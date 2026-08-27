import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_HOOKS } from "../src/hooks.js";
import { MARKER, dispatcherScript, installDispatcher, isOurHooksDir } from "../src/install.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-install-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dispatcherScript", () => {
  it("chains the repository's own hook before doing anything else", () => {
    // core.hooksPath REPLACES .git/hooks, so without chaining, installing this
    // tool silently disables husky/lefthook/pre-commit in every repo.
    const s = dispatcherScript();
    expect(s).toContain("$git_dir/hooks/$hook_name");
    const chainIdx = s.indexOf("local_hook");
    const enqueueIdx = s.indexOf("hook \"$hook_name\"");
    expect(chainIdx).toBeLessThan(enqueueIdx);
  });

  it("propagates a failing local hook's exit code", () => {
    // A repo's own pre-existing hook must still be able to block the operation.
    expect(dispatcherScript()).toContain('exit $?');
  });

  it("never lets its own failure break the git command", () => {
    const s = dispatcherScript();
    expect(s).toContain("|| true");
    expect(s.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("is a POSIX sh script, not bash-specific", () => {
    expect(dispatcherScript().startsWith("#!/bin/sh")).toBe(true);
  });

  it("carries a marker so reinstall can recognise its own work", () => {
    expect(dispatcherScript()).toContain(MARKER);
  });

  it("degrades quietly when the binary is not on PATH", () => {
    // e.g. a global npm bin dir missing from a GUI app's PATH.
    expect(dispatcherScript()).toContain("command -v");
  });

  it("honours a custom binary name", () => {
    expect(dispatcherScript("my-tool")).toContain("my-tool hook");
  });
});

describe("installDispatcher", () => {
  it("installs every supported hook, executable", () => {
    const res = installDispatcher(dir);
    expect(res.installed).toEqual([...GIT_HOOKS]);
    for (const hook of GIT_HOOKS) {
      const file = path.join(dir, hook);
      expect(readFileSync(file, "utf8")).toContain(MARKER);
      // Owner-executable, or git silently ignores the hook.
      expect(statSync(file).mode & 0o100).toBeTruthy();
    }
  });

  it("creates the hooks directory if absent", () => {
    const nested = path.join(dir, "a", "b", "hooks");
    expect(installDispatcher(nested).hooksDir).toBe(nested);
  });

  it("is idempotent", () => {
    installDispatcher(dir);
    const first = readFileSync(path.join(dir, "post-commit"), "utf8");
    installDispatcher(dir);
    expect(readFileSync(path.join(dir, "post-commit"), "utf8")).toBe(first);
  });
});

describe("isOurHooksDir", () => {
  it("recognises its own installation", () => {
    installDispatcher(dir);
    expect(isOurHooksDir(dir)).toBe(true);
  });

  it("does not claim another tool's hooks directory", () => {
    // Guards against overwriting someone else's setup.
    mkdirSync(path.join(dir, "other"), { recursive: true });
    writeFileSync(path.join(dir, "other", "post-commit"), "#!/bin/sh\nhusky\n");
    expect(isOurHooksDir(path.join(dir, "other"))).toBe(false);
  });

  it("is false for a directory that does not exist", () => {
    expect(isOurHooksDir(path.join(dir, "absent"))).toBe(false);
  });
});

describe("dispatcher behaviour in a real repo", () => {
  it("runs the repo's own hook and still exits 0", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "codeindex-hookrepo-"));
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "t@example.com"]);
    run(["config", "user.name", "T"]);

    // A pre-existing repo hook that records it ran.
    const evidence = path.join(repo, "ran.txt");
    const localHook = path.join(repo, ".git", "hooks", "post-commit");
    writeFileSync(localHook, `#!/bin/sh\necho ran > "${evidence}"\n`);
    execFileSync("chmod", ["+x", localHook]);

    const hooksDir = path.join(dir, "hooks");
    installDispatcher(hooksDir, "definitely-not-installed-binary");
    run(["config", "core.hooksPath", hooksDir]);

    writeFileSync(path.join(repo, "f.txt"), "x\n");
    run(["add", "f.txt"]);
    run(["commit", "-q", "-m", "test"]); // must not throw

    // The repo's own hook still ran despite hooksPath being redirected.
    expect(readFileSync(evidence, "utf8").trim()).toBe("ran");
    rmSync(repo, { recursive: true, force: true });
  });
});

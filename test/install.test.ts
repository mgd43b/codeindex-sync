import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_GIT_HOOKS, GIT_HOOKS } from "../src/hooks.js";
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
    expect(res.installed).toEqual([...ALL_GIT_HOOKS]);
    for (const hook of ALL_GIT_HOOKS) {
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

describe("hook coverage (core.hooksPath replaces .git/hooks entirely)", () => {
  it("installs a dispatcher for every hook type, not just the indexing ones", () => {
    // Verified by experiment: with a hooksPath containing only post-commit, a
    // repo's own pre-commit never runs and nothing reports it. Installing this
    // tool would then silently disable validation in every repo on the machine.
    const dir = mkdtempSync(path.join(tmpdir(), "codeindex-cover-"));
    const res = installDispatcher(dir);
    for (const hook of ALL_GIT_HOOKS) {
      expect(res.installed).toContain(hook);
      expect(existsSync(path.join(dir, hook))).toBe(true);
    }
    expect(res.installed.length).toBe(ALL_GIT_HOOKS.length);
    rmSync(dir, { recursive: true, force: true });
  });

  it("covers every hook the indexing set needs", () => {
    for (const hook of GIT_HOOKS) expect(ALL_GIT_HOOKS).toContain(hook);
  });

  it("only the indexing hooks invoke the binary", () => {
    // A pre-commit that spawns node on every commit would tax every repo for
    // nothing: those hooks exist purely to chain.
    expect(dispatcherScript("codeindex-sync", true)).toContain("codeindex-sync hook");
    expect(dispatcherScript("codeindex-sync", false)).not.toContain("codeindex-sync hook");
  });

  it("chains the repo's own hook in both variants", () => {
    for (const enqueue of [true, false]) {
      const script = dispatcherScript("codeindex-sync", enqueue);
      expect(script).toContain('"$local_hook" "$@"');
      // The repo hook's exit status must propagate, or a failing pre-commit
      // stops vetoing the commit.
      expect(script).toContain("exit $?");
    }
  });
});

describe("replacing another tool's hooks", () => {
  it("does not write through a symlink into the other tool's script", () => {
    // The bash implementation this replaces fills its hooks dir with symlinks
    // to one dispatcher. writeFileSync follows symlinks, so a naive write
    // destroys that script through the link — unrecoverably, since uninstall
    // would then have nothing to restore.
    const dir = mkdtempSync(path.join(tmpdir(), "codeindex-symlink-"));
    const other = path.join(dir, "other-dispatch");
    writeFileSync(other, "#!/bin/sh\n# ORIGINAL\n", "utf8");
    symlinkSync("other-dispatch", path.join(dir, "post-commit"));

    installDispatcher(dir);

    expect(readFileSync(other, "utf8")).toContain("ORIGINAL");
    expect(lstatSync(path.join(dir, "post-commit")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(dir, "post-commit"), "utf8")).toContain(MARKER);
    rmSync(dir, { recursive: true, force: true });
  });
});

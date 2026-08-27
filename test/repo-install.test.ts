/**
 * Repository-scoped hook installation, and the path containment it depends on.
 *
 * A repo that sets its own `core.hooksPath` overrides the global one, so it is
 * invisible to the global dispatcher. Both halves matter: covering such a repo,
 * and never breaking the hooks it already had.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localHooksPath } from "../src/git.js";
import { installRepoDispatcher, repoCoverage, uninstallRepoDispatcher } from "../src/install.js";
import { isUnder } from "../src/paths.js";

let dir: string;
let repo: string;
let hooksRoot: string;
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-repoinstall-"));
  repo = path.join(dir, "repo");
  hooksRoot = path.join(dir, "repo-hooks");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "one"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Give the repo a husky-style hooks directory with a hook that leaves a trace. */
function withHusky(): void {
  const husky = path.join(repo, ".husky");
  mkdirSync(husky, { recursive: true });
  const hook = path.join(husky, "post-commit");
  writeFileSync(hook, '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/evidence"\n');
  chmodSync(hook, 0o755);
  git(["config", "--local", "core.hooksPath", ".husky"]);
}

describe("isUnder", () => {
  it("resolves symlinks on both sides", () => {
    // The bug this exists for: git reports a resolved path while config holds
    // the path the user typed, so every hook silently decided "outside root".
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(isUnder(path.join(real, "child"), link)).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(isUnder("/home/me/workspace-other", "/home/me/work")).toBe(false);
  });

  it("counts the root itself as inside", () => {
    expect(isUnder("/home/me/work", "/home/me/work")).toBe(true);
  });

  it("falls back to lexical resolution for paths not on disk", () => {
    expect(isUnder("/nope/a/b", "/nope/a")).toBe(true);
  });
});

describe("repoCoverage", () => {
  it("reports a repo with its own hooksPath as NOT covered", () => {
    // Precisely the blind spot: a global hooksPath is set and healthy, but this
    // repo overrides it, so nothing reaches us.
    withHusky();
    const cov = repoCoverage(repo, "/some/global/hooks");
    expect(cov.covered).toBe(false);
    expect(cov.reason).toMatch(/overrides the global/);
  });

  it("reports it as covered once install-repo has run", () => {
    withHusky();
    installRepoDispatcher(repo, hooksRoot);
    expect(repoCoverage(repo, "/some/global/hooks").covered).toBe(true);
  });
});

describe("installRepoDispatcher", () => {
  it("takes over core.hooksPath and remembers what was there", () => {
    withHusky();
    const res = installRepoDispatcher(repo, hooksRoot);
    expect(res.chained).toBe(".husky");
    expect(localHooksPath(repo)).toBe(res.hooksDir);
  });

  it("writes nothing inside the repository", () => {
    // Compared against a baseline: .husky/ is already untracked beforehand, so
    // an empty status would be asserting the fixture, not the behaviour.
    withHusky();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    installRepoDispatcher(repo, hooksRoot);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(after).toBe(before);
  });

  it("re-running does not chain the dispatcher to itself", () => {
    // Without the guard this recurses until the shell gives up.
    withHusky();
    const first = installRepoDispatcher(repo, hooksRoot);
    const second = installRepoDispatcher(repo, hooksRoot);
    expect(second.alreadyOurs).toBe(true);
    expect(second.chained).toBe(".husky");
    expect(second.hooksDir).toBe(first.hooksDir);
  });

  it("chains .git/hooks when the repo had no hooksPath of its own", () => {
    const res = installRepoDispatcher(repo, hooksRoot);
    expect(res.chained).toBeNull();
  });
});

describe("uninstallRepoDispatcher", () => {
  it("restores the original hooksPath", () => {
    withHusky();
    installRepoDispatcher(repo, hooksRoot);
    const res = uninstallRepoDispatcher(repo, hooksRoot);
    expect(res.wasOurs).toBe(true);
    expect(res.restored).toBe(".husky");
    expect(localHooksPath(repo)).toBe(".husky");
  });

  it("clears hooksPath when there was none before", () => {
    installRepoDispatcher(repo, hooksRoot);
    uninstallRepoDispatcher(repo, hooksRoot);
    expect(localHooksPath(repo)).toBeNull();
  });

  it("is a no-op on a repo it does not own", () => {
    withHusky();
    const res = uninstallRepoDispatcher(repo, hooksRoot);
    expect(res.wasOurs).toBe(false);
    expect(localHooksPath(repo)).toBe(".husky");
  });

  it("removes its dispatcher directory", () => {
    withHusky();
    const { hooksDir } = installRepoDispatcher(repo, hooksRoot);
    uninstallRepoDispatcher(repo, hooksRoot);
    expect(existsSync(hooksDir)).toBe(false);
  });
});

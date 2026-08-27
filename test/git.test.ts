import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentBranch,
  goneBranches,
  isDirty,
  listWorktrees,
  mainWorktree,
  pruneWorktrees,
  repoRoot,
} from "../src/git.js";

let dir: string;

function run(args: string[], cwd = dir): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-git-"));
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "hello\n");
  run(["add", "a.txt"]);
  run(["commit", "-q", "-m", "init"]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repoRoot", () => {
  it("finds the root from a subdirectory", () => {
    const sub = path.join(dir, "nested", "deep");
    execFileSync("mkdir", ["-p", sub]);
    expect(repoRoot(sub)).toBe(repoRoot(dir));
  });

  it("returns null outside a repository", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "codeindex-plain-"));
    expect(repoRoot(plain)).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });

  it("returns null for a path that does not exist", () => {
    expect(repoRoot(path.join(dir, "absent"))).toBeNull();
  });
});

describe("mainWorktree", () => {
  it("resolves a linked worktree back to the main one", () => {
    // This is what stops one repo being indexed repeatedly under different
    // paths — the cause of large-scale duplicate indexes.
    const wt = path.join(dir, "..", `wt-${path.basename(dir)}`);
    run(["worktree", "add", "-q", "-b", "feature", wt]);
    expect(mainWorktree(wt)).toBe(repoRoot(dir));
    rmSync(wt, { recursive: true, force: true });
  });

  it("is a no-op on the main worktree itself", () => {
    expect(mainWorktree(dir)).toBe(repoRoot(dir));
  });
});

describe("listWorktrees", () => {
  it("lists the main worktree", () => {
    const trees = listWorktrees(dir);
    expect(trees.length).toBeGreaterThanOrEqual(1);
    expect(trees[0]?.branch).toBe("main");
  });

  it("includes a linked worktree and its branch", () => {
    const wt = path.join(dir, "..", `wt2-${path.basename(dir)}`);
    run(["worktree", "add", "-q", "-b", "topic", wt]);
    const found = listWorktrees(dir).find((t) => t.branch === "topic");
    expect(found).toBeDefined();
    rmSync(wt, { recursive: true, force: true });
  });

  it("flags a worktree whose directory was deleted as prunable", () => {
    // Exactly the state that hands the indexer a dead working directory.
    const wt = path.join(dir, "..", `wt3-${path.basename(dir)}`);
    run(["worktree", "add", "-q", "-b", "gone", wt]);
    rmSync(wt, { recursive: true, force: true });
    expect(listWorktrees(dir).some((t) => t.prunable)).toBe(true);
  });

  it("returns empty for a non-repository instead of throwing", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "codeindex-plain2-"));
    expect(listWorktrees(plain)).toEqual([]);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("pruneWorktrees", () => {
  it("removes a dangling registration but leaves live ones", () => {
    const live = path.join(dir, "..", `live-${path.basename(dir)}`);
    const dead = path.join(dir, "..", `dead-${path.basename(dir)}`);
    run(["worktree", "add", "-q", "-b", "live", live]);
    run(["worktree", "add", "-q", "-b", "dead", dead]);
    rmSync(dead, { recursive: true, force: true });

    pruneWorktrees(dir, "now");
    const after = listWorktrees(dir);
    expect(after.some((t) => t.branch === "live")).toBe(true);
    expect(after.some((t) => t.path === dead)).toBe(false);
    rmSync(live, { recursive: true, force: true });
  });

  it("is safe on a non-repository", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "codeindex-plain3-"));
    expect(() => pruneWorktrees(plain)).not.toThrow();
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("goneBranches", () => {
  it("returns branch NAMES, not SHAs, for marker-prefixed lines", () => {
    // Regression: `git branch -vv | awk '{print $2}'` yields the SHA on plain
    // lines and the name only on "*"/"+" lines, so naive parsing deletes
    // nothing and reports "branch not found" instead.
    const names = goneBranches(dir);
    for (const n of names) expect(n).not.toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("returns empty when nothing has a gone upstream", () => {
    expect(goneBranches(dir)).toEqual([]);
  });
});

describe("isDirty / currentBranch", () => {
  it("detects a clean and dirty tree", () => {
    expect(isDirty(dir)).toBe(false);
    writeFileSync(path.join(dir, "b.txt"), "x\n");
    expect(isDirty(dir)).toBe(true);
  });

  it("reports the current branch", () => {
    expect(currentBranch(dir)).toBe("main");
  });

  it("reports null on a detached HEAD", () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    run(["checkout", "-q", sha]);
    expect(currentBranch(dir)).toBeNull();
  });
});

/**
 * Git helpers.
 *
 * Everything shells out rather than using a library binding: the operations
 * needed are few, and matching the user's own `git` exactly (their config,
 * their credential helpers, their hooks) matters more than avoiding a spawn.
 *
 * No command here ever throws. Git is queried in contexts — inside hooks,
 * against half-deleted worktrees — where failure is normal and must degrade to
 * "I don't know" rather than crash the worker.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

function git(args: string[], cwd?: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

/** Repository root containing `dir`, or null if it isn't in one. */
export function repoRoot(dir: string): string | null {
  return git(["rev-parse", "--show-toplevel"], dir);
}

/**
 * The MAIN worktree, even when called from a linked one.
 *
 * Linked worktrees share the parent's index, so resolving to the main worktree
 * is what stops one repository being indexed several times under different
 * paths — the cause of large-scale duplicate indexes in practice.
 */
export function mainWorktree(dir: string): string | null {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  if (!common) return null;
  // .../repo/.git -> .../repo
  return common.replace(/\/\.git\/?$/, "") || null;
}

export interface Worktree {
  path: string;
  branch: string | null;
  /** Registered but the directory is gone. */
  prunable: boolean;
}

export function listWorktrees(repo: string): Worktree[] {
  const out = git(["worktree", "list", "--porcelain"], repo);
  if (!out) return [];
  const trees: Worktree[] = [];
  let current: Partial<Worktree> = {};
  for (const raw of out.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("worktree ")) {
      if (current.path) trees.push({ path: current.path, branch: current.branch ?? null, prunable: current.prunable ?? false });
      current = { path: l.slice("worktree ".length) };
    } else if (l.startsWith("branch ")) {
      current.branch = l.slice("branch refs/heads/".length);
    } else if (l === "prunable" || l.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  if (current.path) trees.push({ path: current.path, branch: current.branch ?? null, prunable: current.prunable ?? false });
  return trees;
}

/**
 * Drop registrations whose directory is already gone.
 *
 * Only metadata is removed; no files are touched. `--expire` leaves recent
 * entries alone so a worktree still being created is never raced.
 */
export function pruneWorktrees(repo: string, expire = "1.hour.ago"): void {
  git(["worktree", "prune", `--expire=${expire}`], repo);
}

/** Branches whose upstream is gone — i.e. the remote branch was deleted. */
export function goneBranches(repo: string): string[] {
  const out = git(["branch", "-vv"], repo);
  if (!out) return [];
  return out
    .split("\n")
    .filter((l) => /: gone\]/.test(l))
    // Strip the "*" (current) or "+" (checked out in a worktree) marker first:
    // without this, field 1 is the marker and field 2 is a SHA, not a name.
    .map((l) => l.replace(/^[+*]\s*/, "").trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/** Resolved HEAD commit, or null (unborn branch, not a repo, deleted dir). */
export function currentHead(dir: string): string | null {
  return git(["rev-parse", "HEAD"], dir);
}

export function isDirty(dir: string): boolean {
  const out = git(["status", "--porcelain"], dir);
  return out !== null && out.length > 0;
}

export function currentBranch(dir: string): string | null {
  const b = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return b === "HEAD" ? null : b;
}

/** Is `hooksPath` configured globally, and to what? */
export function globalHooksPath(): string | null {
  return git(["config", "--global", "core.hooksPath"]);
}

/** Set the global core.hooksPath. Machine-wide: callers must confirm first. */
export function setGlobalHooksPath(dir: string): void {
  git(["config", "--global", "core.hooksPath", dir]);
}

export function unsetGlobalHooksPath(): void {
  git(["config", "--global", "--unset", "core.hooksPath"]);
}

/**
 * The `core.hooksPath` set on this repository specifically, if any.
 *
 * Local config beats global, so a repo that sets this (husky, lefthook, a
 * `.githooks` convention) silently opts out of the global dispatcher. Detecting
 * it is the difference between "covered" and "looks covered".
 */
export function localHooksPath(repo: string): string | null {
  return git(["config", "--local", "core.hooksPath"], repo);
}

/** What git will *actually* use for this repo, after config precedence. */
export function effectiveHooksPath(repo: string): string | null {
  return git(["config", "core.hooksPath"], repo);
}

export function setLocalHooksPath(repo: string, dir: string): void {
  git(["config", "--local", "core.hooksPath", dir], repo);
}

export function unsetLocalHooksPath(repo: string): void {
  git(["config", "--local", "--unset", "core.hooksPath"], repo);
}

/** The directory git resolves `core.hooksPath` against, honouring relative paths. */
export function resolveHooksPath(repo: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(repo, value);
}

/** Does this worktree have uncommitted changes? Never remove one that does. */
export function worktreeDirty(dir: string): boolean {
  return isDirty(dir);
}

/**
 * Remove a linked worktree and delete its branch.
 *
 * Refuses the main worktree — `git worktree remove` would too, but failing
 * loudly here keeps the caller's dry-run listing honest.
 */
export function removeWorktree(repo: string, dir: string, force = false): boolean {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), dir];
  return git(args, repo) !== null;
}

export function deleteBranch(repo: string, branch: string): boolean {
  return git(["branch", "-D", branch], repo) !== null;
}

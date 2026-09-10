/**
 * What a hook is allowed to turn into an index.
 *
 * Agent tooling checks a repository out into a directory of its own — Claude
 * Code under `.claude/worktrees/`, Codex under `.codex/worktrees/`, and whatever
 * the next tool picks — then commits in it, firing the hooks. Each of those
 * checkouts carries the repository's *committed* marker file, so a backend asked
 * about one happily builds a second index of the same code under a path that
 * will not exist in an hour. A few agent runs a day and the store fills with
 * indexes of deleted directories.
 *
 * Two independent rules, because neither subsumes the other:
 *
 *  - **Configured paths.** `excludePaths` names directories that are never
 *    project roots. Pure string work, which is exactly why it is the rule that
 *    still holds when the directory has already been deleted — the case that
 *    actually happens, and the one where every git query returns "don't know".
 *  - **Git's own answer.** A linked worktree anywhere on disk is skipped too. Its
 *    commit did not change the main checkout's files, and the main checkout is
 *    what carries the index; enqueuing it produces a tree walk that concludes
 *    nothing changed, while indexing the worktree's own path would create the
 *    duplicate this exists to prevent.
 *
 * The trap worth naming, because both tempting one-liners fall into it: "is this
 * directory the repository root?" is NOT the question. A project can be
 * legitimately rooted at `/repo/src`, so a guard phrased that way discards it —
 * and a guard that instead widens such a path to `/repo` indexes a tree the
 * backend was never asked about. Neither happens here: the decision is only ever
 * "skip, and why" or "this exact path".
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isLinkedWorktree as gitIsLinkedWorktree, repoRoot as gitRepoRoot } from "./git.js";
import { isUnder, realPath } from "./paths.js";

/**
 * Shipped defaults: the agent tools that exist today.
 *
 * A list rather than a constant, and config rather than code, because this is
 * the part that dates. Every agent tool picks its own directory, more will
 * appear, and nobody should need a release of this project to exclude one.
 */
export const DEFAULT_EXCLUDE_PATHS: readonly string[] = [
  "**/.claude/worktrees/**",
  "**/.codex/worktrees/**",
];

/**
 * The literal segments of a pattern.
 *
 * A pattern is a run of path segments — `.claude/worktrees` — and a `**` segment
 * is accepted and dropped, so the glob-shaped form people expect to write, with
 * a leading and trailing `**`, means the same thing. Nothing else about globbing
 * is implemented: a segment run is the whole requirement, and a matcher library
 * would be a third dependency to spell one comparison.
 */
export function patternSegments(pattern: string): string[] {
  return pattern.split(/[\\/]+/).filter((s) => s.length > 0 && s !== "." && s !== "**");
}

/**
 * Segments using glob syntax this matcher does not implement.
 *
 * `**` is the only wildcard, and only as a whole segment. Anything else — `*`,
 * `?`, a character class, a brace list — would be taken literally and match
 * nothing, so a pattern meant to exclude a directory would silently do nothing at
 * all. The config layer turns this into an error at load; see `parseExcludePaths`.
 *
 * Only the metacharacters that are practically never real directory names are
 * refused. `!`, `+`, `@` and parentheses are ordinary characters far more often
 * than they are extglob, and refusing them would reject a legitimate exclusion.
 */
export function unsupportedGlobSegments(pattern: string): string[] {
  return pattern.split(/[\\/]+/).filter((s) => s !== "**" && /[*?[\]{}]/.test(s));
}

function containsRun(segments: readonly string[], want: readonly string[]): boolean {
  for (let i = 0; i + want.length <= segments.length; i++) {
    if (want.every((w, j) => w === segments[i + j])) return true;
  }
  return false;
}

/**
 * The first pattern that excludes `target`, or null.
 *
 * Segments, not substrings: a substring test on "worktrees" would also match a
 * repository called `worktrees-manager`, and quietly stop indexing it.
 */
export function matchesExcludePath(target: string, patterns: readonly string[]): string | null {
  const segments = patternSegments(path.resolve(target));
  for (const pattern of patterns) {
    const want = patternSegments(pattern);
    // A pattern with no literal segment ("", "**", "/") would match every path
    // and switch indexing off machine-wide. The config layer rejects those with
    // an explanation; ignoring one here means a hand-edited file cannot do it
    // silently either.
    if (want.length === 0) continue;
    if (containsRun(segments, want)) return pattern;
  }
  return null;
}

/** Skip, with the reason a log line or `--verbose` run should show. */
export interface HookSkip {
  skip: true;
  reason: string;
}

/** Index this exact path. Never a widened one — see the note at the top. */
export interface HookTarget {
  skip: false;
  path: string;
}

export type HookDecision = HookSkip | HookTarget;

export interface ResolveTargetOptions {
  /** Patterns from config. Empty means "rely on git alone". */
  excludePaths?: readonly string[];
  /**
   * Provider marker filenames (`detectFiles`). The nearest enclosing directory
   * carrying one is the project root, which is what keeps a project rooted at
   * `/repo/src` from being reported as `/repo`.
   */
  markers?: readonly string[];
  /** Injected in tests. Defaults to the real git probes. */
  isLinkedWorktree?: (dir: string) => boolean | null;
  repoRoot?: (dir: string) => string | null;
}

/**
 * Nearest enclosing directory a provider would claim, else the repository root.
 *
 * Walking up rather than down: a marked directory *above* the hook's cwd is the
 * project, and scanning downwards would be a tree walk in a git hook. With no
 * marker anywhere the answer is the repository root, which is where git runs
 * hooks and what every existing config already describes.
 */
function projectRoot(dir: string, repo: string, markers: readonly string[]): string {
  // One spelling per directory, always the resolved one. git answers with
  // `/private/var/...` where a hook's cwd says `/var/...`, and enqueuing both
  // spellings would hand the backend two paths for one tree — the duplicate
  // index this file exists to prevent, arrived at from the other direction.
  const root = realPath(repo);
  if (markers.length === 0) return root;
  let cur = realPath(dir);
  // Bounded without a counter: both paths are resolved, so the walk either
  // reaches `root` or leaves it — and `parent === cur` catches the filesystem
  // root. A depth cap would only ever mean "gave up and widened", silently.
  while (isUnder(cur, root)) {
    if (markers.some((m) => existsSync(path.join(cur, m)))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return root;
}

/** Never let an injected probe's failure reach the caller: hooks must not throw. */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * What a hook firing in `dir` should enqueue, or why nothing should be.
 *
 * Order matters. The configured patterns are tested first because they are the
 * only rule that survives the directory having been deleted — by the time a
 * post-commit hook for an agent worktree runs, `git` in that directory answers
 * nothing at all, and a git-only guard would wave it through.
 */
export function resolveHookTarget(dir: string, opts: ResolveTargetOptions = {}): HookDecision {
  const pattern = matchesExcludePath(dir, opts.excludePaths ?? []);
  if (pattern) return { skip: true, reason: `path is excluded by ${pattern}` };

  const linked = attempt(() => (opts.isLinkedWorktree ?? gitIsLinkedWorktree)(dir));
  // Only an explicit `true` skips: null is "git could not say", and treating
  // that as a worktree would stop indexing every repository git is unhappy with.
  if (linked === true) {
    return { skip: true, reason: "linked worktree — the main checkout carries the index" };
  }

  const repo = attempt(() => (opts.repoRoot ?? gitRepoRoot)(dir));
  if (!repo) return { skip: true, reason: "not a git repository, or the directory is gone" };

  return { skip: false, path: projectRoot(dir, repo, opts.markers ?? []) };
}

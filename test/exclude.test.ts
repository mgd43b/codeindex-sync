/**
 * The rules deciding what a hook may turn into an index.
 *
 * Every case here is one a naive guard gets wrong in production: the agent
 * worktree that carries a perfectly valid marker file, the same worktree once it
 * has been deleted (which is when the hook usually runs), the linked worktree
 * whose path looks like any other directory, and the project legitimately rooted
 * in a subdirectory that a too-eager guard either discards or widens.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXCLUDE_PATHS,
  matchesExcludePath,
  resolveHookTarget,
  unsupportedGlobSegments,
  type HookDecision,
} from "../src/exclude.js";

const MARKERS = [".socraticode.json"];

/** The main checkout, and the resolved spelling git answers with. */
let dir: string;
let real: string;
/** Directories created outside `dir`, removed after each test. */
let strays: string[];

function run(args: string[], cwd = dir): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function init(target: string): void {
  run(["init", "-q", "-b", "main"], target);
  run(["config", "user.email", "t@example.com"], target);
  run(["config", "user.name", "Test"], target);
}

/** Write the marker a backend's `detectFiles` looks for. */
function claim(target: string): void {
  writeFileSync(path.join(target, ".socraticode.json"), '{"projectId":"x"}\n', "utf8");
}

/** A worktree at `target`, as an agent tool would make it. */
function worktree(target: string, branch: string): string {
  mkdirSync(path.dirname(target), { recursive: true });
  run(["worktree", "add", "-q", "-b", branch, target]);
  return target;
}

beforeEach(() => {
  strays = [];
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-exclude-"));
  init(dir);
  // Committed, because that is the whole problem: every checkout of this
  // repository — including every throwaway worktree — carries the marker.
  claim(dir);
  writeFileSync(path.join(dir, "a.txt"), "hello\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  real = realpathSync(dir);
});
afterEach(() => {
  for (const s of [dir, ...strays]) rmSync(s, { recursive: true, force: true });
});

function decide(target: string, excludePaths: readonly string[] = DEFAULT_EXCLUDE_PATHS) {
  return resolveHookTarget(target, { excludePaths, markers: MARKERS });
}

function reasonOf(d: HookDecision): string {
  if (!d.skip) expect.unreachable(`expected a skip, got the target ${d.path}`);
  return d.reason;
}

function pathOf(d: HookDecision): string {
  if (d.skip) expect.unreachable(`expected a target, got a skip: ${d.reason}`);
  return d.path;
}

describe("agent worktrees", () => {
  it("skips a .claude/worktrees checkout even though it carries a valid marker", () => {
    const wt = worktree(path.join(dir, ".claude", "worktrees", "task"), "task");
    expect(existsSync(path.join(wt, ".socraticode.json"))).toBe(true);

    // The reason matters as much as the verdict: this must be the path rule, not
    // the worktree rule. A guard that only knew about git would also say "skip"
    // here and then wave through the copy-based tools and the deleted case below.
    expect(reasonOf(decide(wt))).toContain(".claude/worktrees");
  });

  it("still skips it once the directory is gone, which is when hooks usually run", () => {
    const wt = worktree(path.join(dir, ".claude", "worktrees", "ephemeral"), "ephemeral");
    rmSync(wt, { recursive: true, force: true });

    // Nothing can be asked of git here — it cannot even chdir — so a guard built
    // on git alone has no answer. The path is still the path.
    expect(() => decide(wt)).not.toThrow();
    expect(reasonOf(decide(wt))).toContain(".claude/worktrees");
  });

  it("skips .codex/worktrees from config rather than a second built-in literal", () => {
    // Not every tool links a worktree; some copy the repository outright, so this
    // one is its own repository carrying its own marker — valid by every test
    // except where it sits.
    const copy = path.join(dir, ".codex", "worktrees", "task");
    mkdirSync(copy, { recursive: true });
    init(copy);
    claim(copy);

    expect(reasonOf(decide(copy))).toContain(".codex/worktrees");
    expect(reasonOf(decide(copy, ["**/.codex/worktrees/**"]))).toContain(".codex/worktrees");

    // The rule is data. A config that names only Claude's directory indexes this
    // one, which is what makes the next agent tool a config edit.
    expect(pathOf(decide(copy, ["**/.claude/worktrees/**"]))).toBe(realpathSync(copy));
  });
});

describe("linked worktrees git alone can identify", () => {
  it("skips one that sits outside any excluded path", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "codeindex-stray-"));
    strays.push(parent);
    const wt = worktree(path.join(parent, "feature"), "feature");

    // Nothing in this path is excluded — only git knows what it is.
    expect(matchesExcludePath(wt, DEFAULT_EXCLUDE_PATHS)).toBeNull();
    expect(reasonOf(decide(wt))).toContain("linked worktree");
    // And with no patterns configured at all, so the rule is provably git's.
    expect(reasonOf(decide(wt, []))).toContain("linked worktree");
  });

  it("does not read git's silence as a worktree", () => {
    // null is "could not say". Treating it as yes would stop indexing every
    // repository git happens to be unhappy with.
    const d = resolveHookTarget(dir, { markers: MARKERS, isLinkedWorktree: () => null });
    expect(pathOf(d)).toBe(real);
  });

  it("contains a probe that throws instead of failing the git command", () => {
    const d = resolveHookTarget(dir, {
      markers: MARKERS,
      isLinkedWorktree: () => {
        throw new Error("git exploded");
      },
    });
    expect(pathOf(d)).toBe(real);
  });
});

describe("ordinary checkouts", () => {
  it("leaves the main checkout alone", () => {
    expect(pathOf(decide(dir))).toBe(real);
  });

  it("neither skips nor widens a project rooted in a subdirectory", () => {
    // The /repo/src trap. "Is this the repository root?" is not the question:
    // answering no discards this project, and widening it to the repository root
    // indexes a tree the backend was never asked about.
    const sub = path.join(dir, "src");
    mkdirSync(sub);
    claim(sub);

    const d = decide(sub);
    expect(d.skip).toBe(false);
    expect(pathOf(d)).toBe(path.join(real, "src"));
    expect(pathOf(d)).not.toBe(real);
  });

  it("finds the enclosing project however far above the hook's cwd it sits", () => {
    // The walk is bounded by the repository root, not by a depth counter: a
    // counter would give up on a deep tree and silently widen to the whole repo.
    const nested = Array.from({ length: 70 }, (_, i) => `d${i}`);
    const project = path.join(dir, "sub-project");
    const deep = path.join(project, ...nested);
    mkdirSync(deep, { recursive: true });
    claim(project);

    expect(pathOf(decide(deep))).toBe(path.join(real, "sub-project"));
  });

  it("widens an unmarked subdirectory to the repository root", () => {
    // The other half of the same rule: with no project of its own, a
    // subdirectory belongs to the repository, which is where git runs hooks.
    const sub = path.join(dir, "docs");
    mkdirSync(sub);
    expect(pathOf(decide(sub))).toBe(real);
  });

  it("skips a directory that is not in a repository at all", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "codeindex-plain-"));
    strays.push(plain);
    expect(reasonOf(decide(plain))).toMatch(/not a git repository|gone/);
  });

  it("skips a path that does not exist without throwing", () => {
    // A global hooksPath fires in every repository on the machine, and by the
    // time this runs the directory may simply be absent.
    const absent = path.join(dir, "never-existed");
    expect(() => decide(absent)).not.toThrow();
    expect(reasonOf(decide(absent))).toMatch(/not a git repository|gone/);
  });
});

describe("matchesExcludePath", () => {
  it("matches path segments, not substrings", () => {
    // A substring test would quietly stop indexing a repository whose name
    // merely contains the pattern.
    expect(matchesExcludePath("/w/worktrees/x", ["**/worktrees/**"])).toBe("**/worktrees/**");
    expect(matchesExcludePath("/w/worktrees-manager/src", ["**/worktrees/**"])).toBeNull();
    expect(matchesExcludePath("/w/my.claude/worktrees/x", DEFAULT_EXCLUDE_PATHS)).toBeNull();
  });

  it("requires the segments to be consecutive", () => {
    expect(matchesExcludePath("/w/.claude/other/worktrees/x", DEFAULT_EXCLUDE_PATHS)).toBeNull();
  });

  it("treats the glob form and the bare form as the same rule", () => {
    const target = "/w/repo/.claude/worktrees/task";
    expect(matchesExcludePath(target, ["**/.claude/worktrees/**"])).not.toBeNull();
    expect(matchesExcludePath(target, [".claude/worktrees"])).not.toBeNull();
    expect(matchesExcludePath(target, ["/.claude/worktrees/"])).not.toBeNull();
  });

  it("reports which pattern matched, so a log line can say why", () => {
    expect(matchesExcludePath("/w/.codex/worktrees/x", DEFAULT_EXCLUDE_PATHS)).toBe(
      "**/.codex/worktrees/**",
    );
  });

  it("never lets a wildcard-only pattern exclude everything", () => {
    // Config rejects these with an explanation; if one reaches here from a
    // hand-edited file it must not switch indexing off machine-wide.
    for (const pattern of ["**", "", "/", "**/**"]) {
      expect(matchesExcludePath("/w/repo", [pattern])).toBeNull();
    }
  });

  it("names the glob syntax it does not implement", () => {
    // Config refuses these at load; here is the reason it has to.
    expect(unsupportedGlobSegments("**/.claude/*/**")).toEqual(["*"]);
    expect(unsupportedGlobSegments("**/{.claude,.codex}/worktrees/**")).toEqual([
      "{.claude,.codex}",
    ]);
    // Characters that are ordinary in a directory name stay allowed.
    expect(unsupportedGlobSegments("**/build (old)/**")).toEqual([]);
    expect(unsupportedGlobSegments("**/.claude/worktrees/**")).toEqual([]);
    expect(unsupportedGlobSegments(".claude/worktrees")).toEqual([]);
  });

  it("excludes nothing when nothing is configured", () => {
    expect(matchesExcludePath("/w/repo/.claude/worktrees/x", [])).toBeNull();
  });
});

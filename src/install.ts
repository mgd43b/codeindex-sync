/**
 * Git hook installation.
 *
 * Git's `core.hooksPath` is global and exclusive: setting it *replaces* each
 * repository's own `.git/hooks`. So the dispatcher installed here has to chain
 * whatever a repo already had, or installing this tool would silently disable
 * husky, lefthook, pre-commit and friends across every repository on the
 * machine. That is the single most destructive thing this tool could do, and
 * chaining is what prevents it.
 *
 * The dispatcher stays a tiny shell script rather than Node. It runs on *every*
 * git command, so its job is to be near-free: work out the repo, hand off, and
 * get out of the way. Anything expensive belongs in the queue.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ALL_GIT_HOOKS, GIT_HOOKS } from "./hooks.js";
import { localHooksPath, resolveHooksPath, setLocalHooksPath, unsetLocalHooksPath } from "./git.js";

export const MARKER = "# codeindex-sync dispatcher";

export function defaultHooksDir(): string {
  return path.join(homedir(), ".config", "git", "hooks");
}

/**
 * The dispatcher.
 *
 * Deliberately does NOT index inline — it enqueues and returns, so a git
 * command never waits on a backend.
 */
// The \$ escapes below are unnecessary *today*, only because no sigil here
// happens to be followed by "{". Dropping them would make this template
// silently fragile: the first person to write a braced shell variable would get
// JS interpolation and a corrupted hook, with no error anywhere. Escaping every
// sigil keeps the rule "shell $ is always escaped" rather than the far more
// error-prone "escape only when it currently matters".
/* eslint-disable no-useless-escape */
export function dispatcherScript(binary = "codeindex-sync", enqueue = true): string {
  const enqueueBlock = enqueue
    ? `
# 2. Enqueue, then kick a worker. Neither blocks: the drain is fully detached,
# so git returns immediately, and indexing starts now rather than waiting for
# the next scheduled tick. Concurrent drains are safe — the worker takes a lock
# and any second one exits at once — so a burst of hooks still indexes once.
if command -v ${binary} >/dev/null 2>&1; then
  ${binary} hook "\$hook_name" "\$@" >/dev/null 2>&1 || true
  ( nohup ${binary} drain >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1 || true
fi`
    : `
# This hook type is not an indexing trigger. The dispatcher exists purely so the
# repository's own hook still runs: core.hooksPath replaces .git/hooks, so
# without a file here git would run nothing at all.`;
  return `#!/bin/sh
${MARKER}
# Installed by \`codeindex-sync install\`. Safe to inspect; edits will be
# overwritten on reinstall.
#
# core.hooksPath REPLACES a repository's own .git/hooks, so any hook the repo
# already had is chained first. Without this, installing codeindex-sync would
# silently disable husky/lefthook/pre-commit everywhere.
hook_name=\$(basename "\$0")

# 1. Chain the repository's own hook, if it has one.
git_dir=\$(git rev-parse --git-dir 2>/dev/null) || exit 0
local_hook="\$git_dir/hooks/\$hook_name"
if [ -x "\$local_hook" ]; then
  "\$local_hook" "\$@" || exit \$?
fi

${enqueueBlock}
exit 0
`;
}


/**
 * Write a hook, replacing whatever is at that path.
 *
 * The unlink is load-bearing. Other tools (including the bash implementation
 * this replaces) populate a hooks directory with *symlinks* to one dispatcher.
 * writeFileSync follows a symlink, so writing straight to `post-commit` would
 * overwrite that tool's script through the link — destroying it, while leaving
 * the symlink in place pointing at our content. Replacing the entry keeps the
 * other tool's file intact so uninstalling can leave a recoverable state.
 */
function writeHook(target: string, content: string): void {
  try {
    rmSync(target, { force: true });
  } catch {
    // Nothing there, or unremovable; the write below reports either way.
  }
  writeFileSync(target, content, "utf8");
  chmodSync(target, 0o755);
}

export interface InstallResult {
  hooksDir: string;
  installed: string[];
  /** Set when a different tool already owned core.hooksPath. */
  replacedHooksPath?: string;
}

/**
 * Write the dispatcher and symlink each supported hook to it.
 *
 * Does not set `core.hooksPath` itself — the caller does that after confirming,
 * because it is a global, machine-wide change.
 */
export function installDispatcher(
  hooksDir = defaultHooksDir(),
  binary = "codeindex-sync",
): InstallResult {
  mkdirSync(hooksDir, { recursive: true });
  const dispatcher = path.join(hooksDir, "codeindex-sync-dispatch");
  writeHook(dispatcher, dispatcherScript(binary));

  const installed: string[] = [];
  const indexing = new Set<string>(GIT_HOOKS);
  for (const hook of ALL_GIT_HOOKS) {
    const target = path.join(hooksDir, hook);
    // A copy rather than a symlink: symlinks in hooksDir behave inconsistently
    // across git versions and filesystems.
    writeHook(target, dispatcherScript(binary, indexing.has(hook)));
    installed.push(hook);
  }
  return { hooksDir, installed };
}

/** Is this hooks directory ours? Used to avoid clobbering another tool's setup. */
export function isOurHooksDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const hook of GIT_HOOKS) {
    const file = path.join(dir, hook);
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").includes(MARKER)) return true;
    } catch {
      // Unreadable: assume not ours rather than risk overwriting.
    }
  }
  return false;
}


// ── Repository-scoped install ───────────────────────────────────────────────
//
// A repo that sets its own `core.hooksPath` (husky, lefthook, a `.githooks`
// convention) overrides the global one, so the global dispatcher never runs
// there. Such a repo cannot be covered globally — it has to be covered on its
// own terms: take over its `core.hooksPath`, and chain whatever it pointed at.
//
// Nothing is ever written inside the repository. The dispatcher lives in state,
// so the working tree stays clean and no one has to gitignore our files.

/** Stable, reversible directory name for a repo's dispatcher. */
export function repoSlug(repo: string): string {
  return path.resolve(repo).replace(/[^A-Za-z0-9]/g, "_");
}

/** Where the previous hooksPath is remembered, so uninstall can restore it. */
const ORIGINAL = ".original-hooks-path";

/* eslint-disable no-useless-escape */
export function repoDispatcherScript(binary: string, chainDir: string, enqueue = true): string {
  const enqueueBlock = enqueue
    ? `
if command -v ${binary} >/dev/null 2>&1; then
  ${binary} hook "\$hook_name" "\$@" >/dev/null 2>&1 || true
  ( nohup ${binary} drain >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1 || true
fi`
    : `
# Not an indexing trigger; this exists only so the repo's own hook still runs.`;
  return `#!/bin/sh
${MARKER} (repo-scoped)
# Installed by \`codeindex-sync install-repo\`. This repository sets its own
# core.hooksPath, which overrides the global one, so it is covered here instead.
# The directory it used before is chained below — nothing it had stops working.
hook_name=\$(basename "\$0")
repo_root=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

chained="${chainDir}"
if [ -n "\$chained" ]; then
  case "\$chained" in
    /*) chain_dir="\$chained" ;;
    *)  chain_dir="\$repo_root/\$chained" ;;
  esac
  if [ -x "\$chain_dir/\$hook_name" ]; then
    "\$chain_dir/\$hook_name" "\$@" || exit \$?
  fi
fi

${enqueueBlock}
exit 0
`;
}
/* eslint-enable no-useless-escape */

export interface RepoInstallResult {
  hooksDir: string;
  /** What this repo's core.hooksPath pointed at before, if anything. */
  chained: string | null;
  alreadyOurs: boolean;
}

export function installRepoDispatcher(
  repo: string,
  repoHooksRoot: string,
  binary = "codeindex-sync",
): RepoInstallResult {
  const current = localHooksPath(repo);
  const dir = path.join(repoHooksRoot, repoSlug(repo));

  // Re-running must not chain our own dispatcher to itself, which would
  // recurse until the shell gives up.
  const alreadyOurs = current !== null && path.resolve(current) === path.resolve(dir);
  let chained: string | null;
  if (alreadyOurs) {
    const saved = path.join(dir, ORIGINAL);
    chained = existsSync(saved) ? readFileSync(saved, "utf8").trim() || null : null;
  } else {
    chained = current;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ORIGINAL), chained ?? "", "utf8");

  // With no previous hooksPath, the repo was using .git/hooks; keep honouring it.
  const chainTarget = chained ?? path.join(repo, ".git", "hooks");
  const indexing = new Set<string>(GIT_HOOKS);
  for (const hook of ALL_GIT_HOOKS) {
    const target = path.join(dir, hook);
    writeHook(target, repoDispatcherScript(binary, chainTarget, indexing.has(hook)));
  }
  setLocalHooksPath(repo, dir);
  return { hooksDir: dir, chained, alreadyOurs };
}

export interface RepoUninstallResult {
  restored: string | null;
  wasOurs: boolean;
}

export function uninstallRepoDispatcher(repo: string, repoHooksRoot: string): RepoUninstallResult {
  const dir = path.join(repoHooksRoot, repoSlug(repo));
  const current = localHooksPath(repo);
  const wasOurs = current !== null && path.resolve(current) === path.resolve(dir);
  if (!wasOurs) return { restored: null, wasOurs: false };

  const saved = path.join(dir, ORIGINAL);
  const original = existsSync(saved) ? readFileSync(saved, "utf8").trim() : "";
  if (original) setLocalHooksPath(repo, original);
  else unsetLocalHooksPath(repo);
  rmSync(dir, { recursive: true, force: true });
  return { restored: original || null, wasOurs: true };
}

/**
 * Is this repository actually covered — by the global dispatcher, or its own?
 *
 * Answers the question `doctor` was getting wrong: not "is a global hooksPath
 * set" but "will a hook here reach us".
 */
export function repoCoverage(
  repo: string,
  globalDir: string | null,
): { covered: boolean; effective: string | null; reason: string } {
  const local = localHooksPath(repo);
  if (local) {
    const dir = resolveHooksPath(repo, local);
    if (isOurHooksDir(dir)) return { covered: true, effective: dir, reason: "repo-scoped dispatcher" };
    return {
      covered: false,
      effective: dir,
      reason: "this repo sets its own core.hooksPath, which overrides the global one",
    };
  }
  if (globalDir && isOurHooksDir(globalDir)) {
    return { covered: true, effective: globalDir, reason: "global dispatcher" };
  }
  return { covered: false, effective: globalDir, reason: "no dispatcher installed" };
}

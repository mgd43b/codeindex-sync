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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { GIT_HOOKS } from "./hooks.js";

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
export function dispatcherScript(binary = "codeindex-sync"): string {
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

# 2. Enqueue. Never blocks: the worker does the actual indexing.
if command -v ${binary} >/dev/null 2>&1; then
  ${binary} hook "\$hook_name" "\$@" >/dev/null 2>&1 || true
fi
exit 0
`;
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
  writeFileSync(dispatcher, dispatcherScript(binary), "utf8");
  chmodSync(dispatcher, 0o755);

  const installed: string[] = [];
  for (const hook of GIT_HOOKS) {
    const target = path.join(hooksDir, hook);
    // A copy rather than a symlink: symlinks in hooksDir behave inconsistently
    // across git versions and filesystems.
    writeFileSync(target, dispatcherScript(binary), "utf8");
    chmodSync(target, 0o755);
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

/**
 * Where state lives. Machine-local; nothing here belongs in a repository.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Paths {
  state: string;
  queue: string;
  processing: string;
  failed: string;
  /** Per-repo start time of the last successful index; drives coalescing. */
  lastIndexed: string;
  /** Directory, not a file: mkdir is the atomic primitive we lock with. */
  lock: string;
  log: string;
  repoHooks: string;
}

export function resolvePaths(stateDir?: string): Paths {
  const state =
    stateDir ??
    process.env["CODEINDEX_SYNC_STATE"] ??
    path.join(homedir(), ".local", "state", "codeindex-sync");
  return {
    state,
    queue: path.join(state, "queue"),
    processing: path.join(state, "processing"),
    failed: path.join(state, "failed"),
    lastIndexed: path.join(state, "last-indexed"),
    lock: path.join(state, "worker.lock"),
    log: path.join(state, "sync.log"),
    repoHooks: path.join(state, "repo-hooks"),
  };
}

/**
 * Only repositories under this root are ever enqueued, so a stray hook in some
 * unrelated clone cannot start indexing it.
 */
export function syncRoot(): string {
  return process.env["CODEINDEX_SYNC_ROOT"] ?? path.join(homedir(), "workspace");
}

/**
 * Resolve symlinks as far as the filesystem allows, then re-append the rest.
 *
 * Resolving only the full path is not enough: when the leaf does not exist — a
 * repo not created yet, or a worktree already deleted, which this tool handles
 * routinely — realpath throws, and falling back to the path as written leaves the
 * *parent* symlinks unresolved. Two spellings of one directory then look like two
 * repositories, which is how the same tree ends up indexed twice.
 */
export function realPath(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return rest.length ? path.join(realpathSync(cur), ...rest) : realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `child` inside `parent`?
 *
 * Two traps, both of which silently drop real work rather than erroring:
 *
 *  - **Symlinks.** git reports the resolved path (`/private/var/...` on macOS,
 *    or wherever a symlinked workspace really lives) while config holds the
 *    path the user typed. A raw string comparison then says "outside the root"
 *    for every repository, and hooks quietly stop enqueuing.
 *  - **Prefix matching.** `startsWith("/home/me/work")` also matches
 *    `/home/me/workspace-other`, so an unrelated tree gets indexed.
 *
 * Resolve both sides, then compare on a separator boundary.
 */
export function isUnder(child: string, parent: string): boolean {
  const c = realPath(child);
  const r = realPath(parent);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

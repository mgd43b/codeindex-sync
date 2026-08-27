/**
 * Where state lives. Machine-local; nothing here belongs in a repository.
 */
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

/**
 * "Has anything actually changed?"
 *
 * Coalescing (see coalesce.ts) drops jobs that a completed scan already covered.
 * It does NOT catch the common case, which is subtler: a hook fires for activity
 * that never touched the indexed repository at all.
 *
 * That is what worktree churn does. `git worktree add`, and every checkout
 * inside a linked worktree, fires post-checkout. Hooks resolve to the *main*
 * repository, so the main repo is queued — but its HEAD never moved and its tree
 * never changed. The indexer then walks every file, hashes it, finds nothing,
 * and exits. Measured on a 4,200-file repo that was ~5 seconds of pure waste per
 * event, repeated dozens of times per rebase, all while holding the lock that
 * genuinely-changed repositories were waiting on.
 *
 * A fingerprint of (HEAD, dirty) settles it before any of that work happens:
 *
 *   - HEAD unchanged and the tree clean  -> nothing to index, skip.
 *   - HEAD moved                          -> commits landed, index.
 *   - Tree dirty                          -> uncommitted edits exist. Index, and
 *                                            do NOT record a fingerprint, since
 *                                            "dirty" is not a state we can
 *                                            compare against later.
 *
 * The dirty case is deliberately conservative. Two different sets of
 * uncommitted edits produce the same "dirty" marker, so treating it as a
 * comparable state would let real changes be skipped. Wasting a scan is
 * recoverable; silently missing a change is not.
 */
import { currentHead, isDirty } from "./git.js";

/** Marker used when the tree has uncommitted changes; never matches itself. */
const DIRTY = "dirty";

export interface Fingerprint {
  head: string;
  dirty: boolean;
}

export function fingerprint(repoPath: string): Fingerprint | null {
  const head = currentHead(repoPath);
  if (!head) return null;
  return { head, dirty: isDirty(repoPath) };
}

/** Serialise for storage. A dirty tree is stored as a value that cannot match. */
export function serialiseFingerprint(fp: Fingerprint): string {
  return fp.dirty ? DIRTY : fp.head;
}

/**
 * Can this job be skipped because nothing changed?
 *
 * `stored` is the fingerprint recorded at the last successful index.
 */
export function unchanged(current: Fingerprint | null, stored: string | undefined): boolean {
  if (!current || !stored) return false;
  // A dirty tree is never "unchanged": we cannot tell one set of edits from
  // another, so we always re-index.
  if (current.dirty || stored === DIRTY) return false;
  return current.head === stored;
}

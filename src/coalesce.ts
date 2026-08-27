/**
 * Dropping redundant jobs.
 *
 * Agent tooling churns Git worktrees, and `git worktree add` — plus any
 * checkout inside one — fires post-checkout. Hooks resolve to the *main*
 * repository, so a burst of worktree activity enqueues the same repo dozens of
 * times. Each run costs a full tree walk and hash of every file just to
 * conclude nothing changed: on a 4,200-file repo that measured ~5s of pure
 * waste per event, while holding the lock genuinely-changed repos wait on.
 *
 * The queue already collapses *pending* duplicates (one file per repo), but new
 * enqueues keep arriving during a drain, so each still gets its own cycle.
 *
 * The rule here is an invariant rather than a time window, which is what makes
 * it safe to apply automatically:
 *
 *   An index that STARTED at T observes the filesystem as of T. A job enqueued
 *   strictly before T therefore reflects a change that scan already covered.
 *
 * A real change can never be dropped, because its hook fires only *after* the
 * file changed, so its enqueue timestamp is necessarily later than any index
 * predating it.
 *
 * This depends on recording the index's START time, not its completion. Using
 * completion would discard a change that landed while the scan was running.
 */
import type { Job } from "./queue.js";

export type CoalesceDecision = { skip: false } | { skip: true; reason: string };

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isIso(s: string): boolean {
  return ISO_SECONDS.test(s);
}

/**
 * @param job            the job under consideration
 * @param lastIndexStart ISO-8601 UTC start time of the last successful index for
 *                       this repo, or undefined if it has never been indexed
 */
export function shouldCoalesce(
  job: Job,
  lastIndexStart: string | undefined,
): CoalesceDecision {
  // An explicit full reindex is a deliberate act — never discard it.
  if (job.full) return { skip: false };

  if (!lastIndexStart || !job.enqueuedAt) return { skip: false };

  // Malformed timestamps fail open: indexing needlessly is recoverable,
  // silently skipping a real change is not.
  if (!isIso(job.enqueuedAt) || !isIso(lastIndexStart)) return { skip: false };

  // ISO-8601 UTC sorts lexicographically, so a string compare is chronological
  // and needs no date parsing.
  if (job.enqueuedAt < lastIndexStart) {
    return {
      skip: true,
      reason: `queued ${job.enqueuedAt}, already covered by the index started ${lastIndexStart}`,
    };
  }
  return { skip: false };
}

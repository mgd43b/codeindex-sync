/**
 * The built-in indexer, expressed as an ordinary hook handler.
 *
 * This is deliberate dogfooding: indexing gets no privileged path. It registers
 * through the same interface a third-party extension would, which means the
 * extension point is exercised on every commit rather than only by its tests.
 * If this handler can't express something, the interface is wrong.
 *
 * Note what it does *not* do: index. It enqueues and returns. Hooks run inside
 * the user's git command, and one `git rebase` can fire dozens of them, so the
 * only correct amount of work here is "almost none".
 */
import { isUnder } from "../paths.js";
import type { GitHook, HookEvent, HookHandler } from "../hooks.js";
import { Queue } from "../queue.js";

export interface IndexHandlerOptions {
  queueDir: string;
  /** Only repos under this root are enqueued. */
  root: string;
  /** Hooks to react to. Defaults cover the ways a tree changes. */
  hooks?: readonly GitHook[];
}

/**
 * post-rewrite and post-applypatch are included because rebase and `git am`
 * change the tree without a commit hook firing — a repo would otherwise drift
 * out of date after a rebase and stay stale until the next unrelated commit.
 */
const DEFAULT_HOOKS: readonly GitHook[] = [
  "post-commit",
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "post-applypatch",
];

export function createIndexHandler(opts: IndexHandlerOptions): HookHandler {
  const queue = new Queue(opts.queueDir);
  return {
    name: "index",
    description: "Queue the repository for re-indexing",
    hooks: opts.hooks ?? DEFAULT_HOOKS,
    handle(event: HookEvent): void {
      // The root check is a guard, not an optimisation: a global hooksPath
      // fires in *every* repo on the machine, including ones the user never
      // intended to index.
      if (!isUnder(event.repoPath, opts.root)) return;
      queue.enqueue({
        repoPath: event.repoPath,
        hook: event.hook,
        full: false,
        enqueuedAt: event.at,
      });
    },
  };
}

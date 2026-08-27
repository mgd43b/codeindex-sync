/**
 * Git hook subscriptions.
 *
 * Indexing is only the first thing that wants to react to Git activity. Rather
 * than hard-wiring the indexer into the hook path, anything can subscribe:
 * a linter cache, a docs regenerator, a notifier.
 *
 * The rules that make this safe are the ones learned the hard way running a
 * single-purpose version of this:
 *
 *  - Hooks fire constantly. One `git rebase` can produce dozens of events, so a
 *    handler must be cheap or must defer its work to the queue.
 *  - Hooks are NOT a login shell. They never source a shell profile, so a
 *    handler cannot rely on the user's exported environment.
 *  - The hook's cwd is frequently a throwaway worktree that no longer exists by
 *    the time anything runs. Handlers get a resolved repo root instead.
 *  - A handler that throws must never block other handlers, or one broken
 *    extension takes the whole hook path down with it.
 */

export const GIT_HOOKS = [
  "post-commit",
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "post-applypatch",
] as const;

/**
 * Every hook type a dispatcher must exist for — not just the ones we act on.
 *
 * `core.hooksPath` REPLACES a repository's `.git/hooks` wholesale. Git looks
 * only in that directory, so a hook type with no file there simply never runs:
 * install this tool with five hooks and every repo on the machine silently
 * loses its pre-commit, commit-msg and pre-push. Nothing errors, and the loss
 * is invisible until something unvalidated reaches main.
 *
 * So a dispatcher is installed for all of these. The five above additionally
 * enqueue; the rest only chain the repo's own hook and get out of the way.
 *
 * Deliberately excluded: `fsmonitor-watchman` (invoked with a protocol, not
 * hook semantics), `reference-transaction` (fires many times per command, and
 * chaining it would tax every git operation), and the `p4-*` family.
 */
export const ALL_GIT_HOOKS = [
  "applypatch-msg",
  "commit-msg",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-receive",
  "post-rewrite",
  "post-update",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "pre-receive",
  "prepare-commit-msg",
  "sendemail-validate",
  "update",
] as const;

export type GitHook = (typeof GIT_HOOKS)[number];

export function isGitHook(name: string): name is GitHook {
  return (GIT_HOOKS as readonly string[]).includes(name);
}

export interface HookEvent {
  hook: GitHook;
  /**
   * Absolute path to the repository root. Already resolved from the raw hook
   * cwd, so handlers never see a deleted worktree path.
   */
  repoPath: string;
  /** Raw hook arguments, as Git passed them. */
  args: string[];
  /** When the hook fired, ISO-8601 UTC. */
  at: string;
}

export interface HookHandler {
  /** Stable id, shown by `extensions` and used to enable/disable. */
  readonly name: string;
  readonly description: string;
  /** Which hooks this handler cares about. */
  readonly hooks: readonly GitHook[];
  /**
   * Do the work. Keep it fast: enqueue rather than index inline. Throwing is
   * contained, but a slow handler delays the user's git command.
   */
  handle(event: HookEvent): Promise<void> | void;
}

export interface DispatchResult {
  handler: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/**
 * Holds handlers and fans an event out to those that asked for it.
 *
 * Handlers are isolated: one that throws or hangs is reported, and the rest
 * still run. That containment is what makes third-party extensions safe to add.
 */
export class HookRegistry {
  private readonly handlers: HookHandler[] = [];

  register(handler: HookHandler): this {
    if (this.handlers.some((h) => h.name === handler.name)) {
      throw new Error(`duplicate hook handler: ${handler.name}`);
    }
    this.handlers.push(handler);
    return this;
  }

  all(): readonly HookHandler[] {
    return this.handlers;
  }

  /** Handlers subscribed to a given hook, in registration order. */
  for(hook: GitHook): HookHandler[] {
    return this.handlers.filter((h) => h.hooks.includes(hook));
  }

  /**
   * Run every subscribed handler. Never rejects: a broken extension must not
   * break the user's `git commit`.
   */
  async dispatch(event: HookEvent): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const handler of this.for(event.hook)) {
      const started = Date.now();
      try {
        await handler.handle(event);
        results.push({ handler: handler.name, ok: true, ms: Date.now() - started });
      } catch (err) {
        results.push({
          handler: handler.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started,
        });
      }
    }
    return results;
  }
}

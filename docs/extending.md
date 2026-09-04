# Extending codeindex-sync

Two extension points, in increasing order of effort:

1. **Add a backend** — usually pure config, no code.
2. **Add a hook handler** — react to git activity for something other than indexing.

---

## 1. Add an index backend

If your backend is an MCP server exposing index/update/status tools, you do not
write code. Describe it in `~/.config/codeindex-sync/config.json`:

```json
{
  "providers": [
    {
      "name": "my-backend",
      "description": "What it does, one line",
      "command": "my-index-server",
      "args": ["--stdio"],
      "tools": {
        "update": "update_index",
        "index": "rebuild_index",
        "status": "index_status"
      },
      "repoArg": "projectPath",
      "detectFiles": [".my-backend.json"],
      "busyMarkers": ["already indexing"],
      "timeoutMs": 3600000,
      "env": { "MY_BACKEND_URL": "https://..." }
    }
  ]
}
```

`codeindex-sync providers --example` prints a starting block.

### The fields that matter

**`tools.update` is the only required tool.** Everything else degrades: without
`index`, a `--full` request falls back to `update`; without `status`, `list`
reports nothing for that provider rather than failing — and an asynchronous
`index` cannot be verified, so configure `status` if you configure `index`.

**`detectFiles` decides routing.** When several providers are configured, the
first one claiming a repo wins, in config order. A marker file is the usual
mechanism — it also lets a repo opt in explicitly. An empty list means "claim
any repo", which is fine when only one provider is configured.

**`busyMarkers` prevents a real bug.** Most backends hold their own per-project
lock. When another indexer holds it, the reply is *contention*, not failure — the
job must be requeued without burning a retry attempt. Get this wrong and three
unlucky collisions park a perfectly healthy repository in `failed/`.

**`asyncIndexMarkers` prevents a worse one.** A full-index tool is often
fire-and-forget: it starts the work on the backend's own event loop and returns
in about a second saying so. Taken at face value that reply is a silent
data-loss bug — the session closes, the child is reaped moments into a job
needing minutes, and an empty index reports as a success.

So a reply is not evidence the work happened. After invoking `tools.index`,
codeindex-sync polls `tools.status` **on the same session** until the backend
stops reporting progress, and reports what status says. One session, because
progress is usually per-process state: a second child would see a backend that
has never indexed anything.

Three fields tune it, and the defaults suit any backend that says the usual
things ("in the background", "in progress"):

| Field | Default | What it matches |
| --- | --- | --- |
| `asyncIndexMarkers` | `in the background`, `running asynchronously`, `check progress` | A reply meaning "started", not "done" |
| `progressMarkers` | `in progress`, `in-progress`, `actively indexing` | A `status` reply meaning work is still running |
| `pollIntervalMs` | `2000` | Cadence the status polls settle at (must be positive) |

Polling starts immediately and backs off to `pollIntervalMs`, so a tool that
already did the work before replying pays one extra call and no waiting, while a
long job is not polled hard. Cheap early polls also matter for correctness: a run
that starts and finishes between two polls was never *seen*, and an unseen run
cannot be told apart from one that never started.

Three consequences worth knowing:

- An incremental `update` that answers synchronously is not polled — hooks fire
  constantly and that reply is already the truth — but one whose reply matches
  `asyncIndexMarkers` is.
- "Done" is not merely "no progress marker". Re-indexing a repo that already has
  an index reports a perfectly healthy one during the window before the new run
  becomes visible, so a reply that announced background work must be watched
  running before it counts as finished.
- A run that stops having produced no index at all, or one the backend still
  calls incomplete, is a failure — not a success with a small number in it.

The wait is bounded by the caller's abort signal and by the session's own hard
timer, which kills the child and makes every later call fail at once. Both end as
a failure: a backend that never finishes must never look like one that did.

**`env` exists because git hooks are not a login shell.** They never source
`~/.bashrc`, `~/.zshenv` or any profile, so anything you export in a shell is
invisible to the indexer. If your backend needs configuration, it goes here or in
a file the hook path reads directly — never in a shell profile.

### If config isn't enough

A backend that needs real code is a signal the `IndexProvider` interface is
missing something. Prefer extending the interface over special-casing a product,
so the abstraction keeps its guarantee: nothing above `provider.ts` knows any
backend's name.

To implement one anyway:

```ts
import type { IndexProvider } from "codeindex-sync";

export class MyProvider implements IndexProvider {
  readonly name = "mine";
  readonly description = "…";

  async detect(repoPath: string) { /* cheap, no network */ return true; }
  async index(req) { /* → { status: "ok" | "busy" | "failed", summary } */ }
  async health() { /* → ProviderHealth[]; must never throw */ return []; }
  async status(repoPath: string) { return null; }
}
```

Three rules, each learned from a production failure:

- **`detect` must be cheap.** It runs for every provider on every job.
- **`health` must never throw.** It backs `doctor`, which has to work when
  everything else is broken. Return `ok: false` with a `remedy` instead.
- **Distinguish `busy` from `failed`.** See above.

---

## 2. Add a git-hook handler

Indexing is only the first subscriber to git activity. A handler can do anything
— warm a lint cache, regenerate docs, notify something:

```ts
import { HookRegistry, type HookHandler } from "codeindex-sync";

const lintCache: HookHandler = {
  name: "lint-cache",
  description: "Warm the lint cache after a checkout",
  hooks: ["post-checkout", "post-merge"],
  async handle(event) {
    // event.repoPath is the MAIN worktree, already resolved
    // event.hook, event.args, event.at
  },
};

registry.register(lintCache);
```

### Rules for handlers

**Be fast, or defer.** Hooks run inside the user's git command. One `git rebase`
can fire dozens of events. Enqueue work; don't do it inline.

**Never rely on the environment.** Hooks are not a login shell.

**Use `event.repoPath`, never `process.cwd()`.** The hook's working directory is
frequently a throwaway worktree that no longer exists by the time you run — and
a deleted cwd kills the process during interpreter startup, before your code
runs at all. `repoPath` is already resolved to the main worktree.

**Throwing is contained but not free.** A handler that throws is reported and the
others still run — a broken extension must never break `git commit`. But a slow
one delays every git command the user types.

Per-handler timings come back from `dispatch()`, so a slow extension is
identifiable rather than just "git feels sluggish lately".

---

## Testing your extension

Both interfaces are plain objects, so no framework is needed:

```ts
const provider = new MyProvider();
expect(await provider.detect("/repo")).toBe(true);
```

The worker takes an injected provider, so end-to-end behaviour — retries,
coalescing, crash recovery — can be tested against a scripted fake with no real
backend running. See `test/worker.test.ts` for the pattern.

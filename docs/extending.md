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
reports nothing for that provider rather than failing.

**`tools.list` is what makes `tools.remove` trustworthy.** A removal is confirmed
against the backend's own listing, so configuring `remove` without `list` leaves
`cleanup --apply` able to ask but not to check — it will say so rather than
claim a removal it cannot see. See below.

**`detectFiles` decides routing.** When several providers are configured, the
first one claiming a repo wins, in config order. A marker file is the usual
mechanism — it also lets a repo opt in explicitly. An empty list means "claim
any repo", which is fine when only one provider is configured.

**`busyMarkers` prevents a real bug.** Most backends hold their own per-project
lock. When another indexer holds it, the reply is *contention*, not failure — the
job must be requeued without burning a retry attempt. Get this wrong and three
unlucky collisions park a perfectly healthy repository in `failed/`.

**A removal is verified, not assumed.** `cleanup`'s entire input is indexes whose
directory is gone — that is the definition of an orphan — and a backend that
identifies an index by a marker *inside* the repository cannot resolve it once
the directory is deleted. It then removes nothing, has nothing to complain
about, and answers without an error. Believing that reply is how `cleanup
--apply` printed `✔ removed` while the index stayed put and re-appeared as an
orphan on the very next run, forever.

So `remove()` calls the tool and then re-reads `tools.list`, reporting one of
three things — and only the first is shown as removed:

| Outcome | Meaning |
| --- | --- |
| `removed` | The backend no longer lists the index |
| `failed` | The tool errored, or the index is still listed afterwards |
| `unverified` | The tool was accepted, but no `tools.list` was available to confirm it |

Unlike a slow index call, this check does *not* need to share a session: a
project listing is durable backend state rather than per-process progress, so
asking again in a fresh process is stricter, not weaker — it proves the removal
is visible to the next process, which is exactly what the next `cleanup` run
will be.

When a removal fails this way, the fix is usually to give the backend back the
marker it needs: recreate the directory with just that file (`detectFiles` names
it) and remove the index with the backend's own tooling. `cleanup` prints that
advice, built from your `detectFiles`.

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
  // Optional. Must confirm against the backend before reporting "removed".
  async remove(repoPath: string) { /* → { status: "removed" | "unverified" | "failed" } */ }
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

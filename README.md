# codeindex-sync

Keep code indexes in sync with git activity — for any MCP backend.

Commit, merge, rebase or switch branches, and the affected repository is
re-indexed in the background within seconds. Nothing to run by hand.

```bash
npm install -g codeindex-sync
codeindex-sync init --preset socraticode   # configure a backend
codeindex-sync install                     # install the git hooks
codeindex-sync doctor                      # check it all works
```

Two steps people miss, both covered in the guides below: backend URLs go in the
config's `env` block (git hooks are not a login shell, so your exported
variables are invisible to the indexer), and something has to **drain the
queue** — hooks enqueue but never index inline, so a git command never waits on
a backend.

**Guides:** [Using it with SocratiCode](docs/socraticode.md) ·
[Adding a backend or hook handler](docs/extending.md)

> Not affiliated with, or endorsed by, any backend it drives. codeindex-sync
> contains no third-party backend code — it spawns backends as separate
> processes and speaks MCP to them. Product names describe compatibility only.

## Why this exists

Running a semantic index over a working tree sounds simple. It isn't. Every
behaviour here comes from a failure seen in production:

| Problem | What happens without this |
|---|---|
| **Bursts** | One `git rebase` fires dozens of hooks; naive tools run dozens of concurrent indexers against one GPU |
| **Throwaway worktrees** | A hook fires from a directory that has since been deleted; the indexer dies during interpreter startup with an opaque error |
| **Redundant work** | Worktree churn re-queues the same repo repeatedly, each costing a full tree walk to conclude nothing changed |
| **Crashes** | A worker that dies mid-job silently drops that repository forever |
| **Backend contention** | The backend's own lock is misread as failure, parking healthy repos in `failed/` |
| **Hooks aren't a login shell** | Config exported in `~/.bashrc` is invisible to the indexer, which then writes to the wrong place — silently |

## Commands

| | |
|---|---|
| `init [--preset <id>]` | Create a config from a preset |
| `doctor` | Diagnose config, hooks and backend health — every problem carries a remedy |
| `status` | Queue, worker and failures |
| `sync [repo] [--full]` | Index now |
| `drain` / `once` | Process the queue |
| `retry` / `forget` | Manage failed jobs |
| `unlock [--force]` | Release a stale worker lock |
| `providers [--example]` | Configured providers and available presets |
| `worktrees [--prune]` | Inspect worktrees; drop dangling registrations |
| `hook <name>` | Entry point for git hooks (enqueues; never indexes inline) |

## Adding a backend

Usually no code — describe the MCP server in config:

```json
{
  "providers": [{
    "name": "my-backend",
    "command": "my-index-server",
    "args": ["--stdio"],
    "tools": { "update": "update_index", "index": "rebuild_index" },
    "detectFiles": [".my-backend.json"]
  }]
}
```

See [docs/extending.md](docs/extending.md) for the full field reference, plus how
to write a hook handler for something other than indexing.

## Design

Everything above `provider.ts` is backend-agnostic. If a backend's name appears
in the worker, the abstraction has leaked.

- **Serialised by design.** Indexing backends are usually GPU- or network-bound
  singletons; one job at a time is faster than several.
- **Nothing-changed is settled before any work.** A (HEAD, dirty) fingerprint
  catches the common case: a hook fired for worktree activity that never touched
  this repo. Measured 1.20s → 0.12s, without contacting the backend at all. A
  dirty tree never counts as unchanged, since two sets of uncommitted edits are
  indistinguishable.
- **Coalescing uses an invariant, not a timer.** An index that *started* at T
  observed the filesystem as of T, so a job queued before T is already covered —
  this catches recovered and retried jobs. A real change can never be dropped,
  because its hook fires only after the file changed.
- **`busy` is not failure.** Contention requeues without burning an attempt.
- **The log is the diagnostic.** Append-only, rotated not truncated, and writing
  to it never throws.

## Requirements

Node >= 20. Works on macOS and Linux; CI covers both across Node 20, 22 and 24.

## Licence

MIT — see [LICENSE](LICENSE).

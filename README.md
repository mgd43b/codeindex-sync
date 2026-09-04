# codeindex-sync

Keep code indexes in sync with git activity — for any MCP backend.

Commit, merge, rebase or switch branches, and the affected repository is
re-indexed in the background within seconds. Nothing to run by hand.

Any indexer that speaks MCP works, described entirely in config.
[SocratiCode](https://github.com/giancarloerra/socraticode) is the backend this
was built against and ships as a built-in preset, so that setup is four
commands:

```bash
npm install -g codeindex-sync   # or: brew install mgd43b/taps/codeindex-sync
codeindex-sync init --preset socraticode   # configure a backend
codeindex-sync install                     # install the git hooks
codeindex-sync schedule                    # drain the queue on a timer
codeindex-sync doctor                      # check it all works
```

One step people miss: backend URLs go in the config's `env` block, not your
shell — git hooks are not a login shell, so exported variables are invisible to
the indexer, which then writes somewhere nothing reads. `doctor` checks the
rest, including whether anything is actually draining the queue.

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
| `list [repo] [--all] [--stale] [--json]` | What the backend holds — one repo, or every index with status, age and file counts |
| `sync [repo] [--full]` | Index now |
| `drain` / `once` | Process the queue |
| `retry` / `forget` | Manage failed jobs |
| `unlock [--force]` | Release a stale worker lock |
| `providers [--example]` | Configured providers and available presets |
| `worktrees [--prune\|--gone]` | Inspect worktrees; drop dangling registrations or merged ones |
| `cleanup [--apply]` | Remove indexes whose directory is gone (dry run by default) |
| `schedule` / `unschedule` | Drain the queue on a timer (launchd or systemd) |
| `claim [repo] [--replace]` / `unclaim [--remove]` | Opt a repo in or out by writing the provider's marker file |
| `install-repo` / `uninstall-repo` | Cover a repo that sets its own `core.hooksPath` |
| `completion [shell]` | Shell completion for bash, zsh or fish |
| `hook <name>` | Entry point for git hooks (enqueues; never indexes inline) |

## Backends

| Backend | Status |
|---|---|
| [SocratiCode](https://github.com/giancarloerra/socraticode) | Built-in preset — `init --preset socraticode` |
| Any other MCP indexer | Config only, no code — `init --preset generic-mcp` |

There is one built-in preset because there is one backend this has been run
against in earnest. That is a statement about what has been *verified*, not
about what works: the worker knows nothing about SocratiCode, and the generic
path is exercised in CI against stub MCP servers with arbitrary tool names.

The whole contract is **one MCP tool that re-indexes a path**. Point `update` at
it and you have a working backend:

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

`index` (full rebuild) and `status` (chunk counts for `list`) are optional and
improve behaviour where present. `detectFiles` is how a provider decides a
repository is its own; without it, it claims every repository under `root`.

If you get another backend working, a preset is a few lines of config and a
welcome PR — see [docs/extending.md](docs/extending.md) for the full field
reference, plus how to write a hook handler for something other than indexing.

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

## Releasing

See [docs/releasing.md](docs/releasing.md). Publishing to npm requires
credentials and is a manual step; the Homebrew formula is generated from the
published tarball by `scripts/update-tap.sh`.

## Requirements

Node >= 20. Works on macOS and Linux; CI covers both across Node 20, 22 and 24.

## Licence

MIT — see [LICENSE](LICENSE).

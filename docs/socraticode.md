# Using codeindex-sync with SocratiCode

A complete walkthrough. Roughly five minutes.

> codeindex-sync is not affiliated with SocratiCode. It drives it as a separate
> process over MCP, and contains none of its code.

## What you end up with

Every commit, merge, rebase or branch switch re-indexes the affected repository
in the background. Nothing to run by hand, and a burst of git activity does not
turn into a burst of indexing.

## Prerequisites

SocratiCode reachable via `npx`, and its own backends (Qdrant + Ollama) already
working. Check with:

```bash
npx -y socraticode --version
```

## 1. Install

```bash
npm install -g codeindex-sync
```

## 2. Configure the backend

```bash
codeindex-sync init --preset socraticode
```

That writes `~/.config/codeindex-sync/config.json`:

```json
{
  "providers": [{
    "name": "socraticode",
    "command": "npx",
    "args": ["-y", "socraticode"],
    "tools": {
      "update": "codebase_update",
      "index": "codebase_index",
      "status": "codebase_status"
    },
    "repoArg": "projectPath",
    "detectFiles": [".socraticode.json"]
  }]
}
```

### Tell it where your Qdrant and Ollama are

**This is the step people get wrong.** Git hooks are *not* a login shell — they
never source `~/.bashrc`, `~/.zshenv` or any profile. Anything you export in a
shell is invisible to the indexer, which then falls back to its defaults and
writes to a store nothing else reads. Silently.

So backend URLs go in the config's `env` block, not your shell:

```json
{
  "providers": [{
    "name": "socraticode",
    "command": "npx",
    "args": ["-y", "socraticode"],
    "tools": { "update": "codebase_update", "index": "codebase_index", "status": "codebase_status" },
    "repoArg": "projectPath",
    "detectFiles": [".socraticode.json"],
    "env": {
      "QDRANT_MODE": "external",
      "QDRANT_URL": "https://qdrant.example.internal",
      "QDRANT_API_KEY": "…",
      "OLLAMA_MODE": "external",
      "OLLAMA_URL": "https://ollama.example.internal"
    }
  }]
}
```

Set both modes to `external` explicitly. Their defaults point at *localhost*,
not at your backend, and they fail differently:

- **`QDRANT_MODE`** treats only the exact string `external` as external —
  everything else, including unset, means `managed`, where SocratiCode runs
  Qdrant itself in Docker. A typo (`externl`, `External`) is not rejected; it
  silently falls back to managed and indexes into a local container while your
  real Qdrant stays empty. If Docker isn't running you at least get a clear
  error; if it is, you get a wrong answer quietly.
- **`OLLAMA_MODE`** defaults to `auto`, which probes `localhost:11434`. Unlike
  the Qdrant one, an invalid value raises `Invalid OLLAMA_MODE` immediately.

`QDRANT_URL` and `OLLAMA_URL` are only consulted in external mode, so setting a
URL without the matching mode does nothing at all.

If your Qdrant needs a key, that file now holds a credential:

```bash
chmod 600 ~/.config/codeindex-sync/config.json
```

## 3. Opt each repository in

SocratiCode's preset claims a repo only if it contains `.socraticode.json`:

```bash
cd ~/code/my-project
echo '{"projectId":"my-project"}' > .socraticode.json
```

This does two jobs. It opts the repo in, and it **pins the collection name**.
Without it, SocratiCode derives the name from a hash of the absolute path — so
the same repo checked out at a second path (a git worktree, a CI clone, a
sandbox under `/tmp`) becomes a *separate duplicate index*. Pinning the id makes
the index follow the repository rather than the path.

Commit it if you want the id shared across machines; leave it untracked if not.

Verify:

```bash
codeindex-sync list ~/code/my-project
#   my-project
#     socraticode  indexed  1,240 chunks
```

A repo without the marker reports `does not claim this repo` — that is the
detection working, not an error.

## 4. Install the git hooks

```bash
codeindex-sync install
```

This sets `core.hooksPath` globally and installs a dispatcher for
`post-commit`, `post-checkout`, `post-merge`, `post-rewrite` and
`post-applypatch`.

`core.hooksPath` is global and **exclusive** — it replaces each repository's own
`.git/hooks`. The dispatcher therefore chains whatever a repo already had, so
husky, lefthook and pre-commit keep working. If another tool already owns
`core.hooksPath`, `install` stops and explains rather than taking it over.

Undo at any time:

```bash
codeindex-sync uninstall
```

## 5. Check everything

```bash
codeindex-sync doctor
```

```
Configuration
  ✔ config /Users/you/.config/codeindex-sync/config.json
  ✔ provider socraticode — npx -y socraticode
  ✔ watching /Users/you/workspace

Git hooks
  ✔ global core.hooksPath = /Users/you/.config/git/hooks

Backends
  ✔ socraticode — reachable

Queue
  ✔ no lock held (worker idle)
  ✔ 0 queued
  ✔ no failed jobs

  ✔ No problems found.
```

Anything broken comes with the command that fixes it. `watching` is the root
below which repos are considered — see the troubleshooting note about it.

## 6. Drain the queue

Hooks *enqueue*; they never index inline, because a git command must not wait on
a backend. Something has to drain the queue.

Run it by hand:

```bash
codeindex-sync drain
```

…or on a timer. macOS, `~/Library/LaunchAgents/dev.codeindex.sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.codeindex.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/codeindex-sync</string>
    <string>drain</string>
  </array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.codeindex.sync.plist
```

Use `which codeindex-sync` for the path — a LaunchAgent does not inherit your
shell's `PATH`, for the same reason git hooks do not.

Linux, `~/.config/systemd/user/codeindex-sync.timer` plus a matching
`.service` running `codeindex-sync drain`, is the equivalent.

Draining concurrently is safe: the worker takes a lock and a second run exits
immediately.

## Everyday commands

```bash
codeindex-sync status              # queue, worker, failures
codeindex-sync list                # what the backend knows about this repo
codeindex-sync sync --full         # force a complete reindex
codeindex-sync log 40              # what the worker has been doing
codeindex-sync worktrees --prune   # drop dangling worktree registrations
```

## When something looks wrong

**`doctor` first.** It checks config, hooks, backend reachability and queue
health, and every failure carries a remedy.

**Nothing is being indexed.** Check `core.hooksPath` is set (`doctor` reports
it), that the repo has `.socraticode.json`, and that it lives under the
configured `root` — a global hooksPath fires in *every* repository on the
machine, so codeindex-sync ignores anything outside that root by design.

**`list` says `incomplete`.** A previous run was interrupted. Only a full
reindex clears it: `codeindex-sync sync --full`.

**Jobs land in `failed`.** `codeindex-sync status` shows them and the error;
`codeindex-sync retry` requeues them.

**"another worker is draining".** A previous run died holding the lock:
`codeindex-sync unlock`. It refuses if the holder is genuinely alive.

**Indexing seems to skip.** `[unchanged]` in the log means HEAD had not moved and
the tree was clean, so there was nothing to do — usually a hook fired for
worktree activity that never touched this repo. That is the optimisation working.
`sync --full` bypasses it.

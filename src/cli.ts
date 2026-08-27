#!/usr/bin/env node
/**
 * Command line interface.
 *
 * Design rules, in priority order:
 *
 *  1. `doctor` is the single "what is wrong?" command, and everything it reports
 *     as broken carries a remedy. A diagnosis without a next step is half a
 *     diagnosis.
 *  2. `init` takes someone from nothing to working in one command.
 *  3. Every empty state names the command that fills it.
 *  4. A user never sees a stack trace.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import path from "node:path";
import { ConfigError, configPath, loadConfig, saveConfig, type Config } from "./config.js";
import {
  globalHooksPath,
  listWorktrees,
  mainWorktree,
  pruneWorktrees,
  repoRoot,
  setGlobalHooksPath,
  unsetGlobalHooksPath,
} from "./git.js";
import { HookRegistry, isGitHook, type GitHook } from "./hooks.js";
import { defaultHooksDir, installDispatcher, isOurHooksDir } from "./install.js";
import { WorkerLock } from "./lock.js";
import { Logger } from "./logger.js";
import { resolvePaths } from "./paths.js";
import { PRESETS, findPreset } from "./presets.js";
import { ProviderRegistry } from "./provider.js";
import { McpIndexProvider } from "./providers/mcp-provider.js";
import { Queue, nowIso } from "./queue.js";
import * as ui from "./ui.js";
import { Worker } from "./worker.js";

const VERSION = "0.1.0";

function config(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) ui.fail(err.message, err.remedy);
    throw err;
  }
}

function registryFrom(cfg: Config): ProviderRegistry {
  const reg = new ProviderRegistry();
  for (const p of cfg.providers) reg.register(new McpIndexProvider(p));
  return reg;
}

function workerFrom(cfg: Config, echo = false): Worker {
  const paths = resolvePaths();
  return new Worker({
    paths,
    registry: registryFrom(cfg),
    logger: new Logger(paths.log, cfg.logMaxBytes, echo ? (l) => ui.line(ui.style.dim(l)) : null),
    maxAttempts: cfg.maxAttempts,
    backoffSeconds: cfg.backoffSeconds,
    pruneWorktrees: (repo) => pruneWorktrees(repo),
  });
}

/** Resolve a user-supplied path to the MAIN worktree that owns it. */
function resolveRepo(input: string): string {
  const abs = path.resolve(input);
  if (!existsSync(abs)) ui.fail(`no such directory: ${abs}`);
  const main = mainWorktree(abs) ?? repoRoot(abs);
  if (!main) {
    ui.fail(
      `${abs} is not inside a git repository`,
      "codeindex-sync indexes git repositories; run this from inside one",
    );
  }
  return main;
}

function requireProviders(cfg: Config): void {
  if (cfg.providers.length === 0) {
    ui.fail(
      "no index providers are configured",
      `run ${ui.style.cyan("codeindex-sync init")} to set one up`,
    );
  }
}

const program = new Command();
program
  .name("codeindex-sync")
  .description("Keep code indexes in sync with git activity, for any MCP backend")
  .version(VERSION);

// ── init ──────────────────────────────────────────────────────────────────
program
  .command("init")
  .description("Create a config file from a preset")
  .option("--preset <id>", "preset to use")
  .option("--force", "overwrite an existing config", false)
  .action((opts: { preset?: string; force: boolean }) => {
    const file = configPath();
    if (existsSync(file) && !opts.force) {
      ui.fail(`config already exists at ${file}`, "pass --force to overwrite, or edit it directly");
    }
    if (!opts.preset) {
      ui.heading("Available presets");
      ui.table(PRESETS.map((p) => [ui.style.cyan(p.id), p.summary]));
      ui.line();
      ui.line(`  ${ui.style.dim("then:")} ${ui.style.cyan("codeindex-sync init --preset <id>")}`);
      return;
    }
    const preset = findPreset(opts.preset);
    if (!preset) {
      ui.fail(
        `unknown preset: ${opts.preset}`,
        `known presets: ${PRESETS.map((p) => p.id).join(", ")}`,
      );
    }
    const cfg = loadConfig();
    cfg.providers = [preset.config];
    saveConfig(cfg, file);
    ui.heading(`Configured ${preset.title}`);
    ui.ok(`wrote ${file}`);
    if (preset.note) ui.info(preset.note);
    ui.line();
    ui.line(`  ${ui.style.dim("next:")} ${ui.style.cyan("codeindex-sync doctor")}`);
  });

// ── doctor ────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Diagnose configuration, hooks and backend health")
  .action(async () => {
    const cfg = config();
    const paths = resolvePaths();
    let problems = 0;

    ui.heading("Configuration");
    const file = configPath();
    if (existsSync(file)) ui.ok(`config ${file}`);
    else {
      ui.warn("no config file", `run ${ui.style.cyan("codeindex-sync init")}`);
      problems++;
    }
    if (cfg.providers.length === 0) {
      ui.bad("no providers configured", `run ${ui.style.cyan("codeindex-sync init")}`);
      problems++;
    } else {
      for (const p of cfg.providers) {
        ui.ok(`provider ${ui.style.bold(p.name)} — ${p.command} ${p.args.join(" ")}`);
      }
    }
    ui.ok(`watching ${cfg.root}`);

    ui.heading("Git hooks");
    const hooks = globalHooksPath();
    if (hooks) ui.ok(`global core.hooksPath = ${hooks}`);
    else {
      ui.warn(
        "global core.hooksPath is unset — nothing will enqueue automatically",
        "point it at a hooks directory that calls `codeindex-sync hook <name>`",
      );
      problems++;
    }

    ui.heading("Backends");
    if (cfg.providers.length === 0) ui.empty("nothing to check");
    for (const provider of registryFrom(cfg).all()) {
      for (const h of await provider.health()) {
        if (h.ok) ui.ok(`${h.component} — ${h.detail}`);
        else {
          ui.bad(`${h.component} — ${h.detail}`, h.remedy);
          problems++;
        }
      }
    }

    ui.heading("Queue");
    const queue = new Queue(paths.queue);
    const lock = new WorkerLock(paths.lock);
    const held = lock.read();
    if (held && !lock.isHeld()) {
      ui.warn(
        `stale lock from dead pid ${held.pid}`,
        `run ${ui.style.cyan("codeindex-sync unlock")}`,
      );
      problems++;
    } else if (held) ui.ok(`worker running (pid ${held.pid})`);
    else ui.ok("no lock held (worker idle)");
    ui.ok(`${queue.size} queued`);
    const failed = workerFrom(cfg).listFailed();
    if (failed.length) {
      ui.warn(
        `${failed.length} failed job(s)`,
        `run ${ui.style.cyan("codeindex-sync status")} for details`,
      );
      problems++;
    } else ui.ok("no failed jobs");

    ui.line();
    if (problems === 0) ui.line(`  ${ui.mark.ok} ${ui.style.green("No problems found.")}`);
    else ui.line(`  ${ui.mark.warn} ${problems} problem(s) found — see the arrows above.`);
    process.exitCode = problems === 0 ? 0 : 1;
  });

// ── status ────────────────────────────────────────────────────────────────
program
  .command("status", { isDefault: true })
  .description("Show the queue, worker and recent failures")
  .action(() => {
    const cfg = config();
    const paths = resolvePaths();
    const queue = new Queue(paths.queue);
    const lock = new WorkerLock(paths.lock);

    ui.heading("Worker");
    const held = lock.read();
    if (!held) ui.info("idle");
    else if (lock.isHeld()) ui.info(`running (pid ${held.pid}, since ${held.since || "?"})`);
    else ui.warn(`stale lock from dead pid ${held.pid}`, "codeindex-sync unlock");

    ui.heading("Queue");
    const jobs = queue.list();
    if (jobs.length === 0) ui.empty("nothing queued", "codeindex-sync sync <repo>");
    else {
      ui.table(
        jobs.map((j) => [
          ui.style.cyan(path.basename(j.repoPath)),
          j.hook,
          ui.relativeTime(j.enqueuedAt),
          j.full ? ui.style.yellow("full") : "",
        ]),
      );
    }

    const failed = workerFrom(cfg).listFailed();
    if (failed.length) {
      ui.heading("Failed");
      ui.table(failed.map((j) => [ui.style.red(path.basename(j.repoPath)), j.repoPath]));
      ui.line();
      ui.line(`  ${ui.style.dim("retry:")} ${ui.style.cyan("codeindex-sync retry")}`);
    }
  });

// ── sync ──────────────────────────────────────────────────────────────────
program
  .command("sync [repo]")
  .description("Index a repository now")
  .option("--full", "force a complete reindex", false)
  .action(async (repo: string | undefined, opts: { full: boolean }) => {
    const cfg = config();
    requireProviders(cfg);
    const target = resolveRepo(repo ?? process.cwd());
    const worker = workerFrom(cfg, true);
    const queue = new Queue(resolvePaths().queue);
    const job = queue.enqueue({ repoPath: target, hook: "manual", full: opts.full });
    const result = await worker.runJob(job);
    ui.line();
    switch (result.outcome) {
      case "indexed":
        ui.ok(result.summary || "indexed");
        break;
      case "coalesced":
        ui.info(`skipped — ${result.reason}`);
        break;
      case "busy":
        ui.warn("backend is already indexing this repo; job left queued");
        break;
      case "skipped":
        ui.warn(`skipped — ${result.reason}`);
        break;
      default:
        ui.bad(`failed — ${"error" in result ? result.error : "unknown"}`);
        process.exitCode = 1;
    }
  });

// ── drain / once ──────────────────────────────────────────────────────────
program
  .command("drain")
  .description("Process the queue until it is empty")
  .action(async () => {
    const cfg = config();
    requireProviders(cfg);
    const paths = resolvePaths();
    const lock = new WorkerLock(paths.lock);
    const got = lock.acquire();
    if (!got.acquired) {
      ui.info(`another worker is draining (pid ${got.heldBy}); nothing to do`);
      return;
    }
    try {
      const results = await workerFrom(cfg, true).drain();
      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {});
      ui.line();
      if (results.length === 0) ui.empty("queue was empty");
      else {
        ui.info(
          Object.entries(counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(", "),
        );
      }
    } finally {
      lock.release();
    }
  });

program
  .command("once")
  .description("Process a single queued job")
  .action(async () => {
    const cfg = config();
    requireProviders(cfg);
    const result = await workerFrom(cfg, true).once();
    if (!result) ui.empty("queue was empty");
  });

// ── retry / forget / unlock ───────────────────────────────────────────────
program
  .command("retry [match]")
  .description("Requeue failed jobs")
  .action((match: string | undefined) => {
    const n = workerFrom(config()).retryFailed(match);
    if (n) ui.ok(`requeued ${n} job(s)`);
    else ui.empty("no failed jobs matched");
  });

program
  .command("forget <match>")
  .description("Drop failed jobs without retrying (use --all for everything)")
  .action((match: string) => {
    const n = workerFrom(config()).forgetFailed(match);
    if (n) ui.ok(`dropped ${n} job(s)`);
    else ui.empty("no failed jobs matched");
  });

program
  .command("unlock")
  .description("Release the worker lock")
  .option("--force", "break the lock even if the holder is alive", false)
  .action((opts: { force: boolean }) => {
    const r = new WorkerLock(resolvePaths().lock).forceRelease(opts.force);
    if (r.released) ui.ok(r.heldBy ? `released lock (was pid ${r.heldBy})` : "no lock held");
    else {
      ui.fail(
        `pid ${r.heldBy} is alive and holding the lock`,
        "wait for it, or pass --force to break it (two indexers may then run at once)",
      );
    }
  });

// ── providers / extensions ────────────────────────────────────────────────
program
  .command("providers")
  .description("List configured providers and available presets")
  .option("--example", "print an example provider block", false)
  .action((opts: { example: boolean }) => {
    if (opts.example) {
      ui.line(JSON.stringify({ providers: [PRESETS[1]?.config] }, null, 2));
      return;
    }
    const cfg = config();
    ui.heading("Configured");
    if (cfg.providers.length === 0) ui.empty("none", "codeindex-sync init");
    else {
      ui.table(
        cfg.providers.map((p) => [ui.style.cyan(p.name), `${p.command} ${p.args.join(" ")}`]),
      );
    }
    ui.heading("Presets");
    ui.table(PRESETS.map((p) => [ui.style.cyan(p.id), p.summary]));
  });

program
  .command("extensions")
  .description("List registered git-hook handlers")
  .action(() => {
    // Indexing is only the first subscriber; third-party handlers register here.
    const all = new HookRegistry().all();
    ui.heading("Hook handlers");
    if (all.length === 0) {
      ui.empty("only the built-in indexer is active", "see docs/extending.md to add one");
    } else {
      ui.table(all.map((h) => [ui.style.cyan(h.name), h.hooks.join(", "), h.description]));
    }
  });

// ── worktrees ─────────────────────────────────────────────────────────────
program
  .command("worktrees [repo]")
  .description("Show worktrees and prune dangling registrations")
  .option("--prune", "remove registrations whose directory is gone", false)
  .action((repo: string | undefined, opts: { prune: boolean }) => {
    const target = resolveRepo(repo ?? process.cwd());
    if (opts.prune) {
      const before = listWorktrees(target).length;
      pruneWorktrees(target, "now");
      const after = listWorktrees(target).length;
      ui.ok(`pruned ${before - after} dangling registration(s), ${after} remain`);
      return;
    }
    const trees = listWorktrees(target);
    ui.heading(`Worktrees of ${path.basename(target)}`);
    ui.table(
      trees.map((t) => [
        t.prunable ? ui.style.red("dangling") : ui.style.green("live"),
        t.branch ?? ui.style.dim("(detached)"),
        t.path.replace(process.env["HOME"] ?? "~", "~"),
      ]),
    );
    const dangling = trees.filter((t) => t.prunable).length;
    if (dangling) {
      ui.line();
      ui.warn(
        `${dangling} dangling registration(s)`,
        "these hand the indexer a deleted directory: codeindex-sync worktrees --prune",
      );
    }
  });

// ── install / uninstall ───────────────────────────────────────────────────
program
  .command("install")
  .description("Install the git hook dispatcher globally")
  .option("--hooks-dir <dir>", "where to install", defaultHooksDir())
  .option("--yes", "skip the confirmation prompt", false)
  .action((opts: { hooksDir: string; yes: boolean }) => {
    const existing = globalHooksPath();
    // core.hooksPath is global and exclusive: it REPLACES each repo's own
    // .git/hooks. Taking it over from another tool without warning would
    // silently disable that tool everywhere.
    if (existing && path.resolve(existing) !== path.resolve(opts.hooksDir) && !isOurHooksDir(existing)) {
      ui.heading("Another tool owns your global git hooks");
      ui.warn(`core.hooksPath is currently ${existing}`);
      ui.line();
      ui.line("  codeindex-sync would take it over. Its dispatcher chains each repo's");
      ui.line("  own .git/hooks, but it does NOT chain another global hooksPath.");
      ui.line();
      ui.line(`  ${ui.style.dim("to proceed anyway:")} ${ui.style.cyan("codeindex-sync install --yes")}`);
      if (!opts.yes) {
        process.exitCode = 1;
        return;
      }
    }

    const res = installDispatcher(opts.hooksDir);
    ui.heading("Installed git hooks");
    ui.ok(`dispatcher in ${res.hooksDir}`);
    ui.table(res.installed.map((h) => [ui.style.cyan(h)]));
    setGlobalHooksPath(res.hooksDir);
    ui.ok(`core.hooksPath = ${res.hooksDir}`);
    ui.line();
    ui.info("each repo's own .git/hooks are chained, so existing tooling keeps working");
    ui.line(`  ${ui.style.dim("next:")} ${ui.style.cyan("codeindex-sync doctor")}`);
  });

program
  .command("uninstall")
  .description("Remove the global git hooks setting")
  .action(() => {
    const existing = globalHooksPath();
    if (!existing) {
      ui.empty("core.hooksPath is not set; nothing to undo");
      return;
    }
    if (!isOurHooksDir(existing)) {
      ui.fail(
        `core.hooksPath points at ${existing}, which was not installed by codeindex-sync`,
        "leaving it alone — unset it yourself with `git config --global --unset core.hooksPath`",
      );
    }
    unsetGlobalHooksPath();
    ui.ok("unset core.hooksPath");
    ui.info(`hook scripts left in ${existing} — delete them if you want them gone`);
  });

// ── hook entry point ──────────────────────────────────────────────────────
program
  .command("hook <name> [args...]")
  .description("Entry point for git hooks (enqueues only; never indexes inline)")
  .action((name: string, args: string[]) => {
    // Unknown hooks are ignored rather than erroring: this runs inside the
    // user's git commands and must never break them.
    if (!isGitHook(name)) return;
    const cfg = config();
    // Resolve to the MAIN worktree, so a linked worktree does not create a
    // second index and a deleted worktree cwd is never used.
    const root = mainWorktree(process.cwd()) ?? repoRoot(process.cwd());
    if (!root || !root.startsWith(cfg.root)) return;
    new Queue(resolvePaths().queue).enqueue({
      repoPath: root,
      hook: name as GitHook,
      full: false,
      enqueuedAt: nowIso(),
    });
    void args;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  ui.fail(err instanceof Error ? err.message : String(err));
});

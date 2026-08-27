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
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigError, configPath, loadConfig, saveConfig, type Config } from "./config.js";
import {
  deleteBranch,
  globalHooksPath,
  goneBranches,
  isDirty,
  listWorktrees,
  mainWorktree,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  setGlobalHooksPath,
  unsetGlobalHooksPath,
} from "./git.js";
import { isGitHook, type GitHook } from "./hooks.js";
import {
  defaultHooksDir,
  installDispatcher,
  installRepoDispatcher,
  isOurHooksDir,
  repoCoverage,
  uninstallRepoDispatcher,
} from "./install.js";
import { WorkerLock } from "./lock.js";
import { Logger } from "./logger.js";
import { resolvePaths } from "./paths.js";
import { PRESETS, findPreset } from "./presets.js";
import {
  DEFAULT_INTERVAL,
  detectScheduler,
  installSchedule,
  removeSchedule,
  resolveBinary,
  scheduleInstalled,
} from "./schedule.js";
import { ProviderRegistry } from "./provider.js";
import { McpIndexProvider } from "./providers/mcp-provider.js";
import { Queue, nowIso } from "./queue.js";
import * as ui from "./ui.js";
import { buildHookRegistry } from "./runtime.js";
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

    // A global hooksPath says nothing about THIS repo: local config wins, so a
    // repo with its own hooksPath is bypassed entirely while the global check
    // still reads green. Report what git will actually use.
    const here = repoRoot(process.cwd());
    if (here) {
      const cov = repoCoverage(here, hooks);
      const name = path.basename(here);
      if (cov.covered) ui.ok(`${name} — covered by the ${cov.reason}`);
      else {
        ui.bad(
          `${name} — not covered: ${cov.reason}`,
          `run ${ui.style.cyan(`codeindex-sync install-repo ${here}`)}`,
        );
        problems++;
      }
    }

    ui.heading("Scheduling");
    if (detectScheduler() === "unsupported") {
      ui.info("no supported scheduler here — run `codeindex-sync drain` yourself");
    } else if (scheduleInstalled()) {
      ui.ok("a timer is draining the queue");
    } else {
      // Not a problem: the hook dispatcher fires a detached drain, so commits
      // index immediately without a timer. A timer is a safety net — it picks
      // up jobs left behind when a drain is killed mid-run, and retries — so
      // this is a recommendation, not a fault.
      ui.info(
        `no timer — commits still index immediately; ${ui.style.cyan("codeindex-sync schedule")} adds a safety net`,
      );
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
  .command("status")
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

// ── list ──────────────────────────────────────────────────────────────────
program
  .command("list [repo]")
  .description("Show what each provider knows about a repository")
  .option("--all", "every index the backend holds, not just this repo", false)
  .option("--stale", "with --all, only rows needing attention", false)
  .option("--json", "machine-readable output", false)
  .option("--sort <key>", "with --all: recency (default), path or name", "recency")
  .action(async (repo: string | undefined, opts: ListOpts) => {
    const cfg = config();
    requireProviders(cfg);
    if (opts.all) {
      await listAll(cfg, opts);
      return;
    }
    const target = resolveRepo(repo ?? process.cwd());
    ui.heading(path.basename(target));
    const rows: string[][] = [];
    const json: Record<string, unknown>[] = [];
    for (const provider of registryFrom(cfg).all()) {
      if (!(await provider.detect(target))) {
        rows.push([ui.style.dim(provider.name), ui.style.dim("does not claim this repo"), ""]);
        continue;
      }
      const status = await provider.status(target);
      if (!status) {
        rows.push([ui.style.cyan(provider.name), ui.style.dim("no status reported"), ""]);
        continue;
      }
      const state = status.incomplete
        ? ui.style.yellow("incomplete")
        : status.indexed
          ? ui.style.green("indexed")
          : ui.style.dim("not indexed");
      const detail = [
        status.files === undefined ? "" : `${status.files} files`,
        status.chunks === undefined ? "" : `${status.chunks} chunks`,
      ]
        .filter(Boolean)
        .join(", ");
      rows.push([ui.style.cyan(provider.name), state, detail]);
      json.push({
        provider: provider.name,
        indexed: status.indexed,
        incomplete: status.incomplete ?? false,
        ...(status.files === undefined ? {} : { files: status.files }),
        ...(status.chunks === undefined ? {} : { chunks: status.chunks }),
      });
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ repo: target, providers: json }, null, 2) + "\n");
      return;
    }
    ui.table(rows);
    if (rows.some((r) => ui.stripAnsi(r[1] ?? "").includes("incomplete"))) {
      ui.line();
      ui.warn(
        "an index is incomplete — a previous run was interrupted",
        `only a full reindex clears this: ${ui.style.cyan("codeindex-sync sync --full")}`,
      );
    }
  });

// ── log ───────────────────────────────────────────────────────────────────
program
  .command("log [lines]")
  .description("Show the worker log")
  .option("-f, --follow", "keep printing as the worker writes", false)
  .action((lines: string | undefined, opts: { follow: boolean }) => {
    const file = resolvePaths().log;
    if (!existsSync(file) && !opts.follow) {
      ui.empty("no log yet", "codeindex-sync sync <repo>");
      return;
    }
    const n = Number.parseInt(lines ?? "40", 10);
    if (existsSync(file)) {
      const all = readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (all.length === 0 && !opts.follow) {
        ui.empty("log is empty");
        return;
      }
      for (const l of all.slice(-(Number.isFinite(n) ? n : 40))) ui.line(`  ${l}`);
    }
    if (!opts.follow) return;

    // Polling rather than fs.watch: the log is rotated (renamed) rather than
    // truncated, and watch semantics for a replaced inode differ per platform.
    // Tracking size, and resetting when it shrinks, survives rotation anywhere.
    let offset = existsSync(file) ? statSync(file).size : 0;
    const tick = (): void => {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < offset) offset = 0; // rotated
      if (size === offset) return;
      const fd = openSync(file, "r");
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      for (const l of buf.toString("utf8").split("\n").filter(Boolean)) ui.line(`  ${l}`);
    };
    const timer = setInterval(tick, 500);
    const stop = (): void => {
      clearInterval(timer);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
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
    const all = buildHookRegistry(config()).all();
    ui.heading("Hook handlers");
    ui.table(all.map((h) => [ui.style.cyan(h.name), h.hooks.join(", "), h.description]));
    ui.line();
    ui.line(`  ${ui.style.dim("add one:")} see docs/extending.md`);
  });

// ── worktrees ─────────────────────────────────────────────────────────────
program
  .command("worktrees [repo]")
  .description("Show worktrees and prune dangling registrations")
  .option("--prune", "remove registrations whose directory is gone", false)
  .option("--gone", "remove worktrees whose upstream branch was deleted", false)
  .option("--apply", "with --gone, actually remove them (default: dry run)", false)
  .action((repo: string | undefined, opts: { prune: boolean; gone: boolean; apply: boolean }) => {
    const target = resolveRepo(repo ?? process.cwd());
    if (opts.gone) {
      pruneGoneWorktrees(target, opts.apply);
      return;
    }
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
interface ListOpts {
  all: boolean;
  stale: boolean;
  json: boolean;
  sort: string;
}

/** A row of the `list --all` table: what the backend holds, plus live state. */
interface ProjectRow {
  provider: string;
  path: string;
  exists: boolean;
  collection?: string;
  files?: string;
  lastIndexedAt?: string;
  incomplete?: boolean;
  /** Live worker/queue state, which the backend cannot know about. */
  state: "running" | "queued" | "gone" | "incomplete" | "ok";
}

/** "17m", "4h", "47h" — coarse on purpose; this is a freshness cue, not a clock. */
function age(iso: string | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 72) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Shorten a path for display: $HOME becomes ~, and anything still too long
 * keeps its tail, which is the part that identifies the repo.
 */
function shortPath(p: string, max = 56): string {
  const home = homedir();
  let out = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (out.length > max) out = `\u2026${out.slice(out.length - max + 1)}`;
  return out;
}

/**
 * Every index across every provider, joined with what this machine knows.
 *
 * The backend can say when a repo was last indexed; only the queue and the
 * processing directory know that one is running or waiting right now, and only
 * the filesystem knows the directory is gone. Merging them here is what makes
 * one table answer "is anything wrong".
 */
async function collectProjects(
  cfg: Config,
): Promise<{ rows: ProjectRow[]; unsupported: string[] }> {
  const paths = resolvePaths();
  const queued = new Set(new Queue(paths.queue).list().map((j) => path.resolve(j.repoPath)));
  const running = new Set(
    new Queue(paths.processing).list().map((j) => path.resolve(j.repoPath)),
  );

  const rows: ProjectRow[] = [];
  const unsupported: string[] = [];
  for (const provider of registryFrom(cfg).all()) {
    const projects = provider.projects ? await provider.projects() : null;
    if (projects === null) {
      unsupported.push(provider.name);
      continue;
    }
    for (const proj of projects) {
      const exists = existsSync(proj.path);
      const resolved = path.resolve(proj.path);
      const state: ProjectRow["state"] = running.has(resolved)
        ? "running"
        : queued.has(resolved)
          ? "queued"
          : !exists
            ? "gone"
            : proj.incomplete
              ? "incomplete"
              : "ok";
      rows.push({
        provider: provider.name,
        path: proj.path,
        exists,
        state,
        ...(proj.collection === undefined ? {} : { collection: proj.collection }),
        ...(proj.files === undefined ? {} : { files: proj.files }),
        ...(proj.lastIndexedAt === undefined ? {} : { lastIndexedAt: proj.lastIndexedAt }),
        ...(proj.incomplete === undefined ? {} : { incomplete: proj.incomplete }),
      });
    }
  }
  return { rows, unsupported };
}

const STATE_STYLE: Record<ProjectRow["state"], (s: string) => string> = {
  running: ui.style.cyan,
  queued: ui.style.dim,
  gone: ui.style.red,
  incomplete: ui.style.yellow,
  ok: ui.style.green,
};

async function listAll(cfg: Config, opts: ListOpts): Promise<void> {
  const { rows, unsupported } = await collectProjects(cfg);
  const interesting = (r: ProjectRow): boolean => r.state !== "ok";
  const shown = (opts.stale ? rows.filter(interesting) : rows).sort((a, b) => {
    if (opts.sort === "name") {
      return path.basename(a.path).localeCompare(path.basename(b.path));
    }
    if (opts.sort === "path") return a.path.localeCompare(b.path);
    // Default: most recently indexed first, which puts active work on top.
    const at = Date.parse(a.lastIndexedAt ?? "") || 0;
    const bt = Date.parse(b.lastIndexedAt ?? "") || 0;
    return bt - at;
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ projects: shown, unsupported }, null, 2) + "\n");
    return;
  }

  ui.heading(opts.stale ? "Indexes needing attention" : "All indexes");
  if (shown.length === 0) {
    ui.empty(opts.stale ? "nothing needs attention" : "no indexes reported");
  } else {
    // Bold, not dim: `dim` is this codebase's mark for secondary data, and the
    // collection column uses it — a dim header made the two indistinguishable.
    // Three levels now read as a hierarchy: bold header, plain data, dim aside.
    const header = ["STATUS", "AGE", "FILES", "PROJECT", "COLLECTION"].map((h) =>
      ui.style.bold(h),
    );
    ui.table(
      [
        header,
        ...shown.map((r) => [
          STATE_STYLE[r.state](r.state),
          age(r.lastIndexedAt),
          r.files ?? "",
          shortPath(r.path),
          ui.style.dim(r.collection ?? ""),
        ]),
      ],
      { right: [1, 2] },
    );
  }
  for (const name of unsupported) {
    ui.info(`${name} cannot enumerate indexes (no \`tools.list\` configured)`);
  }

  const gone = rows.filter((r) => r.state === "gone").length;
  const incomplete = rows.filter((r) => r.state === "incomplete").length;
  if (!opts.stale && (gone || incomplete)) ui.line();
  if (!opts.stale && gone > 0) {
    ui.warn(
      `${gone} index(es) point at directories that no longer exist`,
      `review with ${ui.style.cyan("codeindex-sync cleanup")}`,
    );
  }
  if (!opts.stale && incomplete > 0) {
    ui.warn(
      `${incomplete} index(es) are incomplete — a previous run was interrupted`,
      `only a full reindex clears this: ${ui.style.cyan("codeindex-sync sync <repo> --full")}`,
    );
  }
}

/**
 * Remove worktrees whose upstream branch is gone — the worktree analogue of
 * deleting "[gone]" branches after a squash-merge.
 *
 * Squash merges are why ancestry cannot be used to decide this: the commits
 * never appear in the target branch, so a merged worktree looks unmerged
 * forever. A deleted upstream is the signal that actually fires.
 *
 * Three things are never touched, because each can hold work that exists
 * nowhere else: the main worktree, a detached HEAD, and anything with
 * uncommitted changes. Dry run unless --apply.
 */
function pruneGoneWorktrees(repo: string, apply: boolean): void {
  const main = mainWorktree(repo) ?? repo;
  const gone = new Set(goneBranches(main));
  const trees = listWorktrees(main);

  const candidates: { path: string; branch: string }[] = [];
  const skipped: string[][] = [];
  for (const t of trees) {
    if (path.resolve(t.path) === path.resolve(main)) continue;
    if (!t.branch) {
      skipped.push([ui.style.dim(path.basename(t.path)), ui.style.dim("detached HEAD")]);
      continue;
    }
    if (!gone.has(t.branch)) continue;
    if (existsSync(t.path) && isDirty(t.path)) {
      skipped.push([ui.style.yellow(path.basename(t.path)), "uncommitted changes"]);
      continue;
    }
    candidates.push({ path: t.path, branch: t.branch });
  }

  ui.heading(apply ? "Removing merged worktrees" : "Merged worktrees (dry run)");
  if (candidates.length === 0) ui.empty("nothing to remove");
  else
    ui.table(
      candidates.map((c) => [ui.style.cyan(c.branch), ui.style.dim(c.path)]),
    );
  if (skipped.length > 0) {
    ui.line();
    ui.heading("Skipped");
    ui.table(skipped);
  }
  if (!apply) {
    if (candidates.length > 0) {
      ui.line();
      ui.info(`re-run with ${ui.style.cyan("--apply")} to remove ${candidates.length} worktree(s)`);
    }
    return;
  }
  let removed = 0;
  for (const c of candidates) {
    if (removeWorktree(main, c.path)) {
      deleteBranch(main, c.branch);
      ui.ok(`removed ${c.branch}`);
      removed++;
    } else ui.bad(`could not remove ${c.path}`);
  }
  ui.line();
  ui.ok(`${removed} of ${candidates.length} removed`);
}

// ── completion ────────────────────────────────────────────────────────────
/**
 * Completion scripts are generated from commander's own command list rather
 * than a hand-written array, so a new command is completable the moment it
 * exists. A list that drifts out of date is worse than none: it teaches the
 * wrong names.
 */
// The \$ escapes below mirror install.ts: shell sigils are escaped uniformly so
// the rule stays "shell $ is always escaped" rather than the error-prone "escape
// only where it currently matters". The first braced shell variable added here
// would otherwise become JS interpolation and silently corrupt the script.
/* eslint-disable no-useless-escape */
function completionScript(shell: string, commands: string[]): string {
  const words = commands.join(" ");
  if (shell === "bash") {
    return `# codeindex-sync bash completion
_codeindex_sync() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${words}" -- "\$cur") )
  else
    COMPREPLY=( \$(compgen -d -- "\$cur") )
  fi
}
complete -F _codeindex_sync codeindex-sync
`;
  }
  if (shell === "zsh") {
    return `#compdef codeindex-sync
# codeindex-sync zsh completion
_codeindex_sync() {
  local -a cmds
  cmds=(${commands.map((c) => `'${c}'`).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
  else
    _files -/
  fi
}
compdef _codeindex_sync codeindex-sync
`;
  }
  return `# codeindex-sync fish completion
${commands
  .map((c) => `complete -c codeindex-sync -n __fish_use_subcommand -a ${c}`)
  .join("\n")}
`;
}

/* eslint-enable no-useless-escape */

program
  .command("completion [shell]")
  .description("Print a shell completion script (bash, zsh or fish)")
  .action((shell: string | undefined) => {
    const target = (shell ?? process.env["SHELL"]?.split("/").pop() ?? "bash").toLowerCase();
    if (!["bash", "zsh", "fish"].includes(target)) {
      ui.fail(`unknown shell "${target}"`, "supported: bash, zsh, fish");
    }
    const commands = program.commands
      .map((c) => c.name())
      .filter((n) => n !== "help")
      .sort();
    process.stdout.write(completionScript(target, commands));
  });

// ── schedule / unschedule ─────────────────────────────────────────────────
program
  .command("schedule")
  .description("Drain the queue automatically on a timer (launchd or systemd)")
  .option("--interval <seconds>", "how often to drain", String(DEFAULT_INTERVAL))
  .action((opts: { interval: string }) => {
    const interval = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(interval) || interval < 10) {
      ui.fail("--interval must be a number of seconds, at least 10", "e.g. --interval 120");
    }
    const binary = resolveBinary();
    if (!path.isAbsolute(binary)) {
      // A bare name resolves at the terminal but not under a scheduler, which
      // looks configured while doing nothing.
      ui.fail(
        `cannot determine an absolute path for the binary (got "${binary}")`,
        "install it globally first: npm install -g codeindex-sync",
      );
    }
    const res = installSchedule(binary, interval);
    if (res.scheduler === "unsupported") {
      ui.bad("no supported scheduler on this platform", "run `codeindex-sync drain` yourself");
      process.exitCode = 1;
      return;
    }
    ui.heading(`Scheduled via ${res.scheduler}`);
    for (const f of res.files) ui.ok(f);
    ui.ok(`draining every ${interval}s using ${binary}`);
    if (!res.loaded) {
      ui.warn("written but not activated", res.hint ?? "load it yourself");
      process.exitCode = 1;
      return;
    }
    ui.line();
    ui.line(`  ${ui.style.dim("undo:")} ${ui.style.cyan("codeindex-sync unschedule")}`);
  });

program
  .command("unschedule")
  .description("Stop draining on a timer")
  .action(() => {
    const res = removeSchedule();
    if (res.removed.length === 0) {
      ui.info("nothing scheduled");
      return;
    }
    for (const f of res.removed) ui.ok(`removed ${f}`);
  });

// ── cleanup ───────────────────────────────────────────────────────────────
program
  .command("cleanup")
  .description("Remove indexes whose directory no longer exists (dry run by default)")
  .option("--apply", "actually remove them", false)
  .action(async (opts: { apply: boolean }) => {
    const cfg = config();
    requireProviders(cfg);
    const { rows, unsupported } = await collectProjects(cfg);
    const orphans = rows.filter((r) => !r.exists);

    ui.heading(opts.apply ? "Removing orphaned indexes" : "Orphaned indexes (dry run)");
    if (orphans.length === 0) {
      ui.empty("nothing to clean up");
      for (const n of unsupported) ui.info(`${n} cannot enumerate indexes`);
      return;
    }
    ui.table(orphans.map((r) => [ui.style.cyan(r.provider), ui.style.red("gone"), r.path]));

    if (!opts.apply) {
      ui.line();
      // Destructive and unrecoverable — a reindex is the only way back, so the
      // default is always to show rather than do.
      ui.info(`re-run with ${ui.style.cyan("--apply")} to remove ${orphans.length} index(es)`);
      return;
    }
    const registry = registryFrom(cfg);
    let removed = 0;
    for (const orphan of orphans) {
      const provider = registry.all().find((p) => p.name === orphan.provider);
      if (!provider?.remove) {
        ui.bad(`${orphan.provider} cannot remove indexes`, "configure `tools.remove`");
        continue;
      }
      if (await provider.remove(orphan.path)) {
        ui.ok(`removed ${orphan.path}`);
        removed++;
      } else {
        ui.bad(`could not remove ${orphan.path}`);
      }
    }
    ui.line();
    ui.ok(`${removed} of ${orphans.length} removed`);
  });

// ── install-repo / uninstall-repo ──────────────────────────────────────────
program
  .command("install-repo [repo]")
  .description("Cover a repo that sets its own core.hooksPath (husky, .githooks)")
  .action((repo: string | undefined) => {
    const target = resolveRepo(repo ?? process.cwd());
    const paths = resolvePaths();
    const res = installRepoDispatcher(target, paths.repoHooks);

    ui.heading(`Covered ${path.basename(target)}`);
    ui.ok(`dispatcher in ${res.hooksDir}`);
    ui.ok(`core.hooksPath (local) = ${res.hooksDir}`);
    if (res.chained) ui.info(`chaining its previous hooks in ${res.chained}`);
    else ui.info("no previous hooksPath — .git/hooks is chained");
    if (res.alreadyOurs) ui.info("already covered; dispatcher refreshed");
    ui.line();
    ui.line(`  ${ui.style.dim("•")} nothing was written inside the repository`);
    ui.line(`  ${ui.style.dim("undo:")} ${ui.style.cyan(`codeindex-sync uninstall-repo ${target}`)}`);
  });

program
  .command("uninstall-repo [repo]")
  .description("Undo install-repo, restoring the repo's own core.hooksPath")
  .action((repo: string | undefined) => {
    const target = resolveRepo(repo ?? process.cwd());
    const paths = resolvePaths();
    const res = uninstallRepoDispatcher(target, paths.repoHooks);
    if (!res.wasOurs) {
      ui.info(`${path.basename(target)} is not covered by a repo-scoped dispatcher`);
      return;
    }
    if (res.restored) ui.ok(`restored core.hooksPath = ${res.restored}`);
    else ui.ok("cleared core.hooksPath (the global dispatcher applies again)");
  });

program
  .command("hook <name> [args...]")
  .description("Entry point for git hooks (enqueues only; never indexes inline)")
  .action(async (name: string, args: string[]) => {
    // Unknown hooks are ignored rather than erroring: this runs inside the
    // user's git commands and must never break them.
    if (!isGitHook(name)) return;
    const cfg = config();
    // Resolve to the MAIN worktree, so a linked worktree does not create a
    // second index and a deleted worktree cwd is never used.
    const root = mainWorktree(process.cwd()) ?? repoRoot(process.cwd());
    if (!root) return;
    // Dispatch through the registry rather than enqueuing directly: the
    // built-in indexer is just another subscriber, so third-party handlers
    // receive the same event on the same terms.
    await buildHookRegistry(cfg).dispatch({
      hook: name as GitHook,
      repoPath: root,
      args,
      at: nowIso(),
    });
  });

/**
 * Bare `codeindex-sync` should mean `status` — but a *misspelled* command must
 * be an error, not a silent fallback to it. Commander's `isDefault` cannot tell
 * the two apart: with it set, `codeindex-sync statsu` prints the queue and
 * exits 0, so a typo looks like it worked. Applying the default here instead
 * leaves every unrecognised word on commander's own error path, which also
 * suggests the nearest real command.
 */
function withDefaultCommand(argv: string[]): string[] {
  const firstWord = argv.slice(2).find((a) => !a.startsWith("-"));
  return firstWord ? argv : [...argv, "status"];
}

program.showSuggestionAfterError(true);

program.parseAsync(withDefaultCommand(process.argv)).catch((err: unknown) => {
  ui.fail(err instanceof Error ? err.message : String(err));
});

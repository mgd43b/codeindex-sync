/**
 * The worker: drains the queue, one repository at a time.
 *
 * Serialisation is deliberate. Indexing backends are typically GPU- or
 * network-bound singletons, so running several at once makes everything slower
 * and can exhaust the backend. One job at a time is the design; the lock that
 * enforces it across processes belongs to the `drain` command, not to this
 * class, so a hand-run `sync` or `once` runs beside a drain rather than
 * waiting for it.
 *
 * The behaviours here all come from failures observed in production:
 *
 *  - **Crash recovery.** A job stays in queue/ until it succeeds or is parked,
 *    so a worker that dies mid-job leaves it queued for the next one. While it
 *    runs, a marker in processing/ names the job and the process running it;
 *    a marker whose process is gone is cleared, and its job requeued if it is
 *    somehow no longer queued, so no repo is silently dropped.
 *  - **Retries happen in-process.** A failed attempt is retried after an
 *    exponential backoff until `maxAttempts` is spent, by whichever command ran
 *    it. The backoff starts only once the previous attempt's backend has exited,
 *    because a backend still shutting down can still hold its project lock.
 *    A failure the provider marks not retryable is parked at once.
 *  - **Busy is not failure.** Backends hold their own per-project lock. When
 *    another indexer has it, the job is requeued without burning an attempt —
 *    otherwise transient contention parks healthy repos in failed/.
 *  - **Coalescing.** Worktree churn enqueues the same repo repeatedly; jobs
 *    already covered by a completed scan are dropped rather than re-run.
 *  - **Stale worktrees.** Registrations whose directory is gone are pruned
 *    before indexing, because they are the precondition for the indexer being
 *    handed a working directory that no longer exists.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { shouldCoalesce } from "./coalesce.js";
import { fingerprint, serialiseFingerprint, unchanged } from "./fingerprint.js";
import type { Logger } from "./logger.js";
import type { Paths } from "./paths.js";
import { isAlive } from "./lock.js";
import type { IndexOutcome, IndexProvider, ProviderRegistry } from "./provider.js";
import { jobKey, nowIso, parseJob, Queue, serialiseJob, type Job } from "./queue.js";

export interface WorkerOptions {
  paths: Paths;
  registry: ProviderRegistry;
  logger: Logger;
  maxAttempts?: number;
  /** Called instead of sleeping, so tests need not wait out backoff. */
  sleep?: (ms: number) => Promise<void>;
  backoffSeconds?: number;
  /** Injected so worktree pruning can be stubbed in tests. */
  pruneWorktrees?: (repoPath: string) => void;
}

export type JobResult =
  | { outcome: "indexed"; summary: string }
  | { outcome: "coalesced"; reason: string }
  | { outcome: "unchanged" }
  | { outcome: "busy" }
  | { outcome: "retry"; attempt: number; error: string }
  | { outcome: "failed"; error: string }
  | { outcome: "skipped"; reason: string };

/** Every outcome but "retry", which `run` has already acted on. */
export type FinalJobResult = Exclude<JobResult, { outcome: "retry" }>;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A job as it was when it failed for the last time. */
export interface FailedJob extends Job {
  lastError?: string;
  failedAt?: string;
}

function markerFile(processingDir: string, repoPath: string): string {
  return path.join(processingDir, `${jobKey(repoPath)}.job`);
}

function markerPid(text: string): number | undefined {
  const pid = Number.parseInt(/^pid=(\d+)$/m.exec(text)?.[1] ?? "", 10);
  return Number.isInteger(pid) ? pid : undefined;
}

/** Record that `pid` is running `job`, for `list --all` and crash recovery. */
export function markRunning(processingDir: string, job: Job, pid = process.pid): void {
  mkdirSync(processingDir, { recursive: true });
  writeFileSync(markerFile(processingDir, job.repoPath), `${serialiseJob(job)}pid=${pid}\n`, "utf8");
}

/**
 * Jobs a live process is running right now. A marker left by a process that has
 * since died is not a running job, however recent it looks.
 */
export function runningJobs(processingDir: string): Job[] {
  let names: string[];
  try {
    names = readdirSync(processingDir);
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const name of names) {
    if (!name.endsWith(".job")) continue;
    try {
      const text = readFileSync(path.join(processingDir, name), "utf8");
      const pid = markerPid(text);
      const job = parseJob(text);
      if (job && pid !== undefined && isAlive(pid)) jobs.push(job);
    } catch {
      // Removed while being read: it finished.
    }
  }
  return jobs;
}

export class Worker {
  private readonly queue: Queue;
  private readonly maxAttempts: number;
  private readonly backoffSeconds: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: WorkerOptions) {
    this.queue = new Queue(opts.paths.queue);
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffSeconds = opts.backoffSeconds ?? 10;
    this.sleep = opts.sleep ?? defaultSleep;
    mkdirSync(opts.paths.processing, { recursive: true });
    mkdirSync(opts.paths.failed, { recursive: true });
    mkdirSync(opts.paths.lastIndexed, { recursive: true });
  }

  /** Start time of the last successful index for a repo, if any. */
  lastIndexStart(repoPath: string): string | undefined {
    const file = path.join(this.opts.paths.lastIndexed, jobKey(repoPath));
    try {
      return readFileSync(file, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Fingerprint recorded at the last successful index, if any. */
  lastFingerprint(repoPath: string): string | undefined {
    try {
      return readFileSync(
        path.join(this.opts.paths.lastIndexed, `${jobKey(repoPath)}.fp`),
        "utf8",
      ).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private recordFingerprint(repoPath: string): void {
    const fp = fingerprint(repoPath);
    if (!fp) return;
    writeFileSync(
      path.join(this.opts.paths.lastIndexed, `${jobKey(repoPath)}.fp`),
      `${serialiseFingerprint(fp)}\n`,
      "utf8",
    );
  }

  private recordIndexStart(repoPath: string, startedAt: string): void {
    // The START time, not completion: a change landing mid-scan must not be
    // considered covered by that scan.
    writeFileSync(path.join(this.opts.paths.lastIndexed, jobKey(repoPath)), `${startedAt}\n`, "utf8");
  }

  /**
   * Clear markers left by processes that died mid-job, requeueing any job that
   * is not already queued. Returns how many were requeued. Run before draining.
   */
  recoverOrphans(): number {
    const dir = this.opts.paths.processing;
    let recovered = 0;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith(".job")) continue;
      const file = path.join(dir, name);
      try {
        const text = readFileSync(file, "utf8");
        const pid = markerPid(text);
        // Still running somewhere else: not an orphan.
        if (pid !== undefined && pid !== process.pid && isAlive(pid)) continue;
        const job = parseJob(text);
        if (job && !this.queue.list().some((q) => q.repoPath === job.repoPath)) {
          this.queue.enqueue(job);
          this.opts.logger.tag("recover", `requeued interrupted job ${name}`);
          recovered++;
        }
        rmSync(file, { force: true });
      } catch {
        // Another worker recovered it first.
      }
    }
    return recovered;
  }

  private park(job: Job, attempts: number, error: string): void {
    const dest = path.join(this.opts.paths.failed, `${jobKey(job.repoPath)}.job`);
    try {
      // The queue's own format, so a full reindex is still full when retried.
      // One line per field, so a multi-line error cannot spill into the next.
      const parked = serialiseJob({ ...job, attempts });
      const oneLine = error.replace(/\s*\n\s*/g, " | ").trim();
      writeFileSync(dest, `${parked}last_error=${oneLine}\nfailed_at=${nowIso()}\n`, "utf8");
    } catch {
      // Best effort: the log still records the give-up.
    }
    this.queue.remove(job.repoPath);
  }

  async runJob(job: Job): Promise<JobResult> {
    const { logger, registry } = this.opts;

    if (!job.repoPath || !existsSync(job.repoPath)) {
      logger.tag("skip", `${job.repoPath || "(empty)"} no longer exists`);
      this.queue.remove(job.repoPath);
      return { outcome: "skipped", reason: "repo path does not exist" };
    }

    const decision = shouldCoalesce(job, this.lastIndexStart(job.repoPath));
    if (decision.skip) {
      logger.tag("coalesce", `${job.repoPath} — ${decision.reason}`);
      this.queue.remove(job.repoPath);
      return { outcome: "coalesced", reason: decision.reason };
    }

    // Nothing changed? A hook fired for activity that never touched this repo —
    // overwhelmingly worktree churn. Settle it before walking the tree.
    if (!job.full) {
      const fp = fingerprint(job.repoPath);
      if (unchanged(fp, this.lastFingerprint(job.repoPath))) {
        logger.tag("unchanged", `${job.repoPath} — HEAD unmoved and tree clean; nothing to index`);
        this.queue.remove(job.repoPath);
        return { outcome: "unchanged" };
      }
    }

    // Dangling worktree registrations are the precondition for the indexer
    // being handed a deleted working directory.
    try {
      this.opts.pruneWorktrees?.(job.repoPath);
    } catch {
      // Pruning is an optimisation; never fail a job over it.
    }

    let provider: IndexProvider | undefined;
    try {
      provider = await registry.resolve(job.repoPath);
    } catch (err) {
      provider = undefined;
      logger.tag("error", `provider resolution failed: ${String(err)}`);
    }
    if (!provider) {
      logger.tag("skip", `${job.repoPath} — no configured provider claims this repo`);
      this.queue.remove(job.repoPath);
      return { outcome: "skipped", reason: "no provider claims this repo" };
    }

    const startedAt = nowIso();
    logger.tag(
      "start",
      `${job.repoPath} via ${provider.name} (attempt ${job.attempts + 1}/${this.maxAttempts}${job.full ? ", full" : ""})`,
    );

    const marker = markerFile(this.opts.paths.processing, job.repoPath);
    let result: IndexOutcome;
    try {
      try {
        markRunning(this.opts.paths.processing, job);
      } catch {
        // Only `list --all` reads it; never fail a job over a marker.
      }
      result = await provider.index({
        repoPath: job.repoPath,
        full: job.full,
        reason: job.attempts > 0 ? "retry" : job.hook === "manual" ? "manual" : "hook",
      });
    } finally {
      rmSync(marker, { force: true });
    }

    if (result.status === "busy") {
      // Contention, not failure: leave the job queued and do not burn an attempt.
      logger.tag("busy", `${job.repoPath} — backend is indexing already; leaving queued`);
      return { outcome: "busy" };
    }

    if (result.status === "ok") {
      this.recordIndexStart(job.repoPath, startedAt);
      this.recordFingerprint(job.repoPath);
      logger.tag("ok", `${job.repoPath} — ${result.summary || "no summary"}`);
      this.queue.remove(job.repoPath);
      return { outcome: "indexed", summary: result.summary };
    }

    const error = result.error ?? "unknown error";
    const attempts = job.attempts + 1;
    if (attempts >= this.maxAttempts || result.retryable === false) {
      const why = result.retryable === false ? " (not retryable)" : "";
      logger.tag("give-up", `${job.repoPath} — parked after ${attempts} attempts${why}: ${error}`);
      this.park(job, attempts, error);
      return { outcome: "failed", error };
    }

    this.queue.enqueue({ ...job, attempts });
    const delay = this.backoffSeconds * 2 ** (attempts - 1);
    logger.tag("retry", `${job.repoPath} in ${delay}s (attempt ${attempts}): ${error}`);
    await this.sleep(delay * 1000);
    return { outcome: "retry", attempt: attempts, error };
  }

  /**
   * Run a job to a final outcome, making every attempt it is allowed.
   *
   * `runJob` makes one attempt, and on a retryable failure requeues the job and
   * sleeps out the backoff before returning "retry"; this loop is what makes
   * the retry. It carries the job in memory rather than re-reading the queue
   * file, because a hook may overwrite that file meanwhile with an incremental
   * job whose attempts start again from zero — unbounded, and no longer full.
   */
  async run(job: Job): Promise<FinalJobResult> {
    let current = job;
    for (;;) {
      const result = await this.runJob(current);
      if (result.outcome !== "retry") return result;
      current = { ...current, attempts: result.attempt };
    }
  }

  /**
   * Process until the queue is empty, a job is left busy, or `maxJobs` jobs have
   * run. Each job is run to its final outcome before the next is picked.
   */
  async drain(maxJobs = 1000): Promise<JobResult[]> {
    this.recoverOrphans();
    const results: JobResult[] = [];
    for (let i = 0; i < maxJobs; i++) {
      const [job] = this.queue.list();
      if (!job) break;
      const before = this.queue.size;
      results.push(await this.run(job));
      // A busy job stays queued by design; stop rather than spin on it.
      if (this.queue.size === before && results.at(-1)?.outcome === "busy") break;
    }
    return results;
  }

  /** Process exactly one job, if any, to its final outcome. */
  async once(): Promise<FinalJobResult | null> {
    this.recoverOrphans();
    const [job] = this.queue.list();
    if (!job) return null;
    return this.run(job);
  }

  listFailed(): FailedJob[] {
    const dir = this.opts.paths.failed;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const jobs: FailedJob[] = [];
    for (const name of names) {
      if (!name.endsWith(".job")) continue;
      try {
        const text = readFileSync(path.join(dir, name), "utf8");
        const job = parseJob(text);
        if (!job) continue;
        const get = (k: string): string | undefined =>
          text.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
        const lastError = get("last_error");
        const failedAt = get("failed_at");
        jobs.push({
          ...job,
          ...(lastError === undefined ? {} : { lastError }),
          ...(failedAt === undefined ? {} : { failedAt }),
        });
      } catch {
        // Skip unreadable entries.
      }
    }
    return jobs;
  }

  /** Move failed jobs back to the queue with their attempt count reset. */
  retryFailed(match?: string): number {
    let count = 0;
    for (const job of this.listFailed()) {
      if (match && !job.repoPath.includes(match)) continue;
      this.queue.enqueue({ repoPath: job.repoPath, hook: job.hook, full: job.full, attempts: 0 });
      rmSync(path.join(this.opts.paths.failed, `${jobKey(job.repoPath)}.job`), { force: true });
      count++;
    }
    return count;
  }

  /** Drop failed jobs without retrying. */
  forgetFailed(match?: string): number {
    let count = 0;
    for (const job of this.listFailed()) {
      if (match && match !== "--all" && !job.repoPath.includes(match)) continue;
      rmSync(path.join(this.opts.paths.failed, `${jobKey(job.repoPath)}.job`), { force: true });
      count++;
    }
    return count;
  }
}

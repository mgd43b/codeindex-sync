/**
 * The worker: drains the queue, one repository at a time.
 *
 * Serialisation is deliberate. Indexing backends are typically GPU- or
 * network-bound singletons, so running several at once makes everything slower
 * and can exhaust the backend. One job at a time, with a lock, is the design.
 *
 * The behaviours here all come from failures observed in production:
 *
 *  - **Crash recovery.** Anything left in processing/ belongs to a worker that
 *    died mid-job and is returned to the queue, so no repo is silently dropped.
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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { shouldCoalesce } from "./coalesce.js";
import type { Logger } from "./logger.js";
import type { Paths } from "./paths.js";
import type { IndexProvider, ProviderRegistry } from "./provider.js";
import { jobKey, nowIso, Queue, type Job } from "./queue.js";

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
  | { outcome: "busy" }
  | { outcome: "retry"; attempt: number; error: string }
  | { outcome: "failed"; error: string }
  | { outcome: "skipped"; reason: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  private recordIndexStart(repoPath: string, startedAt: string): void {
    // The START time, not completion: a change landing mid-scan must not be
    // considered covered by that scan.
    writeFileSync(path.join(this.opts.paths.lastIndexed, jobKey(repoPath)), `${startedAt}\n`, "utf8");
  }

  /** Return interrupted jobs to the queue. Run before draining. */
  recoverOrphans(): number {
    let recovered = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.opts.paths.processing);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith(".job")) continue;
      try {
        renameSync(
          path.join(this.opts.paths.processing, name),
          path.join(this.opts.paths.queue, name),
        );
        this.opts.logger.tag("recover", `requeued interrupted job ${name}`);
        recovered++;
      } catch {
        // Another worker recovered it first.
      }
    }
    return recovered;
  }

  private park(job: Job, error: string): void {
    const base = `${jobKey(job.repoPath)}.job`;
    const dest = path.join(this.opts.paths.failed, base);
    try {
      writeFileSync(
        dest,
        `repo_path=${job.repoPath}\nhook=${job.hook}\nenqueued_at=${job.enqueuedAt}\nattempts=${job.attempts}\nlast_error=${error}\nfailed_at=${nowIso()}\n`,
        "utf8",
      );
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

    const result = await provider.index({
      repoPath: job.repoPath,
      full: job.full,
      reason: job.attempts > 0 ? "retry" : job.hook === "manual" ? "manual" : "hook",
    });

    if (result.status === "busy") {
      // Contention, not failure: leave the job queued and do not burn an attempt.
      logger.tag("busy", `${job.repoPath} — backend is indexing already; leaving queued`);
      return { outcome: "busy" };
    }

    if (result.status === "ok") {
      this.recordIndexStart(job.repoPath, startedAt);
      logger.tag("ok", `${job.repoPath} — ${result.summary || "no summary"}`);
      this.queue.remove(job.repoPath);
      return { outcome: "indexed", summary: result.summary };
    }

    const error = result.error ?? "unknown error";
    const attempts = job.attempts + 1;
    if (attempts >= this.maxAttempts) {
      logger.tag("give-up", `${job.repoPath} — parked after ${attempts} attempts: ${error}`);
      this.park(job, error);
      return { outcome: "failed", error };
    }

    this.queue.enqueue({ ...job, attempts });
    const delay = this.backoffSeconds * 2 ** (attempts - 1);
    logger.tag("retry", `${job.repoPath} in ${delay}s (attempt ${attempts}): ${error}`);
    await this.sleep(delay * 1000);
    return { outcome: "retry", attempt: attempts, error };
  }

  /** Process until the queue is empty. Returns per-job results. */
  async drain(maxJobs = 1000): Promise<JobResult[]> {
    this.recoverOrphans();
    const results: JobResult[] = [];
    for (let i = 0; i < maxJobs; i++) {
      const [job] = this.queue.list();
      if (!job) break;
      const before = this.queue.size;
      results.push(await this.runJob(job));
      // A busy job stays queued by design; stop rather than spin on it.
      if (this.queue.size === before && results.at(-1)?.outcome === "busy") break;
    }
    return results;
  }

  /** Process exactly one job, if any. */
  async once(): Promise<JobResult | null> {
    this.recoverOrphans();
    const [job] = this.queue.list();
    if (!job) return null;
    return this.runJob(job);
  }

  listFailed(): Job[] {
    const dir = this.opts.paths.failed;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const jobs: Job[] = [];
    for (const name of names) {
      if (!name.endsWith(".job")) continue;
      try {
        const text = readFileSync(path.join(dir, name), "utf8");
        const get = (k: string): string | undefined =>
          text.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
        const repoPath = get("repo_path");
        if (!repoPath) continue;
        jobs.push({
          repoPath,
          hook: get("hook") ?? "manual",
          enqueuedAt: get("enqueued_at") ?? "",
          full: get("full") === "1",
          attempts: Number.parseInt(get("attempts") ?? "0", 10) || 0,
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

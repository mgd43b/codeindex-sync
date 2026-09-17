import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/logger.js";
import { resolvePaths } from "../src/paths.js";
import { ProviderRegistry, type IndexOutcome, type IndexProvider } from "../src/provider.js";
import { Queue, jobKey, nowIso } from "../src/queue.js";
import { markRunning, runningJobs, Worker } from "../src/worker.js";

let state: string;
let repo: string;

beforeEach(() => {
  state = mkdtempSync(path.join(tmpdir(), "codeindex-worker-"));
  repo = mkdtempSync(path.join(tmpdir(), "codeindex-repo-"));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** A provider whose result is scripted, so worker logic is tested in isolation. */
function fakeProvider(results: IndexOutcome[] | IndexOutcome, name = "fake"): IndexProvider {
  const queue = Array.isArray(results) ? [...results] : null;
  const single = Array.isArray(results) ? null : results;
  return {
    name,
    description: name,
    detect: async () => true,
    index: async () => queue?.shift() ?? single ?? { status: "ok", summary: "done" },
    health: async () => [],
    status: async () => null,
  };
}

function makeWorker(
  provider: IndexProvider,
  over: Partial<{ maxAttempts: number; sleep: (ms: number) => Promise<void> }> = {},
) {
  const paths = resolvePaths(state);
  const registry = new ProviderRegistry().register(provider);
  return new Worker({
    paths,
    registry,
    logger: silentLogger,
    maxAttempts: over.maxAttempts ?? 3,
    backoffSeconds: 0,
    sleep: over.sleep ?? (async () => {}), // never actually wait out backoff in tests
  });
}

function enqueue(over: Partial<{ full: boolean; attempts: number; enqueuedAt: string }> = {}) {
  const q = new Queue(resolvePaths(state).queue);
  return q.enqueue({
    repoPath: repo,
    hook: "post-commit",
    full: over.full ?? false,
    ...(over.attempts === undefined ? {} : { attempts: over.attempts }),
    ...(over.enqueuedAt === undefined ? {} : { enqueuedAt: over.enqueuedAt }),
  });
}

describe("Worker.runJob", () => {
  it("indexes and clears the job", async () => {
    const w = makeWorker(fakeProvider({ status: "ok", summary: "Added: 3" }));
    const res = await w.runJob(enqueue());
    expect(res.outcome).toBe("indexed");
    expect(new Queue(resolvePaths(state).queue).size).toBe(0);
  });

  it("records the index START time, not completion", async () => {
    // Load-bearing: using completion would discard changes landing mid-scan.
    //
    // Compare like with like. lastIndexStart is second-precision, and against a
    // millisecond ISO string the comparison inverts at index 19, where "Z"
    // sorts after ".". Production is unaffected because coalescing only ever
    // compares two nowIso() values, but it is an easy trap to re-introduce.
    const w = makeWorker(fakeProvider({ status: "ok", summary: "ok" }));
    const before = nowIso();
    await w.runJob(enqueue());
    const after = nowIso();
    const recorded = w.lastIndexStart(repo);
    expect(recorded).toBeDefined();
    expect(recorded).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(recorded! >= before).toBe(true);
    expect(recorded! <= after).toBe(true);
  });

  it("coalesces a job already covered by a completed scan", async () => {
    const w = makeWorker(fakeProvider({ status: "ok", summary: "ok" }));
    await w.runJob(enqueue()); // establishes lastIndexStart
    const res = await w.runJob(enqueue({ enqueuedAt: "2020-01-01T00:00:00Z" }));
    expect(res.outcome).toBe("coalesced");
  });

  it("never coalesces a full reindex", async () => {
    const w = makeWorker(fakeProvider({ status: "ok", summary: "ok" }));
    await w.runJob(enqueue());
    const res = await w.runJob(enqueue({ full: true, enqueuedAt: "2020-01-01T00:00:00Z" }));
    expect(res.outcome).toBe("indexed");
  });

  it("treats busy as contention: job stays queued, attempt not burnt", async () => {
    // Otherwise transient backend contention parks healthy repos in failed/.
    const w = makeWorker(fakeProvider({ status: "busy", summary: "locked" }));
    const res = await w.runJob(enqueue());
    expect(res.outcome).toBe("busy");
    const [job] = new Queue(resolvePaths(state).queue).list();
    expect(job).toBeDefined();
    expect(job?.attempts).toBe(0);
  });

  it("retries a failure with an incremented attempt count", async () => {
    const w = makeWorker(fakeProvider({ status: "failed", summary: "", error: "boom" }));
    const res = await w.runJob(enqueue());
    expect(res.outcome).toBe("retry");
    expect(new Queue(resolvePaths(state).queue).list()[0]?.attempts).toBe(1);
  });

  it("parks a job in failed/ after maxAttempts", async () => {
    const w = makeWorker(fakeProvider({ status: "failed", summary: "", error: "boom" }), {
      maxAttempts: 2,
    });
    await w.runJob(enqueue({ attempts: 1 }));
    expect(w.listFailed().map((j) => j.repoPath)).toEqual([repo]);
    expect(new Queue(resolvePaths(state).queue).size).toBe(0);
  });

  it("skips a repo that no longer exists rather than retrying forever", async () => {
    const w = makeWorker(fakeProvider({ status: "ok", summary: "ok" }));
    const job = enqueue();
    rmSync(repo, { recursive: true, force: true });
    expect((await w.runJob(job)).outcome).toBe("skipped");
  });

  it("skips when no provider claims the repo", async () => {
    const paths = resolvePaths(state);
    const registry = new ProviderRegistry().register({
      ...fakeProvider({ status: "ok", summary: "" }),
      detect: async () => false,
    });
    const w = new Worker({ paths, registry, logger: silentLogger, sleep: async () => {} });
    expect((await w.runJob(enqueue())).outcome).toBe("skipped");
  });

  it("prunes worktrees before indexing", async () => {
    const prune = vi.fn();
    const paths = resolvePaths(state);
    const registry = new ProviderRegistry().register(fakeProvider({ status: "ok", summary: "" }));
    const w = new Worker({
      paths,
      registry,
      logger: silentLogger,
      sleep: async () => {},
      pruneWorktrees: prune,
    });
    await w.runJob(enqueue());
    expect(prune).toHaveBeenCalledWith(repo);
  });

  it("does not fail a job because pruning threw", async () => {
    const paths = resolvePaths(state);
    const registry = new ProviderRegistry().register(fakeProvider({ status: "ok", summary: "" }));
    const w = new Worker({
      paths,
      registry,
      logger: silentLogger,
      sleep: async () => {},
      pruneWorktrees: () => {
        throw new Error("git exploded");
      },
    });
    expect((await w.runJob(enqueue())).outcome).toBe("indexed");
  });
});

describe("Worker.run", () => {
  it("makes the retry a failure announces, and stops at the first success", async () => {
    // `sync` used to make one attempt: it logged the retry, slept, and exited.
    const provider = fakeProvider([
      { status: "failed", summary: "", error: "transient" },
      { status: "ok", summary: "Added: 3" },
    ]);
    const index = vi.spyOn(provider, "index");
    const res = await makeWorker(provider).run(enqueue());

    expect(res.outcome).toBe("indexed");
    expect(index).toHaveBeenCalledTimes(2);
    expect(index.mock.calls[1]?.[0].reason).toBe("retry");
    expect(new Queue(resolvePaths(state).queue).size).toBe(0);
  });

  it("makes exactly maxAttempts attempts, then parks the job", async () => {
    const provider = fakeProvider({ status: "failed", summary: "", error: "still broken" });
    const index = vi.spyOn(provider, "index");
    const sleep = vi.fn(async () => {});
    const w = makeWorker(provider, { maxAttempts: 3, sleep });
    const res = await w.run(enqueue());

    expect(res).toEqual({ outcome: "failed", error: "still broken" });
    expect(index).toHaveBeenCalledTimes(3);
    // A backoff before each retry, none after the last attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(new Queue(resolvePaths(state).queue).size).toBe(0);
    const [parked] = w.listFailed();
    expect(parked?.attempts).toBe(3);
    expect(parked?.lastError).toBe("still broken");
  });

  it("parks a failure the provider marks not retryable without spending attempts", async () => {
    const provider = fakeProvider({
      status: "failed",
      summary: "",
      error: "timed out after 57600000ms",
      retryable: false,
    });
    const index = vi.spyOn(provider, "index");
    const sleep = vi.fn(async () => {});
    const w = makeWorker(provider, { sleep });
    const res = await w.run(enqueue());

    expect(res.outcome).toBe("failed");
    expect(index).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(w.listFailed()).toHaveLength(1);
  });

  it("keeps a job full and its attempts bounded when a hook re-enqueues during the backoff", async () => {
    // A hook firing during the backoff overwrites the queue file with an
    // incremental job at attempt 0. Re-reading that file would downgrade the
    // run and reset its attempts every time — unbounded retries.
    const seen: boolean[] = [];
    const provider = fakeProvider([]);
    provider.index = async (req) => {
      seen.push(req.full);
      // Succeeds only far past maxAttempts, so a broken run() fails here, not hangs.
      return seen.length > 10
        ? { status: "ok", summary: "done" }
        : { status: "failed", summary: "", error: "transient" };
    };
    const sleep = async (): Promise<void> => {
      new Queue(resolvePaths(state).queue).enqueue({ repoPath: repo, hook: "post-commit" });
    };
    const w = makeWorker(provider, { maxAttempts: 3, sleep });
    const res = await w.run(enqueue({ full: true }));

    expect(res.outcome).toBe("failed");
    expect(seen).toEqual([true, true, true]);
    const [parked] = w.listFailed();
    expect(parked?.attempts).toBe(3);
    expect(parked?.full).toBe(true);
  });
});

describe("Worker running markers", () => {
  it("marks a job running for exactly as long as its attempt", async () => {
    const paths = resolvePaths(state);
    let during: string[] = [];
    const provider = fakeProvider([]);
    provider.index = async () => {
      during = runningJobs(paths.processing).map((j) => j.repoPath);
      return { status: "ok", summary: "done" };
    };
    await makeWorker(provider).runJob(enqueue());
    expect(during).toEqual([repo]);
    expect(runningJobs(paths.processing)).toEqual([]);
  });

  it("does not report a marker left by a dead process as running", () => {
    const paths = resolvePaths(state);
    markRunning(paths.processing, enqueue(), 2 ** 22 + 12345);
    expect(runningJobs(paths.processing)).toEqual([]);
  });

  it("leaves a marker alone while its process is alive", () => {
    const paths = resolvePaths(state);
    const w = makeWorker(fakeProvider({ status: "ok", summary: "" }));
    // The test runner itself stands in for another live worker.
    markRunning(paths.processing, enqueue(), process.ppid);
    expect(w.recoverOrphans()).toBe(0);
    expect(runningJobs(paths.processing).map((j) => j.repoPath)).toEqual([repo]);
  });

  it("clears a dead process's marker without requeueing a job that is still queued", () => {
    const paths = resolvePaths(state);
    const w = makeWorker(fakeProvider({ status: "ok", summary: "" }));
    const job = enqueue({ attempts: 1 });
    markRunning(paths.processing, job, 2 ** 22 + 12345);
    expect(w.recoverOrphans()).toBe(0);
    expect(readdirSync(paths.processing).filter((f) => f.endsWith(".job"))).toHaveLength(0);
    expect(new Queue(paths.queue).list()[0]?.attempts).toBe(1);
  });
});

describe("Worker crash recovery", () => {
  it("returns an interrupted job to the queue", async () => {
    // Without this, a worker that dies mid-job silently drops that repo.
    const paths = resolvePaths(state);
    const w = makeWorker(fakeProvider({ status: "ok", summary: "" }));
    mkdirSync(paths.processing, { recursive: true });
    writeFileSync(
      path.join(paths.processing, `${jobKey(repo)}.job`),
      `repo_path=${repo}\nhook=post-commit\nenqueued_at=2026-01-01T00:00:00Z\nattempts=0\n`,
    );
    expect(w.recoverOrphans()).toBe(1);
    expect(new Queue(paths.queue).size).toBe(1);
    expect(readdirSync(paths.processing).filter((f) => f.endsWith(".job"))).toHaveLength(0);
  });

  it("recovers nothing when processing/ is empty", () => {
    expect(makeWorker(fakeProvider({ status: "ok", summary: "" })).recoverOrphans()).toBe(0);
  });
});

describe("Worker failed-job management", () => {
  it("retries failed jobs with attempts reset", async () => {
    const w = makeWorker(fakeProvider({ status: "failed", summary: "", error: "x" }), {
      maxAttempts: 1,
    });
    await w.runJob(enqueue());
    expect(w.listFailed()).toHaveLength(1);
    expect(w.retryFailed()).toBe(1);
    expect(w.listFailed()).toHaveLength(0);
    expect(new Queue(resolvePaths(state).queue).list()[0]?.attempts).toBe(0);
  });

  it("parks a multi-line error on one line, without corrupting the fields after it", async () => {
    // The failed/ file is one key=value per line; a raw stack trace would spill
    // into keys of its own and push failed_at out of reach.
    const w = makeWorker(
      fakeProvider({ status: "failed", summary: "", error: "backend exited (code 1):\nfailed_at=bogus\n  at x" }),
      { maxAttempts: 1 },
    );
    await w.runJob(enqueue());
    const [parked] = w.listFailed();
    expect(parked?.lastError).toBe("backend exited (code 1): | failed_at=bogus | at x");
    expect(parked?.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("requeues a parked full reindex as full", async () => {
    // park() used to drop full=1, so `retry` quietly downgraded it.
    const w = makeWorker(fakeProvider({ status: "failed", summary: "", error: "x" }), {
      maxAttempts: 1,
    });
    await w.runJob(enqueue({ full: true }));
    expect(readFileSync(path.join(resolvePaths(state).failed, `${jobKey(repo)}.job`), "utf8")).toMatch(
      /^full=1$/m,
    );
    expect(w.retryFailed()).toBe(1);
    expect(new Queue(resolvePaths(state).queue).list()[0]?.full).toBe(true);
  });

  it("forgets failed jobs without requeueing them", async () => {
    const w = makeWorker(fakeProvider({ status: "failed", summary: "", error: "x" }), {
      maxAttempts: 1,
    });
    await w.runJob(enqueue());
    expect(w.forgetFailed("--all")).toBe(1);
    expect(w.listFailed()).toHaveLength(0);
    expect(new Queue(resolvePaths(state).queue).size).toBe(0);
  });
});

describe("Worker.drain", () => {
  it("processes every queued job", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "codeindex-repo2-"));
    const paths = resolvePaths(state);
    const q = new Queue(paths.queue);
    q.enqueue({ repoPath: repo, hook: "post-commit", full: false });
    q.enqueue({ repoPath: other, hook: "post-commit", full: false });
    const w = makeWorker(fakeProvider({ status: "ok", summary: "ok" }));
    const results = await w.drain();
    expect(results.filter((r) => r.outcome === "indexed")).toHaveLength(2);
    expect(q.size).toBe(0);
    rmSync(other, { recursive: true, force: true });
  });

  it("runs a failing job to its final outcome before moving on", async () => {
    const provider = fakeProvider([
      { status: "failed", summary: "", error: "transient" },
      { status: "ok", summary: "done" },
    ]);
    enqueue();
    const results = await makeWorker(provider).drain();
    expect(results.map((r) => r.outcome)).toEqual(["indexed"]);
  });

  it("stops rather than spinning on a busy job", async () => {
    // A busy job stays queued by design; looping on it would burn CPU forever.
    const w = makeWorker(fakeProvider({ status: "busy", summary: "locked" }));
    enqueue();
    const results = await w.drain();
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("busy");
  });

  it("returns nothing on an empty queue", async () => {
    expect(await makeWorker(fakeProvider({ status: "ok", summary: "" })).drain()).toEqual([]);
  });
});

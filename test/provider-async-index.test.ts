/**
 * Asynchronous index tools — the "silent success, empty index" regression.
 *
 * A backend's full-index tool may be fire-and-forget: it returns in about a
 * second with "indexing started" and does the work afterwards on its own event
 * loop. Believing that reply closes the session and reaps the child moments
 * into a job needing minutes, leaving a created-but-empty index that reports
 * as a success. `--full` is the only path that reaches such a tool, which is
 * why the hook-driven path never showed the bug.
 *
 * The stub below reproduces that shape rather than describing it, including
 * the two details that make the naive fixes wrong:
 *
 *  - Progress lives in per-process state, exactly as a real backend's does. A
 *    second child would report a backend that has never indexed anything, so
 *    these tests only pass if the polling shares ONE session with the call.
 *  - Progress is not visible the instant the tool returns; the backend takes a
 *    lock first. A single "are you done yet?" lands in that window and sees an
 *    idle backend, so polling once and believing the answer is not a fix.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpIndexProvider, type McpProviderConfig } from "../src/providers/mcp-provider.js";

let dir: string;
let sessionLog: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-async-"));
  sessionLog = path.join(dir, "sessions.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** How long the backend hides the job before progress becomes observable. */
const STARTUP_MS = 100;
/** How long the simulated indexing then runs for. */
const INDEX_MS = 250;
/** Poll gap. The settle window is a multiple of this and must exceed STARTUP_MS. */
const POLL_MS = 40;

const STARTED = [
  "Indexing started in the background for: /repo",
  "",
  "IMPORTANT: Indexing is now running asynchronously.",
  "Call status to check progress. Keep calling it until progress reaches 100%.",
].join("\n");

const IN_PROGRESS = [
  "Project: /repo",
  "",
  "⚠ Full index in progress",
  "  Phase: embedding",
  "  Progress: 6/12 files",
].join("\n");

const COMPLETED = [
  "Project: /repo",
  "Collection: codebase_stub",
  "Status: green",
  "Indexed chunks: 40",
  "",
  "Last operation: Full index — completed",
  "  Files: 12, Chunks: 40",
].join("\n");

/** A healthy index left behind by an EARLIER run, before this one starts. */
const PREVIOUS = [
  "Project: /repo",
  "Collection: codebase_stub",
  "Status: green",
  "Indexed chunks: 5",
  "",
  "Last operation: Full index — completed",
  "  Files: 3, Chunks: 5",
].join("\n");

/** What a backend says when it has never heard of the project. */
const NO_INDEX = "No index found for project: /repo\nRun index to create one.";

interface StubOptions {
  /** Reply from the `i` (index) tool. */
  indexReply?: string;
  /** Reply from the `u` (update) tool. */
  updateReply?: string;
  /** Text once the simulated run finishes. Omit to never finish. */
  finalStatus?: string | null;
  /** Whether the index/update tool kicks off background work at all. */
  background?: boolean;
  /** Status before the run becomes visible. Defaults to "never heard of it". */
  idleStatus?: string;
}

/**
 * A stub MCP server with a fire-and-forget index tool.
 *
 * `phase` is ordinary module state, so it dies with the process — which is the
 * point: a fresh child sees `idle` forever.
 */
function stubServer(opts: StubOptions = {}): string {
  const file = path.join(dir, "server.mjs");
  const cfg = JSON.stringify({
    indexReply: opts.indexReply ?? STARTED,
    updateReply: opts.updateReply ?? "Added: 3\nNew chunks: 135",
    finalStatus: opts.finalStatus === undefined ? COMPLETED : opts.finalStatus,
    background: opts.background ?? true,
    idleStatus: opts.idleStatus ?? NO_INDEX,
    startupMs: STARTUP_MS,
    indexMs: INDEX_MS,
    inProgress: IN_PROGRESS,
  });
  writeFileSync(
    file,
    `
import { appendFileSync } from "node:fs";
const cfg = ${cfg};
const sessionLog = process.argv[2];

// Per-process, like a real backend's progress map: a second child sees "idle".
let phase = "idle";

function begin() {
  if (!cfg.background) return;
  phase = "starting";
  // The backend takes a lock before it publishes any progress. A poll landing
  // in this window sees an idle backend that has never indexed anything.
  setTimeout(() => { phase = "running"; }, cfg.startupMs);
  if (cfg.finalStatus !== null) {
    setTimeout(() => { phase = "done"; }, cfg.startupMs + cfg.indexMs);
  }
}

function statusText() {
  if (phase === "running") return cfg.inProgress;
  if (phase === "done") return cfg.finalStatus;
  return cfg.idleStatus;
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const text = (id, t) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }] } });

function handle(msg) {
  if (msg.method === "initialize") {
    // One line per session, so tests can prove the polling did not respawn.
    if (sessionLog) appendFileSync(sessionLog, "session\\n");
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method !== "tools/call") return;
  const name = msg.params?.name;
  if (name === "i") { begin(); return text(msg.id, cfg.indexReply); }
  if (name === "u") { begin(); return text(msg.id, cfg.updateReply); }
  if (name === "s") return text(msg.id, statusText());
  return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such tool: " + name } });
}
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

function providerFor(server: string, cfg: Partial<McpProviderConfig> = {}): McpIndexProvider {
  return new McpIndexProvider({
    name: "stub",
    description: "stub",
    command: process.execPath,
    args: [server, sessionLog],
    tools: { update: "u", index: "i", status: "s" },
    pollIntervalMs: POLL_MS,
    timeoutMs: 20_000,
    ...cfg,
  });
}

const sessionCount = (): number =>
  readFileSync(sessionLog, "utf8").split("\n").filter(Boolean).length;

describe("a fire-and-forget index tool", () => {
  it("waits for the work instead of reporting the 'started' reply as success", async () => {
    // The regression. Before the fix this returned in ~1s with the summary
    // "Once complete, you can use codebase_search…" and an empty index.
    const p = providerFor(stubServer());
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    const elapsed = Date.now() - t0;

    expect(got.status).toBe("ok");
    expect(got.summary).not.toMatch(/background/i);
    expect(got.filesIndexed).toBe(12);
    expect(got.chunks).toBe(40);
    // It cannot have known the count without waiting for the run to finish.
    expect(elapsed).toBeGreaterThanOrEqual(STARTUP_MS + INDEX_MS);
  });

  it("does the waiting on one session, not a fresh child per poll", async () => {
    // The constraint that rules out "just call status again": progress is
    // per-process state, so a second child sees a backend that never indexed.
    const p = providerFor(stubServer());
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("ok");
    expect(sessionCount()).toBe(1);
  });

  it("does not mistake the pre-progress window for a finished index", async () => {
    // The backend is idle and reports no index at all for the first few polls.
    // Believing the first answer lands straight back in the original bug.
    const p = providerFor(stubServer({ finalStatus: COMPLETED }));
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("ok");
    expect(got.chunks).toBe(40);
  });

  it("reports what status says, not what the index call claimed", async () => {
    const p = providerFor(stubServer());
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.summary).toContain("Indexed chunks: 40");
  });

  it("fails rather than succeeding when the backend never finishes", async () => {
    // A wait is the one thing that could wedge the queue; it must be bounded,
    // and running out of time is a failure, not a quiet success.
    const p = providerFor(stubServer({ finalStatus: null }), { timeoutMs: 600 });
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("gives up promptly when the caller aborts", async () => {
    const p = providerFor(stubServer({ finalStatus: null }));
    const t0 = Date.now();
    const got = await p.index({
      repoPath: dir,
      full: true,
      reason: "manual",
      signal: AbortSignal.timeout(200),
    });
    expect(got.status).toBe("failed");
    expect(got.error).toMatch(/abort/i);
    // The configured timeout is 20s; the abort must not have waited it out.
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("fails when the backend still calls its own index incomplete", async () => {
    const p = providerFor(
      stubServer({
        finalStatus: [
          "Project: /repo",
          "Indexed chunks: 12",
          "",
          "⚠ INDEX IS INCOMPLETE — a previous run was interrupted.",
          "  Files indexed: 4 of 12 discovered",
        ].join("\n"),
      }),
    );
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("failed");
    expect(got.error).toMatch(/incomplete/i);
  });

  it("keeps waiting when a previous run already left a healthy index", async () => {
    // The trap in "done means no progress marker": a re-index of a populated
    // repo reports a perfectly good index during the window before the new run
    // becomes visible. Believing it returns the OLD count and reaps the child
    // mid-run — the original bug, wearing a healthy-looking status.
    const p = providerFor(stubServer({ idleStatus: PREVIOUS, finalStatus: COMPLETED }));
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });

    expect(got.status).toBe("ok");
    expect(got.chunks).toBe(40); // the new run, not the previous 5
    expect(Date.now() - t0).toBeGreaterThanOrEqual(STARTUP_MS + INDEX_MS);
  });

  it("fails when the backend reports no index after being told to build one", async () => {
    // Ran, finished, produced nothing. That is the symptom this whole change
    // exists to stop reporting as a success.
    const p = providerFor(stubServer({ finalStatus: NO_INDEX }));
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("failed");
    expect(got.error).toMatch(/no index/i);
  });

  it("returns as soon as the run is done, without sitting out the settle window", async () => {
    // A short run must not be billed for the grace period that exists only to
    // catch a backend which has not started reporting yet.
    const p = providerFor(stubServer(), { pollIntervalMs: 2_000 });
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    const elapsed = Date.now() - t0;

    expect(got.status).toBe("ok");
    expect(got.chunks).toBe(40);
    // The settle window here is 2s * 8 = 16s; the run itself takes 350ms.
    expect(elapsed).toBeLessThan(8_000);
  });

  it("adds no fixed delay when the index tool answered synchronously", async () => {
    // A tool that did the work before replying has nothing to wait for. One
    // immediate status call to pick up the counters, then done — sleeping a
    // poll interval first would tax every --full for nothing.
    const p = providerFor(
      stubServer({
        indexReply: "Rebuilt index for /repo\nFiles: 12, Chunks: 40",
        background: false,
        idleStatus: COMPLETED,
      }),
      { pollIntervalMs: 5_000 },
    );
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });

    expect(got.status).toBe("ok");
    expect(got.chunks).toBe(40);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("treats a busy reply as busy without waiting on it", async () => {
    // Contention is the backend's own lock, not work we started; polling for it
    // would burn the whole timeout on a job that should just be requeued.
    const p = providerFor(
      stubServer({ indexReply: "another indexer holds the lock", background: false }),
    );
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("busy");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("cannot verify without a status tool, and says what the backend said", async () => {
    // Degrade rather than hang: a config gap, not a reason to invent an answer.
    const p = providerFor(stubServer(), { tools: { update: "u", index: "i" } });
    const got = await p.index({ repoPath: dir, full: true, reason: "manual" });
    expect(got.status).toBe("ok");
    expect(got.summary).toMatch(/background/i);
  });
});

describe("the incremental path", () => {
  it("is not slowed down by verification when the reply is already the truth", async () => {
    // Hooks fire constantly. A synchronous update reports its own counts, so
    // there is nothing to wait for — and this stub's status would say "in
    // progress" forever, so polling it at all would hang until the timeout.
    const p = providerFor(
      stubServer({ updateReply: "Added: 3\nNew chunks: 135", finalStatus: null }),
      { timeoutMs: 4_000 },
    );
    const t0 = Date.now();
    const got = await p.index({ repoPath: dir, full: false, reason: "hook" });
    expect(got.status).toBe("ok");
    expect(got.chunks).toBe(135);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("is still verified when the update tool turns out to be asynchronous too", async () => {
    // Nothing says only the index tool may be fire-and-forget; a reply that
    // announces background work is waited on whichever tool produced it.
    const p = providerFor(
      stubServer({ updateReply: "Update started in the background for: /repo" }),
    );
    const got = await p.index({ repoPath: dir, full: false, reason: "hook" });
    expect(got.status).toBe("ok");
    expect(got.chunks).toBe(40);
    expect(sessionCount()).toBe(1);
  });
});

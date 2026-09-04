/**
 * Generic MCP-backed index provider.
 *
 * This is the reason adding a backend is config rather than code: any MCP
 * server exposing index/update/status tools can be driven by describing it —
 * how to spawn it, what its tools are called, and how to read its replies.
 *
 * Nothing here names a specific product. A concrete backend is a config entry;
 * see `presets.ts` for ready-made ones.
 *
 * ## Asynchronous index tools
 *
 * A backend's "full index" tool may be fire-and-forget: it starts the work on
 * its own event loop and returns in about a second with "indexing started".
 * Taking that reply at face value is a silent data-loss bug — the session is
 * closed, the child is reaped milliseconds into a job that needed minutes, and
 * an empty-but-created index is reported as a success.
 *
 * So a tool reply is not evidence that the work happened. After invoking the
 * index tool this class polls the configured `status` tool until the backend
 * stops reporting progress, and reports what *status* says rather than what the
 * index call claimed. The polling happens on ONE session, because progress is
 * typically per-process state: a second child would see a backend that has
 * never indexed anything, and the first child is dead by then anyway.
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_TIMEOUT_MS,
  withMcp,
  type McpClientOptions,
  type McpSession,
  type McpToolResult,
} from "../mcp.js";
import type {
  IndexOutcome,
  IndexProvider,
  IndexRequest,
  IndexedProject,
  ProviderHealth,
  RemoveOutcome,
  RepoStatus,
} from "../provider.js";

export interface McpProviderConfig {
  name: string;
  description?: string;
  /** Executable to spawn, e.g. "npx". */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Tool names on the server. Only `update` is strictly required. */
  tools: {
    update: string;
    index?: string;
    status?: string;
    health?: string;
    /** Enumerate every index the backend holds; enables `list --all`/`cleanup`. */
    list?: string;
    /** Drop one index; enables `cleanup --apply`. */
    remove?: string;
  };
  /** Argument name carrying the repo path (servers differ). */
  repoArg?: string;
  /**
   * Files whose presence means "this repo belongs to me" — e.g. a marker file
   * the backend writes. Empty means "claim any git repo", which is fine when
   * only one provider is configured.
   */
  detectFiles?: string[];
  /**
   * What `claim` writes into `detectFiles[0]` to opt a repository in.
   *
   * The file NAME is already `detectFiles[0]`; this is what goes inside it, and
   * that part is irreducibly backend-specific — SocratiCode pins a collection
   * id, another backend might want something else or nothing at all. Keeping it
   * as data is what stops `claim` from having to know any product's schema.
   * `${name}` expands to the repository's directory name.
   *
   * Omit it and `claim` says it cannot write the marker for you, rather than
   * inventing a format the backend will not understand.
   */
  markerContent?: string;
  timeoutMs?: number;
  /**
   * Substrings marking a "busy" reply rather than a failure: the backend holds
   * its own per-project lock and another indexer has it. Busy is not an error —
   * the job should be requeued, not counted as a failed attempt.
   */
  busyMarkers?: string[];
  /**
   * Substrings marking a reply that means "accepted, still running" rather than
   * "done". See the note on asynchronous index tools at the top of this file.
   */
  asyncIndexMarkers?: string[];
  /** Substrings in a `status` reply meaning work is still under way. */
  progressMarkers?: string[];
  /** Gap between `status` polls while waiting for an async tool to finish. */
  pollIntervalMs?: number;
}

/**
 * A directory that definitely exists, preferring `wanted`.
 *
 * Spawning with a cwd that has been deleted fails during interpreter startup
 * with an opaque `uv_cwd ENOENT`, long before the backend gets a chance to
 * report anything useful. Deleted directories are routine here: throwaway
 * worktrees, and `cleanup`, whose entire input is paths that no longer exist.
 */
/**
 * Parse a backend's project listing.
 *
 * Deliberately shape-driven rather than backend-specific: a line that is just a
 * path starts a record, and the indented `Key: value` lines beneath it become
 * its details. Backends that print more keys, or none, still work — unknown
 * keys are ignored rather than causing a parse failure, so a backend adding a
 * field never breaks this.
 *
 * Counts are kept verbatim. A partial index reports "3437/2798", and turning
 * that into a number would silently claim more files than were indexed.
 */
export function parseProjectListing(text: string): IndexedProject[] {
  const out: IndexedProject[] = [];
  let current: IndexedProject | undefined;

  for (const raw of text.split("\n")) {
    const pathLine = /^\s*(?:[-*\u2022]\s*)?(\/.*\S)\s*$/.exec(raw);
    if (pathLine?.[1]) {
      current = { path: pathLine[1] };
      out.push(current);
      continue;
    }
    // A record header that is NOT a path. A backend may print a placeholder for
    // an index whose path it no longer knows ("(path unknown — indexed before
    // path tracking)"), and its details belong to that record, not the one
    // above — absorbing them silently rewrote a real project's collection in
    // `list --all`. Nothing here can be attributed to a path, so drop it.
    if (/^\s*[-*\u2022]\s+\S/.test(raw)) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const kv = /^\s+([A-Za-z][A-Za-z ]*?)\s*:\s*(.+?)\s*$/.exec(raw);
    if (!kv) continue;
    const key = kv[1]!.trim().toLowerCase();
    const value = kv[2]!.trim();

    if (key === "collection") current.collection = value;
    else if (key === "files") {
      // e.g. "39", or "3437/2798 (INCOMPLETE — run codebase_index to resume)"
      const count = /^([\d,]+(?:\/[\d,]+)?)/.exec(value);
      if (count?.[1]) current.files = count[1];
      if (/incomplete/i.test(value)) current.incomplete = true;
    } else if (key === "last indexed" || key === "indexed at" || key === "updated") {
      current.lastIndexedAt = value;
    }
  }

  // Deduplicate on path, keeping the first record for each.
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
}

function safeCwd(wanted?: string): string {
  const candidates = [wanted, process.cwd(), homedir(), tmpdir()].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // Unreadable: try the next one.
    }
  }
  return tmpdir();
}

/**
 * Are these the same index, as far as the backend's listing goes?
 *
 * Compared after normalisation because the path we were handed and the one the
 * backend prints have travelled different routes — a trailing slash or an
 * unresolved `..` would otherwise read as a different project and turn a real
 * removal into a reported failure. Deliberately not resolved through the
 * filesystem: these paths are deleted by definition, so there is nothing for
 * `realpath` to work with.
 */
function samePath(a: string, b: string): boolean {
  return path.normalize(a).replace(/\/+$/, "") === path.normalize(b).replace(/\/+$/, "");
}

const DEFAULT_BUSY_MARKERS = ["another indexer", "already in progress", "locked by", "BUSY"];

/**
 * A reply that means "started, not finished". Matched against the index tool's
 * own answer; deliberately phrase-level rather than backend-specific, because
 * every async tool has to say some version of this to be usable at all.
 */
const DEFAULT_ASYNC_INDEX_MARKERS = [
  "in the background",
  "running asynchronously",
  "check progress",
];

/**
 * A `status` reply that means work is still under way. "actively indexing" is
 * here because a backend may report that *another* process holds the job —
 * waiting for that to finish is right, and returning "done" while it runs is
 * exactly the empty-index failure this polling exists to prevent.
 */
const DEFAULT_PROGRESS_MARKERS = ["in progress", "in-progress", "actively indexing"];

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Grace period for progress that has not appeared yet, as a multiple of the
 * poll interval.
 *
 * There is a gap between an async tool returning and its progress state
 * becoming visible — it typically takes a lock first. Polling once and
 * believing the answer would race straight back into the bug, so the backend
 * is given this long to show something before "nothing is running" is taken at
 * face value.
 */
const SETTLE_INTERVALS = 8;

/**
 * Floor for the first few polls.
 *
 * Waiting a full interval before looking would both add fixed latency to a
 * synchronous tool and let a *fast* async run start and finish unseen — and an
 * unseen run cannot be told apart from one that never started. Polls therefore
 * begin immediately and back off to the configured cadence, which is cheap
 * where it matters and unobtrusive once the job is clearly long-running.
 */
const MIN_POLL_MS = 100;

function matchesAny(text: string, markers: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return markers.some((m) => hay.includes(m.toLowerCase()));
}

/**
 * Does this reply describe an index that exists?
 *
 * The same notion `status()` reports as `indexed`, kept in one place so the
 * two cannot drift: what `list` calls indexed is what counts as done here.
 */
function looksIndexed(text: string): boolean {
  return /indexed|chunks/i.test(text);
}

/** Sleep that gives up early when the caller aborts. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : {});
  } catch {
    // Aborted: the caller re-checks the signal and stops.
  }
}

/** Pull "Added: 3" style counters out of a human-readable summary. */
function extractNumber(text: string, ...labels: string[]): number | undefined {
  for (const label of labels) {
    const m = new RegExp(`${label}\\s*[:=]\\s*(\\d+)`, "i").exec(text);
    if (m?.[1]) return Number.parseInt(m[1], 10);
  }
  return undefined;
}

/** Collapse multi-line tool output to one informative line. */
function firstMeaningfulLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /[:=]\s*\d|complete|updated|indexed/i.test(l)) ?? lines[0] ?? "";
}

export class McpIndexProvider implements IndexProvider {
  readonly name: string;
  readonly description: string;

  constructor(private readonly cfg: McpProviderConfig) {
    this.name = cfg.name;
    this.description = cfg.description ?? `MCP backend via \`${cfg.command} ${cfg.args.join(" ")}\``;
  }

  async detect(repoPath: string): Promise<boolean> {
    const markers = this.cfg.detectFiles ?? [];
    if (markers.length === 0) return true;
    return markers.some((f) => existsSync(path.join(repoPath, f)));
  }

  private repoArgs(repoPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { [this.cfg.repoArg ?? "projectPath"]: repoPath, ...extra };
  }

  private isBusy(text: string): boolean {
    return matchesAny(text, this.cfg.busyMarkers ?? DEFAULT_BUSY_MARKERS);
  }

  /**
   * Options for one session.
   *
   * cwd prefers the repo: inheriting a hook's cwd is how the runtime ends up
   * starting in a deleted worktree and dying before the backend loads. But the
   * repo is not always there — `cleanup` acts on paths that are gone by
   * definition — so fall back to somewhere that exists rather than spawning
   * into ENOENT.
   */
  private sessionOpts(repoPath: string | undefined, timeoutMs: number | undefined): McpClientOptions {
    return {
      command: this.cfg.command,
      args: this.cfg.args,
      cwd: safeCwd(repoPath),
      env: { ...process.env, ...this.cfg.env },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }

  private async call(
    repoPath: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    return withMcp(this.sessionOpts(repoPath, this.cfg.timeoutMs), (s) => s.callTool(tool, args));
  }

  async index(req: IndexRequest): Promise<IndexOutcome> {
    const indexTool = req.full ? this.cfg.tools.index : undefined;
    const tool = indexTool ?? this.cfg.tools.update;
    let res: McpToolResult;
    try {
      // One session for the tool call AND the polling that confirms it
      // finished. Not two: a backend's progress state is per-process, so a
      // second child sees a backend that has never indexed anything.
      res = await withMcp(
        this.sessionOpts(req.repoPath, this.cfg.timeoutMs),
        async (session) => {
          const started = await session.callTool(tool, this.repoArgs(req.repoPath));
          if (started.isError || this.isBusy(started.text)) return started;
          return this.awaitCompletion(session, req, started, indexTool !== undefined);
        },
      );
    } catch (err) {
      return {
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (this.isBusy(res.text)) {
      return { status: "busy", summary: firstMeaningfulLine(res.text) };
    }
    if (res.isError) {
      return { status: "failed", summary: "", error: firstMeaningfulLine(res.text) || res.text };
    }

    const outcome: IndexOutcome = { status: "ok", summary: firstMeaningfulLine(res.text) };
    const files = extractNumber(res.text, "Files", "filesIndexed");
    const chunks = extractNumber(res.text, "New chunks", "Chunks", "Indexed chunks");
    if (files !== undefined) outcome.filesIndexed = files;
    if (chunks !== undefined) outcome.chunks = chunks;
    return outcome;
  }

  /**
   * Wait until the backend stops reporting work, then answer with what `status`
   * says rather than what the tool call claimed.
   *
   * Polling is skipped for a synchronous `update`, which is the hot path: hooks
   * fire constantly and that reply is already the truth. It is NOT skipped for
   * a synchronous index tool — one immediate call costs nothing on a full
   * reindex and upgrades the summary from "started" to real counters.
   *
   * "Done" is deliberately not "no progress marker": a re-index of an already
   * populated repo reports a perfectly healthy index during the window before
   * the new run becomes visible, and believing that is the original bug. So a
   * reply that announced background work must be watched running before it can
   * be called finished; only a reply that promised nothing may be confirmed
   * straight from an index that already exists.
   *
   * The wait is bounded by the caller's abort signal and by the session's own
   * hard timer, which kills the child and makes every later call fail at once.
   * Both end as a failure — a backend that never finishes must never look like
   * one that did.
   */
  private async awaitCompletion(
    session: McpSession,
    req: IndexRequest,
    started: McpToolResult,
    usedIndexTool: boolean,
  ): Promise<McpToolResult> {
    const asyncReply = matchesAny(
      started.text,
      this.cfg.asyncIndexMarkers ?? DEFAULT_ASYNC_INDEX_MARKERS,
    );
    if (!usedIndexTool && !asyncReply) return started;

    const statusTool = this.cfg.tools.status;
    // Nothing to poll. The reply stands as the only account available, which is
    // why a backend with an async index tool wants a `status` tool configured.
    if (!statusTool) return started;

    const progressMarkers = this.cfg.progressMarkers ?? DEFAULT_PROGRESS_MARKERS;
    const interval = this.cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // Never sleep past the session's own ceiling: a long poll interval must not
    // outlive the child it is waiting on.
    const deadline = Date.now() + (this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const settleUntil = Date.now() + interval * SETTLE_INTERVALS;

    /** Accept a settled reply, unless the backend disowns its own index. */
    const finish = (res: McpToolResult): McpToolResult =>
      /incomplete/i.test(res.text)
        ? // Still incomplete after the work stopped: not a success with a small
          // number in it. Failing loudly beats an empty index that reads healthy.
          { isError: true, text: `index still incomplete after ${statusTool}\n${res.text}` }
        : res;

    let sawProgress = false;
    let backoff = Math.min(MIN_POLL_MS, interval);

    for (;;) {
      const now = await session.callTool(statusTool, this.repoArgs(req.repoPath));
      // The session died or timed out. Reporting that is the whole point.
      if (now.isError) return now;

      const running = matchesAny(now.text, progressMarkers);
      if (running) sawProgress = true;

      if (!running && (sawProgress || !asyncReply) && looksIndexed(now.text)) {
        return finish(now);
      }

      // Never saw the work start. Believe an index that exists — a very fast
      // run can finish between polls — but a backend that reports none after
      // being told to build one has failed, however cheerful its reply was.
      if (!running && Date.now() >= settleUntil) {
        return looksIndexed(now.text)
          ? finish(now)
          : {
              isError: true,
              text: `${statusTool} still reports no index after running ${
                usedIndexTool ? (this.cfg.tools.index ?? "index") : this.cfg.tools.update
              }`,
            };
      }

      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())), req.signal);
      if (req.signal?.aborted) {
        return { isError: true, text: "aborted while waiting for the backend to finish" };
      }
      backoff = Math.min(backoff * 2, interval);
    }
  }

  async status(repoPath: string): Promise<RepoStatus | null> {
    const tool = this.cfg.tools.status;
    if (!tool) return null;
    try {
      const res = await this.call(repoPath, tool, this.repoArgs(repoPath));
      if (res.isError) return null;
      const status: RepoStatus = {
        indexed: looksIndexed(res.text),
        incomplete: /incomplete/i.test(res.text),
      };
      const files = extractNumber(res.text, "Files", "filesIndexed");
      const chunks = extractNumber(res.text, "Chunks", "Indexed chunks");
      if (files !== undefined) status.files = files;
      if (chunks !== undefined) status.chunks = chunks;
      return status;
    } catch {
      return null;
    }
  }

  /**
   * Every project this backend holds an index for.
   *
   * Parsing is deliberately generic: any "list projects" tool prints paths, so
   * lines that are *just* a path (optionally bulleted) are taken and everything
   * else ignored. That tolerates differing formats without teaching this class
   * about any particular backend. A path containing a newline would be missed;
   * no filesystem in practice has one.
   */
  async projects(): Promise<IndexedProject[] | null> {
    const tool = this.cfg.tools.list;
    if (!tool) return null;
    try {
      const res = await withMcp(this.sessionOpts(undefined, this.cfg.timeoutMs ?? 30_000), (s) =>
        s.callTool(tool, {}),
      );
      if (res.isError) return null;
      return parseProjectListing(res.text);
    } catch {
      return null;
    }
  }

  /**
   * Drop one index, then check the backend's own listing to see whether it
   * actually went.
   *
   * The reply cannot be trusted here, and the reason is structural rather than
   * a quirk of any one backend. `cleanup`'s entire input is paths whose
   * directory is gone, and a backend that identifies an index by something
   * stored *inside* the repository cannot resolve it once that is deleted — so
   * it removes nothing, finds nothing to complain about, and answers without an
   * error. Believing that is how `cleanup --apply` printed "removed" while the
   * index stayed put, forever re-listing as an orphan.
   *
   * Unlike an async index call, verification does not need to share a session:
   * a project listing is durable backend state rather than per-process
   * progress, so asking again in a fresh child is not merely adequate but
   * stricter — it proves the removal is visible to the *next* process, which is
   * exactly what the next `cleanup` run will be.
   */
  async remove(repoPath: string): Promise<RemoveOutcome> {
    const tool = this.cfg.tools.remove;
    if (!tool) {
      return { status: "failed", detail: "no `tools.remove` configured for this provider" };
    }

    let res: McpToolResult;
    try {
      res = await this.call(repoPath, tool, this.repoArgs(repoPath));
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (res.isError) {
      return { status: "failed", detail: firstMeaningfulLine(res.text) || res.text };
    }

    // No way to look: say so rather than passing the reply off as proof.
    if (!this.cfg.tools.list) {
      return {
        status: "unverified",
        detail: `${tool} reported success; no \`tools.list\` configured to confirm it`,
      };
    }
    const after = await this.projects();
    if (after === null) {
      return {
        status: "unverified",
        detail: `${tool} reported success, but ${this.cfg.tools.list} could not be read to confirm it`,
      };
    }
    if (after.some((p) => samePath(p.path, repoPath))) {
      return {
        status: "failed",
        detail: `${tool} reported success but the backend still lists this index`,
      };
    }
    return { status: "removed" };
  }

  async health(): Promise<ProviderHealth[]> {
    // Reachability is the only backend-agnostic health signal: can we spawn it
    // and complete a handshake? Anything more specific belongs to the backend.
    const probeDir = process.cwd();
    try {
      const res = await withMcp(
        this.sessionOpts(probeDir, this.cfg.timeoutMs ?? 30_000),
        async (s) => {
          const tool = this.cfg.tools.health ?? this.cfg.tools.status;
          if (!tool) return { isError: false, text: "handshake ok" };
          return s.callTool(tool, {});
        },
      );
      return [
        {
          ok: !res.isError,
          component: this.name,
          detail: res.isError ? res.text : "reachable",
          ...(res.isError
            ? { remedy: `check that \`${this.cfg.command} ${this.cfg.args.join(" ")}\` runs` }
            : {}),
        },
      ];
    } catch (err) {
      return [
        {
          ok: false,
          component: this.name,
          detail: err instanceof Error ? err.message : String(err),
          remedy: `check that \`${this.cfg.command} ${this.cfg.args.join(" ")}\` is installed and runnable`,
        },
      ];
    }
  }
}

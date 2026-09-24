/**
 * Minimal MCP client over stdio.
 *
 * Backends of interest ship as MCP servers with no CLI subcommands, so the only
 * way to drive them is to spawn the server and speak JSON-RPC at it:
 *
 *   initialize -> notifications/initialized -> tools/call
 *
 * This is deliberately hand-rolled rather than using the official SDK. The SDK
 * assumes a long-lived client; here every invocation is a one-shot child that
 * must be reaped deterministically, with a hard timeout, so a hung backend can
 * never wedge the queue. Reaped means waited for: `close()` returns once the
 * child — and anything it left holding its pipes — is gone, not once it has been
 * signalled. The wire format is small
 * enough that owning it is cheaper than bending the SDK's lifecycle to fit.
 *
 * cwd is ALWAYS pinned to the repository. Without it the child inherits the
 * directory the Git hook fired from — routinely a throwaway worktree that has
 * since been deleted — and the runtime dies during its own bootstrap with
 * `uv_cwd ENOENT`, long before the backend is reached. That failure surfaces
 * only as an opaque non-zero exit, so it is worth being explicit about.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { BackendLogLevel } from "./provider.js";
import { VERSION } from "./version.js";

export interface McpToolResult {
  isError: boolean;
  text: string;
  /**
   * Why the call never got an answer from the tool, when it did not. Absent for
   * any reply the tool produced itself, including one it flagged as an error.
   *
   * Callers that wait on a backend need the difference. A tool that reports an
   * error is running and may answer differently a moment later; a session that
   * could not start (`spawn`), died (`exit`) or ran out of time (`timeout`), or
   * a request the server rejected outright (`protocol`: an unknown tool, bad
   * arguments), will not.
   */
  failure?: McpError["kind"];
}

/**
 * Hard ceiling on a session when the config does not set one. Exported because
 * callers that wait on a backend must bound themselves by the same number —
 * two disagreeing deadlines is how a "hard ceiling" stops being one.
 */
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * How long `close()` waits for a signalled child before killing it outright.
 *
 * A backend asked to stop may finish its in-flight work first, and until it
 * exits it still holds whatever it holds — a lock on the project, above all.
 * One measured backend lets the current batch finish for up to a minute and
 * then closes its transport for up to three seconds more, so this sits above
 * that with room for a CPU-throttled container. A child that exits promptly
 * costs nothing here; the wait ends as soon as its pipes close.
 */
export const DEFAULT_KILL_AFTER_MS = 75_000;

/** After a forced kill, how long to wait on pipes held by something outside the process group. */
const AFTER_KILL_MS = 2_000;

/** How long a report of a dead backend waits for the rest of its stderr. */
const STDERR_DRAIN_MS = 2_000;

const IS_WINDOWS = process.platform === "win32";

/**
 * Signal a child's whole process group, or the child alone where there are no
 * groups. True if the signal reached a live process.
 */
function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (!IS_WINDOWS && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The group is already gone; try the child itself.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/** Backends still running, for passing on a signal that interrupts us. */
const live = new Set<ChildProcessWithoutNullStreams>();
const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
let forwarding = false;

function installForwarding(): void {
  // Prepended, so every other listener is still attached when it is counted.
  for (const s of FORWARDED) process.prependListener(s, forwardAndDie);
}

function removeForwarding(): void {
  for (const s of FORWARDED) process.removeListener(s, forwardAndDie);
}

function forwardAndDie(signal: NodeJS.Signals): void {
  // Another listener means the program handles this signal itself and may well
  // not be stopping; its sessions are then its own to close.
  if (process.listenerCount(signal) > 1) return;
  // The whole group, as the terminal or scheduler would have reached it.
  for (const child of live) signalGroup(child, signal);
  removeForwarding();
  // With no listener left, the default disposition applies again, so this ends
  // the process exactly as the signal would have.
  process.kill(process.pid, signal);
}

/**
 * Pass SIGINT, SIGTERM and SIGHUP on to running backends before dying of them.
 *
 * Each backend runs in its own process group (see `McpSession.open`), which a
 * terminal's Ctrl-C or a scheduler stopping the job no longer reaches. Without
 * this, a backend that stops on a signal but not on end of input would outlive
 * us, still holding its lock on the project.
 *
 * Opt-in, and meant for a program that has no signal handling of its own — the
 * CLI calls it once. A library must not install process-wide listeners behind
 * its embedder's back. Listeners are attached only while a backend is running,
 * and stand aside for any other listener the program adds for the same signal.
 */
export function forwardSignalsToBackends(): void {
  if (forwarding || IS_WINDOWS) return;
  forwarding = true;
  if (live.size > 0) installForwarding();
}

function track(child: ChildProcessWithoutNullStreams): void {
  if (IS_WINDOWS || child.pid === undefined) return;
  if (live.size === 0 && forwarding) installForwarding();
  live.add(child);
}

function untrack(child: ChildProcessWithoutNullStreams): void {
  if (!live.delete(child) || live.size > 0) return;
  removeForwarding();
}

export interface McpClientOptions {
  /** Executable to spawn, e.g. "npx". */
  command: string;
  args: string[];
  /** MUST be an existing directory; see the note above. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Hard ceiling on the whole session. */
  timeoutMs?: number;
  /** See {@link DEFAULT_KILL_AFTER_MS}. */
  killAfterMs?: number;
  /**
   * Receives the backend's log lines, which are otherwise dropped.
   *
   * A server that declares the `logging` capability sends its log as
   * `notifications/message` on stdout — the one channel a stdio client reads —
   * and it may do so at any point: before its `initialize` reply, between
   * calls, while it shuts down. No `logging/setLevel` is ever sent, so what
   * arrives is whatever the backend's own configured level lets through.
   *
   * Must not throw. If it does, that line is lost and the session carries on.
   */
  onLog?: (message: McpLogMessage) => void;
}

/** A log line a backend sent as an MCP `notifications/message`. */
export interface McpLogMessage {
  level: BackendLogLevel;
  /** The backend's name for the logger that wrote it, when it gave one. */
  logger?: string;
  /** The message as one bounded line; see {@link parseLogMessage}. */
  text: string;
}

/**
 * MCP's levels are syslog's eight (RFC 5424), finer than anyone reading a sync
 * log acts on: `notice` is information, and `critical`, `alert` and
 * `emergency` are errors.
 */
const MCP_LOG_LEVELS: ReadonlyMap<string, BackendLogLevel> = new Map([
  ["debug", "debug"],
  ["info", "info"],
  ["notice", "info"],
  ["warning", "warn"],
  ["error", "error"],
  ["critical", "error"],
  ["alert", "error"],
  ["emergency", "error"],
]);

/**
 * Longest backend log line kept, in characters. Room for a message followed by
 * the JSON context of a storage error; not room for a backend that dumps a
 * whole payload into one line to flood a log that is rotated by size.
 */
export const MAX_LOG_LINE = 2_000;

/** Longest logger name kept. A name, not a message. */
const MAX_LOGGER_NAME = 100;

/**
 * One line, at most `max` characters. The log is read line by line, and a
 * continuation line would carry no timestamp and no label. A cut says how much
 * it cut rather than cutting silently.
 */
function oneLine(text: string, max: number): string {
  const flat = text.trim().replace(/\s*[\r\n]+\s*/g, " | ");
  if (flat.length <= max) return flat;
  // Never end on the first half of a surrogate pair.
  const cut = /[\uD800-\uDBFF]/.test(flat.charAt(max - 1)) ? max - 1 : max;
  return `${flat.slice(0, cut)}… [${flat.length - cut} more chars]`;
}

/**
 * Read a `notifications/message`'s params, or null when there is nothing to log.
 *
 * `data` may be any JSON value. A string is kept as written and anything else
 * is written as JSON. A level outside MCP's eight is logged as info rather than
 * dropped: the line is still worth seeing, and guessing it more severe would
 * cry wolf. Never throws, whatever the backend sent.
 */
export function parseLogMessage(params: unknown): McpLogMessage | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const { level, logger, data } = params as Record<string, unknown>;
  if (data === undefined) return null;
  const text = oneLine(typeof data === "string" ? data : JSON.stringify(data), MAX_LOG_LINE);
  if (!text) return null;
  const name = typeof logger === "string" ? oneLine(logger, MAX_LOGGER_NAME) : "";
  return {
    level: (typeof level === "string" && MCP_LOG_LEVELS.get(level.toLowerCase())) || "info",
    ...(name ? { logger: name } : {}),
    text,
  };
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: "spawn" | "timeout" | "protocol" | "exit",
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** Flatten an MCP content array to plain text. */
function contentText(result: JsonRpcMessage["result"]): string {
  if (!result?.content) return "";
  return result.content
    .map((c) => c.text ?? "")
    .filter(Boolean)
    .join("\n");
}

export class McpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (m: JsonRpcMessage | McpError) => void>();
  private exited = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * A terminal failure (spawn error, exit, timeout). Sticky, because the
   * failure can land *before* the first request registers itself: `error` fires
   * on the next tick, while `open()` is still setting up the initialize call.
   * Without remembering it, that request would wait for the full timeout —
   * an hour by default — instead of failing immediately.
   */
  private fatal: McpError | null = null;
  /** Settles once the child and everything holding its pipes is gone, or at once if it never started. */
  private exitWait: Promise<void> = Promise.resolve();
  /** Every process holding the child's pipes has gone. */
  private reaped = false;
  private closing: Promise<void> | null = null;
  private killed = false;
  /** The last few KB the backend wrote to stderr, for an exit it did not explain. */
  private stderrTail = "";

  constructor(private readonly opts: McpClientOptions) {}

  /**
   * True once `close()` had to kill a child that would not exit in time.
   *
   * Whatever that child held is then left to go stale on the backend's own
   * schedule rather than released, so an immediate retry would meet it.
   */
  get forcedKill(): boolean {
    return this.killed;
  }

  async open(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so `close` can reach the backend itself even
      // behind a launcher such as `npx` or a shell. A signal interrupting
      // codeindex-sync is passed on to the group when the program opts in
      // (see `forwardSignalsToBackends`).
      detached: !IS_WINDOWS,
    });
    this.child = child;
    this.exitWait = new Promise((resolve) => {
      const gone = (): void => {
        this.reaped = true;
        untrack(child);
        resolve();
      };
      // `close`, not `exit`: the pipes close only once every process holding
      // them has gone — including a backend behind a shell that did not exec
      // it, which outlives the shell.
      child.once("close", gone);
      // A child that never started emits `error` and may emit nothing else.
      child.once("error", () => {
        if (child.pid === undefined) gone();
      });
    });
    track(child);

    child.on("error", (err) => {
      this.rejectAll(new McpError(`failed to spawn ${this.opts.command}: ${err.message}`, "spawn"));
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      // A backend that dies mid-call must not leave callers awaiting forever.
      // Its last stderr can still be in the pipe when `exit` fires — written
      // late, or by a process it left behind — so quote it once the pipes
      // close, or after STDERR_DRAIN_MS if something keeps them open.
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const report = (): void => {
        const said = this.stderrTail.trim();
        this.rejectAll(
          new McpError(`backend exited before responding (${how})${said ? `: ${said}` : ""}`, "exit"),
        );
      };
      const settle = setTimeout(report, STDERR_DRAIN_MS);
      child.once("close", () => {
        clearTimeout(settle);
        report();
      });
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // A write or end racing the child's exit fails with EPIPE; the exit handler
    // already reports why, and an unhandled stream error would crash us instead.
    child.stdin.on("error", () => {});
    // Read stderr even though nothing parses it: an unread pipe fills, and a
    // backend blocked writing a log line looks exactly like a hung one.
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2048);
    });

    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timer = setTimeout(() => {
      this.rejectAll(new McpError(`timed out after ${timeoutMs}ms`, "timeout"));
      void this.close();
    }, timeoutMs);

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codeindex-sync", version: VERSION },
    });
    this.notify("notifications/initialized");
  }

  /** Newline-delimited JSON; a partial trailing line is kept for the next chunk. */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // Servers may log non-JSON to stdout; ignore rather than die.
      }
      // `null` or `42` is JSON but no message, and reading a field of null throws.
      if (typeof msg !== "object" || msg === null) continue;
      if (msg.method === undefined) {
        if (typeof msg.id === "number") {
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg);
          }
        }
      } else if (msg.method === "notifications/message") {
        this.onLogMessage(msg.params);
      }
      // Anything else with a method — another notification, or a request from
      // the server — is ignored. It is never a response, whatever id it carries:
      // taking one for the reply to a pending call would answer that call with
      // nothing.
    }
  }

  private onLogMessage(params: unknown): void {
    const onLog = this.opts.onLog;
    if (!onLog) return;
    try {
      const message = parseLogMessage(params);
      if (message) onLog(message);
    } catch {
      // A log line is never worth a response: this loop is what delivers them.
    }
  }

  private rejectAll(err: McpError): void {
    this.fatal ??= err;
    for (const [, resolve] of this.pending) resolve(err);
    this.pending.clear();
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // Pipe closed underneath us; the exit handler surfaces it.
    }
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private request(method: string, params?: unknown): Promise<JsonRpcMessage | McpError> {
    // Already dead: answer now rather than waiting out the timeout.
    if (this.fatal) return Promise.resolve(this.fatal);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg instanceof McpError) return { isError: true, text: msg.message, failure: msg.kind };
    if (msg.error) return { isError: true, text: msg.error.message, failure: "protocol" };
    return { isError: msg.result?.isError === true, text: contentText(msg.result) };
  }

  /**
   * End the session: ask the child to stop, then wait for it to exit.
   *
   * The wait is what makes a retry safe. A child that is still shutting down
   * can still hold the backend's lock on the project, and a fresh child started
   * beside it is refused that lock — typically without saying so, since the
   * refusal happens after the tool has already replied. Returning at the signal
   * would hand the next attempt exactly that race.
   *
   * The order is the MCP stdio one: end the child's input, then SIGTERM, then —
   * only if it is still running after `killAfterMs` — SIGKILL, recorded in
   * `forcedKill` when it reached anything. Some servers stop only on end of
   * input, others only on a signal; a backend that honours both treats the
   * second as already under way.
   *
   * SIGTERM goes to the direct child first. A launcher such as `npx` passes it
   * on itself, and a backend must not get it twice — some treat a second as
   * "stop now". Once the direct child has exited, whatever remains of its
   * process group gets it: a backend behind a shell that did not exec it. The
   * SIGKILL goes to the whole group, since nothing can pass that on. The wait
   * lasts until every process holding the child's pipes has gone, not merely
   * the launcher.
   *
   * Idempotent: every caller, including the timeout, awaits the same exit.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Nothing may be sent once closing has begun; answer any later call at once.
    this.fatal ??= new McpError("session closed", "exit");

    const child = this.child;
    if (!child || this.reaped || child.pid === undefined) {
      this.closing = this.exitWait;
      return this.closing;
    }

    child.stdin.end();
    const termRest = (): void => {
      signalGroup(child, "SIGTERM");
    };
    if (this.exited) termRest();
    else {
      child.once("exit", termRest);
      child.kill("SIGTERM");
    }
    const killAfterMs = this.opts.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
    this.closing = new Promise<void>((resolve) => {
      let giveUp: NodeJS.Timeout | undefined;
      const killer = setTimeout(() => {
        // Only a kill that reached something counts: a child that exited in
        // time, leaving its pipes to a process outside its group, was not killed.
        if (signalGroup(child, "SIGKILL")) this.killed = true;
        // A process outside the group can still hold the pipes; stop waiting on it.
        giveUp = setTimeout(() => {
          untrack(child);
          resolve();
        }, AFTER_KILL_MS);
      }, killAfterMs);
      void this.exitWait.then(() => {
        clearTimeout(killer);
        if (giveUp) clearTimeout(giveUp);
        resolve();
      });
    });
    return this.closing;
  }
}

/** Open a session, run `fn`, and always reap the child before returning. */
export async function withMcp<T>(
  opts: McpClientOptions,
  fn: (s: McpSession) => Promise<T>,
): Promise<T> {
  const session = new McpSession(opts);
  try {
    await session.open();
    return await fn(session);
  } finally {
    await session.close();
  }
}

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
 * never wedge the queue. The wire format is small enough that owning it is
 * cheaper than bending the SDK's lifecycle to fit.
 *
 * cwd is ALWAYS pinned to the repository. Without it the child inherits the
 * directory the Git hook fired from — routinely a throwaway worktree that has
 * since been deleted — and the runtime dies during its own bootstrap with
 * `uv_cwd ENOENT`, long before the backend is reached. That failure surfaces
 * only as an opaque non-zero exit, so it is worth being explicit about.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpToolResult {
  isError: boolean;
  text: string;
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
  private readonly pending = new Map<number, (m: JsonRpcMessage) => void>();
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

  constructor(private readonly opts: McpClientOptions) {}

  async open(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => {
      this.rejectAll(new McpError(`failed to spawn ${this.opts.command}: ${err.message}`, "spawn"));
    });
    child.on("exit", () => {
      this.exited = true;
      // A backend that dies mid-call must not leave callers awaiting forever.
      this.rejectAll(new McpError("backend exited before responding", "exit"));
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));

    const timeoutMs = this.opts.timeoutMs ?? 60 * 60 * 1000;
    this.timer = setTimeout(() => {
      this.rejectAll(new McpError(`timed out after ${timeoutMs}ms`, "timeout"));
      this.close();
    }, timeoutMs);

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codeindex-sync", version: "0.1.0" },
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
      if (typeof msg.id === "number") {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    }
  }

  private rejectAll(err: McpError): void {
    this.fatal ??= err;
    for (const [, resolve] of this.pending) {
      resolve({ jsonrpc: "2.0", error: { code: -1, message: err.message } });
    }
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

  private request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    // Already dead: answer now rather than waiting out the timeout.
    if (this.fatal) {
      return Promise.resolve({ jsonrpc: "2.0", error: { code: -1, message: this.fatal.message } });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) return { isError: true, text: msg.error.message };
    return { isError: msg.result?.isError === true, text: contentText(msg.result) };
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.child && !this.exited) this.child.kill();
    this.child = null;
  }
}

/** Open a session, run `fn`, and always reap the child. */
export async function withMcp<T>(
  opts: McpClientOptions,
  fn: (s: McpSession) => Promise<T>,
): Promise<T> {
  const session = new McpSession(opts);
  try {
    await session.open();
    return await fn(session);
  } finally {
    session.close();
  }
}

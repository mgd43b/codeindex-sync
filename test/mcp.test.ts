import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive } from "../src/lock.js";
import { MAX_LOG_LINE, McpSession, parseLogMessage, withMcp, type McpLogMessage } from "../src/mcp.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-mcp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stub MCP server. Real backends are heavyweight and network-bound, so the
 * protocol handling is exercised against a scripted stand-in instead.
 */
function stubServer(body: string): string {
  const file = path.join(dir, "server.mjs");
  writeFileSync(
    file,
    `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    handle(msg);
  }
});
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
${body}
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

const NODE = process.execPath;

describe("McpSession", () => {
  it("completes the handshake and calls a tool", async () => {
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  if (msg.method === "tools/call")
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Added: 3 New chunks: 135" }] } });
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15000 }, (s) =>
      s.callTool("codebase_update", { projectPath: "/repo" }),
    );
    expect(res.isError).toBe(false);
    expect(res.text).toContain("New chunks: 135");
  });

  it("surfaces a tool error without throwing", async () => {
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call")
    return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "another indexer holds the lock" }] } });
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15000 }, (s) =>
      s.callTool("codebase_update", {}),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("holds the lock");
  });

  it("surfaces a JSON-RPC error object", async () => {
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call")
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such tool" } });
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15000 }, (s) =>
      s.callTool("nope", {}),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no such tool");
  });

  it("ignores non-JSON noise on stdout", async () => {
    // Servers commonly log banners to stdout; that must not kill the session.
    const server = stubServer(`
process.stdout.write("starting up, not json\\n");
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call")
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15000 }, (s) =>
      s.callTool("x", {}),
    );
    expect(res.text).toBe("ok");
  });

  it("handles a response split across chunk boundaries", async () => {
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") {
    const s = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "split-ok" }] } });
    process.stdout.write(s.slice(0, 10));
    setTimeout(() => process.stdout.write(s.slice(10) + "\\n"), 20);
  }
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15000 }, (s) =>
      s.callTool("x", {}),
    );
    expect(res.text).toBe("split-ok");
  });

  it("does not hang when the backend dies mid-call", async () => {
    // The queue must never be wedged by a crashed backend.
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") process.exit(1);
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15000 }, (s) =>
      s.callTool("x", {}),
    );
    expect(res.isError).toBe(true);
  });

  it("times out rather than waiting forever on a silent backend", async () => {
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  // tools/call: never respond.
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 400 }, (s) =>
      s.callTool("x", {}),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/timed out/);
  });

  it("reports a spawn failure instead of throwing raw", async () => {
    const res = await withMcp(
      { command: path.join(dir, "does-not-exist"), args: [], cwd: dir, timeoutMs: 5000 },
      (s) => s.callTool("x", {}),
    );
    expect(res.isError).toBe(true);
  });
});

describe("fast failure", () => {
  it("reports a missing backend immediately, not after the timeout", async () => {
    // Regression: `error` fires before the first request registers, so without
    // a sticky fatal state this waited out the full timeout (1h by default).
    const t0 = Date.now();
    const res = await withMcp(
      { command: path.join(dir, "nope"), args: [], cwd: dir, timeoutMs: 30_000 },
      (s) => s.callTool("x", {}),
    );
    const elapsed = Date.now() - t0;
    expect(res.isError).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("backend log messages", () => {
  // A server declaring the `logging` capability sends its log on stdout as
  // `notifications/message`. These used to be read and thrown away, and with
  // them the backend's own account of why a sync failed.

  /** A JS expression, for a stub, that sends one log notification. */
  const log = (params: unknown): string =>
    `send({ jsonrpc: "2.0", method: "notifications/message", params: ${JSON.stringify(params)} });`;

  /** A stub that runs `beforeReply` inside its tools/call handler, then answers "ok". */
  const loggingDuringCall = (beforeReply: string): string =>
    stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") {
    ${beforeReply}
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
}
`);

  /** Everything one session logs, and the tool call's result. */
  async function callLogging(server: string): Promise<{ got: McpLogMessage[]; text: string }> {
    const got: McpLogMessage[] = [];
    const res = await withMcp(
      { command: NODE, args: [server], cwd: dir, timeoutMs: 15_000, onLog: (m) => got.push(m) },
      (s) => s.callTool("x", {}),
    );
    return { got, text: res.text };
  }

  it("delivers a line sent before the initialize reply, and the handshake still completes", async () => {
    // A backend logs while it starts, before it has answered anything:
    // SocratiCode 1.15.0 sends two lines ahead of its initialize reply.
    const server = stubServer(`
${log({ level: "warning", logger: "stub", data: "config entry ignored" })}
function handle(msg) {
  if (msg.method === "initialize") {
    ${log({ level: "info", data: "connected" })}
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "tools/call") {
    ${log({ level: "error", data: "storage said no" })}
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
}
`);
    const got: McpLogMessage[] = [];
    const session = new McpSession({ command: NODE, args: [server], cwd: dir, onLog: (m) => got.push(m) });
    try {
      await session.open();
      expect(got).toEqual([
        { level: "warn", logger: "stub", text: "config entry ignored" },
        { level: "info", text: "connected" },
      ]);
      const res = await session.callTool("x", {});
      expect(res).toEqual({ isError: false, text: "ok" });
      expect(got.at(-1)).toEqual({ level: "error", text: "storage said no" });
    } finally {
      await session.close();
    }
  });

  it("maps MCP's eight levels onto debug, info, warn and error", async () => {
    const sent = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
    const { got } = await callLogging(loggingDuringCall(sent.map((level) => log({ level, data: level })).join("\n")));
    expect(got.map((m) => [m.text, m.level])).toEqual([
      ["debug", "debug"],
      ["info", "info"],
      ["notice", "info"],
      ["warning", "warn"],
      ["error", "error"],
      ["critical", "error"],
      ["alert", "error"],
      ["emergency", "error"],
    ]);
  });

  it("logs a line whose level it does not recognise as info rather than dropping it", async () => {
    const { got } = await callLogging(
      loggingDuringCall(
        [
          log({ level: "WARNING", data: "shouted" }),
          log({ level: "verbose", data: "unknown level" }),
          log({ data: "no level at all" }),
          log({ level: { nested: true }, data: "level is not a string" }),
        ].join("\n"),
      ),
    );
    expect(got.map((m) => [m.text, m.level])).toEqual([
      ["shouted", "warn"],
      ["unknown level", "info"],
      ["no level at all", "info"],
      ["level is not a string", "info"],
    ]);
  });

  it("writes data that is not a string as JSON, on one line", async () => {
    // `data` may be any JSON value; the log is read line by line.
    const { got } = await callLogging(
      loggingDuringCall(
        [
          log({ level: "error", data: { error: "upsert failed", status: 500 } }),
          log({ level: "info", data: 42 }),
          log({ level: "info", data: null }),
          log({ level: "info", data: false }),
          log({ level: "info", data: ["a", 1] }),
          log({ level: "error", data: "first line\n  at frame one\r\n  at frame two\n" }),
        ].join("\n"),
      ),
    );
    expect(got.map((m) => m.text)).toEqual([
      '{"error":"upsert failed","status":500}',
      "42",
      "null",
      "false",
      '["a",1]',
      "first line | at frame one | at frame two",
    ]);
  });

  it("caps an absurdly long line, saying how much it cut", async () => {
    const { got } = await callLogging(loggingDuringCall(log({ level: "info", data: "x".repeat(MAX_LOG_LINE + 500) })));
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe(`${"x".repeat(MAX_LOG_LINE)}… [500 more chars]`);
  });

  it("carries on answering calls whatever arrives on stdout between them", async () => {
    // Nothing a backend writes may cost a response: not a malformed
    // notification, not a bare JSON value, and not a notification that carries
    // the id of the very call waiting for a reply.
    const { got, text } = await callLogging(
      loggingDuringCall(`
process.stdout.write("null\\n42\\n\\"a string\\"\\n[1,2]\\n");
send({ jsonrpc: "2.0", method: "notifications/message" });
send({ jsonrpc: "2.0", method: "notifications/message", params: "just text" });
send({ jsonrpc: "2.0", method: "notifications/message", params: [1, 2] });
send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "error" } });
send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "   " } });
send({ jsonrpc: "2.0", id: msg.id, method: "notifications/message", params: { level: "warning", data: "has an id" } });
send({ jsonrpc: "2.0", id: msg.id, method: "roots/list" });
send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 5 } });
${log({ level: "info", data: "still logging" })}`),
    );
    expect(text).toBe("ok");
    expect(got).toEqual([
      { level: "warn", text: "has an id" },
      { level: "info", text: "still logging" },
    ]);
  });

  it("survives a log sink that throws", async () => {
    const server = loggingDuringCall(`${log({ level: "info", data: "one" })}\n${log({ level: "info", data: "two" })}`);
    const seen: string[] = [];
    const res = await withMcp(
      {
        command: NODE,
        args: [server],
        cwd: dir,
        timeoutMs: 15_000,
        onLog: (m) => {
          seen.push(m.text);
          throw new Error("sink is broken");
        },
      },
      (s) => s.callTool("x", {}),
    );
    expect(res).toEqual({ isError: false, text: "ok" });
    expect(seen).toEqual(["one", "two"]);
  });

  it("drops the lines when nobody asked for them, as before", async () => {
    const server = loggingDuringCall(log({ level: "error", data: "unheard" }));
    const res = await withMcp({ command: NODE, args: [server], cwd: dir, timeoutMs: 15_000 }, (s) => s.callTool("x", {}));
    expect(res).toEqual({ isError: false, text: "ok" });
  });
});

describe("parseLogMessage", () => {
  it("is null for params that carry nothing to log", () => {
    for (const params of [undefined, null, "text", 3, [1], {}, { level: "info" }, { data: "" }, { data: " \n " }]) {
      expect(parseLogMessage(params)).toBeNull();
    }
  });

  it("keeps the logger's name, on one bounded line", () => {
    expect(parseLogMessage({ level: "info", logger: "indexer", data: "hi" })).toEqual({
      level: "info",
      logger: "indexer",
      text: "hi",
    });
    expect(parseLogMessage({ logger: "a\nb", data: "hi" })?.logger).toBe("a | b");
    expect(parseLogMessage({ logger: "n".repeat(500), data: "hi" })?.logger).toMatch(/^n{100}… \[400 more chars]$/);
    expect(parseLogMessage({ logger: 7, data: "hi" })).toEqual({ level: "info", text: "hi" });
  });

  it("never cuts a character in half", () => {
    // "😀" is two UTF-16 units; a cut between them leaves a lone surrogate,
    // which is written to the log as a replacement character.
    const text = parseLogMessage({ data: `${"x".repeat(MAX_LOG_LINE - 1)}😀tail` })!.text;
    expect(text).toBe(`${"x".repeat(MAX_LOG_LINE - 1)}… [6 more chars]`);
  });
});

describe("failure kinds", () => {
  // Callers that wait on a backend retry a tool's own error but not a dead or
  // refusing session, so the two must be told apart.
  const answering = `
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.params?.name === "tool-error")
    return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "read failed" }] } });
  if (msg.params?.name === "die") { process.stderr.write("fatal: storage gone\\n"); process.exit(2); }
  if (msg.params?.name === "hang") return;
  return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such tool" } });
}
`;

  it("leaves a tool's own error unmarked", async () => {
    const res = await withMcp({ command: NODE, args: [stubServer(answering)], cwd: dir }, (s) =>
      s.callTool("tool-error", {}),
    );
    expect(res).toEqual({ isError: true, text: "read failed" });
  });

  it("marks a JSON-RPC error as a protocol failure", async () => {
    const res = await withMcp({ command: NODE, args: [stubServer(answering)], cwd: dir }, (s) =>
      s.callTool("unknown", {}),
    );
    expect(res.failure).toBe("protocol");
  });

  it("marks a backend that died as an exit, with what it said on stderr", async () => {
    const res = await withMcp({ command: NODE, args: [stubServer(answering)], cwd: dir }, (s) =>
      s.callTool("die", {}),
    );
    expect(res.failure).toBe("exit");
    expect(res.text).toMatch(/code 2/);
    expect(res.text).toContain("storage gone");
  });

  it("quotes stderr that arrives after the backend's exit", async () => {
    // Node can report the exit before the last of stderr is read, and a process
    // the backend left behind can still be writing to it.
    const server = stubServer(`
import { spawn } from "node:child_process";
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  spawn("/bin/sh", ["-c", "sleep 0.2; echo 'late: disk full' >&2"], { stdio: ["ignore", "ignore", "inherit"] });
  process.exit(2);
}
`);
    const res = await withMcp({ command: NODE, args: [server], cwd: dir }, (s) => s.callTool("x", {}));
    expect(res.failure).toBe("exit");
    expect(res.text).toContain("late: disk full");
  });

  it("marks a timeout", async () => {
    const res = await withMcp(
      { command: NODE, args: [stubServer(answering)], cwd: dir, timeoutMs: 300 },
      (s) => s.callTool("hang", {}),
    );
    expect(res.failure).toBe("timeout");
  });

  it("marks a spawn failure", async () => {
    const res = await withMcp({ command: path.join(dir, "absent"), args: [], cwd: dir }, (s) =>
      s.callTool("x", {}),
    );
    expect(res.failure).toBe("spawn");
  });
});

describe("closing a session", () => {
  /**
   * A backend that records its pid and takes `delayMs` to exit after SIGTERM,
   * or never exits on its own when `delayMs` is null. Kept alive by a timer, so
   * end of input alone does not stop it.
   */
  function slowToExit(delayMs: number | null): { server: string; pidFile: string } {
    const pidFile = path.join(dir, "pid");
    const server = stubServer(`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1 << 30);
process.on("SIGTERM", () => { ${delayMs === null ? "" : `setTimeout(() => process.exit(0), ${delayMs});`} });
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
}
`);
    return { server, pidFile };
  }

  it("returns only once the child has exited, however long its shutdown takes", async () => {
    // A child still shutting down can still hold its project lock; a retry that
    // starts beside it is refused that lock and fails for no reason of its own.
    const { server, pidFile } = slowToExit(700);
    const t0 = Date.now();
    await withMcp({ command: NODE, args: [server], cwd: dir }, (s) => s.callTool("x", {}));

    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("kills a child that will not exit, and says so", async () => {
    const { server, pidFile } = slowToExit(null);
    const session = new McpSession({ command: NODE, args: [server], cwd: dir, killAfterMs: 300 });
    await session.open();
    await session.callTool("x", {});
    const t0 = Date.now();
    await session.close();

    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(session.forcedKill).toBe(true);
    expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("ends the child's input first, so a server that stops only on end of input is not killed", async () => {
    // The MCP stdio shutdown order. A server that ignores SIGTERM — node as a
    // container's PID 1, say — would otherwise cost killAfterMs on every
    // session and have every failure parked as not retryable.
    const server = stubServer(`
process.on("SIGTERM", () => {});
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
`);
    const session = new McpSession({ command: NODE, args: [server], cwd: dir, killAfterMs: 10_000 });
    await session.open();
    const t0 = Date.now();
    await session.close();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(session.forcedKill).toBe(false);
  });

  it("kills a backend that sits behind a launcher, not just the launcher", async () => {
    // \`npx -y socraticode\` is a launcher: SIGKILL cannot be passed on, so killing
    // only the direct child orphans the backend, still holding its lock.
    const { server, pidFile } = slowToExit(null);
    const launcher = path.join(dir, "launcher.mjs");
    writeFileSync(
      launcher,
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(server)}], { stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
`,
      "utf8",
    );
    const session = new McpSession({ command: NODE, args: [launcher], cwd: dir, killAfterMs: 300 });
    await session.open();
    await session.callTool("x", {});
    await session.close();

    expect(session.forcedKill).toBe(true);
    const backend = Number(readFileSync(pidFile, "utf8"));
    // The kill is delivered, but reaping the orphan can take a moment.
    for (let i = 0; i < 50 && isAlive(backend); i++) await new Promise((r) => setTimeout(r, 20));
    expect(isAlive(backend)).toBe(false);
  });

  it("waits for a backend behind a shell that does not exec it, not just for the shell", async () => {
    // \`sh -c "server; true"\` dies on SIGTERM at once while its server is still
    // shutting down and holding its lock; returning then hands a retry the race.
    // This server also ignores end of input, so only a signal to the whole
    // group stops it before the 10s kill.
    const { server, pidFile } = slowToExit(700);
    const session = new McpSession({
      command: "/bin/sh",
      args: ["-c", `${JSON.stringify(NODE)} ${JSON.stringify(server)}; true`],
      cwd: dir,
      killAfterMs: 10_000,
    });
    await session.open();
    await session.callTool("x", {});
    const t0 = Date.now();
    await session.close();

    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(session.forcedKill).toBe(false);
    expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("signals a backend behind a forwarding launcher once, so its graceful shutdown runs", async () => {
    // npx passes SIGTERM on. Signalling its whole group as well delivered it
    // twice, and a backend whose handler is \`process.once\` died of the second
    // partway through shutting down.
    const marker = path.join(dir, "graceful");
    const backend = stubServer(`
import { writeFileSync } from "node:fs";
setInterval(() => {}, 1 << 30);
process.once("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, "done"); process.exit(0); }, 700));
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
`);
    const launcher = path.join(dir, "forwarding-launcher.mjs");
    writeFileSync(
      launcher,
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(backend)}], { stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
`,
      "utf8",
    );
    const session = new McpSession({ command: NODE, args: [launcher], cwd: dir, killAfterMs: 10_000 });
    await session.open();
    const t0 = Date.now();
    await session.close();

    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    expect(existsSync(marker)).toBe(true);
  });

  it("does not report a forced kill when the kill reached nothing", async () => {
    // The backend exited in time; a helper outside its group kept the pipes
    // open. Calling that a forced kill parks an ordinary failure as unretryable.
    const helperPid = path.join(dir, "helper.pid");
    const server = stubServer(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const helper = spawn("/bin/sleep", ["30"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));
helper.unref();
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
`);
    const session = new McpSession({ command: NODE, args: [server], cwd: dir, killAfterMs: 300 });
    try {
      await session.open();
      await session.close();
      expect(session.forcedKill).toBe(false);
    } finally {
      try {
        process.kill(Number(readFileSync(helperPid, "utf8")), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("does not report a forced kill for a child that exited in time", async () => {
    const { server } = slowToExit(50);
    const session = new McpSession({ command: NODE, args: [server], cwd: dir, killAfterMs: 5_000 });
    await session.open();
    await session.close();
    expect(session.forcedKill).toBe(false);
  });

  it("answers a call made after closing at once instead of hanging", async () => {
    const { server } = slowToExit(0);
    const session = new McpSession({ command: NODE, args: [server], cwd: dir, timeoutMs: 30_000 });
    await session.open();
    await session.close();
    const t0 = Date.now();
    const res = await session.callTool("x", {});
    expect(res.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("can be closed twice, both callers waiting on the same exit", async () => {
    const { server, pidFile } = slowToExit(300);
    const session = new McpSession({ command: NODE, args: [server], cwd: dir });
    await session.open();
    await Promise.all([session.close(), session.close()]);
    expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });
});


describe("signals that interrupt the program", () => {
  it("installs no process-wide listeners unless the program opts in", async () => {
    // A library must not change how its embedder handles signals.
    const before = FORWARDED.map((sig) => process.listenerCount(sig));
    const server = stubServer(`
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
}
`);
    await withMcp({ command: NODE, args: [server], cwd: dir }, async (s) => {
      expect(FORWARDED.map((sig) => process.listenerCount(sig))).toEqual(before);
      return s.callTool("x", {});
    });
  });

  it("stands aside when the program handles the signal itself", async () => {
    // A host with its own SIGTERM handler may not be stopping at all: it must
    // not see its handler run twice, die anyway, or lose its backend.
    const pidFile = path.join(dir, "backend.pid");
    const handled = path.join(dir, "handled");
    const server = stubServer(`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1 << 30);
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
}
`);
    const host = path.join(dir, "host.mts");
    writeFileSync(
      host,
      `import { appendFileSync } from "node:fs";
import { forwardSignalsToBackends, McpSession } from ${JSON.stringify(path.resolve("src/mcp.ts"))};
forwardSignalsToBackends();
process.on("SIGTERM", () => appendFileSync(${JSON.stringify(handled)}, "x"));
const session = new McpSession({ command: process.execPath, args: [${JSON.stringify(server)}], cwd: ${JSON.stringify(dir)} });
await session.open();
process.stdout.write("ready\\n");
setInterval(() => {}, 1 << 30);
`,
      "utf8",
    );
    const child = spawn(NODE, ["--import", "tsx", host], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "inherit"] });
    let backend = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (c: Buffer) => c.toString().includes("ready") && resolve());
        child.once("exit", () => reject(new Error("host exited before it was ready")));
      });
      backend = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));

      expect(readFileSync(handled, "utf8")).toBe("x");
      expect(child.exitCode).toBeNull();
      expect(isAlive(backend)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      if (backend) {
        try {
          process.kill(backend, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

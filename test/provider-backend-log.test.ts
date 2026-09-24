/**
 * A backend's own log, carried through an index run.
 *
 * A tool's reply to a failed index is often just "failed"; the reason — a
 * storage error, a file it could not read — is in what the backend logged on
 * the way. An MCP backend sends that as `notifications/message`, and the
 * provider hands each line to the request's `log`, for the worker log.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendLogLine } from "../src/provider.js";
import { McpIndexProvider } from "../src/providers/mcp-provider.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-backend-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A backend that logs as it starts, again during `update`, and once more as it
 * shuts down, then answers `update` with `reply` (an error when `failing`).
 */
function loggingBackend(opts: { reply: string; failing: boolean }): string {
  const file = path.join(dir, "server.mjs");
  writeFileSync(
    file,
    `
const send = (o, done) => process.stdout.write(JSON.stringify(o) + "\\n", done);
const log = (params, done) => send({ jsonrpc: "2.0", method: "notifications/message", params }, done);
log({ level: "info", logger: "stub", data: "starting" });
// Asked to stop — by end of input or SIGTERM, which arrive together — it logs
// once more, as a backend finishing its shutdown does, and exits once written.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  log({ level: "info", logger: "stub", data: "shutting down" }, () => process.exit(0));
};
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let n;
  while ((n = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.method === "tools/call") {
      log({ level: "error", logger: "store", data: { error: "upsert rejected", status: 400 } });
      send({ jsonrpc: "2.0", id: m.id, result: { isError: ${opts.failing}, content: [{ type: "text", text: ${JSON.stringify(opts.reply)} }] } });
    }
  }
});
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

function providerFor(server: string): McpIndexProvider {
  return new McpIndexProvider({
    name: "stub",
    command: process.execPath,
    args: [server],
    tools: { update: "u" },
    timeoutMs: 15_000,
  });
}

describe("a backend's log during an index run", () => {
  it("reaches the request's log, from start-up to shutdown", async () => {
    const lines: BackendLogLine[] = [];
    const out = await providerFor(loggingBackend({ reply: "Added: 1", failing: false })).index({
      repoPath: dir,
      full: false,
      reason: "manual",
      log: (l) => lines.push(l),
    });

    expect(out.status).toBe("ok");
    expect(lines).toEqual([
      // Its logger is the provider's own name, which the label already says.
      { level: "info", message: "starting" },
      // A logger the label does not name is kept.
      { level: "error", message: 'store: {"error":"upsert rejected","status":400}' },
      // `close()` waits for the backend to exit, so its last words arrive too.
      { level: "info", message: "shutting down" },
    ]);
  });

  it("carries the reason a failed run gives only in its log", async () => {
    const lines: BackendLogLine[] = [];
    const out = await providerFor(loggingBackend({ reply: "Indexing failed", failing: true })).index({
      repoPath: dir,
      full: false,
      reason: "manual",
      log: (l) => lines.push(l),
    });

    expect(out).toMatchObject({ status: "failed", error: "Indexing failed" });
    expect(lines.map((l) => l.message)).toContain('store: {"error":"upsert rejected","status":400}');
  });

  it("runs as before when the caller takes no log", async () => {
    const out = await providerFor(loggingBackend({ reply: "Added: 1", failing: false })).index({
      repoPath: dir,
      full: false,
      reason: "manual",
    });
    expect(out.status).toBe("ok");
  });
});

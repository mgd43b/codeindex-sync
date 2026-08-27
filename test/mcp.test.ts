import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withMcp } from "../src/mcp.js";

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

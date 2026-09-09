/**
 * Sessions must not let the backend index on its own.
 *
 * SocratiCode auto-resumes the project at its cwd on startup, which is right
 * for an MCP host that has opened a project and wrong for us: we spawn
 * short-lived sessions with cwd set to a repo purely to make a tool call, and
 * we drive indexing explicitly. Left on, it made read-only commands mutate —
 * `list --all` inside a repo re-indexed it, and a session spawned with cwd in a
 * linked worktree re-pointed that project at the worktree and pruned the main
 * checkout's content.
 *
 * Driven against a stub server that reports the env it was actually spawned
 * with, so this pins the child process rather than our intent.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpIndexProvider } from "../src/providers/mcp-provider.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-autoresume-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Stub server that echoes one env var back as the tool result. */
function envEchoServer(variable: string): string {
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
    handle(JSON.parse(line));
  }
});
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") {
    const v = process.env[${JSON.stringify(variable)}];
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "- /seen/" + (v === undefined ? "UNSET" : v) }] },
    });
  }
}
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

function providerFor(server: string, env?: Record<string, string>): McpIndexProvider {
  return new McpIndexProvider({
    name: "stub",
    description: "stub",
    command: process.execPath,
    args: [server],
    tools: { update: "u", list: "l" },
    timeoutMs: 15_000,
    ...(env ? { env } : {}),
  });
}

/** The stub reports the value as a project path, which projects() parses out. */
async function observedValue(p: McpIndexProvider): Promise<string | undefined> {
  const got = await p.projects();
  return got?.[0]?.path?.replace("/seen/", "");
}

describe("spawned backend sessions disable startup auto-indexing", () => {
  it("sets SOCRATICODE_AUTO_RESUME=off in the child environment", async () => {
    const p = providerFor(envEchoServer("SOCRATICODE_AUTO_RESUME"));
    expect(await observedValue(p)).toBe("off");
  });

  it("overrides an ambient value rather than inheriting it", async () => {
    // A shell that has it set to `all` must not re-enable indexing for a tool
    // call: the session is ours, and it is not a project the user opened.
    const previous = process.env.SOCRATICODE_AUTO_RESUME;
    process.env.SOCRATICODE_AUTO_RESUME = "all";
    try {
      const p = providerFor(envEchoServer("SOCRATICODE_AUTO_RESUME"));
      expect(await observedValue(p)).toBe("off");
    } finally {
      if (previous === undefined) delete process.env.SOCRATICODE_AUTO_RESUME;
      else process.env.SOCRATICODE_AUTO_RESUME = previous;
    }
  });

  it("still lets provider config opt back in", async () => {
    // Escape hatch: an operator who genuinely wants backend-driven catch-up can
    // ask for it, and their configuration wins over our default.
    const p = providerFor(envEchoServer("SOCRATICODE_AUTO_RESUME"), {
      SOCRATICODE_AUTO_RESUME: "all",
    });
    expect(await observedValue(p)).toBe("all");
  });
});

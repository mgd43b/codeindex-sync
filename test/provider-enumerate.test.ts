/**
 * Provider enumeration and removal — what `list --all` and `cleanup` stand on.
 *
 * Driven against stub MCP servers rather than a real backend, so the parsing
 * is pinned without a network or a GPU, and so a backend that *cannot* do this
 * is exercised too: degrading cleanly matters as much as working.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpIndexProvider, parseProjectListing } from "../src/providers/mcp-provider.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-enum-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(body: string): string {
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
${body}
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

function providerFor(server: string, tools: Record<string, string>): McpIndexProvider {
  return new McpIndexProvider({
    name: "stub",
    description: "stub",
    command: process.execPath,
    args: [server],
    tools: { update: "u", ...tools },
    timeoutMs: 15_000,
  });
}

const TEXT = (t: string): string => `function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: ${JSON.stringify(t)} }] } });
}`;

describe("projects()", () => {
  it("extracts bulleted paths and ignores metadata lines", async () => {
    const p = providerFor(
      stub(
        TEXT(
          [
            "Indexed projects:",
            "",
            "  - /home/me/alpha",
            "    Collection: codebase_alpha",
            "    Files: 39",
            "  - /home/me/beta",
          ].join("\n"),
        ),
      ),
      { list: "l" },
    );
    const got = await p.projects();
    expect(got?.map((x) => x.path)).toEqual(["/home/me/alpha", "/home/me/beta"]);
    // The detail lines beneath each path are captured, not discarded — this is
    // what `list --all` renders as AGE / FILES / COLLECTION.
    expect(got?.[0]).toMatchObject({ collection: "codebase_alpha", files: "39" });
  });

  it("keeps paths containing spaces", async () => {
    const p = providerFor(stub(TEXT("  - /home/me/my project")), { list: "l" });
    expect((await p.projects())?.map((x) => x.path)).toEqual(["/home/me/my project"]);
  });

  it("de-duplicates repeats", async () => {
    const p = providerFor(stub(TEXT("- /a\n- /a\n- /b")), { list: "l" });
    expect((await p.projects())?.map((x) => x.path)).toEqual(["/a", "/b"]);
  });

  it("returns null when the backend has no list tool", async () => {
    // The signal `cleanup` needs to say "unsupported" instead of "nothing found",
    // which would read as "you have no orphans" and be wrong.
    const p = providerFor(stub(TEXT("irrelevant")), {});
    expect(await p.projects()).toBeNull();
  });

  it("returns null rather than throwing when the tool errors", async () => {
    const p = providerFor(
      stub(`function handle(msg) {
        if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
        if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "nope" }] } });
      }`),
      { list: "l" },
    );
    expect(await p.projects()).toBeNull();
  });
});

describe("remove()", () => {
  it("reports success when the backend accepts", async () => {
    const p = providerFor(stub(TEXT("Removed index for: /a")), { remove: "r" });
    expect(await p.remove("/a")).toBe(true);
  });

  it("is false when the backend cannot remove", async () => {
    const p = providerFor(stub(TEXT("x")), {});
    expect(await p.remove("/a")).toBe(false);
  });

  it("is false on a tool error rather than throwing", async () => {
    const p = providerFor(
      stub(`function handle(msg) {
        if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
        if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
      }`),
      { remove: "r" },
    );
    expect(await p.remove("/a")).toBe(false);
  });
});

describe("parseProjectListing", () => {
  it("captures collection, file count and timestamp", () => {
    const got = parseProjectListing(
      [
        "Indexed projects:",
        "",
        "  - /home/me/alpha",
        "    Collection: codebase_alpha",
        "    Last indexed: 2026-08-25T20:17:02.701Z",
        "    Files: 39",
      ].join("\n"),
    );
    expect(got).toEqual([
      {
        path: "/home/me/alpha",
        collection: "codebase_alpha",
        lastIndexedAt: "2026-08-25T20:17:02.701Z",
        files: "39",
      },
    ]);
  });

  it("keeps a partial count verbatim and flags it incomplete", () => {
    // "3437/2798" must not be coerced to a number: reporting 3437 would claim
    // more files were indexed than actually were.
    const got = parseProjectListing(
      "  - /home/me/big\n    Files: 3437/2798 (INCOMPLETE — run codebase_index to resume)\n",
    );
    expect(got[0]?.files).toBe("3437/2798");
    expect(got[0]?.incomplete).toBe(true);
  });

  it("ignores keys it does not know rather than failing", () => {
    // A backend adding a field must not break parsing.
    const got = parseProjectListing(
      "  - /home/me/x\n    Code graph: 13 files, 6 edges\n    Something New: 1\n    Files: 4\n",
    );
    expect(got[0]).toEqual({ path: "/home/me/x", files: "4" });
  });

  it("attaches details to the right project when several are listed", () => {
    const got = parseProjectListing(
      "  - /a\n    Files: 1\n  - /b\n    Files: 2\n",
    );
    expect(got.map((g) => [g.path, g.files])).toEqual([
      ["/a", "1"],
      ["/b", "2"],
    ]);
  });

  it("returns nothing for output with no paths", () => {
    expect(parseProjectListing("No projects have been indexed.")).toEqual([]);
  });

  it("ignores detail lines that appear before any project", () => {
    expect(parseProjectListing("  Files: 9\n  - /a\n")).toEqual([{ path: "/a" }]);
  });
});

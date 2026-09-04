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

/**
 * A backend whose remove tool answers politely either way.
 *
 * `honest: false` is the shape that caused the bug: it acknowledges the call
 * and leaves the index in place, which is what a real backend does when it
 * cannot resolve a project whose directory has already been deleted.
 *
 * Whether the index is gone is kept in a FILE, not a variable, because a real
 * backend's project listing is durable state rather than per-process progress.
 * That is what makes confirming in a fresh child legitimate here — and the
 * stub has to model it, or an honest removal would look like a failed one.
 */
function removeStub(opts: { honest: boolean; listAs?: string }): string {
  const listed = JSON.stringify(opts.listAs ?? "/a");
  return stub(`
import { existsSync, writeFileSync } from "node:fs";
const gone = process.argv[1] + ".removed";
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method !== "tools/call") return;
  const name = msg.params?.name;
  const text = (t) => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: t }] } });
  if (name === "r") {
    if (${opts.honest ? "true" : "false"}) writeFileSync(gone, "1");
    // Either way the reply is a cheerful success.
    return text("Removed index for: /a");
  }
  if (name === "l") {
    return text(existsSync(gone) ? "No projects have been indexed." : "  - " + ${listed});
  }
}`);
}

describe("remove()", () => {
  it("confirms a removal against the backend's own listing", async () => {
    const p = providerFor(removeStub({ honest: true }), { remove: "r", list: "l" });
    expect(await p.remove("/a")).toEqual({ status: "removed" });
  });

  it("fails when the backend acknowledges but the index is still listed", async () => {
    // The regression. `cleanup --apply` printed "removed" and the very next
    // `cleanup` listed the same repo as an orphan again, forever.
    const got = await providerFor(removeStub({ honest: false }), {
      remove: "r",
      list: "l",
    }).remove("/a");
    expect(got.status).toBe("failed");
    expect(got.detail).toMatch(/still lists/i);
  });

  it("is not fooled by a differently spelled path in the listing", async () => {
    // A trailing slash must not read as "some other project, so mine is gone".
    const got = await providerFor(removeStub({ honest: false, listAs: "/a/" }), {
      remove: "r",
      list: "l",
    }).remove("/a");
    expect(got.status).toBe("failed");
  });

  it("says it could not confirm when the backend cannot enumerate", async () => {
    // No list tool: the reply is all there is, and that is worth admitting
    // rather than dressing up as proof.
    const got = await providerFor(removeStub({ honest: true }), { remove: "r" }).remove("/a");
    expect(got.status).toBe("unverified");
    expect(got.detail).toMatch(/tools\.list/);
  });

  it("says it could not confirm when the listing itself fails", async () => {
    const got = await providerFor(
      stub(`function handle(msg) {
        if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
        if (msg.params?.name === "r")
          return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Removed" }] } });
        return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "nope" }] } });
      }`),
      { remove: "r", list: "l" },
    ).remove("/a");
    expect(got.status).toBe("unverified");
  });

  it("fails when the backend has no remove tool", async () => {
    const got = await providerFor(stub(TEXT("x")), {}).remove("/a");
    expect(got.status).toBe("failed");
    expect(got.detail).toMatch(/tools\.remove/);
  });

  it("fails with the backend's reason on a tool error rather than throwing", async () => {
    const got = await providerFor(
      stub(`function handle(msg) {
        if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
        if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such tool" } });
      }`),
      { remove: "r", list: "l" },
    ).remove("/a");
    expect(got.status).toBe("failed");
    expect(got.detail).toContain("no such tool");
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

  it("does not let a pathless record steal the previous project's details", () => {
    // A backend can list an index whose path it no longer knows. Its details
    // are not the previous project's — treating them as such reported the
    // wrong collection for a real repo in `list --all`.
    const got = parseProjectListing(
      [
        "  - /home/me/alpha",
        "    Collection: codebase_alpha",
        "    Files: 11",
        "  - (path unknown — indexed before path tracking)",
        "    Collection: codebase_7857c8abdc96",
        "    Code graph: not built",
        "  - /home/me/beta",
        "    Collection: codebase_beta",
      ].join("\n"),
    );
    expect(got.map((g) => [g.path, g.collection])).toEqual([
      ["/home/me/alpha", "codebase_alpha"],
      ["/home/me/beta", "codebase_beta"],
    ]);
    expect(got[0]?.files).toBe("11");
  });

  it("returns nothing for output with no paths", () => {
    expect(parseProjectListing("No projects have been indexed.")).toEqual([]);
  });

  it("ignores detail lines that appear before any project", () => {
    expect(parseProjectListing("  Files: 9\n  - /a\n")).toEqual([{ path: "/a" }]);
  });
});

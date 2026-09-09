/**
 * Verification and repair end to end, against an in-memory Qdrant.
 *
 * A stub rather than a mock: it stores points and payloads and answers scrolls
 * with real cursors, so the tests exercise paging, the metadata round-trip and
 * — the part that matters most — what a repair actually leaves behind. A mock
 * would happily confirm that we called the right method with the right
 * arguments while the data ended up wrong.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Qdrant } from "../src/qdrant.js";
import {
  metadataPointId,
  metadataProjects,
  repairCollection,
  verifyCollection,
} from "../src/verify.js";

const PREFIX = "v3_";
const META = `${PREFIX}socraticode_metadata`;
const COLL = `${PREFIX}codebase_demo`;

/** Points, as their `relativePath` — one entry per point, duplicates allowed. */
let chunks: Record<string, string[]>;
/** Metadata payloads by point id. */
let meta: Record<string, Record<string, unknown>>;
let writes: number;
let server: Server | undefined;
let q: Qdrant;
let dir: string;

/** Page size the stub serves, so paging can be forced. */
let pageLimit: number | undefined;

function scroll(values: Record<string, unknown>[], body: Record<string, unknown>) {
  const include = (body["with_payload"] as { include?: string[] } | undefined)?.include ?? [];
  const limit = pageLimit ?? (body["limit"] as number) ?? 1000;
  const from = (body["offset"] as number | undefined) ?? 0;
  const slice = values.slice(from, from + limit);
  const next = from + limit < values.length ? from + limit : null;
  return {
    result: {
      points: slice.map((payload, i) => ({
        id: from + i,
        payload: Object.fromEntries(
          Object.entries(payload).filter(([k]) => include.length === 0 || include.includes(k)),
        ),
      })),
      next_page_offset: next,
    },
  };
}

beforeEach(async () => {
  chunks = {};
  meta = {};
  writes = 0;
  pageLimit = undefined;
  dir = mkdtempSync(path.join(tmpdir(), "codeindex-verify-coll-"));

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const url = req.url ?? "";
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const name = decodeURIComponent(url.split("/")[2] ?? "");

      if (req.method === "GET") {
        if (name === META) return reply(200, { result: { status: "green", points_count: Object.keys(meta).length } });
        if (!(name in chunks)) return reply(404, { status: { error: "Not found" } });
        return reply(200, { result: { status: "green", points_count: chunks[name]?.length ?? 0 } });
      }
      if (url.includes("/points/payload")) {
        const id = (body["points"] as string[])[0] as string;
        writes++;
        meta[id] = { ...(meta[id] ?? {}), ...(body["payload"] as Record<string, unknown>) };
        return reply(200, { result: {} });
      }
      if (url.endsWith("/points/scroll")) {
        const values =
          name === META
            ? Object.values(meta)
            : (chunks[name] ?? []).map((p) => ({ relativePath: p }));
        return reply(200, scroll(values, body));
      }
      // retrieve
      const ids = body["ids"] as string[];
      const found = ids.filter((id) => id in meta).map((id) => ({ id, payload: meta[id] }));
      return reply(200, { result: found });
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  q = new Qdrant({ url: `http://127.0.0.1:${port}`, prefix: PREFIX });
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

/** Seed one project: files on disk, its hash map, and the points it produced. */
function seed(opts: {
  files: Record<string, string>;
  claimed: string[];
  points: string[];
  indexingStatus?: string;
  projectPath?: string;
}) {
  for (const [rel, content] of Object.entries(opts.files)) {
    writeFileSync(path.join(dir, rel), content);
  }
  chunks[COLL] = opts.points;
  meta[metadataPointId(COLL)] = {
    collectionName: COLL,
    projectPath: opts.projectPath ?? dir,
    lastIndexedAt: "2026-09-09T12:00:00.000Z",
    filesTotal: opts.claimed.length,
    filesIndexed: opts.claimed.length,
    fileHashes: JSON.stringify(Object.fromEntries(opts.claimed.map((f) => [f, "hash"]))),
    indexingStatus: opts.indexingStatus ?? "completed",
  };
}

describe("verifyCollection", () => {
  it("finds nothing wrong with an intact index", async () => {
    seed({
      files: { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" },
      claimed: ["a.ts", "b.ts"],
      points: ["a.ts", "a.ts", "b.ts"],
    });
    const r = await verifyCollection(q, COLL);
    expect(r.stranded).toEqual([]);
    expect(r.orphaned).toEqual([]);
    expect(r.claimed).toBe(2);
    expect(r.present).toBe(2);
    expect(r.points).toBe(3);
    expect(r.indexingStatus).toBe("completed");
  });

  /**
   * The signature both production bugs left behind: a hash recorded as current
   * for a file with no points, which no incremental run will ever revisit
   * because the hash already matches.
   */
  it("finds a file claimed as indexed that holds no chunks", async () => {
    seed({
      files: { "a.ts": "export const a = 1;\n", "lost.ts": "export const lost = 3;\n" },
      claimed: ["a.ts", "lost.ts"],
      points: ["a.ts"],
    });
    const r = await verifyCollection(q, COLL);
    expect(r.stranded).toEqual(["lost.ts"]);
    expect(r.blank).toEqual([]);
  });

  it("does not count a blank file as damage", async () => {
    seed({
      files: { "a.ts": "export const a = 1;\n", "__init__.py": "" },
      claimed: ["a.ts", "__init__.py"],
      points: ["a.ts"],
    });
    const r = await verifyCollection(q, COLL);
    expect(r.stranded).toEqual([]);
    expect(r.blank).toEqual(["__init__.py"]);
  });

  it("reports points the hash map does not mention", async () => {
    seed({
      files: { "a.ts": "export const a = 1;\n" },
      claimed: ["a.ts"],
      points: ["a.ts", "ghost.ts"],
    });
    expect((await verifyCollection(q, COLL)).orphaned).toEqual(["ghost.ts"]);
  });

  /**
   * Paging is where a wrong answer would be most convincing: every path the
   * scroll never reached looks like a destroyed file, and the report would
   * carry a confident count.
   */
  it("is unchanged when the listing spans several pages", async () => {
    seed({
      files: { "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" },
      claimed: ["a.ts", "b.ts", "c.ts"],
      points: ["a.ts", "b.ts", "c.ts"],
    });
    pageLimit = 1;
    const r = await verifyCollection(q, COLL);
    expect(r.pages).toBe(3);
    expect(r.present).toBe(3);
    expect(r.stranded).toEqual([]);
  });

  it("says so when there is no collection at all", async () => {
    const r = await verifyCollection(q, COLL);
    expect(r.missing).toBe("collection");
    expect(r.stranded).toEqual([]);
  });

  it("says so when points exist but nothing records what they should be", async () => {
    chunks[COLL] = ["a.ts"];
    const r = await verifyCollection(q, COLL);
    expect(r.missing).toBe("metadata");
    expect(r.points).toBe(1);
    // Nothing claimed anything, so nothing can be stranded — reporting the
    // whole index as destroyed here would be the worst possible answer.
    expect(r.stranded).toEqual([]);
  });

  it("classifies against the tree the caller names, not the one metadata remembers", async () => {
    seed({
      files: { "blank.ts": "" },
      claimed: ["blank.ts"],
      points: [],
      projectPath: "/gone/worktree",
    });
    // Metadata points at a tree that no longer exists — the drift a re-pointed
    // index leaves behind. Given the real checkout, the blank file is still
    // recognised as blank rather than reported as damage.
    expect((await verifyCollection(q, COLL, { projectPath: dir })).blank).toEqual(["blank.ts"]);
    expect((await verifyCollection(q, COLL)).stranded).toEqual(["blank.ts"]);
  });
});

describe("repairCollection", () => {
  it("removes exactly the stranded keys and leaves the rest untouched", async () => {
    seed({
      files: { "a.ts": "a\n", "lost.ts": "lost\n", "b.ts": "b\n" },
      claimed: ["a.ts", "lost.ts", "b.ts"],
      points: ["a.ts", "b.ts"],
    });
    const before = await verifyCollection(q, COLL);
    expect(before.stranded).toEqual(["lost.ts"]);

    const result = await repairCollection(q, COLL, before.stranded);
    expect(result.removed).toEqual(["lost.ts"]);
    expect(result.remaining).toBe(2);

    const payload = meta[metadataPointId(COLL)] as Record<string, unknown>;
    expect(JSON.parse(payload["fileHashes"] as string)).toEqual({ "a.ts": "hash", "b.ts": "hash" });
    // The backend's own invariant: filesIndexed is the size of the hash map.
    expect(payload["filesIndexed"]).toBe(2);
    // Not ours to invent — that is the walk count, and no walk happened here.
    expect(payload["filesTotal"]).toBe(3);
    expect(payload["projectPath"]).toBe(dir);

    // And the file is now genuinely missing from the index rather than
    // claimed-and-absent, so the next sync re-indexes it.
    const after = await verifyCollection(q, COLL);
    expect(after.stranded).toEqual([]);
    expect(after.claimed).toBe(2);
  });

  it("re-reads the hash map instead of writing back the one it was reported", async () => {
    seed({ files: { "a.ts": "a\n" }, claimed: ["a.ts", "lost.ts"], points: ["a.ts"] });
    const before = await verifyCollection(q, COLL);

    // An index run lands between the check and the repair. Writing back the
    // copy taken during the check would erase it.
    const id = metadataPointId(COLL);
    meta[id] = {
      ...(meta[id] as Record<string, unknown>),
      fileHashes: JSON.stringify({ "a.ts": "hash", "lost.ts": "hash", "new.ts": "hash" }),
    };

    await repairCollection(q, COLL, before.stranded);
    expect(JSON.parse((meta[id] as Record<string, unknown>)["fileHashes"] as string)).toEqual({
      "a.ts": "hash",
      "new.ts": "hash",
    });
  });

  it("writes nothing when there is nothing to remove", async () => {
    seed({ files: { "a.ts": "a\n" }, claimed: ["a.ts"], points: ["a.ts"] });
    const result = await repairCollection(q, COLL, []);
    expect(result.removed).toEqual([]);
    expect(writes).toBe(0);
  });

  it("refuses when nothing records what the index claims to hold", async () => {
    chunks[COLL] = ["a.ts"];
    await expect(repairCollection(q, COLL, ["a.ts"])).rejects.toThrow(/nothing to repair/);
  });
});

describe("metadataProjects", () => {
  it("lists code indexes and skips other metadata", async () => {
    seed({ files: { "a.ts": "a\n" }, claimed: ["a.ts"], points: ["a.ts"] });
    // A code graph's metadata lives in the same collection and has no hash map.
    meta["graph"] = { collectionName: `${PREFIX}codebase_demo`, graphEdges: 12 };
    // Another instance's collections are namespaced by a different prefix.
    meta["other"] = { collectionName: "v2_codebase_elsewhere", fileHashes: "{}" };

    expect(await metadataProjects(q)).toEqual([
      { collection: COLL, projectPath: dir, indexingStatus: "completed" },
    ]);
  });
});

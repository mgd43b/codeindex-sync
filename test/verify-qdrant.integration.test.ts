/**
 * The same checks, against a real Qdrant.
 *
 * The stub in `verify-collection.test.ts` pins the logic; this pins the
 * assumptions the logic rests on — that `next_page_offset` really is an opaque
 * point id rather than a number, that `set_payload` merges rather than
 * replaces, and that a 404 for an absent collection looks the way this code
 * expects. Those are the things a hand-written stub can only agree with itself
 * about.
 *
 * ## Never against a real index
 *
 * This talks to whatever `CODEINDEX_SYNC_QDRANT_TEST_URL` names, and it writes.
 * Two things keep that safe, and both are deliberate:
 *
 *  - **Loopback only.** A non-loopback URL fails the file outright rather than
 *    skipping quietly, because a silent skip is what makes someone re-run it
 *    with the "right" URL.
 *  - **Nothing is read from the environment.** The client is constructed from
 *    an explicit config, so an ambient QDRANT_URL — which a developer shell
 *    very often has, pointing at production — cannot be picked up by accident.
 *
 * Run it against a throwaway container, with the ambient values scrubbed:
 *
 *   docker run -d --rm -p 127.0.0.1:16433:6333 qdrant/qdrant
 *   env -u QDRANT_URL -u QDRANT_API_KEY -u QDRANT_COLLECTION_PREFIX \
 *     CODEINDEX_SYNC_QDRANT_TEST_URL=http://127.0.0.1:16433 \
 *     npx vitest run test/verify-qdrant.integration.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Qdrant } from "../src/qdrant.js";
import { metadataPointId, repairCollection, verifyCollection } from "../src/verify.js";

const TEST_URL = process.env["CODEINDEX_SYNC_QDRANT_TEST_URL"];
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

if (TEST_URL && !LOOPBACK.test(TEST_URL)) {
  throw new Error(
    `CODEINDEX_SYNC_QDRANT_TEST_URL must point at a throwaway loopback Qdrant, not ${TEST_URL}. ` +
      "This suite writes to the collections it touches.",
  );
}

// A per-run prefix, so a shared local Qdrant is never a shared namespace.
const PREFIX = `citest${Date.now().toString(36)}_`;
const COLL = `${PREFIX}codebase_demo`;
const META = `${PREFIX}socraticode_metadata`;

const q = new Qdrant({ url: (TEST_URL ?? "http://127.0.0.1:1").replace(/\/$/, ""), prefix: PREFIX });
let dir: string;

async function api(method: string, route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${TEST_URL?.replace(/\/$/, "")}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** One point per chunk, carrying only the payload key this tool reads. */
function chunk(id: number, relativePath: string) {
  return { id, vector: [0.1], payload: { relativePath, content: "…" } };
}

describe.skipIf(!TEST_URL)("verify against a live Qdrant", () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "codeindex-live-"));
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
    // Content on disk, nothing in the index: the damage both bugs left behind.
    writeFileSync(path.join(dir, "lost.ts"), "export const lost = 3;\n");
    // Blank on disk: claimed with no chunks, and correctly so.
    writeFileSync(path.join(dir, "blank.ts"), "");

    for (const name of [COLL, META]) {
      await api("PUT", `/collections/${name}`, { vectors: { size: 1, distance: "Dot" } });
    }
    await api("PUT", `/collections/${COLL}/points?wait=true`, {
      points: [chunk(1, "a.ts"), chunk(2, "a.ts"), chunk(3, "b.ts"), chunk(4, "ghost.ts")],
    });
    await api("PUT", `/collections/${META}/points?wait=true`, {
      points: [
        {
          id: metadataPointId(COLL),
          vector: [0],
          payload: {
            collectionName: COLL,
            projectPath: dir,
            filesTotal: 4,
            filesIndexed: 4,
            indexingStatus: "completed",
            fileHashes: JSON.stringify({
              "a.ts": "h1",
              "b.ts": "h2",
              "lost.ts": "h3",
              "blank.ts": "h4",
            }),
          },
        },
      ],
    });
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    if (!TEST_URL) return;
    for (const name of [COLL, META]) {
      await api("DELETE", `/collections/${name}`).catch(() => undefined);
    }
  });

  it("separates real damage from a file that correctly has no chunks", async () => {
    const r = await verifyCollection(q, COLL);
    expect(r.stranded).toEqual(["lost.ts"]);
    expect(r.blank).toEqual(["blank.ts"]);
    expect(r.orphaned).toEqual(["ghost.ts"]);
    expect(r.claimed).toBe(4);
    expect(r.present).toBe(3);
    expect(r.points).toBe(4);
    expect(r.health).toBe("green");
  });

  it("returns the same answer paged one point at a time", async () => {
    // Qdrant's real cursor is an opaque point id, not an index — the reason
    // this is passed back verbatim rather than being treated as a number.
    const r = await verifyCollection(q, COLL, { pageSize: 1 });
    expect(r.pages).toBeGreaterThan(1);
    expect(r.present).toBe(3);
    expect(r.stranded).toEqual(["lost.ts"]);
  });

  it("repairs exactly the stranded key and nothing else", async () => {
    const before = await verifyCollection(q, COLL);
    const result = await repairCollection(q, COLL, before.stranded);
    expect(result.removed).toEqual(["lost.ts"]);

    const payload = (await q.point(META, metadataPointId(COLL))) as Record<string, unknown>;
    expect(JSON.parse(payload["fileHashes"] as string)).toEqual({
      "a.ts": "h1",
      "b.ts": "h2",
      "blank.ts": "h4",
    });
    expect(payload["filesIndexed"]).toBe(3);
    // set_payload merges: every key the repair did not name is still there.
    expect(payload["filesTotal"]).toBe(4);
    expect(payload["projectPath"]).toBe(dir);
    expect(payload["indexingStatus"]).toBe("completed");

    const after = await verifyCollection(q, COLL);
    expect(after.stranded).toEqual([]);
    expect(after.claimed).toBe(3);
    // The chunks themselves were never touched.
    expect(after.points).toBe(4);
  });

  it("reports a collection that does not exist rather than failing", async () => {
    expect((await verifyCollection(q, `${PREFIX}codebase_absent`)).missing).toBe("collection");
  });
});

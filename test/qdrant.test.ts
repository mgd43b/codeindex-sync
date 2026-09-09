/**
 * The storage reads `verify` stands on, against a stub HTTP server.
 *
 * Pagination gets the most attention here, and it is not incidental: a scroll
 * that stops early returns a subset of the paths that actually have content,
 * and every unseen path then looks exactly like a destroyed file. The failure
 * mode of this module is not an error — it is a confident, wrong answer — so
 * the tests are built around multi-page listings rather than single-page ones.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Qdrant } from "../src/qdrant.js";

interface Call {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

async function stub(
  handler: (call: Call) => Reply,
): Promise<{ calls: Call[]; url: string }> {
  const calls: Call[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call: Call = {
        method: req.method ?? "",
        url: req.url ?? "",
        apiKey: req.headers["api-key"] as string | undefined,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      calls.push(call);
      const reply = handler(call);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { calls, url: `http://127.0.0.1:${port}` };
}

/** Pages of `relativePath` points, the shape Qdrant's scroll returns. */
function page(paths: string[], next: unknown): Reply {
  return {
    json: {
      result: {
        points: paths.map((p, i) => ({ id: i, payload: { relativePath: p } })),
        next_page_offset: next,
      },
    },
  };
}

describe("scroll pagination", () => {
  it("walks every page before answering", async () => {
    const pages: Reply[] = [
      page(["a.ts", "b.ts"], 2),
      page(["c.ts", "d.ts"], { last_id: 4 }),
      page(["e.ts"], null),
    ];
    let n = 0;
    const { url, calls } = await stub(() => pages[n++] as Reply);
    const q = new Qdrant({ url, prefix: "v3_" });

    const { values, pages: walked } = await q.distinct("v3_codebase_demo", "relativePath", 2);

    expect(walked).toBe(3);
    expect([...values].sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    // The cursor is passed back verbatim, whatever shape it has: Qdrant returns
    // an id for simple collections and an object for others, and coercing
    // either would restart the scroll from the top.
    expect(calls[0]?.body["offset"]).toBeUndefined();
    expect(calls[1]?.body["offset"]).toBe(2);
    expect(calls[2]?.body["offset"]).toEqual({ last_id: 4 });
  });

  it("asks for one payload key and no vectors", async () => {
    const { url, calls } = await stub(() => page(["a.ts"], null));
    await new Qdrant({ url, prefix: "" }).distinct("c", "relativePath", 500);

    expect(calls[0]?.url).toBe("/collections/c/points/scroll");
    expect(calls[0]?.body).toMatchObject({
      limit: 500,
      with_payload: { include: ["relativePath"] },
      with_vector: false,
    });
    // Faceting is the trap this avoids: it takes a limit, offers no cursor, and
    // truncates a repo-sized collection without saying so.
    expect(JSON.stringify(calls[0]?.body)).not.toContain("facet");
  });

  it("refuses to answer when the cursor stops advancing", async () => {
    // A server that repeats an offset would otherwise loop forever, and the
    // tempting fix — stop when the cursor repeats — silently returns a subset.
    const { url } = await stub(() => page(["a.ts"], 7));
    await expect(
      new Qdrant({ url, prefix: "" }).distinct("c", "relativePath", 1),
    ).rejects.toThrow(/repeated its cursor/);
  });

  it("ignores points whose payload lacks the key", async () => {
    const { url } = await stub(() => ({
      json: {
        result: {
          points: [{ id: 1, payload: {} }, { id: 2, payload: { relativePath: "a.ts" } }],
          next_page_offset: null,
        },
      },
    }));
    const { values } = await new Qdrant({ url, prefix: "" }).distinct("c", "relativePath");
    expect([...values]).toEqual(["a.ts"]);
  });
});

describe("collection and point reads", () => {
  it("reports status and point count", async () => {
    const { url } = await stub(() => ({ json: { result: { status: "green", points_count: 308 } } }));
    expect(await new Qdrant({ url, prefix: "" }).collection("c")).toEqual({
      status: "green",
      points: 308,
    });
  });

  it("treats a missing collection as an answer, not an error", async () => {
    const { url } = await stub(() => ({ status: 404, json: { status: { error: "Not found" } } }));
    const q = new Qdrant({ url, prefix: "" });
    expect(await q.collection("nope")).toBeNull();
    expect(await q.point("meta", "id")).toBeNull();
  });

  it("surfaces any other failure with its status", async () => {
    const { url } = await stub(() => ({ status: 500, text: "boom" }));
    await expect(new Qdrant({ url, prefix: "" }).collection("c")).rejects.toMatchObject({
      name: "QdrantError",
      status: 500,
    });
  });

  it("returns one point's payload", async () => {
    const { url, calls } = await stub(() => ({
      json: { result: [{ id: "x", payload: { fileHashes: "{}" } }] },
    }));
    expect(await new Qdrant({ url, prefix: "" }).point("meta", "x")).toEqual({ fileHashes: "{}" });
    expect(calls[0]?.body).toMatchObject({ ids: ["x"], with_payload: true, with_vector: false });
  });
});

describe("credentials", () => {
  it("sends the api key when one is configured, and nothing when not", async () => {
    const { url, calls } = await stub(() => ({ json: { result: { status: "green" } } }));
    await new Qdrant({ url, prefix: "", apiKey: "s3cret" }).collection("c");
    await new Qdrant({ url, prefix: "" }).collection("c");
    expect(calls[0]?.apiKey).toBe("s3cret");
    expect(calls[1]?.apiKey).toBeUndefined();
  });

  it("never puts the key in an error", async () => {
    // Errors are the one output that reliably ends up in a log or a bug report.
    const { url } = await stub(() => ({ status: 403, text: "forbidden" }));
    const err = await new Qdrant({ url, prefix: "", apiKey: "s3cret" })
      .collection("c")
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err?.message).toContain("403");
    expect(err?.message).not.toContain("s3cret");
  });
});

describe("setPayload", () => {
  it("merges into one point and waits for the write to land", async () => {
    // wait=true because the next thing anyone does is re-run verify, and an
    // eventually-consistent write makes a successful repair look like a failure.
    const { url, calls } = await stub(() => ({ json: { result: {} } }));
    await new Qdrant({ url, prefix: "" }).setPayload("meta", "pt", { fileHashes: "{}" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/collections/meta/points/payload?wait=true");
    expect(calls[0]?.body).toEqual({ payload: { fileHashes: "{}" }, points: ["pt"] });
  });
});

describe("scrollAll", () => {
  it("returns whole payloads across pages for the metadata listing", async () => {
    const pages: Reply[] = [
      { json: { result: { points: [{ payload: { collectionName: "v3_codebase_a" } }], next_page_offset: 1 } } },
      { json: { result: { points: [{ payload: { collectionName: "v3_codebase_b" } }], next_page_offset: null } } },
    ];
    let n = 0;
    const { url } = await stub(() => pages[n++] as Reply);
    const { payloads, pages: walked } = await new Qdrant({ url, prefix: "v3_" }).scrollAll(
      "v3_socraticode_metadata",
      ["collectionName"],
      1,
    );
    expect(walked).toBe(2);
    expect(payloads.map((p) => p["collectionName"])).toEqual(["v3_codebase_a", "v3_codebase_b"]);
  });
});

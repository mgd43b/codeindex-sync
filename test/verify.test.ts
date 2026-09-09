/**
 * The integrity check, as arithmetic.
 *
 * Everything here is deliberately free of a network: the comparison is the part
 * that decides whether a file is reported as destroyed, so it is pinned on its
 * own, and the blank-file classification is pinned hardest — it is the only
 * thing standing between this command and a wall of false findings on any repo
 * with empty `__init__.py` files in it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyStranded,
  codebaseCollection,
  compare,
  metadataPointId,
  parseFileHashes,
} from "../src/verify.js";
import { resolveQdrantConfig } from "../src/qdrant.js";

describe("collection addressing", () => {
  it("names a collection the way the backend does", () => {
    expect(codebaseCollection("v3_", "codeindex-sync")).toBe("v3_codebase_codeindex-sync");
    expect(codebaseCollection("", "demo")).toBe("codebase_demo");
  });

  /**
   * Golden values, not a re-derivation: computing the id the same way in the
   * test would only prove this file agrees with itself. These come from the
   * backend's own formula (first 32 hex of SHA-256, formatted as a UUID), so a
   * change to ours shows up as a failure rather than as an empty verification.
   */
  it("derives the metadata point id the backend uses", () => {
    expect(metadataPointId("v3_codebase_codeindex-sync")).toBe(
      "987b653e-1f6c-43d7-41d2-989d7235ed59",
    );
    expect(metadataPointId("codebase_demo")).toBe("ec21331c-46e0-4fc4-5076-deb14667811b");
  });
});

describe("parseFileHashes", () => {
  it("reads the JSON string the backend stores", () => {
    const m = parseFileHashes({ fileHashes: JSON.stringify({ "a.ts": "h1", "b.ts": "h2" }) });
    expect([...(m?.keys() ?? [])]).toEqual(["a.ts", "b.ts"]);
  });

  it("reads a plain object too, since the storage shape is not ours to depend on", () => {
    expect(parseFileHashes({ fileHashes: { "a.ts": "h1" } })?.get("a.ts")).toBe("h1");
  });

  it("returns null rather than an empty map when there is nothing to read", () => {
    // The difference matters: an empty map means "claims nothing", which is a
    // finding; null means "cannot tell", which must not be reported as one.
    expect(parseFileHashes(null)).toBeNull();
    expect(parseFileHashes({})).toBeNull();
    expect(parseFileHashes({ fileHashes: "{not json" })).toBeNull();
    expect(parseFileHashes({ fileHashes: ["a.ts"] })).toBeNull();
  });

  it("reads an empty map as claiming nothing", () => {
    expect(parseFileHashes({ fileHashes: "{}" })?.size).toBe(0);
  });
});

describe("compare", () => {
  it("finds files claimed as indexed that hold no chunks", () => {
    const { stranded, orphaned } = compare(["a.ts", "b.ts", "c.ts"], ["a.ts", "c.ts"]);
    expect(stranded).toEqual(["b.ts"]);
    expect(orphaned).toEqual([]);
  });

  it("finds points the hash map does not mention", () => {
    const { stranded, orphaned } = compare(["a.ts"], ["a.ts", "gone.ts"]);
    expect(stranded).toEqual([]);
    expect(orphaned).toEqual(["gone.ts"]);
  });

  it("is empty for an intact index", () => {
    expect(compare(["a.ts", "b.ts"], ["b.ts", "a.ts"])).toEqual({ stranded: [], orphaned: [] });
  });

  it("sorts, so two runs of the same damage read the same", () => {
    const { stranded } = compare(["z.ts", "a.ts", "m.ts"], []);
    expect(stranded).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("classifyStranded", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "codeindex-verify-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * The false-positive class this exists for. The backend records a hash for
   * every file it reads and emits no chunk for one with no non-whitespace
   * content, so blank files are *supposed* to be claimed-with-no-chunks.
   * Reporting them would put a finding in front of the user that repairing
   * cannot clear — re-indexing puts it straight back.
   */
  it("treats an empty file as correct, not as damage", () => {
    writeFileSync(path.join(dir, "__init__.py"), "");
    expect(classifyStranded(dir, ["__init__.py"])).toEqual({
      stranded: [],
      blank: ["__init__.py"],
    });
  });

  it("treats a whitespace-only file the same way", () => {
    writeFileSync(path.join(dir, "blank.ts"), "\n\n   \t\n");
    expect(classifyStranded(dir, ["blank.ts"]).blank).toEqual(["blank.ts"]);
  });

  it("reports a file that has content but no chunks", () => {
    writeFileSync(path.join(dir, "real.ts"), "export const x = 1;\n");
    expect(classifyStranded(dir, ["real.ts"])).toEqual({ stranded: ["real.ts"], blank: [] });
  });

  it("reports a hash for a file that is no longer there", () => {
    // A stale entry for a deleted file is exactly what suppresses re-indexing,
    // so it belongs in the repaired set rather than being excused as absent.
    expect(classifyStranded(dir, ["deleted.ts"]).stranded).toEqual(["deleted.ts"]);
  });

  it("reports a directory that shadows a claimed path", () => {
    mkdirSync(path.join(dir, "weird"));
    expect(classifyStranded(dir, ["weird"]).stranded).toEqual(["weird"]);
  });

  /**
   * The hash map is not this tool's own data: it comes out of a store anything
   * with the API key can write. A key that climbs out of the repository must
   * not turn into a stat and a read of some unrelated file.
   */
  it("refuses a path that climbs out of the project, and calls it damaged", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "codeindex-outside-"));
    try {
      // Blank on disk: if this were read, it would be excused as a blank file.
      // Seeing it reported as stranded is the evidence it was never opened.
      writeFileSync(path.join(outside, "secret"), "");
      const escape = path.relative(dir, path.join(outside, "secret"));
      expect(classifyStranded(dir, [escape])).toEqual({ stranded: [escape], blank: [] });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("contains an absolute-looking key inside the project", () => {
    // path.join treats it as relative, so it lands under the repo and simply
    // does not exist — damaged, and nothing outside was touched.
    expect(classifyStranded(dir, ["/etc/passwd"]).stranded).toEqual(["/etc/passwd"]);
  });

  it("keeps everything when there is no tree to check against", () => {
    expect(classifyStranded(undefined, ["a.ts", "b.ts"])).toEqual({
      stranded: ["a.ts", "b.ts"],
      blank: [],
    });
  });
});

describe("resolveQdrantConfig", () => {
  /**
   * The provider block wins because it is the environment the indexer is
   * actually spawned with — git hooks never see a shell profile. Checking the
   * store an exported variable happens to name would report an unrelated,
   * empty index as total destruction.
   */
  it("prefers the provider block over the ambient environment", () => {
    const cfg = resolveQdrantConfig(
      { QDRANT_URL: "http://config:6333", QDRANT_COLLECTION_PREFIX: "v3_" },
      { QDRANT_URL: "http://shell:6333", QDRANT_API_KEY: "from-shell" },
    );
    expect(cfg?.url).toBe("http://config:6333");
    expect(cfg?.prefix).toBe("v3_");
    // Per-variable fallback: the block set no key, so the ambient one stands.
    expect(cfg?.apiKey).toBe("from-shell");
  });

  it("falls back to the ambient environment entirely", () => {
    expect(resolveQdrantConfig(undefined, { QDRANT_URL: "http://shell:6333/" })).toEqual({
      url: "http://shell:6333",
      prefix: "",
    });
  });

  /**
   * Not trimmed, and not tidied: the backend prepends this to a collection name
   * verbatim and rejects the same character set at startup. Quietly accepting a
   * prefix it would refuse produces a collection name that cannot exist, and
   * the whole index then reads as missing.
   */
  it("rejects a prefix the backend itself would refuse", () => {
    expect(() => resolveQdrantConfig({ QDRANT_URL: "http://q:6333", QDRANT_COLLECTION_PREFIX: "v3_ " }, {})).toThrow(
      /QDRANT_COLLECTION_PREFIX/,
    );
    expect(() => resolveQdrantConfig({ QDRANT_URL: "http://q:6333", QDRANT_COLLECTION_PREFIX: "a/b" }, {})).toThrow();
  });

  it("accepts an absent prefix and a valid one", () => {
    expect(resolveQdrantConfig({ QDRANT_URL: "http://q:6333" }, {})?.prefix).toBe("");
    expect(
      resolveQdrantConfig({ QDRANT_URL: "http://q:6333", QDRANT_COLLECTION_PREFIX: "v3_" }, {})?.prefix,
    ).toBe("v3_");
  });

  it("has no opinion when no URL is configured anywhere", () => {
    expect(resolveQdrantConfig({}, {})).toBeNull();
  });
});

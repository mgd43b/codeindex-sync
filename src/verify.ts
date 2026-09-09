/**
 * Index integrity: what the index *claims* to hold, against what it actually holds.
 *
 * Two separate backend bugs destroyed parts of real indexes without either the
 * indexer or this tool noticing, because both reported success and search
 * simply got quietly worse:
 *
 *  1. A partial upsert recorded as a success. Some points never landed, the
 *     file's content hash was written as current anyway, and no later
 *     incremental ever revisits a file whose hash already matches. The file is
 *     gone from search permanently.
 *  2. An interrupted update. Old chunks are deleted first, the run dies before
 *     the pruned hash map is written, and the surviving stale hash suppresses
 *     re-indexing forever.
 *
 * Different causes, one signature in storage: a file the hash map claims is
 * indexed, with no points to its name. That set should always be empty, and
 * asking is two reads.
 *
 * ## Why this does not walk the repository
 *
 * The obvious check — "which files *should* be indexed?" — would mean
 * reimplementing the backend's discovery rules: .gitignore, nested ignores,
 * its own ignore file, language and size filters, environment-directory
 * heuristics. Any drift between the two implementations shows up as files
 * reported missing that were never meant to be there, and a check that cries
 * wolf gets ignored, which costs more than not having it. Claimed-versus-stored
 * needs no walk and cannot drift: both sides come from the index itself.
 *
 * The one place the working tree is consulted is to tell real damage from a
 * file that correctly has no chunks — see `classifyStranded`.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Qdrant } from "./qdrant.js";

/** Collection holding one project's chunks. */
export function codebaseCollection(prefix: string, projectId: string): string {
  return `${prefix}codebase_${projectId}`;
}

/**
 * The metadata point's id, derived from the collection name exactly as the
 * backend derives it: the first 32 hex characters of its SHA-256, formatted as
 * a UUID. Reproduced rather than looked up because the point has to be
 * addressable before anything about it is known.
 */
export function metadataPointId(collection: string): string {
  const h = createHash("sha256").update(collection).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * File hashes off a metadata payload, as a map.
 *
 * Stored as a JSON *string* rather than a nested object, so this parses one.
 * An object is accepted too: the storage shape is not ours to depend on, and
 * reading both costs three lines.
 */
export function parseFileHashes(payload: Record<string, unknown> | null): Map<string, string> | null {
  const raw = payload?.["fileHashes"];
  if (raw === undefined || raw === null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  return new Map(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );
}

/** The whole check, as set arithmetic. Pure, so it can be tested on its own. */
export function compare(
  claimed: Iterable<string>,
  present: Iterable<string>,
): { stranded: string[]; orphaned: string[] } {
  const c = new Set(claimed);
  const p = new Set(present);
  const stranded = [...c].filter((f) => !p.has(f)).sort();
  const orphaned = [...p].filter((f) => !c.has(f)).sort();
  return { stranded, orphaned };
}

/** How much of a file to read before concluding it cannot be blank. */
const BLANK_SCAN_LIMIT = 1024 * 1024;

/**
 * Split "claimed but no points" into damage and correct behaviour.
 *
 * A zero-byte or whitespace-only file is *supposed* to end up here: the backend
 * records its hash and emits no chunk, because a chunk with no non-whitespace
 * content is worse than no chunk. Empty `__init__.py` files alone would put
 * dozens of them in front of anyone running this on a Python repo, and a
 * finding that is usually wrong is a finding people learn to skip past.
 *
 * Repairing one would also never converge: drop its hash, re-index it, and it
 * lands right back here. So they are counted and named, not flagged.
 *
 * This reads only paths the index itself named — it is not a tree walk, and it
 * infers nothing about which files ought to be indexed. Anything unreadable or
 * absent stays in the damaged set: a hash for a file that is no longer there is
 * exactly the stale entry that suppresses re-indexing.
 */
export function classifyStranded(
  projectPath: string | undefined,
  paths: string[],
): { stranded: string[]; blank: string[] } {
  if (!projectPath) return { stranded: paths, blank: [] };
  const stranded: string[] = [];
  const blank: string[] = [];
  for (const rel of paths) {
    const abs = path.join(projectPath, rel);
    let isBlank: boolean;
    try {
      const size = statSync(abs).size;
      isBlank =
        size === 0 ||
        (size <= BLANK_SCAN_LIMIT && readFileSync(abs, "utf8").trim().length === 0);
    } catch {
      isBlank = false;
    }
    (isBlank ? blank : stranded).push(rel);
  }
  return { stranded, blank };
}

export interface VerifyReport {
  collection: string;
  /** The tree the index says it describes, per its own metadata. */
  projectPath?: string;
  /** "in-progress" while a run is under way; repair refuses to touch those. */
  indexingStatus?: string;
  lastIndexedAt?: string;
  /** Qdrant's own word for the collection: green, yellow, red. */
  health?: string;
  points: number;
  claimed: number;
  present: number;
  /** Claimed as indexed, no points. The finding both bug classes land in. */
  stranded: string[];
  /** Claimed, no points, and correctly so — blank files. */
  blank: string[];
  /** Points whose path the hash map does not mention. */
  orphaned: string[];
  /** Pages walked; a partial scroll would make every number here a lie. */
  pages: number;
  /** Nothing to compare against: no collection, or no metadata point. */
  missing?: "collection" | "metadata";
}

export interface VerifyOptions {
  /**
   * Tree to classify stranded paths against. Defaults to the metadata's own
   * `projectPath`; passing one matters when that has drifted to a worktree.
   */
  projectPath?: string;
  pageSize?: number;
}

/** Read both sides of the comparison and report. Never mutates anything. */
export async function verifyCollection(
  q: Qdrant,
  collection: string,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const info = await q.collection(collection);
  if (!info) {
    return {
      collection,
      points: 0,
      claimed: 0,
      present: 0,
      stranded: [],
      blank: [],
      orphaned: [],
      pages: 0,
      missing: "collection",
    };
  }

  const meta = await q.point(q.metadataCollection, metadataPointId(collection));
  const hashes = parseFileHashes(meta);
  const projectPath =
    opts.projectPath ?? (typeof meta?.["projectPath"] === "string" ? meta["projectPath"] : undefined);
  const base: VerifyReport = {
    collection,
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(typeof meta?.["indexingStatus"] === "string"
      ? { indexingStatus: meta["indexingStatus"] }
      : {}),
    ...(typeof meta?.["lastIndexedAt"] === "string"
      ? { lastIndexedAt: meta["lastIndexedAt"] }
      : {}),
    health: info.status,
    points: info.points,
    claimed: hashes?.size ?? 0,
    present: 0,
    stranded: [],
    blank: [],
    orphaned: [],
    pages: 0,
  };

  if (!hashes) return { ...base, missing: "metadata" };

  const { values, pages } = await q.distinct(collection, "relativePath", opts.pageSize);
  const { stranded, orphaned } = compare(hashes.keys(), values);
  const split = classifyStranded(projectPath, stranded);
  return {
    ...base,
    present: values.size,
    stranded: split.stranded,
    blank: split.blank,
    orphaned,
    pages,
  };
}

export interface RepairResult {
  removed: string[];
  /** Keys left in the hash map afterwards. */
  remaining: number;
}

/**
 * Drop the stranded keys from the hash map, so the next sync re-indexes exactly
 * those files and nothing else.
 *
 * This is the same correction the backend now makes at index time; doing it
 * here reaches indexes that were damaged before that fix existed, which no
 * amount of re-indexing repairs on its own — that is the whole problem with a
 * stale hash.
 *
 * Only the hash map and the count derived from it are written. `filesTotal` is
 * the backend's own walk count and is not ours to invent; leaving `filesIndexed`
 * stale would break the backend's invariant that it equals the map's size.
 */
export async function repairCollection(
  q: Qdrant,
  collection: string,
  stranded: string[],
): Promise<RepairResult> {
  const id = metadataPointId(collection);
  // Re-read rather than trusting the report: the map may have moved on since,
  // and writing back a stale copy would undo indexing that happened in between.
  const meta = await q.point(q.metadataCollection, id);
  const hashes = parseFileHashes(meta);
  if (!hashes) {
    throw new Error(`no metadata point for ${collection}; nothing to repair`);
  }
  const removed: string[] = [];
  for (const key of stranded) {
    if (hashes.delete(key)) removed.push(key);
  }
  if (removed.length > 0) {
    const payload: Record<string, unknown> = {
      fileHashes: JSON.stringify(Object.fromEntries(hashes)),
    };
    if (typeof meta?.["filesIndexed"] === "number") payload["filesIndexed"] = hashes.size;
    await q.setPayload(q.metadataCollection, id, payload);
  }
  return { removed, remaining: hashes.size };
}

/** One project the backend's metadata knows about. */
export interface MetadataProject {
  collection: string;
  projectPath?: string;
  indexingStatus?: string;
}

/**
 * Every code index this Qdrant holds, read from the backend's own metadata.
 *
 * Deliberately not the provider's `list` tool: that means spawning the backend
 * and waiting on it, and the metadata collection is both the authority and one
 * request away. Entries without a hash map are other kinds of metadata — code
 * graphs, context artifacts — and are not code indexes.
 */
export async function metadataProjects(q: Qdrant): Promise<MetadataProject[]> {
  const { payloads } = await q.scrollAll(q.metadataCollection, [
    "collectionName",
    "projectPath",
    "indexingStatus",
    "fileHashes",
  ]);
  const out: MetadataProject[] = [];
  for (const p of payloads) {
    const name = p["collectionName"];
    if (typeof name !== "string" || !name.startsWith(`${q.prefix}codebase_`)) continue;
    if (p["fileHashes"] === undefined || p["fileHashes"] === null) continue;
    out.push({
      collection: name,
      ...(typeof p["projectPath"] === "string" ? { projectPath: p["projectPath"] } : {}),
      ...(typeof p["indexingStatus"] === "string"
        ? { indexingStatus: p["indexingStatus"] }
        : {}),
    });
  }
  return out.sort((a, b) => a.collection.localeCompare(b.collection));
}

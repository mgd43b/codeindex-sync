/**
 * Generic MCP-backed index provider.
 *
 * This is the reason adding a backend is config rather than code: any MCP
 * server exposing index/update/status tools can be driven by describing it —
 * how to spawn it, what its tools are called, and how to read its replies.
 *
 * Nothing here names a specific product. A concrete backend is a config entry;
 * see `presets.ts` for ready-made ones.
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { withMcp, type McpToolResult } from "../mcp.js";
import type {
  IndexOutcome,
  IndexProvider,
  IndexRequest,
  IndexedProject,
  ProviderHealth,
  RemoveOutcome,
  RepoStatus,
} from "../provider.js";

export interface McpProviderConfig {
  name: string;
  description?: string;
  /** Executable to spawn, e.g. "npx". */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Tool names on the server. Only `update` is strictly required. */
  tools: {
    update: string;
    index?: string;
    status?: string;
    health?: string;
    /** Enumerate every index the backend holds; enables `list --all`/`cleanup`. */
    list?: string;
    /** Drop one index; enables `cleanup --apply`. */
    remove?: string;
  };
  /** Argument name carrying the repo path (servers differ). */
  repoArg?: string;
  /**
   * Files whose presence means "this repo belongs to me" — e.g. a marker file
   * the backend writes. Empty means "claim any git repo", which is fine when
   * only one provider is configured.
   */
  detectFiles?: string[];
  timeoutMs?: number;
  /**
   * Substrings marking a "busy" reply rather than a failure: the backend holds
   * its own per-project lock and another indexer has it. Busy is not an error —
   * the job should be requeued, not counted as a failed attempt.
   */
  busyMarkers?: string[];
}

/**
 * A directory that definitely exists, preferring `wanted`.
 *
 * Spawning with a cwd that has been deleted fails during interpreter startup
 * with an opaque `uv_cwd ENOENT`, long before the backend gets a chance to
 * report anything useful. Deleted directories are routine here: throwaway
 * worktrees, and `cleanup`, whose entire input is paths that no longer exist.
 */
/**
 * Parse a backend's project listing.
 *
 * Deliberately shape-driven rather than backend-specific: a line that is just a
 * path starts a record, and the indented `Key: value` lines beneath it become
 * its details. Backends that print more keys, or none, still work — unknown
 * keys are ignored rather than causing a parse failure, so a backend adding a
 * field never breaks this.
 *
 * Counts are kept verbatim. A partial index reports "3437/2798", and turning
 * that into a number would silently claim more files than were indexed.
 */
export function parseProjectListing(text: string): IndexedProject[] {
  const out: IndexedProject[] = [];
  let current: IndexedProject | undefined;

  for (const raw of text.split("\n")) {
    const pathLine = /^\s*(?:[-*\u2022]\s*)?(\/.*\S)\s*$/.exec(raw);
    if (pathLine?.[1]) {
      current = { path: pathLine[1] };
      out.push(current);
      continue;
    }
    if (!current) continue;

    const kv = /^\s+([A-Za-z][A-Za-z ]*?)\s*:\s*(.+?)\s*$/.exec(raw);
    if (!kv) continue;
    const key = kv[1]!.trim().toLowerCase();
    const value = kv[2]!.trim();

    if (key === "collection") current.collection = value;
    else if (key === "files") {
      // e.g. "39", or "3437/2798 (INCOMPLETE — run codebase_index to resume)"
      const count = /^([\d,]+(?:\/[\d,]+)?)/.exec(value);
      if (count?.[1]) current.files = count[1];
      if (/incomplete/i.test(value)) current.incomplete = true;
    } else if (key === "last indexed" || key === "indexed at" || key === "updated") {
      current.lastIndexedAt = value;
    }
  }

  // Deduplicate on path, keeping the first record for each.
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
}

function safeCwd(wanted?: string): string {
  const candidates = [wanted, process.cwd(), homedir(), tmpdir()].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // Unreadable: try the next one.
    }
  }
  return tmpdir();
}

/**
 * Are these the same index, as far as the backend's listing goes?
 *
 * Compared after normalisation because the path we were handed and the one the
 * backend prints have travelled different routes — a trailing slash or an
 * unresolved `..` would otherwise read as a different project and turn a real
 * removal into a reported failure. Deliberately not resolved through the
 * filesystem: these paths are deleted by definition, so there is nothing for
 * `realpath` to work with.
 */
function samePath(a: string, b: string): boolean {
  return path.normalize(a).replace(/\/+$/, "") === path.normalize(b).replace(/\/+$/, "");
}

const DEFAULT_BUSY_MARKERS = ["another indexer", "already in progress", "locked by", "BUSY"];

/** Pull "Added: 3" style counters out of a human-readable summary. */
function extractNumber(text: string, ...labels: string[]): number | undefined {
  for (const label of labels) {
    const m = new RegExp(`${label}\\s*[:=]\\s*(\\d+)`, "i").exec(text);
    if (m?.[1]) return Number.parseInt(m[1], 10);
  }
  return undefined;
}

/** Collapse multi-line tool output to one informative line. */
function firstMeaningfulLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /[:=]\s*\d|complete|updated|indexed/i.test(l)) ?? lines[0] ?? "";
}

export class McpIndexProvider implements IndexProvider {
  readonly name: string;
  readonly description: string;

  constructor(private readonly cfg: McpProviderConfig) {
    this.name = cfg.name;
    this.description = cfg.description ?? `MCP backend via \`${cfg.command} ${cfg.args.join(" ")}\``;
  }

  async detect(repoPath: string): Promise<boolean> {
    const markers = this.cfg.detectFiles ?? [];
    if (markers.length === 0) return true;
    return markers.some((f) => existsSync(path.join(repoPath, f)));
  }

  private repoArgs(repoPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { [this.cfg.repoArg ?? "projectPath"]: repoPath, ...extra };
  }

  private isBusy(text: string): boolean {
    const markers = this.cfg.busyMarkers ?? DEFAULT_BUSY_MARKERS;
    return markers.some((m) => text.toLowerCase().includes(m.toLowerCase()));
  }

  private async call(
    repoPath: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    return withMcp(
      {
        command: this.cfg.command,
        args: this.cfg.args,
        // Prefer the repo: inheriting a hook's cwd is how the runtime ends up
        // starting in a deleted worktree and dying before the backend loads.
        // But the repo is not always there — `cleanup` acts on paths that are
        // gone by definition — so fall back to somewhere that exists rather
        // than spawning into ENOENT.
        cwd: safeCwd(repoPath),
        env: { ...process.env, ...this.cfg.env },
        ...(this.cfg.timeoutMs === undefined ? {} : { timeoutMs: this.cfg.timeoutMs }),
      },
      (s) => s.callTool(tool, args),
    );
  }

  async index(req: IndexRequest): Promise<IndexOutcome> {
    const tool = req.full ? (this.cfg.tools.index ?? this.cfg.tools.update) : this.cfg.tools.update;
    let res: McpToolResult;
    try {
      res = await this.call(req.repoPath, tool, this.repoArgs(req.repoPath));
    } catch (err) {
      return {
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (this.isBusy(res.text)) {
      return { status: "busy", summary: firstMeaningfulLine(res.text) };
    }
    if (res.isError) {
      return { status: "failed", summary: "", error: firstMeaningfulLine(res.text) || res.text };
    }

    const outcome: IndexOutcome = { status: "ok", summary: firstMeaningfulLine(res.text) };
    const files = extractNumber(res.text, "Files", "filesIndexed");
    const chunks = extractNumber(res.text, "New chunks", "Chunks", "Indexed chunks");
    if (files !== undefined) outcome.filesIndexed = files;
    if (chunks !== undefined) outcome.chunks = chunks;
    return outcome;
  }

  async status(repoPath: string): Promise<RepoStatus | null> {
    const tool = this.cfg.tools.status;
    if (!tool) return null;
    try {
      const res = await this.call(repoPath, tool, this.repoArgs(repoPath));
      if (res.isError) return null;
      const status: RepoStatus = {
        indexed: /indexed|chunks/i.test(res.text),
        incomplete: /incomplete/i.test(res.text),
      };
      const files = extractNumber(res.text, "Files", "filesIndexed");
      const chunks = extractNumber(res.text, "Chunks", "Indexed chunks");
      if (files !== undefined) status.files = files;
      if (chunks !== undefined) status.chunks = chunks;
      return status;
    } catch {
      return null;
    }
  }

  /**
   * Every project this backend holds an index for.
   *
   * Parsing is deliberately generic: any "list projects" tool prints paths, so
   * lines that are *just* a path (optionally bulleted) are taken and everything
   * else ignored. That tolerates differing formats without teaching this class
   * about any particular backend. A path containing a newline would be missed;
   * no filesystem in practice has one.
   */
  async projects(): Promise<IndexedProject[] | null> {
    const tool = this.cfg.tools.list;
    if (!tool) return null;
    try {
      const res = await withMcp(
        {
          command: this.cfg.command,
          args: this.cfg.args,
          cwd: safeCwd(),
          env: { ...process.env, ...this.cfg.env },
          timeoutMs: this.cfg.timeoutMs ?? 30_000,
        },
        (s) => s.callTool(tool, {}),
      );
      if (res.isError) return null;
      return parseProjectListing(res.text);
    } catch {
      return null;
    }
  }

  /**
   * Drop one index, then check the backend's own listing to see whether it
   * actually went.
   *
   * The reply cannot be trusted here, and the reason is structural rather than
   * a quirk of any one backend. `cleanup`'s entire input is paths whose
   * directory is gone, and a backend that identifies an index by something
   * stored *inside* the repository cannot resolve it once that is deleted — so
   * it removes nothing, finds nothing to complain about, and answers without an
   * error. Believing that is how `cleanup --apply` printed "removed" while the
   * index stayed put, forever re-listing as an orphan.
   *
   * Unlike an async index call, verification does not need to share a session:
   * a project listing is durable backend state rather than per-process
   * progress, so asking again in a fresh child is not merely adequate but
   * stricter — it proves the removal is visible to the *next* process, which is
   * exactly what the next `cleanup` run will be.
   */
  async remove(repoPath: string): Promise<RemoveOutcome> {
    const tool = this.cfg.tools.remove;
    if (!tool) {
      return { status: "failed", detail: "no `tools.remove` configured for this provider" };
    }

    let res: McpToolResult;
    try {
      res = await this.call(repoPath, tool, this.repoArgs(repoPath));
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (res.isError) {
      return { status: "failed", detail: firstMeaningfulLine(res.text) || res.text };
    }

    // No way to look: say so rather than passing the reply off as proof.
    if (!this.cfg.tools.list) {
      return {
        status: "unverified",
        detail: `${tool} reported success; no \`tools.list\` configured to confirm it`,
      };
    }
    const after = await this.projects();
    if (after === null) {
      return {
        status: "unverified",
        detail: `${tool} reported success, but ${this.cfg.tools.list} could not be read to confirm it`,
      };
    }
    if (after.some((p) => samePath(p.path, repoPath))) {
      return {
        status: "failed",
        detail: `${tool} reported success but the backend still lists this index`,
      };
    }
    return { status: "removed" };
  }

  async health(): Promise<ProviderHealth[]> {
    // Reachability is the only backend-agnostic health signal: can we spawn it
    // and complete a handshake? Anything more specific belongs to the backend.
    const probeDir = process.cwd();
    try {
      const res = await withMcp(
        {
          command: this.cfg.command,
          args: this.cfg.args,
          cwd: safeCwd(probeDir),
          env: { ...process.env, ...this.cfg.env },
          timeoutMs: this.cfg.timeoutMs ?? 30_000,
        },
        async (s) => {
          const tool = this.cfg.tools.health ?? this.cfg.tools.status;
          if (!tool) return { isError: false, text: "handshake ok" };
          return s.callTool(tool, {});
        },
      );
      return [
        {
          ok: !res.isError,
          component: this.name,
          detail: res.isError ? res.text : "reachable",
          ...(res.isError
            ? { remedy: `check that \`${this.cfg.command} ${this.cfg.args.join(" ")}\` runs` }
            : {}),
        },
      ];
    } catch (err) {
      return [
        {
          ok: false,
          component: this.name,
          detail: err instanceof Error ? err.message : String(err),
          remedy: `check that \`${this.cfg.command} ${this.cfg.args.join(" ")}\` is installed and runnable`,
        },
      ];
    }
  }
}

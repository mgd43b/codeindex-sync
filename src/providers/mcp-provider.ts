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
  ProviderHealth,
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
  async projects(): Promise<string[] | null> {
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
      const out: string[] = [];
      for (const line of res.text.split("\n")) {
        const m = /^\s*(?:[-*\u2022]\s*)?(\/.*\S)\s*$/.exec(line);
        if (m?.[1]) out.push(m[1]);
      }
      return [...new Set(out)];
    } catch {
      return null;
    }
  }

  /** Drop one index. Returns false when the backend cannot do this. */
  async remove(repoPath: string): Promise<boolean> {
    const tool = this.cfg.tools.remove;
    if (!tool) return false;
    try {
      const res = await this.call(repoPath, tool, this.repoArgs(repoPath));
      return !res.isError;
    } catch {
      return false;
    }
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

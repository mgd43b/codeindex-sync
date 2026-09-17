/**
 * Configuration.
 *
 * Adding a backend must be a config edit, never a code change — that is the
 * core promise of this tool. A provider entry describes how to spawn an MCP
 * server and what its tools are called; nothing else is required.
 *
 * Two hard-won rules shape the loading order:
 *
 *  1. Git hooks are NOT a login shell. They never source ~/.bashrc, ~/.zshenv
 *     or similar, so anything exported in a shell profile is invisible to the
 *     indexer. Config must therefore live in a file the hook path reads
 *     directly, and that file is the source of truth for where indexing writes.
 *
 *  2. Editors and agent tools inject their own environment into subprocesses.
 *     An inherited stale value silently wins over the config file unless the
 *     precedence is explicit — which is why env vars are applied only where
 *     documented, rather than blanket-overriding everything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_EXCLUDE_PATHS, patternSegments, unsupportedGlobSegments } from "./exclude.js";
import type { McpProviderConfig } from "./providers/mcp-provider.js";

export interface Config {
  /** Only repos under this root are ever enqueued. */
  root: string;
  /**
   * Path patterns that are never project roots — agent-tool worktrees, above
   * all. Configurable because every tool picks its own directory and more keep
   * appearing; see `exclude.ts` for the matching rules.
   */
  excludePaths: string[];
  /** Ordered: the first provider claiming a repo wins, so order is meaningful. */
  providers: McpProviderConfig[];
  /**
   * Attempts, the first included, before a job is parked in failed/. Every
   * command that runs a job — `sync`, `once`, `drain` — makes them in-process.
   */
  maxAttempts: number;
  /** Seconds before the first retry; each later retry waits twice as long. */
  backoffSeconds: number;
  /** Rotate the worker log past this size. */
  logMaxBytes: number;
}

export const DEFAULT_CONFIG: Config = {
  root: path.join(homedir(), "workspace"),
  excludePaths: [...DEFAULT_EXCLUDE_PATHS],
  providers: [],
  maxAttempts: 3,
  backoffSeconds: 10,
  logMaxBytes: 2 * 1024 * 1024,
};

export function configPath(): string {
  return (
    process.env["CODEINDEX_SYNC_CONFIG"] ??
    path.join(homedir(), ".config", "codeindex-sync", "config.json")
  );
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Validate loudly and early: a typo'd tool name otherwise fails at index time. */
function validateProvider(p: unknown, index: number): McpProviderConfig {
  const where = `providers[${index}]`;
  if (typeof p !== "object" || p === null) {
    throw new ConfigError(`${where} is not an object`, "each provider must be a JSON object");
  }
  const o = p as Record<string, unknown>;
  const need = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || !v) {
      throw new ConfigError(
        `${where}.${key} is missing or not a string`,
        `add "${key}" to ${where} — see \`codeindex-sync providers --example\``,
      );
    }
    return v;
  };
  const name = need("name");
  const command = need("command");
  const args = Array.isArray(o["args"]) ? (o["args"] as string[]) : [];
  const tools = o["tools"];
  if (typeof tools !== "object" || tools === null || typeof (tools as Record<string, unknown>)["update"] !== "string") {
    throw new ConfigError(
      `${where}.tools.update is missing`,
      `every provider needs at least an "update" tool name, e.g. "tools": { "update": "codebase_update" }`,
    );
  }
  const cfg: McpProviderConfig = {
    name,
    command,
    args,
    tools: tools as McpProviderConfig["tools"],
  };
  if (typeof o["description"] === "string") cfg.description = o["description"];
  if (typeof o["repoArg"] === "string") cfg.repoArg = o["repoArg"];
  if (Array.isArray(o["detectFiles"])) {
    // Every entry, not just the array: these become `path.join(dir, entry)` in
    // the hook path, where a number throws a TypeError *inside the user's git
    // command*. Rejecting it at load turns that into one clear config error.
    const bad = o["detectFiles"].findIndex((f) => typeof f !== "string" || f === "");
    if (bad !== -1) {
      throw new ConfigError(
        `${where}.detectFiles[${bad}] is not a filename`,
        `each entry is a marker file name, e.g. "detectFiles": [".socraticode.json"]`,
      );
    }
    cfg.detectFiles = o["detectFiles"] as string[];
  }
  if (typeof o["markerContent"] === "string") cfg.markerContent = o["markerContent"];
  if (Array.isArray(o["busyMarkers"])) cfg.busyMarkers = o["busyMarkers"] as string[];
  if (Array.isArray(o["asyncIndexMarkers"])) {
    cfg.asyncIndexMarkers = o["asyncIndexMarkers"] as string[];
  }
  if (Array.isArray(o["progressMarkers"])) cfg.progressMarkers = o["progressMarkers"] as string[];
  // A zero, negative or NaN interval turns the status poll into a spin loop
  // that hammers the backend. Rejecting it here beats discovering it as a
  // pegged CPU during someone's first full reindex.
  const pollIntervalMs = positiveMs(o, "pollIntervalMs", where, 2000);
  if (pollIntervalMs !== undefined) cfg.pollIntervalMs = pollIntervalMs;
  // Zero or less fails every call at once, reported as a timeout. A value that
  // is not a number at all has always been ignored in favour of the default,
  // and still is: rejecting it now would stop indexing for a config that works,
  // silently, since hooks discard the error.
  const timeoutMs = typeof o["timeoutMs"] === "number" ? positiveMs(o, "timeoutMs", where, 3_600_000) : undefined;
  if (timeoutMs !== undefined) cfg.timeoutMs = timeoutMs;
  // Zero or less kills every backend the moment it is asked to stop, leaving
  // whatever it held to go stale.
  const killAfterMs = positiveMs(o, "killAfterMs", where, 75_000);
  if (killAfterMs !== undefined) cfg.killAfterMs = killAfterMs;
  if (typeof o["env"] === "object" && o["env"] !== null) {
    cfg.env = o["env"] as Record<string, string>;
  }
  return cfg;
}

/** The longest delay Node's timers honour; a longer one fires after 1ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** An optional provider field that must be a positive number of milliseconds a timer can wait. */
function positiveMs(
  o: Record<string, unknown>,
  key: string,
  where: string,
  example: number,
): number | undefined {
  const ms = o[key];
  if (ms === undefined) return undefined;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    throw new ConfigError(
      `${where}.${key} must be a positive number of milliseconds`,
      `use a value like ${example}, or remove "${key}" from ${where} to take the default`,
    );
  }
  if (ms > MAX_TIMER_MS) {
    throw new ConfigError(
      `${where}.${key} is longer than ${MAX_TIMER_MS}ms (about 24.8 days), the longest wait Node's timers support — a longer one fires after 1ms`,
      `use a value like ${example}, or at most ${MAX_TIMER_MS}`,
    );
  }
  return ms;
}

/**
 * Validate `excludePaths`. Both failure modes here are silent ones.
 *
 * A pattern of only wildcards excludes every repository on the machine, and the
 * symptom — nothing is ever indexed again — looks exactly like broken hooks. A
 * pattern using glob syntax this does not implement excludes nothing, and looks
 * exactly like a pattern that works. Either way the config file is the last place
 * anyone would look, so neither is allowed to load.
 */
function parseExcludePaths(raw: unknown): string[] {
  if (raw === undefined) return [...DEFAULT_EXCLUDE_PATHS];
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      "excludePaths must be an array of path patterns",
      `e.g. "excludePaths": ${JSON.stringify(DEFAULT_EXCLUDE_PATHS)} — or [] to exclude nothing`,
    );
  }
  return raw.map((p, i) => {
    if (typeof p !== "string") {
      throw new ConfigError(`excludePaths[${i}] is not a string`, "each pattern is a path fragment");
    }
    const globs = unsupportedGlobSegments(p);
    if (globs.length > 0) {
      // A `*` is taken literally, so such a pattern excludes nothing and looks
      // like it works. Say so now rather than leaving worktrees being indexed.
      throw new ConfigError(
        `excludePaths[${i}] (${JSON.stringify(p)}) uses glob syntax that is not implemented: ${globs.join(", ")}`,
        `patterns are runs of path segments, with \`**\` allowed only as a whole segment — e.g. ${JSON.stringify(DEFAULT_EXCLUDE_PATHS[0])}`,
      );
    }
    if (patternSegments(p).length === 0) {
      throw new ConfigError(
        `excludePaths[${i}] (${JSON.stringify(p)}) names no directory, so it would exclude every repository`,
        `name a directory, e.g. ${JSON.stringify(DEFAULT_EXCLUDE_PATHS[0])} — or use [] to exclude nothing`,
      );
    }
    return p;
  });
}

export function parseConfig(raw: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "fix the syntax, or delete the file to start from defaults",
    );
  }
  if (typeof data !== "object" || data === null) {
    throw new ConfigError("config must be a JSON object", "wrap the contents in { }");
  }
  const o = data as Record<string, unknown>;
  const providersRaw = Array.isArray(o["providers"]) ? o["providers"] : [];
  return {
    root: typeof o["root"] === "string" ? o["root"] : DEFAULT_CONFIG.root,
    excludePaths: parseExcludePaths(o["excludePaths"]),
    providers: providersRaw.map(validateProvider),
    maxAttempts: typeof o["maxAttempts"] === "number" ? o["maxAttempts"] : DEFAULT_CONFIG.maxAttempts,
    backoffSeconds:
      typeof o["backoffSeconds"] === "number" ? o["backoffSeconds"] : DEFAULT_CONFIG.backoffSeconds,
    logMaxBytes: typeof o["logMaxBytes"] === "number" ? o["logMaxBytes"] : DEFAULT_CONFIG.logMaxBytes,
  };
}

export function loadConfig(file = configPath()): Config {
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  const cfg = parseConfig(readFileSync(file, "utf8"));
  // Documented override, useful for tests and one-off runs.
  const root = process.env["CODEINDEX_SYNC_ROOT"];
  if (root) cfg.root = root;
  return cfg;
}

export function saveConfig(cfg: Config, file = configPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

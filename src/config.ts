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
import type { McpProviderConfig } from "./providers/mcp-provider.js";

export interface Config {
  /** Only repos under this root are ever enqueued. */
  root: string;
  /** Ordered: the first provider claiming a repo wins, so order is meaningful. */
  providers: McpProviderConfig[];
  /** Retries before a job is parked in failed/. */
  maxAttempts: number;
  /** Base seconds for exponential retry backoff. */
  backoffSeconds: number;
  /** Rotate the worker log past this size. */
  logMaxBytes: number;
}

export const DEFAULT_CONFIG: Config = {
  root: path.join(homedir(), "workspace"),
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
  if (Array.isArray(o["detectFiles"])) cfg.detectFiles = o["detectFiles"] as string[];
  if (typeof o["markerContent"] === "string") cfg.markerContent = o["markerContent"];
  if (Array.isArray(o["busyMarkers"])) cfg.busyMarkers = o["busyMarkers"] as string[];
  if (Array.isArray(o["asyncIndexMarkers"])) {
    cfg.asyncIndexMarkers = o["asyncIndexMarkers"] as string[];
  }
  if (Array.isArray(o["progressMarkers"])) cfg.progressMarkers = o["progressMarkers"] as string[];
  if (o["pollIntervalMs"] !== undefined) {
    // A zero, negative or NaN interval turns the status poll into a spin loop
    // that hammers the backend. Rejecting it here beats discovering it as a
    // pegged CPU during someone's first full reindex.
    const ms = o["pollIntervalMs"];
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
      throw new ConfigError(
        `${where}.pollIntervalMs must be a positive number of milliseconds`,
        `use a value like 2000, or remove "pollIntervalMs" from ${where} to take the default`,
      );
    }
    cfg.pollIntervalMs = ms;
  }
  if (typeof o["timeoutMs"] === "number") cfg.timeoutMs = o["timeoutMs"];
  if (typeof o["env"] === "object" && o["env"] !== null) {
    cfg.env = o["env"] as Record<string, string>;
  }
  return cfg;
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

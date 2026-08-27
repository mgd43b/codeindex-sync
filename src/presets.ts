/**
 * Ready-made provider configurations.
 *
 * These exist purely so `codeindex-sync init` can offer a working starting
 * point instead of an empty file. Each is *only* data — no backend-specific
 * code exists anywhere in this project, which is what keeps it agnostic and
 * keeps its licence independent of the backends it drives.
 *
 * Adding a backend here is a config entry and a test. If a backend ever needs
 * real code, that is a signal the provider interface is missing something —
 * extend the interface rather than special-casing a product.
 */
import type { McpProviderConfig } from "./providers/mcp-provider.js";

export interface Preset {
  id: string;
  title: string;
  /** What the user gets, in one line. */
  summary: string;
  /** Shown when the preset needs setup beyond this config. */
  note?: string;
  config: McpProviderConfig;
}

export const PRESETS: Preset[] = [
  {
    id: "socraticode",
    title: "SocratiCode",
    summary: "Semantic code search over a local Qdrant + Ollama stack",
    note:
      "Backends are configured on the SocratiCode side (QDRANT_URL, OLLAMA_URL). " +
      "Because Git hooks are not a login shell, those must be set in this config's " +
      "`env` block or a file the hook path reads — not in a shell profile.",
    config: {
      name: "socraticode",
      description: "SocratiCode semantic index (MCP)",
      command: "npx",
      args: ["-y", "socraticode"],
      tools: {
        update: "codebase_update",
        index: "codebase_index",
        status: "codebase_status",
        list: "codebase_list_projects",
        remove: "codebase_remove",
      },
      repoArg: "projectPath",
      // A repo opts in by carrying this marker, which also pins a stable
      // project id so the index follows the repo rather than its path.
      detectFiles: [".socraticode.json"],
      busyMarkers: ["another indexer", "BUSY"],
      timeoutMs: 60 * 60 * 1000,
    },
  },
  {
    id: "generic-mcp",
    title: "Any MCP index server",
    summary: "Template for a backend exposing index/update/status tools",
    note: "Replace command, args and tool names with your server's.",
    config: {
      name: "my-backend",
      description: "Describe your backend here",
      command: "my-index-server",
      args: [],
      tools: { update: "update_index", index: "rebuild_index", status: "index_status" },
      repoArg: "projectPath",
      detectFiles: [],
    },
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

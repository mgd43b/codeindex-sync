/** Public API. Extension authors import from here; see docs/extending.md. */
export { Queue, jobKey, nowIso, parseJob } from "./queue.js";
export type { Job } from "./queue.js";
export { shouldCoalesce } from "./coalesce.js";
export type { CoalesceDecision } from "./coalesce.js";
export { ProviderRegistry } from "./provider.js";
export type {
  IndexOutcome,
  IndexProvider,
  IndexReason,
  IndexRequest,
  ProviderHealth,
  RepoStatus,
} from "./provider.js";
export { McpIndexProvider } from "./providers/mcp-provider.js";
export type { McpProviderConfig } from "./providers/mcp-provider.js";
export { GIT_HOOKS, HookRegistry, isGitHook } from "./hooks.js";
export type { DispatchResult, GitHook, HookEvent, HookHandler } from "./hooks.js";
export { WorkerLock, isAlive } from "./lock.js";
export { Worker } from "./worker.js";
export type { JobResult, WorkerOptions } from "./worker.js";
export { Logger, silentLogger } from "./logger.js";
export { resolvePaths } from "./paths.js";
export type { Paths } from "./paths.js";
export { ConfigError, DEFAULT_CONFIG, loadConfig, parseConfig, saveConfig } from "./config.js";
export type { Config } from "./config.js";
export { PRESETS, findPreset } from "./presets.js";
export type { Preset } from "./presets.js";
export { withMcp, McpSession, McpError } from "./mcp.js";
export { createIndexHandler } from "./handlers/index-handler.js";
export type { IndexHandlerOptions } from "./handlers/index-handler.js";
export { buildHookRegistry, buildProviderRegistry } from "./runtime.js";
export { defaultHooksDir, dispatcherScript, installDispatcher, isOurHooksDir } from "./install.js";
export { fingerprint, serialiseFingerprint, unchanged } from "./fingerprint.js";
export type { Fingerprint } from "./fingerprint.js";

/**
 * Wiring.
 *
 * One place that assembles config into a running system, so the CLI, the hook
 * entry point and any embedder all get an identically-configured registry.
 * Without this, "which handlers are active?" would depend on which command you
 * happened to run — and `extensions` would lie.
 */
import type { Config } from "./config.js";
import { createIndexHandler } from "./handlers/index-handler.js";
import { HookRegistry } from "./hooks.js";
import { resolvePaths } from "./paths.js";
import { ProviderRegistry } from "./provider.js";
import { McpIndexProvider } from "./providers/mcp-provider.js";

export function buildProviderRegistry(cfg: Config): ProviderRegistry {
  const reg = new ProviderRegistry();
  for (const p of cfg.providers) reg.register(new McpIndexProvider(p));
  return reg;
}

/**
 * Hook handlers, built-in first.
 *
 * The indexer is registered through the public interface rather than being
 * special-cased, so the extension point is exercised on every commit. Third-party
 * handlers are appended after it.
 */
export function buildHookRegistry(cfg: Config, extra: HookRegistry | null = null): HookRegistry {
  const paths = resolvePaths();
  const registry = new HookRegistry();
  registry.register(createIndexHandler({ queueDir: paths.queue, root: cfg.root }));
  if (extra) for (const handler of extra.all()) registry.register(handler);
  return registry;
}

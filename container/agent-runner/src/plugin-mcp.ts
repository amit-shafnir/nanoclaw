/**
 * Agent Plugins runtime contract for stdio MCP servers that shipped inside a
 * plugin (marked by the host with `pluginRoot` at stamp time):
 *
 *   - `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are expanded once, non-recursively,
 *     in args elements and env values (never in the command or env keys —
 *     the host-side reader rejects those at stamp time).
 *   - a `./`-relative command resolves against the plugin root.
 *   - PLUGIN_ROOT and PLUGIN_DATA env vars are injected last, so configured
 *     env can never override them.
 *
 * Servers without `pluginRoot` (CLI- or approval-added) pass through
 * untouched.
 */
import path from 'path';

import type { McpServerConfig } from './providers/types.js';

/** plugins/<name> and plugin-data/<name> are siblings under the group mount. */
function pluginDataDir(pluginRoot: string): string {
  const groupDir = path.posix.dirname(path.posix.dirname(pluginRoot));
  return path.posix.join(groupDir, 'plugin-data', path.posix.basename(pluginRoot));
}

export function resolvePluginServer(config: McpServerConfig): McpServerConfig {
  if (config.type === 'http') return config;
  const { pluginRoot, ...server } = config;
  if (!pluginRoot) return config;

  const pluginData = pluginDataDir(pluginRoot);
  // Both replacement values are fixed container paths with no placeholders in
  // them, so a single substitution pass is inherently non-recursive.
  const expand = (value: string): string =>
    value.split('${PLUGIN_ROOT}').join(pluginRoot).split('${PLUGIN_DATA}').join(pluginData);

  return {
    ...server,
    command: server.command.startsWith('./')
      ? path.posix.join(pluginRoot, server.command.slice(2))
      : server.command,
    args: (server.args ?? []).map(expand),
    env: {
      ...Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value)])),
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: pluginData,
    },
  };
}

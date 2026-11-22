/**
 * Magpie Bun plugin-host entrypoint for GemPT (tools + page).
 *
 * Exports a single OpenCode/Magpie plugin factory (`GemptPlugin`) that:
 * 1. Starts the sandboxed localhost GemPT control page service non-blockingly.
 * 2. Registers native Magpie MCP tools (`gempt_dispatch`, `gempt_discover`, `gempt_status`,
 *    `gempt_consult`, `gempt_exec`) for every client Magpie connects.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { createGemptTools, isExecEnabled } from './lib/tools.mjs';

let servicePromise = null;

function resolveHostMagpieDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return undefined;
  if (existsSync(join(dir, 'providers.json')) || existsSync(join(dir, 'plugins.json'))) {
    return dir;
  }
  return undefined;
}

export const GemptPlugin = async (ctx = {}, options = {}) => {
  const magpieConfigDir = resolveHostMagpieDir(ctx?.directory);
  const execEnabled = isExecEnabled(options, process.env);
  const mcpToolsEnabled = !(options?.mcpTools === false || String(process.env.GEMPT_MAGPIE_DISABLE_TOOLS || '') === '1');

  if (!servicePromise) {
    const value = Number(options?.port);
    const port = Number.isInteger(value) && value >= 0 && value < 65536 ? value : undefined;
    servicePromise = startServer({
      port,
      magpieConfigDir,
      execEnabled,
      mcpToolsEnabled,
      manageAppServer: options.manageAppServer ?? port !== 0,
    }).catch((err) => {
      console.warn(`[gempt-magpie-plugin] Service startup failed: ${err?.message || err}`);
      servicePromise = null;
    });
  }

  if (!mcpToolsEnabled) {
    return {};
  }

  return {
    tool: createGemptTools({
      magpieConfigDir,
      options,
    }),
  };
};

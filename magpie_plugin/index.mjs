/**
 * Magpie Bun plugin-host entrypoint for GemPT (tools + page).
 *
 * Exports a single OpenCode/Magpie plugin factory (`GemptPlugin`) that:
 * 1. Starts the sandboxed localhost GemPT control page service non-blockingly.
 * 2. Registers native Magpie MCP tools (`gempt_run`, `gempt_ask`, `gempt_ctl`).
 * 3. Exposes a `dispose()` hook (and honors host abort/dispose hooks) so hot
 *    reloads cleanly close the prior HTTP server and release its port/identity.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { createGemptTools, isExecEnabled } from './lib/tools.mjs';

let activeService = null;

function resolveHostMagpieDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return undefined;
  if (existsSync(join(dir, 'providers.json')) || existsSync(join(dir, 'plugins.json'))) {
    return dir;
  }
  return undefined;
}

async function disposeService(target = activeService) {
  if (!target) return;
  target.closed = true;
  if (activeService === target) activeService = null;
  if (target.cleanupHooks?.length) {
    for (const unhook of target.cleanupHooks.splice(0)) {
      try { unhook(); } catch { /* ignore */ }
    }
  }
  const pending = target.promise;
  if (!pending) return;
  let svc;
  try {
    svc = await pending;
  } catch {
    return;
  }
  if (svc && !target.serverClosed) {
    target.serverClosed = true;
    try {
      await svc.close?.();
    } catch {
      /* ignore close errors */
    }
  }
}

export const GemptPlugin = async (ctx = {}, options = {}) => {
  const magpieConfigDir = resolveHostMagpieDir(ctx?.directory) ?? options?.magpieConfigDir;
  const execEnabled = isExecEnabled(options, process.env);
  const mcpToolsEnabled = !(options?.mcpTools === false || String(process.env.GEMPT_MAGPIE_DISABLE_TOOLS || '') === '1');
  const value = Number(options?.port);
  const port = Number.isInteger(value) && value >= 0 && value < 65536 ? value : undefined;
  const configPath = options?.configPath;
  const sessionsDir = options?.sessionsDir;
  const manageAppServer = options.manageAppServer ?? port !== 0;

  const prev = activeService;
  const prevClosed = prev ? disposeService(prev) : Promise.resolve();
  const entry = { closed: false, serverClosed: false, promise: null, cleanupHooks: [] };
  activeService = entry;

  entry.promise = prevClosed.then(() => {
    if (entry.closed) return null;
    return startServer({
      port,
      configPath,
      sessionsDir,
      magpieConfigDir,
      execEnabled,
      mcpToolsEnabled,
      manageAppServer,
    });
  }).then(async (svc) => {
    if (entry.closed) {
      if (svc && !entry.serverClosed) {
        entry.serverClosed = true;
        try { await svc.close?.(); } catch { /* ignore */ }
      }
      return null;
    }
    return svc;
  }).catch((err) => {
    console.warn(`[gempt-magpie-plugin] Service startup failed: ${err?.message || err}`);
    if (activeService === entry) activeService = null;
    return null;
  });

  const dispose = () => disposeService(entry);

  if (ctx?.signal && typeof ctx.signal.addEventListener === 'function') {
    if (ctx.signal.aborted) {
      void dispose();
    } else {
      const onAbort = () => { void dispose(); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      entry.cleanupHooks.push(() => ctx.signal.removeEventListener('abort', onAbort));
    }
  }
  if (typeof ctx?.onDispose === 'function') {
    try { ctx.onDispose(dispose); } catch { /* ignore host callback errors */ }
  }

  if (!mcpToolsEnabled) {
    return { dispose };
  }

  return {
    tool: createGemptTools({
      configPath,
      sessionsDir,
      magpieConfigDir,
      options,
    }),
    dispose,
  };
};

GemptPlugin.dispose = () => disposeService();

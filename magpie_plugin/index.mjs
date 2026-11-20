/**
 * Magpie Bun plugin-host entrypoint for GemPT.
 * Starts the local GemPT control page HTTP service and keeps it alive with Magpie.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';

let started = null;

function resolveHostMagpieDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return undefined;
  if (existsSync(join(dir, 'providers.json')) || existsSync(join(dir, 'plugins.json'))) {
    return dir;
  }
  return undefined;
}

export default {
  id: 'gempt-magpie-plugin',
  server: async (input, options) => {
    if (!started) {
      const value = Number(options?.port);
      const port = Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
      started = startServer({
        port,
        magpieConfigDir: resolveHostMagpieDir(input?.directory),
      }).catch((err) => {
        started = null;
        throw err;
      });
    }
    await started;
    return {};
  },
};

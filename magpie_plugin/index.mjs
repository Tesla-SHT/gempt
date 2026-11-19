/**
 * Magpie Bun plugin-host entrypoint for GemPT.
 * Starts the local GemPT control page HTTP service and keeps it alive with Magpie.
 */
import { startServer } from './lib/server.mjs';

let started = null;

export default {
  id: 'gempt-magpie-plugin',
  server: async (input, options) => {
    if (!started) {
      const value = Number(options?.port);
      const port = Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
      started = startServer({
        port,
        magpieConfigDir: input?.directory,
      }).catch((err) => {
        started = null;
        throw err;
      });
    }
    await started;
    return {};
  },
};

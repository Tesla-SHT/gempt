import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolvePath } from './state.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

export function agyInstallPaths(target, binDir, env = process.env) {
  return {
    target: resolvePath(target || env.GEMPT_AGY_PLUGIN_DIR || join(homedir(), '.gemini', 'config', 'plugins', 'gempt')),
    binDir: resolvePath(binDir || env.GEMPT_BIN_DIR || join(homedir(), 'bin')),
  };
}

export function resolvePluginRoot(runtimeRoot = RUNTIME_ROOT) {
  const sourcePlugin = join(runtimeRoot, 'plugin');
  const bundlePlugin = join(runtimeRoot, '..');
  return [sourcePlugin, bundlePlugin].find((root) => existsSync(join(root, 'plugin.json'))) ?? sourcePlugin;
}

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

export function resolvePluginRoot(runtimeRoot = RUNTIME_ROOT) {
  const sourcePlugin = join(runtimeRoot, 'plugin');
  const bundlePlugin = join(runtimeRoot, '..');
  return [sourcePlugin, bundlePlugin].find((root) => existsSync(join(root, 'plugin.json'))) ?? sourcePlugin;
}

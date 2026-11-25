#!/usr/bin/env node
/**
 * Sync local GemPT checkout to installed Antigravity plugin and reload Magpie plugin.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMagpieCliEnv, findMagpieCli } from '../core/magpie.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const isWin = process.platform === 'win32';
const npm = process.env.npm_execpath;

function run(cmd, args, opts = {}) {
  const isBatch = isWin && /\.(cmd|bat)$/i.test(cmd);
  const bin = isBatch ? (process.env.COMSPEC || 'cmd.exe') : cmd;
  const fullArgs = isBatch ? ['/d', '/c', cmd, ...args] : args;
  execFileSync(bin, fullArgs, { stdio: 'inherit', cwd: ROOT, windowsHide: true, ...opts });
}

function normalizeSpecPath(value) {
  return resolve(String(value || '')).toLowerCase();
}

function findLocalMagpieSpec() {
  const dir = process.env.MAGPIE_CONFIG_DIR || join(homedir(), '.config', 'magpie');
  const file = join(dir, 'plugins.json');
  if (!existsSync(file)) return '';
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
    const want = normalizeSpecPath(ROOT);
    const match = plugins.find((entry) => {
      const spec = String(entry?.spec || '').trim();
      if (!spec || spec.startsWith('@') || spec.startsWith('github:') || spec.startsWith('npm:')) return false;
      try {
        return normalizeSpecPath(spec) === want;
      } catch {
        return false;
      }
    });
    return match ? String(match.spec) : '';
  } catch {
    return '';
  }
}

function resolveMagpieCli() {
  const found = findMagpieCli();
  if (found) return found;
  if (isWin) {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "(Get-Process -Name 'magpie' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 },
      ).trim();
      if (out) {
        const com = join(dirname(out), 'magpie.com');
        if (existsSync(com)) return com;
      }
    } catch {
      // Ignore process probe errors.
    }
  }
  return '';
}

console.log('[sync:local] 1/3 Building HTTP UI bundle...');
if (npm) {
  run(process.execPath, [npm, 'run', 'build:mcp-app']);
} else {
  run(isWin ? 'npm.cmd' : 'npm', ['run', 'build:mcp-app']);
}

console.log('[sync:local] 2/3 Installing Antigravity plugin & shims...');
run(process.execPath, [join(ROOT, 'bin', 'gempt.mjs'), 'install-agy']);

const localSpec = findLocalMagpieSpec();
const magpieCli = localSpec ? resolveMagpieCli() : '';
if (localSpec && magpieCli) {
  console.log(`[sync:local] 3/3 Reloading Magpie plugin (${localSpec})...`);
  const env = buildMagpieCliEnv();
  run(magpieCli, ['plugin', 'off', localSpec], { env });
  run(magpieCli, ['plugin', 'on', localSpec], { env });
} else if (localSpec) {
  console.log('[sync:local] 3/3 Skipped Magpie reload (magpie CLI not found; UI assets still hot-reload via mtime).');
} else {
  console.log('[sync:local] 3/3 Skipped Magpie reload (this repo is not registered as a local Magpie plugin spec).');
}

console.log('[sync:local] Done.');

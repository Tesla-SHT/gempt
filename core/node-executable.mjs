import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';

function nvmNodeBinDirs(home) {
  const root = join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .map((name) => join(root, name, 'bin'));
  } catch {
    return [];
  }
}

export function resolveNodeExecutable({ execPath = process.execPath, env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (/^node(?:\.exe)?$/i.test(basename(execPath))) return execPath;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  const dirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  if (platform !== 'win32') {
    dirs.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.local', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.fnm', 'current', 'bin'),
      ...nvmNodeBinDirs(home),
    );
  }
  for (const dir of dirs) {
    const candidate = resolve(dir.replace(/^"|"$/g, ''), name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return execPath;
}

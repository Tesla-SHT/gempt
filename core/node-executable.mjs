import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, resolve } from 'node:path';

export function resolveNodeExecutable({ execPath = process.execPath, env = process.env } = {}) {
  if (/^node(?:\.exe)?$/i.test(basename(execPath))) return execPath;
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir.replace(/^"|"$/g, ''), name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return execPath;
}

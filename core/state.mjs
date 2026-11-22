import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function resolvePath(path) {
  if (path === '~' || /^~[/\\]/.test(path)) path = join(homedir(), path.slice(2));
  const absolute = resolve(path);
  return resolveExistingPrefix(absolute);
}

function resolveExistingPrefix(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = dirname(path);
    return parent === path ? path : join(resolveExistingPrefix(parent), basename(path));
  }
}

export function withinPath(path, root) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export function validateSessionId(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.includes('..') || id === '.') {
    throw new Error(`Invalid session_id '${sessionId}'`);
  }
  return id;
}

export function atomicJson(path, data, { exclusive = false } = {}) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.gempt-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(data) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (exclusive) linkSync(temp, path);
    else renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export async function withLock(path, operation, { attempts = 3 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fd = openSync(path, 'wx', 0o600);
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || attempt + 1 === attempts) throw error;
      await sleep(20);
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
}

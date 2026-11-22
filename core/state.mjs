import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

function unlinkOwnedLock(path, owner) {
  try {
    const current = lstatSync(path);
    if (current.dev !== owner.dev || current.ino !== owner.ino) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return true;
  }
}

function staleLock(fd, info, staleMs) {
  if (Date.now() - info.mtimeMs > staleMs) return true;
  const record = /^([1-9]\d*):\d+$/.exec(readFileSync(fd, 'utf8').trim());
  const pid = Number(record?.[1]);
  if (!record || pid > 0x7fffffff) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function reclaimLock(path, staleMs) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    return staleLock(fd, info, staleMs) && unlinkOwnedLock(path, info);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (error.code === 'EPERM' || error.code === 'EACCES') return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function withLock(path, operation, { attempts = 25, staleMs = 60_000 } = {}) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.gempt-${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  let owner;
  try {
    writeFileSync(fd, `${process.pid}:${Date.now()}\n`);
    const info = fstatSync(fd);
    for (let attempt = 1; ; attempt++) {
      try {
        linkSync(temp, path);
        owner = info;
        break;
      } catch (error) {
        if (attempt >= attempts || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        if (error.code === 'EEXIST' && reclaimLock(path, staleMs)) continue;
        await sleep(25);
      }
    }
    unlinkSync(temp);
    return await operation();
  } finally {
    try {
      if (owner) unlinkOwnedLock(path, owner);
    } finally {
      closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
}

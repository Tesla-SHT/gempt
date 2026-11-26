import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const NARRATOR_MAX_BYTES = 64 * 1024;
const good = new Map();

export function narratorDirectory(sessionsDir, swarmId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(swarmId)) throw new Error('Invalid swarm ID.');
  return join(sessionsDir, 'swarm-views', swarmId);
}

function readBounded(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NARRATOR_MAX_BYTES) throw new Error('Narrator view exceeds 64 KiB or is not a regular file.');
    const buffer = Buffer.alloc(NARRATOR_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
      if (length > NARRATOR_MAX_BYTES) throw new Error('Narrator view exceeds 64 KiB.');
    }
    return { content: buffer.toString('utf8', 0, length), mtime: stat.mtimeMs };
  } finally { closeSync(fd); }
}

function parseView(content) {
  const value = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a narrator view object.');
  return value;
}

export function readNarratorView(sessionsDir, id) {
  const dir = narratorDirectory(sessionsDir, id);
  let json, html, jsonError, htmlError;
  try {
    json = readBounded(join(dir, 'view.json'));
    json.data = parseView(json.content);
    good.delete(dir);
    good.set(dir, json);
    if (good.size > 64) good.delete(good.keys().next().value);
  } catch (error) {
    if (error.code === 'ENOENT') good.delete(dir);
    else {
      jsonError = error.message;
      json = good.get(dir);
      if (!json) {
        try {
          json = readBounded(join(dir, 'view.last-good.json'));
          json.data = parseView(json.content);
        } catch { json = undefined; }
      }
    }
  }
  try { html = readBounded(join(dir, 'view.html')); }
  catch (error) { if (error.code !== 'ENOENT') htmlError = error.message; }
  return { exists: Boolean(json || html || jsonError || htmlError), dir, source: 'narrator',
    json: json?.data ?? null, jsonMtime: json?.mtime || 0, jsonError: jsonError || '',
    html: html?.content || '', htmlMtime: html?.mtime || 0, htmlError: htmlError || '' };
}

function replaceFile(dir, name, content) {
  const path = join(dir, name);
  if (content === null) {
    rmSync(path, { force: true });
    return;
  }
  const tmp = join(dir, '.' + randomUUID());
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

export function publishNarratorView(sessionsDir, id, { view, html }) {
  const json = typeof view === 'string' ? view : JSON.stringify(view);
  if (typeof json !== 'string' || Buffer.byteLength(json) > NARRATOR_MAX_BYTES
      || (html != null && (typeof html !== 'string' || Buffer.byteLength(html) > NARRATOR_MAX_BYTES))) {
    throw new Error('Narrator view.json and view.html must each fit in 64 KiB.');
  }
  parseView(json);
  const dir = narratorDirectory(sessionsDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (html !== undefined) replaceFile(dir, 'view.html', html);
  replaceFile(dir, 'view.last-good.json', json);
  replaceFile(dir, 'view.json', json);
  return readNarratorView(sessionsDir, id);
}

export function narratorFeedback(view, target, text) {
  if (!/^[a-z0-9-]{1,40}$/.test(target ?? '') || !['attention', 'workstreams', 'milestones', 'risks']
    .some((section) => Array.isArray(view?.json?.[section]) && view.json[section].some((item) => item?.id === target))) {
    throw Object.assign(new Error('Unknown narrator feedback target.'), { status: 400 });
  }
  const body = typeof text === 'string' && text.trim();
  if (!body || Buffer.byteLength(body) > 4000 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(body)) {
    throw Object.assign(new Error('Feedback must be non-empty and at most 4000 bytes.'), { status: 400 });
  }
  // Leave the user's message readable without turning it into another doorbell.
  return `user feedback on card ${target}: ${body.replaceAll('@', '＠')}`;
}

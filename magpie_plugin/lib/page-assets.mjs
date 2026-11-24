import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../../core/assets/http-ui/', import.meta.url);
const assets = new Map([
  ['/index.html', [new URL('index.html', root), 'text/html; charset=utf-8']],
  ['/styles.css', [new URL('styles.css', root), 'text/css; charset=utf-8']],
  ['/app.js', [new URL('app.js', root), 'text/javascript; charset=utf-8']],
  ['/http.js', [new URL('../ui/http.js', import.meta.url), 'text/javascript; charset=utf-8']],
]);
const pending = new Map();

export function readPageAsset(path) {
  if (path === '/') path = '/index.html';
  const entry = assets.get(path);
  if (!entry) return null;
  if (!pending.has(path)) {
    const [file, type] = entry;
    pending.set(path, readFile(file).then((data) => ({
      data, type, etag: `W/"${createHash('sha256').update(data).digest('base64url')}"`,
    })).catch((error) => {
      pending.delete(path);
      throw error;
    }));
  }
  return pending.get(path);
}

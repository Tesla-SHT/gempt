import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

export const PROXY_PATH = '/v1/codex-proxy';

export function createThreadCacheKeys({ limit = 512, ttl = 2 * 60 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  function lookup(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (now() - entry.updatedAt >= ttl) return;
    entry.updatedAt = now();
    entries.set(id, entry);
    return entry;
  }
  function register({ threadId, parentThreadId, swarmId, model }) {
    const valid = (id) => typeof id === 'string' && id.length > 0 && id.length <= 512;
    if (!valid(threadId) || (parentThreadId != null ? !valid(parentThreadId) : !valid(swarmId) || !valid(model))) {
      throw Object.assign(new Error('Invalid cache-key registration'), { status: 400 });
    }
    let cacheKey, rootThreadId;
    if (parentThreadId) {
      const parent = lookup(parentThreadId);
      cacheKey = parent?.cacheKey ?? parentThreadId;
      rootThreadId = parent?.rootThreadId ?? parentThreadId;
    } else {
      const hex = createHash('sha256').update(JSON.stringify([swarmId, model])).digest('hex');
      cacheKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      rootThreadId = threadId;
    }
    entries.delete(threadId);
    entries.set(threadId, { cacheKey, rootThreadId, updatedAt: now() });
    if (entries.size > limit) entries.delete(entries.keys().next().value);
  }
  return { register, lookup, get size() { return entries.size; } };
}

function endToEndHeaders(headers) {
  const result = { ...headers };
  for (const name of ['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(headers.connection || '').split(',')]) {
    delete result[name.trim().toLowerCase()];
  }
  return result;
}

export async function proxyCodexRequest(req, res, url, target, keys) {
  const path = url.pathname.slice(PROXY_PATH.length);
  const upstream = new URL(target.url + '/v1' + path + url.search);
  const headers = endToEndHeaders(req.headers);
  delete headers.authorization;
  delete headers['x-gempt-ipc-token'];
  delete headers['x-gempt-key'];
  if (target.key) headers.authorization = 'Bearer ' + target.key;
  let body;
  if (req.method === 'POST' && path === '/responses' && keys.size) {
    const sessionHeaders = ['session_id', 'session-id'];
    const identity = [...sessionHeaders, 'conversation_id', 'conversation-id', 'thread-id'].map((h) => headers[h]).filter(Boolean);
    const headerKey = identity.map((id) => keys.lookup(id)).find(Boolean);
    // Codex supplies its thread identity in the transport headers as well as the body.
    // An ordinary solo request can stream straight through without parsing the prompt.
    const codexSession = headers['session-id'] || headers.session_id;
    if (headerKey || !codexSession || headers['thread-id'] !== codexSession) {
      if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
        throw Object.assign(new Error('Expected uncompressed Responses JSON'), { status: 415 });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) throw Object.assign(new Error('Responses request too large'), { status: 413 });
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
      let data;
      try {
        // Tool schemas and inputs can contain numbers beyond JavaScript's precision.
        data = JSON.parse(body, (_key, value, context) => typeof value === 'number' ? JSON.rawJSON(context.source) : value);
      } catch { /* Forward malformed payloads for the upstream error response. */ }
      const mapped = keys.lookup(data?.prompt_cache_key) || headerKey;
      if (mapped && data && typeof data === 'object' && !Array.isArray(data)) {
        data.prompt_cache_key = mapped.cacheKey;
        body = Buffer.from(JSON.stringify(data));
        headers['content-length'] = body.length;
        for (const h of sessionHeaders) if (headers[h]) headers[h] = mapped.cacheKey;
      }
    }
  }
  if (res.destroyed) return;
  const transport = upstream.protocol === 'https:' ? https : http;
  const request = transport.request(upstream, { method: req.method, headers });
  res.once('close', () => request.destroy());
  req.once('error', (err) => request.destroy(err));
  const response = new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  if (body) request.end(body);
  else req.pipe(request);
  let incoming;
  try { incoming = await response; }
  catch (err) { throw Object.assign(err, { status: 502 }); }
  res.writeHead(incoming.statusCode, endToEndHeaders(incoming.headers));
  res.flushHeaders();
  await pipeline(incoming, res);
}

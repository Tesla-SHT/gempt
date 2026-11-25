import { findCacheKeyByNativeSession, getRunLineage, resolveLineageCacheKey, upsertRunLineage } from '../../core/swarm-bus.mjs';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

export const PROXY_PATH = '/v1/codex-proxy';
export const CACHE_PROXY_PATH = '/v1/cache-proxy';

export function createThreadCacheKeys({ sessionsDir, limit = 512, ttl = 2 * 60 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  function remember(id, entry) {
    entry.updatedAt = now();
    entries.delete(id);
    entries.set(id, entry);
    if (entries.size > limit) entries.delete(entries.keys().next().value);
    return entry;
  }
  const valid = (id) => typeof id === 'string' && id.length > 0 && id.length <= 512;
  function lookup(id, model) {
    if (!valid(id) || (model != null && !valid(model))) return;
    const entry = entries.get(id);
    if (entry && now() - entry.updatedAt < ttl) {
      if (!model || !entry.model || entry.model === model) return remember(id, entry);
    } else entries.delete(id);
    const row = sessionsDir && findCacheKeyByNativeSession(id, { sessionsDir, model });
    if (row) return remember(id, { cacheKey: row.cache_group_key, model: row.model, runId: row.run_id,
      rootThreadId: row.root_thread_id || id });
  }
  function register({ threadId, parentThreadId, swarmId, model, runId, resume, cli = 'codex', protocol = 'openai-responses' }) {
    if (!valid(threadId) || cli !== 'codex' || protocol !== 'openai-responses' || (runId != null && !valid(runId))
        || (model != null && !valid(model)) || (swarmId != null && !valid(swarmId))
        || (parentThreadId != null ? !valid(parentThreadId) : !resume && (!valid(swarmId) || !valid(model)))) {
      throw Object.assign(new Error('Invalid cache-key registration'), { status: 400 });
    }
    const existing = lookup(threadId, model);
    const run = sessionsDir && runId && getRunLineage(runId, { sessionsDir });
    const parent = lookup(parentThreadId);
    const compatible = parent && (!model || !parent.model || parent.model === model);
    // Older app-servers register native forks with just the two thread IDs.
    const row = { run_id: runId || existing?.runId || 'codex-thread:' + threadId,
      native_session_id: threadId, parent_native_session_id: parentThreadId,
      parent_run_id: parent?.runId, fork_mode: parentThreadId ? 'native' : undefined,
      swarm_id: swarmId, cli, protocol, model: model || parent?.model };
    row.cache_group_key = (resume && existing?.cacheKey) || (compatible && parent.cacheKey)
      || (parentThreadId && !parent && resolveLineageCacheKey({ protocol, native_session_id: parentThreadId }))
      || (run?.cli === cli && run.protocol === protocol && run.model === model && run.cache_group_key)
      || resolveLineageCacheKey(row);
    if (sessionsDir) upsertRunLineage(row, { sessionsDir });
    remember(threadId, { cacheKey: row.cache_group_key, rootThreadId: parent?.rootThreadId || parentThreadId || existing?.rootThreadId || threadId,
      model: row.model, runId: row.run_id });
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

export async function proxyCodexRequest(req, res, url, target, keys, prefix = PROXY_PATH) {
  const path = url.pathname.slice(prefix.length);
  const upstream = new URL(target.url + '/v1' + path + url.search);
  const headers = endToEndHeaders(req.headers);
  const nativeAuth = headers['x-gempt-proxy-token'];
  if (!nativeAuth || headers.authorization === 'Bearer ' + nativeAuth) delete headers.authorization;
  delete headers['x-gempt-proxy-token'];
  delete headers['x-gempt-ipc-token'];
  delete headers['x-gempt-key'];
  if (target.key && !headers.authorization && !(nativeAuth && (headers['x-api-key'] || headers['x-goog-api-key'])))
    headers.authorization = 'Bearer ' + target.key;
  let body;
  let streamRemainder = false;
  if (req.method === 'POST' && path === '/responses' && !headers['anthropic-version'] && !headers['x-api-key'] && !headers['x-goog-api-key']
      && (!headers['content-encoding'] || headers['content-encoding'] === 'identity')) {
    const sessionHeaders = ['session_id', 'session-id'];
    const identity = [...sessionHeaders, 'conversation_id', 'conversation-id', 'thread-id'].map((h) => headers[h]).filter(Boolean);
    const headerId = identity.find((id) => keys.lookup(id));
    // Codex supplies its thread identity in the transport headers as well as the body.
    // An ordinary solo request can stream straight through without parsing the prompt.
    const codexSession = headers['session-id'] || headers.session_id;
    const maxBytes = 64 * 1024 * 1024;
    const oversized = Number(headers['content-length']) > maxBytes;
    if (headerId || (!oversized && (!codexSession || headers['thread-id'] !== codexSession))) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        chunks.push(chunk);
        if (size > maxBytes) {
          if (headerId) throw Object.assign(new Error('Responses request too large'), { status: 413 });
          streamRemainder = true;
          break;
        }
      }
      body = Buffer.concat(chunks);
      let data;
      try {
        // Tool schemas and inputs can contain numbers beyond JavaScript's precision.
        if (!streamRemainder) data = JSON.parse(body, (_key, value, context) => typeof value === 'number' ? JSON.rawJSON(context.source) : value);
      } catch { /* Forward malformed payloads for the upstream error response. */ }
      const mapped = keys.lookup(data?.prompt_cache_key, data?.model) || keys.lookup(headerId, data?.model);
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
  if (body && !streamRemainder) request.end(body);
  else {
    if (body) request.write(body);
    req.pipe(request);
  }
  let incoming;
  try { incoming = await response; }
  catch (err) { throw Object.assign(err, { status: 502 }); }
  res.writeHead(incoming.statusCode, endToEndHeaders(incoming.headers));
  res.flushHeaders();
  await pipeline(incoming, res);
}

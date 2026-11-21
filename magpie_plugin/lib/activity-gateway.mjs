import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const ledgers = new Map();
const WINDOW_MARGIN_MS = 1000; // Older GemPT receipts round timestamps to seconds.
const directGroup = /^(?:group\/)?gempt-(?:sonnet|opus|fable)(?::|#|$)/i;
const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const string = (value) => typeof value === 'string' ? value : '';
const identity = (row) => row.route_id == null ? '' : `${row.route_id}|${row.t ?? row.timestamp ?? row.ts}`;
const matchesModel = (a, b) => {
  a = a.toLowerCase();
  b = b.toLowerCase();
  return Boolean(a && b && (a === b || (!a.includes('/') && b.endsWith(`/${a}`))
    || (!b.includes('/') && a.endsWith(`/${b}`))));
};

function gatewayRow(row) {
  const time = row.t ?? row.timestamp ?? row.ts;
  const at = typeof time === 'number' ? time * (time < 1e12 ? 1000 : 1) : Date.parse(time);
  const requested = string(row.req ?? row.requested_model);
  if (!Number.isFinite(at) || Math.abs(at) > 8.64e15 || directGroup.test(requested)) return null;
  const threads = [...new Set([row.native_session, row.session, row.session_id, row.thread_id, row.codex_thread_id].filter(string))];
  const response = string(row.response_id);
  const agent = string(row.agent);
  // Keep candidates with an exact identity and calls that can support a legacy match.
  if (!threads.length && !response && agent !== 'gempt') return null;
  return {
    at, threads, response, agent, key: identity(row), route_id: row.route_id ?? null,
    endpoint: string(row.ep ?? row.endpoint), websocket: row.ws === true,
    requested_model: requested,
    sent_model: string(row.sent_model || row.upstream_model || row.model),
    model: string(row.served || row.served_model || row.model),
    provider: string(row.provider),
    account: string(row.providerAccount || row.provider_account || row.account),
    status_code: count(row.status ?? row.status_code),
    input_tokens: count(row.in ?? row.input_tokens),
    output_tokens: count(row.out ?? row.output_tokens),
    cache_read_tokens: count(row.cache_read ?? row.cache_read_tokens),
    cache_write_tokens: count(row.cache_write ?? row.cache_write_tokens),
    reasoning_tokens: count(row.reasoning ?? row.reasoning_tokens),
    // Magpie's short 'in' field counts uncached input.
    input_includes_cache: row.in == null,
    cost_usd: row.priced === false ? null : count(row.cost_usd ?? row.cost),
    ttft_ms: count(row.ttft_ms), first_text_ms: count(row.first_text_ms),
    duration_ms: count(row.ms ?? row.duration_ms),
    tokens_per_sec: count(row.tokens_per_sec ?? row.output_tokens_per_sec),
  };
}

function addIndex(map, id, row) {
  if (!id) return;
  const rows = map.get(id);
  if (rows) rows.push(row);
  else map.set(id, [row]);
}

function readLedger(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { ino, dev, size, mtimeMs } = fstatSync(fd);
    let cache = ledgers.get(file);
    if (!cache || cache.ino !== ino || cache.dev !== dev || size < cache.size
        || (size === cache.size && cache.mtimeMs !== mtimeMs)) {
      cache = { ino, dev, offset: 0, threads: new Map(), responses: new Map(), temporal: [], prices: new Map() };
    }
    if (cache.size === size && cache.mtimeMs === mtimeMs) return cache;
    const chunk = Buffer.alloc(Math.min(1024 * 1024, size - cache.offset));
    let carry = Buffer.alloc(0);
    let oversized = false;
    const indexLine = (line) => {
      const row = gatewayRow(JSON.parse(line.toString('utf8')));
      if (!row) return;
      for (const id of row.threads) addIndex(cache.threads, id, row);
      addIndex(cache.responses, row.response, row);
      if (row.agent === 'gempt' || (!row.websocket && !row.threads.length)) cache.temporal.push(row);
    };
    for (let at = cache.offset; at < size;) {
      const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at);
      if (!bytes) break;
      let start = 0;
      const filled = chunk.subarray(0, bytes);
      for (let end; (end = filled.indexOf(10, start)) >= 0; start = end + 1) {
        if (!oversized && carry.length + end - start <= 256 * 1024) {
          const part = filled.subarray(start, end);
          const line = carry.length ? Buffer.concat([carry, part]) : part;
          try { indexLine(line); } catch { /* A malformed ledger line need not hide the rest. */ }
        }
        cache.offset = at + end + 1;
        carry = Buffer.alloc(0);
        oversized = false;
      }
      const rest = filled.subarray(start);
      oversized ||= carry.length + rest.length > 256 * 1024;
      if (!oversized && rest.length) carry = Buffer.concat([carry, rest]);
      at += bytes;
    }
    if (carry.length) {
      try {
        indexLine(carry);
        cache.offset += carry.length;
      } catch { /* Reread an incomplete tail when the writer appends to it. */ }
    }
    cache.temporal.sort((a, b) => a.at - b.at);
    Object.assign(cache, { size, mtimeMs });
    if (!ledgers.has(file) && ledgers.size >= 2) ledgers.delete(ledgers.keys().next().value);
    ledgers.set(file, cache);
    return cache;
  } catch {
    ledgers.delete(file);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function firstAtOrAfter(rows, time) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].at < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function windowFor(request) {
  const time = Date.parse(request.timestamp);
  const finished = Date.parse(request.finished_at);
  const end = Number.isFinite(finished) ? finished : request.active ? Date.now() : time;
  const explicitStart = Date.parse(request.started_at);
  const start = Number.isFinite(explicitStart) ? explicitStart
    : request.elapsed_sec != null ? end - request.elapsed_sec * 1000 : time;
  return { start, end, bounded: Number.isFinite(start) && end >= start };
}

function linkRows(cache, requests) {
  const claims = new Map();
  for (const request of requests) {
    const { start, end, bounded } = windowFor(request);
    const consult = request.mode === 'consult';
    const threads = [request.codex_thread_id, request.dispatchSessionId].filter(Boolean);
    const exact = consult ? cache.responses.get(request.response_id) || []
      : threads.flatMap((thread) => cache.threads.get(thread) || []);
    const models = [request.requested_model, request.sent_model, request.model, ...request.attemptedModels].filter(Boolean);
    const candidates = new Set(exact);
    if (bounded) {
      const rows = cache.temporal;
      for (let index = firstAtOrAfter(rows, start - WINDOW_MARGIN_MS); rows[index]?.at <= end + WINDOW_MARGIN_MS; index++) {
        candidates.add(rows[index]);
      }
    }
    const exactSet = new Set(exact);
    const eligible = [];
    for (const row of candidates) {
      const exactMatch = exactSet.has(row);
      if (!consult && row.endpoint && !row.endpoint.startsWith('/v1/responses')) continue;
      if (consult && !exactMatch && (row.websocket || row.threads.length)) continue;
      if (!consult && !exactMatch && (row.agent !== 'gempt' || !row.websocket || row.threads.length)) continue;
      if (!(consult && exactMatch) && (!bounded || row.at < start - WINDOW_MARGIN_MS || row.at > end + WINDOW_MARGIN_MS)) continue;
      if (!(consult && exactMatch) && models.length && !models.some((model) =>
        [row.requested_model, row.sent_model, row.model].some((candidate) => matchesModel(model, candidate)))) continue;
      if (!exactMatch && !models.length) continue;
      const failed = row.status_code >= 400;
      if (consult && !exactMatch) {
        if (request.response_id && row.response && !failed) continue;
        // Old consults have no response ID. Require a GemPT caller or a token fingerprint.
        const input = row.input_tokens == null ? null : row.input_tokens
          + (row.input_includes_cache ? 0 : row.cache_read_tokens ?? 0);
        if (row.agent !== 'gempt' && !(request.usage.output_tokens > 0
          && request.usage.output_tokens === row.output_tokens
          && request.usage.input_tokens != null && [row.input_tokens, input].includes(request.usage.input_tokens))) continue;
      }
      const distance = bounded ? Math.max(start - row.at, row.at - end, 0) : 0;
      eligible.push({ row, exactMatch, failed, distance });
    }
    const ambiguousConsult = consult && eligible.filter((item) => !item.exactMatch && !item.failed).length > 1;
    for (const { row, exactMatch, failed, distance } of eligible) {
      if (ambiguousConsult && !exactMatch && !failed) continue;
      const priority = exactMatch ? 1 : 0;
      const prior = claims.get(row);
      if (!prior || priority > prior.priority || (priority === prior.priority && distance < prior.distance)) {
        claims.set(row, { request, priority, distance });
      } else if (priority === prior.priority && distance === prior.distance) {
        prior.request = null;
      }
    }
  }
  const linked = new Map();
  for (const [row, { request }] of claims) {
    if (request) addIndex(linked, request, row);
  }
  return linked;
}

async function nativePrices(base, apiKey, query, rows, prices, signal) {
  const remaining = new Set(rows.map((row) => row.key));
  const earliest = rows.reduce((time, row) => Math.min(row.at, time), Infinity);
  const now = new Date();
  const day = 86_400_000;
  const period = earliest >= new Date(now).setHours(0, 0, 0, 0) ? 'today'
    : earliest >= now - 7 * day ? '7d' : earliest >= now - 30 * day ? '30d' : 'all';
  // The native endpoint is paginated. Search by session when the ledger has one.
  for (let offset = 0; remaining.size && offset < 5000;) {
    const url = new URL('/v1/magpie/usage/requests', base);
    url.search = new URLSearchParams({ period, limit: '500', offset, ...query });
    const res = await fetch(url, { redirect: 'error', signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!res.ok) break;
    const { rows: page, total } = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    for (const row of page) {
      const key = identity(row);
      if (remaining.delete(key)) prices.set(key, row.priced === false ? null : count(row.cost_usd ?? row.cost));
    }
    offset += page.length;
    if (offset >= total) break;
  }
}

async function fillPrices(cache, linked, { baseUrl, apiKey } = {}) {
  const groups = new Map();
  for (const rows of linked.values()) {
    for (const row of rows) {
      if (row.cost_usd != null || !row.key || !row.agent || cache.prices.has(row.key)) continue;
      const q = row.agent === 'gempt' ? '' : row.threads[0] || row.requested_model;
      addIndex(groups, JSON.stringify({ agent: row.agent, ...(q ? { q } : {}) }), row);
    }
  }
  if (!groups.size || !baseUrl) return;
  let base;
  try { base = new URL(baseUrl); } catch { return; }
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) return;
  if (!cache.priceFetch && !(cache.retryPricesAt > Date.now())) {
    cache.priceFetch = (async () => {
      const pending = [...groups].sort((a, b) => b[1].length - a[1].length);
      const signal = AbortSignal.timeout(8000);
      async function fetchGroup() {
        while (pending.length && !signal.aborted) {
          const [query, rows] = pending.shift();
          try { await nativePrices(base, apiKey, JSON.parse(query), rows, cache.prices, signal); }
          catch { /* Historical activity still works when Magpie is offline. */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, pending.length) }, fetchGroup));
      cache.retryPricesAt = Date.now() + 15_000;
    })().finally(() => { cache.priceFetch = null; });
  }
  await cache.priceFetch;
}

function gatewayDetail(row, prices) {
  const generated = row.output_tokens == null ? null : Math.max(0, row.output_tokens - (row.reasoning_tokens ?? 0));
  const first = row.first_text_ms ?? row.ttft_ms;
  const generation = first != null && row.duration_ms > first ? row.duration_ms - first : null;
  return {
    timestamp: new Date(row.at).toISOString(), route_id: row.route_id, response_id: row.response,
    endpoint: row.endpoint, requested_model: row.requested_model, sent_model: row.sent_model, model: row.model,
    provider: row.provider, account: row.account, status_code: row.status_code,
    input_tokens: row.input_tokens, output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens, cache_write_tokens: row.cache_write_tokens,
    reasoning_tokens: row.reasoning_tokens, input_includes_cache: row.input_includes_cache,
    cost_usd: row.cost_usd ?? prices.get(row.key) ?? null,
    ttft_ms: row.ttft_ms, duration_ms: row.duration_ms, generation_ms: generation,
    generated_tokens: generated,
    tokens_per_sec: row.tokens_per_sec ?? (generation && generated != null ? generated * 1000 / generation : null),
  };
}

export async function correlateGatewayUsage(file, requests, pricing) {
  if (!requests.length) return new Map();
  const cache = readLedger(file);
  if (!cache) return new Map();
  const linked = linkRows(cache, requests);
  await fillPrices(cache, linked, pricing);
  return new Map([...linked].map(([request, rows]) => [request, rows.sort((a, b) => a.at - b.at)
    .map((row) => gatewayDetail(row, cache.prices))]));
}

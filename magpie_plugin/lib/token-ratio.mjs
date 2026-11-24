/**
 * Gemini vs. GPT token-ratio telemetry for the MCP server and Magpie control panel.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isMainThread, workerData } from 'node:worker_threads';
import { createBackgroundWorker, serveBackgroundWorker } from './background-worker.mjs';
import { extname, join, resolve } from 'node:path';
import { WORKLOAD } from '../../core/assets.mjs';
import { readJsonSafe, resolveSessionsDir } from '../../core/config.mjs';

export const RATIO_RANGES = Object.freeze(['1h', '6h', 'today', '24h', '7d']);
const ROLLING_HOURS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
const HOUR_MS = 3_600_000;
const MIN_SAMPLE_TOKENS = 20_000;
export const OUTPUT_WEIGHT = 5;
export const MAX_USAGE_TAIL_BYTES = 16 * 1024 * 1024;
const USAGE_READ_CHUNK_BYTES = 256 * 1024;
const MAX_USAGE_LINE_BYTES = 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 15_000;
const MAX_MEM_CACHE_ENTRIES = 32;

const SWARM_COORD_TOOLS = new Set(['read_board', 'swarm_wait', 'post_message', 'swarm', 'schedule', 'manage_task']);
const VISION_TOOLS = new Set(['generate_image', 'browser_subagent']);
const GEMPT_TOOLS = new Set([
  'gempt_gempt', 'gpt_run', 'gpt_ask', 'gpt_ctl', 'gempt_run', 'gempt_ask', 'gempt_ctl', 'gempt-worker',
]);
const GEMPT_COMMAND = /(?:^|[;&|]\s*)(?:&\s+)?(?:"[^"\r\n]*[/\\]|'[^'\r\n]*[/\\]|[^\s"';&|]*[/\\]|["'])?(?:gempt-wait(?:\.cmd)?["']?|gempt(?:\.cmd)?["']?\s+(?:run|ask|steer|reply-tool))(?=\s|[;&|]|$)/i;
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg', '.mp4', '.mov', '.webm', '.wav', '.mp3', '.pdf']);

const _memCache = new Map();
const files = new Map();

function readCachedFile(path, stat, parse, variant = '') {
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${variant}`;
  const saved = files.get(path);
  if (saved?.signature === signature) return saved.value;
  const value = parse();
  if (value !== null) {
    files.delete(path);
    if (files.size >= 256) files.delete(files.keys().next().value);
    files.set(path, { signature, value });
  }
  return value;
}

function isUnderTmp(p) {
  if (!p) return false;
  try {
    const abs = resolve(String(p)).toLowerCase();
    const tmp = resolve(tmpdir()).toLowerCase();
    return abs === tmp || abs.startsWith(tmp + '\\') || abs.startsWith(tmp + '/');
  } catch {
    return false;
  }
}

export function resolveAgyBrainDir({ brainDir, configPath, magpieConfigDir, env = process.env } = {}) {
  if (brainDir !== undefined) {
    const raw = String(brainDir || '').trim();
    return raw ? resolve(raw) : '';
  }
  const envVal = String(env.GEMPT_AGY_BRAIN_DIR || '').trim();
  if (envVal) return resolve(envVal);
  for (const probe of [configPath, magpieConfigDir, env.GEMPT_CONFIG, env.GEMPT_SESSIONS_DIR, env.MAGPIE_CONFIG_DIR]) {
    if (isUnderTmp(probe)) return '';
  }
  return resolve(join(homedir(), '.gemini', 'antigravity', 'brain'));
}

export function resolveMagpieDir({ magpieConfigDir, configPath, env = process.env } = {}) {
  if (magpieConfigDir !== undefined) {
    const raw = String(magpieConfigDir || '').trim();
    return raw ? resolve(raw) : '';
  }
  const envVal = String(env.MAGPIE_CONFIG_DIR || '').trim();
  if (envVal) return resolve(envVal);
  for (const probe of [configPath, env.GEMPT_CONFIG, env.GEMPT_SESSIONS_DIR]) {
    if (isUnderTmp(probe)) return '';
  }
  return resolve(join(homedir(), '.config', 'magpie'));
}

function emptyBucket() {
  return { in: 0, out: 0, cache_read: 0, fresh: 0, work: 0, total: 0 };
}

function addTokens(bucket, inp, out, cacheRead) {
  const i = Math.max(0, Math.trunc(Number(inp) || 0));
  const o = Math.max(0, Math.trunc(Number(out) || 0));
  const c = Math.max(0, Math.trunc(Number(cacheRead) || 0));
  bucket.in += i;
  bucket.out += o;
  bucket.cache_read += c;
  bucket.fresh += i + o;
  bucket.work += i + OUTPUT_WEIGHT * o;
  bucket.total += i + o + c;
}

function mergeBucket(dst, src) {
  for (const key of Object.keys(dst)) {
    dst[key] += Number(src[key] || 0);
  }
}

function classifyToolCall(name, args) {
  if (!name) return 'other';
  if (SWARM_COORD_TOOLS.has(name)) return 'swarm';
  if (VISION_TOOLS.has(name)) return 'vision';
  if (name === 'read_file' || name === 'view_file') {
    const raw = String(args.Path || args.AbsolutePath || '').trim().replace(/^"|"$/g, '').toLowerCase();
    if (raw && MEDIA_EXTS.has(extname(raw.replace(/\\/g, '/')))) return 'vision';
  }
  return 'work';
}

function classifyModel(model, provider = '') {
  const m = String(model || '').trim().toLowerCase();
  const p = String(provider || '').trim().toLowerCase();
  if (m.includes('gpt') || p === 'codex' || p === 'openai' || m.startsWith('codex/') || m.startsWith('openai/')) {
    return 'gpt';
  }
  if (m.includes('gemini') || p === 'gemini' || p === 'google' || p === 'vertex' || p === 'antigravity') {
    return 'gemini';
  }
  return 'other';
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return Math.abs(ms) <= 8.64e15 ? ms : null;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

function isGemptToolCall(name, args) {
  return GEMPT_TOOLS.has(name.split('__').at(-1))
    || (name === 'call_mcp_tool' && (args.ServerName === 'gempt_gempt' || GEMPT_TOOLS.has(args.ToolName)))
    || (name === 'invoke_subagent' && args.TypeName === 'gempt-worker')
    || (name === 'run_command' && GEMPT_COMMAND.test(String(args.CommandLine || '').trim()));
}

function readTranscriptFile(filePath) {
  let text;
  try { text = readFileSync(filePath, 'utf-8'); } catch { return null; }
  const rows = [];
  let swarmParent;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('PLANNER_RESPONSE') && !(swarmParent === undefined && line.includes('SYSTEM_MESSAGE'))) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (swarmParent === undefined) {
      if (obj.type === 'SYSTEM_MESSAGE') {
        const notice = typeof obj.content === 'string'
          ? obj.content.split(/\r?\n/).find((part) => part.includes('[swarm] new board message')) : '';
        swarmParent = notice?.match(/\bsender=([a-z0-9._-]+)(?=\s|$)/i)?.[1] || null;
      } else if (obj.type === 'PLANNER_RESPONSE') {
        swarmParent = null;
      }
    }
    if (obj.type !== 'PLANNER_RESPONSE') continue;
    const ts = parseTimestampMs(obj.created_at);
    if (ts === null) continue;
    let mask = 0;
    for (const tc of (Array.isArray(obj.tool_calls) ? obj.tool_calls : [])) {
      const name = String(tc?.name || tc?.tool_name || '').trim();
      const args = tc?.args || tc?.arguments || {};
      if (isGemptToolCall(name, args)) mask |= 1;
      const cat = classifyToolCall(name, args);
      if (cat === 'work') mask |= 2;
      else if (cat === 'swarm' || cat === 'vision') mask |= 4;
    }
    rows.push([ts, mask, classifyModel(obj.model || '') === 'gpt', obj.input_tokens, obj.output_tokens, obj.cache_read_tokens]);
  }
  return { rows, swarmParent };
}

function scanTranscriptFile(filePath, stat, cutoffMs, nowMs) {
  // Small transcripts can be overwritten within one filesystem clock tick.
  // Reading them directly is cheap and avoids reusing an ambiguous signature.
  const file = stat.size < 4096n ? readTranscriptFile(filePath)
    : readCachedFile(filePath, stat, () => readTranscriptFile(filePath));
  if (!file) return null;
  const gemini = emptyBucket();
  const gpt = emptyBucket();
  let flags = 0;
  for (const [ts, mask, isGpt, input, output, cache] of file.rows) {
    if (ts < cutoffMs || ts > nowMs) continue;
    flags |= mask;
    addTokens(isGpt ? gpt : gemini, input, output, cache);
  }
  return { gemini, gpt, swarmParent: file.swarmParent, gemptActive: Boolean(flags & 1),
    excluded: !(flags & 2) && Boolean(flags & 4) };
}

function listDirectories(dir) {
  if (!dir) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function recentRunConversations(sessionsDir, cutoffMs, nowMs) {
  const runsDir = join(sessionsDir, 'runs');
  const conversations = new Set();
  for (const entry of listDirectories(runsDir)) {
    const path = join(runsDir, entry.name, 'state.json');
    let stat;
    try {
      stat = statSync(path);
      if (stat.mtimeMs < cutoffMs) continue;
    } catch {
      continue;
    }
    const run = readJsonSafe(path);
    if (typeof run?.host_conversation_id !== 'string' || !run.host_conversation_id) continue;
    const timestamps = [run.created_at, run.started_at, run.finished_at, run.updated_at, run.progress?.updated_at]
      .map(parseTimestampMs).filter((time) => time !== null);
    if ((timestamps.length ? timestamps : [Math.trunc(stat.mtimeMs)]).some((time) => time >= cutoffMs && time <= nowMs)) {
      conversations.add(run.host_conversation_id);
    }
  }
  return conversations;
}

function scanAgyBrain(brainDir, sessionsDir, cutoffMs, nowMs, gemini, gpt) {
  const entries = listDirectories(brainDir);
  const activeHosts = entries.length ? recentRunConversations(sessionsDir, cutoffMs, nowMs) : new Set();
  const unmarkedGemini = emptyBucket();
  const unmarkedGpt = emptyBucket();
  let hasGemptActivity = false;
  let filesScanned = 0;
  let excludedSessions = 0;
  let unmarkedSessions = 0;
  const swarmWorkers = [];
  const collect = (usage, active, linkedWorker = false) => {
    hasGemptActivity ||= active;
    if (usage.excluded && !linkedWorker) {
      excludedSessions += 1;
    } else if (active) {
      mergeBucket(gemini, usage.gemini);
      mergeBucket(gpt, usage.gpt);
    } else {
      unmarkedSessions += 1;
      mergeBucket(unmarkedGemini, usage.gemini);
      mergeBucket(unmarkedGpt, usage.gpt);
    }
  };
  for (const entry of entries) {
    const transcript = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    let st;
    try {
      st = statSync(transcript, { bigint: true });
    } catch {
      continue;
    }
    if (Number(st.mtimeMs) < cutoffMs) continue;
    filesScanned += 1;
    const usage = scanTranscriptFile(transcript, st, cutoffMs, nowMs);
    if (!usage) continue;
    if (usage.gemptActive) activeHosts.add(entry.name);
    if (usage.swarmParent && usage.swarmParent !== entry.name) {
      swarmWorkers.push({ id: entry.name, usage });
    } else {
      collect(usage, activeHosts.has(entry.name));
    }
  }
  for (const { id, usage } of swarmWorkers) {
    const linkedWorker = activeHosts.has(usage.swarmParent);
    collect(usage, linkedWorker || activeHosts.has(id), linkedWorker);
  }
  if (!hasGemptActivity) {
    mergeBucket(gemini, unmarkedGemini);
    mergeBucket(gpt, unmarkedGpt);
  }
  return {
    filesScanned, excludedSessions,
    skippedNonGemptSessions: hasGemptActivity ? unmarkedSessions : 0,
    scope: hasGemptActivity ? 'gempt_active_sessions' : 'all_sessions',
  };
}

function readUsageRows(usageFile, size, start) {
  const truncated = start > 0;
  const rows = [];
  const processLine = (buf) => {
    const raw = buf.toString('utf-8').trim();
    if (!raw) return;
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    const ts = parseTimestampMs(obj.t ?? obj.created_at ?? obj.timestamp);
    if (ts === null) return;
    const cls = classifyModel(obj.served || obj.model || obj.req, obj.provider);
    rows.push([ts, cls, obj.in !== undefined ? obj.in : obj.input_tokens,
      obj.out !== undefined ? obj.out : obj.output_tokens,
      obj.cache_read !== undefined ? obj.cache_read : obj.cache_read_tokens]);
  };

  let fd;
  try {
    fd = openSync(usageFile, 'r');
    const chunk = Buffer.alloc(Math.min(USAGE_READ_CHUNK_BYTES, size - start));
    let carry = Buffer.alloc(0);
    let oversized = false;
    let skipFirst = truncated;
    for (let pos = start; pos < size;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (n <= 0) break;
      const slice = chunk.subarray(0, n);
      let lineStart = 0;
      for (let nl; (nl = slice.indexOf(10, lineStart)) >= 0; lineStart = nl + 1) {
        if (skipFirst) {
          skipFirst = false;
        } else if (!oversized && carry.length + nl - lineStart <= MAX_USAGE_LINE_BYTES) {
          const part = slice.subarray(lineStart, nl);
          processLine(carry.length ? Buffer.concat([carry, part]) : part);
        }
        carry = Buffer.alloc(0);
        oversized = false;
      }
      const rest = slice.subarray(lineStart);
      if (!skipFirst) {
        oversized ||= carry.length + rest.length > MAX_USAGE_LINE_BYTES;
        if (!oversized && rest.length) carry = Buffer.concat([carry, rest]);
      }
      pos += n;
    }
    if (!skipFirst && !oversized && carry.length) {
      processLine(carry);
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return rows;
}

function scanMagpieUsage(magpieDir, cutoffMs, nowMs, gemini, gpt, other, maxTailBytes) {
  const empty = { matched: 0, truncated: false };
  if (!magpieDir) return empty;
  const usageFile = join(magpieDir, 'usage.jsonl');
  let stat;
  try { stat = statSync(usageFile, { bigint: true }); } catch { return empty; }
  const size = Number(stat.size);
  if (!size) return empty;
  const tailLimit = Number.isFinite(maxTailBytes) && maxTailBytes > 0 ? Math.trunc(maxTailBytes) : MAX_USAGE_TAIL_BYTES;
  const start = Math.max(0, size - tailLimit);
  const rows = readCachedFile(usageFile, stat, () => readUsageRows(usageFile, size, start), start);
  let matched = 0;
  const buckets = { gemini, gpt, other };
  for (const [ts, cls, input, output, cache] of rows || []) {
    if (ts < cutoffMs || ts > nowMs) continue;
    addTokens(buckets[cls], input, output, cache);
    matched++;
  }
  return { matched, truncated: start > 0 };
}

export function readTokenRatio({
  windowHours,
  range = windowHours === undefined ? '24h' : 'custom',
  configPath,
  sessionsDir,
  brainDir,
  magpieConfigDir,
  maxUsageTailBytes = MAX_USAGE_TAIL_BYTES,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  nowMs,
  requestTime,
  env = process.env,
} = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : (requestTime ?? Date.now());
  const customHours = Number(windowHours);
  const selectedRange = RATIO_RANGES.includes(range) ? range
    : Number.isFinite(customHours) && customHours > 0 ? 'custom' : '24h';
  const hours = selectedRange === 'custom' ? Math.max(1, customHours) : ROLLING_HOURS[selectedRange];
  const localNow = new Date(now);
  const midnight = selectedRange === 'today'
    ? new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate()).getTime() : null;
  const cutoffMs = midnight ?? now - hours * HOUR_MS;
  const resolvedBrain = resolveAgyBrainDir({ brainDir, configPath, magpieConfigDir, env });
  const resolvedMagpie = resolveMagpieDir({ magpieConfigDir, configPath, env });
  const resolvedSessions = resolveSessionsDir(sessionsDir || env.GEMPT_SESSIONS_DIR);
  const cacheKey = JSON.stringify([selectedRange, midnight ?? hours, resolvedBrain, resolvedMagpie, resolvedSessions, maxUsageTailBytes]);

  if (cacheTtlMs > 0 && !Number.isFinite(nowMs)) {
    const hit = _memCache.get(cacheKey);
    if (hit && now >= hit.ts && (now - hit.ts) <= cacheTtlMs) {
      return hit.snapshot;
    }
  }

  const gemini = emptyBucket();
  const gpt = emptyBucket();
  const other = emptyBucket();

  const { filesScanned: agyFiles, excludedSessions, skippedNonGemptSessions, scope } =
    scanAgyBrain(resolvedBrain, resolvedSessions, cutoffMs, now, gemini, gpt);
  const { matched: magpieRecords, truncated: usageTruncated } =
    scanMagpieUsage(resolvedMagpie, cutoffMs, now, gemini, gpt, other, maxUsageTailBytes);

  const combinedWork = gemini.work + gpt.work;
  const combinedFresh = gemini.fresh + gpt.fresh;
  const combinedTotal = gemini.total + gpt.total;
  const actualGptWorkShare = combinedWork > 0 ? Math.round((gpt.work / combinedWork) * 1000) / 10 : null;
  const actualGptFreshShare = combinedFresh > 0 ? Math.round((gpt.fresh / combinedFresh) * 1000) / 10 : null;
  const actualGptTotalShare = combinedTotal > 0 ? Math.round((gpt.total / combinedTotal) * 1000) / 10 : null;
  const actualGptShare = actualGptWorkShare;
  const actualGeminiShare = actualGptShare !== null ? Math.round((100 - actualGptShare) * 10) / 10 : null;

  const snapshot = {
    range: selectedRange,
    window_hours: (now - cutoffMs) / HOUR_MS,
    metric: 'attributable_work_in_plus_5out',
    scope,
    truncated: usageTruncated,
    gemini,
    gpt,
    other,
    combined_work: combinedWork,
    combined_fresh: combinedFresh,
    combined_total: combinedTotal,
    actual_gpt_share: actualGptShare,
    actual_gemini_share: actualGeminiShare,
    actual_gpt_work_share: actualGptWorkShare,
    actual_gpt_fresh_share: actualGptFreshShare,
    actual_gpt_total_share: actualGptTotalShare,
    sources: {
      agy_files: agyFiles, excluded_sessions: excludedSessions,
      skipped_non_gempt_sessions: skippedNonGemptSessions, magpie_records: magpieRecords,
      usage_truncated: usageTruncated,
    },
    computed_at: new Date(now).toISOString(),
  };

  if (cacheTtlMs > 0 && !Number.isFinite(nowMs)) {
    if (!_memCache.has(cacheKey) && _memCache.size >= MAX_MEM_CACHE_ENTRIES) {
      _memCache.delete(_memCache.keys().next().value);
    }
    _memCache.set(cacheKey, { ts: now, snapshot });
  }
  return snapshot;
}

export function resolveBudget(profile, options = {}) {
  const snapshot = readTokenRatio(options);
  const target = (WORKLOAD.profiles[profile] || WORKLOAD.profiles.balanced).gpt_share;
  const status = target === 0 ? 'off' : snapshot.combined_total === 0 ? 'no_data'
    : snapshot.combined_work < MIN_SAMPLE_TOKENS ? 'warming_up' : 'observing';
  return {
    status,
    metric: snapshot.metric,
    profile,
    range: snapshot.range,
    scope: snapshot.scope,
    truncated: snapshot.truncated,
    target_gpt_share: target,
    actual_gpt_share: snapshot.actual_gpt_share,
    actual_gemini_share: snapshot.actual_gemini_share,
    actual_gpt_fresh_share: snapshot.actual_gpt_fresh_share,
    actual_gpt_total_share: snapshot.actual_gpt_total_share,
    gemini_work_tokens: snapshot.gemini.work,
    gpt_work_tokens: snapshot.gpt.work,
    gemini_tokens: snapshot.gemini.total,
    gpt_tokens: snapshot.gpt.total,
    combined_work: snapshot.combined_work,
    combined_total: snapshot.combined_total,
    skipped_non_gempt_sessions: snapshot.sources.skipped_non_gempt_sessions,
    window_hours: snapshot.window_hours,
  };
}


// The idle worker retains its per-file and window caches between requests.
const budgetWorker = createBackgroundWorker(new URL(import.meta.url), 'gempt-token-ratio');

export function resolveBudgetAsync(profile, options) {
  return budgetWorker(profile, { ...options, requestTime: Date.now() });
}

if (!isMainThread && workerData === 'gempt-token-ratio') serveBackgroundWorker(resolveBudget);

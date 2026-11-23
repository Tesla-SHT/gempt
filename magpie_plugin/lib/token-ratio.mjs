/**
 * Gemini vs. GPT token-ratio telemetry for the MCP server and Magpie control panel.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg', '.mp4', '.mov', '.webm', '.wav', '.mp3', '.pdf']);

const _memCache = new Map();

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
    || (name === 'invoke_subagent' && args.TypeName === 'gempt-worker');
}

function scanTranscriptFile(filePath, cutoffMs, nowMs) {
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const fileGem = emptyBucket();
  const fileGpt = emptyBucket();
  let workCalls = 0;
  let swarmCalls = 0;
  let visionCalls = 0;
  let gemptActive = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('PLANNER_RESPONSE')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || obj.type !== 'PLANNER_RESPONSE') continue;
    const ts = parseTimestampMs(obj.created_at);
    if (ts === null || ts < cutoffMs || ts > nowMs) continue;
    for (const tc of (Array.isArray(obj.tool_calls) ? obj.tool_calls : [])) {
      const name = String(tc?.name || tc?.tool_name || '').trim();
      const args = tc?.args || tc?.arguments || {};
      gemptActive ||= isGemptToolCall(name, args);
      const cat = classifyToolCall(name, args);
      if (cat === 'swarm') swarmCalls += 1;
      else if (cat === 'vision') visionCalls += 1;
      else if (cat === 'work') workCalls += 1;
    }
    const cls = classifyModel(obj.model || '');
    const bucket = cls === 'gpt' ? fileGpt : fileGem;
    addTokens(bucket, obj.input_tokens, obj.output_tokens, obj.cache_read_tokens);
  }
  const excluded = workCalls === 0 && (swarmCalls > 0 || visionCalls > 0);
  return { gemini: fileGem, gpt: fileGpt, gemptActive, excluded };
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
    let mtimeMs;
    try {
      mtimeMs = statSync(path).mtimeMs;
      if (mtimeMs < cutoffMs) continue;
    } catch {
      continue;
    }
    const run = readJsonSafe(path);
    if (typeof run?.host_conversation_id !== 'string' || !run.host_conversation_id) continue;
    const timestamps = [run.created_at, run.started_at, run.finished_at, run.updated_at, run.progress?.updated_at]
      .map(parseTimestampMs).filter((time) => time !== null);
    if ((timestamps.length ? timestamps : [Math.trunc(mtimeMs)]).some((time) => time >= cutoffMs && time <= nowMs)) {
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
  for (const entry of entries) {
    const transcript = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    let st;
    try {
      st = statSync(transcript);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMs) continue;
    filesScanned += 1;
    const usage = scanTranscriptFile(transcript, cutoffMs, nowMs);
    if (!usage) continue;
    const active = usage.gemptActive || activeHosts.has(entry.name);
    hasGemptActivity ||= active;
    if (usage.excluded) {
      excludedSessions += 1;
    } else if (active) {
      mergeBucket(gemini, usage.gemini);
      mergeBucket(gpt, usage.gpt);
    } else {
      unmarkedSessions += 1;
      mergeBucket(unmarkedGemini, usage.gemini);
      mergeBucket(unmarkedGpt, usage.gpt);
    }
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

function scanMagpieUsage(magpieDir, cutoffMs, nowMs, gemini, gpt, other, maxTailBytes = MAX_USAGE_TAIL_BYTES) {
  if (!magpieDir) return { matched: 0, truncated: false };
  const usageFile = join(magpieDir, 'usage.jsonl');
  let size = 0;
  try {
    size = statSync(usageFile).size;
  } catch {
    return { matched: 0, truncated: false };
  }
  if (size <= 0) return { matched: 0, truncated: false };
  const tailLimit = Number.isFinite(maxTailBytes) && maxTailBytes > 0 ? Math.trunc(maxTailBytes) : MAX_USAGE_TAIL_BYTES;
  const start = Math.max(0, size - tailLimit);
  const truncated = start > 0;
  let matched = 0;

  const processLine = (buf) => {
    const raw = buf.toString('utf-8').trim();
    if (!raw) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const ts = parseTimestampMs(obj.t ?? obj.created_at ?? obj.timestamp);
    if (ts === null || ts < cutoffMs || ts > nowMs) return;
    const model = String(obj.served || obj.model || obj.req || '');
    const provider = String(obj.provider || '');
    const cls = classifyModel(model, provider);
    const bucket = cls === 'gpt' ? gpt : (cls === 'gemini' ? gemini : other);
    addTokens(
      bucket,
      obj.in !== undefined ? obj.in : obj.input_tokens,
      obj.out !== undefined ? obj.out : obj.output_tokens,
      obj.cache_read !== undefined ? obj.cache_read : obj.cache_read_tokens,
    );
    matched += 1;
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
    return { matched: 0, truncated };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return { matched, truncated };
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
  env = process.env,
} = {}) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
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

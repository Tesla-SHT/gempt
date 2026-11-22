/**
 * Live Gemini vs. GPT token-ratio telemetry and closed-loop work-split budget controller.
 * Mirrors src/gempt/token_ratio.py so Python MCP, Antigravity hooks, Magpie tools,
 * and the Magpie Overview UI always agree on the exact same numbers and thresholds.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKLOAD = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'gempt', 'workload.json'), 'utf8'));

export const KIND_LADDER = Object.freeze(['specialist', 'engineering', 'design', 'routine']);
export const MIN_SAMPLE_TOKENS = 200_000;
export const UNDER_MARGIN = 6.0;
export const STRONG_UNDER_MARGIN = 18.0;
export const OVER_MARGIN = 8.0;
const MAX_USAGE_TAIL_BYTES = 16 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 15_000;

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
  return { in: 0, out: 0, cache_read: 0, fresh: 0, total: 0 };
}

function addTokens(bucket, inp, out, cacheRead) {
  const i = Math.max(0, Math.trunc(Number(inp) || 0));
  const o = Math.max(0, Math.trunc(Number(out) || 0));
  const c = Math.max(0, Math.trunc(Number(cacheRead) || 0));
  bucket.in += i;
  bucket.out += o;
  bucket.cache_read += c;
  bucket.fresh += i + o;
  bucket.total += i + o + c;
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
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

function scanTranscriptFile(filePath, cutoffMs, gemini, gpt) {
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
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
    if (ts !== null && ts < cutoffMs) continue;
    const cls = classifyModel(obj.model || '');
    const bucket = cls === 'gpt' ? gpt : gemini;
    addTokens(bucket, obj.input_tokens, obj.output_tokens, obj.cache_read_tokens);
  }
}

function scanAgyBrain(brainDir, cutoffMs, gemini, gpt) {
  if (!brainDir || !existsSync(brainDir)) return 0;
  let entries;
  try {
    entries = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let filesScanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transcript = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    let st;
    try {
      st = statSync(transcript);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMs) continue;
    filesScanned += 1;
    scanTranscriptFile(transcript, cutoffMs, gemini, gpt);
  }
  return filesScanned;
}

function scanMagpieUsage(magpieDir, cutoffMs, gemini, gpt, other) {
  if (!magpieDir) return 0;
  const usageFile = join(magpieDir, 'usage.jsonl');
  let size = 0;
  try {
    size = statSync(usageFile).size;
  } catch {
    return 0;
  }
  if (size <= 0) return 0;
  const start = Math.max(0, size - MAX_USAGE_TAIL_BYTES);
  let text = '';
  let fd;
  try {
    fd = openSync(usageFile, 'r');
    const len = size - start;
    const buf = Buffer.alloc(len);
    let readBytes = 0;
    while (readBytes < len) {
      const n = readSync(fd, buf, readBytes, len - readBytes, start + readBytes);
      if (n <= 0) break;
      readBytes += n;
    }
    text = buf.subarray(0, readBytes).toString('utf-8');
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  let lines = text.split(/\r?\n/);
  if (start > 0 && lines.length > 0) lines = lines.slice(1);

  let matched = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const ts = parseTimestampMs(obj.t || obj.created_at || obj.timestamp);
    if (ts !== null && ts < cutoffMs) continue;
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
  }
  return matched;
}

export function dynamicBudgetEnabled(policy = {}, env = process.env) {
  const envFlag = String(env?.GEMPT_DYNAMIC_BUDGET || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(envFlag)) return false;
  if (['1', 'true', 'yes', 'on'].includes(envFlag)) return true;
  if (policy && typeof policy === 'object' && policy.dynamic_budget === false) return false;
  return true;
}

export function readTokenRatio({
  windowHours = 24,
  configPath,
  brainDir,
  magpieConfigDir,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  nowMs,
  env = process.env,
} = {}) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const resolvedBrain = resolveAgyBrainDir({ brainDir, configPath, magpieConfigDir, env });
  const resolvedMagpie = resolveMagpieDir({ magpieConfigDir, configPath, env });
  const cacheKey = `${windowHours}|${resolvedBrain}|${resolvedMagpie}`;

  if (cacheTtlMs > 0 && !Number.isFinite(nowMs)) {
    const hit = _memCache.get(cacheKey);
    if (hit && (now - hit.ts) <= cacheTtlMs) {
      return hit.snapshot;
    }
  }

  const cutoffMs = now - Math.max(1, Number(windowHours) || 24) * 3_600_000;
  const gemini = emptyBucket();
  const gpt = emptyBucket();
  const other = emptyBucket();

  const agyFiles = scanAgyBrain(resolvedBrain, cutoffMs, gemini, gpt);
  const magpieRecords = scanMagpieUsage(resolvedMagpie, cutoffMs, gemini, gpt, other);

  const combinedTotal = gemini.total + gpt.total;
  const combinedFresh = gemini.fresh + gpt.fresh;
  const actualGptShare = combinedTotal > 0 ? Math.round((gpt.total / combinedTotal) * 1000) / 10 : null;
  const actualGeminiShare = actualGptShare !== null ? Math.round((100 - actualGptShare) * 10) / 10 : null;
  const actualGptFreshShare = combinedFresh > 0 ? Math.round((gpt.fresh / combinedFresh) * 1000) / 10 : null;

  const snapshot = {
    window_hours: windowHours,
    gemini,
    gpt,
    other,
    combined_total: combinedTotal,
    combined_fresh: combinedFresh,
    actual_gpt_share: actualGptShare,
    actual_gemini_share: actualGeminiShare,
    actual_gpt_fresh_share: actualGptFreshShare,
    sources: { agy_files: agyFiles, magpie_records: magpieRecords },
    computed_at: new Date(now).toISOString(),
  };

  if (cacheTtlMs > 0 && !Number.isFinite(nowMs)) {
    _memCache.set(cacheKey, { ts: now, snapshot });
  }
  return snapshot;
}

export function evaluateBudget(profile, snapshot, { enabled = true } = {}) {
  const plan = WORKLOAD.profiles[profile] || WORKLOAD.profiles.balanced;
  const target = Number(plan.gpt_share || 0);
  const baseKinds = [...(plan.kinds || [])];
  const snap = snapshot || {};
  const gemini = snap.gemini || emptyBucket();
  const gpt = snap.gpt || emptyBucket();
  const combinedTotal = Number(snap.combined_total || (gemini.total + gpt.total));
  const actual = typeof snap.actual_gpt_share === 'number' ? snap.actual_gpt_share : null;
  const actualGem = typeof snap.actual_gemini_share === 'number' ? snap.actual_gemini_share : null;
  const actualFresh = typeof snap.actual_gpt_fresh_share === 'number' ? snap.actual_gpt_fresh_share : null;
  const delta = actual !== null ? Math.round((actual - target) * 10) / 10 : null;

  let effectiveKinds = [...baseKinds];
  let adjustment = 'balanced';

  if (!baseKinds.length || target <= 0) {
    effectiveKinds = [];
    adjustment = 'off';
  } else if (!enabled) {
    adjustment = 'disabled';
  } else if (combinedTotal < MIN_SAMPLE_TOKENS || actual === null) {
    adjustment = 'warming_up';
  } else if (target >= 95) {
    effectiveKinds = [...KIND_LADDER];
    adjustment = actual < (target - UNDER_MARGIN) ? 'under_target' : 'balanced';
  } else if (delta <= -STRONG_UNDER_MARGIN) {
    const maxCap = target <= 50 ? 3 : KIND_LADDER.length;
    const count = Math.min(maxCap, baseKinds.length + 2);
    effectiveKinds = KIND_LADDER.slice(0, count);
    adjustment = 'widened_strong';
  } else if (delta < -UNDER_MARGIN) {
    const count = Math.min(KIND_LADDER.length, baseKinds.length + 1);
    effectiveKinds = KIND_LADDER.slice(0, count);
    adjustment = 'widened';
  } else if (delta > OVER_MARGIN) {
    if (baseKinds.length > 1) {
      effectiveKinds = KIND_LADDER.slice(0, baseKinds.length - 1);
      adjustment = 'tightened';
    } else {
      effectiveKinds = [...baseKinds];
      adjustment = 'over_target';
    }
  } else {
    effectiveKinds = [...baseKinds];
    adjustment = 'balanced';
  }

  return {
    enabled: Boolean(enabled),
    profile,
    target_gpt_share: target,
    actual_gpt_share: actual,
    actual_gemini_share: actualGem,
    actual_gpt_fresh_share: actualFresh,
    delta,
    adjustment,
    base_kinds: baseKinds,
    effective_kinds: effectiveKinds,
    gemini_tokens: Number(gemini.total || 0),
    gpt_tokens: Number(gpt.total || 0),
    gemini_fresh_tokens: Number(gemini.fresh || 0),
    gpt_fresh_tokens: Number(gpt.fresh || 0),
    combined_total: combinedTotal,
    window_hours: snap.window_hours || 24,
  };
}

export function resolveBudget(profile, { policy, configPath, brainDir, magpieConfigDir, windowHours = 24, cacheTtlMs = DEFAULT_CACHE_TTL_MS, env = process.env } = {}) {
  const enabled = dynamicBudgetEnabled(policy, env);
  const snapshot = readTokenRatio({ windowHours, configPath, brainDir, magpieConfigDir, cacheTtlMs, env });
  return evaluateBudget(profile, snapshot, { enabled });
}

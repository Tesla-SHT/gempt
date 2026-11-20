/**
 * Zero-dependency backend helpers for the GemPT Magpie page service.
 *
 * Reads redacted configuration from ~/.config/gempt/config.json (or GEMPT_CONFIG),
 * probes local Magpie /v1/models without system proxies, initializes Codex
 * subscription-only routing configs, summarizes recent sessions/runs, and
 * atomically persists default_tier and default_sandbox changes.
 */
import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isAstraModel } from './routing.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const WORKLOAD = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'gempt', 'workload.json'), 'utf8'));

export const TIER_ORDER = ['sonnet', 'opus', 'fable'];
export const TIER_ALIASES = { lite: 'sonnet', mid: 'opus', max: 'fable' };
export const VALID_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const EFFORT_RANK = Object.freeze(Object.fromEntries(VALID_EFFORTS.map((name, idx) => [name, idx])));
export const VALID_FAILOVER_MODES = ['subscription_only', 'api_fallback'];
export const FEATURES = Object.freeze({ api_fallback: true });
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425';

const NATIVE_GROUP_SPECS = [
  { id: 'sonnet', name: 'gempt-sonnet', group_id: 'group/gempt-sonnet' },
  { id: 'opus', name: 'gempt-opus', group_id: 'group/gempt-opus' },
  { id: 'fable', name: 'gempt-fable', group_id: 'group/gempt-fable' },
];

const CLIENT_LABELS = {
  agy: 'Antigravity',
  claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  zcode: 'ZCode',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  dsh: 'Shell / CLI',
  kimi: 'Kimi CLI',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder',
  'workbuddy-ai': 'WorkBuddy',
  commandcode: 'CommandCode',
  mimocode: 'MimoCode',
};

export const DEFAULT_TIERS = {
  sonnet: {
    label: 'Sonnet · 日常高频',
    usage_share: '~75%',
    when_to_use: '约 75% 日常开发、UI/前端、单测与常规修改',
    consult_model: 'codex/gpt-6.2-sol',
    exec_model: '',
    reasoning_effort: 'medium',
    api_mode: 'responses',
    max_output_tokens: 16384,
    fallback_models: [],
    magpie_group_members: [],
  },
  opus: {
    label: 'Opus · 复杂工程',
    usage_share: '~20%',
    when_to_use: '约 20% 跨文件重构、复杂排查与架构设计（Sol @ high + 疑难 @ xhigh 升 Astra）',
    consult_model: 'codex/gpt-6.2-sol',
    exec_model: '',
    escalate_model: 'codex/gpt-6.2-astra',
    escalate_effort_threshold: 'xhigh',
    reasoning_effort: 'high',
    api_mode: 'responses',
    max_output_tokens: 24576,
    fallback_models: [],
    magpie_group_members: [],
  },
  fable: {
    label: 'Fable · 顶配攻坚',
    usage_share: '~5%',
    when_to_use: '约 5% 极难 Bug、核心算法/数学推导、长程架构攻坚',
    consult_model: 'codex/gpt-6.2-astra',
    exec_model: '',
    reasoning_effort: 'xhigh',
    api_mode: 'responses',
    max_output_tokens: 32768,
    fallback_models: [],
    magpie_group_members: [],
  },
};

export const DEFAULT_UTILITY = {
  label: 'Chore · 免费打杂/压缩/分类',
  model: 'auto/deepseek-v4.1-flash',
  reasoning_effort: 'low',
  api_mode: 'chat',
  max_output_tokens: 4096,
  fallback_models: [],
  use_for_magpie_compact: true,
  use_as_classifier: false,
};

export function expandUser(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

const CODEX_MODEL_RE = /^codex\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.-]+)?$/;

export function isCodexModelId(modelId) {
  return CODEX_MODEL_RE.test(String(modelId || '').trim());
}

export function resolveConfigPath(explicit) {
  const raw = typeof explicit === 'string' && explicit.trim()
    ? explicit.trim()
    : (process.env.GEMPT_CONFIG || '').trim();
  if (raw) return resolve(expandUser(raw));
  return resolve(join(homedir(), '.config', 'gempt', 'config.json'));
}

export function resolveSessionsDir(explicit) {
  const raw = typeof explicit === 'string' && explicit.trim()
    ? explicit.trim()
    : (process.env.GEMPT_SESSIONS_DIR || '').trim();
  if (raw) return resolve(expandUser(raw));
  return resolve(join(homedir(), '.config', 'gempt', 'sessions'));
}

export function resolveMagpieConfigDir(explicit) {
  const raw = typeof explicit === 'string' && explicit.trim()
    ? explicit.trim()
    : (process.env.MAGPIE_CONFIG_DIR || '').trim();
  if (raw) return resolve(expandUser(raw));
  return resolve(join(homedir(), '.config', 'magpie'));
}

export function normalizeDefaultTier(value) {
  const raw = String(value || '').trim().toLowerCase();
  const mapped = TIER_ALIASES[raw] || raw;
  return TIER_ORDER.includes(mapped) ? mapped : '';
}

export function defaultGatewayFromEnv() {
  let raw = String(process.env.MAGPIE_ADDR || process.env.MAGPIE_GATEWAY || '').trim();
  if (!raw) return DEFAULT_MAGPIE_URL;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_MAGPIE_URL;
  }
}

export function readJsonSafe(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function discoverLocalMagpieClientKey() {
  const candidates = [
    join(homedir(), '.zcode', 'v2', 'config.json'),
    join(homedir(), '.zcode', 'cli', 'config.json'),
  ];
  for (const candidate of candidates) {
    const data = readJsonSafe(candidate);
    const key = data?.provider?.magpie?.options?.apiKey;
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  return '';
}

export function resolveMagpieApiKey(cfg, targetUrl = '') {
  const magpieCfg = cfg?.magpie || {};
  const endpoint = String(magpieCfg.base_url || DEFAULT_MAGPIE_URL).replace(/\/+$/, '');
  const cleanTarget = String(targetUrl || '').replace(/\/+$/, '');
  if (cleanTarget && cleanTarget !== endpoint) {
    return '';
  }
  const trusted = String(process.env.GEMPT_TRUSTED_GATEWAY || DEFAULT_MAGPIE_URL).replace(/\/+$/, '');
  if (endpoint !== trusted) {
    return String(magpieCfg.api_key || '').trim();
  }
  const envName = String(magpieCfg.api_key_env || 'GEMPT_MAGPIE_API_KEY').trim();
  if (envName) {
    const envVal = String(process.env[envName] || '').trim();
    if (envVal) return envVal;
  }
  const cfgVal = String(magpieCfg.api_key || '').trim();
  if (cfgVal) return cfgVal;
  if (endpoint !== DEFAULT_MAGPIE_URL) return '';
  return discoverLocalMagpieClientKey() || 'magpie';
}

export function resolveExcludedTokens(cfg) {
  const tokens = new Set();
  for (const part of String(process.env.GEMPT_EXCLUDED_MODELS || '').split(',')) {
    const t = part.trim().toLowerCase();
    if (t) tokens.add(t);
  }
  const cfgList = cfg?.routing_policy?.excluded_models;
  if (Array.isArray(cfgList)) {
    for (const item of cfgList) {
      const t = String(item || '').trim().toLowerCase();
      if (t) tokens.add(t);
    }
  }
  return [...tokens];
}

function isExcludedModel(id, excludedTokens) {
  const lower = String(id || '').toLowerCase();
  return excludedTokens.some((tok) => lower.includes(tok));
}

function isGptOrCodexModel(item) {
  const mid = String(item?.id || '').toLowerCase();
  const owned = String(item?.owned_by || '').toLowerCase();
  if (owned === 'codex' || owned === 'openai') return true;
  if (mid.startsWith('codex/') || mid.startsWith('openai/')) return true;
  return mid.includes('gpt');
}

function isUtilityCandidate(item, excludedTokens) {
  const mid = String(item?.id || '').toLowerCase();
  if (!mid || isExcludedModel(mid, excludedTokens) || isGptOrCodexModel(item)) return false;
  if (mid.includes('gemini')) return false;
  return ['deepseek', '-flash', '-free', 'glm-5.3-flash', 'qwen3.8-flash'].some((tok) => mid.includes(tok));
}

function utilityRankScore(modelId) {
  const mid = String(modelId || '').toLowerCase();
  let score = 0;
  if (mid === 'auto/deepseek-v4.1-flash') score += 650;
  else if ((mid.startsWith('workbuddy/') || mid.startsWith('workbuddy-ai/')) && mid.includes('deepseek')) score += 600;
  else if (mid.includes('deepseek') && mid.includes('free')) score += 520;
  else if (mid.includes('deepseek-v4.1-flash') || mid.includes('deepseek-flash')) score += 480;
  else if (mid.includes('deepseek')) score += 360;
  if (mid.includes('flash')) score += 120;
  if (mid.includes('free')) score += 40;
  return score;
}

function scoreModel(modelId, patterns) {
  const lower = String(modelId || '').toLowerCase();
  let score = 0;
  for (const [token, weight] of patterns) {
    if (lower.includes(token)) score += weight;
  }
  const match = lower.match(/gpt-(\d+(?:\.\d+)?)/);
  if (match) {
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) score += Math.trunc(parsed * 10);
  }
  return score;
}

function pickBest(candidates, patterns) {
  if (!candidates.length) return '';
  const ranked = [...candidates].sort((a, b) => {
    const diff = scoreModel(b, patterns) - scoreModel(a, patterns);
    if (diff !== 0) return diff;
    return b.localeCompare(a);
  });
  return ranked[0];
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const s = String(item || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function pickSubscriptionPlan(probe) {
  const codexIds = Array.isArray(probe?.codex_models) ? probe.codex_models : [];
  const utilityIds = Array.isArray(probe?.utility_candidates) ? probe.utility_candidates : [];
  if (!codexIds.length) return null;
  const sonnetModel = pickBest(codexIds, [['6.2-sol', 300], ['sol', 240], ['terra', 140], ['luna', 100]]);
  const fableModel = pickBest(codexIds, [['6.2-astra', 320], ['astra', 260], ['pro', 180], ['sol', 100]]);
  const utilityModel = utilityIds[0] || DEFAULT_UTILITY.model;

  return {
    tiers: {
      sonnet: {
        ...DEFAULT_TIERS.sonnet,
        consult_model: sonnetModel,
        exec_model: sonnetModel,
        reasoning_effort: 'medium',
        fallback_models: [],
        magpie_group_members: [sonnetModel],
      },
      opus: {
        ...DEFAULT_TIERS.opus,
        consult_model: sonnetModel,
        exec_model: sonnetModel,
        escalate_model: fableModel,
        escalate_effort_threshold: 'xhigh',
        reasoning_effort: 'high',
        fallback_models: [],
        magpie_group_members: dedupe([sonnetModel, fableModel]),
      },
      fable: {
        ...DEFAULT_TIERS.fable,
        consult_model: fableModel,
        exec_model: fableModel,
        reasoning_effort: 'xhigh',
        fallback_models: [],
        magpie_group_members: [fableModel],
      },
    },
    utility_model: utilityModel,
  };
}

function isGeminiCandidate(id, excludedTokens) {
  const raw = String(id || '').trim();
  const lower = raw.toLowerCase();
  if (!raw || isExcludedModel(raw, excludedTokens)) return false;
  if (lower.startsWith('group/gempt-')) return false;
  if (!lower.includes('gemini')) return false;
  return !['embedding', 'tts', 'image', 'imagen', 'veo'].some((bad) => lower.includes(bad));
}

function pickGeminiSlot(geminiIds, slot) {
  const patternsBySlot = {
    hydrogen: [['gemini-4-hydrogen', 320], ['hydrogen', 240], ['flash', 140], ['neon', 80], ['carbon', 60]],
    neon: [['gemini-4-neon', 320], ['neon', 240], ['carbon', 160], ['pro', 100], ['hydrogen', 60]],
    argon: [['gemini-4-argon', 320], ['argon', 240], ['neon', 180], ['carbon', 140], ['pro', 100]],
  };
  const patterns = patternsBySlot[slot] || [];
  if (!geminiIds.length) return '';
  const ranked = [...geminiIds].sort((a, b) => {
    const score = (id) => {
      const lower = id.toLowerCase();
      let p = 100;
      if (lower.startsWith('agy-cli/') || lower.startsWith('antigravity/') || lower.startsWith('google/') || lower.startsWith('gemini/')) p = 400;
      else if (lower.startsWith('auto/')) p = 220;
      return p + scoreModel(id, patterns);
    };
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return b.localeCompare(a);
  });
  return ranked[0];
}

export function pickNativeGroupPlan(probe) {
  const geminiIds = Array.isArray(probe?.gemini_models) ? probe.gemini_models : [];
  const codexIds = Array.isArray(probe?.codex_models) ? probe.codex_models : [];
  const utilityIds = Array.isArray(probe?.utility_candidates) ? probe.utility_candidates : [];
  if (!geminiIds.length || !codexIds.length) return null;

  const hydrogen = pickGeminiSlot(geminiIds, 'hydrogen');
  const neon = pickGeminiSlot(geminiIds, 'neon');
  const argon = pickGeminiSlot(geminiIds, 'argon');
  const terra = pickBest(codexIds, [['6.1-terra', 320], ['terra', 240], ['sol', 140]]);
  const sol = pickBest(codexIds, [['6.2-sol', 300], ['sol', 240], ['terra', 140], ['luna', 100]]);
  const astra = pickBest(codexIds, [['6.2-astra', 320], ['astra', 260], ['pro', 180], ['sol', 100]]);
  const flash = utilityIds[0] || '';

  return {
    models: { hydrogen, neon, argon, terra, sol, astra, flash },
    tiers: {
      sonnet: {
        group_id: 'group/gempt-sonnet',
        members: dedupe([hydrogen, terra, flash]),
        nodes: [
          { id: hydrogen, role: 'planner' },
          { id: terra, role: 'coder' },
          ...(flash ? [{ id: flash, role: 'utility' }] : []),
        ],
      },
      opus: {
        group_id: 'group/gempt-opus',
        members: dedupe([neon, sol, astra, flash]),
        nodes: [
          { id: neon, role: 'planner' },
          { id: sol, role: 'coder' },
          ...(astra !== sol ? [{ id: astra, role: 'escalate' }] : []),
          ...(flash ? [{ id: flash, role: 'utility' }] : []),
        ],
      },
      fable: {
        group_id: 'group/gempt-fable',
        members: dedupe([argon, astra, flash]),
        nodes: [
          { id: argon, role: 'planner' },
          { id: astra, role: 'coder' },
          ...(flash ? [{ id: flash, role: 'utility' }] : []),
        ],
      },
    },
  };
}

function emptyProbeResult(url, error) {
  return {
    reachable: false,
    url,
    total_models: 0,
    codex_models: [],
    openai_models: [],
    gemini_models: [],
    codex_ready: false,
    utility_candidates: [],
    harness_groups: [],
    native_groups: [],
    error,
  };
}

export function probeMagpie(baseUrl = DEFAULT_MAGPIE_URL, apiKey = '', timeoutMs = 2000, excludedTokens = []) {
  const cleanedUrl = String(baseUrl || DEFAULT_MAGPIE_URL).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(`${cleanedUrl}/v1/models`);
  } catch (err) {
    return Promise.resolve(emptyProbeResult(cleanedUrl, err.message));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.resolve(emptyProbeResult(cleanedUrl, `Unsupported scheme: ${parsed.protocol}`));
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveProbe(result);
    };

    const req = client.request(
      parsed,
      { method: 'GET', headers },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          finish(emptyProbeResult(cleanedUrl, `HTTP ${res.statusCode} redirect rejected`));
          return;
        }
        const chunks = [];
        let totalBytes = 0;
        const maxBytes = 1024 * 1024;
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes <= maxBytes) chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finish(emptyProbeResult(cleanedUrl, `HTTP ${res.statusCode}`));
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const models = Array.isArray(body?.data) ? body.data : [];
            const visibleIds = [];
            const codexSet = new Set();
            const openaiSet = new Set();
            const geminiSet = new Set();
            const utilSet = new Set();
            const harnessGroups = [];
            const nativeGroups = [];
            for (const item of models) {
              const id = String(item?.id || '');
              if (!id || isExcludedModel(id, excludedTokens)) continue;
              const owned = String(item?.owned_by || '').toLowerCase();
              const label = String(item?.magpie_label || '').toLowerCase();
              const isGroup = id.startsWith('group/') || id.startsWith('auto/') || label.includes('routing group');
              visibleIds.push(id);
              if (isGeminiCandidate(id, excludedTokens)) {
                geminiSet.add(id);
              }
              if (isGroup) {
                if (id.startsWith('group/gempt-harness-')) harnessGroups.push(id);
                else if (id === 'group/gempt-sonnet' || id === 'group/gempt-opus' || id === 'group/gempt-fable') {
                  nativeGroups.push(id);
                }
                if (isUtilityCandidate(item, excludedTokens)) utilSet.add(id);
              } else if (id.startsWith('codex/')) {
                codexSet.add(id);
              } else if (owned === 'openai' || id.startsWith('openai/')) {
                openaiSet.add(id);
              } else if (isUtilityCandidate(item, excludedTokens)) {
                utilSet.add(id);
              }
            }
            const codexModels = [...codexSet];
            const openaiModels = [...openaiSet];
            const geminiModels = [...geminiSet];
            const utilityCandidates = [...utilSet].sort((a, b) => {
              const diff = utilityRankScore(b) - utilityRankScore(a);
              if (diff !== 0) return diff;
              return b.localeCompare(a);
            });
            finish({
              reachable: true,
              url: cleanedUrl,
              total_models: visibleIds.length,
              codex_models: codexModels,
              openai_models: openaiModels,
              gemini_models: geminiModels,
              codex_ready: codexModels.length > 0,
              utility_candidates: utilityCandidates,
              harness_groups: harnessGroups,
              native_groups: nativeGroups,
              error: '',
            });
          } catch (err) {
            finish(emptyProbeResult(cleanedUrl, `Invalid JSON: ${err.message}`));
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      finish(emptyProbeResult(cleanedUrl, err.message));
    });
    req.end();
  });
}

function sortedMtimeEntries(dirPath, filterFn) {
  if (!existsSync(dirPath)) return [];
  const entries = [];
  for (const name of readdirSync(dirPath)) {
    if (!filterFn(name)) continue;
    const full = join(dirPath, name);
    try {
      const st = statSync(full);
      entries.push({ name, full, mtimeMs: st.mtimeMs });
    } catch {
      // Skip disappeared or unreadable entry.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

export function readRecentActivity(sessionsDir, limit = 6) {
  const recentSessions = [];
  for (const entry of sortedMtimeEntries(sessionsDir, (n) => n.endsWith('.json')).slice(0, limit)) {
    const rec = readJsonSafe(entry.full);
    if (!rec) continue;
    recentSessions.push({
      session_id: String(rec.session_id || entry.name.replace(/\.json$/, '')),
      mode: String(rec.mode || 'consult'),
      tier: String(rec.tier || ''),
      model: String(rec.model || ''),
      agent: String(rec.agent || ''),
      turns: Array.isArray(rec.turns) ? rec.turns.length : 0,
      cwd_name: rec.cwd ? basename(String(rec.cwd)) : '',
      updated_at: String(rec.updated_at || ''),
    });
  }

  const runsDir = join(sessionsDir, 'runs');
  const recentRuns = [];
  if (existsSync(runsDir)) {
    const runDirs = sortedMtimeEntries(runsDir, () => true);
    for (const dirEntry of runDirs) {
      const stateFile = join(dirEntry.full, 'state.json');
      const rec = readJsonSafe(stateFile);
      if (!rec) continue;
      let runState = String(rec.state || 'unknown');
      if ((runState === 'queued' || runState === 'running') && Number.isFinite(rec.deadline) && (Date.now() / 1000) > rec.deadline) {
        runState = 'outcome_unknown';
      }
      recentRuns.push({
        run_id: String(rec.run_id || dirEntry.name),
        state: runState,
        cwd_name: rec.cwd ? basename(String(rec.cwd)) : '',
        tier: String(rec.result?.tier || ''),
        model: String(rec.result?.model || ''),
        verification: String(rec.result?.verification?.status || ''),
      });
      if (recentRuns.length >= limit) break;
    }
  }

  return { recentSessions, recentRuns };
}

const ACTIVITY_SESSION_ID = /^(?:consult|exec)-[A-Za-z0-9_.-]{1,120}$/;
const ACTIVITY_RUN_ID = /^[a-f0-9]{32}$/;
const safeSessionId = (id) => typeof id === 'string' && ACTIVITY_SESSION_ID.test(id) && !id.includes('..');

export function isActivityId(kind, id) {
  if (kind === 'sessions') return safeSessionId(id);
  if (/^run-[a-f0-9]{32}$/.test(id)) return true;
  const [sid, turn, beyond] = id.split(':');
  return beyond === undefined && safeSessionId(sid) && /^[1-9][0-9]{0,8}$/.test(turn);
}

function activityEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readActivityFile(file) {
  try {
    const stat = lstatSync(file);
    if (stat.isFile()) {
      const data = readJsonSafe(file);
      if (data) return { data, modified: stat.mtime.toISOString() };
    }
  } catch {
    // A worker may have replaced or removed the entry since enumeration.
  }
  return null;
}

function activityTime(...values) {
  for (const value of values) {
    const ms = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1)
      : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) return new Date(ms).toISOString();
  }
  return null;
}

const activityNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function activityUsage(usage) {
  const input = activityNumber(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = activityNumber(usage?.output_tokens ?? usage?.completion_tokens);
  const cached = activityNumber(usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens);
  const read = cached ?? activityNumber(usage?.cache_read_input_tokens ?? usage?.cache_read_tokens);
  const write = activityNumber(usage?.cache_creation_input_tokens ?? usage?.cache_write_tokens);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: read,
    cache_write_tokens: write,
    cache_hit_rate: read != null && input != null && input + (cached == null ? read + (write ?? 0) : 0) > 0
      ? read / (input + (cached == null ? read + (write ?? 0) : 0)) : null,
    reasoning_tokens: activityNumber(usage?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens
      ?? usage?.completion_tokens_details?.reasoning_tokens),
    total_tokens: activityNumber(usage?.total_tokens) ?? ([input, output, read, write].some((n) => n != null)
      ? (input ?? 0) + (output ?? 0) + (cached == null ? read ?? 0 : 0) + (write ?? 0) : null),
  };
}

function promptSection(prompt, heading) {
  const marker = `## ${heading}\n`;
  const start = prompt.indexOf(marker);
  return start < 0 ? '' : prompt.slice(start + marker.length).split(/\n\n## /, 1)[0].trim();
}

function activityRequest(source, context) {
  const prompt = String(source.prompt || '').replaceAll('\r\n', '\n');
  const verification = source.verification;
  const requested = (typeof verification === 'string' ? verification : verification?.requested)
    || promptSection(prompt, 'Required Verification');
  return {
    ...context,
    timestamp: activityTime(source.timestamp, source.finished_at, source.updated_at, source.started_at, source.created_at),
    cwd: String(source.cwd ?? context.cwd ?? ''),
    agent: String(source.agent ?? context.agent ?? ''),
    tier: String(source.tier ?? context.tier ?? ''),
    model: String(source.served_model || source.model || context.model || ''),
    requested_model: String(source.requested_model || ''),
    sent_model: String(source.sent_model || ''),
    provider: String(source.provider || ''),
    account: String(source.account || ''),
    reasoning_effort: String(source.reasoning_effort ?? context.reasoning_effort ?? ''),
    codex_thread_id: String(source.codex_thread_id ?? context.codex_thread_id ?? ''),
    goal: String(source.goal || promptSection(prompt, 'Goal') || prompt),
    prompt,
    reply: String(source.reply || source.reply_preview || ''),
    reply_is_preview: !source.reply && Boolean(source.reply_preview),
    status: String(source.status || 'succeeded'),
    retried: Boolean(source.retried || source.attempted_models?.length > 1),
    error: String(source.error || ''),
    elapsed_sec: activityNumber(source.elapsed_sec),
    ttft_ms: activityNumber(source.ttft_ms),
    output_tokens_per_sec: activityNumber(source.output_tokens_per_sec),
    cost: activityNumber(source.cost),
    usage: activityUsage(source.usage),
    verification: {
      status: String(verification?.status || (requested ? 'unverified' : '')),
      requested: String(requested || ''),
      checks: Array.isArray(verification?.checks) ? verification.checks : [],
    },
    commands: Array.isArray(source.commands) ? source.commands : Array.isArray(verification?.commands) ? verification.commands : [],
  };
}

function readActivitySession(dir, id) {
  const file = readActivityFile(join(dir, `${id}.json`));
  if (!file) return null;
  const { data, modified } = file;
  const mode = id.startsWith('exec-') ? 'exec' : 'consult';
  if ((data.mode && data.mode !== mode) || (data.session_id && data.session_id !== id)) return null;

  // Legacy consult and native exec files store alternating messages. Python
  // exec files store one object per turn, with a reply preview in older files.
  const turns = [];
  for (const entry of Array.isArray(data.turns) ? data.turns : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role === 'assistant') {
      const prior = turns.at(-1);
      if (prior?.role === 'user' && prior.reply === undefined) prior.reply = entry.content;
    } else if (entry.role === 'user') {
      turns.push({ ...entry, prompt: entry.prompt ?? entry.content });
    } else if (!entry.role) {
      turns.push(entry);
    }
  }
  const created = activityTime(data.created_at);
  const updated = activityTime(data.updated_at, modified);
  const requests = turns.map((entry, index) => {
    const turn = index + 1;
    const source = { ...entry, ...data.turn_details?.[turn] };
    return activityRequest({
      ...source,
      timestamp: activityTime(source.timestamp, source.finished_at, source.updated_at, source.created_at,
        turn === turns.length ? updated : turn === 1 ? created : null),
    }, {
      id: `${id}:${turn}`, session_id: id, turn, mode,
      run_id: ACTIVITY_RUN_ID.test(source.run_id ?? '') ? source.run_id : '',
      cwd: data.cwd, agent: data.agent, model: data.model, tier: data.tier,
      reasoning_effort: data.reasoning_effort, codex_thread_id: data.codex_thread_id,
    });
  });
  return { id, mode, created_at: created, updated_at: updated, requests, runs: [],
    title: String(data.title || ''), cwd: String(data.cwd || ''), model: String(data.model || ''), tier: String(data.tier || '') };
}

function readActivityRun(dir, id) {
  const file = readActivityFile(join(dir, id, 'state.json'));
  if (!file) return null;
  const { data, modified } = file;
  if ((data.run_id && data.run_id !== id) || !data.state) return null;
  const result = data.result;
  const sessionId = result?.session_id || data.session_id;
  const pending = data.state === 'running' || data.state === 'queued';
  const status = pending && Number.isFinite(data.deadline) && Date.now() / 1000 > data.deadline
    ? 'outcome_unknown' : data.state === 'finished' ? 'succeeded' : data.state;
  const reply = result?.reply ?? String(result?.text || '').replace(/^\[mode=exec \| [^\r\n]+\]\r?\n\r?\n/, '');
  const request = activityRequest({
    ...data, ...result, status, reply, error: data.error,
    timestamp: activityTime(data.finished_at, result?.timestamp, data.updated_at, data.started_at, data.created_at, modified),
  }, {
    id: `run-${id}`, run_id: id, mode: 'exec',
    session_id: safeSessionId(sessionId) && sessionId.startsWith('exec-') ? sessionId : '',
    turn: null,
  });
  return { request, turn: result?.turn ?? result?.turns ?? data.turn };
}

function joinActivityRun(session, request, turn) {
  // Old native receipts did not include a turn number. Match their full reply
  // only if it identifies one turn in the same session.
  let target = session.requests.find((item) => item.run_id === request.run_id);
  if (!target && request.status === 'succeeded') {
    const candidates = session.requests.filter((item) => !item.run_id);
    if (Number.isSafeInteger(turn) && turn > 0) {
      target = candidates.find((item) => item.turn === turn && (!request.reply || !item.reply
        || (item.reply_is_preview ? request.reply.startsWith(item.reply) : request.reply === item.reply)));
    } else if (request.reply) {
      const matches = candidates.filter((item) => item.reply === request.reply && !item.reply_is_preview);
      if (matches.length === 1) [target] = matches;
    }
  }
  if (target) {
    target.run_id = request.run_id;
    if (request.status === 'succeeded' || request.status === 'failed') target.status = request.status;
    target.retried ||= request.retried;
    target.timestamp ||= request.timestamp;
    for (const key of ['cwd', 'agent', 'tier', 'model', 'requested_model', 'sent_model', 'provider', 'account',
      'reasoning_effort', 'codex_thread_id', 'goal', 'prompt', 'error']) {
      if (request[key]) target[key] = request[key];
    }
    if (request.reply) {
      target.reply = request.reply;
      target.reply_is_preview = request.reply_is_preview;
    }
    for (const key of ['elapsed_sec', 'ttft_ms', 'output_tokens_per_sec', 'cost']) {
      target[key] = request[key] ?? target[key];
    }
    for (const [key, value] of Object.entries(request.usage)) {
      if (value != null) target.usage[key] = value;
    }
    if (request.verification.status && (request.verification.status !== 'unverified' || !target.verification.status)) {
      target.verification = request.verification;
    }
    if (request.commands.length) target.commands = request.commands;
  } else {
    if (request.status === 'succeeded' && Number.isSafeInteger(turn) && turn > 0
      && !session.requests.some((item) => item.turn === turn)) request.turn = turn;
    session.requests.push(request);
  }
  session.runs.push({ run_id: request.run_id, request_id: (target || request).id, turn: (target || request).turn,
    status: request.status, timestamp: request.timestamp });
}

function totalUsage(requests) {
  const totals = activityUsage();
  for (const request of requests) {
    for (const key of Object.keys(totals)) {
      if (key !== 'cache_hit_rate' && request.usage[key] != null) totals[key] = (totals[key] ?? 0) + request.usage[key];
    }
  }
  return totals;
}

function readDispatchActivity(sessionsDir) {
  const dir = resolveSessionsDir(sessionsDir);
  const entries = activityEntries(dir);
  const sessions = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!safeSessionId(id)) continue;
    const session = readActivitySession(dir, id);
    if (session) sessions.set(id, session);
  }

  const sessionsByRun = new Map();
  for (const session of sessions.values()) {
    for (const request of session.requests) {
      if (request.run_id) sessionsByRun.set(request.run_id, session.id);
    }
  }
  const runsDir = join(dir, 'runs');
  const runRecords = [];
  if (entries.some((entry) => entry.name === 'runs' && entry.isDirectory())) {
    for (const entry of activityEntries(runsDir)) {
      if (!entry.isDirectory() || !ACTIVITY_RUN_ID.test(entry.name)) continue;
      const run = readActivityRun(runsDir, entry.name);
      if (!run) continue;
      const { request } = run;
      request.session_id = sessionsByRun.get(request.run_id) || request.session_id;
      if (request.session_id && request.status === 'succeeded' && !sessions.has(request.session_id)) {
        sessions.set(request.session_id, { id: request.session_id, mode: 'exec', requests: [], runs: [] });
      }
      runRecords.push(run);
    }
  }

  const ledger = [];
  for (const { request, turn } of runRecords) {
    const session = sessions.get(request.session_id);
    if (session) joinActivityRun(session, request, turn);
    else {
      request.session_id = '';
      ledger.push(request);
    }
  }
  for (const session of sessions.values()) {
    session.requests.sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity)
      || (a.timestamp || '').localeCompare(b.timestamp || ''));
    const first = session.requests[0];
    const latestWith = (key) => session.requests.findLast((item) => item[key])?.[key] || '';
    session.session_id = session.id;
    session.title = first?.goal || session.title || '';
    session.cwd = latestWith('cwd') || session.cwd || '';
    session.model = latestWith('model') || session.model || '';
    session.tier = latestWith('tier') || session.tier || '';
    session.turn_count = session.requests.length;
    session.created_at = session.created_at || first?.timestamp || null;
    session.updated_at = activityTime([session.updated_at, ...session.requests.map((r) => r.timestamp)].filter(Boolean).sort().at(-1));
    session.usage = totalUsage(session.requests);
    session.elapsed_sec = session.requests.reduce((total, r) => r.elapsed_sec == null ? total : (total ?? 0) + r.elapsed_sec, null);
    ledger.push(...session.requests);
  }
  ledger.sort((a, b) => {
    const time = (item) => item.timestamp || sessions.get(item.session_id)?.updated_at || '';
    return time(b).localeCompare(time(a)) || (b.turn ?? 0) - (a.turn ?? 0) || a.id.localeCompare(b.id);
  });
  const history = [...sessions.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.id.localeCompare(b.id));
  return { ledger, history, totals: { requests: ledger.length, sessions: history.length, runs: runRecords.length } };
}

function requestListItem(row) {
  const { prompt, reply, error, verification, commands, ...item } = row;
  return { ...item, goal: item.goal.slice(0, 320) };
}

function sessionListItem(row) {
  const { requests, runs, ...item } = row;
  return { ...item, title: item.title.slice(0, 320) };
}

export function listDispatchActivity(kind, params, sessionsDir) {
  const { ledger, history } = readDispatchActivity(sessionsDir);
  const isRequests = kind === 'requests';
  const records = isRequests ? ledger : history;
  const fields = { mode: 'mode', tier: 'tier', workspace: 'cwd', model: 'model', ...(isRequests ? { status: 'status' } : {}) };
  const recordValues = (row, field) => {
    if (field === 'status' && row.retried) return [row.status, 'retried'];
    if (!isRequests && (field === 'tier' || field === 'model' || field === 'cwd')) {
      return [...new Set([row[field], ...row.requests.map((request) => request[field])])];
    }
    return [row[field]];
  };
  const matches = (row, key, field) => !params.get(key) || recordValues(row, field).includes(params.get(key));
  const query = (params.get('q') ?? params.get('search') ?? '').trim().toLowerCase();
  const findText = (row) => [row.id, row.session_id, row.run_id, row.title, row.goal, row.prompt, row.reply, row.error, row.model,
    row.tier, row.agent, row.cwd].some((value) => value?.toLowerCase().includes(query));
  const searchable = query ? records.filter((row) => findText(row) || row.requests?.some(findText)) : records;
  const filters = Object.entries(fields);
  const filtered = searchable.filter((row) => filters.every(([key, field]) => matches(row, key, field)));
  const facets = Object.fromEntries(filters.map(([key, field]) => {
    const counts = new Map();
    for (const row of searchable) {
      if (!filters.every(([other, prop]) => other === key || matches(row, other, prop))) continue;
      for (const value of recordValues(row, field)) {
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [key, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }))];
  }));
  const integer = (key, fallback) => {
    const value = params.get(key);
    return /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
  };
  const limit = Math.min(100, Math.max(1, integer('limit', 25)));
  const offset = integer('offset', 0);
  const requests = isRequests ? filtered : filtered.flatMap((session) => session.requests);
  const summary = { requests: requests.length, ...totalUsage(requests), failed: 0, retried: 0, elapsed_sec: null,
    workspaces: new Set(requests.map((row) => row.cwd).filter(Boolean)).size };
  for (const row of requests) {
    if (row.status === 'failed') summary.failed += 1;
    if (row.retried) summary.retried += 1;
    if (row.elapsed_sec != null) summary.elapsed_sec = (summary.elapsed_sec ?? 0) + row.elapsed_sec;
  }
  return { total: filtered.length, summary, items: filtered.slice(offset, offset + limit)
    .map(isRequests ? requestListItem : sessionListItem), facets, limit, offset };
}

export function getDispatchActivity(kind, id, sessionsDir) {
  if (!isActivityId(kind, id)) return null;
  const { ledger, history } = readDispatchActivity(sessionsDir);
  if (kind === 'requests') return ledger.find((row) => row.id === id) ?? null;
  const session = history.find((row) => row.id === id);
  if (!session) return null;
  const { requests: turns, ...detail } = session;
  return { ...detail, turns };
}

function buildTierView(tierId, tierCfg, defaultTier, fallbackPreset) {
  const fallback = fallbackPreset || DEFAULT_TIERS[tierId];
  const merged = { ...fallback, ...(tierCfg || {}) };
  const consultModel = String(merged.consult_model || fallback.consult_model);
  const execModel = String(merged.exec_model || '').trim();
  const effectiveExec = execModel || consultModel;
  return {
    id: tierId,
    slash: `/gempt-${tierId}`,
    label: String(merged.label || fallback.label),
    usage_share: String(merged.usage_share || fallback.usage_share || ''),
    when_to_use: String(merged.when_to_use || fallback.when_to_use),
    consult_model: consultModel,
    exec_model: effectiveExec,
    escalate_model: String(merged.escalate_model || '').trim(),
    escalate_effort_threshold: String(merged.escalate_effort_threshold || fallback.escalate_effort_threshold || 'high').trim(),
    reasoning_effort: String(merged.reasoning_effort || fallback.reasoning_effort),
    fallback_models: Array.isArray(merged.fallback_models) ? merged.fallback_models.filter(Boolean).map(String) : [],
    magpie_group_members: Array.isArray(merged.magpie_group_members)
      ? merged.magpie_group_members.filter(Boolean).map(String)
      : [],
    active: tierId === defaultTier,
  };
}

export function readMagpieNativeGroups(magpieConfigDir) {
  const providersFile = join(magpieConfigDir, 'providers.json');
  const data = readJsonSafe(providersFile);
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const byTier = {};
  for (const spec of NATIVE_GROUP_SPECS) {
    const found = groups.find((g) => String(g?.id || '') === spec.name);
    if (!found) continue;
    const members = Array.isArray(found.members) ? found.members.filter(Boolean).map(String) : [];
    const nodes = [];
    let coderSeen = false;
    for (let idx = 0; idx < members.length; idx += 1) {
      const m = members[idx];
      const lower = m.toLowerCase();
      if (isUtilityCandidate({ id: m }, []) || lower.includes('deepseek') || lower.includes('flash') || lower.includes('free')) {
        nodes.push({ id: m, role: 'utility' });
      } else if (idx === 0 && !lower.startsWith('codex/')) {
        nodes.push({ id: m, role: 'planner' });
      } else if (spec.id === 'opus' && coderSeen) {
        nodes.push({ id: m, role: 'escalate' });
      } else {
        coderSeen = true;
        nodes.push({ id: m, role: 'coder' });
      }
    }
    byTier[spec.id] = {
      id: spec.id,
      group_id: spec.group_id,
      installed: true,
      members,
      nodes,
      routing: String(found.routing || 'order'),
      rules_count: Array.isArray(found.rules) ? found.rules.length : 0,
    };
  }
  return byTier;
}

export function detectClients({ magpieConfigDir, antigravityPluginDir } = {}) {
  const agyDir = antigravityPluginDir
    ? resolve(expandUser(antigravityPluginDir))
    : resolve(join(homedir(), '.gemini', 'config', 'plugins', 'gempt'));
  const antigravity_installed = existsSync(join(agyDir, 'plugin.json'));

  const applied = readJsonSafe(join(magpieConfigDir, 'applied.json'));
  const appliedKeys = applied && !Array.isArray(applied) ? Object.keys(applied) : [];
  const magpieSet = new Set();
  const externalSet = new Set();
  for (const key of appliedKeys) {
    const label = CLIENT_LABELS[key] || key;
    if (!label) continue;
    magpieSet.add(label);
    if (key !== 'agy') externalSet.add(label);
  }

  const library = readJsonSafe(join(magpieConfigDir, 'library.json'));
  const mcpList = Array.isArray(library?.mcp) ? library.mcp : [];
  let magpie_mcp_registered = false;
  let nativeToolsLibEntry = null;
  for (const entry of mcpList) {
    if (!entry || typeof entry !== 'object') continue;
    const text = `${entry.name || ''} ${entry.id || ''} ${entry.plugin || ''} ${entry.url || ''} ${entry.command || ''} ${JSON.stringify(entry.args || [])}`.toLowerCase();
    if (text.includes('gempt')) {
      magpie_mcp_registered = true;
    }
    const url = String(entry.url || '').toLowerCase();
    const pluginRef = String(entry.plugin || '').toLowerCase();
    if (url.includes('/mcp/magpie/tools/gempt') || pluginRef.includes('gempt')) {
      nativeToolsLibEntry = entry;
    }
  }

  const pluginTools = readJsonSafe(join(magpieConfigDir, 'plugin-tools.json'));
  const nativeToolsSet = new Set();
  let pluginToolsRegistered = false;
  if (pluginTools) {
    for (const [specKey, list] of Object.entries(pluginTools)) {
      if (!String(specKey || '').toLowerCase().includes('gempt')) continue;
      pluginToolsRegistered = true;
      if (Array.isArray(list)) {
        for (const item of list) {
          const name = String(item || '').trim();
          if (name) nativeToolsSet.add(name.startsWith('gempt_') ? name : `gempt_${name}`);
        }
      }
    }
  }

  const native_tools_registered = Boolean(nativeToolsLibEntry || pluginToolsRegistered);
  const native_tools_agents = Array.isArray(nativeToolsLibEntry?.agents)
    ? [...new Set(nativeToolsLibEntry.agents.map((k) => CLIENT_LABELS[k] || String(k)).filter(Boolean))]
    : [];

  return {
    antigravity_installed,
    magpie_clients: [...magpieSet],
    external_clients: [...externalSet],
    magpie_mcp_registered,
    native_tools_registered,
    native_tools_agents,
    native_tools_list: [...nativeToolsSet],
  };
}

export function buildRulesSnippet() {
  return readFileSync(join(REPO_ROOT, 'plugin', 'rules', 'AGENTS.md'), 'utf8');
}

function resolvePythonBin() {
  const envBin = String(process.env.PYTHON_BIN || '').trim();
  if (envBin) return envBin;
  const windows = process.platform === 'win32';
  const names = windows ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const dirs = executablePathDirs().filter((dir) => !windows || !/[/\\]WindowsApps(?:[/\\]|$)/i.test(dir));
  if (windows && process.env.LOCALAPPDATA) {
    const base = join(process.env.LOCALAPPDATA, 'Programs', 'Python');
    try {
      const installs = readdirSync(base).filter((name) => /^Python3\d+$/i.test(name));
      installs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      dirs.push(...installs.map((name) => join(base, name)));
    } catch {
      // The per-user Python installation directory may be absent.
    }
  }
  return findExecutable(dirs.flatMap((dir) => names.map((name) => join(dir, name)))) || names[0];
}

export function buildMcpSnippet({ antigravityPluginDir, repoRoot = REPO_ROOT } = {}) {
  const agyDir = antigravityPluginDir
    ? resolve(expandUser(antigravityPluginDir))
    : resolve(join(homedir(), '.gemini', 'config', 'plugins', 'gempt'));
  const installedRuntime = join(agyDir, 'runtime');
  const targetRoot = existsSync(join(installedRuntime, 'gempt', 'mcp_server.py'))
    ? installedRuntime
    : resolve(join(repoRoot, 'src'));
  const installedConfig = targetRoot === installedRuntime ? readJsonSafe(join(agyDir, 'mcp_config.json')) : null;
  if (installedConfig?.mcpServers?.gempt?.command) {
    return { target_root: targetRoot, config: installedConfig, json: JSON.stringify(installedConfig, null, 2) };
  }

  const pythonBin = resolvePythonBin();
  const config = {
    mcpServers: {
      gempt: {
        command: pythonBin,
        args: [
          '-I',
          '-X',
          'utf8',
          '-c',
          "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('gempt.mcp_server',run_name='__main__')",
          targetRoot,
        ],
        env: {
          PYTHONPATH: targetRoot,
          PYTHONUTF8: '1',
        },
      },
    },
  };
  return {
    target_root: targetRoot,
    config,
    json: JSON.stringify(config, null, 2),
  };
}

export function readExternalGroupUsage(magpieConfigDir, limit = 6) {
  const usageFile = join(magpieConfigDir, 'usage.jsonl');
  if (!existsSync(usageFile)) return [];
  const maxTail = 256 * 1024;
  let text = '';
  let startOffset = 0;
  let fd;
  try {
    fd = openSync(usageFile, 'r');
    const size = fstatSync(fd).size;
    startOffset = Math.max(0, size - maxTail);
    const len = size - startOffset;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    let bytesRead = 0;
    while (bytesRead < len) {
      const n = readSync(fd, buf, bytesRead, len - bytesRead, startOffset + bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }
    text = buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  let lines = text.split(/\r?\n/);
  if (startOffset > 0 && lines.length > 0) lines = lines.slice(1);

  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      continue;
    }
    const req = String(rec?.req || '').trim();
    const match = req.match(/^(?:group\/)?gempt-(sonnet|opus|fable)(?::|#|$)/i);
    if (!match) continue;
    out.push({
      source: 'magpie_group',
      tier: match[1].toLowerCase(),
      req,
      agent: String(rec.agent || ''),
      served_model: String(rec.served || (rec.provider && rec.model ? `${rec.provider}/${rec.model}` : (rec.model || ''))),
      status: Number.isFinite(Number(rec.status)) ? Number(rec.status) : 0,
      updated_at: String(rec.t || ''),
    });
  }
  return out;
}

function readPluginExecOption(magpieConfigDir) {
  if (String(process.env.GEMPT_MAGPIE_TOOLS_EXEC || '') === '1') return true;
  const plugins = readJsonSafe(join(magpieConfigDir, 'plugins.json'));
  const list = Array.isArray(plugins?.plugins) ? plugins.plugins : [];
  const entry = list.find((item) => String(item?.spec || '').toLowerCase().includes('gempt'));
  return entry?.options?.exec === true;
}

function hasApiSnapshot(cfg) {
  const snap = cfg?.routing_policy?.api_fallback_snapshot;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
  return TIER_ORDER.some((t) => snap[t] && typeof snap[t] === 'object' && typeof snap[t].consult_model === 'string' && snap[t].consult_model.trim());
}

export async function readState({ configPath, sessionsDir, magpieConfigDir, antigravityPluginDir, execEnabled, probeTimeoutMs = 2000 } = {}) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const resolvedSessionsDir = resolveSessionsDir(sessionsDir);
  const resolvedMagpieDir = resolveMagpieConfigDir(magpieConfigDir);
  const rawCfg = readJsonSafe(resolvedConfigPath);
  const configured = Boolean(rawCfg);

  const policy = rawCfg?.routing_policy || {};
  const defaultTier = normalizeDefaultTier(policy.default_tier) || 'sonnet';
  const baseUrl = String(rawCfg?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const apiKey = rawCfg ? resolveMagpieApiKey(rawCfg) : '';
  const excludedTokens = resolveExcludedTokens(rawCfg);
  const magpie = await probeMagpie(baseUrl, apiKey, probeTimeoutMs, excludedTokens);
  const recommended = pickSubscriptionPlan(magpie);
  const nativePlan = pickNativeGroupPlan(magpie);
  const liveNativeGroups = readMagpieNativeGroups(resolvedMagpieDir);
  const clients = detectClients({ magpieConfigDir: resolvedMagpieDir, antigravityPluginDir });
  const mcpSnippet = buildMcpSnippet({ antigravityPluginDir });
  const recentGroupCalls = readExternalGroupUsage(resolvedMagpieDir, 6);

  const liveNativeSet = new Set([
    ...(magpie.native_groups || []),
    ...Object.values(liveNativeGroups).map((g) => g.group_id),
  ]);

  const nativeTiers = NATIVE_GROUP_SPECS.map((spec) => {
    const live = liveNativeGroups[spec.id];
    const isInstalled = liveNativeSet.has(spec.group_id);
    if (live) {
      return live;
    }
    const preview = nativePlan?.tiers?.[spec.id];
    return {
      id: spec.id,
      group_id: spec.group_id,
      installed: isInstalled,
      members: preview?.members || [],
      nodes: preview?.nodes || [],
      routing: 'order',
      rules_count: 0,
    };
  });

  const readyCount = nativeTiers.filter((t) => t.installed).length;
  let missingReason = '';
  if (!magpie.reachable) {
    missingReason = '尚未连上本地 Magpie 网关。';
  } else if (!(magpie.gemini_models || []).length && !(magpie.codex_models || []).length) {
    missingReason = '需要 Magpie 中同时接入 Gemini 与 Codex 模型。';
  } else if (!(magpie.gemini_models || []).length) {
    missingReason = 'Magpie 中尚未检测到可用的 Gemini 模型。';
  } else if (!(magpie.codex_models || []).length) {
    missingReason = 'Magpie 中尚未检测到 Codex 订阅模型。';
  }

  const tiersObj = rawCfg?.tiers || {};
  const tiers = TIER_ORDER.map((id) => buildTierView(
    id,
    configured ? tiersObj[id] : undefined,
    defaultTier,
    !configured && recommended?.tiers?.[id] ? recommended.tiers[id] : DEFAULT_TIERS[id],
  ));

  const utilRaw = rawCfg?.utility || {};
  const utility = {
    label: String(utilRaw.label || DEFAULT_UTILITY.label),
    slash: '/gempt-chore',
    model: String(utilRaw.model || (!configured && recommended?.utility_model ? recommended.utility_model : DEFAULT_UTILITY.model)),
    reasoning_effort: String(utilRaw.reasoning_effort || DEFAULT_UTILITY.reasoning_effort),
    fallback_models: Array.isArray(utilRaw.fallback_models) ? utilRaw.fallback_models.filter(Boolean).map(String) : [],
    use_for_magpie_compact: utilRaw.use_for_magpie_compact !== undefined ? Boolean(utilRaw.use_for_magpie_compact) : true,
  };

  const { recentSessions, recentRuns } = readRecentActivity(resolvedSessionsDir, 6);
  const { totals: activityTotals } = readDispatchActivity(resolvedSessionsDir);

  return {
    features: { ...FEATURES },
    configured,
    config_path: resolvedConfigPath,
    work_split: policy.work_split ?? 'balanced',
    swarm_split: policy.swarm_split ?? 'inherit',
    work_profiles: WORKLOAD.profiles,
    pairings: Object.fromEntries(Object.entries(WORKLOAD.pairings).map(([family, model]) =>
      [family, policy.pairings?.[family] ?? model])),
    default_tier: defaultTier,
    failover_mode: String(policy.failover_mode || 'subscription_only'),
    auto_effort: Boolean(rawCfg?.routing_policy?.auto_effort),
    default_sandbox: String(rawCfg?.codex?.default_sandbox || 'workspace-write'),
    subscription: {
      connected: Boolean(magpie.codex_ready),
      codex_count: (magpie.codex_models || []).length,
      recommended,
    },
    clients,
    native_groups: {
      ready_count: readyCount,
      complete: readyCount === NATIVE_GROUP_SPECS.length,
      can_create: Boolean(nativePlan),
      missing_reason: missingReason,
      tiers: nativeTiers,
    },
    mcp_snippet: mcpSnippet,
    rules_snippet: buildRulesSnippet(),
    tools: {
      enabled: true,
      exec_enabled: typeof execEnabled === 'boolean' ? execEnabled : readPluginExecOption(resolvedMagpieDir),
      endpoint: `${baseUrl}/mcp/magpie/tools/gempt`,
    },
    recent_group_calls: recentGroupCalls,
    api_fallback: {
      available: (magpie.openai_models || []).length > 0 || hasApiSnapshot(rawCfg),
      openai_count: (magpie.openai_models || []).length,
      has_snapshot: hasApiSnapshot(rawCfg),
    },
    magpie,
    tiers,
    utility,
    activity_totals: activityTotals,
    recent_sessions: recentSessions,
    recent_runs: recentRuns,
    checked_at: new Date().toISOString(),
  };
}

function readExistingConfigObject(configPath) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  if (!existsSync(resolvedConfigPath)) {
    return {
      ok: false,
      status: 404,
      error: '尚未启用 GemPT 配置，请先在页面上方点“一键启用订阅配置”，或在 Antigravity 中运行 /gempt。',
    };
  }
  let current;
  try {
    current = JSON.parse(readFileSync(resolvedConfigPath, 'utf-8'));
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Failed to read gempt config: ${err.message}`,
    };
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return {
      ok: false,
      status: 500,
      error: 'Invalid gempt config: root must be a JSON object.',
    };
  }
  return { ok: true, status: 200, path: resolvedConfigPath, data: current };
}

export function writeConfigAtomic(resolvedConfigPath, nextObj) {
  const parentDir = dirname(resolvedConfigPath);
  mkdirSync(parentDir, { recursive: true });
  const tmpFile = join(parentDir, `.config.json.tmp.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(tmpFile, JSON.stringify(nextObj, null, 2) + '\n', 'utf-8');
    renameSync(tmpFile, resolvedConfigPath);
    return { ok: true, status: 200, path: resolvedConfigPath };
  } catch (err) {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup failure */ }
    return {
      ok: false,
      status: 500,
      error: `Failed to write gempt config: ${err.message}`,
    };
  }
}

export function setDefaultTier(tier, { configPath } = {}) {
  const normalized = normalizeDefaultTier(tier);
  if (!normalized) {
    return {
      ok: false,
      status: 400,
      error: `Invalid default tier '${String(tier ?? '')}'. Expected one of: ${TIER_ORDER.join(', ')}.`,
    };
  }

  const loaded = readExistingConfigObject(configPath);
  if (!loaded.ok) return loaded;

  const next = {
    ...loaded.data,
    routing_policy: {
      ...(loaded.data.routing_policy && typeof loaded.data.routing_policy === 'object' ? loaded.data.routing_policy : {}),
      default_tier: normalized,
    },
  };
  const written = writeConfigAtomic(loaded.path, next);
  if (!written.ok) return written;

  return {
    ok: true,
    status: 200,
    default_tier: normalized,
    config_path: loaded.path,
  };
}

export function setPairing(family, model, { configPath } = {}) {
  if (!Object.hasOwn(WORKLOAD.pairings, family) ||
      (model !== 'default' && (typeof model !== 'string' || !isCodexModelId(model) || model.trim() !== model))) {
    return { ok: false, status: 400, error: '请选择有效的 Gemini 档位和 Codex 订阅模型。' };
  }
  const config = readExistingConfigObject(configPath);
  if (!config.ok) return config;
  const policy = config.data.routing_policy ||= {};
  policy.pairings = { ...policy.pairings, [family]: model };
  return writeConfigAtomic(config.path, config.data);
}

export function setWorkSplit(key, profile, { configPath } = {}) {
  if (!['work_split', 'swarm_split'].includes(key) ||
      !(Object.hasOwn(WORKLOAD.profiles, profile) || (key === 'swarm_split' && profile === 'inherit'))) {
    return { ok: false, status: 400, error: '请选择有效的工作分工档位。' };
  }
  const config = readExistingConfigObject(configPath);
  if (!config.ok) return config;
  config.data.routing_policy = { ...config.data.routing_policy, [key]: profile };
  return writeConfigAtomic(config.path, config.data);
}

export function setDefaultSandbox(sandbox, { configPath } = {}) {
  const normalized = String(sandbox || '').trim();
  if (!VALID_SANDBOXES.includes(normalized)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid default sandbox '${String(sandbox ?? '')}'. Expected one of: ${VALID_SANDBOXES.join(', ')}.`,
    };
  }

  const loaded = readExistingConfigObject(configPath);
  if (!loaded.ok) return loaded;

  const next = {
    ...loaded.data,
    codex: {
      ...(loaded.data.codex && typeof loaded.data.codex === 'object' ? loaded.data.codex : {}),
      default_sandbox: normalized,
    },
  };
  const written = writeConfigAtomic(loaded.path, next);
  if (!written.ok) return written;

  return {
    ok: true,
    status: 200,
    default_sandbox: normalized,
    config_path: loaded.path,
  };
}

export function setEffortSettings({ tierEffort, tier, autoEffort } = {}, { configPath } = {}) {
  const loaded = readExistingConfigObject(configPath);
  if (!loaded.ok) return loaded;

  const existingPolicy = loaded.data.routing_policy && typeof loaded.data.routing_policy === 'object'
    ? loaded.data.routing_policy
    : {};
  const existingTiers = loaded.data.tiers && typeof loaded.data.tiers === 'object'
    ? loaded.data.tiers
    : {};

  const targetTier = normalizeDefaultTier(tier || existingPolicy.default_tier || 'sonnet');
  if (!targetTier) {
    return {
      ok: false,
      status: 400,
      error: `Invalid target tier '${String(tier ?? '')}'. Expected one of: ${TIER_ORDER.join(', ')}.`,
    };
  }

  let nextAutoEffort = Boolean(existingPolicy.auto_effort);
  if (autoEffort !== undefined) {
    if (typeof autoEffort !== 'boolean') {
      return { ok: false, status: 400, error: 'auto_effort must be a boolean.' };
    }
    nextAutoEffort = autoEffort;
  }

  const nextTiers = { ...existingTiers };
  const targetTierCfg = { ...DEFAULT_TIERS[targetTier], ...(existingTiers[targetTier] || {}) };

  if (tierEffort !== undefined && tierEffort !== null && String(tierEffort).trim() !== '') {
    const cleanEffort = String(tierEffort).trim().toLowerCase();
    if (!VALID_EFFORTS.includes(cleanEffort)) {
      return {
        ok: false,
        status: 400,
        error: `Invalid reasoning_effort '${String(tierEffort)}'. Expected one of: ${VALID_EFFORTS.join(', ')}.`,
      };
    }
    if (cleanEffort === 'ultra') {
      return {
        ok: false,
        status: 400,
        error: "默认档位禁止设为 ultra（避免高倍并发配额消耗），仅在极端个案单次手动传参。",
      };
    }
    const usesAstra = targetTier === 'fable'
      || isAstraModel(targetTierCfg.consult_model)
      || isAstraModel(targetTierCfg.exec_model)
      || (Array.isArray(targetTierCfg.magpie_group_members) && targetTierCfg.magpie_group_members.some((m) => isAstraModel(m)));
    if (usesAstra && EFFORT_RANK[cleanEffort] < EFFORT_RANK.medium) {
      return {
        ok: false,
        status: 400,
        error: 'Astra 模型禁止降到 low 档思考，请保持 high / xhigh 或切换到 Sol 档。',
      };
    }
    targetTierCfg.reasoning_effort = cleanEffort;
    nextTiers[targetTier] = targetTierCfg;
    if (autoEffort === undefined) {
      nextAutoEffort = false;
    }
  }

  const next = {
    ...loaded.data,
    routing_policy: {
      ...existingPolicy,
      auto_effort: nextAutoEffort,
    },
    tiers: nextTiers,
  };
  const written = writeConfigAtomic(loaded.path, next);
  if (!written.ok) return written;

  return {
    ok: true,
    status: 200,
    auto_effort: nextAutoEffort,
    tier: targetTier,
    reasoning_effort: String(nextTiers[targetTier]?.reasoning_effort || targetTierCfg.reasoning_effort || 'medium'),
    config_path: loaded.path,
  };
}

export async function initSubscriptionConfig({ configPath, probeTimeoutMs = 2000 } = {}) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const existing = readJsonSafe(resolvedConfigPath) || {};
  const existingMagpie = existing.magpie && typeof existing.magpie === 'object' ? existing.magpie : {};
  const existingCodex = existing.codex && typeof existing.codex === 'object' ? existing.codex : {};
  const existingPolicy = existing.routing_policy && typeof existing.routing_policy === 'object' ? existing.routing_policy : {};
  const existingLimits = existing.limits && typeof existing.limits === 'object' ? existing.limits : {};

  const baseUrl = String(existingMagpie.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const apiKey = resolveMagpieApiKey({ magpie: { ...existingMagpie, base_url: baseUrl } });
  const excludedTokens = resolveExcludedTokens(existing);

  const probe = await probeMagpie(baseUrl, apiKey, probeTimeoutMs, excludedTokens);
  if (!probe.reachable) {
    return {
      ok: false,
      status: 503,
      error: '无法连接本地 Magpie 网关，请先启动 Magpie。',
    };
  }

  const plan = pickSubscriptionPlan(probe);
  if (!plan) {
    return {
      ok: false,
      status: 400,
      error: '未检测到 Codex 订阅模型，请先在 Magpie 中登录 ChatGPT/Codex 订阅账号。',
    };
  }

  const currentSandbox = String(existingCodex.default_sandbox || '').trim();
  const safeSandbox = VALID_SANDBOXES.includes(currentSandbox) ? currentSandbox : 'workspace-write';
  const defaultTier = normalizeDefaultTier(existingPolicy.default_tier) || 'sonnet';
  const excludedList = Array.isArray(existingPolicy.excluded_models)
    ? existingPolicy.excluded_models.filter((item) => typeof item === 'string')
    : [];

  const next = {
    version: 1,
    magpie: {
      base_url: baseUrl,
      api_key: String(existingMagpie.api_key || ''),
      api_key_env: String(existingMagpie.api_key_env || 'GEMPT_MAGPIE_API_KEY'),
      cli_path: String(existingMagpie.cli_path || ''),
    },
    codex: {
      cli_path: String(existingCodex.cli_path || ''),
      default_sandbox: safeSandbox,
      approval_policy: String(existingCodex.approval_policy || 'never'),
      model_provider: String(existingCodex.model_provider || ''),
      extra_args: Array.isArray(existingCodex.extra_args) ? existingCodex.extra_args : [],
      timeout_sec: Number.isFinite(Number(existingCodex.timeout_sec)) ? Number(existingCodex.timeout_sec) : 600,
    },
    routing_policy: {
      work_split: existingPolicy.work_split ?? 'balanced',
      swarm_split: existingPolicy.swarm_split ?? 'inherit',
      pairings: existingPolicy.pairings ?? {},
      default_tier: defaultTier,
      failover_mode: 'subscription_only',
      auto_effort: Boolean(existingPolicy.auto_effort),
      magpie_group_strategy: String(existingPolicy.magpie_group_strategy || 'order'),
      excluded_models: excludedList,
    },
    tiers: plan.tiers,
    utility: {
      ...DEFAULT_UTILITY,
      model: plan.utility_model,
    },
    limits: {
      max_internal_rounds: 3,
      max_context_file_bytes: 131072,
      max_total_context_bytes: 393216,
      consult_timeout_sec: 180,
      ...existingLimits,
    },
  };

  const written = writeConfigAtomic(resolvedConfigPath, next);
  if (!written.ok) return written;

  return {
    ok: true,
    status: 200,
    config_path: resolvedConfigPath,
    default_tier: defaultTier,
    default_sandbox: safeSandbox,
    plan,
  };
}

const SAFE_MODEL_ID_RE = /^[A-Za-z0-9_./:@#-]+$/;

function normalizeGroupMember(modelId) {
  const m = String(modelId || '').trim();
  if (m.startsWith('auto/')) {
    return `group/auto-${m.slice('auto/'.length).replace(/\./g, '-')}`;
  }
  return m;
}

export function buildMagpieCliEnv() {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = '127.0.0.1,localhost,::1';
  return env;
}

function executablePathDirs() {
  return String(process.env.PATH || '').split(delimiter).filter(Boolean);
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return resolve(candidate);
      }
    } catch {
      // The candidate may be missing or inaccessible.
    }
  }
  return '';
}

export function findMagpieCli(configuredPath = '') {
  const candidates = [];
  const dirs = executablePathDirs();
  for (const override of [configuredPath, process.env.MAGPIE_BIN]) {
    const raw = String(override || '').trim();
    if (raw) {
      candidates.push(expandUser(raw));
      if (basename(raw) === raw) candidates.push(...dirs.map((dir) => join(dir, raw)));
    }
  }

  const windows = process.platform === 'win32';
  const names = windows ? ['magpie.com', 'magpie.exe', 'magpie.cmd', 'magpie'] : ['magpie'];
  if (windows) {
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'magpie'));
    for (const variable of ['ProgramFiles', 'ProgramFiles(x86)']) {
      if (process.env[variable]) dirs.push(join(process.env[variable], 'magpie'));
    }
  } else {
    dirs.push(join(homedir(), '.local', 'bin'), join(homedir(), '.local', 'opt', 'magpie'), '/usr/local/bin');
    if (process.platform === 'darwin') {
      dirs.push('/Applications/Magpie.app/Contents/MacOS', '/Applications/magpie.app/Contents/MacOS');
    }
  }
  return findExecutable([...candidates, ...dirs.flatMap((dir) => names.map((name) => join(dir, name)))]);
}

async function execMagpieCli(cliPath, args, { timeoutMs = 20000 } = {}) {
  const env = buildMagpieCliEnv();
  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
  const bin = isWinBatch ? (process.env.COMSPEC || 'cmd.exe') : cliPath;
  const fullArgs = isWinBatch ? ['/d', '/c', cliPath, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync(bin, fullArgs, {
      env,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (err) {
    return {
      ok: false,
      code: typeof err?.code === 'number' ? err.code : 1,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || ''),
    };
  }
}

export async function createNativeGroups({ configPath, magpieConfigDir, magpieCliPath, probeTimeoutMs = 2000 } = {}) {
  void magpieConfigDir;
  const resolvedConfigPath = resolveConfigPath(configPath);
  const rawCfg = readJsonSafe(resolvedConfigPath) || {};
  const baseUrl = String(rawCfg?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const apiKey = rawCfg ? resolveMagpieApiKey({ magpie: { ...(rawCfg.magpie || {}), base_url: baseUrl } }) : '';
  const excludedTokens = resolveExcludedTokens(rawCfg);

  const probe = await probeMagpie(baseUrl, apiKey, probeTimeoutMs, excludedTokens);
  if (!probe.reachable) {
    return { ok: false, status: 503, error: '无法连接本地 Magpie 网关，请先启动 Magpie。' };
  }

  const plan = pickNativeGroupPlan(probe);
  if (!plan) {
    return {
      ok: false,
      status: 400,
      error: '需要 Magpie 中同时接入 Gemini 与 Codex 订阅模型后，才能创建直连路由组。',
    };
  }

  for (const val of Object.values(plan.models)) {
    if (val && !SAFE_MODEL_ID_RE.test(val)) {
      return { ok: false, status: 400, error: `检测到非法模型 ID: ${val}` };
    }
  }

  const cliPath = findMagpieCli(magpieCliPath || rawCfg?.magpie?.cli_path || '');
  if (!cliPath) {
    return { ok: false, status: 400, error: '未找到 Magpie CLI（请确认安装路径或设置 MAGPIE_BIN）。' };
  }

  const h = normalizeGroupMember(plan.models.hydrogen);
  const n = normalizeGroupMember(plan.models.neon);
  const a = normalizeGroupMember(plan.models.argon);
  const terra = normalizeGroupMember(plan.models.terra);
  const s = normalizeGroupMember(plan.models.sol);
  const t = normalizeGroupMember(plan.models.astra);
  const f = plan.models.flash ? normalizeGroupMember(plan.models.flash) : '';

  const tierCommands = {
    'gempt-sonnet': [
      ['group', 'add', 'gempt-sonnet', `models=${dedupe([h, terra, f]).join(',')}`, 'routing=order', 'stays=turn'],
      ...(f ? [
        ['group', 'rule', 'add', 'gempt-sonnet', `use=${f}`, 'compact'],
        ['group', 'rule', 'add', 'gempt-sonnet', `use=${f}`, `classifier=${f}`, 'intent=simple formatting, adding comments, renaming, translating, writing boilerplate, or trivial quick questions'],
      ] : []),
      ['group', 'rule', 'add', 'gempt-sonnet', `use=${terra}`, 'when=subagent'],
      ['group', 'rule', 'add', 'gempt-sonnet', `use=${terra}`, 'intent=writing code, editing files, running tests, or fixing bugs'],
    ],
    'gempt-opus': [
      ['group', 'add', 'gempt-opus', `models=${dedupe([n, s, t, f]).join(',')}`, 'routing=order', 'stays=turn'],
      ...(f ? [
        ['group', 'rule', 'add', 'gempt-opus', `use=${f}`, 'compact'],
        ['group', 'rule', 'add', 'gempt-opus', `use=${t}`, `classifier=${f}`, 'intent=debugging hard bugs, complex algorithms, math/physics derivations, or critical architecture changes'],
      ] : []),
      ['group', 'rule', 'add', 'gempt-opus', `use=${s}`, 'when=subagent'],
      ['group', 'rule', 'add', 'gempt-opus', `use=${s}`, 'intent=writing code, editing files, implementing features, or writing tests'],
    ],
    'gempt-fable': [
      ['group', 'add', 'gempt-fable', `models=${dedupe([a, t, f]).join(',')}`, 'routing=order', 'stays=turn'],
      ...(f ? [['group', 'rule', 'add', 'gempt-fable', `use=${f}`, 'compact']] : []),
      ['group', 'rule', 'add', 'gempt-fable', `use=${t}`, 'when=subagent'],
      [
        'group',
        'rule',
        'add',
        'gempt-fable',
        `use=${t}`,
        ...(f ? [`classifier=${f}`] : []),
        'intent=writing code, editing files, debugging, or executing tasks',
      ],
    ],
  };

  const created = [];
  const skipped = [];
  for (const spec of NATIVE_GROUP_SPECS) {
    const showRes = await execMagpieCli(cliPath, ['group', 'show', spec.name]);
    if (showRes.ok) {
      skipped.push(spec.group_id);
      continue;
    }
    const detail = `${showRes.stderr}\n${showRes.stdout}`.trim();
    if (!detail.includes(`no group "${spec.name}"`) && showRes.code !== 1) {
      return { ok: false, status: 500, error: `检查路由组 ${spec.group_id} 失败: ${detail || 'unknown error'}` };
    }
    for (const cmd of tierCommands[spec.name]) {
      const runRes = await execMagpieCli(cliPath, cmd);
      if (!runRes.ok) {
        return {
          ok: false,
          status: 500,
          error: `创建路由组 ${spec.group_id} 失败: ${(runRes.stderr || runRes.stdout).trim()}`,
        };
      }
    }
    created.push(spec.group_id);
  }

  return {
    ok: true,
    status: 200,
    created,
    skipped,
    groups: NATIVE_GROUP_SPECS.map((s) => s.group_id),
    models: plan.models,
  };
}

function findApiBackup(subModel, openaiModels) {
  if (!Array.isArray(openaiModels) || !openaiModels.length) return '';
  const bare = String(subModel || '').split('/').pop().toLowerCase();
  for (const oid of openaiModels) {
    if (String(oid || '').split('/').pop().toLowerCase() === bare) return oid;
  }
  if (bare.includes('astra')) return pickBest(openaiModels, [['astra', 220], ['sol', 120]]);
  if (bare.includes('sol')) return pickBest(openaiModels, [['sol', 220], ['terra', 120]]);
  return pickBest(openaiModels, [['terra', 200], ['mini', 150], ['sol', 100]]);
}

export async function setFailoverMode(mode, { configPath, probeTimeoutMs = 2000 } = {}) {
  const normalized = String(mode || '').trim();
  if (!VALID_FAILOVER_MODES.includes(normalized)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid failover_mode '${String(mode ?? '')}'. Expected one of: ${VALID_FAILOVER_MODES.join(', ')}.`,
    };
  }

  const loaded = readExistingConfigObject(configPath);
  if (!loaded.ok) return loaded;

  const current = loaded.data;
  const curPolicy = current.routing_policy && typeof current.routing_policy === 'object' ? current.routing_policy : {};
  const curTiers = current.tiers && typeof current.tiers === 'object' ? current.tiers : {};
  const nextPolicy = { ...curPolicy, failover_mode: normalized };
  const nextTiers = { ...curTiers };

  const baseUrl = String(current.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const apiKey = resolveMagpieApiKey({ magpie: { ...(current.magpie || {}), base_url: baseUrl } });
  const excludedTokens = resolveExcludedTokens(current);
  let cachedProbe = null;
  const ensureProbe = async () => {
    if (!cachedProbe) {
      cachedProbe = await probeMagpie(baseUrl, apiKey, probeTimeoutMs, excludedTokens);
    }
    return cachedProbe;
  };

  if (normalized === 'subscription_only') {
    const usesGroupOrApi = TIER_ORDER.some((t) => {
      const tier = curTiers[t] || {};
      const c = String(tier.consult_model || '').trim();
      const e = String(tier.exec_model || '').trim();
      const fbs = Array.isArray(tier.fallback_models) ? tier.fallback_models : [];
      const mems = Array.isArray(tier.magpie_group_members) ? tier.magpie_group_members : [];
      return (
        c.startsWith('group/')
        || (c && !isCodexModelId(c))
        || (e && !isCodexModelId(e))
        || fbs.some((m) => !isCodexModelId(m))
        || mems.some((m) => !isCodexModelId(m))
      );
    });

    if (curPolicy.failover_mode === 'api_fallback' || usesGroupOrApi) {
      const snapshot = {};
      for (const t of TIER_ORDER) {
        const tier = curTiers[t] || {};
        snapshot[t] = {
          consult_model: String(tier.consult_model || ''),
          exec_model: String(tier.exec_model || ''),
          escalate_model: String(tier.escalate_model || ''),
          fallback_models: Array.isArray(tier.fallback_models) ? [...tier.fallback_models] : [],
          magpie_group_members: Array.isArray(tier.magpie_group_members) ? [...tier.magpie_group_members] : [],
        };
      }
      nextPolicy.api_fallback_snapshot = snapshot;
    }

    for (const t of TIER_ORDER) {
      const baseTier = { ...DEFAULT_TIERS[t], ...(curTiers[t] && typeof curTiers[t] === 'object' ? curTiers[t] : {}) };
      const members = Array.isArray(baseTier.magpie_group_members) ? baseTier.magpie_group_members : [];
      let primary = members.find((m) => isCodexModelId(m))
        || (isCodexModelId(baseTier.consult_model) ? String(baseTier.consult_model).trim() : '')
        || (isCodexModelId(baseTier.exec_model) ? String(baseTier.exec_model).trim() : '');

      let subPlan = null;
      if (!primary) {
        const probe = await ensureProbe();
        subPlan = pickSubscriptionPlan(probe);
        primary = subPlan?.tiers?.[t]?.consult_model || '';
      }
      if (!isCodexModelId(primary)) {
        return {
          ok: false,
          status: 400,
          error: '未找到可用的 Codex 订阅模型，无法切为仅订阅模式。',
        };
      }

      let escalateModel = String(baseTier.escalate_model || '').trim();
      if (t === 'opus') {
        if (escalateModel && !isCodexModelId(escalateModel)) {
          const memberEsc = members.find((m) => isCodexModelId(m) && m !== primary);
          if (memberEsc) escalateModel = memberEsc;
          else {
            if (!subPlan) subPlan = pickSubscriptionPlan(await ensureProbe());
            escalateModel = subPlan?.tiers?.opus?.escalate_model || '';
          }
        }
      } else {
        escalateModel = '';
      }

      const cleanTier = {
        ...baseTier,
        consult_model: primary,
        exec_model: primary,
        fallback_models: [],
        magpie_group_members: t === 'opus' && escalateModel ? dedupe([primary, escalateModel]) : [primary],
      };
      if (t === 'opus') {
        if (escalateModel) cleanTier.escalate_model = escalateModel;
        else delete cleanTier.escalate_model;
      }
      nextTiers[t] = cleanTier;
    }
  } else {
    const snap = curPolicy.api_fallback_snapshot;
    if (hasApiSnapshot(current)) {
      for (const t of TIER_ORDER) {
        const baseTier = { ...DEFAULT_TIERS[t], ...(curTiers[t] && typeof curTiers[t] === 'object' ? curTiers[t] : {}) };
        const savedTier = snap[t];
        if (savedTier && typeof savedTier === 'object' && savedTier.consult_model) {
          baseTier.consult_model = String(savedTier.consult_model);
          baseTier.exec_model = savedTier.exec_model !== undefined ? String(savedTier.exec_model) : String(savedTier.consult_model);
          if (savedTier.escalate_model) baseTier.escalate_model = String(savedTier.escalate_model);
          else delete baseTier.escalate_model;
          baseTier.fallback_models = Array.isArray(savedTier.fallback_models) ? [...savedTier.fallback_models] : [];
          baseTier.magpie_group_members = Array.isArray(savedTier.magpie_group_members) ? [...savedTier.magpie_group_members] : [];
        }
        nextTiers[t] = baseTier;
      }
      delete nextPolicy.api_fallback_snapshot;
    } else {
      const probe = await ensureProbe();
      if (!probe.reachable) {
        return {
          ok: false,
          status: 503,
          error: '无法连接本地 Magpie 网关，无法自动匹配按量 openai/* 备用模型。',
        };
      }
      const openaiModels = probe.openai_models || [];
      if (!openaiModels.length) {
        return {
          ok: false,
          status: 400,
          error: 'Magpie 中未检测到按量 openai/* 模型，请先在 Magpie 接入 OpenAI API 渠道。',
        };
      }
      const subPlan = pickSubscriptionPlan(probe);
      for (const t of TIER_ORDER) {
        const baseTier = { ...DEFAULT_TIERS[t], ...(curTiers[t] && typeof curTiers[t] === 'object' ? curTiers[t] : {}) };
        const primary = isCodexModelId(baseTier.consult_model)
          ? String(baseTier.consult_model).trim()
          : (subPlan?.tiers?.[t]?.consult_model || DEFAULT_TIERS[t].consult_model);
        const backup = findApiBackup(primary, openaiModels);
        const escalateModel = t === 'opus' ? String(baseTier.escalate_model || subPlan?.tiers?.opus?.escalate_model || '').trim() : '';
        const escalateBackup = escalateModel && escalateModel !== primary ? findApiBackup(escalateModel, openaiModels) : '';
        const fallbacks = dedupe([backup].filter((b) => b && b !== primary));
        const members = dedupe([primary, escalateModel, backup, escalateBackup]);
        nextTiers[t] = {
          ...baseTier,
          consult_model: primary,
          exec_model: primary,
          ...(t === 'opus' && escalateModel ? { escalate_model: escalateModel } : {}),
          fallback_models: fallbacks,
          magpie_group_members: members,
        };
      }
    }
  }

  const next = {
    ...current,
    routing_policy: nextPolicy,
    tiers: nextTiers,
  };
  const written = writeConfigAtomic(loaded.path, next);
  if (!written.ok) return written;

  return {
    ok: true,
    status: 200,
    failover_mode: normalized,
    config_path: loaded.path,
  };
}

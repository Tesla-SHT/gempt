/**
 * Zero-dependency backend helpers for the GemPT Magpie page service.
 *
 * Reads redacted configuration from ~/.config/gempt/config.json (or GEMPT_CONFIG),
 * probes local Magpie /v1/models without system proxies, initializes Codex
 * subscription-only routing configs, summarizes recent sessions/runs, and
 * atomically persists default_tier and default_sandbox changes.
 */
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const TIER_ORDER = ['sonnet', 'opus', 'fable'];
export const TIER_ALIASES = { lite: 'sonnet', mid: 'opus', max: 'fable' };
export const VALID_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const FEATURES = Object.freeze({ api_fallback: false });
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
    when_to_use: '80% 日常写代码、加小功能、改 UI、写脚本',
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
    when_to_use: '跨文件重构、读大仓库、复杂逻辑设计与排查（常规 Sol + 疑难 Astra）',
    consult_model: 'codex/gpt-6.2-sol',
    exec_model: '',
    escalate_model: 'codex/gpt-6.2-astra',
    escalate_effort_threshold: 'high',
    reasoning_effort: 'medium',
    api_mode: 'responses',
    max_output_tokens: 24576,
    fallback_models: [],
    magpie_group_members: [],
  },
  fable: {
    label: 'Fable · 顶配攻坚',
    when_to_use: '极难 Bug、核心算法/数学推导、长程架构设计',
    consult_model: 'codex/gpt-6.2-astra',
    exec_model: '',
    reasoning_effort: 'high',
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

function expandUser(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
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

function defaultGatewayFromEnv() {
  let raw = String(process.env.MAGPIE_ADDR || process.env.MAGPIE_GATEWAY || '').trim();
  if (!raw) return DEFAULT_MAGPIE_URL;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_MAGPIE_URL;
  }
}

function readJsonSafe(filePath) {
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

function resolveMagpieApiKey(cfg) {
  const magpieCfg = cfg?.magpie || {};
  const endpoint = String(magpieCfg.base_url || DEFAULT_MAGPIE_URL).replace(/\/+$/, '');
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

function resolveExcludedTokens(cfg) {
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
        escalate_effort_threshold: 'high',
        reasoning_effort: 'medium',
        fallback_models: [],
        magpie_group_members: dedupe([sonnetModel, fableModel]),
      },
      fable: {
        ...DEFAULT_TIERS.fable,
        consult_model: fableModel,
        exec_model: fableModel,
        reasoning_effort: 'high',
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
  const sol = pickBest(codexIds, [['6.2-sol', 300], ['sol', 240], ['terra', 140], ['luna', 100]]);
  const astra = pickBest(codexIds, [['6.2-astra', 320], ['astra', 260], ['pro', 180], ['sol', 100]]);
  const flash = utilityIds[0] || '';

  return {
    models: { hydrogen, neon, argon, sol, astra, flash },
    tiers: {
      sonnet: {
        group_id: 'group/gempt-sonnet',
        members: dedupe([hydrogen, sol, flash]),
        nodes: [
          { id: hydrogen, role: 'planner' },
          { id: sol, role: 'coder' },
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
            const geminiSet = new Set();
            const utilSet = new Set();
            const harnessGroups = [];
            const nativeGroups = [];
            for (const item of models) {
              const id = String(item?.id || '');
              if (!id || isExcludedModel(id, excludedTokens)) continue;
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
              } else if (isUtilityCandidate(item, excludedTokens)) {
                utilSet.add(id);
              }
            }
            const codexModels = [...codexSet];
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
    when_to_use: String(merged.when_to_use || fallback.when_to_use),
    consult_model: consultModel,
    exec_model: effectiveExec,
    escalate_model: String(merged.escalate_model || '').trim(),
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
  const magpie_mcp_registered = mcpList.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const text = `${entry.name || ''} ${entry.id || ''} ${entry.command || ''} ${JSON.stringify(entry.args || [])}`.toLowerCase();
    return text.includes('gempt');
  });

  return {
    antigravity_installed,
    magpie_clients: [...magpieSet],
    external_clients: [...externalSet],
    magpie_mcp_registered,
  };
}

function resolvePythonBin() {
  const envBin = String(process.env.PYTHON_BIN || '').trim();
  if (envBin) return envBin;
  if (process.platform === 'win32') {
    const msysPy = 'C:\\msys64\\mingw64\\bin\\python.exe';
    if (existsSync(msysPy)) return msysPy;
    for (const dir of String(process.env.PATH || '').split(delimiter)) {
      if (!dir || dir.toLowerCase().includes('windowsapps')) continue;
      for (const name of ['python3.exe', 'python.exe']) {
        const cand = join(dir, name);
        if (existsSync(cand)) return cand;
      }
    }
    return 'python';
  }
  return 'python3';
}

export function buildMcpSnippet({ antigravityPluginDir, repoRoot = REPO_ROOT } = {}) {
  const agyDir = antigravityPluginDir
    ? resolve(expandUser(antigravityPluginDir))
    : resolve(join(homedir(), '.gemini', 'config', 'plugins', 'gempt'));
  const installedRuntime = join(agyDir, 'runtime');
  const targetRoot = existsSync(join(installedRuntime, 'gempt', 'mcp_server.py'))
    ? installedRuntime
    : resolve(join(repoRoot, 'src'));

  const pythonBin = resolvePythonBin();
  const config = {
    mcpServers: {
      gempt: {
        command: pythonBin,
        args: [
          '-I',
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

export async function readState({ configPath, sessionsDir, magpieConfigDir, antigravityPluginDir, probeTimeoutMs = 2000 } = {}) {
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

  return {
    features: { ...FEATURES },
    configured,
    config_path: resolvedConfigPath,
    default_tier: defaultTier,
    failover_mode: 'subscription_only',
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
    recent_group_calls: recentGroupCalls,
    magpie,
    tiers,
    utility,
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

function writeConfigAtomic(resolvedConfigPath, nextObj) {
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
      default_tier: defaultTier,
      failover_mode: 'subscription_only',
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

function buildMagpieCliEnv() {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = '127.0.0.1,localhost,::1';
  return env;
}

export function findMagpieCli(configuredPath = '') {
  const candidates = [];
  if (configuredPath && String(configuredPath).trim()) {
    candidates.push(expandUser(String(configuredPath).trim()));
  }
  const envBin = String(process.env.MAGPIE_BIN || '').trim();
  if (envBin) candidates.push(expandUser(envBin));

  const names = process.platform === 'win32' ? ['magpie.com', 'magpie.exe', 'magpie.cmd', 'magpie'] : ['magpie'];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      candidates.push(join(dir, name));
    }
  }

  if (process.platform === 'win32') {
    const localApp = String(process.env.LOCALAPPDATA || '').trim();
    candidates.push(
      join(homedir(), 'apps', 'magpie', 'magpie.com'),
      join(homedir(), 'apps', 'magpie', 'magpie.exe'),
      'D:\\apps\\magpie\\magpie.com',
      'D:\\apps\\magpie\\magpie.exe',
    );
    if (localApp) {
      candidates.push(
        join(localApp, 'Programs', 'magpie', 'magpie.com'),
        join(localApp, 'Programs', 'magpie', 'magpie.exe'),
      );
    }
  } else {
    candidates.push(
      join(homedir(), '.local', 'opt', 'magpie', 'magpie'),
      join(homedir(), 'apps', 'magpie', 'magpie'),
      join(homedir(), '.local', 'bin', 'magpie'),
      '/Applications/magpie.app/Contents/MacOS/magpie',
      '/usr/local/bin/magpie',
    );
  }

  for (const cand of candidates) {
    try {
      if (cand && existsSync(cand) && statSync(cand).isFile()) {
        return cand;
      }
    } catch {
      // Ignore invalid or inaccessible candidate path.
    }
  }
  return '';
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
  const s = normalizeGroupMember(plan.models.sol);
  const t = normalizeGroupMember(plan.models.astra);
  const f = plan.models.flash ? normalizeGroupMember(plan.models.flash) : '';

  const tierCommands = {
    'gempt-sonnet': [
      ['group', 'add', 'gempt-sonnet', `models=${dedupe([h, s, f]).join(',')}`, 'routing=order', 'stays=turn'],
      ...(f ? [
        ['group', 'rule', 'add', 'gempt-sonnet', `use=${f}`, 'compact'],
        ['group', 'rule', 'add', 'gempt-sonnet', `use=${f}`, `classifier=${f}`, 'intent=simple formatting, adding comments, renaming, translating, writing boilerplate, or trivial quick questions'],
      ] : []),
      ['group', 'rule', 'add', 'gempt-sonnet', `use=${s}`, 'when=subagent'],
      ['group', 'rule', 'add', 'gempt-sonnet', `use=${s}`, 'intent=writing code, editing files, running tests, or fixing bugs'],
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

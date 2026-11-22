import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_MAGPIE_URL, DEFAULT_TIERS, DEFAULT_UTILITY, TIER_ORDER, expandUser, isCodexModelId,
  readJsonSafe, resolveConfigPath, resolveSessionsDir,
} from './config.mjs';

const execFileAsync = promisify(execFile);

export const NATIVE_GROUP_SPECS = [
  { id: 'sonnet', name: 'gempt-sonnet', group_id: 'group/gempt-sonnet' },
  { id: 'opus', name: 'gempt-opus', group_id: 'group/gempt-opus' },
  { id: 'fable', name: 'gempt-fable', group_id: 'group/gempt-fable' },
];

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

export function dedupe(items) {
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

export function pickDefaultSubscriptionModel(probe) {
  return pickBest(probe?.codex_models || [], [['6.2-sol', 300], ['sol', 240], ['terra', 140], ['luna', 100]]);
}

export function pickSubscriptionPlan(probe) {
  const codexIds = Array.isArray(probe?.codex_models) ? probe.codex_models : [];
  const utilityIds = Array.isArray(probe?.utility_candidates) ? probe.utility_candidates : [];
  return pickTierPlan(codexIds, utilityIds);
}

export function pickTierPlan(models, utilityIds) {
  if (!models.length) return null;
  const sonnetModel = pickDefaultSubscriptionModel({ codex_models: models });
  const fableModel = pickBest(models, [['6.2-astra', 320], ['astra', 260], ['pro', 180], ['sol', 100]]);
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

  const tierCommands = nativeGroupCommands(plan.models);
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

  return { ok: true, status: 200, created, skipped, groups: NATIVE_GROUP_SPECS.map((spec) => spec.group_id), models: plan.models };
}

export function isHarnessGroup(model) {
  return /^group\/gempt-harness-(sonnet|opus|fable)$/.test(model);
}

function groupMemberRows(report) {
  return (report.match(/^[ \t]*models[ \t]+([^\r\n]+(?:\r?\n[ \t]+\d+[ \t]+[^\r\n]+)*)/m)?.[1] || '')
    .split(/\r?\n/).filter(Boolean);
}

function groupRules(report) {
  return [...report.matchAll(/^[ \t]*(?:rules[ \t]+)?\d+[ \t]+(.+ → .+)$/gm)].map((match) => match[1].trim());
}

export async function verifySubscriptionGroup(config, model) {
  if (!isHarnessGroup(model) || String(config.magpie?.base_url || DEFAULT_MAGPIE_URL).replace(/\/+$/, '') !== DEFAULT_MAGPIE_URL) {
    throw new Error(`Cannot verify subscription group '${model}' against the local Magpie gateway.`);
  }
  const cli = findMagpieCli(config.magpie?.cli_path);
  if (!cli) throw new Error('Subscription group verification requires Magpie CLI.');
  const result = await execMagpieCli(cli, ['group', 'show', model.slice('group/'.length)]);
  if (!result.ok) throw new Error(`Unable to verify subscription group '${model}'.`);
  const members = groupMemberRows(result.stdout).map((row) => row.match(/^\s*\d+\s+(\S+)\s+.+ · .+$/)?.[1]);
  const targets = groupRules(result.stdout).map((rule) => rule.split(' → ').at(-1));
  if (!members.length || ![...members, ...targets].every(isCodexModelId)) {
    throw new Error(`Subscription group '${model}' must contain only concrete codex/* models.`);
  }
}

function nativeGroupCommands(models) {
  const h = normalizeGroupMember(models.hydrogen);
  const n = normalizeGroupMember(models.neon);
  const a = normalizeGroupMember(models.argon);
  const terra = normalizeGroupMember(models.terra);
  const s = normalizeGroupMember(models.sol);
  const t = normalizeGroupMember(models.astra);
  const f = models.flash ? normalizeGroupMember(models.flash) : '';
  return {
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

}

export function previewNativeGroups(env = process.env) {
  const models = {
    hydrogen: env.GEMPT_HYDROGEN?.trim() || 'antigravity/gemini-4-hydrogen',
    neon: env.GEMPT_NEON?.trim() || 'antigravity/gemini-4-neon',
    argon: env.GEMPT_ARGON?.trim() || 'antigravity/gemini-4-carbon',
    terra: env.GEMPT_TERRA?.trim() || env.GEMPT_SOL?.trim() || 'codex/gpt-6.1-terra',
    sol: env.GEMPT_SOL?.trim() || 'codex/gpt-6.2-sol',
    astra: env.GEMPT_ASTRA?.trim() || 'codex/gpt-6.2-astra',
    flash: env.DEEPSEEK_FLASH?.trim() || DEFAULT_UTILITY.model,
  };
  return { applied: false, models, commands: Object.values(nativeGroupCommands(models)).flat()
    .map((args) => [env.MAGPIE_BIN?.trim() || 'magpie', ...args]) };
}

export async function syncHarnessGroups(config, { dryRun }) {
  const cli = findMagpieCli(config.magpie.cli_path);
  if (!cli && !dryRun) throw new Error('Magpie CLI not found. Set MAGPIE_BIN to sync routing groups.');
  const { failover_mode: mode, magpie_group_strategy: strategy } = config.routing_policy;
  const utility = config.utility.use_for_magpie_compact ? normalizeGroupMember(config.utility.model) : '';
  const compact = mode === 'subscription_only' && !isCodexModelId(utility) ? '' : utility;
  const plans = TIER_ORDER.map((tier) => {
    const data = config.tiers[tier];
    const name = `gempt-harness-${tier}`;
    const members = dedupe([...(data.magpie_group_members || []), compact].filter(Boolean).map(normalizeGroupMember));
    const note = `gempt ${tier} (${data.label || tier})`;
    const settings = [`models=${members.join(',')}`, `routing=${strategy}`, 'stays=session'];
    const commands = [['group', 'add', name, ...settings, `note=${note}`]];
    const escalation = normalizeGroupMember(data.escalate_model);
    if (tier === 'opus' && escalation && members.includes(escalation) && escalation !== members[0]) {
      commands.push(['group', 'rule', 'add', name, `use=${escalation}`, `effort=${data.escalate_effort_threshold || 'high'}`]);
    }
    if (compact) commands.push(['group', 'rule', 'add', name, `use=${compact}`, 'compact']);
    return { tier, name, note, settings, members, commands };
  });
  if (!dryRun) {
    const run = async (args) => {
      const result = await execMagpieCli(cli, args);
      if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || `Magpie ${args.join(' ')} failed.`);
      return result.stdout;
    };
    const { withLock } = await import('../../core/state.mjs');
    await withLock(join(resolveSessionsDir(), '.groups.lock'), async () => {
      for (const { name, note, settings, members, commands } of plans) {
        const show = await execMagpieCli(cli, ['group', 'show', name]);
        let report = show.stdout;
        if (!show.ok) {
          if (!`${show.stdout}\n${show.stderr}`.includes(`no group "${name}"`)) {
            throw new Error(show.stderr.trim() || `Unable to inspect group/${name}.`);
          }
          await run(commands[0]);
          report = await run(['group', 'show', name]);
        }
        const lines = report.split(/\r?\n/).map((line) => line.trim());
        if (!lines.some((line) => line.startsWith('note') && line.replace(/^note\s+/, '') === note)) {
          throw new Error(`Existing group/${name} has a different owner.`);
        }
        const groupMembers = (output) => groupMemberRows(output).map((line) => line.match(/^\s*\d+\s+(\S+)/)?.[1]).filter(Boolean);
        const rules = groupRules(report);
        const current = groupMembers(report);
        if (!current.length) throw new Error(`Cannot read members for group/${name}.`);
        if (rules.some((rule) => !members.includes(rule.split(' → ').at(-1)))) {
          throw new Error(`Changing members would invalidate an existing rule on group/${name}.`);
        }
        const expectedRules = [];
        const additions = commands.slice(1).filter((command) => {
          const target = command.at(-2).slice(4);
          const condition = command.at(-1) === 'compact' ? 'compacting' : `effort ≥ ${command.at(-1).slice(7)}`;
          const expected = `${condition} → ${target}`;
          expectedRules.push(expected);
          if (rules.includes(expected)) return false;
          if (rules.some((rule) => rule.startsWith(`${condition} → `))) throw new Error(`Conflicting rule on group/${name}: ${condition}`);
          return true;
        });
        const hasSettings = (output) => settings.slice(1).every((setting) => {
          const [key, value] = setting.split('=');
          return new RegExp(`^\\s*${key}\\s+${value}\\s*$`, 'm').test(output);
        });
        const sameMembers = (values) => values.join(',') === members.join(',');
        const update = !sameMembers(current) || !hasSettings(report);
        if (update) await run(['group', 'set', name, ...settings]);
        for (const command of additions) await run(command);
        const final = update || additions.length ? await run(['group', 'show', name]) : report;
        if (!hasSettings(final) || !sameMembers(groupMembers(final)) ||
            !expectedRules.every((rule) => groupRules(final).includes(rule))) {
          throw new Error(`Group readback differs for group/${name}.`);
        }
      }
    });
  }
  return plans.map(({ tier, name, commands }) => ({ tier, group: `group/${name}`,
    commands: commands.map((command) => [cli || 'magpie', ...command]) }));
}

export function findApiBackup(subModel, openaiModels) {
  if (!Array.isArray(openaiModels) || !openaiModels.length) return '';
  const bare = String(subModel || '').split('/').pop().toLowerCase();
  for (const oid of openaiModels) {
    if (String(oid || '').split('/').pop().toLowerCase() === bare) return oid;
  }
  if (bare.includes('astra')) return pickBest(openaiModels, [['astra', 220], ['sol', 120]]);
  if (bare.includes('sol')) return pickBest(openaiModels, [['sol', 220], ['terra', 120]]);
  return pickBest(openaiModels, [['terra', 200], ['mini', 150], ['sol', 100]]);
}

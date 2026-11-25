import http from 'node:http';
import https from 'node:https';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import {
  DEFAULT_MAGPIE_URL, DEFAULT_TIERS, DEFAULT_UTILITY, expandUser,
  isPairingModelId, normalizeGatewayUrl, readJsonSafe,
} from './config.mjs';

export function defaultGatewayFromEnv() {
  let raw = String(process.env.MAGPIE_ADDR || process.env.MAGPIE_GATEWAY || '').trim();
  if (!raw) return DEFAULT_MAGPIE_URL;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  return normalizeGatewayUrl(raw) || DEFAULT_MAGPIE_URL;
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

export function resolveMagpieApiKey(cfg, targetUrl = '', { allowLocalFallback = true } = {}) {
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
  const envName = String(magpieCfg.api_key_env ?? 'GEMPT_MAGPIE_API_KEY').trim();
  if (envName) {
    const envVal = String(process.env[envName] || '').trim();
    if (envVal) return envVal;
  }
  const cfgVal = String(magpieCfg.api_key || '').trim();
  if (cfgVal) return cfgVal;
  if (endpoint !== DEFAULT_MAGPIE_URL || !allowLocalFallback) return '';
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

export function pickDelegatePlan(probe) {
  const subscription = pickSubscriptionPlan(probe);
  if (subscription) return subscription;
  const available = (probe.models || []).filter(id => isPairingModelId(id)
    && !/(?:embedding|rerank|image|tts|whisper|veo)/i.test(id));
  const preferred = available.filter(id => /(?:^|[/-])gpt(?:[/-]|$)/i.test(id));
  const models = preferred.length ? preferred : available;
  return pickTierPlan(models, probe.utility_candidates?.length ? probe.utility_candidates : models);
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
      },
      opus: {
        ...DEFAULT_TIERS.opus,
        consult_model: sonnetModel,
        exec_model: sonnetModel,
        escalate_model: fableModel,
        escalate_effort_threshold: 'xhigh',
        reasoning_effort: 'high',
        fallback_models: [],
      },
      fable: {
        ...DEFAULT_TIERS.fable,
        consult_model: fableModel,
        exec_model: fableModel,
        reasoning_effort: 'xhigh',
        fallback_models: [],
      },
    },
    utility_model: utilityModel,
  };
}

function isGeminiCandidate(id, excludedTokens) {
  const raw = String(id || '').trim();
  const lower = raw.toLowerCase();
  if (!raw || isExcludedModel(raw, excludedTokens)) return false;
  if (!lower.includes('gemini')) return false;
  return !['embedding', 'tts', 'image', 'imagen', 'veo'].some((bad) => lower.includes(bad));
}

function emptyProbeResult(url, error) {
  return {
    reachable: false,
    url,
    total_models: 0,
    models: [],
    codex_models: [],
    openai_models: [],
    gemini_models: [],
    codex_ready: false,
    utility_candidates: [],
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
  if (apiKey && !/^[\x20-\x7e]+$/.test(apiKey)) return Promise.resolve(emptyProbeResult(cleanedUrl, 'Invalid gateway credential.'));
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
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
            if (totalBytes > maxBytes || !Array.isArray(body?.data)) throw new Error('Invalid model catalog');
            const models = body.data;
            const visibleIds = [];
            const codexSet = new Set();
            const openaiSet = new Set();
            const geminiSet = new Set();
            const utilSet = new Set();
            for (const item of models) {
              const id = typeof item?.id === 'string' ? item.id : '';
              if (!id || (apiKey && (id === apiKey || (apiKey.length >= 8 && id.includes(apiKey)))) || isExcludedModel(id, excludedTokens)) continue;
              const owned = String(item?.owned_by || '').toLowerCase();
              const label = String(item?.magpie_label || '').toLowerCase();
              const isGroup = id.startsWith('group/') || id.startsWith('auto/') || label.includes('routing group');
              visibleIds.push(id);
              if (isGeminiCandidate(id, excludedTokens)) {
                geminiSet.add(id);
              }
              if (isGroup) {
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
              models: visibleIds,
              codex_models: codexModels,
              openai_models: openaiModels,
              gemini_models: geminiModels,
              codex_ready: codexModels.length > 0,
              utility_candidates: utilityCandidates,
              error: '',
            });
          } catch {
            finish(emptyProbeResult(cleanedUrl, 'Invalid gateway model response.'));
          }
        });
      },
    );

    const deadline = setTimeout(() => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('error', (err) => {
      finish(emptyProbeResult(cleanedUrl, err.message));
    });
    req.end();
  });
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
    dirs.push(join(homedir(), '.local', 'bin'), join(homedir(), '.local', 'opt', 'magpie'), '/opt/homebrew/bin', '/usr/local/bin');
    if (process.platform === 'darwin') {
      dirs.push('/Applications/Magpie.app/Contents/MacOS', '/Applications/magpie.app/Contents/MacOS');
    }
  }
  return findExecutable([...candidates, ...dirs.flatMap((dir) => names.map((name) => join(dir, name)))]);
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

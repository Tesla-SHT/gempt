import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isAstraModel } from '../magpie_plugin/lib/routing.mjs';
import { WORKLOAD } from './assets.mjs';
import { RUNTIME_ROOT, resolvePluginRoot } from './bundle-paths.mjs';
import { withLockSync } from './state.mjs';

export const GEMPT_VERSION = readJsonSafe(join(RUNTIME_ROOT, 'package.json'))?.version
  || readJsonSafe(join(resolvePluginRoot(), 'plugin.json'))?.version || '0.8.0';
export const TIER_ORDER = ['sonnet', 'opus', 'fable'];
export const TIER_ALIASES = { lite: 'sonnet', mid: 'opus', max: 'fable' };
export const VALID_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const EFFORT_RANK = Object.freeze(Object.fromEntries(VALID_EFFORTS.map((name, idx) => [name, idx])));
export const VALID_FAILOVER_MODES = ['subscription_only', 'api_fallback'];
export const FEATURES = Object.freeze({ api_fallback: true });
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425';
export const DEFAULT_MCP_EFFORT = 'medium';
export const SAFE_MODEL_ID = /^[A-Za-z0-9._:/@-]{1,128}$/;
export const UI_LANGUAGES = ['auto', 'zh', 'en'];
export const UTILITY_EFFORTS = ['', 'low', 'medium', 'high'];
export const DEFAULT_CONSULT_TIMEOUT_SEC = 180;
export const RUNNER_IDS = Object.freeze([
  'codex', 'opencode', 'claude', 'gemini', 'pi', 'cursor', 'kimi', 'grok', 'kilo', 'copilot', 'qoder',
]);
export const CLI_CHOICES = Object.freeze(['auto', ...RUNNER_IDS]);

export function getExecutionConfig(cfg) {
  const exec = cfg?.execution && typeof cfg.execution === 'object' && !Array.isArray(cfg.execution) ? cfg.execution : {};
  const rawDefault = String(exec.default_cli || 'auto').trim().toLowerCase();
  const default_cli = CLI_CHOICES.includes(rawDefault) ? rawDefault : 'auto';
  const rawPaths = exec.cli_paths && typeof exec.cli_paths === 'object' && !Array.isArray(exec.cli_paths) ? exec.cli_paths : {};
  const cli_paths = {};
  for (const id of RUNNER_IDS) {
    const val = typeof rawPaths[id] === 'string' ? rawPaths[id].trim() : '';
    if (val) cli_paths[id] = val;
  }
  const legacyCodex = typeof cfg?.codex?.cli_path === 'string' ? cfg.codex.cli_path.trim() : '';
  if (!cli_paths.codex && legacyCodex) cli_paths.codex = legacyCodex;
  return { default_cli, cli_paths };
}

export const hasRuntimeConfig = (cfg) => Boolean(cfg && Object.keys(cfg).some((key) => key !== 'ui'));
export const getUiLanguage = (cfg) => UI_LANGUAGES.includes(cfg?.ui?.language) ? cfg.ui.language : 'auto';


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
  },
};

export const DEFAULT_UTILITY = {
  label: 'Chore · 免费打杂/压缩/分类',
  model: 'auto/deepseek-v4.1-flash',
  reasoning_effort: 'low',
  api_mode: 'chat',
  max_output_tokens: 4096,
  fallback_models: [],
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

export function getMcpEffort(policy) {
  const effort = String(policy?.mcp_effort || '').trim().toLowerCase();
  return VALID_EFFORTS.includes(effort) && effort !== 'ultra' ? effort : DEFAULT_MCP_EFFORT;
}

export function getNativeSwarmPolicy(policy) {
  return {
    native_swarm: typeof policy?.native_swarm === 'boolean' ? policy.native_swarm : WORKLOAD.native_swarm,
    swarm_shell_model: isSafeModelId(policy?.swarm_shell_model)
      ? policy.swarm_shell_model : WORKLOAD.swarm_shell_model,
  };
}

export function getPairing(policy, family) {
  if (typeof family !== 'string' || !Object.hasOwn(WORKLOAD.pairings, family)) return 'default';
  return policy?.pairings?.[family] ?? WORKLOAD.pairings[family];
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

export function readJsonSafe(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildTierView(tierId, tierCfg, defaultTier, fallbackPreset) {
  const fallback = fallbackPreset || DEFAULT_TIERS[tierId];
  const merged = { ...fallback, ...(tierCfg || {}) };
  const consultModel = String(merged.consult_model || fallback.consult_model);
  const execModel = String(merged.exec_model || '').trim();
  const effectiveExec = execModel || consultModel;
  return {
    id: tierId,
    label: String(merged.label || fallback.label),
    usage_share: String(merged.usage_share || fallback.usage_share || ''),
    when_to_use: String(merged.when_to_use || fallback.when_to_use),
    consult_model: consultModel,
    exec_model: effectiveExec,
    escalate_model: String(merged.escalate_model || '').trim(),
    escalate_effort_threshold: String(merged.escalate_effort_threshold || fallback.escalate_effort_threshold || 'high').trim(),
    reasoning_effort: String(merged.reasoning_effort || fallback.reasoning_effort),
    fallback_models: Array.isArray(merged.fallback_models) ? merged.fallback_models.filter(Boolean).map(String) : [],
    active: tierId === defaultTier,
  };
}

function readPluginOptions(magpieConfigDir) {
  const plugins = readJsonSafe(join(magpieConfigDir, 'plugins.json'));
  const list = Array.isArray(plugins?.plugins) ? plugins.plugins : [];
  const entry = list.find((item) => String(item?.spec || '').toLowerCase().includes('gempt'));
  return entry?.options;
}

export function readPluginExecOption(magpieConfigDir) {
  return String(process.env.GEMPT_MAGPIE_TOOLS_EXEC || '') === '1' || readPluginOptions(magpieConfigDir)?.exec === true;
}

export function readPluginMcpToolsOption(magpieConfigDir) {
  return String(process.env.GEMPT_MAGPIE_DISABLE_TOOLS || '') !== '1' && readPluginOptions(magpieConfigDir)?.mcpTools !== false;
}

export function hasApiSnapshot(cfg) {
  const snap = cfg?.routing_policy?.api_fallback_snapshot;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
  return TIER_ORDER.some((t) => snap[t] && typeof snap[t] === 'object' && typeof snap[t].consult_model === 'string' && snap[t].consult_model.trim());
}

export function readExistingConfigObject(configPath) {
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
  const tmpFile = join(parentDir, `.config.json.tmp.${process.pid}.${randomUUID()}`);
  try {
    writeFileSync(tmpFile, JSON.stringify(nextObj, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
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

export function withConfigTransaction(configPath, mutator, { create = false } = {}) {
  const resolved = resolveConfigPath(configPath);
  const lockPath = `${resolved}.lock`;
  try {
    return withLockSync(lockPath, () => {
      let loaded = readExistingConfigObject(resolved);
      if (create && loaded.status === 404) loaded = { ok: true, path: resolved, data: {} };
      if (!loaded.ok) return loaded;
      const result = mutator(loaded);
      if (!result || result.ok === false || !result.next) return result;
      const written = writeConfigAtomic(loaded.path, result.next);
      if (!written.ok) return written;
      return result.response || written;
    });
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: `Failed to acquire gempt config lock: ${err.message}`,
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

  return withConfigTransaction(configPath, (loaded) => ({
    next: {
      ...loaded.data,
      routing_policy: {
        ...(loaded.data.routing_policy && typeof loaded.data.routing_policy === 'object' ? loaded.data.routing_policy : {}),
        default_tier: normalized,
      },
    },
    response: {
      ok: true,
      status: 200,
      default_tier: normalized,
      config_path: loaded.path,
    },
  }));
}

export function setPairing(family, model, { configPath } = {}) {
  return withConfigTransaction(configPath, (loaded) => editPairing(loaded, family, model));
}

export function editPairing(loaded, family, model) {
  if (typeof family !== 'string' || !Object.hasOwn(WORKLOAD.pairings, family) ||
      !isPairingModelId(model)) {
    return { ok: false, status: 400, error: '请选择有效的 Gemini 档位和 Magpie 模型。' };
  }
  const policy = loaded.data.routing_policy;
  return { next: { ...loaded.data, routing_policy: { ...policy, pairings: { ...policy?.pairings, [family]: model } } } };
}

export function setWorkSplit(key, profile, { configPath } = {}) {
  return withConfigTransaction(configPath, (loaded) => editWorkSplit(loaded, key, profile));
}

export function editWorkSplit(loaded, key, profile) {
  if (!['work_split', 'swarm_split'].includes(key) ||
      typeof profile !== 'string' || !(Object.hasOwn(WORKLOAD.profiles, profile) || (key === 'swarm_split' && profile === 'inherit'))) {
    return { ok: false, status: 400, error: '请选择有效的工作分工档位。' };
  }
  return { next: { ...loaded.data, routing_policy: { ...loaded.data.routing_policy, [key]: profile } } };
}

export function setDefaultSandbox(sandbox, { configPath } = {}) {
  return withConfigTransaction(configPath, (loaded) => editDefaultSandbox(loaded, sandbox));
}

export function editDefaultSandbox(loaded, sandbox) {
  const normalized = typeof sandbox === 'string' ? sandbox.trim() : '';
  if (!VALID_SANDBOXES.includes(normalized)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid default sandbox. Expected one of: ${VALID_SANDBOXES.join(', ')}.`,
    };
  }

  return {
    next: {
      ...loaded.data,
      codex: {
        ...(loaded.data.codex && typeof loaded.data.codex === 'object' ? loaded.data.codex : {}),
        default_sandbox: normalized,
      },
    },
    response: {
      ok: true,
      status: 200,
      default_sandbox: normalized,
      config_path: loaded.path,
    },
  };
}

export function setEffortSettings(settings = {}, { configPath } = {}) {
  return withConfigTransaction(configPath, (loaded) => editEffortSettings(loaded, settings));
}

export function editEffortSettings(loaded, { mcpEffort, tierEffort, tier, autoEffort }) {
  const existingPolicy = loaded.data.routing_policy && typeof loaded.data.routing_policy === 'object'
    ? loaded.data.routing_policy
    : {};
  const invalid = validateEffortSettings({ mcpEffort, tierEffort, tier, autoEffort });
  if (invalid) return invalid;
  if (mcpEffort !== undefined || (tierEffort === undefined && tier === undefined)) {
    const policy = { ...existingPolicy };
    if (mcpEffort !== undefined) {
      const effort = mcpEffort.trim().toLowerCase();
      policy.mcp_effort = effort;
    }
    policy.auto_effort = autoEffort ?? (mcpEffort === undefined && Boolean(policy.auto_effort));
    return {
      next: { ...loaded.data, routing_policy: policy },
      response: { ok: true, status: 200, auto_effort: policy.auto_effort, mcp_effort: getMcpEffort(policy), config_path: loaded.path },
    };
  }

  const existingTiers = loaded.data.tiers && typeof loaded.data.tiers === 'object'
    ? loaded.data.tiers
    : {};

  const targetTier = tier === undefined ? normalizeDefaultTier(existingPolicy.default_tier || 'sonnet')
    : typeof tier === 'string' && normalizeDefaultTier(tier);
  if (!targetTier) {
    return {
      ok: false,
      status: 400,
      error: `Invalid target tier '${String(tier ?? '')}'. Expected one of: ${TIER_ORDER.join(', ')}.`,
    };
  }

  let nextAutoEffort = Boolean(existingPolicy.auto_effort);
  if (autoEffort !== undefined) nextAutoEffort = autoEffort;

  const nextTiers = { ...existingTiers };
  const targetTierCfg = { ...DEFAULT_TIERS[targetTier], ...(existingTiers[targetTier] || {}) };

  const cleanEffort = tierEffort?.trim().toLowerCase();
  if (cleanEffort) {
    const usesAstra = targetTier === 'fable'
      || isAstraModel(targetTierCfg.consult_model)
      || isAstraModel(targetTierCfg.exec_model);
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

  return {
    next,
    response: {
      ok: true,
      status: 200,
      auto_effort: nextAutoEffort,
      tier: targetTier,
      reasoning_effort: String(nextTiers[targetTier]?.reasoning_effort || targetTierCfg.reasoning_effort || 'medium'),
      config_path: loaded.path,
    },
  };
}

export function validateEffortSettings({ mcpEffort, tierEffort, tier, autoEffort }) {
  let error;
  if (autoEffort !== undefined && typeof autoEffort !== 'boolean') {
    error = 'auto_effort must be a boolean.';
  } else if (mcpEffort !== undefined) {
    const effort = typeof mcpEffort === 'string' ? mcpEffort.trim().toLowerCase() : '';
    if (tierEffort !== undefined || tier !== undefined) error = 'Set either mcp_effort or tier_effort.';
    else if (!VALID_EFFORTS.includes(effort) || effort === 'ultra') error = 'Invalid mcp_effort.';
  } else if (tier !== undefined && (typeof tier !== 'string' || !normalizeDefaultTier(tier))) {
    error = 'Invalid target tier.';
  } else if (tierEffort != null) {
    const effort = typeof tierEffort === 'string' ? tierEffort.trim().toLowerCase() : null;
    if (effort === 'ultra') error = '默认档位禁止设为 ultra，仅在极端个案单次手动传参。';
    else if (effort !== '' && !VALID_EFFORTS.includes(effort)) error = 'Invalid reasoning_effort.';
  }
  if (error) return { ok: false, status: 400, error };
}

const cleanText = (value) => typeof value === 'string' && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const cleanArray = (value) => Array.isArray(value) && value.every((item) => cleanText(item) && item.trim());
export const isSafeModelId = (value) => cleanText(value) && SAFE_MODEL_ID.test(value);
export const isPairingModelId = (value) => cleanText(value) && value.length > 0 && value.trim() === value;

export function normalizeGatewayUrl(value) {
  if (!cleanText(value) || !/^https?:\/\/[^/\\\s]/i.test(value.trim()) || /[?#\\]/.test(value)) return;
  try {
    const url = new URL(value.trim());
    if (!url.username && !url.password) return url.href.replace(/\/+$/, '');
  } catch { /* Invalid URL. */ }
}

export const GATEWAY_SETTINGS = {
  base_url: { type: 'string' },
  api_key: { type: 'string' },
  api_key_env: { type: 'string', pattern: '^(?:[A-Za-z_][A-Za-z0-9_]*)?$' },
  clear_api_key: { type: 'boolean' },
};

const settingRules = {
  magpie: {
    base_url: (value) => normalizeGatewayUrl(value) !== undefined,
    api_key: (value) => cleanText(value) && /^[\x20-\x7e]*$/.test(value),
    api_key_env: (value) => cleanText(value) && /^(?:[A-Za-z_][A-Za-z0-9_]*)?$/.test(value),
    clear_api_key: (value) => typeof value === 'boolean',
  },
  routing_policy: { swarm_shell_model: isSafeModelId, excluded_models: cleanArray },
  utility: { model: (value) => cleanText(value) && /^\S{1,256}$/u.test(value.trim()), reasoning_effort: (value) => UTILITY_EFFORTS.includes(value) },
  codex: { cli_path: cleanText, extra_args: cleanArray },
  execution: {
    default_cli: (value) => typeof value === 'string' && CLI_CHOICES.includes(value.trim().toLowerCase()),
    cli_paths: (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
      && Object.entries(value).every(([k, v]) => RUNNER_IDS.includes(k) && cleanText(v)),
  },
  limits: { consult_timeout_sec: (value) => Number.isInteger(value) && value >= 15 && value <= 1800 },
  ui: { language: (value) => UI_LANGUAGES.includes(value) },
};

export function editAdvancedSettings({ data }, section, fields, fallbackUrl = DEFAULT_MAGPIE_URL) {
  const invalid = (name) => ({ ok: false, status: 400, error: 'Invalid ' + name + '.' });
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return invalid(section);
  const rules = settingRules[section];
  const patch = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(rules, key) || !rules[key](value)) return invalid(section + '.' + key);
    patch[key] = Array.isArray(value) ? value.map((item) => item.trim())
      : typeof value === 'string' ? value.trim() : value;
  }
  if (section === 'limits' && Object.hasOwn(patch, 'consult_timeout_sec')) patch.consult_timeout_customized = true;
  if (section === 'magpie') {
    if (patch.base_url !== undefined) {
      patch.base_url = normalizeGatewayUrl(patch.base_url);
      if (patch.base_url !== normalizeGatewayUrl(data.magpie?.base_url || fallbackUrl) && patch.api_key === undefined) {
        patch.api_key = '';
      }
    }
    if (patch.clear_api_key) patch.api_key = '';
    delete patch.clear_api_key;
  }
  if (section === 'execution') {
    const existingExec = getExecutionConfig(data);
    const nextExec = { ...existingExec };
    if (patch.default_cli !== undefined) nextExec.default_cli = patch.default_cli.toLowerCase();
    if (patch.cli_paths !== undefined) {
      const mergedPaths = { ...existingExec.cli_paths };
      for (const [k, v] of Object.entries(patch.cli_paths)) {
        const clean = String(v || '').trim();
        if (clean) mergedPaths[k] = clean;
        else delete mergedPaths[k];
      }
      nextExec.cli_paths = mergedPaths;
    }
    const next = { ...data, execution: nextExec };
    if (patch.cli_paths && Object.hasOwn(patch.cli_paths, 'codex')) {
      next.codex = { ...(data.codex && typeof data.codex === 'object' ? data.codex : {}), cli_path: String(patch.cli_paths.codex || '').trim() };
    }
    return { next };
  }
  if (section === 'codex' && Object.hasOwn(patch, 'cli_path')) {
    const existingExec = getExecutionConfig(data);
    const nextPaths = { ...existingExec.cli_paths };
    if (patch.cli_path) nextPaths.codex = patch.cli_path;
    else delete nextPaths.codex;
    return {
      next: {
        ...data,
        codex: { ...data.codex, ...patch },
        execution: { ...existingExec, cli_paths: nextPaths },
      },
    };
  }
  return { next: { ...data, [section]: { ...data[section], ...patch } } };
}

// The managed app-server owns the transport, provider, approval, and sandbox
// flags. Only standalone flags without an argument can be passed through here.
export function codexAppServerExtraArgs(args = []) {
  return Array.isArray(args) ? args.filter((arg) => ['--strict-config', '--analytics-default-enabled'].includes(arg)) : [];
}

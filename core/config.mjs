import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isAstraModel } from '../magpie_plugin/lib/routing.mjs';
import { WORKLOAD } from './assets.mjs';
import { withLockSync } from './state.mjs';

export const TIER_ORDER = ['sonnet', 'opus', 'fable'];
export const TIER_ALIASES = { lite: 'sonnet', mid: 'opus', max: 'fable' };
export const VALID_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const EFFORT_RANK = Object.freeze(Object.fromEntries(VALID_EFFORTS.map((name, idx) => [name, idx])));
export const VALID_FAILOVER_MODES = ['subscription_only', 'api_fallback'];
export const FEATURES = Object.freeze({ api_fallback: true });
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425';
export const DEFAULT_MCP_EFFORT = 'medium';

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

export function getMcpEffort(policy) {
  const effort = String(policy?.mcp_effort || '').trim().toLowerCase();
  return VALID_EFFORTS.includes(effort) && effort !== 'ultra' ? effort : DEFAULT_MCP_EFFORT;
}

export function getPairing(policy, family) {
  if (!Object.hasOwn(WORKLOAD.pairings, family)) return 'default';
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
    magpie_group_members: Array.isArray(merged.magpie_group_members)
      ? merged.magpie_group_members.filter(Boolean).map(String)
      : [],
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

export function withConfigTransaction(configPath, mutator) {
  const resolved = resolveConfigPath(configPath);
  const lockPath = `${resolved}.lock`;
  try {
    return withLockSync(lockPath, () => {
      const loaded = readExistingConfigObject(resolved);
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
  if (!Object.hasOwn(WORKLOAD.pairings, family) ||
      (model !== 'default' && (typeof model !== 'string' || !isCodexModelId(model) || model.trim() !== model))) {
    return { ok: false, status: 400, error: '请选择有效的 Gemini 档位和 Codex 订阅模型。' };
  }
  return withConfigTransaction(configPath, (config) => {
    const policy = config.data.routing_policy ||= {};
    policy.pairings = { ...policy.pairings, [family]: model };
    return { next: config.data };
  });
}

export function setWorkSplit(key, profile, { configPath } = {}) {
  if (!['work_split', 'swarm_split'].includes(key) ||
      !(Object.hasOwn(WORKLOAD.profiles, profile) || (key === 'swarm_split' && profile === 'inherit'))) {
    return { ok: false, status: 400, error: '请选择有效的工作分工档位。' };
  }
  return withConfigTransaction(configPath, (config) => {
    config.data.routing_policy = { ...config.data.routing_policy, [key]: profile };
    return { next: config.data };
  });
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

  return withConfigTransaction(configPath, (loaded) => ({
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
  }));
}

export function setEffortSettings({ mcpEffort, tierEffort, tier, autoEffort } = {}, { configPath } = {}) {
  return withConfigTransaction(configPath, (loaded) => {
    const existingPolicy = loaded.data.routing_policy && typeof loaded.data.routing_policy === 'object'
      ? loaded.data.routing_policy
      : {};
    if (autoEffort !== undefined && typeof autoEffort !== 'boolean') {
      return { ok: false, status: 400, error: 'auto_effort must be a boolean.' };
    }
    if (mcpEffort !== undefined || (tierEffort === undefined && tier === undefined)) {
      if (tierEffort !== undefined || tier !== undefined) {
        return { ok: false, status: 400, error: 'Set either mcp_effort or tier_effort.' };
      }
      const policy = { ...existingPolicy };
      if (mcpEffort !== undefined) {
        const effort = String(mcpEffort || '').trim().toLowerCase();
        if (!VALID_EFFORTS.includes(effort) || effort === 'ultra') {
          return { ok: false, status: 400, error: `Invalid mcp_effort '${mcpEffort}'.` };
        }
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

    const targetTier = normalizeDefaultTier(tier || existingPolicy.default_tier || 'sonnet');
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
  });
}

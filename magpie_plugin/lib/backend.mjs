import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBudget } from './token-ratio.mjs';
import { WORKLOAD } from '../../core/assets.mjs';
import { resolveNodeExecutable } from '../../core/node-executable.mjs';
import {
  DEFAULT_TIERS, DEFAULT_UTILITY, FEATURES, TIER_ORDER, VALID_FAILOVER_MODES, VALID_SANDBOXES,
  buildTierView, expandUser, hasApiSnapshot, isCodexModelId, normalizeDefaultTier,
  readExistingConfigObject, readJsonSafe, readPluginExecOption, readPluginMcpToolsOption,
  resolveConfigPath, resolveMagpieConfigDir, resolveSessionsDir, writeConfigAtomic,
} from '../../core/config.mjs';
import {
  NATIVE_GROUP_SPECS, dedupe, defaultGatewayFromEnv, findApiBackup, pickNativeGroupPlan,
  pickSubscriptionPlan, pickTierPlan, probeMagpie, readMagpieNativeGroups, resolveExcludedTokens,
  resolveMagpieApiKey, syncHarnessGroups,
} from '../../core/magpie.mjs';
import { readActiveRuns, readDispatchActivity, readExternalGroupUsage, readRecentActivity } from './activity.mjs';

export {
  DEFAULT_MAGPIE_URL, DEFAULT_TIERS, DEFAULT_UTILITY, EFFORT_RANK, FEATURES, TIER_ALIASES,
  TIER_ORDER, VALID_EFFORTS, VALID_FAILOVER_MODES, VALID_SANDBOXES, expandUser, isCodexModelId,
  normalizeDefaultTier, readJsonSafe, resolveConfigPath, resolveMagpieConfigDir,
  resolveSessionsDir, setDefaultSandbox, setDefaultTier, setEffortSettings, setPairing,
  setWorkSplit, writeConfigAtomic,
} from '../../core/config.mjs';
export {
  buildMagpieCliEnv, createNativeGroups, defaultGatewayFromEnv, findMagpieCli, isHarnessGroup,
  pickNativeGroupPlan, pickSubscriptionPlan, previewNativeGroups, probeMagpie,
  readMagpieNativeGroups, resolveExcludedTokens, resolveMagpieApiKey, verifySubscriptionGroup,
} from '../../core/magpie.mjs';
export {
  explicitTitle, getDispatchActivity, isActivityId, listDispatchActivity, normalizeTitle,
  readActiveRuns, readExternalGroupUsage, readRecentActivity, sessionGoal, workspaceName,
} from './activity.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export { WORKLOAD };

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

const SAFE_MCP_ENV_KEYS = new Set(['PYTHONPATH', 'PYTHONUTF8', 'PYTHONIOENCODING', 'LANG', 'LC_ALL', 'GEMPT_CONFIG']);

export function buildMcpSnippet({ antigravityPluginDir, repoRoot = REPO_ROOT, preferInstalled = true } = {}) {
  const agyDir = antigravityPluginDir
    ? resolve(expandUser(antigravityPluginDir))
    : resolve(join(homedir(), '.gemini', 'config', 'plugins', 'gempt'));
  const installedRuntime = join(agyDir, 'runtime');
  const installedConfig = preferInstalled ? readJsonSafe(join(agyDir, 'mcp_config.json')) : null;
  if (installedConfig?.mcpServers?.gempt?.command) {
    const json = JSON.stringify(installedConfig, (key, value) => {
      if (key !== 'env' || !value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
        name, SAFE_MCP_ENV_KEYS.has(name) ? entry : '[REDACTED]',
      ]));
    }, 2);
    return { target_root: installedRuntime, config: JSON.parse(json), json };
  }

  const targetRoot = resolve(repoRoot);
  const config = { mcpServers: { gempt: {
    command: resolveNodeExecutable(), args: [join(targetRoot, 'core', 'mcp-server.mjs')],
  } } };
  return {
    target_root: targetRoot,
    config,
    json: JSON.stringify(config, null, 2),
  };
}

export async function readState({ configPath, sessionsDir, magpieConfigDir, antigravityPluginDir, execEnabled, mcpToolsEnabled, appServer, probeTimeoutMs = 2000 } = {}) {
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
  const workSplit = policy.work_split ?? 'balanced';
  const tokenRatio = resolveBudget(workSplit, {
    policy,
    configPath: resolvedConfigPath,
    sessionsDir: resolvedSessionsDir,
    magpieConfigDir: resolvedMagpieDir,
  });

  return {
    app_server: appServer?.getStatus() ?? { running: false, ws_url: null, pid: null, gateway_url: null, error: null },
    active_runs: readActiveRuns(resolvedSessionsDir),
    features: { ...FEATURES },
    configured,
    config_path: resolvedConfigPath,
    work_split: workSplit,
    swarm_split: policy.swarm_split ?? 'inherit',
    work_profiles: WORKLOAD.profiles,
    token_ratio: tokenRatio,
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
      enabled: typeof mcpToolsEnabled === 'boolean' ? mcpToolsEnabled : readPluginMcpToolsOption(resolvedMagpieDir),
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

export async function initSubscriptionConfig({ configPath, probeTimeoutMs = 2000, sandbox, strategy,
  utilityModel, failover = 'subscription_only', useGroups = false, syncGroups = false, dryRun = false,
  chooseSettings,
} = {}) {
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

  const subscription = pickSubscriptionPlan(probe);
  const plan = subscription || ((chooseSettings || failover === 'api_fallback')
    ? pickTierPlan(probe.openai_models || [], probe.utility_candidates || []) : null);
  if (!plan) {
    return {
      ok: false,
      status: 400,
      error: '未检测到 Codex 订阅模型，请先在 Magpie 中登录 ChatGPT/Codex 订阅账号。',
    };
  }

  if (chooseSettings) ({ sandbox, utilityModel, failover, syncGroups, useGroups } = await chooseSettings({
    sandbox, utilityModel, failover: subscription ? failover : 'api_fallback', syncGroups, useGroups, plan,
  }));
  if (failover === 'subscription_only' && !subscription) {
    return { ok: false, status: 400, error: '未检测到可用的 Codex 订阅模型。' };
  }
  const currentSandbox = String(sandbox || existingCodex.default_sandbox || '').trim();
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
      failover_mode: failover,
      auto_effort: Boolean(existingPolicy.auto_effort),
      magpie_group_strategy: strategy || String(existingPolicy.magpie_group_strategy || 'pace'),
      excluded_models: excludedList,
    },
    tiers: plan.tiers,
    utility: {
      ...DEFAULT_UTILITY,
      model: utilityModel ?? plan.utility_model,
    },
    limits: {
      max_internal_rounds: 3,
      max_context_file_bytes: 131072,
      max_total_context_bytes: 393216,
      consult_timeout_sec: 180,
      ...existingLimits,
    },
  };

  let config = next;
  if (failover === 'api_fallback' && subscription && probe.openai_models?.length) {
    const result = await setFailoverMode(failover, { configPath: resolvedConfigPath, candidate: next, probe });
    if (!result.ok) return result;
    config = result.config;
  }
  if (useGroups) {
    config.tiers = Object.fromEntries(TIER_ORDER.map((tier) => {
      const group = `group/gempt-harness-${tier}`;
      return [tier, { ...config.tiers[tier], consult_model: group, exec_model: group }];
    }));
  }
  const magpieGroups = syncGroups ? await syncHarnessGroups(config, { dryRun }) : [];
  if (!dryRun) {
    const written = writeConfigAtomic(resolvedConfigPath, config);
    if (!written.ok) return written;
  }

  return {
    ok: true,
    status: 200,
    config_path: resolvedConfigPath,
    default_tier: defaultTier,
    default_sandbox: safeSandbox,
    plan,
    saved: !dryRun,
    ...(dryRun ? { config: { ...config, magpie: { ...config.magpie, api_key: config.magpie.api_key ? '[REDACTED]' : '' } } } : {}),
    ...(syncGroups ? { magpie_groups_sync: magpieGroups } : {}),
  };
}

export async function setFailoverMode(mode, { configPath, probeTimeoutMs = 2000, candidate, probe } = {}) {
  const normalized = String(mode || '').trim();
  if (!VALID_FAILOVER_MODES.includes(normalized)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid failover_mode '${String(mode ?? '')}'. Expected one of: ${VALID_FAILOVER_MODES.join(', ')}.`,
    };
  }

  const loaded = candidate ? { ok: true, data: candidate, path: resolveConfigPath(configPath) } : readExistingConfigObject(configPath);
  if (!loaded.ok) return loaded;

  const current = loaded.data;
  const curPolicy = current.routing_policy && typeof current.routing_policy === 'object' ? current.routing_policy : {};
  const curTiers = current.tiers && typeof current.tiers === 'object' ? current.tiers : {};
  const nextPolicy = { ...curPolicy, failover_mode: normalized };
  const nextTiers = { ...curTiers };

  const baseUrl = String(current.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const apiKey = resolveMagpieApiKey({ magpie: { ...(current.magpie || {}), base_url: baseUrl } });
  const excludedTokens = resolveExcludedTokens(current);
  let cachedProbe = probe || null;
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
  if (candidate) return { ok: true, config: next };
  const written = writeConfigAtomic(loaded.path, next);
  if (!written.ok) return written;

  return {
    ok: true,
    status: 200,
    failover_mode: normalized,
    config_path: loaded.path,
  };
}

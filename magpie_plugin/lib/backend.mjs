import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveBudgetAsync } from './token-ratio.mjs';
import { WORKLOAD } from '../../core/assets.mjs';
import { agyInstallPaths, RUNTIME_ROOT, resolvePluginRoot } from '../../core/bundle-paths.mjs';
import { GEMPT_VERSION } from '../../core/config.mjs';
import { readRun, refreshRun } from '../../core/runs.mjs';
import { resolveNodeExecutable } from '../../core/node-executable.mjs';
import {
  CLI_CHOICES, configuredConsultTimeoutSec, DEFAULT_TIERS, DEFAULT_UTILITY, FEATURES, TIER_ORDER, VALID_FAILOVER_MODES, VALID_SANDBOXES,
  buildTierView, editAdvancedSettings, editDefaultSandbox, editEffortSettings, editPairing, editWorkSplit, expandUser,
  getExecutionConfig, getMcpEffort, getPairing, getUiLanguage, hasApiSnapshot, hasRuntimeConfig,
  isCodexModelId, normalizeDefaultTier, readJsonSafe, readPluginExecOption, readPluginMcpToolsOption,
  resolveConfigPath, resolveMagpieConfigDir, resolveSessionsDir, validateEffortSettings, withConfigTransaction,
} from '../../core/config.mjs';
import { detectAvailableRunners } from '../../core/runners/registry.mjs';
import {
  dedupe, defaultGatewayFromEnv, findApiBackup, pickDelegatePlan, pickSubscriptionPlan,
  probeMagpie, resolveExcludedTokens, resolveMagpieApiKey,
} from '../../core/magpie.mjs';
import { findCodexCli } from './app-server-manager.mjs';
import { configuredExecTimeoutSec, validateExecTimeoutSec } from './routing.mjs';
import { readActiveRuns, readDispatchActivity, readOverviewActivity, readRecentActivity } from './activity.mjs';

export {
  DEFAULT_MAGPIE_URL, DEFAULT_TIERS, DEFAULT_UTILITY, EFFORT_RANK, FEATURES, TIER_ALIASES,
  TIER_ORDER, VALID_EFFORTS, VALID_FAILOVER_MODES, VALID_SANDBOXES, expandUser, isCodexModelId,
  normalizeDefaultTier, readJsonSafe, resolveConfigPath, resolveMagpieConfigDir,
  resolveSessionsDir, setDefaultSandbox, setDefaultTier, setEffortSettings, setPairing,
  writeConfigAtomic,
} from '../../core/config.mjs';
export {
  defaultGatewayFromEnv, findMagpieCli, pickSubscriptionPlan, probeMagpie,
  resolveExcludedTokens, resolveMagpieApiKey,
} from '../../core/magpie.mjs';
export {
  explicitTitle, getDispatchActivity, isActivityId, listDispatchActivity, normalizeTitle,
  readActiveRuns, readRecentActivity, sessionGoal, workspaceName,
} from './activity.mjs';

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

export function detectClients({ magpieConfigDir, antigravityPluginDir, agyBinDir } = {}) {
  const { target: agyDir, binDir } = agyInstallPaths(antigravityPluginDir, agyBinDir);
  const manifest = readJsonSafe(join(agyDir, 'plugin.json'));
  const antigravity_installed = manifest?.name === 'gempt';

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
    agy_install: { target: agyDir, bin_dir: binDir, bundled_version: GEMPT_VERSION,
      installed_version: antigravity_installed ? manifest.version : null },
    magpie_clients: [...magpieSet],
    external_clients: [...externalSet],
    magpie_mcp_registered,
    native_tools_registered,
    native_tools_agents,
    native_tools_list: [...nativeToolsSet],
  };
}

export function buildRulesSnippet() {
  return readFileSync(join(resolvePluginRoot(), 'rules', 'AGENTS.md'), 'utf8');
}

const SAFE_MCP_ENV_KEYS = new Set(['PYTHONPATH', 'PYTHONUTF8', 'PYTHONIOENCODING', 'LANG', 'LC_ALL', 'GEMPT_CONFIG']);

export function buildMcpSnippet({ antigravityPluginDir, repoRoot = RUNTIME_ROOT, preferInstalled = true } = {}) {
  const { target: agyDir } = agyInstallPaths(antigravityPluginDir);
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

const probeCache = new Map();
const PROBE_TTL_MS = 15_000;

function gateway(configPath) {
  const path = resolveConfigPath(configPath);
  const config = readJsonSafe(path);
  const url = String(config?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  return { path, config, url };
}

function gatewayIdentity(config, url) {
  const key = resolveMagpieApiKey({ magpie: { ...config?.magpie, base_url: url } });
  const excluded = resolveExcludedTokens(config);
  return { key, excluded, id: JSON.stringify([url, key, excluded]) };
}

function cachedProbe(path, url, config) {
  const entry = probeCache.get(path);
  return entry?.url === url && entry.id === gatewayIdentity(config, url).id ? entry.result : undefined;
}

export function readRoutingSummary({ configPath } = {}) {
  const { path, config, url } = gateway(configPath);
  const policy = config?.routing_policy;
  const profile = Object.hasOwn(WORKLOAD.profiles, policy?.work_split) ? policy.work_split : 'balanced';
  const result = cachedProbe(path, url, config);
  return {
    ui: { language: getUiLanguage(config) },
    routing: { profile, gpt_share: WORKLOAD.profiles[profile].gpt_share },
    magpie: { reachable: result?.reachable ?? null, url, error: result?.error || '' },
  };
}

export async function readMagpieStatus({ configPath, force = false, probeTimeoutMs = 600 } = {}) {
  const { path, config, url } = gateway(configPath);
  const { key, excluded, id } = gatewayIdentity(config, url);
  let entry = probeCache.get(path);
  if (entry?.id !== id) entry = undefined;
  if (entry?.pending) return entry.pending;
  if (!force && entry?.result && Date.now() - entry.checkedAt < PROBE_TTL_MS) return entry.result;
  if (!entry) {
    if (!probeCache.has(path) && probeCache.size >= 32) probeCache.delete(probeCache.keys().next().value);
    probeCache.set(path, entry = { id, url });
  }
  entry.pending = probeMagpie(url, key, Math.min(probeTimeoutMs, 600), excluded).then((result) => {
    entry.result = result;
    entry.checkedAt = Date.now();
    return result;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}

function overviewGatewayFields(magpie, rawCfg) {
  const recommended = pickSubscriptionPlan(magpie);
  return {
    mcp_default_model: pickDelegatePlan(magpie)?.tiers.sonnet.consult_model || null,
    subscription: {
      connected: Boolean(magpie.codex_ready),
      codex_count: (magpie.codex_models || []).length,
      recommended,
    },
    api_fallback: {
      available: (magpie.openai_models || []).length > 0 || hasApiSnapshot(rawCfg),
      openai_count: (magpie.openai_models || []).length,
      has_snapshot: hasApiSnapshot(rawCfg),
    },
  };
}

export async function readPageMagpieStatus(options = {}) {
  const magpie = await readMagpieStatus(options);
  const { config, url } = gateway(options.configPath);
  if (url !== magpie.url) return { reachable: null, url, ui: { language: getUiLanguage(config) } };
  return { ...magpie, ui: { language: getUiLanguage(config) }, overview: overviewGatewayFields(magpie, config) };
}

export function readRatio({ range = '24h', configPath, sessionsDir, magpieConfigDir, env } = {}) {
  const { path, config } = gateway(configPath);
  return resolveBudgetAsync(config?.routing_policy?.work_split ?? 'balanced', {
    range, configPath: path, sessionsDir, magpieConfigDir,
    env: {
      GEMPT_AGY_BRAIN_DIR: env?.GEMPT_AGY_BRAIN_DIR ?? process.env.GEMPT_AGY_BRAIN_DIR,
      GEMPT_CONFIG: env?.GEMPT_CONFIG ?? process.env.GEMPT_CONFIG,
      GEMPT_SESSIONS_DIR: env?.GEMPT_SESSIONS_DIR ?? process.env.GEMPT_SESSIONS_DIR,
      MAGPIE_CONFIG_DIR: env?.MAGPIE_CONFIG_DIR ?? process.env.MAGPIE_CONFIG_DIR,
    },
  });
}

export function readRunState({ appServer, sessionsDir, activeRuns } = {}) {
  return {
    app_server: appServer?.getStatus() ?? { running: false, ws_url: null, pid: null, gateway_url: null, error: null },
    active_runs: activeRuns ?? readActiveRuns(resolveSessionsDir(sessionsDir)),
  };
}

async function healedActiveRun(activeRuns, options) {
  const pending = activeRuns.filter((run) => run.remote_turn_unconfirmed && run.codex_thread_id && run.turn_id);
  const results = await Promise.all(pending.map((run) =>
    refreshRun(readRun(run.run_id, options.sessionsDir, { allowLegacyId: true }), options)));
  return results.some((run) => !run.remote_turn_unconfirmed);
}

export async function currentRunState(options) {
  const state = readRunState(options);
  return await healedActiveRun(state.active_runs, options) ? readRunState(options) : state;
}

export function warmPageTelemetry(options = {}) {
  setImmediate(() => {
    void Promise.allSettled([
      Promise.resolve().then(() => readRatio({ ...options, range: '7d' })),
      Promise.resolve().then(() => readOverviewActivity(options.sessionsDir, options.magpieConfigDir, options.configPath)),
    ]);
  }).unref();
}

export function readOverview(options = {}) {
  return readState({ ...options, overview: true });
}

export async function readState({ configPath, sessionsDir, magpieConfigDir, antigravityPluginDir, agyBinDir, execEnabled, mcpToolsEnabled, appServer, ratioRange = '24h', probeTimeoutMs = 2000, overview = false, env = process.env } = {}) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const resolvedSessionsDir = resolveSessionsDir(sessionsDir);
  const resolvedMagpieDir = resolveMagpieConfigDir(magpieConfigDir);
  const rawCfg = readJsonSafe(resolvedConfigPath);
  const configured = hasRuntimeConfig(rawCfg);

  const policy = rawCfg?.routing_policy || {};
  const defaultTier = normalizeDefaultTier(policy.default_tier) || 'sonnet';
  const baseUrl = String(rawCfg?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  let magpie;
  if (overview) {
    magpie = cachedProbe(resolvedConfigPath, baseUrl, rawCfg) ?? { reachable: null, url: baseUrl };
  } else {
    const { key, excluded } = gatewayIdentity(rawCfg, baseUrl);
    magpie = await probeMagpie(baseUrl, key, probeTimeoutMs, excluded);
  }
  const { subscription, ...gatewayFields } = overviewGatewayFields(magpie, rawCfg);
  const recommended = subscription.recommended;
  const pairings = Object.fromEntries(Object.keys(WORKLOAD.pairings).map((family) => [family, getPairing(policy, family)]));
  const clients = detectClients({ magpieConfigDir: resolvedMagpieDir, antigravityPluginDir, agyBinDir });
  const mcpSnippet = buildMcpSnippet({ antigravityPluginDir });

  const tiersObj = rawCfg?.tiers || {};
  const tiers = TIER_ORDER.map((id) => buildTierView(
    id,
    configured ? tiersObj[id] : undefined,
    defaultTier,
    !configured && recommended?.tiers?.[id] ? recommended.tiers[id] : DEFAULT_TIERS[id],
  ));

  const gatewayKey = rawCfg ? resolveMagpieApiKey({ magpie: { ...rawCfg.magpie, base_url: baseUrl } }, baseUrl, { allowLocalFallback: false }) : '';
  const execution = getExecutionConfig(rawCfg);
  const runners = detectAvailableRunners(rawCfg || {}, env);
  const codexRunnerInfo = runners.find((r) => r.id === 'codex');
  const codexPath = execution.cli_paths.codex || rawCfg?.codex?.cli_path || '';
  const resolvedCodexPath = codexRunnerInfo?.path ?? findCodexCli(codexPath, env);
  const availableRunners = runners.filter((r) => r.available).map((r) => r.id);
  const utilRaw = rawCfg?.utility || {};
  const utility = {
    label: String(utilRaw.label || DEFAULT_UTILITY.label),
    slash: '/gempt-chore',
    model: String(utilRaw.model || (!configured && recommended?.utility_model ? recommended.utility_model : DEFAULT_UTILITY.model)),
    reasoning_effort: String(utilRaw.reasoning_effort ?? DEFAULT_UTILITY.reasoning_effort),
    fallback_models: Array.isArray(utilRaw.fallback_models) ? utilRaw.fallback_models.filter(Boolean).map(String) : [],
  };

  const activity = () => overview ? readOverviewActivity(resolvedSessionsDir, resolvedMagpieDir, resolvedConfigPath)
    : { ...readRecentActivity(resolvedSessionsDir, 6),
        activityTotals: readDispatchActivity(resolvedSessionsDir).totals, activeRuns: readActiveRuns(resolvedSessionsDir) };
  let snapshot = await activity();
  if (await healedActiveRun(snapshot.activeRuns, { sessionsDir: resolvedSessionsDir, configPath: resolvedConfigPath, env })) {
    snapshot = await activity();
  }
  const { recentSessions, recentRuns, activityTotals, activeRuns } = snapshot;
  const workSplit = policy.work_split ?? 'balanced';
  const tokenRatio = overview ? null : await readRatio({
    range: ratioRange,
    configPath: resolvedConfigPath,
    sessionsDir: resolvedSessionsDir,
    magpieConfigDir: resolvedMagpieDir,
  });

  return {
    ...readRunState({ appServer, activeRuns }),
    features: { ...FEATURES },
    configured,
    config_path: resolvedConfigPath,
    ui: { language: getUiLanguage(rawCfg) },
    magpie_api_key_configured: Boolean(gatewayKey),
    magpie_api_key_stored: Boolean(rawCfg?.magpie?.api_key?.trim?.()),
    magpie_api_key_hint: gatewayKey ? '••••' + (gatewayKey.length > 4 ? gatewayKey.slice(-4) : '') : '',
    magpie_api_key_env: rawCfg?.magpie?.api_key_env ?? 'GEMPT_MAGPIE_API_KEY',
    magpie_base_url: baseUrl,
    excluded_models: rawCfg?.routing_policy?.excluded_models || [],
    codex_cli_path: codexPath,
    codex_cli_resolved_path: resolvedCodexPath,
    codex_cli_available: Boolean(resolvedCodexPath),
    codex_auto_detected_path: codexRunnerInfo?.auto_detected_path ?? (codexPath ? findCodexCli('', env) : resolvedCodexPath),
    codex_extra_args: rawCfg?.codex?.extra_args || [],
    execution,
    runners,
    available_runners: availableRunners,
    has_any_runner: availableRunners.length > 0,
    consult_timeout_sec: configuredConsultTimeoutSec(rawCfg?.limits),
    work_split: workSplit,
    codex_timeout_sec: configuredExecTimeoutSec(rawCfg?.codex),
    work_profiles: WORKLOAD.profiles,
    ...(overview ? {} : { token_ratio: tokenRatio }),
    pairings,
    mcp_effort: getMcpEffort(policy),
    default_tier: defaultTier,
    failover_mode: String(policy.failover_mode || 'subscription_only'),
    auto_effort: Boolean(rawCfg?.routing_policy?.auto_effort),
    default_sandbox: String(rawCfg?.codex?.default_sandbox || 'workspace-write'),
    subscription,
    ...gatewayFields,
    clients,
    mcp_snippet: mcpSnippet,
    rules_snippet: buildRulesSnippet(),
    tools: {
      enabled: typeof mcpToolsEnabled === 'boolean' ? mcpToolsEnabled : readPluginMcpToolsOption(resolvedMagpieDir),
      exec_enabled: typeof execEnabled === 'boolean' ? execEnabled : readPluginExecOption(resolvedMagpieDir),
      endpoint: `${baseUrl}/mcp/magpie/tools/gempt`,
    },
    magpie,
    tiers,
    utility,
    activity_totals: activityTotals,
    ...(overview ? { activity_7d: snapshot.weekly } : {}),
    recent_sessions: recentSessions,
    recent_runs: recentRuns,
    checked_at: new Date().toISOString(),
  };
}

export async function initSubscriptionConfig({ configPath, probeTimeoutMs = 2000, sandbox,
  utilityModel, failover, dryRun = false,
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
  const plan = pickDelegatePlan(probe);
  if (!plan) {
    return {
      ok: false,
      status: 400,
      error: '请在 Magpie 接入可用于对话的模型后刷新。',
    };
  }

  if (chooseSettings) ({ sandbox, utilityModel, failover } = await chooseSettings({
    sandbox, utilityModel, failover, plan,
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
      api_key_env: String(existingMagpie.api_key_env ?? 'GEMPT_MAGPIE_API_KEY'),
      cli_path: String(existingMagpie.cli_path || ''),
    },
    codex: {
      cli_path: String(existingCodex.cli_path || ''),
      default_sandbox: safeSandbox,
      approval_policy: String(existingCodex.approval_policy || 'never'),
      model_provider: String(existingCodex.model_provider || ''),
      extra_args: Array.isArray(existingCodex.extra_args) ? existingCodex.extra_args : [],
      timeout_sec: configuredExecTimeoutSec(existingCodex),
      ...(existingCodex.timeout_sec_customized === true ? { timeout_sec_customized: true } : {}),
    },
    execution: getExecutionConfig(existing),
    routing_policy: {
      work_split: existingPolicy.work_split ?? 'balanced',
      pairings: existingPolicy.pairings ?? {},
      default_tier: defaultTier,
      failover_mode: failover ?? 'paired',
      auto_effort: Boolean(existingPolicy.auto_effort),
      mcp_effort: getMcpEffort(existingPolicy),
      excluded_models: excludedList,
    },
    tiers: plan.tiers,
    utility: {
      ...DEFAULT_UTILITY,
      ...existing.utility,
      model: utilityModel ?? existing.utility?.model ?? plan.utility_model,
    },
    ui: { language: getUiLanguage(existing) },
    limits: {
      max_internal_rounds: 3,
      max_context_file_bytes: null,
      max_total_context_bytes: null,
      ...existingLimits,
      consult_timeout_sec: configuredConsultTimeoutSec(existingLimits),
    },
  };

  let config = next;
  if (failover === 'api_fallback' && subscription && probe.openai_models?.length) {
    const result = await setFailoverMode(failover, { configPath: resolvedConfigPath, candidate: next, probe });
    if (!result.ok) return result;
    config = result.config;
  }
  if (!dryRun) {
    const written = withConfigTransaction(resolvedConfigPath, ({ data }) =>
      isDeepStrictEqual(data, existing) ? { next: config }
        : { ok: false, status: 409, error: '配置在初始化期间已被修改，请重试。' }, { create: true });
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
  };
}

export function setFailoverMode(mode, options) {
  return updateSettings({ failover_mode: mode }, options);
}

export async function updateSettings(settings, { configPath, probeTimeoutMs = 2000, candidate, probe } = {}) {
  const advancedEdits = Object.fromEntries(['magpie', 'routing_policy', 'utility', 'codex', 'execution', 'limits', 'ui'].map((section) =>
    [section, (loaded, value) => editAdvancedSettings(loaded, section, value, defaultGatewayFromEnv())]));
  const edits = {
    ...advancedEdits,
    default_cli: (loaded, value) => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!CLI_CHOICES.includes(normalized)) {
        return { ok: false, status: 400, error: `Invalid default_cli. Expected one of: ${CLI_CHOICES.join(', ')}.` };
      }
      return editAdvancedSettings(loaded, 'execution', { default_cli: normalized }, defaultGatewayFromEnv());
    },
    codex_timeout_sec: (loaded, value) => {
      try {
        if (validateExecTimeoutSec(value) === undefined) throw new Error('Missing codex_timeout_sec.');
      } catch (error) {
        return { ok: false, status: 400, error: error.message };
      }
      return { next: { ...loaded.data, codex: { ...loaded.data.codex, timeout_sec: validateExecTimeoutSec(value), timeout_sec_customized: true } } };
    },
    default_sandbox: editDefaultSandbox,
    pairing: (loaded, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some((key) => key !== 'family' && key !== 'model')) {
        return { ok: false, status: 400, error: 'Invalid pairing.' };
      }
      return editPairing(loaded, value.family, value.model);
    },
    work_split: editWorkSplit,
  };
  const effortKeys = ['auto_effort', 'mcp_effort', 'tier_effort', 'tier'];
  const keys = settings && Object.keys(settings);
  if (!keys?.length || typeof settings !== 'object' || Array.isArray(settings) ||
      keys.some((key) => !Object.hasOwn(edits, key) && key !== 'failover_mode' && !effortKeys.includes(key)) ||
      (keys.includes('tier') && !keys.includes('tier_effort') && !keys.includes('auto_effort'))) {
    return { ok: false, status: 400, error: 'Invalid settings.' };
  }
  const create = keys.every((key) => key === 'pairing' || Object.hasOwn(advancedEdits, key));
  const hasMode = keys.includes('failover_mode');
  const mode = typeof settings.failover_mode === 'string' ? settings.failover_mode.trim() : '';
  if (hasMode && !VALID_FAILOVER_MODES.includes(mode)) {
    return { ok: false, status: 400, error: `Invalid failover_mode. Expected one of: ${VALID_FAILOVER_MODES.join(', ')}.` };
  }

  const hasEffort = effortKeys.some((key) => keys.includes(key));
  const effort = { autoEffort: settings.auto_effort, mcpEffort: settings.mcp_effort,
    tierEffort: settings.tier_effort, tier: settings.tier };
  const invalid = hasEffort && validateEffortSettings(effort);
  if (invalid) return invalid;

  let probeKey;
  const plan = (loaded) => {
    const draft = { ...loaded };
    const response = { ok: true, status: 200 };
    for (const [key, edit] of Object.entries(edits)) {
      if (!keys.includes(key)) continue;
      const result = edit(draft, settings[key]);
      if (!result.next) return result;
      draft.data = result.next;
      Object.assign(response, result.response);
    }
    if (hasMode) {
      const baseUrl = String(draft.data.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
      const apiKey = resolveMagpieApiKey({ magpie: { ...draft.data.magpie, base_url: baseUrl } });
      const inputs = [baseUrl, apiKey, resolveExcludedTokens(draft.data)];
      const key = JSON.stringify(inputs);
      if (probe && probeKey === undefined) probeKey = key;
      const result = planFailover(draft.data, mode, key === probeKey ? probe : undefined);
      if (!result) return { probeInputs: inputs, probeKey: key };
      if (!result.ok) return result;
      draft.data = result.config;
      Object.assign(response, { failover_mode: mode, config_path: loaded.path });
    }
    if (hasEffort) {
      const result = editEffortSettings(draft, effort);
      if (!result.next) return result;
      draft.data = result.next;
      Object.assign(response, result.response);
    }
    if ([600, 3600].includes(draft.data.codex?.timeout_sec) && draft.data.codex?.timeout_sec_customized !== true) {
      draft.data = { ...draft.data, codex: { ...draft.data.codex, timeout_sec: configuredExecTimeoutSec(draft.data.codex) } };
    }
    if (draft.data.limits?.consult_timeout_sec === 180 && draft.data.limits.consult_timeout_customized !== true) {
      draft.data = { ...draft.data, limits: { ...draft.data.limits, consult_timeout_sec: null } };
    }
    if (candidate) return { ok: true, config: draft.data };
    return { next: draft.data, response: hasMode || hasEffort || keys.includes('default_sandbox') ? response : undefined };
  };

  for (;;) {
    const result = candidate ? plan({ data: candidate, path: resolveConfigPath(configPath) })
      : withConfigTransaction(configPath, plan, { create });
    if (!result.probeInputs) return result;
    // Probe without the config lock, then plan again with the latest on-disk settings.
    const [url, key, excluded] = result.probeInputs;
    probe = await probeMagpie(url, key, probeTimeoutMs, excluded);
    probeKey = result.probeKey;
  }
}

function planFailover(current, normalized, probe) {
  const curPolicy = current.routing_policy && typeof current.routing_policy === 'object' ? current.routing_policy : {};
  const curTiers = current.tiers && typeof current.tiers === 'object' ? current.tiers : {};
  const nextPolicy = { ...curPolicy, failover_mode: normalized };
  const nextTiers = { ...curTiers };

  if (normalized === 'subscription_only') {
    const usesNonSubscriptionModels = TIER_ORDER.some((t) => {
      const tier = curTiers[t] || {};
      const c = String(tier.consult_model || '').trim();
      const e = String(tier.exec_model || '').trim();
      const fbs = Array.isArray(tier.fallback_models) ? tier.fallback_models : [];
      return (
        (c && !isCodexModelId(c))
        || (e && !isCodexModelId(e))
        || fbs.some((m) => !isCodexModelId(m))
      );
    });

    if (curPolicy.failover_mode === 'api_fallback' || usesNonSubscriptionModels) {
      const snapshot = {};
      for (const t of TIER_ORDER) {
        const tier = curTiers[t] || {};
        snapshot[t] = {
          consult_model: String(tier.consult_model || ''),
          exec_model: String(tier.exec_model || ''),
          escalate_model: String(tier.escalate_model || ''),
          fallback_models: Array.isArray(tier.fallback_models) ? [...tier.fallback_models] : [],
        };
      }
      nextPolicy.api_fallback_snapshot = snapshot;
    }

    for (const t of TIER_ORDER) {
      const baseTier = { ...DEFAULT_TIERS[t], ...(curTiers[t] && typeof curTiers[t] === 'object' ? curTiers[t] : {}) };
      let primary = (isCodexModelId(baseTier.consult_model) ? String(baseTier.consult_model).trim() : '')
        || (isCodexModelId(baseTier.exec_model) ? String(baseTier.exec_model).trim() : '');

      let subPlan = null;
      if (!primary) {
        if (!probe) return null;
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
          if (!probe) return null;
          subPlan ||= pickSubscriptionPlan(probe);
          escalateModel = subPlan?.tiers?.opus?.escalate_model || '';
        }
      } else {
        escalateModel = '';
      }

      const cleanTier = {
        ...baseTier,
        consult_model: primary,
        exec_model: primary,
        fallback_models: [],
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
        }
        nextTiers[t] = baseTier;
      }
      delete nextPolicy.api_fallback_snapshot;
    } else {
      if (!probe) return null;
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
        const fallbacks = dedupe([backup].filter((b) => b && b !== primary));
        nextTiers[t] = {
          ...baseTier,
          consult_model: primary,
          exec_model: primary,
          ...(t === 'opus' && escalateModel ? { escalate_model: escalateModel } : {}),
          fallback_models: fallbacks,
        };
      }
    }
  }

  return { ok: true, config: { ...current, routing_policy: nextPolicy, tiers: nextTiers } };
}

export async function probeGatewaySettings(draft, { configPath, probeTimeoutMs = 2000 } = {}) {
  const { config, url } = gateway(configPath);
  const result = editAdvancedSettings({ data: config || {} }, 'magpie', draft, url);
  if (!result.next) return result;
  const baseUrl = result.next.magpie.base_url || url;
  const key = resolveMagpieApiKey({ magpie: { ...result.next.magpie, base_url: baseUrl } });
  const started = performance.now();
  const probe = await probeMagpie(baseUrl, key, probeTimeoutMs);
  return { ok: true, status: 200, reachable: probe.reachable, latency_ms: Math.round(performance.now() - started),
    models: probe.models, total_models: probe.models.length, error: probe.error };
}

export function resetSettings(body, { configPath } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'keep_gateway') ||
      (Object.hasOwn(body, 'keep_gateway') && typeof body.keep_gateway !== 'boolean')) {
    return { ok: false, status: 400, error: 'Invalid keep_gateway.' };
  }
  const defaults = readJsonSafe(join(resolvePluginRoot(), 'templates', 'gempt.config.example.json'))
    || readJsonSafe(join(RUNTIME_ROOT, 'templates', 'gempt.config.example.json'));
  if (!defaults) return { ok: false, status: 500, error: 'GemPT default config is unavailable.' };
  const keepGateway = body.keep_gateway ?? true;
  return withConfigTransaction(configPath, ({ data, path }) => ({
    next: { ...defaults, ...(keepGateway ? { magpie: { ...defaults.magpie, base_url: defaultGatewayFromEnv(), ...data.magpie } } : {}) },
    response: { ok: true, status: 200, config_path: path, keep_gateway: keepGateway },
  }), { create: true });
}

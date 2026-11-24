import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createNativeGroups, getDispatchActivity, initSubscriptionConfig, listDispatchActivity,
  readOverview, readRoutingSummary, readPageMagpieStatus, readRunState, readRatio, setDefaultTier, updateSettings } from '../magpie_plugin/lib/backend.mjs';
import { createAppServerManager } from '../magpie_plugin/lib/app-server-manager.mjs';
import { RATIO_RANGES } from '../magpie_plugin/lib/token-ratio.mjs';
import { EXEC_TIMEOUT_MIN_SEC, EXEC_TIMEOUT_MAX_SEC } from '../magpie_plugin/lib/routing.mjs';
import { WORKLOAD } from './assets.mjs';
import { TIER_ORDER, VALID_EFFORTS, VALID_FAILOVER_MODES, VALID_SANDBOXES } from './config.mjs';
import { interruptRun } from './runs.mjs';
import { checkArgs, LIVE_OPERATIONS, runLiveOperation, workspaceRun } from './live-service.mjs';
import { resolvePath } from './state.mjs';

export const APP_URI = 'ui://gempt/live.html';
export const APP_RESOURCE = {
  uri: APP_URI, name: 'GemPT', mimeType: 'text/html;profile=mcp-app',
  _meta: { ui: { prefersBorder: false } },
};
export const LIVE_META = {
  ui: { resourceUri: APP_URI },
};
const RUN_ID = { type: 'string', pattern: '^[0-9a-f]{32}$' };
const MAX_HTML = 10 * 1024 * 1024;
let cachedResource;
function tool(name, description, properties, required) {
  return [name, { name, description,
    inputSchema: { type: 'object', properties, additionalProperties: false, ...(required ? { required } : {}) },
    _meta: { ui: { visibility: ['app'] } },
  }];
}

const STRING = { type: 'string' };
const BOOL = { type: 'boolean' };
const enumString = (values) => ({ type: 'string', enum: values });
const shape = (properties, required) => ({ type: 'object', properties, additionalProperties: false,
  ...(required ? { required } : {}) });
const PROFILES = Object.keys(WORKLOAD.profiles);
const SETTINGS = {
  default_sandbox: enumString(VALID_SANDBOXES),
  codex_timeout_sec: { type: 'number', minimum: EXEC_TIMEOUT_MIN_SEC, maximum: EXEC_TIMEOUT_MAX_SEC },
  work_split: enumString(PROFILES),
  swarm_split: enumString(['inherit', ...PROFILES]),
  native_swarm: BOOL,
  swarm_shell_model: enumString(WORKLOAD.swarm_shell_models),
  pairing: shape({ family: enumString(Object.keys(WORKLOAD.pairings)), model: STRING }, ['family', 'model']),
  failover_mode: enumString(VALID_FAILOVER_MODES),
  auto_effort: BOOL,
  mcp_effort: enumString(VALID_EFFORTS.filter((effort) => effort !== 'ultra')),
  tier_effort: enumString(['', ...VALID_EFFORTS.filter((effort) => effort !== 'ultra')]),
  tier: enumString(TIER_ORDER),
};
const CONSOLE_ACTIONS = {
  init: shape({}),
  native_groups: shape({}),
  tier: shape({ tier: SETTINGS.tier }, ['tier']),
  restart_app_server: shape({ force: BOOL }),
  interrupt_run: shape({ run_id: RUN_ID }, ['run_id']),
};
const ACTIVITY_QUERY = shape({
  range: enumString(['all', 'today', '24h', '7d', '30d', '90d']), from: STRING, to: STRING, q: STRING, search: STRING,
  session_id: STRING, run_id: RUN_ID, mode: STRING, tier: STRING, workspace: STRING, model: STRING, provider: STRING, status: STRING,
  format: enumString(['csv']), limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
});

export const APP_TOOLS = Object.fromEntries([
  ...Object.entries(LIVE_OPERATIONS).filter(([name]) => name !== 'open').map(([name, schema]) =>
    tool(`gempt_app_${name}`, `GemPT: ${name}.`, schema.properties, schema.required)),
  tool('gempt_app_summary', 'Read the cached routing and connection summary.', {}),
  tool('gempt_app_magpie_status', 'Refresh the Magpie connection status.', { force: BOOL }),
  tool('gempt_app_active_runs', 'Read current run and app-server status.', {}),
  tool('gempt_app_token_ratio', 'Read token-ratio telemetry.', { range: enumString(RATIO_RANGES) }),
  tool('gempt_app_console_state', 'Read GemPT Overview.', {}),
  tool('gempt_app_console_settings', 'Save GemPT Console settings and read the updated state.', SETTINGS),
  tool('gempt_app_console_action', 'Run a GemPT Console action.', {
    action: enumString(Object.keys(CONSOLE_ACTIONS)), tier: SETTINGS.tier, force: BOOL, run_id: RUN_ID,
  }, ['action']),
  tool('gempt_app_console_activity', 'Read a page or detail of GemPT Console activity.', {
    kind: enumString(['requests', 'sessions']), id: STRING, query: ACTIVITY_QUERY,
  }, ['kind']),
]);

export function readAppResource({ env = process.env } = {}) {
  const path = env.GEMPT_APP_HTML || new URL('./assets/mcp_app_live.html', import.meta.url);
  const fd = openSync(path, 'r');
  try {
    const { size, ino, mtimeNs, ctimeNs } = fstatSync(fd, { bigint: true });
    const version = `${path}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
    if (cachedResource?.version === version) {
      return { contents: [{ ...APP_RESOURCE, text: cachedResource.html }] };
    }
    if (size >= MAX_HTML) throw new Error('GemPT HTML must be smaller than 10 MiB.');
    const byteLength = Number(size);
    const raw = Buffer.alloc(byteLength);
    const bytes = readSync(fd, raw, 0, byteLength, 0);
    const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(0, bytes));
    if (!html.trim()) throw new Error('GemPT HTML must be non-empty.');
    cachedResource = { version, html };
    return { contents: [{ ...APP_RESOURCE, text: html }] };
  } finally {
    closeSync(fd);
  }
}

function result(text, data) {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

async function withConsoleAppServer(options, operation) {
  const manager = createAppServerManager({ ...options, observeOnly: true });
  try {
    return await operation(manager);
  } finally {
    await manager.stop();
  }
}

function consoleState(options) {
  return withConsoleAppServer(options, (appServer) => readOverview({ ...options, appServer }));
}

async function consoleAction({ action, ...args }, options) {
  checkArgs(action, args, CONSOLE_ACTIONS[action]);
  switch (action) {
    case 'init': return initSubscriptionConfig(options);
    case 'native_groups': return createNativeGroups(options);
    case 'tier': return setDefaultTier(args.tier, options);
    case 'restart_app_server':
      return withConsoleAppServer(options, (manager) => manager.restart({ force: args.force }));
    case 'interrupt_run':
      workspaceRun(args.run_id, options);
      return interruptRun(args.run_id, options);
  }
}

function consoleResult(text, data) {
  if (data?.ok !== false) return result(text, data);
  return { ...result(data.error || text, data), isError: true };
}

export async function callAppTool(name, args = {}, opts = {}) {
  const options = { ...opts, configPath: opts.configPath ?? opts.config, root: opts.root && resolvePath(opts.root) };
  const live = name === 'gempt_live_view';
  const operation = live ? 'open' : name.slice('gempt_app_'.length);
  if (Object.hasOwn(LIVE_OPERATIONS, operation) && (live || name.startsWith('gempt_app_'))) {
    const data = await runLiveOperation(operation, args, options);
    return result(live ? 'Opened GemPT.' : 'GemPT.', data);
  }
  const schema = APP_TOOLS[name]?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  checkArgs(name, args, schema);
  if (name === 'gempt_app_summary') return result('GemPT routing.', readRoutingSummary(options));
  if (name === 'gempt_app_magpie_status') return result('Magpie status.', await readPageMagpieStatus({ ...options, ...args }));
  if (name === 'gempt_app_token_ratio') return result('GemPT token ratio.', await readRatio({ ...options, ...args }));
  if (name === 'gempt_app_active_runs') {
    return result('GemPT run status.', await withConsoleAppServer(options, (appServer) => readRunState({ ...options, appServer })));
  }
  if (name === 'gempt_app_console_state') {
    const state = await consoleState(options);
    return result('GemPT Console state.', { ...state, rulesText: state.rules_snippet });
  }
  if (name === 'gempt_app_console_settings') {
    const saved = await updateSettings(args, options);
    if (!saved.ok) return consoleResult('GemPT Console settings rejected.', saved);
    return result('GemPT Console settings saved.', await consoleState(options));
  }
  if (name === 'gempt_app_console_action') {
    return consoleResult('GemPT Console action complete.', await consoleAction(args, options));
  }
  if (name === 'gempt_app_console_activity') {
    const { kind, id, query } = args;
    const paths = [options.sessionsDir, options.magpieConfigDir, options.configPath];
    if (id !== undefined) {
      if (query !== undefined) throw new Error('Use either id or query.');
      const item = await getDispatchActivity(kind, id, ...paths);
      if (!item) return consoleResult('Activity record unavailable.', { ok: false, status: 404, error: 'Activity record not found.' });
      return result('GemPT Console activity detail.', item);
    }
    if (query?.format === 'csv' && kind !== 'requests') throw new Error('CSV export applies to requests.');
    const data = await listDispatchActivity(kind, new URLSearchParams(query), ...paths);
    return result('GemPT Console activity.', typeof data === 'string' ? { csv: data } : data);
  }
  throw new Error(`Unknown tool: ${name}`);
}

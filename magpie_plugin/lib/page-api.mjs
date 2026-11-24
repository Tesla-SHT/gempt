import { RATIO_RANGES } from './token-ratio.mjs';
import {
  createNativeGroups,
  getDispatchActivity,
  initSubscriptionConfig,
  isActivityId,
  listDispatchActivity,
  probeGatewaySettings,
  resetSettings,
  readState,
  readOverview,
  readRoutingSummary,
  readPageMagpieStatus,
  readRunState,
  readRatio,
  setDefaultTier,
  updateSettings,
} from './backend.mjs';

import { LIVE_OPERATIONS, runLiveOperation } from '../../core/live-service.mjs';
import { installAgy } from '../../core/agy-install.mjs';

export async function dispatchPageApi({ method, url, rawPath = url.pathname, readBody, opaqueOrigin }, options) {
  const pathname = url.pathname;
  const { configPath, sessionsDir, magpieConfigDir, antigravityPluginDir,
    execEnabled, mcpToolsEnabled, appServer, probeTimeoutMs, agyBinDir, magpieCliPath } = options;
  const reply = (status, body, type = 'application/json; charset=utf-8') => ({ status, body, type });
  // Validate the raw segment before URL normalization can collapse dot paths.
  const activity = /^\/api\/(requests|sessions)(?:\/(.*))?$/.exec(rawPath);
  if (activity && method === 'GET') {
    const [, kind, encodedId] = activity;
    if (encodedId === undefined) {
      const result = await listDispatchActivity(kind, url.searchParams, sessionsDir, magpieConfigDir, configPath);
      return reply(200, result, typeof result === 'string' ? 'text/csv; charset=utf-8' : undefined);
    }
    let id;
    try { id = decodeURIComponent(encodedId); } catch { /* Invalid percent encoding. */ }
    if (!id || !isActivityId(kind, id)) return reply(400, { error: 'invalid activity id' });
    const result = await getDispatchActivity(kind, id, sessionsDir, magpieConfigDir, configPath);
    return result ? reply(200, result) : reply(404, { error: 'not found' });
  }
  const live = /^\/api\/live\/(runs|stream|steer|interrupt|reply)$/.exec(pathname)?.[1];
  if (live) {
    const read = live === 'runs' || live === 'stream';
    if (method !== (read ? 'GET' : 'POST')) return reply(405, { error: 'method not allowed' });
    if (!read && opaqueOrigin) return reply(403, { error: 'invalid origin' });
    const args = read ? Object.fromEntries([...url.searchParams].map(([key, value]) => {
      const field = Object.hasOwn(LIVE_OPERATIONS[live].properties, key) && LIVE_OPERATIONS[live].properties[key];
      return [key, field?.type === 'integer' && /^\d+$/.test(value) ? Number(value)
        : field?.type === 'boolean' && ['true', 'false'].includes(value) ? value === 'true' : value];
    })) : await readBody();
    if (live === 'runs') {
      args.scope ??= options.conversationId === undefined ? 'all' : 'session';
      args.limit ??= 50;
    }
    const data = await runLiveOperation(live, args, options);
    return reply(200, data);
  }
  if (method === 'GET') {
    if (pathname === '/api/summary') return reply(200, readRoutingSummary(options));
    if (pathname === '/api/magpie-status') {
      return reply(200, await readPageMagpieStatus({ ...options, force: url.searchParams.get('force') === '1' }));
    }
    if (pathname === '/api/active-runs') return reply(200, readRunState(options));
    if (pathname === '/api/overview') return reply(200, await readOverview(options));
    if (pathname === '/api/token-ratio') {
      const range = url.searchParams.get('range') ?? '24h';
      if (!RATIO_RANGES.includes(range)) return reply(400, { error: 'invalid range' });
      return reply(200, await readRatio({ ...options, range }));
    }
  }
  if (method === 'POST' && pathname === '/api/install-agy') {
    if (opaqueOrigin) return reply(403, { error: 'invalid origin' });
    return reply(200, await installAgy({ target: antigravityPluginDir, binDir: agyBinDir }));
  }
  if (method === 'POST' && pathname === '/api/app-server/restart') {
    if (opaqueOrigin) return reply(403, { error: 'invalid origin' });
    if (!appServer) return reply(503, { error: 'shared Codex app-server management is disabled' });
    const body = await readBody();
    const result = await appServer.restart({ force: body?.force === true });
    return reply(result.status || (result.ok ? 200 : 500), result);
  }
  const interrupt = /^\/api\/runs\/(.*?)\/interrupt$/.exec(rawPath);
  if (method === 'POST' && interrupt) {
    if (opaqueOrigin) return reply(403, { error: 'invalid origin' });
    const id = interrupt[1];
    if (id.length !== 32 || !/^[a-f0-9]+$/.test(id)) return reply(400, { error: 'invalid run_id' });
    if (!appServer) return reply(503, { error: 'shared Codex app-server management is disabled' });
    return reply(200, await appServer.interruptRun(id, sessionsDir));
  }
  if (method === 'GET' && pathname === '/api/state') {
    const ratioRange = url.searchParams.get('ratio_range') ?? '24h';
    if (!RATIO_RANGES.includes(ratioRange)) {
      return reply(400, { error: 'invalid ratio_range' });
    }
    if (url.searchParams.get('probe') === '1' && appServer) {
      await appServer.ensureRunning({ probe: true });
    }
    const state = await readState({
      configPath,
      sessionsDir,
      magpieConfigDir,
      antigravityPluginDir,
      agyBinDir,
      execEnabled,
      mcpToolsEnabled,
      appServer,
      ratioRange,
      probeTimeoutMs,
    });
    return reply(200, state);
  }
  if (method === 'POST' && pathname === '/api/init') {
    const result = await initSubscriptionConfig({ configPath, probeTimeoutMs });
    return reply(result.status, result);
  }
  if (method === 'POST' && pathname === '/api/native-groups') {
    const result = await createNativeGroups({
      configPath,
      magpieConfigDir,
      magpieCliPath,
      probeTimeoutMs,
    });
    return reply(result.status, result);
  }
  if (method === 'POST' && pathname === '/api/tier') {
    const body = await readBody();
    const result = setDefaultTier(body?.tier, { configPath });
    return reply(result.status, result);
  }
  if (method === 'POST' && (pathname === '/api/probe-gateway' || pathname === '/api/reset-settings')) {
    const body = await readBody();
    const result = pathname === '/api/probe-gateway' ? await probeGatewaySettings(body, options) : resetSettings(body, options);
    return reply(result.status, result);
  }
  if (method === 'POST' && pathname === '/api/settings') {
    const result = await updateSettings(await readBody(), { configPath, probeTimeoutMs });
    return reply(result.status, result);
  }
  return reply(404, { error: 'not found' });
}

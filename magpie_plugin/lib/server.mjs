/**
 * Local HTTP page service for the GemPT Magpie Page Plugin.
 *
 * Follows Magpie's sandboxed page service model:
 * - Binds strictly to 127.0.0.1 and validates Host & Origin headers.
 * - Generates an ephemeral per-process token injected into ui/index.html only on
 *   navigation requests (sec-fetch-mode === 'navigate' or absent).
 * - Requires `x-gempt-key` on every /api/* route except /api/ping.
 * - Reuses and seamlessly takes over the port across Magpie plugin reloads.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATIO_RANGES } from './token-ratio.mjs';
import {
  createNativeGroups,
  getDispatchActivity,
  initSubscriptionConfig,
  isActivityId,
  listDispatchActivity,
  readJsonSafe,
  readState,
  resolveConfigPath,
  setDefaultSandbox,
  setDefaultTier,
  setWorkSplit,
  setPairing,
  setEffortSettings,
  setFailoverMode,
} from './backend.mjs';

import { createAppServerManager } from './app-server-manager.mjs';
import { installAgy } from '../../core/agy-install.mjs';

export const DEFAULT_PORT = 3498;
const MAX_POST_BYTES = 8192;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const UI_ROOT = resolve(HERE, '..', 'ui');
const UI_PREFIX = UI_ROOT.endsWith(sep) ? UI_ROOT : UI_ROOT + sep;
const THIS_FILE = fileURLToPath(import.meta.url);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const PKG = (() => {
  try {
    return JSON.parse(readFileSync(resolve(HERE, '..', '..', 'package.json'), 'utf-8'));
  } catch {
    return {};
  }
})();

const BUILD_ID = `${PKG.version || '0.3.1'}-${Math.trunc(statSync(THIS_FILE).mtimeMs)}`;
const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sleepUnref = (ms) => new Promise((resolveSleep) => {
  const timer = setTimeout(resolveSleep, ms);
  timer.unref?.();
});

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_POST_BYTES) {
        rejectBody(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(Object.assign(new Error('Invalid JSON payload'), { status: 400 }));
      }
    });
    req.on('error', rejectBody);
  });
}

export async function startServer({
  port,
  configPath,
  sessionsDir,
  magpieConfigDir,
  antigravityPluginDir,
  agyBinDir,
  magpieCliPath,
  execEnabled = false,
  mcpToolsEnabled,
  probeTimeoutMs = 2000,
  manageAppServer,
  appServerOptions,
} = {}) {
  const KEY = randomBytes(24).toString('base64url');
  const INSTANCE_ID = randomBytes(16).toString('hex');
  const resolvedConfigDir = dirname(resolveConfigPath(configPath));
  const identityFile = (p) => join(resolvedConfigDir, `page-server-${p}.json`);
  let publishedIdentityPath = null;
  const publishIdentity = (p) => {
    try {
      mkdirSync(resolvedConfigDir, { recursive: true, mode: 0o700 });
      const file = identityFile(p);
      writeFileSync(file, JSON.stringify({
        service: 'gempt-magpie-plugin',
        instance_id: INSTANCE_ID,
        pid: process.pid,
        port: p,
        build: BUILD_ID,
      }) + '\n', { mode: 0o600 });
      publishedIdentityPath = file;
    } catch { /* Best effort when config dir is read-only. */ }
  };
  const clearIdentity = () => {
    if (!publishedIdentityPath) return;
    try {
      const current = readJsonSafe(publishedIdentityPath);
      if (current?.instance_id === INSTANCE_ID && existsSync(publishedIdentityPath)) {
        unlinkSync(publishedIdentityPath);
      }
    } catch { /* Ignore cleanup errors. */ }
    publishedIdentityPath = null;
  };
  let actualPort = 0;
  let appServer;
  let OWN = new Set();
  let HOSTS = new Set();

  const own = (p) => {
    actualPort = p;
    OWN = new Set([`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
    HOSTS = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
  };

  const hostAllowed = (req) => HOSTS.has(String(req.headers.host || '').toLowerCase());
  const originAllowed = (req) => {
    const o = req.headers.origin;
    return o === undefined || o === 'null' || OWN.has(o);
  };
  const corsHeaders = (req) => {
    const o = req.headers.origin;
    const h = { vary: 'Origin' };
    if (o === 'null' ? req.method === 'OPTIONS' || keyOK(req) : OWN.has(o)) {
      h['access-control-allow-origin'] = o;
    }
    return h;
  };
  const send = (req, res, status, body, type = 'application/json; charset=utf-8', withCors = true) => {
    const data = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      ...(withCors ? corsHeaders(req) : {}),
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  };
  const keyOK = (req) => {
    const got = Buffer.from(String(req.headers['x-gempt-key'] || ''));
    const want = Buffer.from(KEY);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const server = createServer(async (req, res) => {
    if (!hostAllowed(req)) {
      return send(req, res, 403, { error: 'invalid host' }, undefined, false);
    }
    if (!originAllowed(req)) {
      return send(req, res, 403, { error: 'cross-origin reads are not allowed' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(req),
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type, x-gempt-key',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${actualPort || DEFAULT_PORT}`);
      const pathname = url.pathname;
      // Validate the raw segment before URL normalization can collapse dot paths.
      const activity = /^\/api\/(requests|sessions)(?:\/(.*))?$/.exec((req.url || '/').split('?', 1)[0]);
      if (activity && req.method === 'GET') {
        if (!keyOK(req)) return send(req, res, 401, { error: 'unauthorized: send the x-gempt-key header' });
        const [, kind, encodedId] = activity;
        if (encodedId === undefined) {
          const result = await listDispatchActivity(kind, url.searchParams, sessionsDir, magpieConfigDir, configPath);
          return send(req, res, 200, result, typeof result === 'string' ? 'text/csv; charset=utf-8' : undefined);
        }
        let id;
        try { id = decodeURIComponent(encodedId); } catch { /* Invalid percent encoding. */ }
        if (!id || !isActivityId(kind, id)) return send(req, res, 400, { error: 'invalid activity id' });
        const result = await getDispatchActivity(kind, id, sessionsDir, magpieConfigDir, configPath);
        return result ? send(req, res, 200, result) : send(req, res, 404, { error: 'not found' });
      }
      if (pathname === '/api/ping') {
        return send(req, res, 200, {
          ok: true,
          service: 'gempt-magpie-plugin',
          build: BUILD_ID,
          port: actualPort,
          instance_id: INSTANCE_ID,
        }, undefined, false);
      }

      if (pathname.startsWith('/api/')) {
        if (!keyOK(req)) {
          return send(req, res, 401, { error: 'unauthorized: send the x-gempt-key header' });
        }
        if (req.method === 'POST' && pathname === '/api/install-agy') {
          if (req.headers.origin === 'null') return send(req, res, 403, { error: 'invalid origin' });
          return send(req, res, 200, await installAgy({ target: antigravityPluginDir, binDir: agyBinDir }));
        }
        if (req.method === 'POST' && pathname === '/api/app-server/restart') {
          if (req.headers.origin === 'null') return send(req, res, 403, { error: 'invalid origin' });
          if (!appServer) return send(req, res, 503, { error: 'shared Codex app-server management is disabled' });
          const body = await readJsonBody(req);
          const result = await appServer.restart({ force: body?.force === true });
          return send(req, res, result.status || (result.ok ? 200 : 500), result);
        }
        const interrupt = /^\/api\/runs\/(.*?)\/interrupt$/.exec((req.url || '/').split('?', 1)[0]);
        if (req.method === 'POST' && interrupt) {
          if (req.headers.origin === 'null') return send(req, res, 403, { error: 'invalid origin' });
          const id = interrupt[1];
          if (id.length !== 32 || !/^[a-f0-9]+$/.test(id)) return send(req, res, 400, { error: 'invalid run_id' });
          if (!appServer) return send(req, res, 503, { error: 'shared Codex app-server management is disabled' });
          return send(req, res, 200, await appServer.interruptRun(id, sessionsDir));
        }
        if (req.method === 'GET' && pathname === '/api/state') {
          const ratioRange = url.searchParams.get('ratio_range') ?? '24h';
          if (!RATIO_RANGES.includes(ratioRange)) {
            return send(req, res, 400, { error: 'invalid ratio_range' });
          }
          if (url.searchParams.get('probe') === '1' && appServer) {
            await appServer.ensureRunning({ probe: true });
          }
          const state = await readState({
            configPath,
            sessionsDir,
            magpieConfigDir,
            antigravityPluginDir,
            execEnabled,
            mcpToolsEnabled,
            appServer,
            ratioRange,
            probeTimeoutMs,
          });
          return send(req, res, 200, state);
        }
        if (req.method === 'POST' && pathname === '/api/init') {
          const result = await initSubscriptionConfig({ configPath, probeTimeoutMs });
          return send(req, res, result.status, result);
        }
        if (req.method === 'POST' && pathname === '/api/native-groups') {
          const result = await createNativeGroups({
            configPath,
            magpieConfigDir,
            magpieCliPath,
            probeTimeoutMs,
          });
          return send(req, res, result.status, result);
        }
        if (req.method === 'POST' && pathname === '/api/tier') {
          const body = await readJsonBody(req);
          const result = setDefaultTier(body?.tier, { configPath });
          return send(req, res, result.status, result);
        }
        if (req.method === 'POST' && pathname === '/api/settings') {
          const body = await readJsonBody(req);
          if (!body || typeof body !== 'object') {
            return send(req, res, 400, { ok: false, error: '未提供有效设置项。' });
          }
          const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
          if (has('pairing')) {
            if (Object.keys(body).length !== 1) return send(req, res, 400, { ok: false, error: '每次请选择一个配对设置。' });
            const result = setPairing(body.pairing?.family, body.pairing?.model, { configPath });
            return send(req, res, result.status, result);
          }
          if (has('work_split') || has('swarm_split')) {
            if (Object.keys(body).length !== 1) {
              return send(req, res, 400, { ok: false, error: '每次请选择一个分工设置。' });
            }
            const key = has('work_split') ? 'work_split' : 'swarm_split';
            const result = setWorkSplit(key, body[key], { configPath });
            return send(req, res, result.status, result);
          }
          const hasSbx = has('default_sandbox');
          const hasMode = has('failover_mode');
          const hasEffort = has('auto_effort') || has('tier_effort');
          if (!hasSbx && !hasMode && !hasEffort) {
            return send(req, res, 400, { ok: false, error: '未提供有效设置项。' });
          }
          let out = { ok: true, status: 200 };
          if (hasSbx) {
            const sbxRes = setDefaultSandbox(body.default_sandbox, { configPath });
            if (!sbxRes.ok) return send(req, res, sbxRes.status, sbxRes);
            out = { ...out, ...sbxRes };
          }
          if (hasMode) {
            const fmRes = await setFailoverMode(body.failover_mode, { configPath, probeTimeoutMs });
            if (!fmRes.ok) return send(req, res, fmRes.status, fmRes);
            out = { ...out, ...fmRes };
          }
          if (hasEffort) {
            const effRes = setEffortSettings(
              {
                autoEffort: has('auto_effort') ? body.auto_effort : undefined,
                tierEffort: has('tier_effort') ? body.tier_effort : undefined,
                tier: has('tier') ? body.tier : undefined,
              },
              { configPath },
            );
            if (!effRes.ok) return send(req, res, effRes.status, effRes);
            out = { ...out, ...effRes };
          }
          return send(req, res, out.status || 200, out);
        }
        return send(req, res, 404, { error: 'not found' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, { error: 'method not allowed' }, undefined, false);
      }

      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = resolve(UI_ROOT, rel);
      if (!file.startsWith(UI_PREFIX)) {
        return send(req, res, 403, { error: 'forbidden' }, undefined, false);
      }
      const data = await readFile(file).catch(() => null);
      if (!data) {
        return send(req, res, 404, 'not found', 'text/plain; charset=utf-8', false);
      }
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
      if (rel === 'index.html') {
        const mode = String(req.headers['sec-fetch-mode'] || '');
        if (mode && mode !== 'navigate') {
          return send(req, res, 403, { error: 'cross-origin page read not allowed' }, undefined, false);
        }
        const html = data.toString('utf-8').replace('<head>', `<head>\n  <meta name="gempt-key" content="${KEY}">`);
        return send(req, res, 200, html, type, false);
      }
      return send(req, res, 200, data, type, false);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      return send(req, res, err.status || 500, { error: String(err?.message || err) });
    }
  });

  const rawWant = port ?? process.env.GEMPT_MAGPIE_PLUGIN_PORT;
  let target = DEFAULT_PORT;
  if (rawWant !== undefined && rawWant !== null && rawWant !== '' && Number.isFinite(Number(rawWant))) {
    const n = Number(rawWant);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) target = n;
  }

  const probeExisting = async (p) => {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(800) });
      if (!r.ok) return null;
      const body = await r.json();
      if (!body || body.service !== 'gempt-magpie-plugin') return null;
      const expected = readJsonSafe(identityFile(p));
      if (!expected || expected.service !== 'gempt-magpie-plugin' || expected.port !== p
          || typeof expected.instance_id !== 'string' || !expected.instance_id
          || body.instance_id !== expected.instance_id || !pidAlive(expected.pid)) {
        return null;
      }
      return body;
    } catch {
      return null;
    }
  };

  const bindOnce = (p) => new Promise((resolveBind, rejectBind) => {
    const cleanup = () => {
      server.removeListener('listening', onOk);
      server.removeListener('error', onErr);
    };
    const onOk = () => {
      cleanup();
      own(server.address().port);
      publishIdentity(actualPort);
      resolveBind(true);
    };
    const onErr = (err) => {
      cleanup();
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') rejectBind(err);
      else resolveBind(false);
    };
    server.once('listening', onOk);
    server.once('error', onErr);
    server.listen(p, '127.0.0.1');
  });

  let closed = false;
  const result = (listening, reused) => {
    if (manageAppServer ?? target !== 0) {
      appServer = createAppServerManager({ configPath, sessionsDir, ...appServerOptions });
      void appServer.ensureRunning();
    }
    return {
      port: actualPort, listening, reused, server, appServer,
      async close() {
        closed = true;
        clearIdentity();
        await Promise.all([
          appServer?.stop(),
          new Promise((done) => (server.listening ? server.close(done) : done())),
        ]);
      },
    };
  };

  if (target === 0) {
    await bindOnce(0);
    return result(true, false);
  }

  const takeover = (p) => {
    (async () => {
      while (!closed) {
        await sleepUnref(1000);
        if (closed) return;
        try {
          if (await bindOnce(p)) {
            console.log(`[gempt-magpie-plugin] took over port ${p} (build ${BUILD_ID})`);
            return;
          }
        } catch (err) {
          console.log(`[gempt-magpie-plugin] takeover stopped: ${err.code || err.message}`);
          return;
        }
      }
    })();
  };

  const deadline = Date.now() + 18000;
  let foreignSince = 0;
  for (;;) {
    if (await bindOnce(target)) break;
    const st = await probeExisting(target);
    if (st) {
      if (st.build === BUILD_ID) {
        await sleep(1200);
        const again = await probeExisting(target);
        if (again && again.build === BUILD_ID) {
          own(target);
          takeover(target);
          return result(false, true);
        }
        continue;
      }
      own(target);
      takeover(target);
      return result(false, true);
    }
    if (!foreignSince) foreignSince = Date.now();
    if (Date.now() - foreignSince > 4000 || Date.now() >= deadline) {
      throw new Error(`port ${target} is in use by another program — free it or set GemPT's port option`);
    }
    await sleep(150);
  }

  console.log(`[gempt-magpie-plugin] listening on http://127.0.0.1:${actualPort}`);
  return result(true, false);
}

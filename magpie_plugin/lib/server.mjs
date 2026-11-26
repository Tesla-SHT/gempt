import { startSwarmMonitor } from '../../core/swarm-monitor.mjs';
import { routeBoardDeliveries } from '../../core/swarm-engine.mjs';
/**
 * Local HTTP page service for the GemPT Magpie Page Plugin.
 *
 * Follows Magpie's sandboxed page service model:
 * - Binds strictly to 127.0.0.1 and validates Host & Origin headers.
 * - Generates an ephemeral per-process token injected into ui/index.html only on
 *   navigation requests (sec-fetch-mode === 'navigate' / 'nested-navigate' or absent)
 *   without a foreign/opaque Origin header.
 * - Requires `x-gempt-key` on every /api/* route except /api/ping.
 * - Reuses and seamlessly takes over the port across Magpie plugin reloads,
 *   cleaning up stale identity files whose owning PID has exited.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { withLockSync } from '../../core/state.mjs';
import { readJsonSafe, resolveConfigPath, resolveSessionsDir, warmPageTelemetry } from './backend.mjs';
import { createAppServerManager, resolveProxyTarget } from './app-server-manager.mjs';
import { CACHE_PROXY_PATH, createThreadCacheKeys, PROXY_PATH, proxyCodexRequest } from './codex-proxy.mjs';
import { dispatchPageApi } from './page-api.mjs';
import { readPageAsset } from './page-assets.mjs';

export const DEFAULT_PORT = 3498;
const MAX_POST_BYTES = 8192;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const compress = promisify(gzip);
const compressedAssets = new WeakMap();

function acceptsGzip(value = '') {
  return value.split(',').some((part) => {
    const [encoding, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.find((parameter) => /^\s*q\s*=/.test(parameter));
    return encoding.trim() === 'gzip' && (!quality || Number(quality.split('=')[1]) > 0);
  });
}

const PKG = (() => {
  try {
    return JSON.parse(readFileSync(resolve(HERE, '..', '..', 'package.json'), 'utf-8'));
  } catch {
    return {};
  }
})();

const BUILD_ID = `${PKG.version || '0.10.1'}-${Math.trunc(statSync(THIS_FILE).mtimeMs)}`;
const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
function readJsonBody(req, maxBytes = MAX_POST_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
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

function loadOrCreateProxyToken(configPath) {
  const dir = dirname(resolveConfigPath(configPath));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'codex-proxy.token');
  return withLockSync(join(dir, 'codex-proxy.token.lock'), () => {
    let token;
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      token = randomBytes(32).toString('base64url');
      const temp = join(dir, `.codex-proxy-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, token, { mode: 0o600, flag: 'wx' });
        renameSync(temp, file);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    return token;
  });
}

export async function startServer({
  port,
  configPath,
  sessionsDir,
  magpieConfigDir,
  antigravityPluginDir,
  agyBinDir,
  execEnabled = false,
  mcpToolsEnabled,
  probeTimeoutMs = 2000,
  manageAppServer,
  appServerOptions,
} = {}) {
  const KEY = randomBytes(24).toString('base64url');
  const IPC_TOKEN = randomBytes(24).toString('base64url');
  const proxyToken = loadOrCreateProxyToken(configPath);
  const threadCacheKeys = createThreadCacheKeys({ sessionsDir: resolveSessionsDir(sessionsDir) });
  let proxyTarget = resolveProxyTarget(readJsonSafe(resolveConfigPath(configPath)) || {});
  const INSTANCE_ID = randomBytes(16).toString('hex');
  const resolvedConfigDir = dirname(resolveConfigPath(configPath));
  const identityFile = (p) => join(resolvedConfigDir, `page-server-${p}.json`);
  const ipcFile = (p) => join(resolvedConfigDir, `page-server-${p}.ipc`);
  let publishedIdentityPath = null;
  let publishedIpcPath = null;
  let exitHookRegistered = false;

  const cleanStaleIdentity = (file) => {
    if (!file || file === publishedIdentityPath || file === publishedIpcPath || !existsSync(file)) return false;
    try {
      const rec = readJsonSafe(file);
      const stale = !rec
        || (rec.service === 'gempt-magpie-plugin'
          && (!pidAlive(rec.pid) || typeof rec.instance_id !== 'string' || !rec.instance_id));
      if (stale) {
        unlinkSync(file);
        if (file.endsWith('.json')) {
          const siblingIpc = `${file.slice(0, -5)}.ipc`;
          if (siblingIpc !== publishedIpcPath && existsSync(siblingIpc)) {
            try { unlinkSync(siblingIpc); } catch { /* ignore */ }
          }
        }
        return true;
      }
    } catch { /* Ignore cleanup races or read-only directories. */ }
    return false;
  };

  const sweepStaleIdentities = () => {
    try {
      if (!existsSync(resolvedConfigDir)) return;
      for (const name of readdirSync(resolvedConfigDir)) {
        if (!/^page-server-\d+\.(?:json|ipc)$/.test(name)) continue;
        cleanStaleIdentity(join(resolvedConfigDir, name));
      }
    } catch { /* Best effort. */ }
  };

  const clearIdentity = () => {
    if (publishedIdentityPath) {
      try {
        const current = readJsonSafe(publishedIdentityPath);
        if (current?.instance_id === INSTANCE_ID && existsSync(publishedIdentityPath)) {
          unlinkSync(publishedIdentityPath);
        }
      } catch { /* Ignore cleanup errors. */ }
      publishedIdentityPath = null;
    }
    if (publishedIpcPath) {
      try {
        const current = readJsonSafe(publishedIpcPath);
        if (current?.instance_id === INSTANCE_ID && existsSync(publishedIpcPath)) {
          unlinkSync(publishedIpcPath);
        }
      } catch { /* Ignore cleanup errors. */ }
      publishedIpcPath = null;
    }
  };

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
      const ipc = ipcFile(p);
      writeFileSync(ipc, JSON.stringify({
        service: 'gempt-magpie-plugin',
        instance_id: INSTANCE_ID,
        pid: process.pid,
        port: p,
        token: IPC_TOKEN,
      }) + '\n', { mode: 0o600 });
      publishedIpcPath = ipc;
      if (!exitHookRegistered) {
        exitHookRegistered = true;
        process.once('exit', clearIdentity);
      }
    } catch { /* Best effort when config dir is read-only. */ }
  };

  let actualPort = 0;
  let appServer;
  const pageOptions = () => ({ configPath, sessionsDir, magpieConfigDir, antigravityPluginDir, agyBinDir,
    execEnabled, mcpToolsEnabled, appServer, probeTimeoutMs, env: appServerOptions?.env,
    connect: appServerOptions?.connect });
  let OWN = new Set();
  let HOSTS = new Set();

  const own = (p) => {
    actualPort = p;
    OWN = new Set([`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`]);
    HOSTS = new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  };

  const normalizedOrigin = (req) => {
    const o = req.headers.origin;
    return typeof o === 'string' ? o.trim().toLowerCase() : undefined;
  };
  const hostAllowed = (req) => HOSTS.has(String(req.headers.host || '').toLowerCase());
  const originAllowed = (req) => {
    const o = normalizedOrigin(req);
    return o === undefined || o === 'null' || OWN.has(o);
  };
  const corsHeaders = (req, publicModule = false) => {
    const o = req.headers.origin;
    const norm = normalizedOrigin(req);
    const h = { vary: 'Origin' };
    if (norm === 'null' ? publicModule || req.method === 'OPTIONS' || keyOK(req) : (norm !== undefined && OWN.has(norm))) {
      h['access-control-allow-origin'] = o;
    }
    return h;
  };
  const send = async (req, res, status, body, type = 'application/json; charset=utf-8', withCors = true, asset, extraHeaders) => {
    let data = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    const headers = {
      'content-type': type,
      'cache-control': asset ? 'public, max-age=0, must-revalidate' : 'no-store',
      ...(withCors ? corsHeaders(req, withCors === 'module') : {}),
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    };
    headers.vary = [headers.vary, 'Accept-Encoding'].filter(Boolean).join(', ');
    if (asset) {
      headers.etag = asset.etag;
      if (req.headers['if-none-match']?.split(/,\s*/).some((tag) => tag === '*' || tag.replace(/^W\//, '') === asset.etag.slice(2))) {
        res.writeHead(304, headers);
        return res.end();
      }
    }
    if (Buffer.byteLength(data) >= 1024 && acceptsGzip(req.headers['accept-encoding'])) {
      if (asset && !compressedAssets.has(asset)) {
        compressedAssets.set(asset, compress(data).catch(() => {
          compressedAssets.delete(asset);
          return null;
        }));
      }
      const compressed = await (asset ? compressedAssets.get(asset) : compress(data).catch(() => null));
      if (compressed) {
        data = compressed;
        headers['content-encoding'] = 'gzip';
      }
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  };
  const keyOK = (req) => {
    const got = Buffer.from(String(req.headers['x-gempt-key'] || ''));
    const want = Buffer.from(KEY);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const ipcOK = (req) => {
    const got = Buffer.from(String(req.headers['x-gempt-ipc-token'] || ''));
    const want = Buffer.from(IPC_TOKEN);
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
      const proxyPrefix = [PROXY_PATH, CACHE_PROXY_PATH].find((prefix) => pathname.startsWith(prefix + '/'));
      if (proxyPrefix) {
        const got = Buffer.from(req.headers['x-gempt-proxy-token']
          ? 'Bearer ' + req.headers['x-gempt-proxy-token'] : req.headers.authorization || '');
        const want = Buffer.from('Bearer ' + proxyToken);
        if (got.length !== want.length || !timingSafeEqual(got, want)) {
          return send(req, res, 401, { error: 'invalid proxy token' }, undefined, false);
        }
        if (!proxyTarget) return send(req, res, 503, { error: 'gateway unavailable' }, undefined, false);
        return await proxyCodexRequest(req, res, url, proxyTarget, threadCacheKeys, proxyPrefix);
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

      if (pathname === '/api/internal/dispatch' || pathname === '/api/internal/cache-key') {
        if (req.method !== 'POST') return send(req, res, 405, { error: 'method not allowed' }, undefined, false);
        const remote = String(req.socket?.remoteAddress || '');
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLoopback || !ipcOK(req)) {
          return send(req, res, 401, { error: 'unauthorized: valid loopback x-gempt-ipc-token required' }, undefined, false);
        }
        if (pathname === '/api/internal/cache-key') {
          threadCacheKeys.register(await readJsonBody(req) || {});
          return send(req, res, 200, { ok: true }, undefined, false);
        }
        const body = await readJsonBody(req, 1024 * 1024);
        if (!body || typeof body !== 'object' || !body.args || typeof body.args !== 'object') {
          return send(req, res, 400, { error: 'invalid dispatch payload' }, undefined, false);
        }
        const { dispatchRun } = await import('../../core/runs.mjs');
        const reqOpts = body.options && typeof body.options === 'object' ? body.options : {};
        const run = await dispatchRun(body.args, {
          configPath: reqOpts.configPath || configPath,
          sessionsDir: reqOpts.sessionsDir || sessionsDir,
          magpieConfigDir: reqOpts.magpieConfigDir || magpieConfigDir,
          probeTimeoutMs,
          waitSec: reqOpts.waitSec,
          agent: reqOpts.agent,
          env: appServerOptions?.env || process.env,
        });
        return send(req, res, 200, { ok: true, run }, undefined, false);
      }

      const rawPath = (req.url || '/').split('?', 1)[0];
      if (pathname === '/api/swarm' || pathname.startsWith('/api/') || /^\/api\/(requests|sessions)(?:\/|$)/.test(rawPath)) {
        if (!keyOK(req)) return send(req, res, 401, { error: 'unauthorized: send the x-gempt-key header' });
        const result = await dispatchPageApi({
          method: req.method, url, rawPath, readBody: () => readJsonBody(req),
          opaqueOrigin: normalizedOrigin(req) === 'null',
        }, pageOptions());
        return send(req, res, result.status, result.body, result.type);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, { error: 'method not allowed' }, undefined, false);
      }

      const index = pathname === '/' || pathname.toLowerCase() === '/index.html';
      if (index) {
        const mode = String(req.headers['sec-fetch-mode'] || '').trim().toLowerCase();
        if (mode && mode !== 'navigate' && mode !== 'nested-navigate') {
          return send(req, res, 403, { error: 'cross-origin page read not allowed' }, undefined, false);
        }
        const origin = normalizedOrigin(req);
        if (origin !== undefined && origin !== 'null' && !OWN.has(origin)) {
          return send(req, res, 403, { error: 'cross-origin page read not allowed' }, undefined, false);
        }
        const asset = await readPageAsset('/index.html');
        const html = asset.data.toString('utf8')
          .replace('<head>', `<head>\n  <meta name="gempt-key" content="${KEY}">`);
        const ownOrigins = [...OWN].filter((o) => !o.includes('[::1]')).join(' ');
        return await send(req, res, 200, html, asset.type, false, undefined, {
          'content-security-policy': `default-src 'none'; script-src 'self' ${ownOrigins}; connect-src 'self' ${ownOrigins}; style-src 'self' ${ownOrigins} 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`,
        });
      }
      const asset = await readPageAsset(pathname);
      if (!asset) return send(req, res, 404, 'not found', 'text/plain; charset=utf-8', false);
      // Public modules also load in opaque Magpie frames.
      return await send(req, res, 200, asset.data, asset.type,
        asset.type.startsWith('text/javascript') ? 'module' : false, asset);
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

  sweepStaleIdentities();

  const probeExisting = async (p) => {
    const idFile = identityFile(p);
    cleanStaleIdentity(idFile);
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(800) });
      if (!r.ok) return null;
      const body = await r.json();
      if (!body || body.service !== 'gempt-magpie-plugin') return null;
      const expected = readJsonSafe(idFile);
      if (!expected || expected.service !== 'gempt-magpie-plugin' || expected.port !== p
          || typeof expected.instance_id !== 'string' || !expected.instance_id
          || !pidAlive(expected.pid)) {
        cleanStaleIdentity(idFile);
        return null;
      }
      if (body.instance_id !== expected.instance_id) {
        return null;
      }
      return body;
    } catch {
      cleanStaleIdentity(idFile);
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
  let takeoverTimer = null;
  let takeoverDone = null;
  const sleepTakeover = (ms) => new Promise((resolveSleep) => {
    takeoverDone = resolveSleep;
    takeoverTimer = setTimeout(() => {
      takeoverTimer = null;
      takeoverDone = null;
      resolveSleep();
    }, ms);
    takeoverTimer.unref?.();
  });

  let stopMonitor;
  const startManager = () => {
    stopMonitor ??= startSwarmMonitor({ sessionsDir: resolveSessionsDir(sessionsDir),
      dispatchAlert: (id) => routeBoardDeliveries(id, pageOptions()) });
    if (manageAppServer ?? target !== 0) {
      appServer = createAppServerManager({ configPath, sessionsDir, ...appServerOptions,
        proxyBaseUrl: `http://127.0.0.1:${actualPort}${PROXY_PATH}`, proxyToken,
        onProxyTarget: (target) => { proxyTarget = target; } });
      void appServer.ensureRunning();
    }
  };
  const result = (listening, reused) => {
    if (listening) startManager();
    if (listening) warmPageTelemetry(pageOptions());
    return {
      port: actualPort,
      get listening() { return server.listening; },
      reused,
      server,
      get appServer() { return appServer; },
      async close() {
        closed = true;
        stopMonitor?.();
        if (takeoverTimer) {
          clearTimeout(takeoverTimer);
          takeoverTimer = null;
        }
        if (takeoverDone) {
          const done = takeoverDone;
          takeoverDone = null;
          done();
        }
        if (exitHookRegistered) {
          exitHookRegistered = false;
          process.off('exit', clearIdentity);
        }
        clearIdentity();
        await Promise.all([
          appServer?.stop(),
          new Promise((done) => {
            if (!server.listening) return done();
            server.close(done);
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
          }),
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
        await sleepTakeover(500);
        if (closed) return;
        cleanStaleIdentity(identityFile(p));
        try {
          if (await bindOnce(p)) {
            startManager();
            warmPageTelemetry(pageOptions());
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
    cleanStaleIdentity(identityFile(target));
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

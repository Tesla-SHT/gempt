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
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeGroups, initSubscriptionConfig, readState, setDefaultSandbox, setDefaultTier } from './backend.mjs';

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

const BUILD_ID = `${PKG.version || '0.1.0'}-${Math.trunc(statSync(THIS_FILE).mtimeMs)}`;
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
  magpieCliPath,
  execEnabled = false,
  probeTimeoutMs = 2000,
} = {}) {
  const KEY = randomBytes(24).toString('base64url');
  let actualPort = 0;
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
    if (o === 'null') h['access-control-allow-origin'] = 'null';
    else if (o && OWN.has(o)) h['access-control-allow-origin'] = o;
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

    const url = new URL(req.url || '/', `http://127.0.0.1:${actualPort || DEFAULT_PORT}`);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/ping') {
        return send(req, res, 200, {
          ok: true,
          service: 'gempt-magpie-plugin',
          build: BUILD_ID,
          port: actualPort,
        });
      }

      if (pathname.startsWith('/api/')) {
        if (!keyOK(req)) {
          return send(req, res, 401, { error: 'unauthorized: send the x-gempt-key header' });
        }
        if (req.method === 'GET' && pathname === '/api/state') {
          const state = await readState({
            configPath,
            sessionsDir,
            magpieConfigDir,
            antigravityPluginDir,
            execEnabled,
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
          if (body && Object.prototype.hasOwnProperty.call(body, 'failover_mode')) {
            return send(req, res, 400, {
              ok: false,
              error: '当前纯订阅版本不支持切换 API 兜底模式。',
            });
          }
          if (body && Object.prototype.hasOwnProperty.call(body, 'default_sandbox')) {
            const result = setDefaultSandbox(body.default_sandbox, { configPath });
            return send(req, res, result.status, result);
          }
          return send(req, res, 400, { ok: false, error: '未提供有效设置项。' });
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
      return body && body.service === 'gempt-magpie-plugin' ? body : null;
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

  if (target === 0) {
    await bindOnce(0);
    return {
      port: actualPort,
      listening: true,
      reused: false,
      server,
      close: () => new Promise((resolveClose) => (server.listening ? server.close(() => resolveClose()) : resolveClose())),
    };
  }

  let closed = false;
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
          return {
            port: target,
            listening: false,
            reused: true,
            server,
            close: () => {
              closed = true;
              return new Promise((resolveClose) => (server.listening ? server.close(() => resolveClose()) : resolveClose()));
            },
          };
        }
        continue;
      }
      own(target);
      takeover(target);
      return {
        port: target,
        listening: false,
        reused: true,
        server,
        close: () => {
          closed = true;
          return new Promise((resolveClose) => (server.listening ? server.close(() => resolveClose()) : resolveClose()));
        },
      };
    }
    if (!foreignSince) foreignSince = Date.now();
    if (Date.now() - foreignSince > 4000 || Date.now() >= deadline) {
      throw new Error(`port ${target} is in use by another program — free it or set GemPT's port option`);
    }
    await sleep(150);
  }

  console.log(`[gempt-magpie-plugin] listening on http://127.0.0.1:${actualPort}`);
  return {
    port: actualPort,
    listening: true,
    reused: false,
    server,
    close: () => {
      closed = true;
      return new Promise((resolveClose) => (server.listening ? server.close(() => resolveClose()) : resolveClose()));
    },
  };
}

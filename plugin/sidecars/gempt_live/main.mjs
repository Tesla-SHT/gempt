import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundledRuntime = new URL('../../runtime/', import.meta.url);
const runtime = existsSync(bundledRuntime) ? bundledRuntime : new URL('../../../', import.meta.url);
const { startSwarmMonitor } = await import(new URL('core/swarm-monitor.mjs', runtime));
const { routeBoardDeliveries } = await import(new URL('core/swarm-engine.mjs', runtime));
const { resolveSessionsDir } = await import(new URL('core/config.mjs', runtime));
const { dispatchPageApi } = await import(new URL('magpie_plugin/lib/page-api.mjs', runtime));
const { readPageAsset } = await import(new URL('magpie_plugin/lib/page-assets.mjs', runtime));
const { warmPageTelemetry } = await import(new URL('magpie_plugin/lib/backend.mjs', runtime));
const { createAppServerManager } = await import(new URL('magpie_plugin/lib/app-server-manager.mjs', runtime));
const { resolvePath } = await import(new URL('core/state.mjs', runtime));
const { readPluginOptions, resolveMagpieConfigDir } = await import(new URL('core/config.mjs', runtime));

let sdkUrl;
try {
  sdkUrl = import.meta.resolve('sidecar_sdk');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("'sidecar_sdk'")) throw error;
  sdkUrl = pathToFileURL(join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'));
}
const { SidecarApp, Response } = await import(sdkUrl);

if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN) {
  throw new Error('GemPT requires ANTIGRAVITY_SIDECAR_UI_TOKEN.');
}
const app = new SidecarApp();
const appServer = createAppServerManager({ observeOnly: true });
const options = { appServer };
const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

// Keep the SDK's host bridge, scope its API calls to our mount, and defer
// project lookup until an Agent API action needs it. GemPT never needs it.
const preloadUrl = new URL('./preload.js', sdkUrl);
const scopedPreload = readFileSync(existsSync(preloadUrl) ? preloadUrl : new URL('../preload.js', sdkUrl), 'utf8')
  .replace(/(['"`])\/_sidecar\//g, '$1./_sidecar/');
const eagerProjectLookup = 'const projectIdPromise = (async () => {';
const preload = scopedPreload.includes(eagerProjectLookup)
  ? scopedPreload.replace(eagerProjectLookup,
    'let projectIdPromise;\n  const resolveProjectId = () => projectIdPromise ??= (async () => {')
    .replaceAll('await projectIdPromise;', 'await resolveProjectId();')
  : scopedPreload;
app.page('/gempt-preload.js', () => new Response(preload, {
  contentType: 'text/javascript; charset=utf-8', headers: noStore,
}));

// The gateway may serve the same page with or without a trailing slash. The
// SDK page handler cannot see the public URL, so normalize it before loading
// the relative assets. Keep the query (including the SDK token) and deep link.
const bootstrap = `if (!location.pathname.endsWith('/') && !location.pathname.endsWith('/index.html')) {
  const url = new URL(location.href);
  url.pathname += '/';
  try { history.replaceState(history.state, '', url); }
  catch { location.replace(url); }
}
// Embedded frames can lose the gateway's SameSite cookie on subresources.
const token = new URLSearchParams(location.search).get('token');
const asset = (name) => './' + name + (token ? '?' + new URLSearchParams({ token }) : '');
const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = asset('styles.css');
document.head.append(style);
function loadScript(name, onerror) {
  const script = document.createElement('script');
  script.async = false;
  script.src = asset(name);
  if (onerror) script.addEventListener('error', onerror, { once: true });
  document.head.append(script);
}
loadScript('gempt-preload.js');
document.addEventListener('DOMContentLoaded', () => {
  loadScript('app.js', () => {
    const notice = document.getElementById('list-error');
    notice.textContent = 'GemPT 脚本加载失败，请重新打开侧栏。';
    notice.hidden = false;
    document.getElementById('list-loading').hidden = true;
    document.getElementById('list-wrap').setAttribute('aria-busy', 'false');
  });
}, { once: true });`;
const entryHash = createHash('sha256').update(bootstrap).digest('base64');

async function entryPage() {
  const { data, type } = await readPageAsset('/');
  // The installed sidecar runs inside the directory the Magpie installer replaces.
  const port = Number(readPluginOptions(resolveMagpieConfigDir())?.port ?? process.env.GEMPT_MAGPIE_PLUGIN_PORT);
  const consolePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3498;
  const html = data.toString('utf8')
    .replace("script-src 'self';", `script-src 'self' 'sha256-${entryHash}';`)
    .replace('<link rel="stylesheet" href="./styles.css">', `<meta name="referrer" content="no-referrer">\n  <script>${bootstrap}</script>`)
    .replace('<html ', `<html data-sidecar data-install-page="http://127.0.0.1:${consolePort}/" `)
    .replace(/<script\s+(?:type="module"|defer)\s+src="\.\/app\.js"><\/script>/, '');
  return new Response(html, { contentType: type, headers: noStore });
}
app.page('/', entryPage);
app.page('/index.html', entryPage);
for (const path of ['/styles.css', '/app.js']) {
  app.page(path, async () => {
    const { data, type } = await readPageAsset(path);
    return new Response(data, { contentType: type, headers: noStore });
  });
}

function workspacePath(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'file:' && !url.search && !url.hash) return resolvePath(fileURLToPath(url));
  } catch { /* A remote or malformed URI cannot match a local run. */ }
  return null;
}

// Live and history contain local data. Keep the SDK's token check on every
// request, including those from an opaque iframe using its URL token.
const apiHeaders = { ...noStore, 'Access-Control-Allow-Origin': 'null' };
app.api('/api', async ({ path, body, conversationId, workspaceUris }) => {
  try {
    if (typeof path !== 'string' || path !== './api/swarm' && !path.startsWith('./api/swarm?') && !path.startsWith('./api/')) {
      return new Response(JSON.stringify({ error: 'invalid API path' }), {
        status: 400, contentType: 'application/json', headers: apiHeaders,
      });
    }
    const url = new URL(path, 'http://localhost/');
    const rawPath = path.slice(1).split('?', 1)[0];
    const activeConversation = typeof conversationId === 'string' && conversationId
      ? conversationId : app.config.conversationId || null;
    const result = await dispatchPageApi({
      method: body === undefined ? 'GET' : 'POST', url, rawPath, readBody: () => body,
    }, {
      ...options,
      sidecarJson: true,
      conversationId: activeConversation,
      ...(Array.isArray(workspaceUris) && workspaceUris.length
        ? { workspaceRoots: workspaceUris.map(workspacePath).filter(Boolean) } : {}),
    });
    return new Response(typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
      status: result.status, contentType: result.type, headers: apiHeaders,
    });
  } catch (error) {
    if (!error.status || error.status >= 500) console.error('[gempt sidecar] Page API failed:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: error.status || 500, contentType: 'application/json', headers: apiHeaders,
    });
  }
});
const server = await app.run();
const sessionsDir = resolveSessionsDir(process.env.GEMPT_SESSIONS_DIR);
const stopMonitor = startSwarmMonitor({ sessionsDir, dispatchAlert: (id) => routeBoardDeliveries(id, { sessionsDir }) });
const watchedFiles = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL('sidecar.json', import.meta.url)),
  fileURLToPath(new URL('magpie_plugin/lib/page-api.mjs', runtime)),
  fileURLToPath(new URL('core/assets/http-ui/app.js', runtime)),
];
const readStamp = () => watchedFiles.map((file) => {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}).join('|');
const initialStamp = readStamp();
let reloading = false;
const watchTimer = setInterval(() => {
  if (reloading || readStamp() === initialStamp) return;
  reloading = true;
  clearInterval(watchTimer);
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 1500).unref();
}, 2000);
watchTimer.unref();
server.once('close', () => {
  stopMonitor();
  clearInterval(watchTimer);
  void appServer.stop();
});
warmPageTelemetry(options);

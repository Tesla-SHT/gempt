import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundledRuntime = new URL('../../runtime/', import.meta.url);
const runtime = existsSync(bundledRuntime) ? bundledRuntime : new URL('../../../', import.meta.url);
const { dispatchPageApi } = await import(new URL('magpie_plugin/lib/page-api.mjs', runtime));
const { readPageAsset } = await import(new URL('magpie_plugin/lib/page-assets.mjs', runtime));
const { warmPageTelemetry } = await import(new URL('magpie_plugin/lib/backend.mjs', runtime));
const { createAppServerManager } = await import(new URL('magpie_plugin/lib/app-server-manager.mjs', runtime));
const { resolvePath } = await import(new URL('core/state.mjs', runtime));

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

// The SDK serves its own /preload.js with root-relative Agent API calls.
// Expose the same host bridge with those calls scoped to this sidecar mount.
const preloadUrl = new URL('./preload.js', sdkUrl);
const preload = readFileSync(existsSync(preloadUrl) ? preloadUrl : new URL('../preload.js', sdkUrl), 'utf8')
  .replace(/(['"`])\/_sidecar\//g, '$1./_sidecar/');
app.page('/gempt-preload.js', () => new Response(preload, {
  contentType: 'text/javascript; charset=utf-8', headers: noStore,
}));

// The gateway may serve the same page with or without a trailing slash. The
// SDK page handler cannot see the public URL, so normalize it before loading
// the relative assets. Keep the query (including the SDK token) and deep link.
const normalizeEntry = `if (!location.pathname.endsWith('/')) {
  const url = new URL(location.href);
  url.pathname += '/';
  history.replaceState(history.state, '', url);
}`;
const entryHash = createHash('sha256').update(normalizeEntry).digest('base64');

app.page('/', async () => {
  const { data, type } = await readPageAsset('/');
  const html = data.toString('utf8')
    .replace("script-src 'self';", `script-src 'self' 'sha256-${entryHash}';`)
    .replace('<link rel="stylesheet"', `<script>${normalizeEntry}</script>\n  <script src="./gempt-preload.js"></script>\n  <link rel="stylesheet"`);
  return new Response(html, { contentType: type, headers: noStore });
});
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

// The SDK only validates tokens on non-GET requests. Submit reads through
// this authenticated endpoint too, because Live and history contain local data.
app.api('/api', async ({ path, body, conversationId, workspaceUris }) => {
  try {
    if (typeof path !== 'string' || !path.startsWith('./api/')) {
      return new Response(JSON.stringify({ error: 'invalid API path' }), { status: 400, contentType: 'application/json' });
    }
    const url = new URL(path, 'http://localhost/');
    const rawPath = path.slice(1).split('?', 1)[0];
    const activeConversation = typeof conversationId === 'string' && conversationId
      ? conversationId : app.config.conversationId || null;
    const result = await dispatchPageApi({
      method: body === undefined ? 'GET' : 'POST', url, rawPath, readBody: () => body,
    }, {
      ...options,
      conversationId: activeConversation,
      ...(Array.isArray(workspaceUris) && workspaceUris.length
        ? { workspaceRoots: workspaceUris.map(workspacePath).filter(Boolean) } : {}),
    });
    return new Response(typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
      status: result.status, contentType: result.type, headers: noStore,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: error.status || 500, contentType: 'application/json', headers: noStore,
    });
  }
});
const server = await app.run();
server.once('close', () => { void appServer.stop(); });
warmPageTelemetry(options);

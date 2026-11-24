import { existsSync } from 'node:fs';
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

const { SidecarApp, Response } = await import('sidecar_sdk').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("'sidecar_sdk'")) throw error;
  return import(pathToFileURL(join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs')));
});

if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN) {
  throw new Error('GemPT Live requires ANTIGRAVITY_SIDECAR_UI_TOKEN.');
}
const app = new SidecarApp();
const appServer = createAppServerManager({ observeOnly: true });
const options = { appServer };
const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

app.page('/', async () => {
  const { data, type } = await readPageAsset('/');
  const html = data.toString('utf8')
    .replace(/(<link rel="stylesheet")/, '<script src="/preload.js"></script>\n  $1');
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

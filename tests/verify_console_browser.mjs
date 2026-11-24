// Run from the repo root after npm run build:mcp-app. Requires Chrome and the Antigravity Sidecar SDK.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveAppServerSocket } from './app-server-fixture.mjs';
import { handleTool } from '../core/mcp-server.mjs';
import { updateHostContext } from '../core/host-context.mjs';
import { runDirectory, saveRun } from '../core/runs.mjs';
import { resolvePath } from '../core/state.mjs';
import { startServer } from '../magpie_plugin/lib/server.mjs';

const output = process.env.GEMPT_VERIFY_DIR || '/tmp/gempt-v060-verify';
const root = mkdtempSync(join(tmpdir(), 'gempt-verify-'));
const configPath = join(root, 'config.json');
const sessionsDir = join(root, 'sessions');
const magpieConfigDir = join(root, 'magpie');
const brainDir = join(root, 'brain');
const cwd = join(root, 'Web Console');
const host = 'phase3-console-fixture';
const runId = 'a'.repeat(32);
const sessionId = 'exec-console-verification';
const runPath = runDirectory(runId, sessionsDir);
const stamp = (minutes = 0) => new Date(Date.now() - minutes * 60_000).toISOString();
const model = 'codex/gpt-6.2-sol';
const themeTokens = {
  dark: ['#17181b', '#202126', '#282a30', '#ebedf3', '#adb3bf', '#8c94a3', '#353842', '#2a2c33'],
  light: ['#fdfdff', '#ffffff', '#f1f3f7', '#202633', '#555e70', '#626d80', '#cdd3df', '#e7eaf0'],
};
const tokenKeys = ['background-primary', 'background-secondary', 'background-tertiary', 'text-primary',
  'text-secondary', 'text-tertiary', 'border-primary', 'border-secondary'];
const calls = [];
const requests = [];
let consoleServer, chrome, ws, sidecarChild, sidecarOrigin;
let gatewayDelay = 0;
const sidecarWorkspace = join(root, 'Sidecar workspace');
const sidecarRunId = 'b'.repeat(32);
const sidecarToken = 'browser-fixture-token';
const sidecarPrefix = '/sidecar/gempt/gempt_live';
const magpiePrefix = '/magpie/gempt';
const sidecarRequests = [];
let authorizeSidecarAtGateway = false;
let sidecarFailure;
let blockedSidecarScript = false;
const controlPackets = [];
const controlSockets = new Set();
const codexToken = 'browser-codex-fixture';
const appHtml = readFileSync(new URL('../core/assets/mcp_app_live.html', import.meta.url));
const priorRunId = 'd'.repeat(32);
const appPath = join(root, 'app-server.json');
const env = { ...process.env, GEMPT_CONFIG: configPath, GEMPT_SESSIONS_DIR: sessionsDir,
  MAGPIE_CONFIG_DIR: magpieConfigDir, GEMPT_APP_SERVER_STATE: appPath, GEMPT_AGY_BRAIN_DIR: brainDir };
process.env.GEMPT_AGY_BRAIN_DIR = brainDir;

function hostHtml(theme) {
  const variables = Object.fromEntries(tokenKeys.map((key, i) => ['--color-' + key, themeTokens[theme][i]]));
  const context = { theme, styles: { variables }, displayMode: 'inline' };
  return `<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0;background:${variables['--color-background-primary']}">
  <iframe id="app" src="/app" sandbox="allow-scripts allow-downloads" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>
  <script>
  const frame = document.getElementById('app');
  addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    const { id, method, params } = event.data;
    if (method === 'ui/notifications/initialized') {
      const toolResult = await fetch('/tool', { method: 'POST', body: JSON.stringify({ name:'gpt_ctl', arguments:{} }) }).then(r => r.json());
      if (toolResult.isError || !Array.isArray(toolResult.structuredContent?.runs)) throw new Error('gpt_ctl failed to open GemPT');
      frame.contentWindow.postMessage({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:toolResult }, '*');
    }
    if (id == null) return;
    let result = {};
    if (method === 'ui/initialize') result = {
      protocolVersion: params.protocolVersion, hostInfo:{name:'AGY fixture',version:'1'},
      hostCapabilities:{ serverTools:{}, message:{text:{}}, updateModelContext:{text:{}} },
      hostContext:${JSON.stringify(context)}
    };
    if (method === 'tools/call') result = await fetch('/tool', { method:'POST', body:JSON.stringify(params) }).then(r => r.json());
    frame.contentWindow.postMessage({ jsonrpc:'2.0', id, result }, '*');
  });
  </script></body></html>`;
}

const backend = createServer(async (req, res) => {
  const incoming = new URL(req.url, 'http://' + req.headers.host);
  for (const [prefix, origin] of [
    [sidecarPrefix, sidecarOrigin],
    [magpiePrefix, consoleServer && `http://127.0.0.1:${consoleServer.port}`],
  ]) {
    if (!origin || (incoming.pathname !== prefix && !incoming.pathname.startsWith(prefix + '/'))) continue;
    const path = (incoming.pathname.slice(prefix.length) || '/') + incoming.search;
    const headers = { ...req.headers, host: new URL(origin).host };
    if (headers.origin === incoming.origin) headers.origin = origin;
    if (prefix === sidecarPrefix && /^\/(gempt-preload\.js|styles\.css|app\.js)$/.test(path.split('?')[0])) {
      if (blockedSidecarScript && path.startsWith('/app.js')) return res.writeHead(404).end('missing script');
      if (!authorizeSidecarAtGateway && incoming.searchParams.get('token') !== sidecarToken) {
        return res.writeHead(401).end('unauthorized');
      }
    }
    if (prefix === sidecarPrefix && path === '/api') {
      if (sidecarFailure) {
        return res.writeHead(sidecarFailure, { 'content-type': 'application/json' }).end('{}');
      }
      if (authorizeSidecarAtGateway) headers['x-sidecar-token'] = sidecarToken;
    }
    const proxy = request(origin + path, { method: req.method, headers }, (upstream) => {
      if (prefix === sidecarPrefix) {
        sidecarRequests.push({ publicPath: incoming.pathname, path, method: req.method, authenticated: headers['x-sidecar-token'] === sidecarToken,
          status: upstream.statusCode });
      }
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on('error', (error) => { res.writeHead(502).end(error.message); });
    return req.pipe(proxy);
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') {
    if (gatewayDelay) await sleep(gatewayDelay);
    return res.end(JSON.stringify({ data: [model, 'codex/gpt-6.2-astra', 'gemini/gemini-4-neon-high', 'openai/gpt-5.4'].map(id => ({ id })) }));
  }
  if (req.url === '/app') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(appHtml);
  }
  if (req.url === '/tool') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { name, arguments: args } = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ name, args });
    try {
      return res.end(JSON.stringify(await handleTool(name, args, env, { configPath, sessionsDir, magpieConfigDir })));
    } catch (error) {
      return res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: error.message }] }));
    }
  }
  if (incoming.pathname === '/native-host' && sidecarOrigin) {
    const bare = incoming.searchParams.has('bare');
    const opaque = incoming.searchParams.has('opaque');
    const noWorkspace = incoming.searchParams.has('no-workspace');
    const path = bare ? '' : incoming.searchParams.has('index') ? '/index.html' : '/';
    const light = incoming.searchParams.get('theme') === 'light';
    const src = sidecarPrefix + path + '?theme=' + (light ? 'light' : 'dark')
      + (incoming.searchParams.has('tokenless') ? '' : '&amp;token=' + sidecarToken)
      + (incoming.searchParams.has('tokenless') ? '' : '&amp;conversationId=' + host)
      + (bare ? '#live/' + runId : '');
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><link rel="icon" href="data:,"><iframe id="sidecar" src="${src}" ${opaque ? 'sandbox="allow-scripts"' : ''} style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>
      <script>
      const frame = document.getElementById('sidecar');
      window.addEventListener('message', (event) => {
        if (event.source === frame.contentWindow && event.data?.type === 'toggle-aux-pane') window.lastPreview = event.data.payload;
      });
      window.setWorkspace = (workspaceUris) => frame.contentWindow.postMessage({ type: 'workspace-change', payload: { workspaceUris } }, '*');
      frame.onload = () => {
        frame.contentWindow.postMessage({ type: 'theme-change', payload: { cssVariables: {
          '--background':'${light ? '#fdfdff' : '#17181b'}', '--foreground':'${light ? '#202633' : '#ebedf3'}',
          '--card':'${light ? '#ffffff' : '#202126'}', '--muted-foreground':'${light ? '#555e70' : '#adb3bf'}',
          '--border':'${light ? '#cdd3df' : '#353842'}', '--primary':'${light ? '#2057a8' : '#92b9fb'}'
        } } }, '*');
        ${noWorkspace ? '' : `setWorkspace([${JSON.stringify(pathToFileURL(cwd).href)}]);`}
      };
      </script>`);
  }
  if (incoming.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(hostHtml(incoming.searchParams.get('theme') || 'dark'));
  }
  res.writeHead(404).end('Not found');
});

backend.on('upgrade', (req, socket) => {
  assert.equal(req.url, '/codex');
  assert.equal(req.headers.authorization, 'Bearer ' + codexToken);
  controlSockets.add(socket);
  socket.on('close', () => controlSockets.delete(socket));
  serveAppServerSocket(req, socket, ({ id, method, params }, send) => {
    if (method === 'initialized') return;
    if (method !== 'initialize') controlPackets.push({ method, params });
    send({ id, result: {} });
  });
});

function seed(url) {
  const brain = join(brainDir, host, '.system_generated', 'logs');
  for (const path of [sessionsDir, magpieConfigDir, cwd, brain, output]) mkdirSync(path, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    version: 1, magpie: { base_url: url }, ui: { language: 'zh' },
    codex: { default_sandbox: 'workspace-write', timeout_sec: 3600 },
    routing_policy: { work_split: 'gpt_first', swarm_split: 'inherit', native_swarm: true, mcp_effort: 'high' },
    tiers: { sonnet: { consult_model: model, exec_model: model, reasoning_effort: 'medium' },
      opus: { consult_model: model, exec_model: model, reasoning_effort: 'high' } },
  }));
  writeFileSync(appPath, JSON.stringify({ status: 'running', pid: process.pid,
    ws_url: url.replace('http:', 'ws:') + '/codex', auth_header: 'Authorization', auth_token: codexToken, gateway_url: url }));
  const records = [];
  const titles = ['控制台路由回归检查', '分析会话统计的来源', '请求时间范围与分页', '核对模型配对', '修复任务列表焦点', '梳理重试与终态', '只读审查工作区'];
  for (const [i, title] of titles.entries()) {
    const id = i === 0 ? sessionId : `${i % 2 ? 'consult' : 'exec'}-console-${i}`;
    const timestamp = stamp(22 + i * 97);
    const usage = { input_tokens: 26_700 - i * 1700, output_tokens: 2900 - i * 160, cached_input_tokens: 9000 - i * 850 };
    writeFileSync(join(sessionsDir, id + '.json'), JSON.stringify({
      session_id: id, host_conversation_id: host, mode: id.startsWith('consult') ? 'consult' : 'exec',
      cwd, title, model, tier: i % 2 ? 'sonnet' : 'opus', agent: 'gemini-4-neon-high', created_at: timestamp, updated_at: timestamp,
      turns: [{ role: 'user', content: title }, { role: 'assistant', content: '已核对请求记录与会话统计。' }],
      turn_details: { 1: { timestamp, title, goal: title, model, elapsed_sec: 18 + i * 16, usage } },
    }));
    records.push(JSON.stringify({ req: model, served: model, provider: 'codex', account: 'Subscription',
      status: 200, t: timestamp, session: id, in: usage.input_tokens, out: usage.output_tokens, cache_read: usage.cached_input_tokens }));
  }
  writeFileSync(join(magpieConfigDir, 'usage.jsonl'), records.join('\n') + '\n');
  writeFileSync(join(brain, 'transcript.jsonl'), JSON.stringify({
    type: 'PLANNER_RESPONSE', created_at: stamp(8), model: 'gemini-4-neon-high',
    input_tokens: 55_000, output_tokens: 9000, tool_calls: [{ name: 'gpt_run' }],
  }) + '\n');

  const threadId = 'console-codex-thread';
  const turnId = 'verification-turn';
  const started = stamp(9);
  mkdirSync(join(cwd, 'worktree'));
  writeFileSync(join(cwd, 'worktree', 'note.md'), 'fixture note');
  const args = { question: '可以使用两个保留的旧会话重新验证迁移吗？', media_paths: ['note.md'],
    context: '共享控制台功能已接通，现有快照显示两条旧会话仍有待迁移的字段。' };
  saveRun(join(runPath, 'state.json'), {
    source: 'magpie_exec', run_id: runId, session_id: sessionId, title: '核对双端控制台与迁移',
    cwd: join(cwd, 'worktree'), worktree_path: join(cwd, 'worktree'), source_cwd: cwd,
    host_conversation_id: host, state: 'waiting_gemini', started_at: started,
    created_at: started, pid: process.pid, model, tier: 'opus', turn_id: turnId, codex_thread_id: threadId,
    deadline: Date.now() / 1000 + 3060, execution_timeout_sec: 3600,
    goal: '核对共享控制台、活动查看与在 Live 中直接回复。',
    pending_tool_call: { call_id: 'ask_1', tool: 'ask_gemini', requested_at: stamp(1), arguments: args },
    progress: { phase: 'waiting_gemini', last_message: '概览、请求与会话三处数据已核对。',
      recent_commands: [{ command: 'node --test tests/test_core_node.mjs', exit_code: 0 }],
      token_usage: { input_tokens: 27610, output_tokens: 2219, cached_input_tokens: 11012 } },
  });
  const events = [
    ['item/completed', { item: { type: 'commandExecution', id: 'test', command: 'node --test tests/test_core_node.mjs', exitCode: 0,
      aggregatedOutput: 'PASS · 全部回归检查通过' } }],
    ['item/completed', { item: { type: 'agentMessage', id: 'summary', text: '共享控制台已通过首轮检查。接下来验证旧会话迁移和暂停恢复。' } }],
    ['item/tool/call', { tool: 'ask_gemini', callId: 'ask_1', arguments: args }],
  ];
  saveRun(join(sessionsDir, 'runs', priorRunId, 'state.json'), {
    source: 'magpie_exec', run_id: priorRunId, session_id: sessionId, title: '较早轮次',
    cwd, host_conversation_id: host, state: 'finished', started_at: stamp(33), finished_at: stamp(29),
    created_at: stamp(33), model, tier: 'sonnet', result: { text: '之前一轮已完成。' },
  });
  writeFileSync(join(runPath, 'events.jsonl'), events.map(([method, params]) =>
    JSON.stringify({ method, params: { threadId, turnId, ...params } })).join('\n') + '\n');
}

async function until(predicate, description) {
  for (let n = 0; n < 120; n++) {
    const found = await predicate();
    if (found) return found;
    await sleep(100);
  }
  throw new Error('Browser condition timed out: ' + description);
}

try {
  const serverEntry = fileURLToPath(new URL('../core/mcp-server.mjs', import.meta.url));
  const { result: { tools } } = JSON.parse(execFileSync(process.execPath, [serverEntry], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8', env,
  }));
  assert.deepEqual(tools.filter(({ _meta }) => _meta?.['com.google.antigravity/ui']?.entrypoints?.length), []);
  assert.equal(tools.find(({ name }) => name === 'gpt_ctl')._meta.ui.resourceUri, 'ui://gempt/live.html');
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const url = 'http://127.0.0.1:' + backend.address().port;
  seed(url);
  await updateHostContext(host, [cwd], { configPath });
  consoleServer = await startServer({ port: 0, configPath, sessionsDir, magpieConfigDir,
    antigravityPluginDir: join(root, 'client plugins', 'gempt'), agyBinDir: join(root, 'commands with spaces'),
    manageAppServer: true, appServerOptions: { env, isPidAlive: (pid) => pid === process.pid, connect: async () => ({ close() {} }) } });
  const standaloneUrl = `http://127.0.0.1:${consoleServer.port}/?theme=dark`;
  consoleServer.server.on('request', (req) => requests.push(req.url));

  const sdk = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk');
  assert.ok(existsSync(join(sdk, 'index.mjs')), 'The Antigravity Sidecar SDK is required for the native gateway regression');
  {
    const agentApi = join(root, 'agentapi-fixture');
    writeFileSync(agentApi, `#!/usr/bin/env node
const [subcommand, action, id] = process.argv.slice(2);
if (subcommand !== 'agentapi' || action !== 'get-conversation-metadata' || id !== ${JSON.stringify(host)}) process.exit(1);
console.log(JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: 'browser-project' } } } }));
`, { mode: 0o755 });
    // Launch the source sidecar without --import to exercise its installed SDK lookup.
    const entry = fileURLToPath(new URL('../plugin/sidecars/gempt_live/main.mjs', import.meta.url));
    sidecarChild = spawn(process.execPath, [entry], { cwd: dirname(entry), env: { ...env,
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:0', ANTIGRAVITY_CSRF_TOKEN: 'fixture', ANTIGRAVITY_CONVERSATION_ID: host,
      ANTIGRAVITY_AGENTAPI_EXE: agentApi,
      ANTIGRAVITY_SIDECAR_WEB_PORT: '0', ANTIGRAVITY_SIDECAR_UI_TOKEN: sidecarToken }, stdio: ['ignore', 'pipe', 'inherit'] });
    const [line] = await once(createInterface({ input: sidecarChild.stdout }), 'line', { signal: AbortSignal.timeout(5000) });
    sidecarOrigin = 'http://' + line.match(/listening on (127[.]0[.]0[.]1:[0-9]+)/)[1];
  }

  chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-site-isolation-trials', '--remote-debugging-port=0', '--user-data-dir=' + join(root, 'chrome'), 'about:blank'],
  { stdio: 'ignore' });
  const exited = once(chrome, 'exit');
  const port = await until(() => {
    try { return readFileSync(join(root, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { return null; }
  }, 'Chrome DevTools port');
  const [tab] = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await once(ws, 'open');

  const errors = [];
  const external = [];
  const notFound = [];
  const contexts = new Map();
  const responses = new Map();
  let num = 0;
  ws.addEventListener('message', ({ data }) => {
    const { id, method, params, result, error } = JSON.parse(data);
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) {
      contexts.set(params.context.auxData.frameId, params.context.id);
    } else if (method === 'Runtime.executionContextsCleared') contexts.clear();
    else if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
    else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args.map(arg => arg.value).join(' '));
    else if (method === 'Log.entryAdded' && params.entry.level === 'error') errors.push(params.entry.text);
    else if (method === 'Network.responseReceived' && params.response.status === 404) notFound.push(params.response.url);
    else if (method === 'Network.requestWillBeSent' && /^https?:/.test(params.request.url)
      && ![url, new URL(standaloneUrl).origin].includes(new URL(params.request.url).origin)) external.push(params.request.url);
    const pair = responses.get(id);
    if (pair) {
      responses.delete(id);
      if (error) pair.reject(new Error(error.message));
      else pair.resolve(result);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    responses.set(++num, { resolve, reject });
    ws.send(JSON.stringify({ id: num, method, params }));
  });
  await Promise.all(['Runtime.enable', 'Page.enable', 'Log.enable', 'Network.enable'].map(method => cdp(method)));
  const downloads = join(root, 'downloads');
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  let contextId;
  const evaluate = async (body) => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
      expression: `(() => { const $ = id => document.getElementById(id); ${body} })()`,
      contextId, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(result?.description || exceptionDetails.text);
    return result.value;
  };
  async function open(target, width, height, embedded) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: target });
    contextId = await until(async () => {
      const { frameTree } = await cdp('Page.getFrameTree');
      const native = new URL(target).pathname === '/native-host';
      const frame = embedded ? frameTree.childFrames?.find(({ frame }) => native
        ? frame.url.startsWith(url + sidecarPrefix)
        : frame.url === url + '/app')?.frame : frameTree.frame;
      return frame && contexts.get(frame.id);
    }, target);
  }
  async function assertGeometry(name) {
    const overflow = await evaluate(`return [document.documentElement, document.body, $('view-console'), $('live-panel')]
      .filter(el => el && !el.hidden).map(el => [el.id || el.tagName, el.scrollWidth, el.clientWidth]);`);
    const outside = overflow.some(([, scroll, client]) => scroll > client) ? await evaluate(
      "return [...document.body.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => [el.id || el.className || el.tagName, Math.round(el.getBoundingClientRect().right)]).slice(0, 18);") : [];
    for (const [id, scroll, client] of overflow) assert.ok(scroll <= client, `${name} ${id} overflows ${scroll} > ${client} ${JSON.stringify(outside)}`);
  }
  async function assertTopbar(name) {
    const boxes = await evaluate(`return [...document.querySelectorAll('.app-topbar .app-brand, .app-topbar button, #magpie-status')]
      .map(el => [el.id || 'brand', el.getBoundingClientRect().toJSON()]);`);
    for (const [index, [id, box]] of boxes.entries()) {
      assert.ok(box.width > 0, name + ' hides ' + id);
      assert.ok(box.left >= 0 && box.right <= await evaluate('return innerWidth;'), name + ' clips ' + id);
      if (index) assert.ok(box.left >= boxes[index - 1][1].right, name + ' overlaps ' + id);
    }
  }
  async function shot(name) {
    await assertGeometry(name);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const png = Buffer.from(data, 'base64');
    const dimensions = await evaluate('return [innerWidth, innerHeight];');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], dimensions);
    writeFileSync(join(output, name + '.png'), png);
  }
  const activityCount = () => calls.filter(({ name }) => name === 'gempt_app_console_activity').length;
  const click = (id) => evaluate(`$(${JSON.stringify(id)}).click();`);
  const selected = (selector) => evaluate(`return document.querySelector(${JSON.stringify(selector)})?.value;`);
  async function overview(theme, width, screenshot) {
    const before = activityCount();
    await open(`${url}/?theme=${theme}`, width, 900, true);
    await until(() => evaluate(`return document.querySelector('.session-card[data-run-id="${runId}"]')?.dataset.runId;`), 'Live on launch');
    assert.equal(await evaluate("return $('tab-live').getAttribute('aria-selected');"), 'true');
    await click('tab-overview');
    await until(() => evaluate(`return !$('view-console')?.hidden && !$('token-ratio-card')?.hidden
      && $('magpie-status')?.dataset.state === 'online' && !!$('active-run-list')?.children.length;`), 'shared Overview state');
    assert.equal(await evaluate('try { void localStorage; return false; } catch { return true; }'), true);
    assert.equal(await evaluate("return getComputedStyle($('view-console')).getPropertyValue('--gp-bg').trim();"), themeTokens[theme][0]);
    assert.equal(await selected('[name="native_swarm"]:checked'), 'true');
    assert.equal(await selected('#swarm-shell-model'), 'gemini-4-hydrogen-low');
    assert.equal(await evaluate("return document.querySelector('[name=\"failover_mode\"]') === null;"), true);
    assert.deepEqual(await evaluate(`return [...document.querySelector('[name="pair-hydrogen"]').options]
      .filter(option => option.value !== 'default').map(option => [option.value, option.text]);`),
      [model, 'codex/gpt-6.2-astra', 'gemini/gemini-4-neon-high', 'openai/gpt-5.4'].map(id => [id, id]));
    assert.equal(await selected('#codex-timeout'), '3600');
    assert.match(await evaluate("return $('routing-badge').textContent;"), /^80% · Swarm$/);
    assert.ok(Number.parseFloat(await evaluate("return $('token-ratio-gpt-bar').style.width;")) > 0);
    assert.equal(activityCount(), before);
    await assertGeometry(screenshot);
    if (width < 500) {
      await click('routing-badge');
      assert.equal(await evaluate("return document.activeElement.id;"), 'work-controls');
    }
    if (screenshot) await shot(screenshot);
  }

  await overview('dark', 1280, 'agy-console-dark-wide');
  const overviewCalls = calls.filter(({ name }) => name === 'gempt_app_console_state').length;
  const activeCalls = calls.filter(({ name }) => name === 'gempt_app_active_runs').length;
  await sleep(3000);
  assert.equal(activityCount(), 0, 'Overview refresh must never call activity');
  assert.equal(calls.filter(({ name }) => name === 'gempt_app_console_state').length, overviewCalls);
  assert.ok(calls.filter(({ name }) => name === 'gempt_app_active_runs').length > activeCalls);
  await click('tab-sessions');
  await until(() => evaluate("return document.querySelector('#sessions [data-activity-id]')?.dataset.activityId;"), 'session ledger');
  await shot('agy-console-sessions-dark');
  await evaluate(`const filter = document.querySelector('#sessions [data-filter="mode"]');
    filter.value = 'consult'; filter.dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(() => calls.some(({ name, args }) => name === 'gempt_app_console_activity'
    && args.kind === 'sessions' && args.query?.mode === 'consult'), 'session mode filter');
  await until(() => evaluate("return document.querySelector('#sessions [data-activity-id]')?.dataset.activityId.startsWith('consult-');"), 'consult-only sessions');
  await evaluate("document.querySelector('#sessions [data-activity-id]').click();");
  await until(() => evaluate("return !!document.querySelector('#sessions-detail .activity-detail-head');"), 'session detail');
  await click('tab-requests');
  await until(() => evaluate("return !!document.querySelector('#requests tbody [data-activity-id]');"), 'request ledger');
  await evaluate(`const search = document.querySelector('#requests .activity-search');
    search.value = '模型配对'; search.dispatchEvent(new Event('input', { bubbles: true }));`);
  await until(() => evaluate("return document.querySelectorAll('#requests tbody [data-activity-id]').length === 1;"), 'request search');
  await evaluate("document.querySelector('[data-export-csv]').click();");
  await until(() => {
    try { return readFileSync(join(downloads, 'gempt-requests.csv'), 'utf8').includes('模型配对'); } catch { return false; }
  }, 'authentic CSV download in MCP App');
  await click('tab-overview');
  const activityAfterClose = activityCount();
  await sleep(3100);
  assert.equal(activityCount(), activityAfterClose);
  await click('tab-live');
  await until(() => evaluate(`return !$('live-panel').hidden && !!document.querySelector('.session-card[data-run-id="${runId}"]');`), 'return to Live');

  await overview('dark', 460, 'agy-console-dark-narrow');
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { value: undefined });
    document.execCommand = () => false; $('copy-mcp-btn').click();`);
  await until(() => evaluate("return $('console-copy-dialog').open && $('console-copy-text').value.includes('mcpServers');"), 'manual clipboard fallback');
  await click('console-copy-close');
  await evaluate("document.querySelector('[data-ratio-range=\"7d\"]').click();");
  await until(() => evaluate("return $('token-ratio-title').textContent.includes('7 天');"), 'token ratio preset');
  await evaluate("$('advanced-settings').open = true; document.querySelector('[data-timeout=\"1800\"]').click();");
  await until(() => evaluate("return document.querySelector('[data-timeout=\"1800\"]').getAttribute('aria-pressed') === 'true';"), 'saved timeout preset');
  await evaluate("const field = $('codex-timeout'); field.value = '2400'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));");
  await until(() => JSON.parse(readFileSync(configPath)).codex.timeout_sec === 2400, 'manual timeout saved in opaque iframe');
  await click('dispatch-direct');
  await until(() => evaluate("return $('routing-badge').textContent === '80% · 直调';"), 'Swarm toggle');
  await evaluate(`const model = $('swarm-shell-model'); model.value = 'gemini-3.8-flash-low';
    model.dispatchEvent(new Event('change',{bubbles:true}));`);
  await until(() => {
    const policy = JSON.parse(readFileSync(configPath)).routing_policy;
    return policy.native_swarm === false && policy.swarm_shell_model === 'gemini-3.8-flash-low';
  }, 'persisted AGY Swarm settings');
  await until(() => evaluate("return !$('swarm-shell-model').disabled;"), 'model update completed');
  assert.equal(JSON.parse(readFileSync(configPath)).codex.timeout_sec, 2400);
  // Restore fixture defaults through the auth-independent application tool.
  const saved = await handleTool('gempt_app_console_settings', { native_swarm: true,
    swarm_shell_model: 'gemini-4-hydrogen-low', codex_timeout_sec: 3600 }, env, { configPath, sessionsDir, magpieConfigDir });
  assert.equal(saved.structuredContent.codex_timeout_sec, 3600);
  await overview('light', 1280, 'agy-console-light-wide');
  await overview('light', 390, 'agy-console-light-narrow');
  await overview('dark', 1440, 'agy-console-dark-1440');

  const beforeLive = activityCount();
  const beforeLaunch = calls.length;
  await open(url + '/?theme=dark', 1280, 820, true);
  await until(() => evaluate(`return document.querySelector('.session-card[data-run-id="${runId}"]')?.dataset.runId;`), 'Live run');
  await until(() => calls.slice(beforeLaunch).some(({ name }) => name === 'gempt_app_magpie_status'), 'first gateway probe');
  assert.deepEqual([...new Set(calls.slice(beforeLaunch).map(({ name }) => name))].sort(),
    ['gempt_app_magpie_status', 'gempt_app_runs', 'gempt_app_summary', 'gpt_ctl']);
  assert.equal(await evaluate("return $('tab-live').getAttribute('aria-selected');"), 'true');
  assert.equal(await evaluate("return document.querySelectorAll('.app-topbar [role=tab]').length;"), 4);
  await evaluate(`document.querySelector('.session-card[data-run-id="${runId}"]').click();`);
  await until(() => evaluate("return !$('ask')?.hidden && !$('reply-form')?.hidden && $('ask-question')?.textContent.includes('旧会话');"), 'direct reply');
  assert.equal(await evaluate("return $('detail-worktree').hidden;"), false);
  assert.equal(await evaluate("return $('routing-badge').textContent;"), '80% · Swarm');
  await shot('agy-live-dark');
  await evaluate("$('reply-message').value = '可以，保留原始备份。'; $('reply-message').dispatchEvent(new Event('input')); $('send-reply').click();");
  await until(() => evaluate("return $('reply-status')?.textContent === '已发送回复。';"), 'direct reply submitted');
  assert.equal(JSON.parse(readFileSync(join(runPath, 'tool_replies', 'ask_1.json'))).answer, '可以，保留原始备份。');
  await sleep(2800);
  assert.equal(activityCount(), beforeLive);
  await open(url + '/?theme=light', 460, 820, true);
  await until(() => evaluate(`return document.querySelector('.session-card[data-run-id="${runId}"]')?.dataset.runId;`), 'light Live run');
  await evaluate(`document.querySelector('.session-card[data-run-id="${runId}"]').click();`);
  await until(() => evaluate("return !$('ask')?.hidden && !$('reply-form')?.hidden;"), 'light Live reply card');
  await shot('agy-live-light-narrow');
  await click('info-toggle');
  await click('open-run-session');
  await until(() => evaluate("return !!document.querySelector('#sessions-detail .activity-detail-head');"), 'AGY Live to Session');
  await evaluate(`document.querySelector('#sessions-detail a[href="#live/${priorRunId}"]').click();`);
  await until(() => evaluate("return $('detail-title').textContent === '较早轮次';"), 'AGY Session to the exact older run');

  gatewayDelay = 400;
  await open(standaloneUrl, 1280, 900, false);
  await until(() => evaluate("return $('magpie-status')?.dataset.state === 'online' && !$('token-ratio-card')?.hidden;"), 'authenticated Magpie Overview')
    .catch((error) => { throw new Error(`${error.message} · ${JSON.stringify({ requests, errors })}`); });
  gatewayDelay = 0;
  assert.equal(requests.filter(path => path === '/api/overview').length, 1, 'gateway status patches the existing overview');
  assert.equal(requests.filter(path => path === '/api/magpie-status').length, 1, 'the status poll waits for the first probe');
  await shot('magpie-standalone-dark');
  await evaluate("$('agy-setup').open = true;");
  assert.equal(await evaluate("return $('agy-target').textContent;"), resolvePath(join(root, 'client plugins', 'gempt')));
  assert.equal(await evaluate("return $('agy-bin').textContent;"), resolvePath(join(root, 'commands with spaces')));
  await evaluate("$('agy-install').scrollIntoView({block:'center'});");
  await shot('magpie-enable-antigravity');
  await click('agy-install');
  await until(() => evaluate("return $('agy-setup').hidden && !!$('agy-install-result').textContent;"), 'bundled integration installed');
  assert.equal(JSON.parse(readFileSync(join(root, 'client plugins', 'gempt', 'plugin.json'))).name, 'gempt');
  assert.equal(requests.some(path => /^\/api\/(sessions|requests)/.test(path)), false);
  await evaluate("document.querySelector('[data-timeout=\"7200\"]').click();");
  await until(() => evaluate("return document.querySelector('[data-timeout=\"7200\"]').getAttribute('aria-pressed') === 'true';"), 'Magpie timeout update over HTTP');
  assert.equal(JSON.parse(readFileSync(configPath)).codex.timeout_sec, 7200);
  assert.ok(requests.some(path => path === '/api/settings'));
  await evaluate(`document.querySelector('#active-run-list [data-run-id="${runId}"] [data-run-action="detail"]').click();`);
  await until(() => evaluate("return !$('ask').hidden && $('turn-strip').children.length === 2;"), 'Magpie Overview to Live');
  await shot('magpie-live-dark-wide');
  await click(`turn-${priorRunId}`);
  await until(() => evaluate("return $('detail-title').textContent === '较早轮次';"), 'Magpie turn switching');
  await click('info-toggle');
  await click('open-run-requests');
  await until(() => evaluate("return !!document.querySelector('#requests-detail .activity-detail-head');"), 'Magpie Live to exact Request');
  assert.equal(await evaluate('return location.hash;'), '#requests/run-' + priorRunId);
  await evaluate("history.back();");
  await until(() => evaluate("return !$('live-panel').hidden && $('detail-title').textContent === '较早轮次';"), 'Magpie back to prior run');
  await click('tab-overview');
  await until(() => evaluate("return !!document.querySelector('#activity-list button.recent-text');"), 'linked recent activity');
  await evaluate("document.querySelector('#activity-list button.recent-text').click();");
  await until(() => evaluate("return !$('live-panel').hidden && !$('detail-bar').hidden;"), 'Magpie recent activity to Live');
  await click('tab-sessions');
  await until(() => evaluate("return !!document.querySelector('#sessions [data-activity-id]');"), 'Magpie session ledger');
  await evaluate(`document.querySelector('#sessions [data-activity-id="${sessionId}"]').parentElement.querySelector('.activity-link').click();`);
  await until(() => evaluate("return !$('live-panel').hidden && !$('detail-bar').hidden;"), 'Magpie session list to Live');
  rmSync(join(runPath, 'tool_replies', 'ask_1.json'));
  await open(standaloneUrl + '#live/' + runId, 360, 820, false);
  await until(() => evaluate("return !$('ask').hidden;"), 'Magpie hash restores Live detail');
  assert.equal(await evaluate("return getComputedStyle($('toast')).bottom;"), '65px');
  await shot('magpie-live-dark-360');
  await evaluate("$('reply-message').value = 'HTTP 可以继续。'; $('reply-message').dispatchEvent(new Event('input')); $('send-reply').click();");
  await until(() => evaluate("return $('reply-status').textContent === '已发送回复。';"), 'Magpie Live reply over HTTP');
  assert.equal(JSON.parse(readFileSync(join(runPath, 'tool_replies', 'ask_1.json'))).answer, 'HTTP 可以继续。');
  assert.ok(requests.some(path => path.startsWith('/api/sessions?')));
  {
    mkdirSync(sidecarWorkspace);
    saveRun(join(runDirectory(sidecarRunId, sessionsDir), 'state.json'), {
      run_id: sidecarRunId, session_id: 'exec-other-workspace', title: '另一个工作区',
      state: 'finished', cwd: sidecarWorkspace, host_conversation_id: host, created_at: stamp(),
    });
    await open(url + '/native-host', 460, 820, true);
    await until(() => evaluate(`return !!document.querySelector('.session-card[data-run-id="${runId}"]');`), 'native Live starts in the active conversation and project');
    assert.equal(await evaluate("return $('tab-live').getAttribute('aria-selected');"), 'true');
    assert.equal(await evaluate('return window.sidecar.conversationId;'), host);
    assert.equal(await evaluate("return getComputedStyle(document.body).backgroundColor;"), 'rgb(23, 24, 27)');
    assert.equal(await evaluate(`return !!document.querySelector('.session-card[data-run-id="${sidecarRunId}"]');`), false);
    await shot('agy-native-live-dark');
    const { frameTree } = await cdp('Page.getFrameTree');
    const hostContextId = contexts.get(frameTree.frame.id);
    await evaluate(`document.querySelector('.session-card[data-run-id="${runId}"]').click();`);
    await until(() => evaluate("return !!document.querySelector('#ask-media button.file-chip');"), 'native workspace file chip');
    await evaluate("document.querySelector('#ask-media button.file-chip').click();");
    const preview = async () => (await cdp('Runtime.evaluate', { contextId: hostContextId,
      expression: 'window.lastPreview', returnByValue: true })).result.value;
    const expectedPreview = { tabType: 'fileView', uri: pathToFileURL(join(cwd, 'worktree', 'note.md')).href };
    await until(async () => (await preview())?.uri === expectedPreview.uri, 'native file preview event').catch(async (error) => {
      const state = await evaluate("return { toast: $('toast-message').textContent, chip: document.querySelector('#ask-media .file-chip').outerHTML };");
      throw new Error(`${error.message} · ${JSON.stringify({ expectedPreview, preview: await preview(), state })}`);
    });
    await evaluate("$('steer').value = 'Continue with the gateway check.'; $('steer').dispatchEvent(new Event('input')); $('send-steer').click();");
    await until(() => evaluate("return $('control-status').textContent === '已发送纠偏指令';"), 'native authenticated steer');
    await click('interrupt');
    assert.equal(await evaluate("return $('interrupt').textContent;"), '确认中止');
    await click('interrupt');
    await until(() => evaluate("return $('control-status').textContent === '已请求中止当前回合';"), 'native authenticated interrupt');
    assert.deepEqual(controlPackets, [
      { method: 'turn/steer', params: { threadId: 'console-codex-thread', expectedTurnId: 'verification-turn',
        input: [{ type: 'text', text: 'Continue with the gateway check.' }] } },
      { method: 'turn/interrupt', params: { threadId: 'console-codex-thread', turnId: 'verification-turn' } },
    ]);
    rmSync(join(runPath, 'tool_replies', 'ask_1.json'));
    await evaluate("$('reply-message').value = '可以通过侧栏继续。'; $('reply-message').dispatchEvent(new Event('input')); $('send-reply').click();");
    await until(() => evaluate("return $('reply-status').textContent === '已发送回复。';"), 'native authenticated reply');
    assert.equal(JSON.parse(readFileSync(join(runPath, 'tool_replies', 'ask_1.json'))).answer, '可以通过侧栏继续。');
    await click('tab-overview');
    await until(() => evaluate(`return $('view-console').classList.contains('gp-ready') && !$('token-ratio-card').hidden
      && $('magpie-status').dataset.state === 'online' && Number.parseFloat($('token-ratio-gpt-bar').style.width) > 0;`), 'native Console and token data');
    await evaluate("document.querySelector('[data-ratio-range=\"7d\"]').click();");
    await until(() => evaluate("return $('token-ratio-title').textContent.includes('7 天') && !$('token-ratio-card').hidden;"), 'native token range change');
    await evaluate("$('advanced-settings').open = true; document.querySelector('[data-timeout=\"1800\"]').click();");
    await until(() => evaluate("return document.querySelector('[data-timeout=\"1800\"]').getAttribute('aria-pressed') === 'true';"), 'native Settings via sidecar auth');
    assert.equal(JSON.parse(readFileSync(configPath)).codex.timeout_sec, 1800);
    await shot('agy-native-console-dark');
    for (const tab of ['requests', 'sessions']) {
      await click('tab-' + tab);
      await until(() => evaluate(`return !!document.querySelector('#${tab} [data-activity-id]');`), 'native ' + tab);
      await evaluate(`document.querySelector('#${tab} [data-activity-id]').click();`);
      await until(() => evaluate(`return !!document.querySelector('#${tab}-detail .activity-detail-head');`), 'native ' + tab + ' detail');
    }
    await cdp('Runtime.evaluate', { contextId: hostContextId,
      expression: `setWorkspace([${JSON.stringify(pathToFileURL(sidecarWorkspace).href)}])` });
    await click('tab-live');
    await until(() => evaluate(`return !!document.querySelector('.session-card[data-run-id="${sidecarRunId}"]');`), 'native workspace-change refresh');
    assert.equal(await evaluate(`return !!document.querySelector('.session-card[data-run-id="${runId}"]');`), false);


    const resize = (width, height) => cdp('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await open(url + '/native-host', 460, 1170, true);
    await click('tab-overview');
    await until(() => evaluate("return $('view-console').classList.contains('gp-ready') && $('gateway-url').value;"), 'settings initialized');
    assert.equal(await evaluate("return $('advanced-settings').open;"), false);
    await evaluate("document.querySelector('#advanced-settings summary').click();");
    assert.equal(await evaluate("return $('advanced-settings').open && $('tab-overview').textContent;"), '概览');

    const fill = (id, value) => evaluate(`const field = $(${JSON.stringify(id)});
      field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true }));`);
    await fill('gateway-url', url + '/');
    await fill('gateway-key', 'sidecar-draft-key-1234');
    await fill('gateway-key-env', 'GEMPT_BROWSER_TOKEN');
    await click('gateway-test');
    await until(() => evaluate("return $('gateway-result').textContent.includes('4 个模型');"), 'native unsaved gateway draft probe');
    assert.equal(JSON.parse(readFileSync(configPath)).magpie.api_key, undefined);
    await fill('utility-model', 'vendor/chore:fast');
    await fill('utility-effort', 'high');
    await fill('excluded-models', ' vendor/ignore, vendor/experimental ');
    await fill('consult-timeout', '240');
    await fill('codex-extra-args', '--strict-config --analytics-default-enabled');
    await click('advanced-save');
    await until(() => evaluate("return $('gateway-key').placeholder === '••••1234' && !$('gateway-key').value && $('advanced-save').disabled;"), 'native settings saved and key masked');
    const settings = JSON.parse(readFileSync(configPath));
    assert.equal(settings.magpie.base_url, url);
    assert.equal(settings.magpie.api_key, 'sidecar-draft-key-1234');
    assert.equal(settings.magpie.api_key_env, 'GEMPT_BROWSER_TOKEN');
    assert.deepEqual(settings.routing_policy.excluded_models, ['vendor/ignore', 'vendor/experimental']);
    assert.equal(settings.utility.model, 'vendor/chore:fast');
    assert.equal(settings.utility.reasoning_effort, 'high');
    assert.equal(settings.limits.consult_timeout_sec, 240);
    assert.deepEqual(settings.codex.extra_args, ['--strict-config', '--analytics-default-enabled']);

    await evaluate("const model = $('swarm-shell-model'); model.value = 'vendor/custom-shell:v2'; model.dispatchEvent(new Event('change', { bubbles: true }));");
    await until(() => JSON.parse(readFileSync(configPath)).routing_policy.swarm_shell_model === 'vendor/custom-shell:v2', 'native custom Swarm model');
    await until(() => evaluate("return !$('swarm-shell-model').disabled;"), 'native custom Swarm save settled');
    await click('advanced-reset');
    assert.equal(await evaluate("return !$('reset-confirm').hidden && $('reset-keep-gateway').checked;"), true);
    await click('reset-cancel');

    await click('gateway-test');
    await until(() => evaluate("return $('gateway-result').dataset.state === 'ok';"), 'native saved gateway probe');
    for (const language of ['zh', 'en']) {
      if (language === 'en') {
        await fill('utility-model', 'vendor/chore:draft');
        await click('language-toggle');
        await until(() => evaluate("return document.documentElement.lang === 'en' && !$('language-toggle').disabled;"), 'language switch persisted');
        assert.equal(await evaluate("return $('utility-model').value;"), 'vendor/chore:draft');
        await click('advanced-save');
        await until(async () => JSON.parse(readFileSync(configPath)).utility.model === 'vendor/chore:draft'
          && await evaluate("return !$('gateway-test').disabled;"), 'English settings save');
        await click('gateway-test');
        await until(() => evaluate("return $('gateway-result').textContent.includes('4 models');"), 'English probe result');
        assert.equal(await evaluate("return [...document.querySelectorAll('.app-tabs button')].map(x => x.textContent).join('|');"), 'Live|Overview|Requests|Sessions');
        assert.equal(await evaluate("return document.querySelector('#advanced-settings summary').textContent;"), 'Connection & Advanced Settings');
        assert.match(await evaluate("return $('work-detail').textContent;"), /GPT handles substantive tasks/);
      }
      for (const width of [420, 460]) {
        await resize(width, 1170);
        await assertGeometry(language + ' ' + width);
        await assertTopbar(language + ' ' + width);
      }
      await click('toast-dismiss');
      await evaluate("document.querySelector('#advanced-settings summary').scrollIntoView({ block: 'start' });");
      await shot('sidecar-' + language + '-overview-dark');
    }
    assert.equal(JSON.parse(readFileSync(configPath)).ui.language, 'en');
    await click('tab-requests');
    await until(() => evaluate("return !!document.querySelector('#requests [data-activity-id]');"), 'English native Requests');
    await click('tab-sessions');
    await until(() => evaluate("return !!document.querySelector('#sessions [data-activity-id]');"), 'English native Sessions');
    await open(url + '/native-host?theme=light', 460, 820, true);
    await until(() => evaluate("return document.documentElement.lang === 'en' && !!document.querySelector('.session-card');"), 'native English Live applies saved language');
    assert.equal(await evaluate("return document.documentElement.dataset.theme;"), 'light');
    await assertTopbar('English native Live light');
    await shot('sidecar-en-live-light');
    // Restore the fixture before the remaining lifecycle and authentication checks.
    const restored = await handleTool('gempt_app_console_settings', { ui: { language: 'zh' },
      magpie: { api_key: '', api_key_env: '' }, codex: { extra_args: [] } }, env, { configPath, sessionsDir, magpieConfigDir });
    assert.equal(restored.structuredContent.ui.language, 'zh');

    await open(url + '/native-host?bare', 460, 820, true);
    await until(() => evaluate("return $('detail-title').textContent === '核对双端控制台与迁移';"), 'native slashless entry and deep-linked run');
    assert.equal(await evaluate('return location.pathname + location.search + location.hash;'),
      sidecarPrefix + '/?theme=dark&token=' + sidecarToken + '&conversationId=' + host + '#live/' + runId);
    assert.ok(sidecarRequests.some(({ publicPath, status }) => publicPath === sidecarPrefix && status === 200),
      'gateway served the slashless HTML directly');
    for (const asset of ['gempt-preload.js', 'styles.css', 'app.js']) {
      assert.ok(sidecarRequests.some(({ path, method, status }) =>
        path === '/' + asset + '?token=' + sidecarToken && method === 'GET' && status === 200), asset);
    }
    const apiRequests = sidecarRequests.filter(({ path }) => path === '/api');
    assert.ok(apiRequests.length > 0 && apiRequests.every(({ method, authenticated, status }) =>
      method === 'POST' && authenticated && status === 200), 'native reads and mutations use authenticated POSTs');
    await open(url + '/native-host?no-workspace&index', 460, 820, true);
    await until(() => evaluate(`return $('list-loading').hidden && !$('routing-badge').disabled
      && !!document.querySelector('.session-card[data-run-id="${runId}"]');`), 'native startup without workspace metadata');
    assert.equal(await evaluate('return location.pathname;'), sidecarPrefix + '/index.html');
    const noWorkspaceFrame = (await cdp('Page.getFrameTree')).frameTree.frame;
    await cdp('Runtime.evaluate', { contextId: contexts.get(noWorkspaceFrame.id),
      expression: `setWorkspace([${JSON.stringify(pathToFileURL(sidecarWorkspace).href)}])` });
    await until(() => evaluate(`return !!document.querySelector('.session-card[data-run-id="${sidecarRunId}"]')
      && !document.querySelector('.session-card[data-run-id="${runId}"]');`), 'late first workspace narrows the run list');

    await open(url + '/native-host?opaque&no-workspace', 460, 820, true);
    await until(() => evaluate(`return self.origin === 'null' && !!window.sidecar && !$('routing-badge').disabled
      && !!document.querySelector('.session-card[data-run-id="${runId}"]');`), 'opaque native iframe starts with authenticated data');
    assert.ok(sidecarRequests.some(({ path, method, authenticated, status }) =>
      path === '/api?token=' + sidecarToken && method === 'POST' && !authenticated && status === 200));

    authorizeSidecarAtGateway = true;
    await open(url + '/native-host?tokenless&no-workspace', 460, 820, true);
    await until(() => evaluate(`return !$('routing-badge').disabled
      && !!document.querySelector('.session-card[data-run-id="${runId}"]');`), 'gateway-authenticated native iframe without a query token');
    authorizeSidecarAtGateway = false;
    assert.ok(!sidecarRequests.some(({ path }) => path === '/_sidecar/get-conversation-metadata'),
      'startup never invokes the SDK metadata subprocess');
  }

  await open(url + magpiePrefix + '/?theme=dark', 900, 820, false);
  await until(() => evaluate("return $('magpie-status')?.dataset.state === 'online' && !$('token-ratio-card')?.hidden;"), 'Magpie Console through a prefix');
  await evaluate("document.querySelector('[data-timeout=\"3600\"]').click();");
  await until(() => evaluate("return document.querySelector('[data-timeout=\"3600\"]').getAttribute('aria-pressed') === 'true';"), 'Magpie settings through a prefix');
  assert.equal(JSON.parse(readFileSync(configPath)).codex.timeout_sec, 3600);

  assert.deepEqual(notFound, [], 'Chrome received no 404 responses');
  assert.deepEqual(errors, [], 'Chrome console and uncaught errors');
  assert.deepEqual(external, [], 'No external asset or network requests');
  console.log('Chrome OK · Magpie HTTP, MCP App and native Sidecar · prefixed, slashless, index, opaque, gateway-authenticated and late-workspace startup · four tabs, details, token ratio, settings and controls · 0 HTTP 404s, 0 console errors');
  for (const status of [401, 404, 500]) {
    sidecarFailure = status;
    await open(url + '/native-host?no-workspace', 460, 820, true);
    await until(() => evaluate(`return $('list-loading').hidden && !$('list-error').hidden
      && $('list-error').textContent === 'HTTP ${status}';`), 'native error banner for HTTP ' + status);
  }
  sidecarFailure = undefined;
  blockedSidecarScript = true;
  await open(url + '/native-host', 460, 820, true);
  await until(() => evaluate(`return $('list-loading').hidden && !$('list-error').hidden
    && $('list-error').textContent.includes('脚本加载失败');`), 'native startup banner for missing script');
  console.log('Chrome OK · native HTTP 401, 404, 500 and a missing script replace skeletons with an error');
  chrome.kill();
  await exited;
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill();
    await exited.catch(() => {});
  }
  if (sidecarChild && sidecarChild.exitCode === null && sidecarChild.signalCode === null) {
    const exited = once(sidecarChild, 'exit');
    sidecarChild.kill();
    await exited;
  }
  await consoleServer?.close();
  for (const socket of controlSockets) socket.destroy();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

import { Worker } from 'node:worker_threads';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { buildMcpSnippet, findMagpieCli, listDispatchActivity, normalizeTitle, readActiveRuns, readState, setDefaultSandbox, setDefaultTier } from '../magpie_plugin/lib/backend.mjs';
import { createAppServerManager, resolveCodexInvocation } from '../magpie_plugin/lib/app-server-manager.mjs';
import { buildEscalationSuggestion } from '../magpie_plugin/lib/routing.mjs';
import { startServer } from '../magpie_plugin/lib/server.mjs';
import { createExecutionTools, createGemptTools } from '../magpie_plugin/lib/tools.mjs';
import { TOOLS } from '../core/mcp-server.mjs';
import { waitForRun } from '../core/runs.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('short titles prefer the explicit value and clean historical goals', () => {
  for (const [title, goal, cwd, expected] of [
    ['  侧栏\n绑定　与命名 ', 'ignored', 'C:\\work\\gempt', '侧栏 绑定 与命名'],
    [null, 'You are executing a task delegated by Gemini.\nRead carefully.\n\n# Goal\n'
      + '- 用户反馈：请在工作区 C:/work/gempt 中修复侧栏绑定。跟进测试。', 'C:\\work\\gempt', 'gempt · 修复侧栏绑定'],
    [' ', '请在你当前分配的隔离工作区中请先修复命名', '/code/gempt/', 'gempt · 修复命名'],
    [null, '```text\nnot the task\n```\n# 请帮我整理 `session.json`。', '', '整理 session.json'],
    [null, '1. "C:/My Projects/gempt": clean titles. Verify tests.', '/code/gempt', 'gempt · clean titles'],
    [null, '`/code/gempt` 修复会话列表', 'C:\\kit\\gempt', 'gempt · 修复会话列表'],
    ['🧪'.repeat(49), 'ignored', '', '🧪'.repeat(47) + '…'],
    [null, '标题'.repeat(50), '/code/gempt', 'gempt · ' + '标题'.repeat(12).slice(0, 23) + '…'],
    [null, '', '', 'GPT 任务'],
  ]) assert.equal(normalizeTitle(title, goal, cwd), expected);
});

test('npm pack dry run includes the MIT license and Live bundle and excludes local state and dependencies', async () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  assert.ok(manifest.files.includes('LICENSE'));
  assert.equal(manifest.magpie.options.mcpTools, true);
  assert.match(readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf-8'), /^MIT License\r?\n\r?\nCopyright \(c\) 2026 GemPT Contributors/);
  const npmCli = process.env.npm_execpath || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : '');
  const { stdout } = await execFileAsync(npmCli ? process.execPath : 'npm', [
    ...(npmCli ? [npmCli] : []), 'pack', '--dry-run', '--json', '--ignore-scripts',
  ], { cwd: REPO_ROOT, timeout: 30_000, windowsHide: true });
  const [{ files, version }] = JSON.parse(stdout);
  assert.equal(version, '0.6.0');
  const paths = files.map((file) => file.path);
  assert.deepEqual(paths.filter((path) => /^plugin\/skills\/[^/]+\/SKILL\.md$/.test(path)).sort(),
    ['plugin/skills/gempt-chore/SKILL.md', 'plugin/skills/gempt/SKILL.md']);
  for (const path of ['LICENSE', 'THIRD_PARTY_LICENSES.txt', 'README.en.md', 'plugin/README.md', 'plugin/assets/logo.svg', 'scripts/build-agy-plugin.mjs', 'plugin/hooks.json', 'magpie_plugin/lib/backend.mjs',
    'bin/gempt.mjs', 'plugin/work_split_hook.mjs', 'core/agy-install.mjs', 'core/mcp-server.mjs',
    'core/host-context.mjs', 'core/wait.mjs', 'core/assets/mcp_app_live.html', 'core/assets/workload.json',
    'core/assets/http-ui/index.html', 'core/assets/http-ui/styles.css', 'core/assets/http-ui/app.js',
    'plugin/sidecars/gempt_live/sidecar.json', 'plugin/sidecars/gempt_live/main.mjs']) {
    assert.ok(paths.includes(path), path);
  }
  const roots = /^(?:LICENSE(?:\.md)?$|THIRD_PARTY_LICENSES\.txt$|README(?:\.en)?\.md$|install\.(?:sh|ps1)$|package\.json$|(?:bin|core|magpie_plugin|mcp_app|plugin|scripts|templates)\/)/;
  const localFiles = /(?:^|\/)(?:\.[^/]+|node_modules|__pycache__|sessions|runs|host-context(?:[.-][^/]*)?|state\.json|config\.json|request\.json|package-lock\.json)(?:\/|$)|\.(?:py|pyc|log|jsonl|tgz)$/i;
  assert.deepEqual(paths.filter((path) => !roots.test(path) || (path !== 'core/host-context.mjs' && localFiles.test(path))), []);
  assert.ok(!existsSync(join(REPO_ROOT, 'node_modules')));
  assert.ok(!existsSync(join(REPO_ROOT, 'mcp_app', 'node_modules')));
});

test('shared Console adapters preserve relative HTTP paths, authentication and exact MCP arguments', async () => {
  const { createHttpTransport } = await import('../magpie_plugin/ui/http.js');
  const { createConsoleTransport } = await import('../mcp_app/console-transport.js');
  const html = readFileSync(join(REPO_ROOT, 'magpie_plugin', 'ui', 'index.html'), 'utf-8');
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css">/);
  assert.doesNotMatch(html, /<script/);
  const query = { q: 'a/b', offset: 0, limit: 25 };
  const settings = { native_swarm: false, swarm_shell_model: 'gemini-3.8-flash-low', codex_timeout_sec: 1800 };
  for (const base of ['http://127.0.0.1:3498/', 'https://magpie.invalid/service/gempt/']) {
    let request;
    const transport = createHttpTransport('test-key', async (path, options) => {
      request = [new URL(path, base).href, options];
      return new Response(JSON.stringify({ ok: true, items: [] }));
    });
    assert.equal((await transport.listActivity('requests', query)).items.length, 0);
    assert.equal(request[0], `${base}api/requests?q=a%2Fb&offset=0&limit=25`);
    assert.equal(request[1].headers['x-gempt-key'], 'test-key');
    await transport.saveSettings(settings);
    assert.equal(request[0], `${base}api/settings`);
    assert.deepEqual(JSON.parse(request[1].body), settings);
    await transport.runAction('interrupt_run', { run_id: 'a'.repeat(32) });
    assert.equal(request[0], `${base}api/runs/${'a'.repeat(32)}/interrupt`);
  }

  const calls = [];
  const embedded = createConsoleTransport(async (name, args) => { calls.push([name, args]); });
  await embedded.getState();
  await embedded.getRatio('24h');
  await embedded.saveSettings(settings);
  await embedded.listActivity('sessions', query);
  await embedded.getActivity('sessions', 'exec-fixture');
  assert.deepEqual(calls, [
    ['gempt_app_console_state', {}],
    ['gempt_app_token_ratio', { range: '24h' }],
    ['gempt_app_console_settings', settings],
    ['gempt_app_console_activity', { kind: 'sessions', query }],
    ['gempt_app_console_activity', { kind: 'sessions', id: 'exec-fixture' }],
  ]);
});

test('built AGY resource uses the full shared Console markup and scoped styles', () => {
  const html = readFileSync(join(REPO_ROOT, 'magpie_plugin/ui/index.html'), 'utf-8').replaceAll('\r\n', '\n');
  const css = readFileSync(join(REPO_ROOT, 'magpie_plugin/ui/styles.css'), 'utf-8').replaceAll('\r\n', '\n');
  const resource = readFileSync(join(REPO_ROOT, 'core/assets/mcp_app_live.html'), 'utf-8');
  const fragment = html.split('<!-- CONSOLE START -->')[1].split('<!-- CONSOLE END -->')[0].trim();
  assert.ok(resource.includes(fragment.replace('class="console-host"', 'class="console-host" hidden')));
  assert.ok(resource.includes(css));
  assert.match(css, /@scope \(\.console-host\)/);
  assert.match(css, /--gp-bg: var\(--bg\)/);
  assert.match(resource, /--color-background-primary/);
  assert.match(css, /@container \(max-width: 450px\)/);
  assert.match(resource, /default-src 'none'/);
  assert.doesNotMatch(resource, /<script\b[^>]+src=|<link\b[^>]+rel="stylesheet"/);
  assert.deepEqual([...resource.matchAll(/id="tab-(live|overview|requests|sessions)"/g)].map((match) => match[1]),
    ['live', 'overview', 'requests', 'sessions']);
  assert.equal((resource.match(/id="refresh-btn"/g) || []).length, 1);
  assert.equal((resource.match(/<dialog\b/g) || []).length, 1);
  assert.equal((resource.match(/id="toast"/g) || []).length, 1);
});

test('shared Console preferences survive blocked storage in an opaque iframe', async (t) => {
  const { consolePreference } = await import('../magpie_plugin/ui/app.js');
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('opaque'); } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'localStorage', prior) : delete globalThis.localStorage);
  assert.equal(consolePreference('test-opaque'), null);
  consolePreference('test-opaque', '7d');
  assert.equal(consolePreference('test-opaque'), '7d');
});

test('UI token-ratio card offers all ranges, shows observation states and has no dispatch nags', () => {
  const html = readFileSync(join(REPO_ROOT, 'magpie_plugin', 'ui', 'index.html'), 'utf-8');
  const script = readFileSync(join(REPO_ROOT, 'magpie_plugin', 'ui', 'app.js'), 'utf-8');
  assert.deepEqual([...html.matchAll(/data-ratio-range="([^"]+)" aria-pressed="([^"]+)">([^<]+)/g)].map((match) => match.slice(1)), [
    ['1h', 'false', '1小时内'], ['6h', 'false', '6小时内'], ['today', 'false', '今天'],
    ['24h', 'true', '24小时'], ['7d', 'false', '7天'],
  ]);
  assert.doesNotMatch(html + script, /放宽派单|强力放宽|低于目标|已回落 Gemini|仅派专研|当前接单|自动放宽|RATIO_ADJ_META|effective_kinds/);
  const renderSource = script.match(/  function renderTokenRatio\([\s\S]+?\r?\n  }/)?.[0];
  const constants = ['RATIO_RANGE_TITLES', 'RATIO_STATUS'].map((name) =>
    script.match(new RegExp(`  const ${name} = \\{[\\s\\S]+?\\r?\\n  \\};`))?.[0]);
  assert.ok(renderSource && constants.every(Boolean));
  const card = {};
  const title = {};
  const badge = { dataset: {} };
  const tick = { style: {} };
  const meta = {};
  const elements = {
    'token-ratio-card': card, 'token-ratio-title': title, 'token-ratio-badge': badge,
    'token-ratio-target-tick': tick, 'token-ratio-meta': meta,
  };
  const renderTokenRatio = runInNewContext(`${constants.join('\n')}\n${renderSource}\nrenderTokenRatio`, {
    $: (id) => elements[id],
    latestRatio: undefined,
    tr: (str, ...args) => args.length ? str.replace(/\{(\d+)\}/g, (_, i) => args[i]) : str,
  });
  for (const [range, titleText, target, status, badgeText] of [
    ['1h', '1 小时内实际 Token 占比', 0, 'off', '已关闭'],
    ['6h', '6 小时内实际 Token 占比', 15, 'no_data', '暂无数据'],
    ['today', '今天实际 Token 占比', 35, 'warming_up', '样本积累中'],
    ['24h', '近 24h 实际 Token 占比', 60, 'observing', '实时观测'],
    ['7d', '近 7 天实际 Token 占比', 80, 'observing', '实时观测'],
  ]) {
    const total = status === 'observing' ? 66.7 : null;
    renderTokenRatio({ range, target_gpt_share: target, status, actual_gpt_total_share: total });
    assert.equal(card.hidden, false);
    assert.equal(title.textContent, titleText);
    assert.equal(badge.textContent, badgeText);
    assert.equal(tick.hidden, target === 0);
    assert.equal(tick.style.left, `${target}%`);
    assert.equal(meta.textContent, `参考目标 ${target}%${total === null ? '' : ' · 含缓存 66.7%'}`);
    assert.match(meta.title, /in \+ 5×out/);
  }
});

test('UI shows tiers only for direct routing and offers exactly two Antigravity shortcuts', () => {
  const html = readFileSync(join(REPO_ROOT, 'magpie_plugin', 'ui', 'index.html'), 'utf-8');
  const script = readFileSync(join(REPO_ROOT, 'magpie_plugin', 'ui', 'app.js'), 'utf-8');
  assert.match(html, /<section id="tiers-section"[^>]*\bhidden>/);
  const slashStrip = html.match(/<div id="strip-agy-slash"[\s\S]+?<\/div>/)?.[0];
  assert.ok(slashStrip);
  assert.deepEqual([...slashStrip.matchAll(/data-copy="([^"]+)"/g)].map((match) => match[1].trim()), ['/gempt', '/gempt-chore']);
  assert.match(html, /id="active-slash-btn"[^>]*data-copy="\/gempt\s*"/);
  assert.doesNotMatch(html + script, /(?<!group)\/gempt-(?:sonnet|opus|fable)\b/);

  const renderSource = script.match(/  function renderState\([\s\S]+?\r?\n  }/)?.[0];
  assert.ok(renderSource);
  const elements = {
    'tiers-section': { querySelectorAll: () => [] },
    'strip-native-ids': {},
    'strip-agy-slash': {},
  };
  const routeModes = [];
  const noop = () => {};
  const renderTierRoutes = script.match(/  function renderTierRoutes\([\s\S]+?\r?\n  }/)?.[0];
  assert.ok(renderTierRoutes);
  const renderState = runInNewContext(`let latestState, currentViewMode, nativePreviewTier, onState, locateWork;\nconst pendingSettings = new Set();\n${renderSource}\n${renderTierRoutes}\nrenderState`, {
    $: (id) => elements[id],
    tr: (str, ...args) => args.length ? str.replace(/\{(\d+)\}/g, (_, i) => args[i]) : str,
    root: { querySelectorAll: () => [] },
    resolveEffectiveViewMode: (state) => state.mode,
    renderSetupBanner: noop,
    renderControls: noop,
    advanced: { render: noop },
    renderReadiness: noop,
    renderActiveRoute: (_state, tier, mode) => routeModes.push([tier?.group_id, mode]),
    renderActivity: noop,
    syncHasFallbackClasses: noop,
    markUiReady: noop,
  });
  const state = { default_tier: 'fable', clients: { antigravity_installed: true },
    native_groups: { tiers: [{ id: 'fable', group_id: 'group/gempt-fable' }] } };
  for (const mode of ['mcp', 'native', 'mcp']) {
    renderState({ ...state, mode });
    assert.equal(elements['tiers-section'].hidden, mode === 'mcp');
    assert.equal(elements['strip-native-ids'].hidden, mode === 'mcp');
    assert.equal(elements['strip-agy-slash'].hidden, mode === 'native');
  }
  assert.deepEqual(routeModes[1], ['group/gempt-fable', 'native']);
});

function startMockMagpie(modelsData, { onRequest } = {}) {
  const payloadData = modelsData ?? [
    { id: 'codex/gpt-6.2-sol', owned_by: 'codex' },
    { id: 'codex/gpt-6.2-astra', owned_by: 'codex' },
    { id: 'openai/gpt-6.1-sol', owned_by: 'openai' },
    { id: 'openai/gpt-6-astra', owned_by: 'openai' },
    { id: 'agy-cli/gemini-4-hydrogen', owned_by: 'agy-cli' },
    { id: 'agy-cli/gemini-4-neon', owned_by: 'agy-cli' },
    { id: 'agy-cli/gemini-4-argon', owned_by: 'agy-cli' },
    { id: 'auto/deepseek-v4.1-flash', owned_by: 'magpie', magpie_label: 'DeepSeek · routing group' },
    { id: 'group/gempt-harness-sonnet', owned_by: 'magpie' },
    { id: 'group/gempt-sonnet', owned_by: 'magpie' },
    { id: 'opencode-go/gemini-4-argon', owned_by: 'opencode-go' },
  ];

  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: payloadData }));
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/responses' || req.url === '/v1/chat/completions')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        requests.push({ path: req.url, headers: req.headers, body });
        if (onRequest) {
          const custom = onRequest(req.url, body, requests.length);
          if (custom) {
            res.writeHead(custom.status || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(custom.json));
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/v1/chat/completions') {
          res.end(JSON.stringify({
            id: 'chatcmpl-mock',
            model: body.model,
            choices: [{ finish_reason: 'stop', message: { content: `mock-chat:${body.model}` } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }));
        } else {
          res.end(JSON.stringify({
            id: 'resp-mock',
            status: 'completed',
            model: body.model,
            output_text: `mock-responses:${body.model}`,
            usage: { input_tokens: 12, output_tokens: 6 },
          }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

function rawHttpGet({ port, path, headers = {} }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolveReq({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', rejectReq);
    req.end();
  });
}

function createMockMagpieCli(dir, logFile) {
  const jsPath = join(dir, 'mock-magpie-cli.mjs');
  writeFileSync(
    jsPath,
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n', 'utf8');
if (args[0] === 'group' && args[1] === 'show' && args[2] === 'gempt-sonnet') {
  console.log('gempt-sonnet group/gempt-sonnet');
  process.exit(0);
}
if (args[0] === 'group' && args[1] === 'show') {
  console.error('magpie: no group "' + args[2] + '"');
  process.exit(1);
}
process.exit(0);
`,
    'utf-8',
  );

  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'mock-magpie.cmd');
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf-8');
    return cmdPath;
  }
  const shPath = join(dir, 'mock-magpie.sh');
  writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, 'utf-8');
  chmodSync(shPath, 0o755);
  return shPath;
}

const MOCK_THREAD = '01900000-0000-7000-8000-000000000001';

async function startMockAppServer({ port = 0, token = 'fixture-capability' } = {}) {
  const packets = [];
  const turns = new Map();
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const frame = (op, data) => {
      const prefix = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 255]);
      socket.write(Buffer.concat([prefix, data]));
    };
    const send = (data) => frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...data })));
    const notify = (method, params) => send({ method, params });
    let currentTurn;
    const processPacket = (message) => {
      packets.push(message);
      const { id, method, params } = message;
      if (method === 'initialize') {
        assert.equal(params.capabilities.experimentalApi, true);
        send({ id, result: { userAgent: 'mock' } });
      } else if (method === 'thread/start' || method === 'thread/resume') {
        if (method === 'thread/start') {
          assert.equal(params.dynamicTools[0].name, 'ask_gemini');
          notify('thread/started', { thread: { id: MOCK_THREAD } });
        } else {
          assert.equal(params.threadId, MOCK_THREAD);
          assert.equal(params.dynamicTools, undefined);
        }
        send({ id, result: { thread: { id: MOCK_THREAD }, cwd: params.cwd, modelProvider: params.modelProvider,
          sandbox: { type: { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[params.sandbox] } } });
      } else if (method === 'turn/start') {
        const threadId = params.threadId;
        const turnId = currentTurn = `turn-${packets.length}`;
        const emit = (method, data) => notify(method, { threadId, turnId, ...data });
        const finish = (status) => {
          if (status === 'completed') emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'mock codex final report' } });
          emit('turn/completed', { turn: { id: turnId, status } });
          turns.delete(turnId);
        };
        turns.set(turnId, finish);
        emit('turn/started', { turn: { id: turnId, status: 'inProgress' } });
        emit('item/agentMessage/delta', { itemId: 'answer', delta: 'live drafting' });
        emit('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'echo ok', exitCode: 0, aggregatedOutput: 'ok' } });
        send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
        if (params.input[0].text.includes('Ask Gemini')) {
          send({ id: 'tool-rpc', method: 'item/tool/call', params: { threadId, turnId, tool: 'ask_gemini',
            callId: 'call_native', arguments: { reason: 'decision', question: 'Continue?' } } });
        } else if (!params.input[0].text.includes('Hold turn')) finish('completed');
      } else if (method === 'turn/interrupt') {
        turns.get(params.turnId)?.('interrupted');
        send({ id, result: {} });
      } else if (id === 'tool-rpc') {
        turns.get(currentTurn)?.('completed');
      }
    };
    let received = head;
    const parse = (data) => {
      received = Buffer.concat([received, data]);
      while (received.length >= 2) {
        const opcode = received[0] & 15;
        assert.equal(received[1] & 128, 128);
        let length = received[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (received.length < 4) return;
          length = received.readUInt16BE(2);
          offset = 4;
        }
        const end = offset + 4 + length;
        if (received.length < end) return;
        const mask = received.subarray(offset, offset + 4);
        const bytes = received.subarray(offset + 4, end);
        for (let i = 0; i < length; i++) bytes[i] ^= mask[i % 4];
        received = received.subarray(end);
        if (opcode === 1) processPacket(JSON.parse(bytes));
        else if (opcode === 8) { frame(8, bytes); socket.end(); }
      }
    };
    socket.on('data', parse);
    if (head.length) parse(Buffer.alloc(0));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { packets, url: `ws://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }) };
}

async function eventually(probe, timeout = 4000) {
  const end = Date.now() + timeout;
  let result;
  do {
    result = await probe();
    if (result) return result;
    await sleep(20);
  } while (Date.now() < end);
  assert.fail('timed out waiting for observed state');
}

test('package.json Magpie manifest fields and single plugin factory export exist', async () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, 'gempt');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './magpie_plugin/index.mjs');
  for (const item of [pkg.main.slice(2), 'core/assets/**/*', 'plugin/rules/AGENTS.md', 'install.sh', 'install.ps1', 'README.md']) {
    assert.ok(pkg.files.includes(item), `files missing ${item}`);
  }
  assert.ok(existsSync(join(REPO_ROOT, pkg.main)));
  assert.ok(pkg.files.includes('plugin/agents/*.md'));
  assert.ok(existsSync(join(REPO_ROOT, 'plugin/agents/gempt-worker.md')));
  assert.equal(pkg.magpie.name, 'GemPT');
  assert.equal(pkg.magpie.page.service.port, 3498);
  assert.equal(pkg.magpie.options.port, 3498);
  assert.equal(pkg.magpie.options.exec, false);
  assert.ok(existsSync(join(REPO_ROOT, pkg.magpie.page.file)));
  assert.ok(existsSync(join(REPO_ROOT, pkg.magpie.page.icon)));
  assert.ok(Array.isArray(pkg.magpie.permissions));

  const launcherHtml = readFileSync(join(REPO_ROOT, pkg.magpie.page.file), 'utf-8');
  assert.match(launcherHtml, /_magpie\/bridge\.js/);
  assert.match(launcherHtml, /boot\.js/);

  const pluginUrl = pathToFileURL(join(REPO_ROOT, 'magpie_plugin', 'index.mjs')).href;
  const mod = await import(pluginUrl);
  assert.deepEqual(Object.keys(mod), ['GemptPlugin']);
  assert.equal(typeof mod.GemptPlugin, 'function');

  const probeScript = `
    import { GemptPlugin } from ${JSON.stringify(pluginUrl)};
    const out = await GemptPlugin({}, { port: 0 });
    console.log(JSON.stringify(Object.keys(out.tool).sort()));
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', probeScript], {
    timeout: 10000,
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(stdout.trim()), ['ask', 'ctl', 'run']);
});

test('token-ratio scopes Antigravity usage to conversations with recent GemPT activity', async (t) => {
  const { readTokenRatio } = await import('../magpie_plugin/lib/token-ratio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gempt-ratio-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brainDir = join(dir, 'brain');
  const sessionsDir = join(dir, 'custom-sessions');
  const magpieConfigDir = join(dir, 'magpie');
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const saveTranscript = (id, inputTokens, toolCalls = []) => {
    const logDir = join(brainDir, id, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'transcript.jsonl'), JSON.stringify({
      type: 'PLANNER_RESPONSE', created_at: recent, model: 'gemini-4-neon-high',
      input_tokens: inputTokens, output_tokens: 1_000, tool_calls: toolCalls,
    }) + '\n');
  };
  saveTranscript('unrelated', 985_000);
  mkdirSync(magpieConfigDir);
  writeFileSync(join(magpieConfigDir, 'usage.jsonl'), JSON.stringify({
    t: recent, provider: 'codex', in: 10_000, out: 2_000,
  }) + '\n');
  const read = () => readTokenRatio({ brainDir, sessionsDir, magpieConfigDir, cacheTtlMs: 0 });
  const assertScoped = () => {
    const snapshot = read();
    assert.equal(snapshot.scope, 'gempt_active_sessions');
    assert.equal(snapshot.sources.agy_files, 2);
    assert.equal(snapshot.sources.skipped_non_gempt_sessions, 1);
    assert.equal(snapshot.gemini.work, 10_000);
    assert.equal(snapshot.gpt.work, 20_000);
    assert.equal(snapshot.actual_gpt_share, 66.7);
  };
  for (const call of [
    { name: 'gpt_run' },
    { name: 'call_mcp_tool', args: { ServerName: 'gempt_gempt', ToolName: 'gpt_run' } },
    { name: 'invoke_subagent', args: { TypeName: 'gempt-worker' } },
    ...['gempt run --goal -', 'gempt ask --goal -', 'gempt-wait 123', 'gempt steer 123 update',
      'gempt reply-tool 123 ask_1 reply', 'cat brief.txt | gempt run --goal -',
      "'/path with space/bin/gempt-wait' 123", '"C:\\path with space\\gempt.cmd" run --goal x']
      .map((CommandLine) => ({ name: 'run_command', args: { CommandLine } })),
  ]) {
    saveTranscript('active', 5_000, [call]);
    assertScoped();
  }
  saveTranscript('active', 5_000);
  const runDir = join(sessionsDir, 'runs', 'a'.repeat(32));
  mkdirSync(runDir, { recursive: true });
  const saveRun = (createdAt) => writeFileSync(join(runDir, 'state.json'), JSON.stringify({
    host_conversation_id: 'active', created_at: createdAt,
  }));
  saveRun(old);
  const fallback = read();
  assert.equal(fallback.scope, 'all_sessions');
  assert.equal(fallback.sources.skipped_non_gempt_sessions, 0);
  assert.equal(fallback.actual_gpt_share, 2);
  saveRun(recent);
  assertScoped();
});

test('token-ratio includes native Swarm workers by the opening board message from an active coordinator', async (t) => {
  const { readTokenRatio } = await import('../magpie_plugin/lib/token-ratio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gempt-ratio-swarm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brainDir = join(dir, 'brain');
  const sessionsDir = join(dir, 'sessions');
  const nowMs = Date.now();
  const recent = new Date(nowMs - 30_000).toISOString();
  const old = new Date(nowMs - 48 * 3600_000).toISOString();
  const notice = (sender) => ({
    type: 'SYSTEM_MESSAGE', created_at: old,
    content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-23T00:00:00Z sender=' + sender
      + ' priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2\n</SYSTEM_MESSAGE>',
  });
  const planner = (toolCalls, created_at = recent) => ({
    type: 'PLANNER_RESPONSE', created_at, model: 'gemini-4-neon-high', input_tokens: 100, output_tokens: 10,
    tool_calls: toolCalls,
  });
  const saveTranscript = (id, ...records) => {
    const logs = join(brainDir, id, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'transcript.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  };
  const native = planner([{ name: 'read_board' }, { name: 'post_message' }]);
  const shell = (CommandLine) => planner([{ name: 'run_command', args: { CommandLine } }]);
  saveTranscript('a-linked-worker', notice('z-coordinator'), native);
  saveTranscript('b-fake-opening', shell('echo "gempt run --goal x"'), notice('z-coordinator'));
  saveTranscript('c-inactive-parent', notice('inactive'), shell('git status'));
  saveTranscript('z-coordinator', shell('gempt run --goal x'));
  const read = () => readTokenRatio({ brainDir, sessionsDir, magpieConfigDir: '', nowMs });
  const both = read();
  assert.equal(both.scope, 'gempt_active_sessions');
  assert.equal(both.gemini.work, 300);
  assert.equal(both.sources.excluded_sessions, 0);
  assert.equal(both.sources.skipped_non_gempt_sessions, 2);

  saveTranscript('z-coordinator', { ...shell('gempt run --goal x'), created_at: old });
  const other = read();
  assert.equal(other.scope, 'all_sessions');
  assert.equal(other.sources.excluded_sessions, 1);
  const runDir = join(sessionsDir, 'runs', 'a'.repeat(32));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({ host_conversation_id: 'z-coordinator', created_at: recent }));
  const byRun = read();
  assert.equal(byRun.scope, 'gempt_active_sessions');
  assert.equal(byRun.gemini.work, 150);
  assert.equal(byRun.sources.skipped_non_gempt_sessions, 2);
});

test('backend discovery uses overrides, PATH and installed MCP configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'gempt-paths-'));
  const keys = ['PATH', 'MAGPIE_BIN', 'PYTHON_BIN'];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const bin = join(root, 'bin');
    const win = process.platform === 'win32';
    const python = join(bin, win ? 'python.exe' : 'python3');
    const magpie = join(bin, win ? 'magpie.com' : 'magpie');
    const override = join(root, 'custom-magpie');
    mkdirSync(bin);
    for (const path of [python, magpie, override]) {
      writeFileSync(path, '');
      chmodSync(path, 0o755);
    }
    process.env.PATH = [bin, before.PATH].filter(Boolean).join(delimiter);
    process.env.MAGPIE_BIN = override;
    process.env.PYTHON_BIN = python;
    assert.equal(findMagpieCli(magpie), magpie);
    assert.equal(findMagpieCli(), override);
    assert.equal(buildMcpSnippet({ antigravityPluginDir: root }).config.mcpServers.gempt.command, process.execPath);
    delete process.env.MAGPIE_BIN;
    delete process.env.PYTHON_BIN;
    assert.equal(findMagpieCli(), magpie);
    assert.deepEqual(buildMcpSnippet({ antigravityPluginDir: root }).config.mcpServers.gempt,
      { command: process.execPath, args: [join(REPO_ROOT, 'core', 'mcp-server.mjs')] });

    const runtime = join(root, 'runtime', 'gempt');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'mcp_server.py'), '');
    const config = { mcpServers: { gempt: { command: 'installed-python', args: ['-m', 'gempt.mcp_server'] } } };
    writeFileSync(join(root, 'mcp_config.json'), JSON.stringify(config));
    assert.deepEqual(buildMcpSnippet({ antigravityPluginDir: root }).config, config);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed MCP snippets redact unlisted env values without modifying the config file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gempt-mcp-redaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime', 'gempt');
  const path = join(root, 'mcp_config.json');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'mcp_server.py'), '');
  const safe = { PYTHONPATH: '/runtime', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GEMPT_CONFIG: '/config/gempt.json' };
  const installed = JSON.stringify({ mcpServers: {
    gempt: { command: 'python', env: { ...safe, OPENAI_API_KEY: 'test-secret-one' } },
    other: { command: 'node', env: { CUSTOM_TOKEN: 'test-secret-two' } },
  } });
  writeFileSync(path, installed);
  const snippet = buildMcpSnippet({ antigravityPluginDir: root });
  assert.deepEqual(snippet.config.mcpServers.gempt.env, { ...safe, OPENAI_API_KEY: '[REDACTED]' });
  assert.deepEqual(snippet.config.mcpServers.other.env, { CUSTOM_TOKEN: '[REDACTED]' });
  assert.deepEqual(JSON.parse(snippet.json), snippet.config);
  assert.doesNotMatch(snippet.json, /test-secret-/);
  assert.equal(readFileSync(path, 'utf-8'), installed);
});

test('backend readState exposes multi-client state, native groups, MCP snippet, usage tail, and api_fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-magpie-backend-'));
  const magpie = await startMockMagpie();
  try {
    const cfgPath = join(dir, 'config.json');
    const sessDir = join(dir, 'sessions');
    const magpieDir = join(dir, 'magpie-cfg');
    const agyDir = join(dir, 'agy-plugin');
    mkdirSync(join(sessDir, 'runs', 'a'.repeat(32)), { recursive: true });
    mkdirSync(magpieDir, { recursive: true });
    mkdirSync(agyDir, { recursive: true });

    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        magpie: { base_url: magpie.url, api_key: 'sk-super-secret-value' },
        codex: { default_sandbox: 'workspace-write' },
        routing_policy: {
          default_tier: 'opus',
          failover_mode: 'api_fallback',
          excluded_models: ['gemini-4-argon'],
        },
        tiers: {
          sonnet: { consult_model: 'codex/gpt-6.2-sol', fallback_models: ['openai/gpt-6.1-sol'], reasoning_effort: 'medium' },
          opus: { consult_model: 'codex/gpt-6.2-sol', escalate_model: 'codex/gpt-6.2-astra', escalate_effort_threshold: 'xhigh', fallback_models: ['openai/gpt-6.1-sol'], reasoning_effort: 'high' },
          fable: { consult_model: 'codex/gpt-6.2-astra', fallback_models: ['openai/gpt-6-astra'], reasoning_effort: 'xhigh' },
        },
        utility: { model: 'auto/deepseek-v4.1-flash' },
      }),
      'utf-8',
    );

    writeFileSync(join(magpieDir, 'applied.json'), JSON.stringify({ zcode: {}, claude: {}, codex: {} }), 'utf-8');
    writeFileSync(
      join(magpieDir, 'library.json'),
      JSON.stringify({
        mcp: [{ name: 'gempt', url: 'http://127.0.0.1:3425/mcp/magpie/tools/gempt', plugin: 'gempt', agents: ['zcode', 'claude'] }],
      }),
      'utf-8',
    );
    writeFileSync(
      join(magpieDir, 'plugin-tools.json'),
      JSON.stringify({ gempt: ['run', 'ask', 'ctl'] }),
      'utf-8',
    );
    writeFileSync(
      join(magpieDir, 'providers.json'),
      JSON.stringify({
        groups: [
          { id: 'gempt-sonnet', members: ['agy-cli/gemini-4-hydrogen', 'codex/gpt-6.2-sol', 'auto/deepseek-v4.1-flash'], routing: 'order', rules: [] },
        ],
      }),
      'utf-8',
    );
    writeFileSync(
      join(magpieDir, 'usage.jsonl'),
      `${JSON.stringify({ t: '2026-11-20T12:00:00Z', agent: 'Python-urllib', req: 'auto/deepseek-v4.1-flash', status: 200 })}\n`
      + `${JSON.stringify({ t: '2026-11-20T12:01:00Z', agent: 'zcode', req: 'group/gempt-opus', provider: 'codex', model: 'gpt-6.2-sol', served: 'gpt-6.2-sol', status: 200 })}\n`,
      'utf-8',
    );

    writeFileSync(
      join(sessDir, 'consult-20261119-demo.json'),
      JSON.stringify({
        session_id: 'consult-20261119-demo',
        mode: 'consult',
        tier: 'opus',
        model: 'codex/gpt-6.2-sol',
        cwd: join(dir, 'repo'),
        turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
      }),
      'utf-8',
    );

    writeFileSync(
      join(sessDir, 'runs', 'a'.repeat(32), 'state.json'),
      JSON.stringify({
        run_id: 'a'.repeat(32),
        state: 'finished',
        cwd: join(dir, 'repo'),
        result: { tier: 'sonnet', model: 'codex/gpt-6.2-sol', verification: { status: 'passed' } },
      }),
      'utf-8',
    );

    const state = await readState({
      configPath: cfgPath,
      sessionsDir: sessDir,
      magpieConfigDir: magpieDir,
      antigravityPluginDir: agyDir,
      probeTimeoutMs: 2000,
    });
    assert.equal(state.configured, true);
    assert.equal(state.features.api_fallback, true);
    assert.equal(state.subscription.connected, true);
    assert.equal(state.api_fallback.available, true);
    assert.equal(state.api_fallback.openai_count, 2);
    assert.equal(state.clients.antigravity_installed, false);
    assert.equal(state.clients.magpie_mcp_registered, true);
    assert.equal(state.clients.native_tools_registered, true);
    assert.deepEqual(state.clients.native_tools_agents, ['ZCode', 'Claude Code']);
    assert.deepEqual(state.clients.native_tools_list, ['gempt_run', 'gempt_ask', 'gempt_ctl']);
    assert.deepEqual(state.clients.external_clients, ['ZCode', 'Claude Code', 'Codex CLI']);
    assert.equal(state.tools.enabled, true);
    assert.equal(state.tools.exec_enabled, false);
    assert.match(state.rules_snippet, /gpt_run/);
    assert.match(state.rules_snippet, /gpt_ask/);
    assert.match(state.rules_snippet, /gpt_ctl/);
    assert.ok(state.rules_snippet.trim().split(/\r?\n/).length <= 8);

    assert.equal(state.native_groups.ready_count, 1);
    assert.equal(state.native_groups.complete, false);
    assert.equal(state.native_groups.can_create, true);
    const fablePreview = state.native_groups.tiers.find((t) => t.id === 'fable');
    assert.equal(fablePreview.installed, false);
    assert.equal(fablePreview.members.some((m) => m.includes('gemini-4-argon')), false);

    assert.equal(state.mcp_snippet.config.mcpServers.gempt.args[0], join(REPO_ROOT, 'core', 'mcp-server.mjs'));
    assert.equal(state.recent_group_calls.length, 1);
    assert.equal(state.recent_group_calls[0].tier, 'opus');
    assert.equal(state.recent_group_calls[0].agent, 'zcode');
    assert.equal(state.default_tier, 'opus');
    assert.equal(state.failover_mode, 'api_fallback');
    assert.equal(state.magpie.reachable, true);
    assert.equal(state.magpie.total_models, 9);
    assert.deepEqual(state.magpie.harness_groups, ['group/gempt-harness-sonnet']);
    assert.equal(state.recent_sessions.length, 1);
    assert.equal(state.recent_runs.length, 1);
    assert.equal(JSON.stringify(state).includes('sk-super-secret-value'), false);

    assert.equal(setDefaultTier('chore', { configPath: cfgPath }).status, 400);
    assert.equal(setDefaultTier('sonnet', { configPath: join(dir, 'missing.json') }).status, 404);
    assert.equal(setDefaultSandbox('invalid', { configPath: cfgPath }).status, 400);

    const tierOk = setDefaultTier('fable', { configPath: cfgPath });
    assert.equal(tierOk.ok, true);
    const sbxOk = setDefaultSandbox('danger-full-access', { configPath: cfgPath });
    assert.equal(sbxOk.ok, true);

    const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(saved.routing_policy.default_tier, 'fable');
    assert.equal(saved.codex.default_sandbox, 'danger-full-access');
    assert.equal(saved.magpie.api_key, 'sk-super-secret-value');
  } finally {
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('page server supports native groups and lossless failover round-trip with a unified MCP consultation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-magpie-srv-'));
  const magpie = await startMockMagpie();
  const cfgPath = join(dir, 'config.json');
  const magpieDir = join(dir, 'magpie-cfg');
  mkdirSync(magpieDir, { recursive: true });
  const cliLog = join(dir, 'cli-calls.jsonl');
  const mockCli = createMockMagpieCli(dir, cliLog);

  const initialConfig = {
    version: 1,
    magpie: { base_url: magpie.url, api_key: 'sk-keep-me' },
    codex: { default_sandbox: 'danger-full-access' },
    routing_policy: {
      default_tier: 'opus',
      failover_mode: 'api_fallback',
      magpie_group_strategy: 'order',
      excluded_models: ['gemini-4-argon'],
    },
    tiers: {
      sonnet: {
        consult_model: 'group/gempt-harness-sonnet',
        exec_model: 'group/gempt-harness-sonnet',
        reasoning_effort: 'medium',
        api_mode: 'responses',
        fallback_models: ['openai/gpt-6.1-sol'],
        magpie_group_members: ['codex/gpt-6.2-sol', 'openai/gpt-6.1-sol'],
      },
      opus: {
        consult_model: 'group/gempt-harness-opus',
        exec_model: 'group/gempt-harness-opus',
        escalate_model: 'codex/gpt-6.2-astra',
        escalate_effort_threshold: 'high',
        reasoning_effort: 'medium',
        api_mode: 'responses',
        fallback_models: ['openai/gpt-6.1-sol'],
        magpie_group_members: ['codex/gpt-6.2-sol', 'codex/gpt-6.2-astra', 'openai/gpt-6.1-sol', 'openai/gpt-6-astra'],
      },
      fable: {
        consult_model: 'group/gempt-harness-fable',
        exec_model: 'group/gempt-harness-fable',
        reasoning_effort: 'high',
        api_mode: 'responses',
        fallback_models: ['openai/gpt-6-astra'],
        magpie_group_members: ['codex/gpt-6.2-astra', 'openai/gpt-6-astra'],
      },
    },
    utility: { model: 'auto/deepseek-v4.1-flash', api_mode: 'chat' },
  };
  writeFileSync(cfgPath, JSON.stringify(initialConfig, null, 2), 'utf-8');

  const svc = await startServer({
    port: 0,
    configPath: cfgPath,
    sessionsDir: join(dir, 'sessions'),
    magpieConfigDir: magpieDir,
    antigravityPluginDir: join(dir, 'missing-agy'),
    agyBinDir: join(dir, 'bin'),
    magpieCliPath: mockCli,
    mcpToolsEnabled: false,
  });
  const origin = `http://127.0.0.1:${svc.port}`;

  try {
    const opaque = { Origin: 'null' };
    const pingRes = await fetch(`${origin}/api/ping`, { headers: opaque });
    assert.equal(pingRes.status, 200);
    assert.equal(pingRes.headers.get('access-control-allow-origin'), null);

    const badHost = await rawHttpGet({ port: svc.port, path: '/api/ping', headers: { Host: 'evil.example:3498' } });
    assert.equal(badHost.status, 403);
    const badOrigin = await rawHttpGet({ port: svc.port, path: '/api/ping', headers: { Origin: 'http://evil.example' } });
    assert.equal(badOrigin.status, 403);
    const badFetchMode = await fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'cors' } });
    assert.equal(badFetchMode.status, 403);
    for (const path of ['/api/state', '/api/requests']) {
      const unauth = await fetch(`${origin}${path}`, { headers: opaque });
      assert.equal(unauth.status, 401);
      assert.equal(unauth.headers.get('access-control-allow-origin'), null);
    }
    for (const path of ['/http.js', '/app.js']) {
      const publicModule = await fetch(`${origin}${path}`, { headers: opaque });
      assert.equal(publicModule.status, 200);
      assert.equal(publicModule.headers.get('access-control-allow-origin'), 'null');
      assert.doesNotMatch(await publicModule.text(), /<meta name="gempt-key"/);
    }
    const preflight = await fetch(`${origin}/api/state`, { method: 'OPTIONS', headers: opaque });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');

    const pageRes = await rawHttpGet({ port: svc.port, path: '/', headers: { 'sec-fetch-mode': 'navigate' } });
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(pageRes.text, /id="create-native-btn"/);
    assert.match(pageRes.text, /id="effort-control-group"/);
    const key = pageRes.text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];
    const installUrl = `${origin}/api/install-agy`;
    assert.equal((await fetch(installUrl, { method: 'POST' })).status, 401);
    assert.equal((await fetch(installUrl, { method: 'POST', headers: { ...opaque, 'x-gempt-key': key } })).status, 403);
    const installation = await fetch(installUrl, { method: 'POST', headers: { origin, 'x-gempt-key': key } });
    assert.equal(installation.status, 200);
    const installed = await installation.json();
    assert.equal(installed.plugin_dir, join(dir, 'missing-agy'));
    assert.equal(installed.mcp_config.mcpServers.gempt.command, process.execPath);
    assert.ok(existsSync(join(dir, 'bin', 'gempt-wait.mjs')));
    const disabledStateRes = await fetch(`${origin}/api/state`, { headers: { ...opaque, 'x-gempt-key': key } });
    assert.equal(disabledStateRes.status, 200);
    assert.equal(disabledStateRes.headers.get('access-control-allow-origin'), 'null');
    assert.equal((await disabledStateRes.json()).tools.enabled, false);
    writeFileSync(join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: 'github:yizhang-dream/gempt', options: { mcpTools: false } }],
    }));
    const directState = await readState({ configPath: cfgPath, sessionsDir: join(dir, 'sessions'),
      magpieConfigDir: magpieDir, antigravityPluginDir: join(dir, 'missing-agy') });
    assert.equal(directState.tools.enabled, false);

    // Native groups idempotent creation
    const nativeRes = await fetch(`${origin}/api/native-groups`, {
      method: 'POST',
      headers: { Origin: 'null', 'x-gempt-key': key },
    });
    assert.equal(nativeRes.status, 200);
    const nativeJson = await nativeRes.json();
    assert.equal(nativeJson.ok, true);
    assert.deepEqual(nativeJson.skipped, ['group/gempt-sonnet']);
    assert.deepEqual(nativeJson.created, ['group/gempt-opus', 'group/gempt-fable']);
    assert.equal(nativeJson.models.argon.includes('gemini-4-argon'), false);

    // Switch api_fallback -> subscription_only
    const toSubRes = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ failover_mode: 'subscription_only', default_sandbox: 'workspace-write' }),
    });
    assert.equal(toSubRes.status, 200);
    const toSubJson = await toSubRes.json();
    assert.equal(toSubJson.failover_mode, 'subscription_only');
    assert.equal(toSubJson.default_sandbox, 'workspace-write');

    const subCfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(subCfg.routing_policy.failover_mode, 'subscription_only');
    assert.equal(subCfg.codex.default_sandbox, 'workspace-write');
    assert.equal(subCfg.tiers.sonnet.consult_model, 'codex/gpt-6.2-sol');
    assert.equal(subCfg.tiers.opus.consult_model, 'codex/gpt-6.2-sol');
    assert.equal(subCfg.tiers.opus.escalate_model, 'codex/gpt-6.2-astra');
    assert.equal(subCfg.tiers.fable.consult_model, 'codex/gpt-6.2-astra');
    assert.deepEqual(subCfg.tiers.opus.fallback_models, []);
    assert.ok(subCfg.routing_policy.api_fallback_snapshot);

    const { ask } = createGemptTools({ configPath: cfgPath, sessionsDir: join(dir, 'sessions') });
    await ask.execute({ goal: 'Check the active subscription tier.', tier: 'fable' });
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.2-astra');

    // Restore subscription_only -> api_fallback losslessly
    const toApiRes = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ failover_mode: 'api_fallback' }),
    });
    assert.equal(toApiRes.status, 200);

    const restored = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(restored.routing_policy.failover_mode, 'api_fallback');
    assert.equal(restored.routing_policy.api_fallback_snapshot, undefined);
    assert.equal(restored.tiers.opus.consult_model, 'group/gempt-harness-opus');
    assert.deepEqual(restored.tiers.opus.fallback_models, ['openai/gpt-6.1-sol']);
    assert.deepEqual(restored.tiers.opus.magpie_group_members, initialConfig.tiers.opus.magpie_group_members);
    assert.equal(restored.magpie.api_key, 'sk-keep-me');

    const postAutoOn = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ auto_effort: true }),
    });
    assert.equal(postAutoOn.status, 200);
    assert.equal((await postAutoOn.json()).auto_effort, true);

    const postEffortSet = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ auto_effort: false, tier_effort: 'xhigh', tier: 'opus' }),
    });
    assert.equal(postEffortSet.status, 200);
    const effSetJson = await postEffortSet.json();
    assert.equal(effSetJson.auto_effort, false);
    assert.equal(effSetJson.reasoning_effort, 'xhigh');

    const mcpEffort = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ mcp_effort: 'high' }),
    });
    assert.equal(mcpEffort.status, 200);
    assert.equal((await mcpEffort.json()).mcp_effort, 'high');
    const defaultPairing = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ pairing: { family: 'hydrogen', model: 'default' } }),
    });
    assert.equal(defaultPairing.status, 200);
    const pairedReceipt = await ask.execute({ goal: 'Check the default subscription model.', gemini_family: 'hydrogen' });
    assert.equal(pairedReceipt.tier, 'paired:hydrogen');
    assert.equal(pairedReceipt.reasoning_effort, 'high');
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.2-sol');
    assert.equal(magpie.requests.at(-1).body.reasoning.effort, 'high');

    const postUltraRejected = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ tier_effort: 'ultra', tier: 'opus' }),
    });
    assert.equal(postUltraRejected.status, 400);

    const postAstraLowRejected = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ tier_effort: 'low', tier: 'fable' }),
    });
    assert.equal(postAstraLowRejected.status, 400);

    for (const field of ['work_split', 'swarm_split']) {
      const response = await fetch(`${origin}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
        body: JSON.stringify({ [field]: 'gemini_first' }),
      });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).routing_policy[field], 'gemini_first');
    }
    const stateRes = await fetch(`${origin}/api/state`, {
      headers: { 'x-gempt-key': key },
    });
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.work_split, 'gemini_first');
    assert.equal(stateJson.swarm_split, 'gemini_first');
    assert.deepEqual(Object.values(stateJson.work_profiles).map(({ gpt_share }) => gpt_share), [0, 15, 35, 60, 80]);
    assert.equal(stateJson.auto_effort, false);
    assert.equal(stateJson.mcp_effort, 'high');
    assert.equal(stateJson.pairings.hydrogen, 'default');
    assert.equal(stateJson.mcp_default_model, 'codex/gpt-6.2-sol');
    assert.equal(stateJson.tiers.find((t) => t.id === 'opus').reasoning_effort, 'xhigh');
  } finally {
    await svc.close();
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh subscription_only auto-discovers openai/* backup when switching to api_fallback, or rejects when absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-magpie-autoapi-'));
  const prevMagpieAddr = process.env.MAGPIE_ADDR;

  // Case 1: With openai/* present -> init then toggle to api_fallback populates fallbacks.
  const magpieWithApi = await startMockMagpie();
  const cfgPath1 = join(dir, 'cfg-with-api.json');
  process.env.MAGPIE_ADDR = magpieWithApi.url;
  const svc1 = await startServer({ port: 0, configPath: cfgPath1, sessionsDir: join(dir, 'sess1') });

  // Case 2: Without openai/* -> switching to api_fallback returns 400.
  const magpieSubOnly = await startMockMagpie([{ id: 'codex/gpt-6.2-sol', owned_by: 'codex' }, { id: 'codex/gpt-6.2-astra', owned_by: 'codex' }]);
  const cfgPath2 = join(dir, 'cfg-sub-only.json');
  writeFileSync(
    cfgPath2,
    JSON.stringify({
      version: 1,
      magpie: { base_url: magpieSubOnly.url },
      routing_policy: { default_tier: 'sonnet', failover_mode: 'subscription_only' },
      tiers: {
        sonnet: { consult_model: 'codex/gpt-6.2-sol', exec_model: 'codex/gpt-6.2-sol' },
        opus: { consult_model: 'codex/gpt-6.2-sol', exec_model: 'codex/gpt-6.2-sol', escalate_model: 'codex/gpt-6.2-astra' },
        fable: { consult_model: 'codex/gpt-6.2-astra', exec_model: 'codex/gpt-6.2-astra' },
      },
    }),
    'utf-8',
  );
  const svc2 = await startServer({ port: 0, configPath: cfgPath2, sessionsDir: join(dir, 'sess2') });

  try {
    const key1 = (await rawHttpGet({ port: svc1.port, path: '/', headers: { 'sec-fetch-mode': 'navigate' } }))
      .text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];
    const initRes = await fetch(`http://127.0.0.1:${svc1.port}/api/init`, {
      method: 'POST',
      headers: { Origin: 'null', 'x-gempt-key': key1 },
    });
    assert.equal(initRes.status, 200);

    const enableApi = await fetch(`http://127.0.0.1:${svc1.port}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key1 },
      body: JSON.stringify({ failover_mode: 'api_fallback' }),
    });
    assert.equal(enableApi.status, 200);
    const updated1 = JSON.parse(readFileSync(cfgPath1, 'utf-8'));
    assert.equal(updated1.routing_policy.failover_mode, 'api_fallback');
    assert.deepEqual(updated1.tiers.sonnet.fallback_models, ['openai/gpt-6.1-sol']);
    assert.deepEqual(updated1.tiers.fable.fallback_models, ['openai/gpt-6-astra']);

    const key2 = (await rawHttpGet({ port: svc2.port, path: '/', headers: { 'sec-fetch-mode': 'navigate' } }))
      .text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];
    const rejectApi = await fetch(`http://127.0.0.1:${svc2.port}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key2 },
      body: JSON.stringify({ failover_mode: 'api_fallback' }),
    });
    assert.equal(rejectApi.status, 400);
  } finally {
    if (prevMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
    else process.env.MAGPIE_ADDR = prevMagpieAddr;
    await svc1.close();
    await svc2.close();
    await magpieWithApi.close();
    await magpieSubOnly.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings batch validates atomically and failover preserves changes made during the gateway probe', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-settings-'));
  const configPath = join(dir, 'config.json');
  let probeStarted, releaseProbe;
  const probing = new Promise((resolve) => { probeStarted = resolve; });
  const allowProbe = new Promise((resolve) => { releaseProbe = resolve; });
  let requests = 0;
  const magpie = http.createServer(async (_req, res) => {
    requests++;
    probeStarted();
    await allowProbe;
    res.end(JSON.stringify({ data: [{ id: 'codex/gpt-6.2-sol' }, { id: 'openai/gpt-6.1-sol' }] }));
  });
  await new Promise((resolve) => magpie.listen(0, '127.0.0.1', resolve));
  const original = JSON.stringify({ magpie: { base_url: `http://127.0.0.1:${magpie.address().port}` },
    codex: { default_sandbox: 'workspace-write' }, routing_policy: { failover_mode: 'subscription_only' } });
  writeFileSync(configPath, original);
  const svc = await startServer({ port: 0, configPath, sessionsDir: join(dir, 'sessions'), probeTimeoutMs: 5000 });
  t.after(async () => {
    releaseProbe();
    await svc.close();
    await new Promise((resolve) => magpie.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const key = (await rawHttpGet({ port: svc.port, path: '/' })).text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];
  const post = (body) => fetch(`http://127.0.0.1:${svc.port}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gempt-key': key }, body: JSON.stringify(body),
  });
  for (const invalid of [{ failover_mode: 'wrong' }, { mcp_effort: 'ultra' }, { auto_effort: 'true' },
    { pairing: { family: 'bogus', model: 'default' } }, { work_split: 'invalid' },
    { tier: 'fable', tier_effort: 'low' }, { unknown: 1 }]) {
    assert.equal((await post({ default_sandbox: 'read-only', ...invalid })).status, 400);
    assert.equal(readFileSync(configPath, 'utf8'), original);
  }
  assert.equal((await post({ default_sandbox: ['read-only'], work_split: 'balanced' })).status, 400);
  assert.equal((await post({ failover_mode: 'api_fallback', mcp_effort: 'ultra' })).status, 400);
  assert.equal(requests, 0);

  const toggle = post({ failover_mode: 'api_fallback', default_sandbox: 'read-only', mcp_effort: 'high' });
  try {
    await Promise.race([probing, toggle.then((response) => assert.fail(`Failover returned ${response.status} before probing`))]);
    assert.equal(readFileSync(configPath, 'utf8'), original);
    assert.equal((await post({ pairing: { family: 'hydrogen', model: 'codex/fixture' }, work_split: 'balanced' })).status, 200);
  } finally {
    releaseProbe();
  }
  assert.equal((await toggle).status, 200);
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(saved.codex.default_sandbox, 'read-only');
  assert.equal(saved.routing_policy.mcp_effort, 'high');
  assert.equal(saved.routing_policy.failover_mode, 'api_fallback');
  assert.equal(saved.routing_policy.pairings.hydrogen, 'codex/fixture');
  assert.equal(saved.routing_policy.work_split, 'balanced');
});

test('history API paginates GemPT dispatches, correlates exec receipts and returns full transcripts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-activity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = join(dir, 'sessions');
  const magpieConfigDir = join(dir, 'magpie');
  mkdirSync(sessionsDir);
  mkdirSync(magpieConfigDir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ magpie: { base_url: 'http://127.0.0.1:1' } }));
  const saveSession = (id, session) => writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ session_id: id, ...session }));
  const saveRun = (id, run) => {
    const runDir = join(sessionsDir, 'runs', id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), JSON.stringify({ run_id: id, ...run }));
  };
  const alpha = join(dir, 'project alpha');
  const beta = join(dir, '项目 beta');
  const stamp = (day) => `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  const consult = 'consult-dispatch';
  const exec = 'exec-dispatch';
  const linked = 'a'.repeat(32);
  const legacyNative = 'b'.repeat(32);
  const runOnly = 'c'.repeat(32);
  const failed = 'd'.repeat(32);
  const expired = 'e'.repeat(32);
  const queued = 'f'.repeat(32);
  const running = '1'.repeat(32);
  const resumed = '2'.repeat(32);
  const saving = '3'.repeat(32);
  const rawReply = '<img src=x> second reply';
  saveSession(consult, {
    mode: 'consult', cwd: alpha, tier: 'opus', model: 'codex/beta',
    created_at: stamp(1), updated_at: stamp(7),
    turns: [
      { role: 'user', content: '## Goal\nfirst goal\n\n## Context\nfull context' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'followup' },
      { role: 'assistant', content: rawReply },
    ],
    turn_details: {
      1: { tier: 'sonnet', model: 'codex/alpha', reasoning_effort: 'medium', timestamp: stamp(1),
        elapsed_sec: 1.5, usage: { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 8 } } },
      2: { reasoning_effort: 'high', timestamp: stamp(7), attempted_models: ['codex/alpha', 'codex/beta'],
        elapsed_sec: 3, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
    },
  });
  saveSession('consult-legacy', {
    updated_at: '2026-11-08T18:00:00+0800',
    turns: [{ role: 'user', content: 'historic question' }, { role: 'assistant', content: 'historic answer' }],
  });
  const command = { command: 'node --test', exit_code: 0, output: 'PASS' };
  saveSession(exec, {
    mode: 'exec', cwd: beta, title: '  解析器\n检查 ', tier: 'opus', model: 'codex/exec', updated_at: stamp(10),
    turns: [
      { goal: 'check parser', timestamp: stamp(2), elapsed_sec: 12, usage: { input_tokens: 120, output_tokens: 30 }, reply_preview: 'full exec' },
      { role: 'user', content: '## Goal\ncontinue work\n\n## Required Verification\nnode --check app.js' },
      { role: 'assistant', content: 'native response' },
      { goal: 'pending receipt', reply: 'already saved', timestamp: stamp(10), run_id: saving },
    ],
  });
  saveRun(linked, { state: 'finished', cwd: beta, finished_at: stamp(2), result: {
    session_id: exec, turns: 1, model: 'codex/exec', tier: 'sonnet', reasoning_effort: 'high',
    usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 30 }, elapsed_sec: 12,
    text: 'full exec response', verification: { requested: 'node --test', status: 'passed', checks: [command], commands: [command] },
  } });
  saveRun(legacyNative, { state: 'finished', cwd: beta, finished_at: stamp(9), result: {
    session_id: exec, elapsed_sec: 8, usage: { input_tokens: 50, output_tokens: 25 },
    text: '[mode=exec | tier=opus]\n\nnative response',
  } });
  saveRun(saving, { state: 'running', cwd: beta, created_at: stamp(10), title: ' 短任务名 ', goal: 'pending receipt' });
  saveRun(resumed, { state: 'failed', session_id: exec, cwd: beta, finished_at: stamp(11), goal: 'failed followup', error: 'worker stopped' });
  saveRun(runOnly, { state: 'finished', cwd: alpha, finished_at: stamp(12),
    result: { session_id: 'exec-orphan', turns: 3, text: 'receipt only', tier: 'fable' } });
  saveRun(failed, { state: 'failed', cwd: alpha, finished_at: stamp(13), goal: 'standalone failure', error: 'failed to start' });
  saveRun(expired, { state: 'running', deadline: 1, created_at: stamp(14) });
  saveRun(queued, { state: 'queued', pid: process.pid, created_at: stamp(15) });
  saveRun(running, { state: 'running', started_at: stamp(16) });
  for (let i = 1; i <= 7; i += 1) {
    saveSession(`consult-filler-${i}`, {
      created_at: stamp(i), updated_at: stamp(i), turns: [{ goal: `filler ${i}`, reply: 'ok' }],
    });
  }
  saveSession('unrelated', { turns: [{ goal: 'not a dispatch' }] });
  saveSession('consult-invalid', { mode: 'exec', turns: [{ goal: 'invalid mode' }] });
  writeFileSync(join(sessionsDir, 'exec-broken.json'), '{');
  writeFileSync(join(magpieConfigDir, 'usage.jsonl'), JSON.stringify({
    req: 'group/gempt-sonnet', served: 'codex/direct-marker', status: 200, t: stamp(18), session: consult,
  }) + '\n');

  const svc = await startServer({ port: 0, configPath, sessionsDir, magpieConfigDir,
    antigravityPluginDir: join(dir, 'agy'), probeTimeoutMs: 50 });
  t.after(() => svc.close());
  const page = await rawHttpGet({ port: svc.port, path: '/' });
  const key = page.text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];
  const headers = { 'x-gempt-key': key, Origin: 'null' };
  const get = (path, extra = {}) => rawHttpGet({ port: svc.port, path, headers: { ...headers, ...extra } });
  const json = async (path) => {
    const res = await get(path);
    assert.equal(res.status, 200, res.text);
    return JSON.parse(res.text);
  };
  const query = (path, options) => json(`${path}?${new URLSearchParams(options)}`);

  const all = await json('/api/requests?limit=100');
  assert.equal(all.total, 19);
  assert.equal(all.items.length, all.total);
  assert.deepEqual(all.items.slice(0, 3).map((r) => r.status), ['running', 'queued', 'outcome_unknown']);
  assert.equal(all.summary.total_tokens, 300);
  assert.equal(all.summary.failed, 2);
  assert.equal(all.summary.retried, 1);
  assert.deepEqual(all.facets.mode, [{ value: 'consult', count: 10 }, { value: 'exec', count: 9 }]);
  assert.equal(new Set(all.items.map((r) => r.id)).size, all.total);
  for (const id of [linked, legacyNative, saving]) {
    assert.equal(all.items.filter((r) => r.run_id === id).length, 1);
  }
  assert.equal(all.items.find((r) => r.run_id === saving).status, 'succeeded');
  assert.ok(all.items.every((r) => r.reply === undefined && r.prompt === undefined));
  const page2 = await json('/api/requests?limit=2&offset=2');
  assert.equal(page2.total, all.total);
  assert.deepEqual(page2.summary, all.summary);
  assert.deepEqual(page2.items, all.items.slice(2, 4));
  assert.deepEqual((await json('/api/requests?limit=0')).items, all.items.slice(0, 1));
  assert.equal((await json('/api/requests?limit=900&offset=500')).limit, 100);
  assert.equal((await json('/api/requests?offset=500')).items.length, 0);

  const filtered = await query('/api/requests', { search: 'CHECK PARSER', mode: 'exec', tier: 'sonnet',
    status: 'succeeded', workspace: beta });
  assert.deepEqual(filtered.items.map((r) => r.id), [`${exec}:1`]);
  assert.deepEqual(filtered.facets.workspace, [{ value: beta, count: 1 }]);
  assert.equal(filtered.summary.cache_read_tokens, 30);
  assert.equal((await json('/api/requests?status=retried')).total, 1);
  assert.equal((await json('/api/requests?q=direct-marker')).total, 0);
  assert.equal((await json('/api/sessions?q=direct-marker')).total, 0);
  const legacy = await json('/api/requests/consult-legacy%3A1');
  assert.equal(legacy.timestamp, stamp(8));
  assert.equal(legacy.elapsed_sec, null);
  assert.equal(legacy.usage.total_tokens, null);

  const detail = await json(`/api/requests/${encodeURIComponent(`${exec}:1`)}`);
  assert.equal(detail.title, '项目 beta · check parser');
  assert.equal(detail.reply, 'full exec response');
  assert.equal(detail.reply_is_preview, false);
  assert.equal(detail.run_id, linked);
  assert.equal(detail.elapsed_sec, 12);
  assert.equal(detail.usage.cache_hit_rate, .25);
  assert.deepEqual(detail.verification.checks, [command]);
  assert.deepEqual(detail.commands, [command]);
  const standalone = await json(`/api/requests/run-${failed}`);
  assert.equal(standalone.status, 'failed');
  assert.equal(standalone.goal, 'standalone failure');
  assert.equal(standalone.error, 'failed to start');

  const sessions = await json('/api/sessions?limit=2&offset=1');
  assert.equal(sessions.total, 11);
  assert.equal(sessions.summary.requests, 15);
  assert.equal(sessions.items.length, 2);
  assert.ok(sessions.items.every((row) => !('turns' in row)));
  const narrowed = await query('/api/sessions', { q: 'SECOND REPLY', mode: 'consult', tier: 'sonnet',
    model: 'codex/alpha', workspace: alpha });
  assert.deepEqual(narrowed.items.map((row) => row.id), [consult]);
  assert.equal(narrowed.items[0].title, 'project alpha · first goal');
  assert.equal(narrowed.items[0].turn_count, 2);
  assert.equal(narrowed.items[0].usage.total_tokens, 75);

  const transcript = await json(`/api/sessions/${consult}`);
  assert.equal(transcript.turns[0].prompt, '## Goal\nfirst goal\n\n## Context\nfull context');
  assert.equal(transcript.turns[1].reply, rawReply);
  assert.deepEqual(transcript.turns.map((row) => row.elapsed_sec), [1.5, 3]);
  assert.deepEqual(transcript.runs, []);
  const execSession = await json(`/api/sessions/${exec}`);
  assert.equal(execSession.title, '解析器 检查');
  assert.equal(readActiveRuns(sessionsDir).find((run) => run.run_id === saving).title, '短任务名');
  assert.equal(execSession.turn_count, 4);
  assert.deepEqual(execSession.turns.map((row) => [row.turn, row.run_id, row.status]), [
    [1, linked, 'succeeded'], [2, legacyNative, 'succeeded'], [3, saving, 'succeeded'], [null, resumed, 'failed'],
  ]);
  assert.equal(execSession.turns[1].verification.requested, 'node --check app.js');
  assert.equal(execSession.turns[1].reply, 'native response');
  assert.deepEqual(new Set(execSession.runs.map((row) => row.run_id)), new Set([linked, legacyNative, saving, resumed]));
  assert.equal((await json('/api/sessions/exec-orphan')).turns[0].run_id, runOnly);

  const state = await json('/api/state');
  assert.deepEqual(state.activity_totals, { requests: 19, sessions: 11, runs: 9 });
  assert.equal(state.recent_group_calls[0].req, 'group/gempt-sonnet');
  assert.equal(state.recent_runs.length, 6);
  assert.ok(state.recent_sessions.length <= 6);
});

async function activityFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-history-parity-'));
  const sessionsDir = join(dir, 'sessions');
  const magpieConfigDir = join(dir, 'magpie');
  const configPath = join(dir, 'config.json');
  const usageFile = join(magpieConfigDir, 'usage.jsonl');
  mkdirSync(join(sessionsDir, 'runs'), { recursive: true });
  mkdirSync(magpieConfigDir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (file, data) => writeFileSync(file, JSON.stringify(data));
  const putLines = (file, rows) => writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return {
    usageFile,
    session: (id, data) => put(join(sessionsDir, `${id}.json`), { session_id: id, ...data }),
    run: (id, data, events) => {
      const directory = join(sessionsDir, 'runs', id);
      mkdirSync(directory);
      put(join(directory, 'state.json'), { run_id: id, ...data });
      const journal = join(directory, 'events.jsonl');
      putLines(journal, events);
      return journal;
    },
    ledger: (rows) => putLines(usageFile, rows),
    start: async (base_url = 'http://127.0.0.1:1') => {
      put(configPath, { magpie: { base_url } });
      const svc = await startServer({ port: 0, configPath, sessionsDir, magpieConfigDir });
      t.after(() => svc.close());
      const page = await rawHttpGet({ port: svc.port, path: '/' });
      const headers = { 'x-gempt-key': page.text.match(/<meta name="gempt-key" content="([^"]+)">/)[1], Origin: 'null' };
      const get = (path) => rawHttpGet({ port: svc.port, path, headers });
      const json = async (path) => {
        const res = await get(path);
        assert.equal(res.status, 200, res.text);
        return JSON.parse(res.text);
      };
      return { get, json, query: (kind, params) => json(`/api/${kind}?${new URLSearchParams(params)}`) };
    },
  };
}

test('gateway calls enrich GemPT turns one-to-many, isolate routes and reuse a growing ledger', async (t) => {
  const f = await activityFixture(t);
  const stamp = (second) => new Date(Date.UTC(2026, 9, 15, 12, 0, second)).toISOString();
  const model = 'codex/original';
  const thread = 'codex-thread-test';
  f.session('exec-gateway', { mode: 'exec', model, codex_thread_id: thread, turns: [
    { goal: 'first turn', timestamp: stamp(20), elapsed_sec: 10 },
    { goal: 'second turn', timestamp: stamp(40), elapsed_sec: 10 },
  ] });
  f.session('consult-gateway', { mode: 'consult', model, turns: [
    { goal: 'primary consult', timestamp: stamp(50), elapsed_sec: 5, response_id: 'resp-consult' },
    { goal: 'legacy consult', timestamp: stamp(57), elapsed_sec: 4, usage: { input_tokens: 120, output_tokens: 12 } },
  ] });
  const base = { agent: 'gempt', req: model, model: 'sent-actual', served: 'served-actual',
    provider: 'codex', providerAccount: 'one', ep: '/v1/responses', status: 200 };
  const row = (route_id, time, extra) => ({ ...base, route_id, t: stamp(time), ...extra });
  const first = row(1001, 13, { session: thread, native_session: thread, in: 80, out: 15, reasoning: 5,
    cache_read: 20, cache_write: 4, ttft_ms: 100, ms: 1100, cost: 0.125 });
  const second = row(1002, 19, { native_session: thread, providerAccount: 'two', in: 60, out: 40,
    cache_read: 40, cache_write: 6, ttft_ms: 200, first_text_ms: 400, ms: 2400 });
  f.ledger([first, second,
    row(1003, 31, { session_id: thread, cache_write: 0, cost_usd: .5, tokens_per_sec: 9 }),
    row(1004, 13, { session: 'other-thread', cost: 44 }),
    row(1005, 17, { session: thread, req: 'group/gempt-sonnet', cost: 44 }),
    row(1006, 43, { session: thread, cost: 44 }),
    row(1007, 17, { session: thread, agent: 'codex', ep: '/backend-api/codex/responses', cost: 44 }),
    row(1008, 48, { status: 429, cost: .01 }),
    row(1009, 49, { response_id: 'resp-consult', agent: 'http', cost: .1 }),
    row(1010, 49, { response_id: 'other-response', cost: 44 }),
    row(1011, 55, { agent: 'Python-urllib', response_id: 'old-consult', in: 100, cache_read: 20, out: 12, cost: .2 }),
    row(1012, 55, { agent: 'Python-urllib', response_id: 'unrelated-consult', in: 100, cache_read: 20, out: 22, cost: 44 }),
    row(1014, 34, { ws: true, cost: 0 }),
    row(1015, 34, { ws: true, req: 'codex/wrong-model', cost: 44 }),
  ]);
  let nativeCalls = 0;
  const magpie = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/v1/magpie/usage/requests' || url.searchParams.get('agent') !== 'gempt') {
      res.writeHead(404).end();
      return;
    }
    nativeCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ total: 2, rows: [{ ...second, t: stamp(18), cost: 44 }, { ...second, cost: .375, priced: true }] }));
  });
  await new Promise((resolve) => magpie.listen(0, '127.0.0.1', resolve));
  t.after(() => magpie.close());
  const { json, query } = await f.start(`http://127.0.0.1:${magpie.address().port}`);
  const listing = await json('/api/requests');
  assert.equal(listing.total, 4);
  assert.equal(listing.summary.cost_usd, 1.31);
  assert.ok(listing.items.every((row) => !('gateway_requests' in row)));
  const r = listing.items.find((row) => row.id === 'exec-gateway:1');
  assert.deepEqual([r.requested_model, r.provider, r.account, r.sent_model, r.usage.cache_write_tokens, r.cost_usd, r.ttft_ms],
    [model, 'codex', 'one / two', 'sent-actual', 10, .5, 100]);
  assert.equal(r.provider_accounts, 'codex · one / codex · two');
  assert.ok(Math.abs(r.usage.cache_hit_rate - 60 / 210) < 1e-10);
  assert.equal(r.tokens_per_sec, 50 / 3);
  assert.equal(r.gateway_request_count, 2);

  const detail = await json('/api/requests/exec-gateway%3A1');
  assert.deepEqual(detail.gateway_requests.map((call) => [call.route_id, call.timestamp, call.status_code,
    call.duration_ms, call.output_tokens, call.cost_usd, call.tokens_per_sec]), [
    [1001, stamp(13), 200, 1100, 15, .125, 10],
    [1002, stamp(19), 200, 2400, 40, .375, 20],
  ]);
  const session = await json('/api/sessions/exec-gateway');
  assert.equal(session.cost_usd, 1);
  assert.deepEqual(session.turns.map((turn) => turn.gateway_requests.map((call) => call.route_id)), [[1001, 1002], [1003, 1014]]);
  assert.equal(session.gateway_requests.length, 4);
  const consult = await json('/api/sessions/consult-gateway');
  assert.deepEqual(consult.turns.map((turn) => turn.gateway_requests.map((call) => call.route_id)), [[1008, 1009], [1011]]);
  const scoped = await query('sessions', { from: stamp(15), to: stamp(25) });
  assert.deepEqual(scoped.items.map(({ id, turn_count }) => [id, turn_count]), [['exec-gateway', 1]]);
  assert.equal(scoped.summary.cost_usd, .5);
  assert.equal(scoped.summary.cache_hit_rate, 60 / 210);
  assert.equal(nativeCalls, 1);

  const appended = JSON.stringify(row(1013, 18, { session: thread, cost: .25 }));
  appendFileSync(f.usageFile, appended.slice(0, 20));
  assert.equal((await json('/api/requests/exec-gateway%3A1')).gateway_requests.length, 2);
  appendFileSync(f.usageFile, appended.slice(20) + '\n');
  assert.equal((await json('/api/requests/exec-gateway%3A1')).cost_usd, .75);
  f.ledger([first]);
  assert.equal((await json('/api/sessions/exec-gateway')).cost_usd, .125);
});

test('request and session time presets and explicit bounds scope KPIs and CSV exports all filtered rows safely', async (t) => {
  const f = await activityFixture(t);
  const now = Date.now();
  const hour = 3_600_000;
  const midnight = new Date().setHours(0, 0, 0, 0);
  const combined = '=SUM(1,2),"quoted"\nsecond line';
  const dates = [new Date(midnight).toISOString(), ...[25, 6 * 24, 10 * 24, 35 * 24].map((ago) => new Date(now - ago * hour).toISOString())];
  dates.forEach((timestamp, index) => f.session(`consult-date-${index}`, {
    mode: 'consult', turns: [{ timestamp, title: index === 0 ? '＝2+2' : `test-${index}`,
      goal: index === 0 ? combined : 'filtered export', agent: index === 0 ? '\tplain' : 'CLI',
      cost_usd: index + 1, usage: { input_tokens: 100, cached_input_tokens: 25 } }],
  }));
  const { get, query } = await f.start();
  for (const kind of ['requests', 'sessions']) {
    for (const [range, count, cost] of [['today', 1, 1], ['24h', 1, 1], ['7d', 3, 6], ['30d', 4, 10], ['all', 5, 15]]) {
      const data = await query(kind, { range, limit: 1 });
      assert.equal(data.total, count, range);
      assert.equal(data.summary.cost_usd, cost, range);
      assert.equal(data.summary.cache_hit_rate, .25, range);
    }
    const exact = await query(kind, { from: dates[2], to: dates[2] });
    assert.equal(exact.total, 1);
    assert.equal(exact.summary.cost_usd, 3);
    for (const invalid of ['range=yesterday', 'from=invalid', `from=${encodeURIComponent(dates[0])}&to=${encodeURIComponent(dates[4])}`]) {
      assert.equal((await get(`/api/${kind}?${invalid}`)).status, 400);
    }
  }
  const filtered = await get('/api/requests?format=csv&range=7d&limit=1&offset=70');
  assert.equal(filtered.status, 200);
  assert.match(filtered.headers['content-type'], /^text\/csv\b/);
  assert.equal(filtered.text.charCodeAt(0), 0xFEFF);
  assert.match(filtered.text, /"'＝2\+2"/);
  assert.ok(filtered.text.includes(`"'=SUM(1,2),""quoted""\nsecond line","consult","'\tplain"`));
  const ids = [...filtered.text.matchAll(/"consult-date-\d:1"/g)].map(([id]) => id);
  assert.deepEqual(ids, ['"consult-date-0:1"', '"consult-date-1:1"', '"consult-date-2:1"']);
  const searched = await get('/api/requests?format=csv&range=7d&q=quoted');
  assert.doesNotMatch(searched.text, /consult-date-[1-4]/);
  assert.match(searched.text, /consult-date-0/);
});

test('activity details fold raw app-server events into a bounded turn timeline', async (t) => {
  const f = await activityFixture(t);
  const id = '9'.repeat(32);
  const stamp = '2026-11-04T10:00:00Z';
  const threadId = 'trace-thread';
  const turnId = 'trace-turn';
  f.session('exec-trace', { mode: 'exec', turns: [{ timestamp: stamp, run_id: id, goal: 'trace goal' }] });
  const event = (method, fields, extra) => ({ method, params: { threadId, turnId, ...fields }, ...extra });
  const item = (entry) => event('item/completed', { item: entry });
  const journal = f.run(id, { session_id: 'exec-trace', state: 'finished', codex_thread_id: threadId,
    turn_id: turnId, finished_at: stamp }, [
    { method: 'noise', text: 'A'.repeat(800 * 1024) },
    event('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'Plan ' }),
    event('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'tests' }),
    item({ type: 'reasoning', id: 'r', summary: ['Plan tests'], content: ['private reasoning'] }),
    item({ type: 'agentMessage', id: 'mid', text: 'tests running', phase: 'commentary' }),
    event('item/started', { item: { type: 'commandExecution', id: 'c', command: 'node --test' } }),
    event('item/commandExecution/outputDelta', { itemId: 'c', delta: 'partial' }),
    item({ type: 'commandExecution', id: 'c', exitCode: 2, aggregatedOutput: 'test output' }),
    item({ type: 'fileChange', id: 'f', changes: [{ path: 'lib/trace.js', diff: 'large diff' }] }),
    event('item/tool/call', { tool: 'ask_gemini', callId: 'ask', arguments: { question: 'Verify UI', reason: 'visual_check' } }, { id: 99 }),
    event('serverRequest/resolved', { requestId: 99 }),
    event('item/agentMessage/delta', { itemId: 'false', turnId: 'some-other-turn', delta: 'unrelated event' }),
    event('item/agentMessage/delta', { itemId: 'last', delta: 'done fragment' }),
    item({ type: 'agentMessage', id: 'last', text: 'completed reply' }),
  ]);
  appendFileSync(journal, '{"method": incomplete');
  const { json } = await f.start();
  const detail = await json('/api/requests/exec-trace%3A1');
  assert.equal(detail.timeline_truncated, true);
  assert.deepEqual(detail.timeline.map(({ type }) => type), ['reasoning', 'agent_message', 'command', 'files', 'ask_gemini', 'agent_message']);
  const [reasoning, message, command, files, ask, final] = detail.timeline;
  assert.deepEqual(reasoning, { type: 'reasoning', id: 'r:0', text: 'Plan tests' });
  assert.equal(message.phase, 'commentary');
  assert.equal(message.text, 'tests running');
  assert.deepEqual(command, { type: 'command', id: 'c', command: 'node --test', exit_code: 2, output: 'test output' });
  assert.deepEqual(files.paths, ['lib/trace.js']);
  assert.equal(ask.status, 'resolved');
  assert.equal(ask.arguments.question, 'Verify UI');
  assert.equal(final.phase, 'final_answer');
  assert.equal(final.text, 'completed reply');
  assert.deepEqual((await json('/api/sessions/exec-trace')).turns[0].timeline, detail.timeline);
});

test('history routes enforce loopback host, origin, authorization and opaque detail IDs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-history-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const svc = await startServer({ port: 0, sessionsDir: dir });
  t.after(() => svc.close());
  const page = await rawHttpGet({ port: svc.port, path: '/' });
  const key = page.text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];
  const get = (path, extra = {}) => rawHttpGet({ port: svc.port, path, headers: { 'x-gempt-key': key, ...extra } });
  for (const [route, valid] of [['requests', 'consult-missing%3A1'], ['sessions', 'exec-missing']]) {
    const base = `/api/${route}`;
    assert.equal((await get(base, { 'x-gempt-key': 'incorrect' })).status, 401);
    assert.equal((await get(`${base}/${valid}`, { Host: 'example.test' })).status, 403);
    assert.equal((await get(`${base}/${valid}`, { Origin: 'https://example.test' })).status, 403);
    assert.equal((await get(`${base}/${valid}`)).status, 404);
    for (const malformed of ['', '..', '%2e%2e', '../state', 'exec-ok%2Fstate', 'exec-ok%5Cstate', '%00', '%ZZ', 'exec-a..b']) {
      assert.equal((await get(`${base}/${malformed}`)).status, 400, `${route}: ${malformed}`);
    }
    const empty = JSON.parse((await get(base)).text);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
  }
});

test('native Magpie tools: discover, status, consult (zero-config + resume + security), and exec (default-off + sandbox + resume)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-tools-test-'));
  const magpie = await startMockMagpie();
  const cfgDir = join(dir, 'gempt-cfg');
  const cfgPath = join(cfgDir, 'config.json');
  const sessDir = join(dir, 'sessions');
  const magpieDir = join(dir, 'magpie-cfg');
  const repoDir = join(dir, 'workspace');
  const outsideDir = join(dir, 'outside');
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(magpieDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(repoDir, 'app.py'), 'def solve():\n    return 42\n', 'utf-8');
  writeFileSync(join(repoDir, '.env'), 'SECRET_TOKEN=nope\n', 'utf-8');
  writeFileSync(join(repoDir, 'private.pem'), 'PRIVATE KEY\n', 'utf-8');
  writeFileSync(join(outsideDir, 'secret.txt'), 'outside\n', 'utf-8');

  const app = await startMockAppServer();
  const appState = join(dir, 'app-server-connection.json');
  const env = { ...process.env, GEMPT_APP_SERVER_STATE: appState };
  writeFileSync(appState, JSON.stringify({ ws_url: app.url, status: 'running', auth_token: 'fixture-capability',
    auth_header: 'Authorization', gateway_url: magpie.url }));

  const prevMagpieAddr = process.env.MAGPIE_ADDR;
  const prevProxy = process.env.HTTP_PROXY;
  process.env.MAGPIE_ADDR = magpie.url;
  process.env.HTTP_PROXY = 'http://127.0.0.1:9999';

  try {
    const defaultTools = createExecutionTools({
      configPath: cfgPath,
      sessionsDir: sessDir,
      magpieConfigDir: magpieDir,
      antigravityPluginDir: join(dir, 'missing-agy'),
      env,
      options: { exec: false },
    });

    const disc = await defaultTools.discover.execute({});
    assert.equal(disc.configured, false);
    assert.equal(disc.exec_enabled, false);
    assert.equal(disc.magpie.reachable, true);
    assert.ok(disc.magpie.codex_models.includes('codex/gpt-6.2-sol'));
    assert.equal(disc.codex_cli.found, true);

    const st = await defaultTools.status.execute({ session_limit: 3 });
    assert.equal(st.tools.enabled, true);
    assert.equal(st.tools.exec_enabled, false);

    // Zero-config consult with subscription auto-plan + file attachment + agent attribution
    const c1 = await defaultTools.consult.execute(
      {
        goal: 'Review solve function',
        tier: 'opus',
        escalate: true,
        cwd: repoDir,
        file_paths: ['app.py'],
      },
      { agent: 'zcode' },
    );
    assert.equal(c1.config_source, 'auto_subscription');
    assert.equal(c1.model, 'codex/gpt-6.2-astra');
    assert.equal(c1.reasoning_effort, 'xhigh');
    assert.equal(c1.agent, 'zcode');
    assert.match(magpie.requests[0].body.input[0].content, /1: def solve\(\):/);
    assert.equal(magpie.requests[0].body.reasoning.effort, 'xhigh');

    // Consult multi-turn resume & chore routing
    const c2 = await defaultTools.consult.execute({ goal: 'Follow up question', session_id: c1.session_id }, { agent: 'claude' });
    assert.equal(c2.session_id, c1.session_id);
    assert.equal(magpie.requests[1].body.input.length, 3);
    const consultHistory = JSON.parse(readFileSync(join(sessDir, `${c1.session_id}.json`), 'utf8'));
    assert.equal(consultHistory.turn_details[1].agent, 'zcode');
    assert.ok(consultHistory.turn_details[1].response_id);
    assert.equal(consultHistory.turn_details[2].goal, 'Follow up question');
    assert.deepEqual(consultHistory.turn_details[2].usage, c2.usage);

    const cChore = await defaultTools.consult.execute({ goal: 'Summarize logs', tier: 'chore' }, { agent: 'zcode' });
    assert.equal(cChore.model, 'auto/deepseek-v4.1-flash');
    assert.equal(magpie.requests[2].path, '/v1/chat/completions');

    // Security rejections on consult
    await assert.rejects(
      () => defaultTools.consult.execute({ goal: 'Read env', cwd: repoDir, file_paths: ['.env'] }),
      /secret-shaped/i,
    );
    await assert.rejects(
      () => defaultTools.consult.execute({ goal: 'Read pem', cwd: repoDir, file_paths: ['private.pem'] }),
      /secret-shaped/i,
    );
    await assert.rejects(
      () => defaultTools.consult.execute({ goal: 'Escape', cwd: repoDir, file_paths: ['../outside/secret.txt'] }),
      /outside workspace/i,
    );
    await assert.rejects(
      () => defaultTools.consult.execute({ goal: 'Home root', cwd: homedir(), file_paths: ['app.py'] }),
      /blocked workspace/i,
    );
    await assert.rejects(
      () => defaultTools.consult.execute({ goal: 'Magpie dir', cwd: magpieDir, file_paths: ['x'] }),
      /sensitive directory/i,
    );
    await assert.rejects(
      () => defaultTools.consult.execute({ goal: 'GemPT cfg dir', cwd: cfgDir, file_paths: ['x'] }),
      /sensitive directory/i,
    );

    // exec must fail cleanly when default-disabled
    await assert.rejects(
      () => defaultTools.exec.execute({ goal: 'Edit', cwd: repoDir }),
      /disabled by default/i,
    );

    // Enable exec via plugin option and configure host default_sandbox='workspace-write'
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        magpie: { base_url: magpie.url },
        codex: { default_sandbox: 'workspace-write' },
        routing_policy: { default_tier: 'opus', failover_mode: 'subscription_only', auto_effort: true },
        tiers: {
          sonnet: { consult_model: 'codex/gpt-6.2-sol', exec_model: 'codex/gpt-6.2-sol', reasoning_effort: 'medium' },
          opus: { consult_model: 'codex/gpt-6.2-sol', exec_model: 'codex/gpt-6.2-sol', escalate_model: 'codex/gpt-6.2-astra', escalate_effort_threshold: 'xhigh', reasoning_effort: 'high' },
          fable: { consult_model: 'codex/gpt-6.2-astra', exec_model: 'codex/gpt-6.2-astra', reasoning_effort: 'xhigh' },
        },
        utility: { model: 'auto/deepseek-v4.1-flash', api_mode: 'chat' },
      }),
      'utf-8',
    );

    const enabledTools = createExecutionTools({
      configPath: cfgPath,
      sessionsDir: sessDir,
      magpieConfigDir: magpieDir,
      antigravityPluginDir: join(dir, 'missing-agy'),
      options: { exec: true }, env,
    });


    assert.equal(enabledTools.dispatch, undefined);
    const consult = enabledTools.consult.execute;
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const hydrogenTask = { goal: 'Design a form', gemini_family: 'hydrogen' };
    const initial = await consult({ ...hydrogenTask, title: '  表单\n设计 ', host_conversation_id: 'consult-host' });
    assert.equal(initial.tier, 'paired:hydrogen');
    assert.equal(initial.auto_effort?.effort, initial.reasoning_effort);
    const titledConsult = JSON.parse(readFileSync(join(sessDir, `${initial.session_id}.json`), 'utf8'));
    assert.equal(titledConsult.title, '表单 设计');
    assert.equal(titledConsult.host_conversation_id, 'consult-host');
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.1-terra');
    config.routing_policy.pairings = { hydrogen: 'codex/gpt-6-luna' };
    writeFileSync(cfgPath, JSON.stringify(config));
    await enabledTools.consult.execute({ goal: 'Continue', session_id: initial.session_id });
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.1-terra');
    await consult(hydrogenTask);
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6-luna');
    const explicitFable = await consult({ ...hydrogenTask, tier: 'fable' });
    assert.equal(explicitFable.tier, 'fable');
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.2-astra');
    const astra = await consult({ goal: 'Return a short answer', gemini_family: 'carbon', reasoning_effort: 'low' });
    assert.equal(astra.tier, 'paired:carbon');
    assert.equal(astra.reasoning_effort, 'medium');
    assert.equal(magpie.requests.at(-1).body.reasoning.effort, 'medium');

    // Reject widening sandbox above config host ceiling
    await assert.rejects(
      () => enabledTools.exec.execute({ goal: 'Widen', cwd: repoDir, sandbox: 'danger-full-access' }),
      /cannot increase/i,
    );

    // Tighten sandbox to read-only and verify mock codex invocation + thread resume
    const e1 = await enabledTools.exec.execute(
      { goal: 'Inspect repo', cwd: repoDir, sandbox: 'read-only', title: '  核对\n工作区 ', host_conversation_id: 'exec-host' },
      { agent: 'opencode' },
    );
    assert.equal(e1.sandbox, 'read-only');
    assert.equal(e1.codex_thread_id, '01900000-0000-7000-8000-000000000001');
    assert.equal(e1.agent, 'opencode');
    assert.match(e1.summary, /codex_thread=01900000-0000-7000-8000-000000000001/);

    // Cannot widen sandbox or switch workspace on resume
    await assert.rejects(
      () => enabledTools.exec.execute({ goal: 'Widen resume', cwd: repoDir, session_id: e1.session_id, sandbox: 'workspace-write' }),
      /cannot increase/i,
    );
    await assert.rejects(
      () => enabledTools.exec.execute({ goal: 'Move cwd', cwd: outsideDir, session_id: e1.session_id }),
      /original workspace/i,
    );

    const e2 = await enabledTools.exec.execute(
      { goal: 'Continue in same repo', cwd: repoDir, session_id: e1.session_id },
      { agent: 'opencode' },
    );
    const execHistory = JSON.parse(readFileSync(join(sessDir, `${e2.session_id}.json`), 'utf8'));
    assert.equal(execHistory.title, '核对 工作区');
    assert.equal(execHistory.host_conversation_id, 'exec-host');
    const resumedState = JSON.parse(readFileSync(join(sessDir, 'runs', e2.run_id, 'state.json'), 'utf8'));
    assert.equal(resumedState.title, 'workspace · Continue in same re…');
    assert.equal(resumedState.host_conversation_id, 'exec-host');
    assert.equal(execHistory.turn_details[2].run_id, e2.run_id);
    assert.deepEqual(execHistory.turn_details[2].commands, e2.commands);
    assert.equal(e2.session_id, e1.session_id);

    const codexCalls = app.packets.filter((p) => p.method === 'turn/start');
    assert.equal(codexCalls.length, 2);
    assert.match(codexCalls[0].params.input[0].text, /## Goal\nInspect repo/);
    assert.equal(codexCalls[0].params.sandboxPolicy.type, 'readOnly');
    assert.equal(app.packets.find((p) => p.method === 'thread/resume').params.threadId, MOCK_THREAD);
    assert.equal(codexCalls[1].params.threadId, MOCK_THREAD);

    // A receipt survives a new tool instance and repeat delivery never launches a second worker.
    const job = { goal: 'Edit one file', cwd: repoDir, run_id: '3'.repeat(32), background: true };
    const first = await enabledTools.exec.execute(job);
    assert.equal(first.run_id, job.run_id);
    const reconnected = createExecutionTools({ sessionsDir: sessDir, configPath: cfgPath, options: { exec: true }, env });
    const finished = await reconnected.status.execute({ run_id: job.run_id, wait_sec: 5 });
    assert.equal(finished.state, 'finished', finished.error);
    assert.equal(finished.result.sandbox, 'workspace-write');
    const replay = await reconnected.exec.execute(job);
    assert.equal(replay.session_id, finished.result.session_id);
    assert.equal(app.packets.filter((p) => p.method === 'turn/start').length, codexCalls.length + 1);
    await assert.rejects(reconnected.exec.execute({ ...job, cwd: outsideDir }), /different workspace/);
    await assert.rejects(reconnected.status.execute({ run_id: '../wrong' }), /Invalid run_id/);

    config.routing_policy.mcp_effort = 'xhigh';
    config.routing_policy.auto_effort = false;
    writeFileSync(cfgPath, JSON.stringify(config));
    const pairedExec = await enabledTools.exec.execute({ ...hydrogenTask, sandbox: 'read-only', cwd: repoDir });
    assert.equal(pairedExec.model, 'codex/gpt-6-luna');
    assert.equal(pairedExec.tier, 'paired:hydrogen');
    assert.equal(pairedExec.reasoning_effort, 'xhigh');
    assert.equal(app.packets.findLast((p) => p.method === 'turn/start').params.model, 'codex/gpt-6-luna');
    assert.equal(app.packets.findLast((p) => p.method === 'turn/start').params.effort, 'xhigh');
    config.routing_policy.auto_effort = true;
    writeFileSync(cfgPath, JSON.stringify(config));

    const waiting = await enabledTools.exec.execute({ goal: 'Ask Gemini', cwd: repoDir });
    assert.equal(waiting.state, 'waiting_gemini');
    assert.equal(waiting.progress.last_message, 'live drafting');
    assert.equal(waiting.pending_tool_call.call_id, 'call_native');
    const runDirectory = join(sessDir, 'runs', waiting.run_id);
    assert.match(readFileSync(join(runDirectory, 'events.jsonl'), 'utf8'), /item\/tool\/call/);
    mkdirSync(join(runDirectory, 'tool_replies'));
    writeFileSync(join(runDirectory, 'tool_replies', 'call_native.json'), JSON.stringify({ answer: 'Proceed', success: true }));
    const done = await eventually(async () => {
      const state = await enabledTools.status.execute({ run_id: waiting.run_id });
      return state.state === 'finished' && state;
    });
    assert.equal(done.session_id, waiting.session_id);
    assert.equal(done.turn_id, waiting.progress.turn_id);
    assert.deepEqual(app.packets.find((p) => p.id === 'tool-rpc' && p.result).result,
      { success: true, contentItems: [{ type: 'inputText', text: 'Proceed' }] });

    // Auto-effort escalates complex Opus consult to Astra@xhigh and preserves on resume
    const autoHard = await enabledTools.consult.execute({
      goal: 'Diagnose deadlock and race condition in distributed scheduler state machine',
      tier: 'opus',
    });
    assert.equal(autoHard.model, 'codex/gpt-6.2-astra');
    assert.equal(autoHard.reasoning_effort, 'xhigh');
    assert.equal(autoHard.escalated, true);
    assert.equal(autoHard.auto_effort?.effort, 'xhigh');

    const autoResume = await enabledTools.consult.execute({
      goal: 'Summarize root cause',
      session_id: autoHard.session_id,
    });
    assert.equal(autoResume.reasoning_effort, 'xhigh');
    assert.equal(autoResume.auto_effort, null);

    const host = { configPath: cfgPath, sessionsDir: sessDir, magpieConfigDir: magpieDir,
      env: { ...env, GEMPT_MAGPIE_TOOLS_EXEC: '0', GEMPT_GPT_RUN_SYNC_SEC: '0' } };
    const unified = createGemptTools(host);
    assert.deepEqual(Object.keys(unified).sort(), ['ask', 'ctl', 'run']);
    for (const { name, inputSchema } of TOOLS.slice(0, 3)) {
      assert.deepEqual(unified[name.slice(4)].args, inputSchema);
    }
    for (const access of [undefined, 'change']) {
      await assert.rejects(unified.run.execute({ access, goal: 'Edit', cwd: repoDir }), /disabled/);
    }
    const inspection = await unified.run.execute({ access: 'inspect', goal: 'Inspect the project', cwd: repoDir });
    assert.ok(inspection.wait_command);
    const inspected = await waitForRun(inspection.run_id, { sessionsDir: sessDir, timeoutSec: 5 });
    assert.equal(inspected.state, 'finished', inspected.error);
    assert.equal(inspected.sandbox, 'read-only');
    const ask = await unified.ask.execute({ goal: 'Review the project', cwd: repoDir, tier: 'sonnet' });
    assert.ok(ask.text && ask.session_id);
    const status = await unified.ctl.execute({ action: 'status', run_id: inspection.run_id });
    assert.equal(status.st, 'finished');
    const writable = createGemptTools({ ...host, options: { exec: true } });
    const change = await writable.run.execute({ access: 'change', goal: 'Normal change', cwd: repoDir });
    assert.equal((await waitForRun(change.run_id, { sessionsDir: sessDir, timeoutSec: 5 })).state, 'finished');
  } finally {
    if (prevMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
    else process.env.MAGPIE_ADDR = prevMagpieAddr;
    if (prevProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = prevProxy;
    await app.close();
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native tool.consult fails over to openai/* backup on HTTP 429 when failover_mode is api_fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-tools-fallback-'));
  const magpie = await startMockMagpie(undefined, {
    onRequest: (_path, body) => {
      if (body.model === 'codex/gpt-6.2-sol') {
        return { status: 429, json: { error: { message: 'subscription rate limited' } } };
      }
      return null;
    },
  });

  const cfgDir = join(dir, 'gempt-cfg');
  const cfgPath = join(cfgDir, 'config.json');
  const sessDir = join(dir, 'sessions');
  const magpieDir = join(dir, 'magpie-cfg');
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(magpieDir, { recursive: true });

  writeFileSync(
    cfgPath,
    JSON.stringify({
      version: 1,
      magpie: { base_url: magpie.url },
      codex: { default_sandbox: 'workspace-write' },
      routing_policy: { default_tier: 'sonnet', failover_mode: 'api_fallback' },
      tiers: {
        sonnet: {
          consult_model: 'codex/gpt-6.2-sol',
          exec_model: 'codex/gpt-6.2-sol',
          reasoning_effort: 'medium',
          fallback_models: ['openai/gpt-6.1-sol'],
        },
        opus: {
          consult_model: 'codex/gpt-6.2-sol',
          escalate_model: 'codex/gpt-6.2-astra',
          fallback_models: ['openai/gpt-6.1-sol'],
        },
        fable: {
          consult_model: 'codex/gpt-6.2-astra',
          fallback_models: ['openai/gpt-6-astra'],
        },
      },
      utility: { model: 'auto/deepseek-v4.1-flash', api_mode: 'chat' },
    }),
    'utf-8',
  );

  try {
    const tools = createExecutionTools({
      configPath: cfgPath,
      sessionsDir: sessDir,
      magpieConfigDir: magpieDir,
      antigravityPluginDir: join(dir, 'missing-agy'),
    });
    const disc = await tools.discover.execute({});
    assert.equal(disc.failover_mode, 'api_fallback');
    assert.equal(disc.api_fallback_available, true);
    assert.ok(disc.magpie.openai_models.includes('openai/gpt-6.1-sol'));

    const res = await tools.consult.execute({ goal: 'Test 429 failover', tier: 'sonnet' }, { agent: 'claude' });
    assert.deepEqual(res.attempted_models, ['codex/gpt-6.2-sol', 'openai/gpt-6.1-sol']);
    assert.equal(res.model, 'openai/gpt-6.1-sol');
    assert.equal(res.served_model, 'openai/gpt-6.1-sol');
    assert.equal(res.agent, 'claude');
    assert.match(res.text, /mock-responses:openai\/gpt-6\.1-sol/);
  } finally {
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared app-server manager reports missing Codex CLI without scheduling retries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-no-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const managerUrl = pathToFileURL(join(REPO_ROOT, 'magpie_plugin', 'lib', 'app-server-manager.mjs')).href;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { createAppServerManager } from ${JSON.stringify(managerUrl)};
    let scheduled = 0;
    const backoffMs = [10];
    Object.defineProperty(backoffMs, '0', { get() { scheduled++; return 10; } });
    const manager = createAppServerManager({
      configPath: ${JSON.stringify(join(dir, 'config.json'))},
      env: { GEMPT_APP_SERVER_STATE: ${JSON.stringify(join(dir, 'state.json'))} },
      backoffMs,
      spawnProcess: () => assert.fail('Codex CLI should not be spawned'),
    });
    try {
      const state = await manager.ensureRunning();
      assert.equal(state.running, false);
      assert.match(state.error, /未找到 Codex CLI.*gempt_ask/);
      await sleep(50);
      assert.deepEqual(manager.getStatus(), state);
      assert.equal(scheduled, 0);
    } finally {
      await manager.stop();
    }
  `], { timeout: 10_000, windowsHide: true, env: { ...process.env, HOME: dir, USERPROFILE: dir } });
});

test('shared app-server manager launches once, authenticates, restarts and serves live run controls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-app-server-'));
  const configDir = join(dir, 'cfg');
  mkdirSync(configDir);
  const configPath = join(configDir, 'config.json');
  const sessionsDir = join(dir, 'sessions');
  const statePath = join(dir, 'explicit-state.json');
  const gateway = await startMockMagpie();
  writeFileSync(configPath, JSON.stringify({ codex: { cli_path: process.execPath },
    magpie: { base_url: gateway.url } }));
  const children = [];
  const env = { ...process.env, GEMPT_APP_SERVER_STATE: statePath,
    CODEX_SESSION_ID: 'desktop-test', CODEX_WINDOWS_REGISTERED_CORE: 'desktop-test' };
  const choices = { configPath, env, backoffMs: [20, 40], spawnProcess(bin, args, opts) {
    assert.equal(bin, process.execPath);
    assert.deepEqual(args.slice(0, 2), ['app-server', '--listen']);
    assert.ok(args.includes('capability-token'));
    assert.ok(args.includes('model_providers.gempt_gateway.base_url=' + JSON.stringify(gateway.url + '/v1')));
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.env.NO_PROXY, '127.0.0.1,localhost,::1');
    assert.equal(opts.env.CODEX_SESSION_ID, undefined);
    assert.equal(opts.env.CODEX_WINDOWS_REGISTERED_CORE, undefined);
    const child = new EventEmitter();
    child.pid = process.pid;
    const token = readFileSync(args[args.indexOf('--ws-token-file') + 1], 'utf8');
    child.app = startMockAppServer({ token, port: Number(new URL(args[2]).port) });
    child.crash = async (code) => {
      await (await child.app).close();
      child.exitCode = code;
      child.emit('exit', code);
    };
    child.kill = () => { void child.crash(0); };
    children.push(child);
    return child;
  } };
  const svc = await startServer({ configPath, sessionsDir, port: 0, manageAppServer: true, appServerOptions: choices });
  const follower = createAppServerManager(choices);
  t.after(async () => {
    await follower.stop();
    await svc.close();
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await svc.appServer.ensureRunning();
  assert.equal(first.running, true, first.error);
  assert.equal((await follower.ensureRunning()).ws_url, first.ws_url);
  assert.equal(children.length, 1);
  const firstState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(firstState.auth_header, 'Authorization');
  assert.equal(firstState.status, 'running');
  assert.ok(firstState.auth_token);
  await children[0].crash(17);
  const second = await eventually(() => children.length === 2 && svc.appServer.getStatus().running && svc.appServer.getStatus());
  const secondState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.notEqual(secondState.auth_token, firstState.auth_token);

  const origin = `http://127.0.0.1:${svc.port}`;
  const key = (await rawHttpGet({ port: svc.port, path: '/' })).text.match(/name="gempt-key" content="([^"]+)"/)[1];
  const headers = { 'x-gempt-key': key };
  const readApi = async (path) => (await fetch(origin + path, { headers })).json();
  const repo = join(dir, 'workspace');
  mkdirSync(repo);
  const tools = createExecutionTools({ configPath, sessionsDir, options: { exec: true }, env });
  const receipt = await tools.exec.execute({ goal: 'Ask Gemini', cwd: repo, background: true });
  const runId = receipt.run_id;
  await eventually(async () => (await tools.status.execute({ run_id: runId })).state === 'waiting_gemini');
  const state = await readApi('/api/state');
  assert.deepEqual(state.app_server, second);
  assert.equal(state.app_server.auth_token, undefined);
  assert.deepEqual(state.active_runs.map((run) => [run.run_id, run.state]), [[runId, 'waiting_gemini']]);
  assert.equal(state.active_runs[0].pending_tool_call.arguments.question, 'Continue?');
  const request = (await readApi('/api/requests')).items.find((row) => row.run_id === runId);
  assert.equal(request.state, 'waiting_gemini');
  assert.equal((await readApi('/api/requests/' + encodeURIComponent(request.id))).progress.last_message, 'live drafting');
  const session = (await readApi('/api/sessions')).items.find((row) => row.session_id === receipt.session_id);
  assert.equal(session.pending_tool_call.tool, 'ask_gemini');
  assert.equal((await readApi('/api/sessions/' + session.id)).state, 'waiting_gemini');

  const path = `/api/runs/${runId}/interrupt`;
  assert.equal((await fetch(origin + path, { method: 'POST' })).status, 401);
  assert.equal((await fetch(origin + path, { method: 'POST', headers: { ...headers, origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(origin + path, { method: 'POST', headers: { ...headers, origin: 'null' } })).status, 403);
  assert.equal((await fetch(origin + '/api/runs/%2e%2e%2fstate/interrupt', { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(origin + '/api/runs/' + 'a'.repeat(32) + '/interrupt', { method: 'POST', headers })).status, 404);
  const interrupted = await fetch(origin + path, { method: 'POST', headers: { ...headers, origin } });
  assert.equal(interrupted.status, 200);
  assert.equal((await interrupted.json()).thread_id, MOCK_THREAD);
  const finished = await eventually(async () => {
    const state = await tools.status.execute({ run_id: runId });
    return state.state === 'interrupted' && state;
  });
  assert.equal(finished.session_id, receipt.session_id);
  assert.equal(finished.codex_thread_id, MOCK_THREAD);
  assert.equal(finished.pending_tool_call, null);
  const interrupt = (await children[1].app).packets.find((p) => p.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: MOCK_THREAD, turnId: finished.turn_id });
  assert.equal((await readApi('/api/sessions/' + session.id)).state, 'interrupted');
  assert.deepEqual((await readApi('/api/state')).active_runs, []);
  await follower.stop();
  await svc.close();
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).status, 'stopped');
});

test('requests and sessions analytics return buckets, breakdowns, speed board, 53w heatmap, hour matrix, shapes and top tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-analytics-'));
  try {
    const sessDir = join(dir, 'sessions');
    const magpieDir = join(dir, 'magpie');
    mkdirSync(sessDir, { recursive: true });
    mkdirSync(magpieDir, { recursive: true });
    const now = new Date();
    const todayIso = now.toISOString();
    const yesterdayIso = new Date(now.getTime() - 26 * 3600 * 1000).toISOString();
    const sessionFile = join(sessDir, 'exec-20261121-analytics1.json');
    writeFileSync(sessionFile, JSON.stringify({
      session_id: 'exec-20261121-analytics1',
      mode: 'exec',
      cwd: 'C:\\work\\gempt',
      model: 'codex/gpt-6.2-sol',
      tier: 'sonnet',
      created_at: yesterdayIso,
      updated_at: todayIso,
      turns: [{ role: 'user', content: 'Analyze repo' }, { role: 'assistant', content: 'Done' }],
      turn_details: {
        1: {
          goal: 'Analyze repo',
          timestamp: todayIso,
          model: 'codex/gpt-6.2-sol',
          provider: 'codex',
          tier: 'sonnet',
          status: 'succeeded',
          elapsed_sec: 120,
          ttft_ms: 4200,
          tokens_per_sec: 64,
          cost_usd: 0.42,
          usage: { input_tokens: 10000, output_tokens: 800, cached_input_tokens: 8000, total_tokens: 10800 },
          commands: [
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'git status\'',
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'$x=Get-Content a.txt\'',
            '"C:\\Program Files\\Python312\\python.exe" -V',
          ],
        },
      },
    }), 'utf8');

    const reqAll = await listDispatchActivity('requests', new URLSearchParams({ range: 'all' }), sessDir, magpieDir);
    assert.equal(reqAll.total, 1);
    assert.equal(reqAll.summary.avg_speed, 64);
    assert.equal(reqAll.summary.avg_ttft_ms, 4200);
    assert.equal(reqAll.analytics.breakdowns.model[0].name, 'codex/gpt-6.2-sol');
    assert.equal(reqAll.analytics.speed_board.model[0].avg_speed, 64);
    assert.ok(reqAll.analytics.heatmap_53w.days.length >= 365);
    assert.ok(reqAll.facets.provider.some((f) => f.value === 'codex'));

    const reqToday = await listDispatchActivity('requests', new URLSearchParams({ range: 'today' }), sessDir, magpieDir);
    assert.equal(reqToday.analytics.bucket_kind, 'hour');
    assert.equal(reqToday.analytics.buckets.length, 24);

    const sess90 = await listDispatchActivity('sessions', new URLSearchParams({ range: '90d' }), sessDir, magpieDir);
    assert.equal(sess90.total, 1);
    assert.equal(sess90.summary.top_project, 'gempt');
    assert.equal(sess90.analytics.projects[0].name, 'gempt');
    assert.equal(sess90.analytics.models[0].name, 'codex/gpt-6.2-sol');
    assert.equal(sess90.analytics.hour_matrix.matrix.length, 7);
    assert.equal(sess90.analytics.top_sessions.by_cost[0].id, 'exec-20261121-analytics1');
    assert.equal(sess90.analytics.shapes.total_sessions, 1);
    const toolNames = sess90.analytics.top_tools.items.map((i) => i.name).sort();
    assert.deepEqual(toolNames, ['get-content', 'git', 'python']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('token-ratio reports weighted work and cache-inclusive shares independently of the target', async () => {
  const { readTokenRatio, resolveBudget } = await import('../magpie_plugin/lib/token-ratio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gempt-ratio-'));
  try {
    const brainDir = join(dir, 'brain');
    const logDir = join(brainDir, 'conv-a', '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const recentIso = new Date(Date.now() - 3600_000).toISOString();
    writeFileSync(join(logDir, 'transcript.jsonl'), JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: recentIso,
      model: 'gemini-4-neon-high',
      input_tokens: 900_000,
      output_tokens: 100_000,
      cache_read_tokens: 8_000_000,
    }) + '\n', 'utf8');

    const magpieDir = join(dir, 'magpie');
    mkdirSync(magpieDir, { recursive: true });
    writeFileSync(join(magpieDir, 'usage.jsonl'), JSON.stringify({
      t: recentIso,
      provider: 'codex',
      model: 'gpt-6.2-sol',
      req: 'codex/gpt-6.2-sol',
      in: 100_000,
      out: 10_000,
      cache_read: 890_000,
    }) + '\n', 'utf8');

    const snap = readTokenRatio({ brainDir, magpieConfigDir: magpieDir, sessionsDir: join(dir, 'sessions'), cacheTtlMs: 0 });
    assert.equal(snap.scope, 'all_sessions');
    assert.equal(snap.sources.skipped_non_gempt_sessions, 0);
    assert.equal(snap.gemini.total, 9_000_000);
    assert.equal(snap.gpt.total, 1_000_000);
    // Attributable work = in + 5*out: gemini=1.4M, gpt=150k -> 9.7% (total share remains 10.0%)
    assert.equal(snap.actual_gpt_share, 9.7);
    assert.equal(snap.actual_gemini_share, 90.3);
    assert.equal(snap.actual_gpt_total_share, 10.0);

    const options = { brainDir, magpieConfigDir: magpieDir, sessionsDir: join(dir, 'sessions'), cacheTtlMs: 0 };
    for (const [profile, target] of Object.entries({ gemini: 0, gemini_first: 15, balanced: 35, gpt: 60, gpt_first: 80 })) {
      const ratio = resolveBudget(profile, options);
      assert.equal(ratio.target_gpt_share, target);
      assert.equal(ratio.status, target ? 'observing' : 'off');
      assert.equal(ratio.actual_gpt_share, 9.7);
      assert.equal(ratio.actual_gpt_fresh_share, 9.9);
      assert.equal(ratio.actual_gpt_total_share, 10);
      assert.equal(ratio.scope, 'all_sessions');
      assert.equal(ratio.skipped_non_gempt_sessions, 0);
      for (const legacy of ['adjustment', 'effective_kinds', 'base_kinds', 'delta']) assert.equal(legacy in ratio, false);
    }
    assert.equal(resolveBudget('balanced', { brainDir: '', magpieConfigDir: '' }).status, 'no_data');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('authenticated Magpie Live shares run snapshots, turn controls, replies and exact activity links', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-live-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const sessionsDir = join(dir, 'sessions');
  const id = 'f'.repeat(32);
  const sessionId = 'exec-live-link';
  const runPath = join(sessionsDir, 'runs', id);
  const statePath = join(runPath, 'state.json');
  const timestamp = new Date().toISOString();
  const actions = [];
  mkdirSync(runPath, { recursive: true });
  writeFileSync(join(dir, 'app-server.json'), JSON.stringify({
    status: 'running', pid: process.pid, ws_url: 'ws://127.0.0.1:1',
  }));
  const record = {
    run_id: id, session_id: sessionId, cwd: dir, title: 'Live HTTP', state: 'waiting_gemini',
    source: 'magpie_exec', pid: process.pid, codex_thread_id: 'thread-1', turn_id: 'turn-1', created_at: timestamp,
    started_at: timestamp, pending_tool_call: { tool: 'ask_gemini', call_id: 'question', arguments: { question: 'Proceed?' } },
    progress: { phase: 'waiting_gemini' },
  };
  writeFileSync(statePath, JSON.stringify(record));
  writeFileSync(join(sessionsDir, sessionId + '.json'), JSON.stringify({
    session_id: sessionId, title: record.title, cwd: dir, mode: 'exec', turns: [],
  }));
  writeFileSync(join(runPath, 'events.jsonl'), JSON.stringify({ method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Live output' } }) + '\n');
  const service = await startServer({
    port: 0, sessionsDir, configPath, magpieConfigDir: dir,
    appServerOptions: {
      env: { ...process.env, GEMPT_APP_SERVER_STATE: join(dir, 'app-server.json') },
      connect: async () => ({ close() {}, request: async (method, args) => { actions.push([method, args]); } }),
    },
  });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.port}`;
  const { text: page } = await rawHttpGet({ port: Number(new URL(base).port), path: '/' });
  const headers = { 'x-gempt-key': page.match(/name="gempt-key" content="([^"]+)"/)[1] };
  const read = async (path) => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const write = (operation, body, origin = base) => fetch(`${base}/api/live/${operation}`, {
    method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(base + '/api/live/runs')).status, 401);
  assert.equal((await write('steer', { run_id: id, message: 'go' }, 'null')).status, 403);
  assert.equal((await write('steer', { run_id: id, message: 'go' }, 'https://foreign.test')).status, 403);
  assert.equal((await fetch(base + '/api/live/stream?run_id=invalid', { headers })).status, 400);
  assert.equal((await fetch(base + '/api/live/runs?limit=5000', { headers })).status, 400);
  const list = await read(`/api/live/runs?session_id=${sessionId}`);
  assert.equal(list.runs[0].run_id, id);
  assert.equal('stream' in list, false);
  const stream = await read(`/api/live/stream?run_id=${id}`);
  assert.equal(stream.full_text, 'Live output');
  assert.equal(stream.run.pending_tool_call.arguments.question, 'Proceed?');
  assert.equal((await read(`/api/requests?run_id=${id}&session_id=${sessionId}`)).items[0].run_id, id);
  assert.equal((await read(`/api/sessions?session_id=${sessionId}`)).items[0].live_run_id, id);
  assert.equal((await write('steer', { run_id: id, message: 'continue' })).status, 200);
  assert.equal((await write('interrupt', { run_id: id })).status, 200);
  assert.deepEqual(actions.map(([method]) => method), ['turn/steer', 'turn/interrupt']);
  assert.equal(actions[0][1].expectedTurnId, 'turn-1');
  assert.equal((await write('reply', { run_id: id, call_id: 'question', message: 'yes' })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(runPath, 'tool_replies', 'question.json'))).answer, 'yes');
  const legacyId = 'e'.repeat(32);
  const legacyPath = join(sessionsDir, 'runs', legacyId);
  mkdirSync(legacyPath, { recursive: true });
  writeFileSync(join(legacyPath, 'state.json'), JSON.stringify({ ...record, run_id: undefined }));
  assert.equal((await read('/api/active-runs')).active_runs.some((run) => run.run_id === legacyId), true);
});

test('Magpie serves split gzip assets with conditional caching and a private HTML key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-split-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { port, close } = await startServer({ port: 0, configPath: join(dir, 'config.json'),
    sessionsDir: join(dir, 'sessions'), magpieConfigDir: dir });
  t.after(close);
  const base = `http://127.0.0.1:${port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers });
  const html = await rawHttpGet({ port, path: '/', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(html.status, 200);
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.equal(html.headers.etag, undefined);
  assert.equal(html.headers['content-encoding'], 'gzip');
  const { text: markup } = await rawHttpGet({ port, path: '/' });
  assert.match(markup, /name="gempt-key"/);
  assert.match(markup, /<script type="module" src="\.\/app.js"><\/script>/);
  assert.match(markup, /<link rel="stylesheet" href="\.\/styles.css">/);
  for (const path of ['/app.js', '/styles.css']) {
    const zipped = await get(path, { 'accept-encoding': 'br, gzip;q=0.8', origin: 'null' });
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    assert.match(zipped.headers.get('vary'), /Accept-Encoding/);
    const plain = await get(path, { 'accept-encoding': 'gzip;q=0' });
    assert.equal(plain.headers.get('content-encoding'), null);
    const data = await zipped.text();
    assert.equal(await plain.text(), data);
    assert.doesNotMatch(data, /@modelcontextprotocol|Invalid Zod|@cfworker/);
    const etag = zipped.headers.get('etag');
    assert.ok(etag);
    assert.equal((await get(path, { 'if-none-match': etag })).status, 304);
  }
});

test('boot prewarms token ratio and overview, coalesces refreshes and reflects ledger writes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-prewarm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir);
  const postMessage = Worker.prototype.postMessage;
  const posted = [];
  t.mock.method(Worker.prototype, 'postMessage', function (message, ...rest) {
    if (message.args?.[0] === sessionsDir || message.args?.[1]?.sessionsDir === sessionsDir) posted.push(message.args);
    return postMessage.call(this, message, ...rest);
  });
  const { port, close } = await startServer({ port: 0, configPath: join(dir, 'config.json'), sessionsDir, magpieConfigDir: dir });
  t.after(close);
  await eventually(() => posted.some(([scope]) => scope === sessionsDir)
    && posted.some(([, options]) => options?.range === '24h'));

  const { readOverviewActivity } = await import('../magpie_plugin/lib/activity.mjs');
  const first = readOverviewActivity(sessionsDir, dir);
  assert.strictEqual(first, readOverviewActivity(sessionsDir, dir));
  assert.equal((await first).activityTotals.requests, 0);
  writeFileSync(join(sessionsDir, 'consult-fresh.json'), JSON.stringify({
    mode: 'consult', updated_at: new Date().toISOString(), turns: [{ goal: 'fresh', reply: 'yes' }],
  }));
  const { text: page } = await rawHttpGet({ port, path: '/' });
  const headers = { 'x-gempt-key': page.match(/name="gempt-key" content="([^"]+)"/)[1] };
  const [overview, summary] = await Promise.all([rawHttpGet({ port, path: '/api/overview', headers }),
    rawHttpGet({ port, path: '/api/summary', headers })]);
  assert.equal(JSON.parse(overview.text).activity_totals.requests, 1);
  assert.equal(JSON.parse(summary.text).magpie.reachable, null);
});

test('summary and overview avoid a stalled gateway, and the separate probe coalesces and caches failures', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-summary-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  let probes = 0;
  const gateway = http.createServer(() => { probes++; });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => { gateway.closeAllConnections(); return new Promise((resolve) => gateway.close(resolve)); });
  writeFileSync(configPath, JSON.stringify({ magpie: { base_url: `http://127.0.0.1:${gateway.address().port}` },
    routing_policy: { work_split: 'gpt_first' } }));
  const svc = await startServer({ port: 0, configPath, sessionsDir: join(dir, 'sessions'), magpieConfigDir: dir });
  t.after(() => svc.close());
  const base = `http://127.0.0.1:${svc.port}`;
  const { text: page } = await rawHttpGet({ port: Number(new URL(base).port), path: '/' });
  const headers = { 'x-gempt-key': page.match(/name="gempt-key" content="([^"]+)"/)[1] };
  const read = (path) => fetch(base + '/api/' + path, { headers }).then((res) => res.json());
  const summary = await read('summary');
  assert.equal(summary.routing.gpt_share, 80);
  assert.equal(summary.magpie.reachable, null);
  assert.equal('token_ratio' in await read('overview'), false);
  assert.deepEqual(Object.keys(await read('active-runs')).sort(), ['active_runs', 'app_server']);
  assert.equal(probes, 0);
  const pending = Promise.all([read('magpie-status'), read('magpie-status')]);
  await eventually(() => probes === 1);
  assert.equal((await read('summary')).magpie.reachable, null);
  const [first, second] = await pending;
  assert.equal(first.reachable, false);
  assert.equal(first.error, 'Timeout after 600ms');
  assert.deepEqual(first, second);
  assert.deepEqual(await read('magpie-status'), first);
  assert.equal(probes, 1);
  assert.equal((await read('summary')).magpie.reachable, false);
  assert.equal((await read('token-ratio?range=7d')).range, '7d');
});

test('token-ratio and /api/state apply five timestamp windows and roll today over at local midnight', async (t) => {
  const { RATIO_RANGES, readTokenRatio, resolveBudget } = await import('../magpie_plugin/lib/token-ratio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gempt-ratio-ranges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brainDir = join(dir, 'brain');
  const logDir = join(brainDir, 'active', '.system_generated', 'logs');
  const magpieConfigDir = join(dir, 'magpie');
  const sessionsDir = join(dir, 'sessions');
  const configPath = join(dir, 'config.json');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(magpieConfigDir);
  const hour = 3_600_000;
  const midnight = new Date(2026, 0, 15).getTime();
  const noon = midnight + 12 * hour;
  let now = noon;
  t.mock.method(Date, 'now', () => now);
  const timestamps = [
    noon - hour / 2, noon - hour, noon - 2 * hour, noon - 6 * hour, midnight, midnight - 1,
    noon - 24 * hour, noon - 60 * hour, noon - 168 * hour, noon - 168 * hour - 1, noon + 1,
  ].map((time) => new Date(time).toISOString());
  const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  writeFileSync(join(logDir, 'transcript.jsonl'), jsonl(timestamps.map((created_at) => ({
    type: 'PLANNER_RESPONSE', created_at, model: 'gemini-4-neon-high',
    input_tokens: 4_000, tool_calls: [{ name: 'gpt_run' }],
  }))));
  writeFileSync(join(magpieConfigDir, 'usage.jsonl'), jsonl(timestamps.map((time, index) => ({
    t: time, provider: 'codex', in: (index + 1) * 1_000,
  }))));
  const magpie = await startMockMagpie();
  t.after(() => magpie.close());
  writeFileSync(configPath, JSON.stringify({ version: 2, magpie: { base_url: magpie.url }, routing_policy: { work_split: 'balanced' } }));
  const previousBrain = process.env.GEMPT_AGY_BRAIN_DIR;
  process.env.GEMPT_AGY_BRAIN_DIR = brainDir;
  t.after(() => {
    if (previousBrain === undefined) delete process.env.GEMPT_AGY_BRAIN_DIR;
    else process.env.GEMPT_AGY_BRAIN_DIR = previousBrain;
  });
  const svc = await startServer({ port: 0, configPath, sessionsDir, magpieConfigDir });
  t.after(() => svc.close());
  const page = await rawHttpGet({ port: svc.port, path: '/' });
  const headers = { 'x-gempt-key': page.text.match(/name="gempt-key" content="([^"]+)"/)[1] };
  const get = (query = '') => rawHttpGet({ port: svc.port, path: `/api/state${query}`, headers });
  const options = { brainDir, magpieConfigDir, sessionsDir };
  const expected = [
    ['1h', 1, 3_000, 8_000], ['6h', 6, 10_000, 16_000], ['today', 12, 15_000, 20_000],
    ['24h', 24, 28_000, 28_000], ['7d', 168, 45_000, 36_000],
  ];
  assert.deepEqual(RATIO_RANGES, expected.map(([range]) => range));
  for (const [range, hours, gpt, gemini] of expected) {
    const snapshot = readTokenRatio({ ...options, range, nowMs: noon });
    assert.equal(snapshot.range, range);
    assert.equal(snapshot.window_hours, hours);
    assert.equal(snapshot.gpt.work, gpt);
    assert.equal(snapshot.gemini.work, gemini);
    const response = await get(`?ratio_range=${range}`);
    assert.equal(response.status, 200);
    const ratio = JSON.parse(response.text).token_ratio;
    assert.equal(ratio.range, range);
    assert.equal(ratio.window_hours, hours);
    assert.equal(ratio.gpt_work_tokens, gpt);
    assert.equal(ratio.gemini_work_tokens, gemini);
    assert.equal(ratio.combined_work, gpt + gemini);
    assert.equal(ratio.combined_total, gpt + gemini);
    assert.equal(ratio.actual_gpt_share, Math.round(gpt / (gpt + gemini) * 1_000) / 10);
    assert.equal(ratio.status, range === '1h' ? 'warming_up' : 'observing');
    assert.equal(ratio.scope, 'gempt_active_sessions');
  }
  assert.equal(JSON.parse((await get()).text).token_ratio.range, '24h');
  for (const invalid of ['2h', '', 'TODAY', 'custom']) {
    const response = await get(`?ratio_range=${invalid}`);
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.text).error, 'invalid ratio_range');
  }
  const custom = resolveBudget('balanced', { ...options, windowHours: 2, nowMs: noon });
  assert.equal(custom.range, 'custom');
  assert.equal(custom.window_hours, 2);
  assert.equal(custom.gpt_work_tokens, 6_000);
  assert.equal(readTokenRatio({ ...options, range: '1h', windowHours: 2 }).gpt.work, 3_000);
  now = midnight - 1;
  assert.equal(readTokenRatio({ ...options, range: 'today' }).gpt.work, 13_000);
  now = midnight;
  assert.equal(readTokenRatio({ ...options, range: 'today' }).gpt.work, 5_000);
});

test('mcpTools false disables duplicate Magpie GemPT tool registration', async () => {
  const pluginUrl = pathToFileURL(join(REPO_ROOT, 'magpie_plugin', 'index.mjs')).href;
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    `import { GemptPlugin } from ${JSON.stringify(pluginUrl)};
     const out = await GemptPlugin({}, { port: 0, mcpTools: false });
     console.log(JSON.stringify(out));
     process.exit(0);`,
  ], { timeout: 10_000, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout.trim()), {});
});

test('Magpie marketplace check shape and inspect+share guard hold', async () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.6.0');
  assert.ok(pkg.keywords.includes('magpie-plugin'));
  assert.ok(pkg.files.includes('THIRD_PARTY_LICENSES.txt'));
  assert.ok(pkg.magpie?.summary?.en && pkg.magpie?.summary?.zh);
  const tools = createGemptTools({ options: { exec: false } });
  for (const [name, tool] of Object.entries(tools)) {
    assert.match(name, /^[A-Za-z0-9_-]{1,48}$/);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(typeof tool.args, 'object');
  }
  await assert.rejects(
    tools.run.execute({ goal: 'read', cwd: REPO_ROOT, access: 'inspect', workspace: 'share' }),
    /workspace='share' is not allowed with read-only access/,
  );
});

test('Windows Codex shim resolution supports non-npm shims and server probe rejects spoofed ping', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const customCmd = join(dir, 'codex.cmd');
  const comspec = join(dir, 'cmd.exe');
  writeFileSync(customCmd, '@echo off\r\necho fake\r\n');
  writeFileSync(comspec, '');
  const resolved = resolveCodexInvocation(customCmd, { ComSpec: comspec }, 'win32');
  assert.deepEqual(resolved, [comspec, '/d', '/s', '/c', customCmd]);

  const spoof = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'gempt-magpie-plugin', build: 'fake', port: 0, instance_id: 'forged' }));
  });
  await new Promise((ok) => spoof.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => spoof.close(ok)));
  const spoofPort = spoof.address().port;
  await assert.rejects(
    startServer({ port: spoofPort, configPath: join(dir, 'config.json'), manageAppServer: false }),
    /in use by another program/,
  );
});

test('transport disconnects yield recovery hint and app-server self-heals on wedge, config drift, and restart API', async (t) => {
  const hint = buildEscalationSuggestion({ mode: 'exec', tier: 'fable', effort: 'xhigh', errorMessage: 'read ECONNRESET' });
  assert.match(hint, /transport disconnected/i);
  assert.doesNotMatch(hint, /Already at xhigh\/fable/);

  const dir = mkdtempSync(join(tmpdir(), 'gempt-selfheal-'));
  const managers = [];
  t.after(async () => {
    for (const m of managers) await m.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, 'config.json');
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(join(sessionsDir, 'runs'), { recursive: true });
  const fakeCli = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  writeFileSync(fakeCli, 'fake');
  if (process.platform !== 'win32') chmodSync(fakeCli, 0o755);
  writeFileSync(configPath, JSON.stringify({
    magpie: { base_url: 'http://127.0.0.1:3425' },
    codex: { cli_path: fakeCli },
  }));

  let spawnCount = 0;
  let healthy = true;
  const fakeSpawn = () => {
    spawnCount++;
    const child = new EventEmitter();
    child.pid = process.pid;
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    };
    return child;
  };
  const fakeConnect = async () => {
    if (!healthy) throw new Error('wedged');
    return { close() {}, request: async () => ({}) };
  };

  const mgr = createAppServerManager({
    configPath,
    sessionsDir,
    env: { ...process.env, GEMPT_APP_SERVER_STATE: join(dir, 'app-server.json') },
    port: 0,
    spawnProcess: fakeSpawn,
    connect: fakeConnect,
    startupMs: 2000,
    backoffMs: [20],
  });
  managers.push(mgr);

  const first = await mgr.ensureRunning();
  assert.equal(first.running, true);
  assert.equal(spawnCount, 1);

  // 1. Config change (gateway_url) triggers automatic restart when idle
  writeFileSync(configPath, JSON.stringify({
    magpie: { base_url: 'http://127.0.0.1:3426' },
    codex: { cli_path: fakeCli },
  }));
  const afterConfig = await mgr.ensureRunning();
  assert.equal(afterConfig.running, true);
  assert.equal(afterConfig.gateway_url, 'http://127.0.0.1:3426');
  assert.equal(spawnCount, 2);

  // 2. Wedged process (alive PID, failing WS probe) triggers automatic restart on probe
  healthy = false;
  let probeCalls = 0;
  const mgr2 = createAppServerManager({
    configPath,
    sessionsDir,
    env: { ...process.env, GEMPT_APP_SERVER_STATE: join(dir, 'app-server-2.json') },
    port: 0,
    spawnProcess: fakeSpawn,
    connect: async () => {
      probeCalls++;
      if (probeCalls === 2) throw new Error('wedged');
      return { close() {}, request: async () => ({}) };
    },
    startupMs: 2000,
    backoffMs: [20],
  });
  managers.push(mgr2);
  await mgr2.ensureRunning();
  const spawnsBeforeProbe = spawnCount;
  const healed = await mgr2.ensureRunning({ probe: true });
  assert.equal(healed.running, true);
  assert.equal(spawnCount, spawnsBeforeProbe + 1);

  // 3. Manual restart returns 409 when active runs exist unless force: true
  const runId = 'a'.repeat(32);
  mkdirSync(join(sessionsDir, 'runs', runId), { recursive: true });
  writeFileSync(join(sessionsDir, 'runs', runId, 'state.json'), JSON.stringify({
    run_id: runId, source: 'magpie_exec', state: 'running', pid: process.pid,
    deadline: Date.now() / 1000 + 600, cwd: dir, goal: 'busy',
  }));
  const spawnsBeforeActiveProbe = spawnCount;
  const refreshed = await mgr.ensureRunning({ probe: true });
  assert.equal(refreshed.running, false);
  assert.equal(refreshed.healthy, false);
  assert.equal(refreshed.degraded, true);
  assert.match(refreshed.error || '', /unresponsive/i);
  assert.equal(spawnCount, spawnsBeforeActiveProbe);
  const blocked = await mgr.restart({ force: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  healthy = true;
  const forced = await mgr.restart({ force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.status, 200);
  assert.equal(forced.app_server.running, true);
  assert.equal(forced.app_server.healthy, true);
  assert.equal(forced.app_server.degraded, false);
});

test('GemptPlugin hot-reload disposes prior HTTP server, cleans stale identity files and enforces GET / boundaries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-hotreload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const sessionsDir = join(dir, 'sessions');
  writeFileSync(configPath, JSON.stringify({ version: 1 }));

  // Pick a free ephemeral port and plant a stale identity file with a dead PID.
  const probeSrv = http.createServer();
  await new Promise((ok) => probeSrv.listen(0, '127.0.0.1', ok));
  const targetPort = probeSrv.address().port;
  await new Promise((ok) => probeSrv.close(ok));
  const deadPid = 999_999;
  const staleIdFile = join(dir, `page-server-${targetPort}.json`);
  const staleOtherFile = join(dir, 'page-server-65432.json');
  writeFileSync(staleIdFile, JSON.stringify({
    service: 'gempt-magpie-plugin', instance_id: 'dead-inst', pid: deadPid, port: targetPort, build: 'old',
  }));
  writeFileSync(staleOtherFile, JSON.stringify({
    service: 'gempt-magpie-plugin', instance_id: 'dead-other', pid: deadPid, port: 65432, build: 'old',
  }));

  const { GemptPlugin } = await import('../magpie_plugin/index.mjs');
  const controller = new AbortController();
  const first = await GemptPlugin({ signal: controller.signal }, {
    port: targetPort, configPath, sessionsDir, mcpTools: false, manageAppServer: false,
  });
  assert.equal(typeof first.dispose, 'function');
  const ping1 = await eventually(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/api/ping`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  });
  assert.equal(ping1.service, 'gempt-magpie-plugin');
  assert.equal(existsSync(staleOtherFile), false);
  const idRec1 = JSON.parse(readFileSync(staleIdFile, 'utf8'));
  assert.equal(idRec1.instance_id, ping1.instance_id);
  assert.equal(idRec1.pid, process.pid);

  // Verify GET / security boundaries (allow navigate/nested-navigate/host proxy; block cors/opaque Origin/path tricks).
  assert.equal((await rawHttpGet({ port: targetPort, path: '/', headers: { 'sec-fetch-mode': 'navigate' } })).status, 200);
  assert.equal((await rawHttpGet({ port: targetPort, path: '/', headers: { 'sec-fetch-mode': 'nested-navigate' } })).status, 200);
  assert.equal((await rawHttpGet({ port: targetPort, path: '/' })).status, 200);
  assert.equal((await rawHttpGet({ port: targetPort, path: '/', headers: { Origin: `http://127.0.0.1:${targetPort}` } })).status, 200);
  assert.equal((await rawHttpGet({ port: targetPort, path: '/', headers: { Origin: 'null' } })).status, 403);
  assert.equal((await rawHttpGet({ port: targetPort, path: '/', headers: { 'sec-fetch-mode': 'cors' } })).status, 403);
  assert.equal((await rawHttpGet({ port: targetPort, path: '/./index.html', headers: { 'sec-fetch-mode': 'cors' } })).status, 403);

  // Hot-reload in the same process should gracefully close old server and bind a fresh instance on the same port.
  const second = await GemptPlugin({}, {
    port: targetPort, configPath, sessionsDir, mcpTools: false, manageAppServer: false,
  });
  const ping2 = await eventually(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/api/ping`);
      if (!res.ok) return null;
      const body = await res.json();
      return body.instance_id !== ping1.instance_id ? body : null;
    } catch { return null; }
  });
  assert.notEqual(ping2.instance_id, ping1.instance_id);

  // Disposing releases the port and removes the identity file.
  await second.dispose();
  assert.equal(existsSync(staleIdFile), false);
  await assert.rejects(() => fetch(`http://127.0.0.1:${targetPort}/api/ping`));

  // AbortSignal hook also disposes cleanly.
  const abortCtrl = new AbortController();
  const third = await GemptPlugin({ signal: abortCtrl.signal }, {
    port: targetPort, configPath, sessionsDir, mcpTools: false, manageAppServer: false,
  });
  await eventually(async () => {
    try { return (await fetch(`http://127.0.0.1:${targetPort}/api/ping`)).ok; } catch { return false; }
  });
  abortCtrl.abort();
  await eventually(() => !existsSync(staleIdFile));
  await third.dispose();
});

test('app-server manager runs periodic health probes for Linux children and closes non-lock-holder restart race', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-app-health-'));
  const managers = [];
  t.after(async () => {
    for (const m of managers) await m.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, 'config.json');
  const sessionsDir = join(dir, 'sessions');
  const statePath = join(dir, 'app-server.json');
  mkdirSync(join(sessionsDir, 'runs'), { recursive: true });
  const fakeCli = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  writeFileSync(fakeCli, 'fake');
  if (process.platform !== 'win32') chmodSync(fakeCli, 0o755);
  writeFileSync(configPath, JSON.stringify({
    magpie: { base_url: 'http://127.0.0.1:3425' },
    codex: { cli_path: fakeCli },
  }));

  // 1. Periodic health probe heals a wedged Linux-style child (with .once) automatically when idle.
  let spawns = 0;
  let wedgedPid = null;
  const fakePids = new Set();
  const spawnLinuxChild = () => {
    spawns++;
    const child = new EventEmitter();
    child.pid = 700000 + spawns;
    fakePids.add(child.pid);
    child.stderr = new EventEmitter();
    child.kill = () => {
      fakePids.delete(child.pid);
      child.exitCode = 0;
      child.emit('exit', 0, null);
    };
    return child;
  };
  const ownerMgr = createAppServerManager({
    configPath,
    sessionsDir,
    env: { ...process.env, GEMPT_APP_SERVER_STATE: statePath },
    port: 0,
    spawnProcess: spawnLinuxChild,
    connect: async (target) => {
      if (target.pid === wedgedPid) throw new Error('wedged');
      return { close() {}, request: async () => ({}) };
    },
    isPidAlive: (pid) => pid === process.pid || fakePids.has(pid),
    terminateProcess: (target) => {
      if (target?.kill) target.kill();
      else if (target?.pid) fakePids.delete(target.pid);
    },
    waitForExit: async (pid) => !fakePids.has(pid),
    startupMs: 2000,
    backoffMs: [20],
    healthIntervalMs: 60,
  });
  managers.push(ownerMgr);

  const initial = await ownerMgr.ensureRunning();
  assert.equal(initial.running, true);
  assert.equal(initial.healthy, true);
  assert.equal(initial.degraded, false);
  const firstPid = initial.pid;

  // Wedge the running child; periodic health timer should detect and replace it automatically.
  wedgedPid = firstPid;
  const healed = await eventually(() => {
    const st = ownerMgr.getStatus();
    return st.running && st.pid !== firstPid ? st : null;
  }, 3000);
  assert.equal(healed.healthy, true);
  assert.equal(healed.degraded, false);
  assert.notEqual(healed.pid, firstPid);

  // 2. Non-lock-holder restart must NOT report false success when old PID does not exit/replace.
  const stubbornFollower = createAppServerManager({
    configPath,
    sessionsDir,
    env: { ...process.env, GEMPT_APP_SERVER_STATE: statePath },
    port: 0,
    spawnProcess: spawnLinuxChild,
    connect: async () => ({ close() {}, request: async () => ({}) }),
    isPidAlive: (pid) => pid === process.pid || fakePids.has(pid),
    verifyProcess: async () => true,
    terminateProcess: () => { /* Simulate stubborn process ignoring SIGTERM */ },
    startupMs: 300,
    restartTimeoutMs: 250,
    backoffMs: [20],
    healthIntervalMs: 0,
  });
  managers.push(stubbornFollower);
  const failedRestart = await stubbornFollower.restart();
  assert.equal(failedRestart.ok, false);
  assert.equal(failedRestart.status, 500);
  assert.match(failedRestart.error, /重启超时/);

  // 3. The Console observer verifies the child and waits for the owner to replace it.
  const oldPid = ownerMgr.getStatus().pid;
  const delayedFollower = createAppServerManager({
    observeOnly: true,
    configPath,
    sessionsDir,
    env: { ...process.env, GEMPT_APP_SERVER_STATE: statePath },
    port: 0,
    spawnProcess: () => assert.fail('Console observer must leave app-server ownership with Magpie.'),
    connect: async (target) => {
      if (!fakePids.has(target.pid)) throw new Error('gone');
      return { close() {}, request: async () => ({}) };
    },
    isPidAlive: (pid) => pid === process.pid || fakePids.has(pid),
    verifyProcess: async (pid, marker) => pid === oldPid && marker.endsWith('.token'),
    terminateProcess: (target) => {
      setTimeout(() => {
        fakePids.delete(target.pid);
        // Trigger ownerMgr to notice dead child and spawn replacement.
        void ownerMgr.ensureRunning({ probe: true });
      }, 120);
    },
    startupMs: 2000,
    restartTimeoutMs: 3000,
    backoffMs: [20],
    healthIntervalMs: 0,
  });
  managers.push(delayedFollower);
  const restarted = await delayedFollower.restart();
  assert.equal(restarted.ok, true, restarted.error);
  assert.equal(restarted.status, 200);
  assert.equal(restarted.app_server.running, true);
  assert.equal(restarted.app_server.healthy, true);
  assert.notEqual(restarted.app_server.pid, oldPid);
  await delayedFollower.stop();
  assert.equal(ownerMgr.getStatus().pid, restarted.app_server.pid);
});

test('activity endpoints unify run reconciliation, cache ledger with write invalidation, and align session_id with core/state', async (t) => {
  const { getActivityCacheStats, invalidateActivityCache } = await import('../magpie_plugin/lib/activity.mjs');
  const f = await activityFixture(t);
  const dir = dirname(f.usageFile);
  const sessionsDir = join(dirname(dir), 'sessions');
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 120_000).toISOString();
  const timedOutQueued = '4'.repeat(32);
  const deadWorkerRun = '5'.repeat(32);
  const customSessionId = 'feature-auth.v1';

  // Custom valid session_id (matches core/state.mjs) with explicit mode.
  f.session(customSessionId, {
    mode: 'exec',
    cwd: dir,
    model: 'codex/gpt-6.2-sol',
    updated_at: nowIso,
    turns: [{ goal: 'Custom session task', timestamp: nowIso, reply: 'done' }],
  });
  // Queued run > 60s without PID -> must reconcile to 'failed' everywhere.
  f.run(timedOutQueued, {
    source: 'magpie_exec', state: 'queued', created_at: oldIso, cwd: dir, goal: 'stuck queue',
  }, []);
  // Running run with dead PID and active turn_id -> must reconcile to 'outcome_unknown' + remote_turn_unconfirmed everywhere.
  f.run(deadWorkerRun, {
    source: 'magpie_exec', state: 'running', pid: 999_999, turn_id: 'turn-dead',
    session_id: customSessionId, created_at: nowIso, deadline: Date.now() / 1000 + 600, cwd: dir, goal: 'dead worker',
  }, []);

  const { get, json } = await f.start();
  invalidateActivityCache(sessionsDir);

  const state = await json('/api/state');
  const requests = await json('/api/requests?limit=100');
  const sessions = await json('/api/sessions?limit=100');

  // Unified state across /api/state, /api/requests, and /api/sessions.
  assert.equal(state.active_runs.some((r) => r.run_id === timedOutQueued), false);
  const activeDead = state.active_runs.find((r) => r.run_id === deadWorkerRun);
  assert.ok(activeDead, 'recent remote_turn_unconfirmed run remains occupying active_runs');
  assert.equal(activeDead.state, 'outcome_unknown');
  assert.equal(activeDead.remote_turn_unconfirmed, true);

  const recentQueued = state.recent_runs.find((r) => r.run_id === timedOutQueued);
  assert.equal(recentQueued.state, 'failed');
  const recentDead = state.recent_runs.find((r) => r.run_id === deadWorkerRun);
  assert.equal(recentDead.state, 'outcome_unknown');

  const reqQueued = requests.items.find((r) => r.run_id === timedOutQueued);
  assert.equal(reqQueued.status, 'failed');
  const reqDead = requests.items.find((r) => r.run_id === deadWorkerRun);
  assert.equal(reqDead.status, 'outcome_unknown');
  assert.equal(reqDead.remote_turn_unconfirmed, true);

  // Custom valid session_id is visible in /api/sessions and /api/sessions/:id.
  const customSess = sessions.items.find((s) => s.id === customSessionId);
  assert.ok(customSess);
  assert.equal(customSess.state, 'outcome_unknown');
  const customDetail = await json(`/api/sessions/${encodeURIComponent(customSessionId)}`);
  assert.equal(customDetail.session_id, customSessionId);
  assert.equal(customDetail.turns.length, 2);

  // Invalid core/state.mjs session IDs are rejected with 400.
  for (const bad of ['con', 'nul', 'exec-trail.', '.hidden']) {
    assert.equal((await get(`/api/sessions/${encodeURIComponent(bad)}`)).status, 400, bad);
  }

  // Activity cache hits on unchanged consecutive reads and invalidates immediately on write.
  const before = getActivityCacheStats();
  await json('/api/requests');
  await json('/api/sessions');
  const afterHits = getActivityCacheStats();
  assert.equal(afterHits.enrichedHits, before.enrichedHits + 2);
  assert.equal(afterHits.enrichedMisses, before.enrichedMisses);

  f.session('consult-cache-new', {
    mode: 'consult', cwd: dir, updated_at: new Date().toISOString(),
    turns: [{ goal: 'invalidate cache', timestamp: new Date().toISOString(), reply: 'fresh' }],
  });
  const afterWrite = await json('/api/sessions');
  const afterMiss = getActivityCacheStats();
  assert.equal(afterMiss.enrichedMisses, afterHits.enrichedMisses + 1);
  assert.ok(afterWrite.items.some((s) => s.id === 'consult-cache-new'));
});

test('token-ratio skips unparseable timestamps and flags truncated usage.jsonl metadata', async (t) => {
  const { readTokenRatio, resolveBudget } = await import('../magpie_plugin/lib/token-ratio.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gempt-ratio-edge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brainDir = join(dir, 'brain');
  const logDir = join(brainDir, 'conv-edge', '.system_generated', 'logs');
  const magpieConfigDir = join(dir, 'magpie');
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(magpieConfigDir, { recursive: true });

  const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
  const validTs = new Date(nowMs - 30 * 60_000).toISOString();

  // Transcript has one valid record + two invalid/missing timestamp records that must be skipped.
  writeFileSync(join(logDir, 'transcript.jsonl'), [
    JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: validTs, model: 'gemini-4-neon', input_tokens: 10_000, output_tokens: 1_000 }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 999_000, output_tokens: 100_000 }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: 'not-a-timestamp', model: 'gemini-4-neon', input_tokens: 888_000, output_tokens: 50_000 }),
  ].join('\n') + '\n');

  // Usage ledger has valid + missing/bad timestamps.
  const usageRows = [
    JSON.stringify({ t: validTs, provider: 'codex', model: 'gpt-6.2-sol', in: 5_000, out: 500 }),
    JSON.stringify({ provider: 'codex', model: 'gpt-6.2-sol', in: 500_000, out: 50_000 }),
    JSON.stringify({ t: 'invalid-date', provider: 'codex', model: 'gpt-6.2-sol', in: 400_000, out: 40_000 }),
  ];
  writeFileSync(join(magpieConfigDir, 'usage.jsonl'), usageRows.join('\n') + '\n');

  const full = readTokenRatio({ brainDir, magpieConfigDir, sessionsDir, range: '1h', nowMs, cacheTtlMs: 0 });
  assert.equal(full.gemini.in, 10_000);
  assert.equal(full.gemini.out, 1_000);
  assert.equal(full.gpt.in, 5_000);
  assert.equal(full.gpt.out, 500);
  assert.equal(full.truncated, false);
  assert.equal(full.sources.usage_truncated, false);
  assert.equal(full.sources.magpie_records, 1);

  // Exceeding the tail byte cap sets truncated metadata without breaking parsing of the tail.
  const paddedLines = [];
  for (let i = 0; i < 40; i += 1) {
    paddedLines.push(JSON.stringify({
      t: new Date(nowMs - 40 * 60_000).toISOString(),
      provider: 'codex', model: 'gpt-6.2-sol', in: 1_000, out: 0, pad: 'x'.repeat(80),
    }));
  }
  paddedLines.push(JSON.stringify({ t: validTs, provider: 'codex', model: 'gpt-6.2-sol', in: 7_000, out: 0 }));
  writeFileSync(join(magpieConfigDir, 'usage.jsonl'), paddedLines.join('\n') + '\n');

  const truncSnap = readTokenRatio({
    brainDir, magpieConfigDir, sessionsDir, range: '1h', nowMs, cacheTtlMs: 0, maxUsageTailBytes: 512,
  });
  assert.equal(truncSnap.truncated, true);
  assert.equal(truncSnap.sources.usage_truncated, true);
  assert.ok(truncSnap.gpt.in >= 7_000 && truncSnap.gpt.in < 47_000);

  const budget = resolveBudget('balanced', {
    brainDir, magpieConfigDir, sessionsDir, range: '1h', nowMs, cacheTtlMs: 0, maxUsageTailBytes: 512,
  });
  assert.equal(budget.truncated, true);
});

test('advanced HTTP settings validate, protect credentials, probe drafts and reset defaults', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-advanced-settings-'));
  const configPath = join(dir, 'config.json');
  const secret = 'fixture-only-gateway-secret-1234';
  const envName = 'GEMPT_TEST_ADVANCED_KEY';
  const requests = [];
  const gateway = http.createServer((req, res) => {
    const authorization = req.headers.authorization;
    requests.push([req.url, authorization]);
    res.end(JSON.stringify({ data: [{ id: 'external/custom-v1' },
      ...(authorization?.endsWith(secret) ? [{ id: secret }] : [])] }));
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = 'http://127.0.0.1:' + gateway.address().port;
  const trustedBefore = process.env.GEMPT_TRUSTED_GATEWAY;
  process.env.GEMPT_TRUSTED_GATEWAY = gatewayUrl + '/trusted';
  process.env[envName] = secret;
  writeFileSync(configPath, JSON.stringify({ version: 1, magpie: { base_url: gatewayUrl } }));
  const svc = await startServer({ port: 0, configPath, sessionsDir: join(dir, 'sessions'), magpieConfigDir: dir });
  t.after(async () => {
    if (trustedBefore === undefined) delete process.env.GEMPT_TRUSTED_GATEWAY;
    else process.env.GEMPT_TRUSTED_GATEWAY = trustedBefore;
    delete process.env[envName];
    await svc.close();
    await new Promise((resolve) => gateway.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const auth = (await rawHttpGet({ port: svc.port, path: '/' })).text.match(/name="gempt-key" content="([^"]+)"/)[1];
  const call = async (path, body) => {
    const response = await fetch('http://127.0.0.1:' + svc.port + '/api/' + path, {
      headers: { Origin: 'null', 'x-gempt-key': auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    return [response.status, await response.json()];
  };
  const saved = {
    magpie: { base_url: ' ' + gatewayUrl + '/// ', api_key: secret, api_key_env: envName },
    routing_policy: { swarm_shell_model: 'vendor/custom:model@1', excluded_models: [' unused-provider  '] },
    utility: { model: 'external/custom-v1', reasoning_effort: '' },
    codex: { cli_path: process.execPath, extra_args: ['--strict-config'] },
    limits: { consult_timeout_sec: 15 },
    ui: { language: 'en' },
  };
  assert.equal((await call('settings', saved))[0], 200);
  const config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config().magpie.base_url, gatewayUrl);
  assert.equal(config().magpie.api_key, secret);
  for (const endpoint of ['overview', 'state']) {
    const [status, data] = await call(endpoint);
    assert.equal(status, 200);
    assert.equal(data.magpie_api_key_configured, true);
    assert.equal(data.magpie_api_key_hint, '••••1234');
    assert.equal(data.magpie_api_key_env, envName);
    assert.equal(data.magpie_base_url, gatewayUrl);
    assert.equal(data.swarm_shell_model, saved.routing_policy.swarm_shell_model);
    assert.deepEqual(data.excluded_models, ['unused-provider']);
    assert.equal(data.utility.model, saved.utility.model);
    assert.equal(data.utility.reasoning_effort, '');
    assert.equal(data.codex_cli_path, process.execPath);
    assert.equal(data.codex_cli_available, true);
    assert.equal(data.codex_cli_resolved_path, process.execPath);
    assert.deepEqual(data.codex_extra_args, ['--strict-config']);
    assert.equal(data.consult_timeout_sec, 15);
    assert.equal(data.ui.language, 'en');
    assert.ok(!JSON.stringify(data).includes(secret));
  }
  assert.equal((await call('summary'))[1].ui.language, 'en');
  const [probeStatus, probe] = await call('probe-gateway', {});
  assert.equal(probeStatus, 200);
  assert.equal(probe.reachable, true);
  assert.ok(Number.isInteger(probe.latency_ms) && probe.latency_ms >= 0);
  assert.deepEqual(probe.models, ['external/custom-v1']);
  assert.deepEqual(requests.at(-1), ['/v1/models', 'Bearer ' + secret]);

  assert.equal((await call('probe-gateway', { base_url: gatewayUrl + '/draft', api_key: 'draft-token' }))[1].reachable, true);
  assert.deepEqual(requests.at(-1), ['/draft/v1/models', 'Bearer draft-token']);
  await call('probe-gateway', { base_url: gatewayUrl + '/draft' });
  assert.deepEqual(requests.at(-1), ['/draft/v1/models', undefined]);
  await call('probe-gateway', { base_url: gatewayUrl + '/trusted', api_key_env: envName });
  assert.deepEqual(requests.at(-1), ['/trusted/v1/models', 'Bearer ' + secret]);
  assert.equal(config().magpie.base_url, gatewayUrl);

  const prev = config();
  for (const invalid of [
    { swarm_shell_model: 'bad model' }, { swarm_shell_model: 'x\n' }, { swarm_shell_model: 'x'.repeat(129) },
    { magpie: { base_url: 'ftp://example.com' } }, { magpie: { base_url: 'https://user:secret@example.com' } },
    { magpie: { api_key_env: 'bad-env' } }, { magpie: { api_key: 'invalid\nkey' } },
    { utility: { model: '' } }, { utility: { reasoning_effort: 'ultra' } },
    { routing_policy: { excluded_models: ['\t'] } }, { codex: { extra_args: ['bad\narg'] } },
    { codex: { cli_path: 'bin\0codex' } }, { limits: { consult_timeout_sec: 15.5 } },
    { limits: { consult_timeout_sec: 1801 } }, { ui: { language: 'fr' } },
  ]) {
    assert.equal((await call('settings', { default_sandbox: 'read-only', ...invalid }))[0], 400);
    assert.deepEqual(config(), prev);
  }
  assert.equal((await call('probe-gateway', { base_url: 'not-a-url' }))[0], 400);
  assert.equal((await call('settings', { magpie: { api_key: '' } }))[0], 200);
  assert.equal((await call('overview'))[1].magpie_api_key_configured, false);
  await call('settings', { magpie: { api_key: secret } });
  await call('settings', { magpie: { clear_api_key: true } });
  assert.equal(config().magpie.api_key, '');
  await call('settings', { magpie: { api_key: secret } });
  assert.equal((await call('reset-settings', { keep_gateway: 'false' }))[0], 400);
  assert.equal((await call('reset-settings', {}))[1].keep_gateway, true);
  assert.deepEqual(config().magpie, { cli_path: '', ...prev.magpie });
  assert.equal(config().ui.language, 'auto');
  assert.equal(config().limits.consult_timeout_sec, 180);
  assert.equal((await call('reset-settings', { keep_gateway: false }))[0], 200);
  assert.equal(config().magpie.base_url, 'http://127.0.0.1:3425');
  assert.equal(config().magpie.api_key, '');
});

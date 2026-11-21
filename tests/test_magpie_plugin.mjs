import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildMcpSnippet, findMagpieCli, normalizeTitle, readActiveRuns, readState, setDefaultSandbox, setDefaultTier } from '../magpie_plugin/lib/backend.mjs';
import { createAppServerManager } from '../magpie_plugin/lib/app-server-manager.mjs';
import { startServer } from '../magpie_plugin/lib/server.mjs';
import { createGemptTools } from '../magpie_plugin/lib/tools.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('short titles prefer the explicit value and clean historical goals', () => {
  for (const [title, goal, cwd, expected] of [
    ['  侧栏\n绑定　与命名 ', 'ignored', 'D:\\gempt', '侧栏 绑定 与命名'],
    [null, 'You are executing a task delegated by Gemini.\nRead carefully.\n\n# Goal\n'
      + '- 用户反馈：请在工作区 D:/gempt 中修复侧栏绑定。跟进测试。', 'D:\\gempt', 'gempt · 修复侧栏绑定'],
    [' ', '请在你当前分配的隔离工作区中请先修复命名', '/code/gempt/', 'gempt · 修复命名'],
    [null, '```text\nnot the task\n```\n# 请帮我整理 `session.json`。', '', '整理 session.json'],
    [null, '1. "C:/My Projects/gempt": clean titles. Verify tests.', '/code/gempt', 'gempt · clean titles'],
    [null, '`/code/gempt` 修复会话列表', 'C:\\kit\\gempt', 'gempt · 修复会话列表'],
    ['🧪'.repeat(49), 'ignored', '', '🧪'.repeat(47) + '…'],
    [null, '标题'.repeat(50), '/code/gempt', 'gempt · ' + '标题'.repeat(12).slice(0, 23) + '…'],
    [null, '', '', 'GPT 任务'],
  ]) assert.equal(normalizeTitle(title, goal, cwd), expected);
});

test('npm pack dry run includes the Live bundle and excludes local state and dependencies', async () => {
  const npmCli = process.env.npm_execpath || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : '');
  const { stdout } = await execFileAsync(npmCli ? process.execPath : 'npm', [
    ...(npmCli ? [npmCli] : []), 'pack', '--dry-run', '--json', '--ignore-scripts',
  ], { cwd: REPO_ROOT, timeout: 30_000, windowsHide: true });
  const [{ files }] = JSON.parse(stdout);
  const paths = files.map((file) => file.path);
  for (const path of ['src/gempt/mcp_app_live.html', 'src/gempt/host_context.py', 'src/gempt/titles.py',
    'plugin/hooks.json', 'plugin/work_split_hook.py', 'magpie_plugin/lib/backend.mjs']) {
    assert.ok(paths.includes(path), path);
  }
  const roots = /^(?:LICENSE(?:\.md)?$|README\.md$|install\.(?:sh|ps1)$|package\.json$|pyproject\.toml$|(?:magpie_plugin|mcp_app|plugin|src\/gempt|templates)\/)/;
  const localFiles = /(?:^|\/)(?:\.[^/]+|node_modules|__pycache__|sessions|runs|host-context(?:[.-][^/]*)?|state\.json|config\.json|request\.json|package-lock\.json)(?:\/|$)|\.(?:pyc|log|jsonl|tgz)$/i;
  assert.deepEqual(paths.filter((path) => !roots.test(path) || localFiles.test(path)), []);
  assert.ok(!existsSync(join(REPO_ROOT, 'node_modules')));
  assert.ok(!existsSync(join(REPO_ROOT, 'mcp_app', 'node_modules')));
});

function findPythonBin() {
  const candidates = [
    process.env.PYTHON_BIN,
    ...(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']),
  ].filter(Boolean);
  for (const cand of candidates) {
    const run = spawnSync(cand, ['-I', '-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { windowsHide: true });
    if (run.status === 0) return cand;
  }
  return '';
}

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
  for (const item of [pkg.main.slice(2), 'src/gempt/workload.json', 'plugin/rules/AGENTS.md', 'install.sh', 'install.ps1', 'README.md']) {
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
  assert.deepEqual(JSON.parse(stdout.trim()), ['consult', 'discover', 'dispatch', 'exec', 'status']);
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
    assert.equal(buildMcpSnippet({ antigravityPluginDir: root }).config.mcpServers.gempt.command, python);
    delete process.env.MAGPIE_BIN;
    delete process.env.PYTHON_BIN;
    assert.equal(findMagpieCli(), magpie);
    assert.equal(buildMcpSnippet({ antigravityPluginDir: root }).config.mcpServers.gempt.command, python);

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
      JSON.stringify({ gempt: ['consult', 'discover', 'exec', 'status'] }),
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
    assert.deepEqual(state.clients.native_tools_list, ['gempt_consult', 'gempt_discover', 'gempt_exec', 'gempt_status']);
    assert.deepEqual(state.clients.external_clients, ['ZCode', 'Claude Code', 'Codex CLI']);
    assert.equal(state.tools.enabled, true);
    assert.equal(state.tools.exec_enabled, false);
    assert.match(state.rules_snippet, /gempt_consult/);

    assert.equal(state.native_groups.ready_count, 1);
    assert.equal(state.native_groups.complete, false);
    assert.equal(state.native_groups.can_create, true);
    const fablePreview = state.native_groups.tiers.find((t) => t.id === 'fable');
    assert.equal(fablePreview.installed, false);
    assert.equal(fablePreview.members.some((m) => m.includes('gemini-4-argon')), false);

    assert.equal(state.mcp_snippet.config.mcpServers.gempt.env.PYTHONUTF8, '1');
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

test('page server supports native-groups, lossless api_fallback <-> subscription_only round-trip, and Python cross-check', async () => {
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
    magpieCliPath: mockCli,
  });
  const origin = `http://127.0.0.1:${svc.port}`;

  try {
    const pingRes = await fetch(`${origin}/api/ping`);
    assert.equal(pingRes.status, 200);

    const badHost = await rawHttpGet({ port: svc.port, path: '/api/ping', headers: { Host: 'evil.example:3498' } });
    assert.equal(badHost.status, 403);
    const badOrigin = await rawHttpGet({ port: svc.port, path: '/api/ping', headers: { Origin: 'http://evil.example' } });
    assert.equal(badOrigin.status, 403);
    const badFetchMode = await fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'cors' } });
    assert.equal(badFetchMode.status, 403);
    const unauthState = await fetch(`${origin}/api/state`);
    assert.equal(unauthState.status, 401);

    const pageRes = await rawHttpGet({ port: svc.port, path: '/', headers: { 'sec-fetch-mode': 'navigate' } });
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(pageRes.text, /id="create-native-btn"/);
    assert.match(pageRes.text, /id="effort-control-group"/);
    const key = pageRes.text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];

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

    // Cross-check in Python: resolve_tier under subscription_only must succeed without ConfigError.
    const pyBin = findPythonBin();
    if (pyBin) {
      const pyCheck = await execFileAsync(
        pyBin,
        [
          '-c',
          'import sys; from gempt.config import load_config, resolve_tier; '
          + 'c,_=load_config(explicit=sys.argv[1]); '
          + 'print(resolve_tier(c,"sonnet")["model"], resolve_tier(c,"opus",escalate=True)["model"], resolve_tier(c,"fable")["model"])',
          cfgPath,
        ],
        { env: { ...process.env, PYTHONPATH: join(REPO_ROOT, 'src') } },
      );
      assert.equal(pyCheck.stdout.trim(), 'codex/gpt-6.2-sol codex/gpt-6.2-astra codex/gpt-6.2-astra');
    }

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

    const stateRes = await fetch(`${origin}/api/state`, {
      headers: { 'x-gempt-key': key },
    });
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.auto_effort, false);
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
  saveRun(queued, { state: 'queued', created_at: stamp(15) });
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
    const defaultTools = createGemptTools({
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

    const enabledTools = createGemptTools({
      configPath: cfgPath,
      sessionsDir: sessDir,
      magpieConfigDir: magpieDir,
      antigravityPluginDir: join(dir, 'missing-agy'),
      options: { exec: true }, env,
    });

    // Routing uses the current settings even for an already registered tool instance.
    const dispatch = enabledTools.dispatch.execute;
    const design = { goal: 'Design a form', kind: 'design', access: 'provided' };
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
    for (const [profile, delegated] of [['gemini', false], ['balanced', false], ['gpt', true], ['gpt_first', true]]) {
      config.routing_policy.work_split = profile;
      writeFileSync(cfgPath, JSON.stringify(config));
      const before = magpie.requests.length;
      const reply = await dispatch(design);
      assert.equal(reply.action, delegated ? 'consult' : 'gemini');
      assert.equal(magpie.requests.length - before, Number(delegated));
    }
    const hydrogenTask = { ...design, gemini_family: 'hydrogen' };
    const initial = await dispatch({ ...hydrogenTask, title: '  表单\n设计 ', host_conversation_id: 'consult-host' });
    const titledConsult = JSON.parse(readFileSync(join(sessDir, `${initial.session_id}.json`), 'utf8'));
    assert.equal(titledConsult.title, '表单 设计');
    assert.equal(titledConsult.host_conversation_id, 'consult-host');
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.1-terra');
    config.routing_policy.pairings = { hydrogen: 'codex/gpt-6-luna' };
    writeFileSync(cfgPath, JSON.stringify(config));
    await enabledTools.consult.execute({ goal: 'Continue', session_id: initial.session_id });
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.1-terra');
    await dispatch(hydrogenTask);
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6-luna');
    await dispatch({ ...hydrogenTask, tier: 'fable' });
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6.2-astra');
    config.routing_policy.swarm_split = 'gemini';
    writeFileSync(cfgPath, JSON.stringify(config));
    const beforeOff = magpie.requests.length;
    for (const payload of [
      { ...design, role: 'coordinator' },
      { ...design, role: 'worker', assignment_id: '1'.repeat(32) },
      { ...hydrogenTask, role: 'worker', kind: 'specialist', access: 'change' },
    ]) {
      const offReply = await dispatch(payload);
      assert.equal(offReply.action, 'gemini');
      assert.equal(offReply.disabled, true);
    }
    assert.equal(magpie.requests.length, beforeOff);

    config.routing_policy.swarm_split = 'balanced';
    writeFileSync(cfgPath, JSON.stringify(config));
    assert.equal((await dispatch({ ...design, role: 'coordinator' })).action, 'board');
    assert.equal((await dispatch({ ...design, role: 'worker', assignment_id: '1'.repeat(32) })).action, 'gemini');
    const revision = { ...hydrogenTask, role: 'worker', kind: 'specialist', assignment_id: '2'.repeat(32) };
    const before = magpie.requests.length;
    const pair = await Promise.all([dispatch(revision), dispatch(revision)]);
    assert.deepEqual(pair.map(item => item.action).sort(), ['already_assigned', 'consult']);
    assert.equal(magpie.requests.length, before + 1);
    assert.equal(magpie.requests.at(-1).body.model, 'codex/gpt-6-luna');
    await assert.rejects(dispatch({ ...revision, role: 'verifier', access: 'change', cwd: repoDir }), /read-only/);
    await assert.rejects(defaultTools.dispatch.execute({ ...design, access: 'change', cwd: repoDir }), /disabled/);

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
    const reconnected = createGemptTools({ sessionsDir: sessDir, configPath: cfgPath, options: { exec: true }, env });
    const finished = await reconnected.status.execute({ run_id: job.run_id, wait_sec: 5 });
    assert.equal(finished.state, 'finished', finished.error);
    assert.equal(finished.result.sandbox, 'workspace-write');
    const replay = await reconnected.exec.execute(job);
    assert.equal(replay.session_id, finished.result.session_id);
    assert.equal(app.packets.filter((p) => p.method === 'turn/start').length, codexCalls.length + 1);
    await assert.rejects(reconnected.exec.execute({ ...job, cwd: outsideDir }), /different workspace/);
    await assert.rejects(reconnected.status.execute({ run_id: '../wrong' }), /Invalid run_id/);

    const pairedExec = await dispatch({ ...hydrogenTask, kind: 'engineering', access: 'inspect', cwd: repoDir });
    assert.equal(pairedExec.model, 'codex/gpt-6-luna');
    assert.equal(app.packets.findLast((p) => p.method === 'turn/start').params.model, 'codex/gpt-6-luna');

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
    const tools = createGemptTools({
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
  const tools = createGemptTools({ configPath, sessionsDir, options: { exec: true }, env });
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

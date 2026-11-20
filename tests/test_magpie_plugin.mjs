import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readState, setDefaultSandbox, setDefaultTier } from '../magpie_plugin/lib/backend.mjs';
import { startServer } from '../magpie_plugin/lib/server.mjs';
import { createGemptTools } from '../magpie_plugin/lib/tools.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function findPythonBin() {
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/msys64/mingw64/bin/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const cand of candidates) {
    if (!cand.includes('/') && !cand.includes('\\')) return cand;
    if (existsSync(cand)) return cand;
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

function createMockCodexCli(dir, logFile) {
  const jsPath = join(dir, 'mock-codex-cli.mjs');
  writeFileSync(
    jsPath,
    `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdinPrompt = readFileSync(0, 'utf8');
const oIdx = args.indexOf('-o');
if (oIdx >= 0 && args[oIdx + 1]) {
  writeFileSync(args[oIdx + 1], 'mock codex final report', 'utf8');
}
appendFileSync(
  ${JSON.stringify(logFile)},
  JSON.stringify({
    args,
    cwd: process.cwd(),
    stdinPrompt,
    httpProxy: process.env.HTTP_PROXY || '',
    httpsProxy: process.env.HTTPS_PROXY || '',
    noProxy: process.env.NO_PROXY || '',
    gatewayToken: process.env.GEMPT_EXEC_GATEWAY_TOKEN || '',
  }) + '\\n',
  'utf8',
);
console.log(JSON.stringify({ type: 'thread.started', thread_id: '01900000-0000-7000-8000-000000000001' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'echo ok', exit_code: 0, aggregated_output: 'ok' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'mock codex final report' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }));
process.exit(0);
`,
    'utf-8',
  );

  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'mock-codex.cmd');
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf-8');
    return cmdPath;
  }
  const shPath = join(dir, 'mock-codex.sh');
  writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, 'utf-8');
  chmodSync(shPath, 0o755);
  return shPath;
}

test('package.json Magpie manifest fields and single plugin factory export exist', async () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, 'gempt');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './magpie_plugin/index.mjs');
  for (const item of ['magpie_plugin', 'src', 'plugin', 'templates', 'install.sh', 'README.md']) {
    assert.ok(pkg.files.includes(item), `files missing ${item}`);
  }
  assert.ok(existsSync(join(REPO_ROOT, pkg.main)));
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

  const codexLog = join(dir, 'codex-calls.jsonl');
  const mockCodex = createMockCodexCli(dir, codexLog);

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
      codexCliPath: mockCodex,
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
        codex: { default_sandbox: 'workspace-write', cli_path: mockCodex },
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
      options: { exec: true },
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
    const initial = await dispatch(hydrogenTask);
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
      { goal: 'Inspect repo', cwd: repoDir, sandbox: 'read-only' },
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
    assert.equal(e2.session_id, e1.session_id);

    const codexCalls = readFileSync(codexLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(codexCalls.length, 2);
    assert.equal(codexCalls[0].httpProxy, '');
    assert.ok(codexCalls[0].noProxy.includes('127.0.0.1'));
    assert.match(codexCalls[0].stdinPrompt, /## Goal\nInspect repo/);
    assert.ok(codexCalls[1].args.includes('resume'));
    assert.ok(codexCalls[1].args.includes('01900000-0000-7000-8000-000000000001'));

    // A receipt survives a new tool instance and repeat delivery never launches a second worker.
    const job = { goal: 'Edit one file', cwd: repoDir, run_id: '3'.repeat(32), background: true };
    const first = await enabledTools.exec.execute(job);
    assert.equal(first.run_id, job.run_id);
    const reconnected = createGemptTools({ sessionsDir: sessDir, configPath: cfgPath, options: { exec: true } });
    const finished = await reconnected.status.execute({ run_id: job.run_id, wait_sec: 5 });
    assert.equal(finished.state, 'finished', finished.error);
    assert.equal(finished.result.sandbox, 'workspace-write');
    const replay = await reconnected.exec.execute(job);
    assert.equal(replay.session_id, finished.result.session_id);
    assert.equal(readFileSync(codexLog, 'utf8').trim().split(/\r?\n/).length, codexCalls.length + 1);
    await assert.rejects(reconnected.exec.execute({ ...job, cwd: outsideDir }), /different workspace/);
    await assert.rejects(reconnected.status.execute({ run_id: '../wrong' }), /Invalid run_id/);

    const pairedExec = await dispatch({ ...hydrogenTask, kind: 'engineering', access: 'inspect', cwd: repoDir });
    assert.equal(pairedExec.model, 'codex/gpt-6-luna');
    const pairedArgs = JSON.parse(readFileSync(codexLog, 'utf8').trim().split('\n').at(-1)).args;
    assert.ok(pairedArgs.includes('codex/gpt-6-luna'));

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

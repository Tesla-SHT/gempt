import { normalizeUsage, cacheHitRatio } from '../core/token-usage.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getExecutionConfig, RUNNER_IDS } from '../core/config.mjs';
import { runSwarmOperation } from '../core/swarm-service.mjs';
import { handleTool } from '../core/mcp-server.mjs';
import { runLiveOperation } from '../core/live-service.mjs';
import {
  buildRunnerBaseEnv, findExecutable, getExecutableSearchDirs, resolveExecutableInvocation,
} from '../core/runners/detect.mjs';
import {
  CLI_CHOICES, detectAvailableRunners, getRunner, listRunners, preferredRunnerForModel, resolveRunnerId,
} from '../core/runners/registry.mjs';
import { dispatchRun, interruptRun, readRun, steerRun, waitForRun } from '../core/runs.mjs';
import { handleBoardAction, handleSwarmAction } from '../core/swarm-engine.mjs';
import { getSwarmOverview, readBoardMessages } from '../core/swarm-bus.mjs';
import { waitForBoard } from '../core/wait.mjs';
import { readOverview, readState, updateSettings } from '../magpie_plugin/lib/backend.mjs';
import { dispatchPageApi } from '../magpie_plugin/lib/page-api.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED_11 = ['codex', 'opencode', 'claude', 'gemini', 'pi', 'cursor', 'kimi', 'grok', 'kilo', 'copilot', 'qoder'];

function makeTmp(t, prefix = 'gempt-runners-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

function makeMockCli(dir, name, jsBody) {
  const scriptPath = join(dir, `${name}.mjs`);
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${jsBody}\n`, 'utf8');
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeFakeBin(dir, name) {
  const file = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
  return file;
}

async function startMockGateway(t, models = ['codex/gpt-6.2-sol', 'claude/claude-sonnet-4', 'gemini/gemini-2.5-pro']) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    }
    res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('all 11 hcom-parity CLIs register, detect cross-platform, route by model affinity, and degrade gracefully with zero CLIs', (t) => {
  assert.deepEqual([...RUNNER_IDS], EXPECTED_11);
  assert.deepEqual([...CLI_CHOICES], ['auto', ...EXPECTED_11]);
  assert.equal(listRunners().length, 11);
  for (const id of EXPECTED_11) {
    const runner = getRunner(id);
    assert.ok(runner, `runner ${id} should exist`);
    assert.ok(runner.installHint, `runner ${id} should expose installHint`);
    assert.ok(Array.isArray(runner.binaryNames) && runner.binaryNames.length > 0);
  }

  // Verify macOS GUI fallback dirs include homebrew, volta, cargo, bun, fnm, nvm.
  const fakeHome = makeTmp(t, 'gempt-home-');
  mkdirSync(join(fakeHome, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), { recursive: true });
  const macDirs = getExecutableSearchDirs({ PATH: '/usr/bin' }, { platform: 'darwin', home: fakeHome });
  for (const required of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(fakeHome, '.local', 'bin'),
    join(fakeHome, '.volta', 'bin'),
    join(fakeHome, '.npm-global', 'bin'),
    join(fakeHome, '.cargo', 'bin'),
    join(fakeHome, '.bun', 'bin'),
    join(fakeHome, '.fnm', 'current', 'bin'),
    join(fakeHome, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'),
  ]) {
    assert.ok(macDirs.includes(required), `macOS fallback dirs should include ${required}`);
  }

  const winDirs = getExecutableSearchDirs({ PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, { platform: 'win32', home: fakeHome });
  assert.ok(winDirs.includes(join('C:\\Users\\test\\AppData\\Roaming', 'npm')));

  // Zero-CLI detection and graceful resolution error.
  const emptyBin = makeTmp(t, 'gempt-empty-bin-');
  const isolatedEnv = { PATH: emptyBin };
  const opts = { includeFallbackDirs: false };
  const zeroDetected = detectAvailableRunners({}, isolatedEnv, opts);
  assert.equal(zeroDetected.length, 11);
  assert.equal(zeroDetected.filter((r) => r.available).length, 0);

  const zeroRes = resolveRunnerId({ requested: 'auto', model: 'codex/gpt-6.2-sol', cfg: {}, env: isolatedEnv, opts });
  assert.equal(zeroRes.ok, false);
  assert.equal(zeroRes.zero_cli, true);
  assert.match(zeroRes.error, /gpt_ask/);
  assert.ok(zeroRes.install_hints.codex && zeroRes.install_hints.opencode);

  // Model affinity routing when subset of CLIs are installed.
  const binDir = makeTmp(t, 'gempt-bin-');
  makeFakeBin(binDir, 'codex');
  makeFakeBin(binDir, 'claude');
  makeFakeBin(binDir, 'gemini');
  makeFakeBin(binDir, 'opencode');
  const envWithFour = { PATH: binDir };

  assert.equal(preferredRunnerForModel('codex/gpt-6.2-sol'), 'codex');
  assert.equal(preferredRunnerForModel('openai/gpt-5'), 'codex');
  assert.equal(preferredRunnerForModel('claude/claude-sonnet-4'), 'claude');
  assert.equal(preferredRunnerForModel('anthropic/claude-opus-4'), 'claude');
  assert.equal(preferredRunnerForModel('gemini/gemini-2.5-pro'), 'gemini');
  assert.equal(preferredRunnerForModel('deepseek/deepseek-r1'), 'opencode');

  assert.equal(resolveRunnerId({ requested: 'auto', model: 'codex/gpt-6.2-sol', env: envWithFour, opts }).cli, 'codex');
  assert.equal(resolveRunnerId({ requested: 'auto', model: 'claude/claude-sonnet-4', env: envWithFour, opts }).cli, 'claude');
  assert.equal(resolveRunnerId({ requested: 'auto', model: 'gemini/gemini-2.5-pro', env: envWithFour, opts }).cli, 'gemini');
  assert.equal(resolveRunnerId({ requested: 'auto', model: 'moonshot/kimi-k2', env: envWithFour, opts }).cli, 'opencode');

  // Fallback to first installed when model-matched CLI is not installed.
  const onlyClaudeDir = makeTmp(t, 'gempt-only-claude-');
  makeFakeBin(onlyClaudeDir, 'claude');
  const fallbackRes = resolveRunnerId({ requested: 'auto', model: 'codex/gpt-6.2-sol', env: { PATH: onlyClaudeDir }, opts });
  assert.equal(fallbackRes.ok, true);
  assert.equal(fallbackRes.cli, 'claude');
  assert.equal(fallbackRes.reason, 'priority_fallback');

  // Explicit request for uninstalled CLI returns actionable install hint.
  const missingExplicit = resolveRunnerId({ requested: 'kimi', model: 'codex/gpt-6.2-sol', env: { PATH: onlyClaudeDir }, opts });
  assert.equal(missingExplicit.ok, false);
  assert.equal(missingExplicit.not_installed, true);
  assert.match(missingExplicit.install_hint, /kimi/);

  // Cursor / Kilo / Qoder alternate binary names detected cleanly.
  const altBinDir = makeTmp(t, 'gempt-alt-bin-');
  makeFakeBin(altBinDir, 'cursor-agent');
  makeFakeBin(altBinDir, 'kilocode');
  makeFakeBin(altBinDir, 'qodercli');
  const altDetected = detectAvailableRunners({}, { PATH: altBinDir }, opts);
  const availIds = altDetected.filter((r) => r.available).map((r) => r.id).sort();
  assert.deepEqual(availIds, ['cursor', 'kilo', 'qoder']);
});

test('Windows Gemini detection skips a stale Unix shim and continues searching PATH', (t) => {
  const staleDir = makeTmp(t);
  const npmDir = makeTmp(t);
  const staleShim = join(staleDir, 'gemini');
  writeFileSync(staleShim, '#!/bin/bash\nexec node missing.js "$@"\n');
  const env = { PATH: [staleDir, npmDir].join(delimiter) };
  const opts = { platform: 'win32', includeFallbackDirs: false };
  const request = { requested: 'gemini', env, opts };

  assert.equal(resolveRunnerId(request).not_installed, true);
  const windowsShim = join(npmDir, 'gemini.cmd');
  writeFileSync(windowsShim, '@echo off\r\necho ok\r\n');
  assert.equal(resolveRunnerId(request).path, windowsShim);
  const cfg = { execution: { cli_paths: { gemini: staleShim } } };
  assert.equal(resolveRunnerId({ ...request, cfg }).path, windowsShim);
});

test('claude adapter runs stream-json end-to-end with ANTHROPIC_BASE_URL, --permission-mode, --mcp-config, --resume, and Live journal', async (t) => {
  const dir = makeTmp(t, 'gempt-claude-');
  const cwd = join(dir, 'repo');
  const sessionsDir = join(dir, 'sessions');
  const configPath = join(dir, 'cfg', 'config.json');
  const captureFile = join(dir, 'claude-invocations.jsonl');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, 'cfg'), { recursive: true });
  const gatewayUrl = await startMockGateway(t);

  const mockClaude = makeMockCli(dir, 'mock-claude', `
import { appendFileSync, readFileSync } from 'node:fs';
let stdinText = '';
for await (const chunk of process.stdin) stdinText += chunk;
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--resume ID' + (process.env.MOCK_NO_FORK ? '' : ' --fork-session'));
  process.exit(0);
}
if (args.includes('--fork-session') && process.env.MOCK_BAD_PARENT) {
  console.error('No conversation found with session ID');
  process.exit(1);
}
const mcpIdx = args.indexOf('--mcp-config');
const mcpContent = mcpIdx >= 0 ? JSON.parse(readFileSync(args[mcpIdx + 1], 'utf8')) : null;
const resumeIdx = args.indexOf('--resume');
const sessionId = args.includes('--fork-session') ? 'new-child-id' : resumeIdx >= 0 ? args[resumeIdx + 1] : 'claude-sess-777';
appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  args,
  stdinLen: stdinText.length,
  stdinText,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  swarmId: process.env.GEMPT_SWARM_ID || null,
  swarmAgent: process.env.GEMPT_AGENT_NAME || null,
  mcpContent,
}) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working... ' } } }));
console.log(JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_1',
    content: [
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo claude-ok' } },
      { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: 'src/app.js' } },
      { type: 'text', text: resumeIdx >= 0 ? 'Resumed turn complete.' : 'First turn complete.' },
    ],
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
  },
}));
console.log(JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'claude-ok', is_error: false }] },
}));
console.log(JSON.stringify({
  type: 'result',
  session_id: sessionId,
  result: resumeIdx >= 0 ? 'Resumed turn complete.' : 'First turn complete.',
  usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
  is_error: false,
}));
`);

  writeFileSync(configPath, JSON.stringify({
    version: 1,
    magpie: { base_url: gatewayUrl, api_key: 'sk-test-magpie' },
    codex: { default_sandbox: 'workspace-write', timeout_sec: 300 },
    execution: { default_cli: 'claude', cli_paths: { claude: mockClaude } },
    routing_policy: { default_tier: 'sonnet', failover_mode: 'paired', pairings: { neon: 'claude/claude-sonnet-4' } },
  }));

  const env = { ...process.env, GEMPT_CONFIG: configPath, GEMPT_SESSIONS_DIR: sessionsDir, GEMPT_DISABLE_IPC_DISPATCH: '1' };

  // Turn 1: inspect (read-only -> --permission-mode plan)
  const r1 = await dispatchRun({
    goal: 'Inspect repo files',
    cwd,
    access: 'inspect',
    sandbox: 'read-only',
    cli: 'claude',
    model: 'claude/claude-sonnet-4',
    swarm_id: 'sw-claude',
    swarm_agent: 'analyst',
    background: true,
  }, { configPath, sessionsDir, env });

  const done1 = await waitForRun(r1.run_id, { sessionsDir, timeoutSec: 15 });
  assert.equal(done1.state, 'finished', done1.error || 'turn 1 failed');
  assert.equal(done1.cli, 'claude');
  assert.equal(done1.result.cli, 'claude');
  assert.match(done1.result.text, /First turn complete/);
  assert.equal(done1.runner_session_id, 'claude-sess-777');

  // Verify Live stream parses Claude's journaled events.
  const liveStream = await runLiveOperation('stream', { run_id: r1.run_id }, { configPath, sessionsDir, env });
  assert.equal(liveStream.run.cli, 'claude');
  assert.ok(liveStream.commands.some((c) => c.command === 'echo claude-ok' && c.exit_code === 0));
  assert.ok(liveStream.touched_files.includes('src/app.js'));
  assert.equal(liveStream.usage.input_tokens, 160);
  assert.equal(liveStream.usage.cache_write_tokens, 10);
  assert.equal(liveStream.cache_hit_rate, 30 / 160);
  assert.equal(liveStream.usage.output_tokens, 45);

  // Turn 2: resume same session with change access (upgrade -> fresh turn) vs same sandbox resume
  const r2 = await dispatchRun({
    goal: 'Continue inspection', host_conversation_id: 'claude-solo',
    cwd,
    access: 'inspect',
    sandbox: 'read-only',
    cli: 'claude',
    model: 'claude/claude-sonnet-4',
    session_id: r1.session_id,
    background: true,
  }, { configPath, sessionsDir, env });

  const done2 = await waitForRun(r2.run_id, { sessionsDir, timeoutSec: 15 });
  assert.equal(done2.state, 'finished', done2.error || 'turn 2 failed');
  assert.match(done2.result.text, /Resumed turn complete/);

  const invocations = readFileSync(captureFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const fork = await dispatchRun({ goal: 'Fallback board summary', cwd, sandbox: 'read-only',
    cli: 'claude', model: done1.result.model }, { configPath, sessionsDir, env, swarmFork: {
    source: { cli: 'claude', model: done1.result.model, id: done1.runner_session_id }, prompt: 'Lean child assignment',
  } });
  assert.equal(fork.fork_mode, 'native');
  assert.equal(fork.runner_session_id, 'new-child-id');
  const child = JSON.parse(readFileSync(captureFile, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(child.args.slice(child.args.indexOf('--resume'), child.args.indexOf('--resume') + 3),
    ['--resume', 'claude-sess-777', '--fork-session']);
  assert.equal(child.stdinText, 'Lean child assignment');
  for (const flag of ['MOCK_BAD_PARENT', 'MOCK_NO_FORK']) {
    const result = await dispatchRun({ goal: 'Fallback board summary', cwd, sandbox: 'read-only',
      cli: 'claude', model: done1.result.model }, { configPath, sessionsDir, env: { ...env, [flag]: '1' }, swarmFork: {
      source: { cli: 'claude', model: done1.result.model, id: done1.runner_session_id }, prompt: 'Lean child assignment',
    } });
    assert.equal(result.fork_mode, 'summary_fallback');
    const invocation = JSON.parse(readFileSync(captureFile, 'utf8').trim().split('\n').at(-1));
    assert.match(invocation.stdinText, /Fallback board summary/);
    assert.ok(!invocation.args.includes('--resume'));
  }
  const solo = await runSwarmOperation('overview', { swarm_id: r2.swarm_id }, { sessionsDir, configPath });
  assert.equal(solo.head, 0);
  assert.equal(solo.counts.visible, 1);
  assert.equal(solo.roster[0].session_id, r2.session_id);
  assert.equal(solo.roster[0].cli, 'claude');
  assert.equal(solo.roster[0].telemetry.cache_hit_ratio, 30 / 160);
  assert.equal(solo.roster[0].telemetry.usage.input_tokens, 160);
  const added = await handleSwarmAction({ action: 'add', name: 'claude-child', brief: 'Check the findings',
    host_conversation_id: 'claude-solo', fork: solo.roster[0].name }, { configPath, sessionsDir, env });
  assert.equal(added.swarm_id, r2.swarm_id);
  const escalated = await waitForRun(added.workers[0].run_id, { sessionsDir, timeoutSec: 15 });
  assert.equal(escalated.fork_mode, 'native', escalated.error);
  const childCall = JSON.parse(readFileSync(captureFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(childCall.swarmAgent, 'claude-child');
  assert.ok(childCall.mcpContent.mcpServers.gempt_board);
  assert.equal(invocations[1].mcpContent, null);
  assert.equal(invocations[1].swarmId, null);
  assert.doesNotMatch(invocations[1].stdinText, /board_post|Shared message board protocol/);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].anthropicBaseUrl, gatewayUrl);
  assert.equal(invocations[0].anthropicAuthToken, 'sk-test-magpie');
  assert.ok(invocations[0].args.includes('--permission-mode') && invocations[0].args.includes('plan'));
  assert.equal(invocations[0].swarmId, 'sw-claude');
  assert.equal(invocations[0].swarmAgent, 'analyst');
  assert.ok(invocations[0].mcpContent?.mcpServers?.gempt_board?.args?.[0]?.endsWith('board-mcp.mjs'));
  assert.ok(invocations[1].args.includes('--resume') && invocations[1].args.includes('claude-sess-777'));
});

test('opencode adapter supports persistent HTTP/SSE serve (session/stream/steer/abort) and run --format json fallback', async (t) => {
  const dir = makeTmp(t, 'gempt-opencode-');
  const cwd = join(dir, 'repo');
  const sessionsDir = join(dir, 'sessions');
  const configPath = join(dir, 'cfg', 'config.json');
  const logFile = join(dir, 'opencode-events.jsonl');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, 'cfg'), { recursive: true });
  const gatewayUrl = await startMockGateway(t);

  const mockOpenCode = makeMockCli(dir, 'mock-opencode', `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const log = (entry) => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + '\\n');
const sub = args[0];

if (sub === 'run') {
  let prompt = '';
  for await (const c of process.stdin) prompt += c;
  log({ mode: 'run', args, promptLen: prompt.length, ocConfig: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') });
  console.log(JSON.stringify({ type: 'text', sessionID: 'oc-run-sess-1', part: { id: 'p1', text: 'Fallback run succeeded.' } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input_tokens: 50, output_tokens: 20 } } }));
  process.exit(0);
}

if (sub === 'serve') {
  const port = Number(args[args.indexOf('--port') + 1]);
  const sseClients = new Set();
  const broadcast = (payload) => {
    const chunk = 'data: ' + JSON.stringify({ payload }) + '\\n\\n';
    for (const res of sseClients) res.write(chunk);
  };
  let aborted = false;
  let steered = false;
  let lookups = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.pathname === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ healthy: true }));
    }
    if (url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.method === 'GET' && url.pathname === '/session/oc-srv-1') {
      log({ action: 'lookup', attempt: ++lookups });
      res.writeHead(Number(process.env.MOCK_LOOKUP_STATUS) || (lookups === 1 ? 503 : 200));
      return res.end('{}');
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      log({ mode: 'serve', action: 'create_session', ocConfig: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'oc-srv-1' }));
    }
    if (req.method === 'POST' && url.pathname === '/session/oc-srv-1/prompt_async') {
      steered = true;
      log({ mode: 'serve', action: 'steer', body });
      broadcast({ type: 'message.part.updated', properties: { sessionID: 'oc-srv-1', part: { id: 'p2', type: 'text' }, delta: ' Steered!' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && url.pathname === '/session/oc-srv-1/abort') {
      aborted = true;
      log({ mode: 'serve', action: 'abort' });
      broadcast({ type: 'session.idle', properties: { sessionID: 'oc-srv-1' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && url.pathname === '/session/oc-srv-1/message') {
      const text = body?.parts?.[0]?.text || '';
      log({ mode: 'serve', action: 'message', text });
      broadcast({ type: 'message.part.updated', properties: { sessionID: 'oc-srv-1', part: { id: 'p1', type: 'text' }, delta: 'Serve streaming reply.' } });
      if (text.includes('HOLD_FOR_STEER')) {
        const deadline = Date.now() + 4000;
        while (!steered && !aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
      }
      if (text.includes('HOLD_FOR_ABORT')) {
        const deadline = Date.now() + 4000;
        while (!aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
      }
      broadcast({ type: 'message.updated', properties: { sessionID: 'oc-srv-1', info: { tokens: { input: 88, output: 33, cache: { read: 24, write: 8 } } } } });
      broadcast({ type: 'session.idle', properties: { sessionID: 'oc-srv-1' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ info: { id: 'oc-m1' }, parts: [{ type: 'text', text: steered ? 'Serve streaming reply. Steered!' : 'Serve streaming reply.' }] }));
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1');
}
`);

  writeFileSync(configPath, JSON.stringify({
    version: 1,
    magpie: { base_url: gatewayUrl, api_key: 'sk-oc-key' },
    codex: { default_sandbox: 'workspace-write', timeout_sec: 300 },
    execution: { default_cli: 'opencode', cli_paths: { opencode: mockOpenCode } },
    routing_policy: { default_tier: 'sonnet', failover_mode: 'paired', pairings: { neon: 'deepseek/deepseek-r1' } },
  }));

  const env = { ...process.env, GEMPT_CONFIG: configPath, GEMPT_SESSIONS_DIR: sessionsDir, GEMPT_DISABLE_IPC_DISPATCH: '1' };

  // 1. Serve mode + mid-turn steer
  const r1 = await dispatchRun({
    goal: 'HOLD_FOR_STEER test opencode serve',
    cwd,
    cli: 'opencode',
    model: 'deepseek/deepseek-r1',
    swarm_id: 'sw-oc',
    swarm_agent: 'coder',
    background: true,
  }, { configPath, sessionsDir, env });

  // Wait until runner_meta.server_url is published on state.json, then steer!
  let readyToSteer = false;
  for (let i = 0; i < 80; i++) {
    const st = readRun(r1.run_id, sessionsDir);
    if (st.runner_meta?.server_url) { readyToSteer = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(readyToSteer, true, 'opencode serve should publish runner_meta.server_url');
  const steerRes = await steerRun(r1.run_id, 'Focus on edge cases', { configPath, sessionsDir, env });
  assert.equal(steerRes.ok, true);

  const done1 = await waitForRun(r1.run_id, { sessionsDir, timeoutSec: 15 });
  assert.equal(done1.state, 'finished', done1.error || 'opencode serve failed');
  assert.match(done1.result.text, /Serve streaming reply/);
  assert.match(done1.result.text, /Steered!/);

  assert.equal(done1.result.usage.input_tokens, 120);
  assert.equal(done1.result.usage.cache_write_tokens, 8);
  assert.equal(done1.result.usage.cache_hit_ratio, .2);
  const resumed = await dispatchRun({ session_id: done1.session_id, cwd, goal: 'Continue in the same session' },
    { configPath, sessionsDir, env });
  assert.equal(resumed.runner_session_id, 'oc-srv-1');
  const log = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.filter((e) => e.action === 'lookup').map((e) => e.attempt), [1, 2]);
  assert.equal(log.filter((e) => e.action === 'create_session').length, 1);

  const resumeArgs = { session_id: done1.session_id, cwd, goal: 'Follow up after outage' };
  await assert.rejects(dispatchRun(resumeArgs, { configPath, sessionsDir, env: { ...env, MOCK_LOOKUP_STATUS: '503' } }),
    /preserving session oc-srv-1/);
  const outageLog = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(outageLog.slice(log.length).filter((e) => e.action === 'lookup').map((e) => e.attempt), [1, 2, 3]);
  assert.ok(!outageLog.slice(log.length).some((e) => e.action === 'create_session'));
  await dispatchRun(resumeArgs, { configPath, sessionsDir, env: { ...env, MOCK_LOOKUP_STATUS: '404' } });
  const repaired = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse).slice(outageLog.length);
  assert.ok(repaired.some((e) => e.action === 'create_session'));
  assert.match(repaired.find((e) => e.action === 'message').text, /Carryover[\s\S]*Serve streaming reply/);

  // 2. Serve mode + interrupt/abort
  const r2 = await dispatchRun({
    goal: 'HOLD_FOR_ABORT test opencode abort',
    cwd,
    cli: 'opencode',
    model: 'deepseek/deepseek-r1',
    background: true,
  }, { configPath, sessionsDir, env });
  let readyToAbort = false;
  for (let i = 0; i < 80; i++) {
    const st = readRun(r2.run_id, sessionsDir);
    if (st.runner_meta?.server_url) { readyToAbort = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(readyToAbort, true);
  await interruptRun(r2.run_id, { configPath, sessionsDir, env });
  const done2 = await waitForRun(r2.run_id, { sessionsDir, timeoutSec: 15 });
  assert.equal(done2.state, 'interrupted');

  // 3. Fallback `opencode run --format json`
  const r3 = await dispatchRun({
    goal: 'Run fallback test', host_conversation_id: 'opencode-solo',
    cwd,
    cli: 'opencode',
    model: 'deepseek/deepseek-r1',
    background: true,
  }, { configPath, sessionsDir, env: { ...env, GEMPT_OPENCODE_FORCE_RUN: '1' } });
  const done3 = await waitForRun(r3.run_id, { sessionsDir, timeoutSec: 15 });
  assert.equal(done3.state, 'finished', done3.error || 'opencode run fallback failed');
  assert.match(done3.result.text, /Fallback run succeeded/);
  const ocBoard = await getSwarmOverview(r3.swarm_id, { sessionsDir });
  assert.equal(ocBoard.head, 0);
  assert.equal(ocBoard.roster[0].cli, 'opencode');

  const events = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.mode === 'serve' && e.action === 'create_session' && e.ocConfig?.mcp?.gempt_board));
  assert.ok(events.some((e) => e.mode === 'serve' && e.action === 'steer'));
  assert.ok(events.some((e) => e.mode === 'serve' && e.action === 'abort'));
  assert.ok(events.some((e) => e.mode === 'run' && e.args.includes('--format') && e.args.includes('json')));
});

test('gemini and all 7 declarative adapters wire Magpie + Swarm env and stream into Live journal', async (t) => {
  const dir = makeTmp(t, 'gempt-decl-');
  const cwd = join(dir, 'repo');
  const sessionsDir = join(dir, 'sessions');
  const configPath = join(dir, 'cfg', 'config.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, 'cfg'), { recursive: true });
  const gatewayUrl = await startMockGateway(t);

  const targets = ['gemini', 'pi', 'cursor', 'kimi', 'grok', 'kilo', 'copilot', 'qoder'];
  const cliPaths = {};
  for (const id of targets) {
    cliPaths[id] = makeMockCli(dir, `mock-${id}`, `
let stdinText = '';
for await (const c of process.stdin) stdinText += c;
const id = ${JSON.stringify(id)};
const summary = {
  cli: id,
  openaiBase: process.env.OPENAI_BASE_URL || '',
  geminiBase: process.env.GEMINI_API_BASE || '',
  swarmId: process.env.GEMPT_SWARM_ID || '',
  agent: process.env.GEMPT_AGENT_NAME || '',
  sessionsDir: process.env.GEMPT_SESSIONS_DIR || '',
};
if (id === 'gemini') {
  summary.prompt = process.argv[process.argv.indexOf('-p') + 1];
  summary.resume = process.argv.includes('--resume') && process.argv[process.argv.indexOf('--resume') + 1];
  if (summary.prompt === 'temporary failure') {
    console.log(JSON.stringify({ type: 'result', status: 'error', error: { message: 'transient error' } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'init', session_id: 'gem-sess-1' }));
  console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'GEMINI_OK:' + JSON.stringify(summary) }));
  console.log(JSON.stringify({ type: 'result', status: 'success', stats: { models: { gem: {
    tokens: { prompt: 10, input: 4, candidates: 5, cached: 6, thoughts: 1, total: 16 } } } } }));
} else if (id === 'grok' || id === 'copilot') {
  console.log('PLAIN_OK:' + JSON.stringify(summary));
} else {
  console.log(JSON.stringify({ session_id: id + '-sess-1', text: 'JSON_OK:' + JSON.stringify(summary), usage: { input_tokens: 11, output_tokens: 7 } }));
}
`);
  }

  writeFileSync(configPath, JSON.stringify({
    version: 1,
    magpie: { base_url: gatewayUrl, api_key: 'sk-decl-key' },
    codex: { default_sandbox: 'workspace-write', timeout_sec: 300 },
    execution: { default_cli: 'auto', cli_paths: cliPaths },
    routing_policy: { default_tier: 'sonnet', failover_mode: 'paired' },
  }));
  const env = { ...process.env, GEMPT_CONFIG: configPath, GEMPT_SESSIONS_DIR: sessionsDir, GEMPT_DISABLE_IPC_DISPATCH: '1' };

  for (const id of targets) {
    const run = await dispatchRun({
      goal: `Test adapter ${id}`,
      cwd,
      cli: id,
      model: id === 'gemini' ? 'gemini/gemini-2.5-pro' : 'openai/gpt-5',
      swarm_id: `sw-${id}`,
      swarm_agent: `w-${id}`,
      background: true,
    }, { configPath, sessionsDir, env });
    const done = await waitForRun(run.run_id, { sessionsDir, timeoutSec: 15 });
    assert.equal(done.state, 'finished', `${id} failed: ${done.error}`);
    assert.equal(done.cli, id);
    assert.equal(done.result.cli, id);
    const match = done.result.text.match(/(?:GEMINI|PLAIN|JSON)_OK:(\{.*\})/);
    assert.ok(match, `${id} output missing structured payload: ${done.result.text}`);
    const payload = JSON.parse(match[1]);
    assert.equal(payload.cli, id);
    assert.equal(payload.openaiBase, `${gatewayUrl}/v1`);
    if (id === 'gemini') {
      assert.equal(payload.geminiBase, gatewayUrl);
      assert.equal(done.result.usage.input_tokens, 10);
      assert.equal(done.result.usage.cache_hit_ratio, .6);
      const wake = async (goal) => {
        const receipt = await dispatchRun({ cli: id, model: done.result.model, goal, cwd,
          session_id: done.session_id, background: true }, { configPath, sessionsDir, env, swarmWake: true });
        return waitForRun(receipt.run_id, { sessionsDir, timeoutSec: 15 });
      };
      assert.equal((await wake('temporary failure')).state, 'failed');
      assert.equal(JSON.parse(readFileSync(join(sessionsDir, done.session_id + '.json'))).runner_session_id, 'gem-sess-1');
      const retry = await wake('fresh board message');
      assert.equal(retry.state, 'finished', retry.error);
      const resumed = JSON.parse(retry.result.text.match(/GEMINI_OK:(\{.*\})/)[1]);
      assert.equal(resumed.prompt, 'fresh board message');
      assert.equal(resumed.resume, 'gem-sess-1');
    }
    assert.equal(payload.swarmId, `sw-${id}`);
    assert.equal(payload.agent, `w-${id}`);
    assert.equal(payload.sessionsDir, sessionsDir);

    const host_conversation_id = 'single-' + id;
    const soloResult = await handleTool('gpt_run', { cwd, cli: id, goal: 'Inspect the project', host_conversation_id,
      background: true }, env, { configPath, sessionsDir });
    const receipt = JSON.parse(soloResult.content[0].text);
    assert.ok(receipt.wait_command.includes(receipt.run_id));
    const solo = await waitForRun(receipt.run_id, { sessionsDir, timeoutSec: 15 });
    assert.equal(solo.state, 'finished', solo.error);
    const board = await getSwarmOverview(solo.swarm_id, { sessionsDir });
    assert.equal(board.head, 0);
    assert.equal(board.roster.length, 1);
    assert.equal(board.roster[0].cli, id);
    assert.equal(board.roster[0].session_id, receipt.session_id);
    const invocation = JSON.parse(solo.result.text.match(/(?:GEMINI|PLAIN|JSON)_OK:(\{.*\})/)[1]);
    assert.equal(invocation.swarmId, '');
    assert.equal(invocation.agent, '');
    if (id === 'gemini') {
      assert.doesNotMatch(invocation.prompt, /board_post|Shared message board protocol/);
      const added = await handleSwarmAction({ action: 'add', fork: board.roster[0].name, name: 'child',
        brief: 'Check the previous answer', host_conversation_id, cwd }, { configPath, sessionsDir, env });
      assert.equal(added.swarm_id, solo.swarm_id);
      const child = await waitForRun(added.workers[0].run_id, { sessionsDir, timeoutSec: 15 });
      assert.equal(child.fork_mode, 'summary_fallback', child.error);
      const forked = JSON.parse(child.result.text.match(/GEMINI_OK:(\{.*\})/)[1]);
      assert.match(forked.prompt, /GEMINI_OK:/);
      assert.equal(forked.agent, 'child');
    }
  }
});

test('Swarm end-to-end with non-Codex Claude worker posts to SQLite board via board-mcp and wakes gempt-wait --board', async (t) => {
  const dir = makeTmp(t, 'gempt-swarm-claude-');
  const cwd = join(dir, 'repo');
  const sessionsDir = join(dir, 'sessions');
  const configPath = join(dir, 'cfg', 'config.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, 'cfg'), { recursive: true });
  const gatewayUrl = await startMockGateway(t);

  // Mock Claude worker that actually launches the board-mcp server referenced in --mcp-config
  // and invokes board_post over JSON-RPC stdio!
  const mockClaudeSwarm = makeMockCli(dir, 'mock-claude-swarm', `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
for await (const _ of process.stdin) { /* drain prompt */ }
const args = process.argv.slice(2);
const mcpIdx = args.indexOf('--mcp-config');
if (mcpIdx < 0) { console.error('Missing --mcp-config'); process.exit(2); }
const mcpCfg = JSON.parse(readFileSync(args[mcpIdx + 1], 'utf8'));
const srv = mcpCfg.mcpServers.gempt_board;
const reqs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'board_post', arguments: { text: '@coordinator [done] Claude worker completed via board-mcp!' } },
  },
].map((r) => JSON.stringify(r)).join('\\n') + '\\n';
const out = execFileSync(srv.command, srv.args, {
  input: reqs,
  env: { ...process.env, ...srv.env },
  encoding: 'utf8',
  windowsHide: true,
});
const lines = out.trim().split('\\n').map((l) => JSON.parse(l));
const postRes = lines.find((l) => l.id === 2);
if (!postRes?.result || postRes.result.isError) {
  console.error('board_post failed:', out);
  process.exit(3);
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-swarm-sess-1' }));
console.log(JSON.stringify({
  type: 'result',
  session_id: 'claude-swarm-sess-1',
  result: 'Posted completion to board via board-mcp.',
  is_error: false,
}));
`);

  writeFileSync(configPath, JSON.stringify({
    version: 1,
    magpie: { base_url: gatewayUrl, api_key: 'sk-swarm-test' },
    codex: { default_sandbox: 'workspace-write', timeout_sec: 300 },
    execution: { default_cli: 'claude', cli_paths: { claude: mockClaudeSwarm } },
    routing_policy: { default_tier: 'sonnet', failover_mode: 'paired', native_swarm: false },
  }));
  const env = { ...process.env, GEMPT_CONFIG: configPath, GEMPT_SESSIONS_DIR: sessionsDir, GEMPT_DISABLE_IPC_DISPATCH: '1' };

  const swarmId = 'sw-claude-e2e';
  const added = await handleSwarmAction({
    action: 'add',
    swarm_id: swarmId,
    cwd,
    name: 'designer',
    cli: 'claude',
    model: 'claude/claude-sonnet-4',
    brief: 'Audit UI spacing and report via board_post.',
  }, { configPath, sessionsDir, env });

  assert.equal(added.ok, true);
  assert.equal(added.workers[0].cli, 'claude');

  // Wait on board for @coordinator wakeup!
  const wake = await waitForBoard(swarmId, {
    since: added.workers[0].brief_seq,
    mentionsOnly: true,
    timeoutSec: 15,
    sessionsDir,
  });
  assert.ok(!wake.timed_out);
  assert.ok(wake.messages.some((m) => m.from_agent === 'designer' && m.text.includes('Claude worker completed via board-mcp!')));

  // Wait for worker turn to finish and confirm no duplicate auto-summary was posted.
  await waitForRun(added.workers[0].run_id, { sessionsDir, timeoutSec: 15 });
  for (let i = 0; i < 40; i++) {
    const ov = await getSwarmOverview(swarmId, { sessionsDir });
    if (ov.roster[0].state === 'waiting') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const overview = await getSwarmOverview(swarmId, { sessionsDir });
  assert.equal(overview.roster[0].state, 'waiting');
  assert.equal(overview.roster[0].cli, 'claude');
  const msgs = await readBoardMessages(swarmId, { sessionsDir, limit: 20 });
  assert.equal(msgs.filter((m) => m.from_agent === 'designer').length, 1);
});

test('backend exposes runners, execution config, zero-CLI readiness, and default native_swarm: false', async (t) => {
  const dir = makeTmp(t, 'gempt-backend-runners-');
  const configPath = join(dir, 'config.json');
  const sessionsDir = join(dir, 'sessions');
  const magpieConfigDir = join(dir, 'magpie');
  const emptyBin = join(dir, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  const gatewayUrl = await startMockGateway(t);
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    magpie: { base_url: gatewayUrl },
    codex: { default_sandbox: 'workspace-write', timeout_sec: 3600 },
    routing_policy: { default_tier: 'sonnet', failover_mode: 'paired' },
  }));

  const env = { ...process.env, PATH: emptyBin };
  const st0 = await readState({ configPath, sessionsDir, magpieConfigDir, env });
  assert.equal(st0.native_swarm, false, 'shell-free GemPT Swarm should be default (native_swarm: false)');
  assert.equal(st0.execution.default_cli, 'auto');
  assert.equal(st0.runners.length, 11);

  // Update execution.default_cli and execution.cli_paths via settings API.
  const upd1 = await updateSettings({ default_cli: 'opencode' }, { configPath });
  assert.equal(upd1.ok, true);
  assert.equal(getExecutionConfig(JSON.parse(readFileSync(configPath, 'utf8'))).default_cli, 'opencode');

  const upd2 = await updateSettings({
    execution: { default_cli: 'claude', cli_paths: { claude: process.execPath, codex: process.execPath } },
  }, { configPath });
  assert.equal(upd2.ok, true);
  const disk = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(disk.execution.default_cli, 'claude');
  assert.equal(disk.execution.cli_paths.claude, process.execPath);
  assert.equal(disk.codex.cli_path, process.execPath, 'codex.cli_path stays synced with execution.cli_paths.codex');

  const ov = await readOverview({ configPath, sessionsDir, magpieConfigDir, env });
  assert.equal(ov.execution.default_cli, 'claude');
  assert.equal(ov.runners.find((r) => r.id === 'claude').available, true);
  assert.equal(ov.has_any_runner, true);

  // Reject invalid default_cli cleanly.
  const bad = await updateSettings({ default_cli: 'not-a-cli' }, { configPath });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  // Verify HTTP API /api/overview and /api/settings expose execution & runners.
  const apiRes = await dispatchPageApi({
    method: 'GET',
    url: new URL('/api/overview', 'http://localhost'),
    rawPath: '/api/overview',
    readBody: async () => ({}),
  }, { configPath, sessionsDir, magpieConfigDir, env });
  assert.equal(apiRes.status, 200);
  assert.equal(apiRes.body.execution.default_cli, 'claude');
  assert.equal(apiRes.body.runners.length, 11);
});

test('cache input and writes normalize once across owner-specific token counters', () => {
  const models = { a: { tokens: { prompt: 30, input: 5, cached: 25, candidates: 4, thoughts: 3, total: 40 } },
    b: { tokens: { input: 7, cached: 3, candidates: 2, thoughts: 1 } }, empty: {} };
  assert.deepEqual(normalizeUsage({ models }), { input_tokens: 40, cached_input_tokens: 28,
    output_tokens: 6, reasoning_tokens: 4, total_tokens: 53 });
  assert.equal(normalizeUsage({ models, input_tokens: 0, output_tokens: 1 }).input_tokens, 0);
  assert.equal(normalizeUsage({ models, input: 12 }).input_tokens, 40);
  for (const [raw, written] of [
    [{ input_tokens: 100, input_tokens_details: { cached_tokens: 40 } }, undefined],
    [{ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } }, undefined],
    [{ inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 5 }, 5],
    [{ input_tokens: 55, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 }, 5],
    [{ input: 55, cache: { read: 40, write: 5 } }, 5],
    [{ promptTokenCount: 100, cachedContentTokenCount: 40 }, undefined],
    [{ input_tokens: 100, cached: 40 }, undefined],
  ]) {
    const usage = normalizeUsage(raw);
    assert.equal(usage.input_tokens, 100);
    assert.equal(usage.cache_write_tokens, written);
    assert.equal(cacheHitRatio(usage), .4);
    assert.deepEqual(normalizeUsage(usage), usage);
  }
});

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { serveAppServerSocket } from './app-server-fixture.mjs';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installAgy, resolveNodeExecutable, stagePluginBundle, syncInPlace, validatePluginBundle } from '../core/agy-install.mjs';
import { buildTierView, setEffortSettings } from '../core/config.mjs';
import { assertSafeOutDir } from '../scripts/build-agy-plugin.mjs';
import { contextPath, readHostContext, updateHostContext } from '../core/host-context.mjs';
import { runLiveOperation } from '../core/live-service.mjs';
import { handleTool, TOOLS } from '../core/mcp-server.mjs';
import { buildWaitCommand, dispatchRun, interruptRun, isRecentUnconfirmedRun, listActiveRoster, readRun,
  reconcileRunState, replyToolCall, runDirectory, saveRun, steerRun, waitForRun, waitForRuns } from '../core/runs.mjs';
import { DEFAULT_LOCK_STALE_MS, isValidSessionId, lockStaleMsForBudget, validateSessionId, withLock } from '../core/state.mjs';
import { linkTarget, listArguments, streamRenderKey, timelineMessages } from '../mcp_app/live-state.js';
import { assertShareWorktree, ensureShareWorktree, pruneShareWorktrees,
  removeShareWorktree, worktreesRoot } from '../core/worktrees.mjs';
import { createAppServerManager } from '../magpie_plugin/lib/app-server-manager.mjs';
import { probeGatewaySettings, readOverview, readRoutingSummary, readState, resetSettings, updateSettings } from '../magpie_plugin/lib/backend.mjs';
import { dispatchPageApi } from '../magpie_plugin/lib/page-api.mjs';
import { resolveExecTimeoutSec } from '../magpie_plugin/lib/routing.mjs';
import { runAppServer } from '../magpie_plugin/lib/app-server-run.mjs';

const execFileAsync = promisify(execFile);
const hookPath = fileURLToPath(new URL('../plugin/work_split_hook.mjs', import.meta.url));
const cliPath = fileURLToPath(new URL('../bin/gempt.mjs', import.meta.url));

test('Live builds the split pane and preserves host scope, safe link routes and exact transcript text', () => {
  const html = readFileSync(new URL('../core/assets/http-ui/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../core/assets/http-ui/styles.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../core/assets/http-ui/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../mcp_app/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(html, /<meta\s+http-equiv=["']Content-Security-Policy["']/i);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css">/);
  assert.match(html, /<script defer src="\.\/app\.js"><\/script>/);
  assert.ok(css.includes(styles));
  assert.match(css, /@media \(min-width: 900px\)[\s\S]+?grid-template-columns: 290px minmax\(0, 1fr\)/);
  assert.match(css, /max-width: 760px; margin: 0 auto/);
  assert.match(html, /id="scope-all"[^>]+>全部<\/button>/);
  assert.match(js, /createTHead\(/);

  assert.deepEqual(listArguments('session', null), { scope: 'session', limit: 50 });
  assert.deepEqual(listArguments('session', 'selected'), { scope: 'session', limit: 50, host_conversation_id: 'selected' });
  assert.deepEqual(listArguments('all', 'selected', 50), { scope: 'all', limit: 50, offset: 50 });
  assert.deepEqual(linkTarget('https://example.org/test?q=a&b=c'), { kind: 'web', value: 'https://example.org/test?q=a&b=c' });
  assert.equal(linkTarget('file:///C:/workspace/notes.md'), null);
  assert.deepEqual(linkTarget('file:///C:/workspace/notes.md', null, { approved: true }), { kind: 'file', value: 'file:///C:/workspace/notes.md' });
  assert.deepEqual(linkTarget('file:///C:/workspace/notes.md', null, { fileUris: { 'notes.md': 'file:///C:/workspace/notes.md' } }),
    { kind: 'file', value: 'file:///C:/workspace/notes.md' });
  assert.deepEqual(linkTarget('src/file name.md#L8', 'D:\\gempt'), { kind: 'file', value: 'file:///D:/gempt/src/file%20name.md#L8' });
  assert.equal(linkTarget('C:\\workspace\\notes.md', 'D:\\gempt'), null);
  assert.equal(linkTarget('../outside.md', 'D:\\gempt'), null);
  for (const target of ['javascript:alert(1)', 'data:text/html,x', '//example.org/file', 'file://example.org/share/file']) {
    assert.equal(linkTarget(target, 'D:/gempt'), null);
  }

  const first = { id: 'one', type: 'agent_message', text: 'First' };
  const second = { id: 'two', type: 'agent_message', text: 'Second' };
  const events = [first, { type: 'command', output: 'old' }, second];
  assert.deepEqual([...timelineMessages(events, 'First paragraph\n\nSecond paragraph')], [
    [first, 'First paragraph'], [second, 'Second paragraph'],
  ]);
  assert.deepEqual([...timelineMessages(events, 'Prior hidden message\n\nFirst\n\nSecond')], [
    [second, 'Prior hidden message\n\nFirst\n\nSecond'],
  ]);
  const key = (timeline, text) => streamRenderKey('id', 'running', timeline, {}, { text, complete: true }, null, true);
  assert.notEqual(key(events, 'same'), key(events, 'size'));
  assert.notEqual(key(events, 'same'), key([first, { type: 'command', output: 'new' }, second], 'same'));
});

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gempt-node-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'config', 'config.json');
  const sessionsDir = join(root, 'sessions');
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  return { root, cwd, configPath, sessionsDir, env: { ...process.env, GEMPT_CONFIG: configPath,
    GEMPT_SESSIONS_DIR: sessionsDir, GEMPT_WORKTREES_DIR: join(root, 'worktrees'), GEMPT_WORKSPACE_ROOT: cwd } };
}

function jsonProcess(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('Node hook emits entry banners and one user-only alert per context milestone', (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.configPath));
  writeFileSync(join(dirname(f.configPath), 'app-server.json'),
    JSON.stringify({ status: 'running', pid: process.pid, ws_url: 'ws://127.0.0.1:1' }));
  const env = { ...f.env, GEMPT_APP_SERVER_STATE: join(dirname(f.configPath), 'app-server.json') };
  const invoke = (payload) => jsonProcess(process.execPath, [hookPath], { env, input: JSON.stringify(payload) });
  for (const [profile, share] of [['gemini', 0], ['gemini_first', 15], ['balanced', 35], ['gpt', 60], ['gpt_first', 80]]) {
    writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split: profile } }));
    const payload = { conversationId: profile, workspacePaths: [f.cwd], modelName: 'gemini-4-neon-high' };
    const start = invoke({ ...payload, hookEventName: 'SessionStart' });
    if (share) assert.match(start.injectSteps[0].systemMessage.systemMessage, new RegExp(`${share}% GPT, family=neon`));
    else assert.deepEqual(start, {});
    const turn = { ...payload, hookEventName: 'PreInvocation', initialNumSteps: 31, lastUserInput: 'Review this' };
    const entry = invoke({ ...turn, invocationNum: 0 });
    if (share) assert.ok(entry.injectSteps[0].systemMessage.systemMessage.startsWith(`[GemPT ${share}%] `));
    else assert.deepEqual(entry, {});
    assert.deepEqual(invoke({ ...turn, invocationNum: 1 }), {});
  }
  assert.equal(readHostContext(f.configPath).conversation_id, 'gpt_first');
  const transcriptPath = join(f.root, 'transcript.jsonl');
  const turn = { hookEventName: 'PreInvocation', conversationId: 'long-chat', invocationNum: 7, transcriptPath };
  for (const tokens of [120, 200, 280]) {
    writeFileSync(transcriptPath, `${'x'.repeat(70_000)}\n${JSON.stringify({ type: 'PLANNER_RESPONSE', cache_read_tokens: tokens * 1000 })}\n`);
    const { systemMessage } = invoke(turn).injectSteps[0];
    assert.equal(systemMessage.systemMessage, '');
    assert.match(systemMessage.metadata.user_markdown, new RegExp(`${tokens}k.*\\/compact`));
    assert.deepEqual(invoke(turn), {});
  }
});

test('Node hook applies write and explore gates with exemptions, resets and fail-open', (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.configPath));
  const health = join(f.root, 'app-server.json');
  const env = { ...f.env, GEMPT_APP_SERVER_STATE: health, GEMPT_CIRCUIT_WINDOW_SEC: '600' };
  const set = (work_split) => writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split, native_swarm: false } }));
  const allow = (name, args, payload) => jsonProcess(process.execPath, [hookPath], { env,
    input: JSON.stringify({ hookEventName: 'PreToolUse', conversationId: 'turn', workspacePaths: [f.cwd],
      lastUserInput: 'Change this', toolCall: { name, args }, ...payload }) });
  const edit = (TargetFile = join(f.cwd, 'app.mjs'), Content = 'code', payload) => allow('edit_file', { TargetFile, Content }, payload);
  set('balanced');
  assert.equal(edit().decision, 'allow');
  writeFileSync(health, JSON.stringify({ status: 'running', pid: process.pid, ws_url: 'ws://127.0.0.1:1' }));
  assert.match(edit().reason, /35% Write Gate/);
  assert.equal(edit(join(f.cwd, 'app.json'), 'line\n'.repeat(15)).decision, 'allow');
  assert.match(edit(join(f.cwd, 'app.json'), 'line\n'.repeat(16)).reason, /Write Gate/);
  assert.equal(edit(join(f.cwd, 'README.md')).decision, 'allow');
  assert.equal(edit(join(f.cwd, '.gemini', 'antigravity', 'brain', 'prototype.js')).decision, 'allow');
  assert.equal(edit(undefined, undefined, { lastUserInput: '这里你自己改' }).decision, 'allow');
  for (const profile of ['gemini', 'gemini_first']) {
    set(profile);
    assert.equal(edit().decision, 'allow');
  }
  for (const [profile, share, limit] of [['gpt', 60, 5], ['gpt_first', 80, 2]]) {
    set(profile);
    const read = () => allow('read_file', { Path: join(f.cwd, 'app.mjs') }, { lastUserInput: profile });
    for (let count = 0; count < limit; count++) assert.equal(read().decision, 'allow');
    const reason = read().reason;
    assert.ok(reason.startsWith(`[GemPT ${share}% Explore Stop-Loss] `));
    assert.match(reason, new RegExp(`limit ${limit}`));
    assert.equal(reason.includes('Codex CLI'), profile === 'gpt_first');
    assert.equal(allow('run_command', { CommandLine: 'gempt status --run-id 123 --wait' }).decision, 'allow');
    for (const delegation of [
      ['call_mcp_tool', { ServerName: 'gempt_gempt', ToolName: 'gpt_run' }],
      ['invoke_subagent', { TypeName: 'gempt-worker', Prompt: 'Do it', Role: 'Example' }],
    ]) {
      assert.equal(allow(...delegation, { lastUserInput: profile }).decision, 'allow');
      for (let count = 0; count < limit; count++) assert.equal(read().decision, 'allow');
      assert.equal(read().decision, 'deny');
    }
  }
  state(f, 'a'.repeat(32), { state: 'failed' });
  assert.equal(edit().decision, 'deny');
  state(f, 'b'.repeat(32), { state: 'outcome_unknown' });
  assert.equal(edit().decision, 'allow');
});

test('Antigravity installer replaces a legacy target and stages a runnable Node-only plugin and wait shims', async (t) => {
  const f = fixture(t);
  const target = join(f.root, 'plugins with spaces', 'gempt');
  const binDir = join(f.root, 'bin with spaces');
  const legacyLock = join(dirname(target), '.gempt-install.lock');
  const legacyWait = join(binDir, 'gempt-wait.py');
  mkdirSync(join(target, 'runtime', 'gempt'), { recursive: true });
  mkdirSync(binDir);
  writeFileSync(legacyLock, '');
  writeFileSync(legacyWait, 'legacy');
  writeFileSync(join(target, 'plugin.json'), JSON.stringify({ name: 'gempt' }));
  writeFileSync(join(target, 'work_split_hook.py'), 'legacy');
  writeFileSync(join(target, 'runtime', 'gempt', 'mcp_server.py'), 'legacy');
  const refreshCalls = [];
  const languageServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    refreshCalls.push({ url: req.url, method: req.method, token: req.headers['x-codeium-csrf-token'],
      data: JSON.parse(Buffer.concat(chunks)) });
    res.end('{}');
  });
  languageServer.listen(0, '127.0.0.1');
  await once(languageServer, 'listening');
  t.after(() => languageServer.close());
  const env = { ...f.env, ANTIGRAVITY_CSRF_TOKEN: 'fixture', ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${languageServer.address().port}` };
  assert.equal(resolveNodeExecutable({ execPath: join(f.root, 'magpie-bun'), env: { PATH: dirname(process.execPath) } }), process.execPath);
  const macHome = join(f.root, 'mac-home');
  const nvmOld = join(macHome, '.nvm', 'versions', 'node', 'v18.19.0', 'bin');
  const nvmNew = join(macHome, '.nvm', 'versions', 'node', 'v22.2.0', 'bin');
  mkdirSync(nvmOld, { recursive: true });
  mkdirSync(nvmNew, { recursive: true });
  writeFileSync(join(nvmOld, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(nvmNew, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveNodeExecutable({ execPath: join(f.root, 'magpie-bun'), env: { PATH: '' }, platform: 'darwin', home: macHome }), join(nvmNew, 'node'));
  const { findCodexCli } = await import('../magpie_plugin/lib/app-server-manager.mjs');
  writeFileSync(join(nvmNew, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findCodexCli('', { PATH: '' }, { platform: 'darwin', home: macHome }), join(nvmNew, 'codex'));
  const installed = await installAgy({ target, binDir, env });
  assert.equal(installed.installed, true);
  assert.ok(!existsSync(legacyLock));
  assert.ok(!existsSync(legacyWait));
  assert.ok(existsSync(join(binDir, 'gempt-wait.mjs')));
  const cliShim = join(binDir, process.platform === 'win32' ? 'gempt.cmd' : 'gempt');
  assert.ok(installed.cli_shims.includes(cliShim));
  const help = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'gempt.cmd --help'], { cwd: binDir, env, encoding: 'utf8' })
    : spawnSync(cliShim, ['--help'], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr || help.error?.message);
  assert.match(help.stdout, /\|run\|ask\|/);
  assert.ok(installed.refresh.refreshed);
  assert.deepEqual(refreshCalls, [{ url: '/exa.language_server_pb.LanguageServerService/RefreshMcpServers',
    method: 'POST', token: 'fixture', data: { serverName: 'gempt_gempt' } }]);
  const bridge = join(target, 'work_split_hook.py');
  assert.equal(readFileSync(bridge, 'utf8').trimEnd().split('\n').length, 7);
  assert.ok(!existsSync(join(target, 'runtime', 'gempt')));
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'runtime', 'package.json'), 'utf8')), { type: 'module', version: '0.8.0' });
  const bundledSkills = new URL('../plugin/skills/', import.meta.url);
  assert.deepEqual(readdirSync(bundledSkills).sort(), ['gempt', 'gempt-chore']);
  assert.deepEqual(readdirSync(join(target, 'skills')).sort(), ['gempt', 'gempt-chore']);
  const config = JSON.parse(readFileSync(join(target, 'mcp_config.json'), 'utf8'));
  const { command, args } = config.mcpServers.gempt;
  assert.equal(command, process.execPath);
  const sidecar = JSON.parse(readFileSync(join(target, 'sidecars', 'gempt_live', 'sidecar.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8'));
  assert.equal(manifest.displayName, 'GemPT');
  assert.equal(sidecar.display_name, 'GemPT');
  assert.deepEqual(sidecar.ui_config, { display_name: 'GemPT', views: [
    { path: '/', entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', title: 'GemPT' },
  ] });
  assert.equal(sidecar.command, command);
  assert.deepEqual(sidecar.args, ['main.mjs']);
  assert.deepEqual(args, [join(target, 'runtime', 'core', 'mcp-server.mjs')]);
  const initialized = jsonProcess(command, args, { cwd: f.root, env, input: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  }) });
  assert.equal(initialized.result.serverInfo.version, '0.8.0');
  assert.equal(initialized.result.capabilities.resources, undefined);
  const listedResources = jsonProcess(command, args, { cwd: f.root, env, input: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'resources/list',
  }) });
  assert.deepEqual(listedResources.result.resources, []);
  const ctlStatus = jsonProcess(command, args, { cwd: f.root, env, input: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'gpt_ctl', arguments: { action: 'status' } },
  }) });
  assert.equal(ctlStatus.error, undefined);
  assert.notEqual(ctlStatus.result?.isError, true, ctlStatus.result?.content?.[0]?.text);
  assert.equal(typeof JSON.parse(ctlStatus.result.content[0].text), 'object');
  const rulesText = readFileSync(join(target, 'rules', 'AGENTS.md'), 'utf8');
  assert.ok(rulesText.trim());
  const hooks = JSON.parse(readFileSync(join(target, 'hooks.json'), 'utf8'));
  const matcher = hooks['gempt-work-split'].PreToolUse[0].matcher.split('|');
  for (const name of ['swarm', 'post_message', 'read_board', 'swarm_wait', 'define_subagent', 'send_message']) {
    assert.ok(matcher.includes(name), name);
  }
  const hook = hooks['gempt-work-split'].SessionStart[0].command;
  assert.ok(hook.includes('work_split_hook.mjs'));
  assert.doesNotMatch(hook, /python/i);
  const hookResult = process.platform === 'win32'
    ? jsonProcess(command, [join(target, 'work_split_hook.mjs')], { cwd: f.root, env, input: '{"hookEventName":"SessionStart"}' })
    : jsonProcess('sh', ['-c', hook], { cwd: f.root, env, input: '{"hookEventName":"SessionStart"}' });
  assert.match(hookResult.injectSteps[0].systemMessage.systemMessage, /GemPT v2 active/);
  await t.test('cached Python hook forwards SessionStart to Node', (t) => {
    const python = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean)
      .find((candidate) => spawnSync(candidate, ['-I', '-c', 'import sys'], { windowsHide: true }).status === 0);
    if (!python) return t.skip('A legacy Python launcher is needed to exercise the compatibility bridge.');
    const throughBridge = jsonProcess(python, ['-I', bridge], { cwd: f.root, env, input: '{"hookEventName":"SessionStart"}' });
    assert.deepEqual(throughBridge, hookResult);
  });
  const first = 'a'.repeat(32);
  const second = 'b'.repeat(32);
  state(f, first, { state: 'finished' });
  state(f, second, { state: 'finished' });
  const shim = join(binDir, 'gempt-wait');
  const runShim = (args) => process.platform === 'win32'
    ? jsonProcess(command, [`${shim}.mjs`, ...args], { cwd: f.root, env })
    : jsonProcess(shim, args, { cwd: f.root, env });
  assert.equal(runShim([first]).run_id, first);
  assert.equal(runShim(['status', '--run-id', first, '--wait']).state, 'finished');
  assert.deepEqual(runShim([`${first},${second}`]).ready, [first, second]);
  assert.deepEqual(runShim(['--all', `${first},${second}`]).ready, [first, second]);
  const source = join(f.root, 'invalid plugin');
  mkdirSync(source);
  for (const name of ['hooks.json', 'mcp_config.json', 'work_split_hook.mjs']) {
    copyFileSync(join(dirname(hookPath), name), join(source, name));
  }
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'wrong-plugin' }));
  await assert.rejects(installAgy({ source, target, binDir, env }), /manifest name 'gempt'/);
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'mcp_config.json'), 'utf8')), config);
});

test('Antigravity installer resets Windows plugin and shim ACLs after placement, even if icacls is unavailable', async (t) => {
  const f = fixture(t);
  const target = join(f.cwd, 'plugin with spaces');
  const binDir = join(f.cwd, 'bin with spaces');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let installWindowsAgy;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    ({ installAgy: installWindowsAgy } = await import('../core/agy-install.mjs?test-windows-acls'));
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }

  const calls = [];
  const mock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({
      command: basename(command), args, options,
      exists: existsSync(args[0]), pluginPlaced: existsSync(join(target, 'plugin.json')),
      shimsWritten: existsSync(join(binDir, 'gempt-wait.cmd')),
    });
    return { error: Object.assign(new Error('icacls unavailable'), { code: 'ENOENT' }) };
  });
  syncBuiltinESMExports();
  try {
    const env = { ...f.env, ANTIGRAVITY_CSRF_TOKEN: '' };
    const installed = await installWindowsAgy({ target, binDir, env });
    assert.equal(installed.installed, true);
    assert.equal(installed.shims.length, 3);
    assert.deepEqual(installed.cli_shims, ['gempt', 'gempt.cmd'].map((name) => join(binDir, name)));
    assert.deepEqual(calls.map(({ args }) => args), [
      [installed.plugin_dir, '/reset', '/T', '/C', '/Q'],
      ...[...installed.shims, ...installed.cli_shims].map((path) => [path, '/reset', '/C', '/Q']),
    ]);
    assert.deepEqual(calls.map(({ shimsWritten }) => shimsWritten), [false, true, true, true, true, true]);
    assert.ok(calls.every(({ command, exists, pluginPlaced, options }) =>
      command === 'icacls.exe' && exists && pluginPlaced && options.windowsHide === true));

    if (process.platform !== 'win32') {
      calls.length = 0;
      await installAgy({ target, binDir, env });
      assert.deepEqual(calls, []);
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Node CLI discovers, updates tiers, prints launchers and installs to an isolated home', async (t) => {
  const f = fixture(t);
  await appFixture(t, f);
  const gateway = JSON.parse(readFileSync(f.configPath, 'utf8')).magpie.base_url;
  rmSync(f.configPath);
  const env = { ...f.env, HOME: f.root, USERPROFILE: f.root, MAGPIE_ADDR: gateway,
    ANTIGRAVITY_CSRF_TOKEN: '' };
  const cli = async (...args) => JSON.parse((await execFileAsync(process.execPath, [cliPath, ...args], {
    env, cwd: f.root, timeout: 15_000, windowsHide: true,
  })).stdout);
  const discovery = await cli('discover');
  assert.equal(discovery.config.path, f.configPath);
  assert.equal(typeof discovery.codex.found, 'boolean');
  const preview = await cli('init', '--non-interactive', '--sandbox', 'read-only',
    '--utility-model', 'fixture/utility', '--dry-run');
  assert.equal(preview.saved, false);
  assert.equal(preview.config.codex.default_sandbox, 'read-only');
  assert.equal(preview.config.utility.model, 'fixture/utility');
  assert.ok(!existsSync(f.configPath));
  await cli('init', '--non-interactive');
  assert.equal((await cli('tier')).default_tier, 'sonnet');
  assert.equal((await cli('tier', 'opus')).default_tier, 'opus');
  assert.equal((await cli('tier')).default_tier, 'opus');
  assert.equal((await cli('sandbox', 'read-only')).default_sandbox, 'read-only');
  assert.equal((await cli('effort', 'auto')).auto_effort, true);
  const id = 'a'.repeat(32);
  state(f, id, { state: 'finished' });
  assert.equal((await cli('wait', '--all', id)).run_id, id);
  assert.equal((await cli('status', '--run-id', id, '--wait')).state, 'finished');
  assert.match((await cli('print-mcp')).mcpServers.gempt.args[0], /core[/\\]mcp-server\.mjs$/);
  const target = join(f.root, 'cli plugin');
  const installed = await cli('install-agy', '--target', target);
  assert.equal(installed.plugin_dir, target);
  assert.ok(!existsSync(join(target, 'work_split_hook.py')));
  assert.ok(existsSync(join(f.root, 'bin', 'gempt-wait.mjs')));
  assert.deepEqual(await cli('print-mcp', '--installed', '--target', target), installed.mcp_config);
});

test('legacy routing fields do not affect effort settings or custom tier model IDs', (t) => {
  const f = fixture(t);
  const sonnet = {
    consult_model: 'group/custom-consult',
    exec_model: 'group/custom-exec',
    magpie_group_members: ['codex/gpt-6.2-astra'],
  };
  mkdirSync(dirname(f.configPath), { recursive: true });
  writeFileSync(f.configPath, JSON.stringify({
    routing_policy: { magpie_group_strategy: 'order' },
    tiers: { sonnet },
  }));
  assert.equal(setEffortSettings({ tier: 'sonnet', tierEffort: 'low' }, { configPath: f.configPath }).ok, true);
  const saved = JSON.parse(readFileSync(f.configPath, 'utf8'));
  const tier = buildTierView('sonnet', saved.tiers.sonnet, 'sonnet');
  assert.equal(tier.consult_model, sonnet.consult_model);
  assert.equal(tier.exec_model, sonnet.exec_model);
  assert.equal(tier.reasoning_effort, 'low');
  assert.equal(Object.hasOwn(tier, 'magpie_group_members'), false);
});

test('portable Antigravity bundle validates and a shim failure reports a partial install', async (t) => {
  const f = fixture(t);
  const bundleDir = join(f.root, 'bundle');
  stagePluginBundle(bundleDir, { portable: true });
  await validatePluginBundle(bundleDir, resolveNodeExecutable(), f.env, { portable: true });
  writeFileSync(join(bundleDir, 'rules', 'AGENTS.md'), ' \n');
  await assert.rejects(validatePluginBundle(bundleDir, resolveNodeExecutable(), f.env, { portable: true }),
    /Empty Antigravity plugin rules text/);
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'plugin.json'), 'utf8'));
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.equal(typeof manifest.author?.name, 'string');
  assert.ok(manifest.author.name.trim());
  for (const name of ['assets/logo.svg', 'THIRD_PARTY_LICENSES.txt', 'README.md']) {
    assert.ok(readFileSync(join(bundleDir, name), 'utf8').trim(), name);
  }

  const target = join(f.root, 'installed-plugin');
  const binDir = join(f.root, 'bin-file');
  writeFileSync(binDir, 'keep this file');
  const result = await installAgy({ target, binDir, env: f.env });
  assert.equal(result.plugin_installed, true);
  assert.equal(result.shim_installed, false);
  assert.equal(result.installed, false);
  assert.ok(result.shim_error);
  assert.ok(result.cli_shim_error);
  assert.ok(result.warnings.some((warning) => warning.includes(result.shim_error)));
  assert.equal(JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8')).name, 'gempt');
  assert.equal(readFileSync(binDir, 'utf8'), 'keep this file');
});

test('Antigravity installer stages assets from an installed bundle', async (t) => {
  const f = fixture(t);
  const bundle = join(f.root, 'bundle');
  stagePluginBundle(bundle, { portable: true });
  const template = join('templates', 'bundle-only.json');
  writeFileSync(join(bundle, template), '{}');
  const runtime = join(bundle, 'runtime');
  const installer = await import(pathToFileURL(join(runtime, 'core', 'agy-install.mjs')).href);
  const restaged = join(f.root, 'restaged');
  installer.stagePluginBundle(restaged, { portable: true });
  assert.equal(readFileSync(join(restaged, template), 'utf8'), '{}');
  await validatePluginBundle(restaged, process.execPath, f.env, { portable: true });
});

test('packaged native sidecar serves shared assets and authenticates scoped APIs with the Antigravity SDK', async (t) => {
  const sdk = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk');
  if (!existsSync(join(sdk, 'index.mjs'))) return t.skip('Antigravity Sidecar SDK is unavailable');
  const f = fixture(t);
  const bundle = join(f.root, 'bundle');
  stagePluginBundle(bundle, { portable: true });
  const alternate = join(f.root, 'another workspace');
  const active = 'active-conversation';
  mkdirSync(alternate);
  const id = '1'.repeat(32);
  const otherWorkspace = '2'.repeat(32);
  const otherConversation = '3'.repeat(32);
  state(f, id, { state: 'finished', host_conversation_id: active });
  state(f, otherWorkspace, { state: 'finished', host_conversation_id: active, cwd: alternate });
  state(f, otherConversation, { state: 'finished', host_conversation_id: 'other-conversation' });
  await updateHostContext('other-conversation', [f.cwd], f);
  mkdirSync(dirname(f.configPath), { recursive: true });
  writeFileSync(f.configPath, '{}');
  const token = 'fixture-sidecar-token';
  const cwd = join(bundle, 'sidecars', 'gempt_live');
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(sdk, 'register_loader.js')).href, 'main.mjs'], {
    cwd, env: { ...f.env, ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:0', ANTIGRAVITY_CSRF_TOKEN: 'fixture',
      ANTIGRAVITY_CONVERSATION_ID: active, ANTIGRAVITY_SIDECAR_WEB_PORT: '0', ANTIGRAVITY_SIDECAR_UI_TOKEN: token },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  try {
    const scanner = createInterface({ input: child.stdout });
    const [line] = await once(scanner, 'line', { signal: AbortSignal.timeout(5000) });
    const base = 'http://' + line.match(/listening on (127[.]0[.]0[.]1:[0-9]+)/)[1];
    const html = await fetch(base).then((response) => response.text());
    assert.match(html, /loadScript\('gempt-preload\.js'\)/);
    assert.match(html, /loadScript\('app\.js',/);
    assert.doesNotMatch(html, /<script type="module"/);
    assert.equal(await fetch(base + '/index.html').then((response) => response.text()), html);
    assert.match(html, /id="view-console"/);
    const preload = await fetch(base + '/gempt-preload.js');
    assert.equal(preload.status, 200);
    const preloadSource = await preload.text();
    assert.match(preloadSource, /['"]\.\/_sidecar\/get-conversation-metadata/);
    assert.match(preloadSource, /const resolveProjectId = \(\) => projectIdPromise \?\?=/);
    const css = await fetch(base + '/styles.css');
    assert.match(css.headers.get('content-type'), /^text\/css/);
    assert.match(await css.text(), /var\(--background/);
    const js = await fetch(base + '/app.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.doesNotMatch(await js.text(), /@modelcontextprotocol|Invalid Zod|@cfworker/);
    assert.equal((await fetch(base + '/missing.js')).status, 404);

    const call = (path, payload = {}, key = token, method = 'POST') => fetch(base + '/api', {
      method, headers: { 'content-type': 'application/json', ...(key ? { 'x-sidecar-token': key } : {}) },
      body: JSON.stringify({ path: './api/' + path, ...payload }),
    });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await call('settings', { body: { codex_timeout_sec: 900 } }, '', method)).status, 401);
    }
    assert.equal((await call('summary', {}, 'bad-token')).status, 401);
    assert.equal((await fetch(base + '/api', { method: 'POST', headers: { origin: 'null' },
      body: JSON.stringify({ path: './api/summary' }),
    })).headers.get('access-control-allow-origin'), null);
    const opaqueSummary = await fetch(base + '/api?token=' + token, { method: 'POST', headers: { origin: 'null' },
      body: JSON.stringify({ path: './api/summary' }),
    });
    assert.equal(opaqueSummary.status, 200);
    assert.equal(opaqueSummary.headers.get('access-control-allow-origin'), 'null');
    assert.ok((await opaqueSummary.json()).routing);
    assert.equal((await fetch(base + '/api?token=' + token + '&path=./api/summary', { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + '/api')).status, 405);
    const workspaceUris = [pathToFileURL(f.cwd).href];
    const list = await call('live/runs', { workspaceUris }).then((response) => response.json());
    assert.equal(list.active_conversation_id, active);
    assert.deepEqual(list.runs.map((run) => run.run_id), [id]);
    const all = await call('live/runs?scope=all', { workspaceUris }).then((response) => response.json());
    assert.deepEqual(new Set(all.runs.map((run) => run.run_id)), new Set([id, otherConversation]));
    const multi = await call('live/runs', { workspaceUris: [...workspaceUris, pathToFileURL(alternate).href] })
      .then((response) => response.json());
    assert.deepEqual(new Set(multi.runs.map((run) => run.run_id)), new Set([id, otherWorkspace]));
    assert.equal((await call('live/stream?run_id=' + otherWorkspace, { workspaceUris })).status, 403);
    assert.equal((await call('requests?format=csv')).headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal((await call('settings', { body: { codex_timeout_sec: 900 } })).status, 200);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).codex.timeout_sec, 900);
  } finally {
    child.kill();
    await exited;
  }
});

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function initRepo(cwd) {
  const subdir = join(cwd, 'project');
  mkdirSync(subdir);
  writeFileSync(join(subdir, 'readme.txt'), 'tracked\n');
  git(cwd, 'init', '-q');
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return subdir;
}

function state(f, id, fields) {
  const path = join(runDirectory(id, f.sessionsDir), 'state.json');
  saveRun(path, { run_id: id, state: 'running', session_id: `exec-${id.slice(0, 1)}`, cwd: f.cwd, ...fields });
}

async function appFixture(t, f, controls = {}) {
  const packets = [];
  const turns = new Map();
  const sockets = new Set();
  let threadCount = 0;
  let turnCount = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'codex/gpt-6.2-sol' }] }));
    else if (req.url === '/v1/responses') res.end(JSON.stringify({ model: 'codex/gpt-6.2-sol', output_text: 'Consult answer.' }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  server.on('upgrade', (req, socket) => {
    if (req.headers.authorization !== 'Bearer test-token') {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let activeTurn;
    serveAppServerSocket(req, socket, (packet, send) => {
      packets.push(packet);
      const { method, id, params } = packet;
      if (method === 'initialized') return;
      let result = {};
      if (method === 'thread/start' || method === 'thread/resume') {
        const sandbox = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
        result = { thread: { id: params.threadId || `thread-${++threadCount}` }, cwd: params.cwd,
          modelProvider: params.modelProvider, sandbox: { type: sandbox[params.sandbox] } };
      } else if (method === 'turn/start') {
        const turnId = activeTurn = `turn-${++turnCount}`;
        const threadId = params.threadId;
        const event = (method, params) => send({ method, params: { threadId, turnId, ...params } });
        turns.set(turnId, (status) => {
          if (status === 'completed') event('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Prior finding: verify the result.' } });
          event('turn/completed', { turn: { id: turnId, status } });
          turns.delete(turnId);
        });
        if (params.input[0].text.includes('Ask before turn acknowledgement')) {
          controls.ask = () => send({ id: 'early-ask-rpc', method: 'item/tool/call', params: {
            threadId, turnId, callId: 'early_ask', tool: 'ask_gemini', arguments: { question: 'Proceed?' },
          } });
          return;
        }
        event('turn/started', { turn: { id: turnId, status: 'inProgress' } });
        if (params.input[0].text.includes('Disconnect the turn socket')) {
          socket.end();
          return;
        }
        send({ id, result: { turn: { id: turnId } } });
        if (params.input[0].text.includes('Request a cross-check')) {
          send({ id: 'ask-rpc', method: 'item/tool/call', params: { threadId, turnId, callId: 'ask_1',
            tool: 'ask_gemini', arguments: { reason: 'decision', question: 'Proceed?' } } });
        } else if (!params.input[0].text.includes('Hold this turn')) turns.get(turnId)('completed');
        return;
      } else if (method === 'turn/interrupt') {
        turns.get(params.turnId)?.('interrupted');
      } else if (id === 'ask-rpc') {
        turns.get(activeTurn)?.('completed');
        return;
      }
      send({ id, result });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const address = `127.0.0.1:${server.address().port}`;
  const gateway = `http://${address}`;
  mkdirSync(join(f.root, 'config'), { recursive: true });
  writeFileSync(f.configPath, JSON.stringify({ version: 1, magpie: { base_url: gateway },
    codex: { default_sandbox: 'workspace-write' }, routing_policy: { default_tier: 'sonnet', failover_mode: 'subscription_only' },
    tiers: { sonnet: { consult_model: 'codex/gpt-6.2-sol', exec_model: 'codex/gpt-6.2-sol', reasoning_effort: 'medium' } } }));
  f.env.GEMPT_APP_SERVER_STATE = join(f.root, 'app-server.json');
  writeFileSync(f.env.GEMPT_APP_SERVER_STATE, JSON.stringify({ status: 'running', ws_url: `ws://${address}`,
    auth_header: 'Authorization', auth_token: 'test-token', gateway_url: gateway }));
  return packets;
}

async function until(probe) {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    const value = probe();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('Timed out waiting for fixture state.');
}

test('gempt run and ask accept shell input and share execution and consult sessions with MCP', async (t) => {
  const f = fixture(t);
  const repoSubdir = initRepo(f.cwd);
  const workerCwd = join(f.root, 'native swarm worktree');
  git(f.cwd, 'worktree', 'add', '--detach', workerCwd, 'HEAD');
  const packets = await appFixture(t, f);
  const baseEnv = { ...f.env, GEMPT_WORKSPACE_ROOT: f.root, GEMPT_GPT_RUN_SYNC_SEC: '0' };
  const cli = (args, input = '', env = baseEnv) => {
    const pending = execFileAsync(process.execPath, [cliPath, ...args], { cwd: workerCwd, env, timeout: 15_000 });
    pending.child.stdin.end(input);
    return pending.then(({ stdout }) => JSON.parse(stdout));
  };
  const run = await cli(['run', '--goal', '-', '--access', 'inspect', '--workspace', 'inherit', '--tier', 'sonnet',
    '--family', 'hydrogen', '--host', 'coordinator', '--title', 'inspect worker', '--timeout', '90'], '  Inspect the native worktree. \n');
  assert.equal(run.state, 'queued');
  assert.equal(run.cwd, workerCwd);
  assert.equal(run.worktree_path, null);
  assert.equal(run.tier, 'sonnet');
  assert.match(run.wait_command, new RegExp(run.run_id + '$'));
  assert.equal(run.goal, undefined);
  const done = await waitForRun(run.run_id, { ...f, timeoutSec: 5 });
  assert.equal(done.state, 'finished', done.error);
  assert.equal(done.session_id, run.session_id);
  assert.equal(done.host_conversation_id, 'coordinator');
  assert.equal(done.title, 'inspect worker');
  assert.equal(done.sandbox, 'read-only');
  assert.equal(done.goal, 'Inspect the native worktree.');
  assert.equal(git(f.cwd, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 2);

  const goalFile = join(f.root, 'brief.txt');
  writeFileSync(goalFile, 'Follow up on the inspection.');
  const follow = await cli(['run', '--goal-file', goalFile, '--cwd', workerCwd, '--access', 'inspect',
    '--session', run.session_id], '', { ...baseEnv, GEMPT_GPT_RUN_SYNC_SEC: '5' });
  assert.equal(follow.state, 'finished');
  assert.equal(follow.session_id, run.session_id);
  assert.equal(follow.cwd, workerCwd);
  assert.match(follow.text, /Prior finding/);
  assert.match(packets.filter(({ method }) => method === 'turn/start').at(-1).params.input[0].text, /Follow up on the inspection/);

  writeFileSync(join(repoSubdir, 'second.txt'), 'second attachment');
  const askArgs = ['ask', '--cwd', repoSubdir, '--tier', 'sonnet', '--host', 'coordinator', '--file', 'readme.txt', '--file', 'second.txt'];
  const answer = await cli(askArgs, 'Summarize these files.');
  assert.match(answer.text, /Consult answer/);
  const consulted = JSON.parse(readFileSync(join(f.sessionsDir, answer.session_id + '.json'), 'utf8'));
  assert.equal(consulted.host_conversation_id, 'coordinator');
  const prompt = consulted.turns.find(({ role }) => role === 'user').content;
  assert.match(prompt, /tracked/);
  assert.match(prompt, /second attachment/);
  const continuation = await cli(['ask', '--goal-file', goalFile, '--cwd', repoSubdir, '--session', answer.session_id]);
  assert.equal(continuation.session_id, answer.session_id);
  await assert.rejects(cli([...askArgs, '--file', '../outside.txt'], 'Check attachments.'), /outside workspace/);

  for (const [args, input, error] of [
    [['run'], ' \n', /goal is required/],
    [['ask', '--goal', '-'], '', /goal is required/],
    [['ask', '--goal', 'x', '--goal-file', goalFile], '', /Choose --goal or --goal-file/],
    [['run', '--access', 'admin'], '', /Invalid --access/],
    [['run', '--workspace', 'other'], '', /Invalid --workspace/],
    [['run', '--access', 'inspect', '--workspace', 'share', '--goal', 'x'], '', /not allowed with read-only/],
    [['run', '--tier', 'chore'], '', /Invalid --tier/],
    [['ask', '--tier', 'unknown'], '', /Invalid --tier/],
    [['ask', '--family', 'unknown'], '', /Invalid --family/],
    [['run', '--timeout', 'Infinity'], '', /Invalid timeout_sec/],
  ]) await assert.rejects(cli(args, input), error);
});

test('host context reclaims a dead PID lock, restores the main conversation and tracks subagents', async (t) => {
  const { cwd, configPath } = fixture(t);
  const opts = { configPath };
  const lock = join(dirname(configPath), 'host-context.lock');
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  mkdirSync(dirname(configPath));
  writeFileSync(lock, `${exited.pid}:${Date.now()}\n`);
  assert.equal(basename(contextPath(configPath)), 'host-context.json');
  assert.deepEqual(readHostContext(configPath), {});
  await updateHostContext('main', [cwd, 1], { ...opts, geminiFamily: ' pro ' });
  assert.equal(readHostContext(configPath).conversation_id, 'main');
  assert.ok(!existsSync(lock));
  await updateHostContext('child', ['other'], opts);
  await updateHostContext('child', ['other'], { ...opts, parentId: 'main' });
  assert.equal(readHostContext(configPath).conversation_id, 'main');
  assert.deepEqual(readHostContext(configPath).workspace_paths, [cwd]);
  await Promise.all(['worker-z', 'worker-a'].map((id) => updateHostContext(id, [], { ...opts, parentId: 'main' })));
  const before = readHostContext(configPath);
  assert.deepEqual(before.subagent_conversations, ['child', 'worker-a', 'worker-z']);
  assert.equal(before.gemini_family, 'pro');
  assert.ok(before.updated_at > 0);
  await updateHostContext('child', [], opts);
  assert.deepEqual(readHostContext(configPath), before);
});

test('lock retries while an owner is alive and reclaims a malformed legacy record', async (t) => {
  const { root } = fixture(t);
  const lock = join(root, 'state.lock');
  writeFileSync(lock, 'legacy\n');
  const events = [];
  const first = withLock(lock, async () => {
    assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}:\\d+\\n$`));
    events.push('first enters');
    await sleep(100);
    events.push('first leaves');
  });
  const second = withLock(lock, () => events.push('second enters'));
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first enters', 'first leaves', 'second enters']);
  assert.ok(!existsSync(lock));
});

test('live PID lock is not stolen past staleMs and replaced locks are preserved on release', async (t) => {
  const { root } = fixture(t);
  const lock = join(root, 'state.lock');
  assert.equal(DEFAULT_LOCK_STALE_MS, 300_000);
  assert.equal(lockStaleMsForBudget(180), 300_000);
  assert.equal(lockStaleMsForBudget(600), 660_000);
  let releaseFirst;
  const first = withLock(lock, () => new Promise((resolve) => { releaseFirst = resolve; }));
  const expired = new Date(Date.now() - 10_000);
  utimesSync(lock, expired, expired);
  try {
    await assert.rejects(
      withLock(lock, () => {}, { attempts: 3, delayMs: 10, staleMs: 5_000 }),
      { code: 'EEXIST' },
    );
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(exited.status, 0);
    rmSync(lock);
    writeFileSync(lock, `${exited.pid}:${Date.now() - 10_000}\n`);
    await withLock(lock, async () => {
      const replacement = readFileSync(lock, 'utf8');
      releaseFirst();
      await first;
      assert.equal(readFileSync(lock, 'utf8'), replacement);
    }, { staleMs: 5_000 });
  } finally {
    releaseFirst();
    await first;
  }
  assert.ok(!existsSync(lock));
});

test('shared worktrees use detached Git HEAD, preserve subdirectories, reuse, and remove', (t) => {
  const { cwd, env } = fixture(t);
  const subdir = initRepo(cwd);
  const worktree = ensureShareWorktree(subdir, 'session-a', env);
  assert.equal(worktree.worktree_root, join(worktreesRoot(env), 'session-a'));
  assert.equal(worktree.cwd, join(worktree.worktree_root, 'project'));
  assert.equal(worktree.source_repo, cwd);
  assert.equal(worktree.source_cwd, subdir);
  assert.equal(git(worktree.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(git(worktree.cwd, 'rev-parse', 'HEAD'), git(cwd, 'rev-parse', 'HEAD'));
  writeFileSync(join(worktree.cwd, 'new.txt'), 'work in progress');
  assert.deepEqual(ensureShareWorktree(subdir, 'session-a', env), worktree);
  assert.equal(readFileSync(join(worktree.cwd, 'new.txt'), 'utf8'), 'work in progress');
  assert.throws(() => ensureShareWorktree(cwd, '../unsafe', env), /Invalid session_id/);
  assert.equal(removeShareWorktree(cwd, cwd, env), false);
  rmSync(join(worktree.cwd, 'new.txt'));
  assert.equal(removeShareWorktree(cwd, worktree.worktree_root, env), true);
  assert.equal(existsSync(worktree.worktree_root), false);
  assert.doesNotMatch(git(cwd, 'worktree', 'list'), /session-a/);
});

test('shared worktree entry points reject inspect and cleanup protects foreign and dirty worktrees', async (t) => {
  const f = fixture(t);
  const subdir = initRepo(f.cwd);
  const request = { goal: 'Inspect the project', access: 'inspect', workspace: 'share', cwd: subdir };
  const readOnlyError = /workspace='share' is not allowed with read-only access/;
  const originalWorktrees = git(f.cwd, 'worktree', 'list', '--porcelain');
  await assert.rejects(dispatchRun(request, f), readOnlyError);
  assert.equal(existsSync(worktreesRoot(f.env)), false);
  await assert.rejects(handleTool('gpt_run', request, f.env), readOnlyError);
  assert.equal(existsSync(worktreesRoot(f.env)), false);
  assert.equal(git(f.cwd, 'worktree', 'list', '--porcelain'), originalWorktrees);

  const otherRepo = join(f.root, 'other-repo');
  mkdirSync(otherRepo);
  initRepo(otherRepo);
  const foreign = ensureShareWorktree(otherRepo, 'foreign', f.env).worktree_root;
  assert.throws(() => assertShareWorktree(f.cwd, foreign, f.env), /does not belong to the requested Git repository/);

  const dirty = ensureShareWorktree(subdir, 'dirty', f.env);
  const edited = join(dirty.cwd, 'readme.txt');
  writeFileSync(edited, 'uncommitted edit\n');
  assert.equal(removeShareWorktree(f.cwd, dirty.worktree_root, f.env), false);

  const clean = ensureShareWorktree(subdir, 'clean', f.env);
  writeFileSync(join(clean.cwd, 'merged.txt'), 'merged change\n');
  git(clean.cwd, 'add', 'merged.txt');
  git(clean.cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'worktree change');
  const commit = git(clean.cwd, 'rev-parse', 'HEAD');
  assert.equal(removeShareWorktree(f.cwd, clean.worktree_root, f.env), false);
  git(f.cwd, 'merge', '--ff-only', commit);
  assert.deepEqual(pruneShareWorktrees(f.cwd, { env: f.env, maxAgeMs: 0 }),
    { removed: [clean.worktree_root], kept: [dirty.worktree_root] });
  assert.equal(existsSync(clean.worktree_root), false);
  assert.doesNotMatch(git(f.cwd, 'worktree', 'list', '--porcelain'), /\/clean(?:\r?\n|$)/);
  assert.equal(readFileSync(edited, 'utf8'), 'uncommitted edit\n');
  assert.equal(assertShareWorktree(otherRepo, foreign, f.env), foreign);
});

test('background dispatch reuses a shared worktree and upgrades inspect to a fresh writable thread', async (t) => {
  const f = fixture(t);
  const subdir = initRepo(f.cwd);
  const packets = await appFixture(t, f);
  await updateHostContext('host-main', [f.cwd], f);
  const first = await dispatchRun({ goal: 'Read-only inspection', cwd: subdir, workspace: 'inherit',
    background: true, sandbox: 'read-only' }, f);
  assert.equal(first.state, 'queued');
  assert.equal(first.host_conversation_id, 'host-main');
  assert.equal(first.worktree_path, null);
  const done = await waitForRun(first.run_id, { ...f, timeoutSec: 5 });
  assert.equal(done.state, 'finished', done.error);
  assert.equal(done.sandbox, 'read-only');
  const second = await dispatchRun({ goal: 'Make the change', cwd: subdir, session_id: done.session_id,
    workspace: 'inherit', background: true }, f);
  assert.equal(second.worktree_path, null);
  const upgraded = await waitForRun(second.run_id, { ...f, timeoutSec: 5 });
  assert.equal(upgraded.state, 'finished', upgraded.error);
  assert.equal(upgraded.sandbox_upgraded, true);
  assert.equal(upgraded.result.sandbox_upgraded, true);
  assert.equal(upgraded.cwd, first.cwd);
  assert.notEqual(upgraded.codex_thread_id, done.codex_thread_id);
  const session = JSON.parse(readFileSync(join(f.sessionsDir, `${done.session_id}.json`), 'utf8'));
  assert.equal(session.sandbox_upgraded, true);
  assert.equal(session.sandbox, 'workspace-write');
  assert.equal(session.codex_thread_id, upgraded.codex_thread_id);
  assert.deepEqual(packets.filter(({ method }) => /^thread\/(start|resume)$/.test(method)).map(({ method, params }) =>
    [method, params.sandbox]), [['thread/start', 'read-only'], ['thread/start', 'workspace-write']]);
  const input = packets.filter(({ method }) => method === 'turn/start').at(-1).params;
  assert.deepEqual(input.sandboxPolicy, { type: 'workspaceWrite' });
  assert.match(input.input[0].text, /Carryover from the prior read-only Codex thread/);
  assert.match(input.input[0].text, /Prior finding: verify the result/);

  const sharedFirst = await dispatchRun({ goal: 'Edit in shared worktree', cwd: subdir, workspace: 'share',
    background: true }, f);
  assert.equal(sharedFirst.cwd, join(sharedFirst.worktree_path, 'project'));
  const sharedDone = await waitForRun(sharedFirst.run_id, { ...f, timeoutSec: 5 });
  assert.equal(sharedDone.state, 'finished', sharedDone.error);
  const sharedSecond = await dispatchRun({ goal: 'Follow up in shared worktree', cwd: subdir,
    session_id: sharedDone.session_id, workspace: 'inherit', background: true }, f);
  assert.equal(sharedSecond.worktree_path, sharedFirst.worktree_path);
  assert.equal((await waitForRun(sharedSecond.run_id, { ...f, timeoutSec: 5 })).state, 'finished');

  const priorId = 'exec-python-example';
  writeFileSync(join(f.sessionsDir, `${priorId}.json`), JSON.stringify({ mode: 'exec', session_id: priorId,
    cwd: subdir, sandbox: 'read-only', codex_thread_id: 'legacy-thread', turns: [{ goal: 'Inspect on Python', reply: 'Legacy finding.' }] }));
  await assert.rejects(dispatchRun({ goal: 'Exceeds host ceiling', cwd: subdir, session_id: priorId,
    sandbox: 'danger-full-access' }, { ...f, waitSec: 5 }), /cannot increase ceiling/);
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  config.codex.default_sandbox = 'danger-full-access';
  writeFileSync(f.configPath, JSON.stringify(config));
  const full = await dispatchRun({ goal: 'Resume with full access', cwd: subdir, session_id: priorId,
    sandbox: 'danger-full-access' }, { ...f, waitSec: 5 });
  assert.equal(full.sandbox_upgraded, true);
  assert.equal(full.sandbox, 'danger-full-access');
  assert.notEqual(full.codex_thread_id, 'legacy-thread');
  assert.match(packets.findLast(({ method }) => method === 'turn/start').params.input[0].text, /Legacy finding/);
});

test('steer and interrupt send turn identity over WebSocket and ask_gemini relays file replies', async (t) => {
  const f = fixture(t);
  const packets = await appFixture(t, f);
  const seed = await dispatchRun({ goal: 'Create a session to resume', cwd: f.cwd, background: true }, f);
  const ready = await waitForRun(seed.run_id, { ...f, timeoutSec: 5 });
  assert.equal(ready.state, 'finished', ready.error);
  const args = { goal: 'Hold this turn', cwd: f.cwd, session_id: seed.session_id, background: true };
  const competingId = process.platform === 'win32' ? seed.session_id.toUpperCase() : seed.session_id;
  const claims = await Promise.allSettled([dispatchRun(args, f), dispatchRun({ ...args, session_id: competingId }, f)]);
  assert.equal(claims.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(claims.find(({ status }) => status === 'rejected').reason.status, 409);
  const run = claims.find(({ status }) => status === 'fulfilled').value;
  const active = await until(() => {
    const record = readRun(run.run_id, f.sessionsDir);
    assert.notEqual(record.state, 'failed', record.error);
    return record.turn_id && record;
  });
  await assert.rejects(steerRun(run.run_id, ' ', f), /non-empty/);
  assert.equal((await steerRun(run.run_id, 'Check the logs.', f)).turn_id, active.turn_id);
  assert.deepEqual(packets.find(({ method }) => method === 'turn/steer').params, {
    threadId: active.codex_thread_id, expectedTurnId: active.turn_id, input: [{ type: 'text', text: 'Check the logs.' }],
  });
  assert.equal((await interruptRun(run.run_id, f)).ok, true);
  assert.deepEqual(packets.find(({ method }) => method === 'turn/interrupt').params, {
    threadId: active.codex_thread_id, turnId: active.turn_id,
  });
  assert.equal((await waitForRun(run.run_id, { ...f, timeoutSec: 5 })).state, 'interrupted');
  await assert.rejects(interruptRun(run.run_id, f), /no active Codex turn/);

  const asking = await dispatchRun({ goal: 'Request a cross-check', cwd: f.cwd, background: true }, f);
  const waiting = await waitForRun(asking.run_id, { ...f, timeoutSec: 5 });
  assert.equal(waiting.state, 'waiting_gemini', waiting.error);
  assert.equal(waiting.pending_tool_call.call_id, 'ask_1');
  assert.throws(() => replyToolCall(asking.run_id, '../bad', 'answer', f), /Invalid tool call_id/);
  assert.equal(replyToolCall(asking.run_id, 'ask_1', 'Confirmed.', f).ok, true);
  assert.equal(replyToolCall(asking.run_id, 'ask_1', 'Confirmed.', f).ok, true);
  assert.throws(() => replyToolCall(asking.run_id, 'ask_1', 'Conflicting answer.', f), /different reply|not waiting/);
  const finished = await until(() => {
    const record = readRun(asking.run_id, f.sessionsDir);
    assert.notEqual(record.state, 'failed', record.error);
    return record.state === 'finished' && record;
  });
  assert.equal(finished.pending_tool_call, null);
  assert.deepEqual(packets.find(({ id, method }) => id === 'ask-rpc' && !method).result,
    { success: true, contentItems: [{ type: 'inputText', text: 'Confirmed.' }] });
});

test('exceptional turns attempt interruption on an open socket and after reconnecting', async (t) => {
  const f = fixture(t);
  const packets = await appFixture(t, f);
  const asking = await dispatchRun({ goal: 'Request a cross-check', cwd: f.cwd, background: true }, f);
  const waiting = await waitForRun(asking.run_id, { ...f, timeoutSec: 5 });
  assert.equal(waiting.state, 'waiting_gemini', waiting.error);
  const replies = join(runDirectory(asking.run_id, f.sessionsDir), 'tool_replies');
  mkdirSync(replies);
  writeFileSync(join(replies, 'ask_1.json'), '{}');
  const failed = await until(() => {
    const record = readRun(asking.run_id, f.sessionsDir);
    return record.state === 'failed' && record;
  });
  assert.match(failed.error, /Invalid ask_gemini reply/);
  assert.equal(failed.remote_turn_unconfirmed, undefined);
  assert.ok(packets.some(({ method, params }) => method === 'turn/interrupt' && params.turnId === waiting.turn_id));

  const disconnected = await dispatchRun({ goal: 'Disconnect the turn socket', cwd: f.cwd, background: true }, f);
  const outcome = await waitForRun(disconnected.run_id, { ...f, timeoutSec: 5 });
  assert.equal(outcome.state, 'failed', outcome.error);
  assert.equal(outcome.remote_turn_unconfirmed, true);
  assert.match(outcome.error, /Remote Codex turn may still be running/);
  assert.ok(packets.some(({ method, params }) => method === 'turn/interrupt' && params.turnId === outcome.turn_id));
});

test('expired queued claims release occupancy, but old active sessions still protect their worktree', async (t) => {
  const f = fixture(t);
  initRepo(f.cwd);
  const sessionId = 'occupied';
  const worktree = ensureShareWorktree(f.cwd, sessionId, f.env).worktree_root;
  const id = 'f'.repeat(32);
  const file = join(runDirectory(id, f.sessionsDir), 'state.json');
  const old = new Date(Date.now() - 120_000);
  state(f, id, { session_id: sessionId, worktree_path: worktree, state: 'waiting_gemini' });
  utimesSync(file, old, old);
  for (let i = 1; i <= 101; i++) state(f, i.toString(16).padStart(32, '0'), {});
  await assert.rejects(dispatchRun({ goal: 'Resume', cwd: f.cwd, session_id: sessionId, background: true }, f),
    (error) => error.status === 409 && error.message.includes(id));
  assert.deepEqual(pruneShareWorktrees(f.cwd, { env: f.env, maxAgeMs: 0 }), { removed: [], kept: [worktree] });

  state(f, id, { session_id: sessionId, worktree_path: worktree, state: 'queued', created_at: old.toISOString(),
    deadline: Date.now() / 1000 + 4500, source: 'magpie_exec' });
  assert.match(readRun(id, f.sessionsDir).error, /worker startup timed out/);
  const worker = fileURLToPath(new URL('../magpie_plugin/lib/exec-worker.mjs', import.meta.url));
  const queued = readFileSync(file, 'utf8');
  const late = spawnSync(process.execPath, [worker], { env: f.env, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ file, record: JSON.parse(queued), host: { sessionsDir: f.sessionsDir } }) });
  assert.equal(late.status, 0, late.stderr);
  assert.equal(readFileSync(file, 'utf8'), queued);
  assert.equal(listActiveRoster({ ...f, sessionId }).length, 0);
  assert.deepEqual(pruneShareWorktrees(f.cwd, { env: f.env, maxAgeMs: 0 }), { removed: [worktree], kept: [] });
});

test('wait batch returns the first ready run or waits for all and keeps waiting_gemini ready', async (t) => {
  const f = fixture(t);
  const first = 'a'.repeat(32);
  const second = 'b'.repeat(32);
  state(f, first, { state: 'waiting_gemini', host_conversation_id: 'host' });
  state(f, second, { state: 'running', host_conversation_id: 'another' });
  assert.equal(listActiveRoster({ ...f, hostConversationId: 'host' })[0].run_id, first);
  assert.deepEqual((await waitForRuns([first, second], f)).ready, [first]);
  assert.deepEqual((await waitForRuns([first, second], { ...f, waitAll: true, timeoutSec: 0 })).active, [second]);
  const completion = sleep(40).then(() => state(f, second, { state: 'finished' }));
  const batch = await waitForRuns(`${first},${second}`, { ...f, waitAll: true, timeoutSec: 2, pollInterval: 0.01 });
  await completion;
  assert.deepEqual(batch.ready, [first, second]);
  assert.deepEqual(batch.active, []);
  assert.equal(batch.runs[second].state, 'finished');
  assert.match(buildWaitCommand([first, second], { waitAll: true }), new RegExp(`--all ${first},${second}$`));
  const waitScript = fileURLToPath(new URL('../core/wait.mjs', import.meta.url));
  for (const flags of [[], ['--all']]) {
    const result = spawnSync(process.execPath, [waitScript, ...flags, `${first},${second}`], { env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).ready, batch.ready);
  }
  state(f, second, { state: 'failed', error: 'fixture error' });
  const failed = spawnSync(process.execPath, [waitScript, '--all', `${first},${second}`], { env: f.env, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).runs[first].state, 'waiting_gemini');
});

test('Live run list binds to the active conversation and workspace', async (t) => {
  const f = fixture(t);
  const first = '1'.repeat(32);
  await updateHostContext('current', [f.cwd], f);
  state(f, first, { host_conversation_id: 'current' });
  state(f, '2'.repeat(32), { host_conversation_id: 'another' });
  state(f, '3'.repeat(32), { host_conversation_id: 'current', cwd: f.root });
  const opts = { ...f, root: f.cwd };
  const scoped = await runLiveOperation('runs', {}, opts);
  assert.equal(scoped.bound_conversation_id, 'current');
  assert.equal(scoped.bound_workspace_name, 'repo');
  assert.equal(scoped.session_count, 1);
  assert.deepEqual(scoped.runs.map(({ run_id }) => run_id), [first]);
  assert.equal((await runLiveOperation('runs', { scope: 'all' }, opts)).runs.length, 2);
  assert.equal((await runLiveOperation('runs', { host_conversation_id: 'another' }, opts)).session_count, 1);
  await assert.rejects(runLiveOperation('stream', { run_id: '3'.repeat(32) }, opts), /outside host workspace/);
});

test('Live run list defaults to an empty unbound session and can list all workspace runs', async (t) => {
  const f = fixture(t);
  const first = '1'.repeat(32);
  const second = '2'.repeat(32);
  state(f, first, { host_conversation_id: 'previous' });
  state(f, second, { host_conversation_id: 'another', state: 'finished' });
  const opts = { ...f, root: f.cwd };
  const scoped = await runLiveOperation('runs', {}, opts);
  assert.equal(scoped.scope, 'session');
  assert.equal(scoped.unbound_session, true);
  assert.deepEqual(scoped.runs, []);
  assert.equal(scoped.app_server.version, '0.8.0');

  const all = await runLiveOperation('runs', { scope: 'all' }, opts);
  assert.equal(all.scope, 'all');
  assert.equal(all.unbound_session, false);
  assert.deepEqual(all.runs.map(({ run_id }) => run_id).sort(), [first, second]);
  assert.equal(all.app_server.version, '0.8.0');
});

test('Live binds normalized workspaces and never selects another run for a filtered explicit ID', async (t) => {
  const f = fixture(t);
  const other = join(f.root, 'other');
  mkdirSync(other);
  await updateHostContext('first', [f.cwd + '/.'], { ...f, geminiFamily: 'pro' });
  await updateHostContext('elsewhere', [other], { ...f, geminiFamily: 'flash' });
  const nested = join(f.cwd, 'nested');
  mkdirSync(nested);
  const workspaceContext = readHostContext(f.configPath, nested);
  assert.equal(workspaceContext.conversation_id, 'first');
  assert.equal(workspaceContext.gemini_family, 'pro');
  assert.equal(readHostContext(f.configPath).conversation_id, 'elsewhere');
  await updateHostContext('child', [f.cwd], { ...f, geminiFamily: 'flash' });
  await updateHostContext('child', [f.cwd], { ...f, parentId: 'first', geminiFamily: 'flash' });
  assert.equal(readHostContext(f.configPath, nested).gemini_family, 'pro');
  assert.equal(readHostContext(f.configPath, other).conversation_id, 'elsewhere');
  assert.deepEqual(readHostContext(f.configPath, f.root), {});
  await updateHostContext('latest', [f.cwd], f);
  await updateHostContext('first', undefined, f);
  assert.equal(readHostContext(f.configPath, nested).conversation_id, 'first');
  assert.equal(readHostContext(f.configPath, nested).gemini_family, 'pro');

  const current = '1'.repeat(32);
  const previous = '2'.repeat(32);
  state(f, current, { host_conversation_id: 'first' });
  state(f, previous, { host_conversation_id: 'previous' });
  for (let i = 3; i <= 23; i++) state(f, i.toString(16).padStart(32, '0'), { host_conversation_id: 'previous' });
  const opts = { ...f, root: f.cwd };
  const excluded = await runLiveOperation('open', { run_id: previous }, opts);
  assert.equal(excluded.active_conversation_id, 'first');
  assert.equal(excluded.requested_run, false);
  assert.equal(excluded.run_id, null);
  assert.equal(excluded.stream, null);
  assert.deepEqual(excluded.runs.map(({ run_id }) => run_id), [current]);
  const ctlExcluded = await handleTool('gpt_ctl', { run_id: previous }, f.env, opts);
  assert.equal(ctlExcluded.structuredContent, undefined);
  assert.equal(JSON.parse(ctlExcluded.content[0].text).id, previous);
  const all = await runLiveOperation('open', { scope: 'all', run_id: previous }, opts);
  assert.equal(all.run_id, previous);
  assert.equal(all.requested_run, true);
  assert.equal(all.runs.length, 23);
  const page = await runLiveOperation('runs', { scope: 'all', limit: 3 }, opts);
  assert.equal(page.next_offset, 3);
  const rest = await runLiveOperation('runs', { scope: 'all', offset: page.next_offset }, opts);
  assert.deepEqual([...page.runs, ...rest.runs].map(({ run_id }) => run_id), all.runs.map(({ run_id }) => run_id));
  const bound = await runLiveOperation('open', { host_conversation_id: 'previous' }, opts);
  assert.equal(bound.bound_conversation_id, 'previous');
  assert.equal(bound.active_conversation_id, 'first');
  const ctlBound = await handleTool('gpt_ctl', { host_conversation_id: 'previous' }, f.env, opts);
  assert.ok(JSON.parse(ctlBound.content[0].text).active.length >= 1);

  for (const [name, fields] of Object.entries({ gpt_run: ['title', 'tier', 'background', 'host_conversation_id'],
    gpt_ask: ['host_conversation_id'], gpt_ctl: ['host_conversation_id'] })) {
    const { inputSchema } = TOOLS.find((tool) => tool.name === name);
    for (const field of fields) assert.ok(Object.hasOwn(inputSchema.properties, field), `${name}.${field}`);
  }
});


test('Live run index sees new directories, worker updates and removed state files', async (t) => {
  const f = fixture(t);
  const first = '1'.repeat(32);
  const second = '2'.repeat(32);
  const runs = async () => (await runLiveOperation('runs', { scope: 'all' }, f)).runs;
  assert.deepEqual(await runs(), []);
  state(f, first, { state: 'finished', session_id: 'session-a' });
  assert.deepEqual((await runs()).map((run) => run.state), ['finished']);
  state(f, first, { state: 'running', session_id: 'session-a' });
  assert.deepEqual((await runs()).map((run) => run.state), ['running']);
  state(f, second, { state: 'finished', session_id: 'session-b' });
  assert.deepEqual(new Set((await runs()).map((run) => run.run_id)), new Set([first, second]));
  const linked = await runLiveOperation('runs', { scope: 'all', session_id: 'session-a' }, f);
  assert.deepEqual(linked.runs.map((run) => run.run_id), [first]);
  rmSync(join(runDirectory(first, f.sessionsDir), 'state.json'));
  assert.deepEqual((await runs()).map((run) => run.run_id), [second]);
});

test('Live journal filters other turns, bounds events, and pages stable Unicode text and goals', async (t) => {
  const f = fixture(t);
  const id = '4'.repeat(32);
  const full = '🧪\n'.repeat(20_000);
  const goal = '目标 🧪'.repeat(3000);
  state(f, id, { codex_thread_id: 'ours', turn_id: '1', goal });
  const journal = join(runDirectory(id, f.sessionsDir), 'events.jsonl');
  const event = (method, params) => JSON.stringify({ method, params: { threadId: 'ours', turnId: '1', ...params } }) + '\n';
  const unrelated = event('item/agentMessage/delta', { threadId: 'other', itemId: 'no', delta: 'unrelated' });
  const command = event('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'test', exitCode: 0 } });
  const message = event('item/agentMessage/delta', { itemId: 'answer', delta: full });
  const incomplete = event('item/agentMessage/delta', { itemId: 'answer', delta: ' END' }).trimEnd();
  const parse = JSON.parse;
  let parsedDiffs = 0;
  t.mock.method(JSON, 'parse', (value, ...options) => {
    if (typeof value === 'string' && value.startsWith('{"method":"turn/diff/updated"')) parsedDiffs++;
    return parse(value, ...options);
  });
  const diff = event('turn/diff/updated', { diff: 'diff only 🧪'.repeat(200_000) });
  writeFileSync(journal, unrelated + command + diff + message + incomplete);
  const call = async (args) => runLiveOperation('stream', { run_id: id, ...args }, f);
  const opened = await runLiveOperation('open', { scope: 'all' }, f);
  assert.equal(opened.runs[0].run_id, id);
  assert.equal(opened.stream, null);
  const ctlOpened = await handleTool('gpt_ctl', { scope: 'all' }, f.env, f);
  assert.equal(JSON.parse(ctlOpened.content[0].text).active[0].id, id);
  const first = await call({ max_events: 1 });
  assert.equal((await call({ max_events: 1 })).text_revision, first.text_revision);
  assert.equal(first.timeline.length, 1);
  assert.equal(first.timeline[0].type, 'agent_message');
  assert.equal(first.commands[0].exit_code, 0);
  assert.ok(first.next_text_offset > 0 && first.text_revision > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(first.full_text)) <= 96 * 1024);
  appendFileSync(journal, '\n');
  const updated = await call({});
  assert.notEqual(updated.text_revision, first.text_revision);
  const page = await call({ text_offset: first.next_text_offset, text_revision: first.text_revision });
  assert.equal(first.full_text + page.full_text, full);
  const currentPage = await call({ text_offset: updated.next_text_offset, text_revision: updated.text_revision });
  assert.equal(updated.full_text + currentPage.full_text, full + ' END');
  let reconstructedGoal = first.run.goal;
  let goalOffset = first.next_goal_offset;
  while (goalOffset !== null) {
    const page = await call({ goal_offset: goalOffset });
    reconstructedGoal += page.goal;
    goalOffset = page.next_goal_offset;
  }
  assert.equal(reconstructedGoal, goal);
  assert.deepEqual(await call({ text_offset: 20, text_revision: first.text_revision + 100 }), { stale_text_revision: true });
  appendFileSync(journal, diff.slice(0, -1));
  assert.equal((await call({})).text_revision, updated.text_revision);
  appendFileSync(journal, '\n');
  assert.equal((await call({})).text_revision, updated.text_revision);
  writeFileSync(journal, event('item/agentMessage/delta', { itemId: 'answer', delta: 'rotated' }));
  assert.equal(parsedDiffs, 0, 'large diff notifications are skipped before JSON parsing');
  assert.equal((await call({})).full_text, 'rotated');
});

test('standalone NDJSON MCP exposes only core tools without legacy MCP App resources or UI metadata', async (t) => {
  const f = fixture(t);
  await appFixture(t, f);
  await updateHostContext('host', [f.cwd], f);
  state(f, 'd'.repeat(32), { goal: '🚦'.repeat(120), host_conversation_id: 'host' });
  const linkedCore = join(f.root, 'linked core');
  symlinkSync(fileURLToPath(new URL('../core/', import.meta.url)), linkedCore, process.platform === 'win32' ? 'junction' : 'dir');
  const file = join(linkedCore, 'mcp-server.mjs');
  const child = spawn(process.execPath, [file], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const exited = once(child, 'exit');
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  async function request(method, params) {
    send({ method, params, id: ++id });
    const line = await responses.next();
    assert.equal(line.done, false);
    const data = JSON.parse(line.value);
    assert.equal(data.id, id);
    return data;
  }
  const started = await request('initialize', { protocolVersion: '2026-test' });
  assert.equal(started.result.protocolVersion, '2026-test');
  assert.equal(started.result.serverInfo.name, 'gempt');
  assert.equal(started.result.serverInfo.version, '0.8.0');
  assert.deepEqual(started.result.capabilities, { tools: { listChanged: false } });
  send({ method: 'notifications/initialized' });
  assert.deepEqual((await request('ping')).result, {});
  const { tools } = (await request('tools/list')).result;
  assert.deepEqual(tools.map(({ name }) => name), ['gpt_run', 'gpt_ask', 'gpt_ctl', 'gpt_swarm', 'gpt_board']);
  assert.deepEqual(tools.filter(({ _meta }) => _meta?.ui || _meta?.['com.google.antigravity/ui']), []);
  assert.deepEqual((await request('resources/list')).result.resources, []);
  assert.equal((await request('resources/read', { uri: 'ui://unknown' })).error.code, -32002);
  assert.equal((await request('resources/read', { uri: 'ui://gempt/live.html' })).error.code, -32002);
  const { result } = await request('tools/call', { name: 'gpt_ctl', arguments: {} });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 500);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.active.length, 1);
  assert.equal(status.active[0].id, 'd'.repeat(32));
  assert.equal(result.structuredContent, undefined);
  const oversized = 'e'.repeat(32);
  state(f, oversized, { state: 'failed', host_conversation_id: 'host', title: '🚦'.repeat(40),
    error: '🚧'.repeat(500) });
  const detail = (await request('tools/call', { name: 'gpt_ctl', arguments: { run_id: oversized } })).result;
  assert.ok(Buffer.byteLength(detail.content[0].text) <= 500);
  assert.equal(JSON.parse(detail.content[0].text).id, oversized);
  const asked = await request('tools/call', { name: 'gpt_ask', arguments: { goal: 'Summarize the fixture.' } });
  assert.equal(asked.result.isError, undefined, asked.result.content[0].text);
  assert.equal(JSON.parse(asked.result.content[0].text).text.includes('Consult answer.'), true);
  const consults = await runLiveOperation('runs', { include_consults: true }, { ...f, root: f.cwd });
  assert.equal(consults.consult_sessions[0].session_id,
    JSON.parse(asked.result.content[0].text).session_id);
  const launch = await request('tools/call', { name: 'gpt_run', arguments: { goal: 'Inspect the fixture.', access: 'inspect' } });
  assert.equal(launch.result.isError, false, launch.result.content[0].text);
  const run = JSON.parse(launch.result.content[0].text);
  assert.match(run.wait_command, new RegExp(`${run.run_id}$`));
  const complete = await waitForRun(run.run_id, { ...f, timeoutSec: 5 });
  assert.equal(complete.result?.sandbox, 'read-only', complete.error);
  assert.equal(complete.execution_timeout_sec, 3600);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});

test('waiting_gemini pauses execution timeout and deadline, and gpt_run validates timeout_sec', async (t) => {
  const f = fixture(t);
  await appFixture(t, f);
  const gateway = JSON.parse(readFileSync(f.configPath, 'utf8')).magpie.base_url;
  const runId = 'c'.repeat(32);
  const runFile = join(runDirectory(runId, f.sessionsDir), 'state.json');
  const initialDeadline = Date.now() / 1000 + 30;
  saveRun(runFile, {
    source: 'magpie_exec', run_id: runId, session_id: 'exec-pause-test', cwd: f.cwd,
    state: 'running', pid: process.pid, deadline: initialDeadline,
  });

  const runPromise = runAppServer({
    configPath: f.configPath, env: f.env, runFile, sessionId: 'exec-pause-test',
    onIdentity() {}, prompt: 'Request a cross-check', cwd: f.cwd,
    model: 'codex/gpt-6.2-sol', effort: 'medium', sandbox: 'workspace-write',
    approvalPolicy: 'never', gatewayUrl: gateway, timeoutSec: 0.45,
  });

  const waiting = await until(() => {
    const rec = readRun(runId, f.sessionsDir);
    return rec.state === 'waiting_gemini' && rec;
  });
  assert.equal(waiting.pending_tool_call.call_id, 'ask_1');
  assert.ok(waiting.waiting_since);

  // Past record.deadline must not expire while in waiting_gemini with a live worker PID.
  const waitingReconciled = reconcileRunState({
    source: 'magpie_exec', run_id: runId, state: 'waiting_gemini', pid: process.pid,
    deadline: Date.now() / 1000 - 3600, turn_id: 'turn-1',
  });
  assert.equal(waitingReconciled.state, 'waiting_gemini');
  // Dead worker PID in waiting_gemini still reconciles to outcome_unknown + remote_turn_unconfirmed.
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadWaiting = reconcileRunState({
    source: 'magpie_exec', run_id: runId, state: 'waiting_gemini', pid: exited.pid,
    deadline: Date.now() / 1000 + 3600, turn_id: 'turn-1',
  });
  assert.equal(deadWaiting.state, 'outcome_unknown');
  assert.equal(deadWaiting.remote_turn_unconfirmed, true);

  // Wait longer than timeoutSec (0.45s) before replying; paused timer must not fire.
  await sleep(650);
  assert.equal(readRun(runId, f.sessionsDir).state, 'waiting_gemini');
  assert.equal(replyToolCall(runId, 'ask_1', 'Approved.', f).ok, true);

  const result = await runPromise;
  assert.match(result.text, /Prior finding/);
  const updated = JSON.parse(readFileSync(runFile, 'utf8'));
  assert.ok(updated.waiting_gemini_sec >= 0.5, `expected waiting_gemini_sec >= 0.5, got ${updated.waiting_gemini_sec}`);
  assert.ok(Math.abs(updated.deadline - waiting.deadline - updated.waiting_gemini_sec) < 0.002,
    'deadline extends by exactly the paused duration');

  // Verify gpt_run timeout_sec schema, bounds validation, and forwarding.
  const runSchema = TOOLS.find((tool) => tool.name === 'gpt_run').inputSchema.properties.timeout_sec;
  assert.equal(runSchema.minimum, 30);
  assert.equal(runSchema.maximum, 7200);
  for (const bad of [29, 7201, NaN, Infinity, '60', null]) {
    await assert.rejects(handleTool('gpt_run', { goal: 'Check timeout', cwd: f.cwd, timeout_sec: bad }, f.env, f), /Invalid timeout_sec/);
  }
  const custom = await dispatchRun({ goal: 'Custom timeout run', cwd: f.cwd, timeout_sec: 7200, background: true }, f);
  assert.equal(custom.execution_timeout_sec, 7200);
  assert.ok(Math.abs(custom.deadline - Date.parse(custom.created_at) / 1000 - 7200) < 0.01);
  assert.equal((await waitForRun(custom.run_id, { ...f, timeoutSec: 5 })).state, 'finished');
});

test('execution clock survives 600s and early ask_gemini pauses before the start acknowledgement', async (t) => {
  const f = fixture(t);
  const controls = {};
  const packets = await appFixture(t, f, controls);
  const gateway = JSON.parse(readFileSync(f.configPath, 'utf8')).magpie.base_url;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const start = (runId, prompt, timeoutSec) => {
    state(f, runId, { source: 'magpie_exec', pid: process.pid });
    return runAppServer({
      configPath: f.configPath, env: f.env, runFile: join(runDirectory(runId, f.sessionsDir), 'state.json'),
      sessionId: 'exec-clock-test', onIdentity() {}, prompt, cwd: f.cwd, model: 'codex/gpt-6.2-sol',
      effort: 'medium', sandbox: 'workspace-write', approvalPolicy: 'never', gatewayUrl: gateway, timeoutSec,
    });
  };
  const defaultId = 'a'.repeat(32);
  const defaultRun = assert.rejects(start(defaultId, 'Hold this turn', resolveExecTimeoutSec()), /timed out after 3600s/);
  await until(() => readRun(defaultId, f.sessionsDir).turn_id);
  t.mock.timers.tick(601_000);
  assert.equal(readRun(defaultId, f.sessionsDir).state, 'running');
  assert.equal(packets.some(({ method }) => method === 'turn/interrupt'), false);
  t.mock.timers.tick(2_999_000);
  await defaultRun;

  const earlyId = 'b'.repeat(32);
  const earlyRun = assert.rejects(start(earlyId, 'Ask before turn acknowledgement', 30), /timed out after 30s/);
  await until(() => controls.ask);
  t.mock.timers.tick(5_000);
  controls.ask();
  const waiting = await until(() => {
    const record = readRun(earlyId, f.sessionsDir);
    return record.state === 'waiting_gemini' && record;
  });
  assert.equal(waiting.deadline - Date.now() / 1000, 25);
  t.mock.timers.tick(60_000);
  assert.equal(readRun(earlyId, f.sessionsDir).state, 'waiting_gemini');
  const reply = await runLiveOperation('reply', {
    run_id: earlyId, call_id: 'early_ask', message: 'Approved.',
  }, f);
  assert.equal(reply.ok, true);
  t.mock.timers.tick(100);
  const replyPacket = await until(() => packets.find(({ id }) => id === 'early-ask-rpc'));
  assert.equal(replyPacket.result.contentItems[0].text, 'Approved.');
  const resumed = readRun(earlyId, f.sessionsDir);
  assert.equal(resumed.waiting_gemini_sec, 60.1);
  assert.equal(resumed.deadline - Date.now() / 1000, 25);
  t.mock.timers.tick(24_999);
  assert.equal(readRun(earlyId, f.sessionsDir).state, 'running');
  assert.equal(packets.filter(({ method }) => method === 'turn/interrupt').length, 1);
  t.mock.timers.tick(1);
  await earlyRun;
});

test('Console migrates the legacy timeout and preserves a deliberately saved 600 seconds', async (t) => {
  const f = fixture(t);
  await appFixture(t, f);
  const options = { ...f, root: f.cwd };
  const cfg = JSON.parse(readFileSync(f.configPath, 'utf8'));
  cfg.codex.timeout_sec = 600;
  writeFileSync(f.configPath, JSON.stringify(cfg));
  assert.equal((await readState(f)).codex_timeout_sec, 3600);
  assert.equal(resolveExecTimeoutSec({ codex: cfg.codex, effort: 'high' }), 3600);
  assert.equal(resolveExecTimeoutSec({ codex: { timeout_sec: 300 }, effort: 'high' }), 900);
  assert.equal(resolveExecTimeoutSec({ codex: cfg.codex, effort: 'high', timeoutSec: 30 }), 30);
  const run = await dispatchRun({ goal: 'Check migrated timeout', cwd: f.cwd, background: true }, f);
  assert.equal(run.execution_timeout_sec, 3600);
  assert.equal((await waitForRun(run.run_id, { ...f, timeoutSec: 5 })).execution_timeout_sec, 3600);
  assert.equal((await updateSettings({ native_swarm: false }, f)).ok, true);
  assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).codex.timeout_sec, 3600);
  const api = async (method, path, body) => dispatchPageApi({
    method, url: new URL(path, 'http://localhost'), rawPath: path.split('?', 1)[0], readBody: () => body,
  }, { ...options, appServer });
  const appServer = createAppServerManager({ ...options, observeOnly: true });
  t.after(() => appServer.stop());
  const saved = await api('POST', '/api/settings', {
    codex_timeout_sec: 600, native_swarm: true, swarm_shell_model: 'gemini-3.8-flash-low',
  });
  assert.equal(saved.status, 200);
  const overview = (await api('GET', '/api/overview')).body;
  assert.equal(overview.codex_timeout_sec, 600);
  assert.equal(overview.native_swarm, true);
  assert.equal(overview.swarm_shell_model, 'gemini-3.8-flash-low');
  assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).codex.timeout_sec_customized, true);
  const customized = await dispatchRun({ goal: 'Check saved timeout', cwd: f.cwd, background: true }, f);
  assert.equal(customized.execution_timeout_sec, 600);
  assert.equal((await waitForRun(customized.run_id, { ...f, timeoutSec: 5 })).execution_timeout_sec, 600);
  assert.equal((await api('POST', '/api/settings', { codex_timeout_sec: 29 })).status, 400);
  assert.equal((await api('POST', '/api/tier', { tier: 'invalid' })).status, 400);
  const unsafeRestart = await api('POST', '/api/app-server/restart', { force: true });
  assert.equal(unsafeRestart.status, 409);
  const activity = await api('GET', '/api/requests?q=saved+timeout&limit=1');
  assert.equal(activity.body.items[0].run_id, customized.run_id);
  const details = await api('GET', `/api/requests/${encodeURIComponent(activity.body.items[0].id)}`);
  assert.equal(details.body.run_id, customized.run_id);
  const waiting = 'd'.repeat(32);
  state(f, waiting, { state: 'waiting_gemini', pending_tool_call: { tool: 'ask_gemini', call_id: 'ask_1' } });
  await assert.rejects(runLiveOperation('reply', { run_id: waiting, call_id: 'stale', message: 'yes' }, options), /not waiting/);
  await assert.rejects(runLiveOperation('reply', { run_id: waiting, call_id: 'ask_1', message: 'yes' },
    { ...options, root: join(f.root, 'other') }), /outside host workspace/);
});

test('remote_turn_unconfirmed blocks concurrent dispatch and worktree prune until interrupt clears it', async (t) => {
  const f = fixture(t);
  const subdir = initRepo(f.cwd);
  const packets = await appFixture(t, f);

  const first = await dispatchRun({ goal: 'Seed shared worktree', cwd: subdir, workspace: 'share', background: true }, f);
  const seeded = await waitForRun(first.run_id, { ...f, timeoutSec: 5 });
  assert.equal(seeded.state, 'finished', seeded.error);

  const failedId = '9'.repeat(32);
  state(f, failedId, {
    session_id: seeded.session_id, cwd: seeded.cwd, worktree_path: seeded.worktree_path, source_cwd: subdir,
    state: 'failed', codex_thread_id: seeded.codex_thread_id, turn_id: 'turn-unconfirmed',
    remote_turn_unconfirmed: true, unconfirmed_at: new Date().toISOString(),
    error: 'Remote Codex turn may still be running (no terminal status confirmed).',
    config_path: f.configPath,
  });

  // Recent unconfirmed record is occupying: blocks roster idle, same-session dispatch, and worktree prune.
  assert.equal(listActiveRoster({ ...f, sessionId: seeded.session_id }).length, 1);
  assert.equal(listActiveRoster({ ...f, sessionId: seeded.session_id })[0].remote_turn_unconfirmed, true);
  await assert.rejects(
    dispatchRun({ goal: 'Concurrent resume', cwd: subdir, session_id: seeded.session_id, background: true }, f),
    (err) => err.status === 409 && /unconfirmed remote turn/i.test(err.message),
  );
  assert.deepEqual(pruneShareWorktrees(f.cwd, { env: f.env, maxAgeMs: 0 }), { removed: [], kept: [seeded.worktree_path] });

  // gpt_ctl status exposes unconfirmed flag.
  const statusRes = await handleTool('gpt_ctl', { action: 'status', run_id: failedId }, f.env, f);
  assert.equal(JSON.parse(statusRes.content[0].text).unconfirmed, true);

  // gpt_ctl interrupt sends turn/interrupt and clears remote_turn_unconfirmed.
  const cleared = await interruptRun(failedId, f);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared_unconfirmed, true);
  assert.ok(packets.some(({ method, params }) => method === 'turn/interrupt' && params.turnId === 'turn-unconfirmed'));
  assert.equal(readRun(failedId, f.sessionsDir).remote_turn_unconfirmed, undefined);
  assert.equal(listActiveRoster({ ...f, sessionId: seeded.session_id }).length, 0);

  // Also clears when app-server reports the turn is no longer active.
  const goneId = '8'.repeat(32);
  state(f, goneId, {
    session_id: seeded.session_id, cwd: seeded.cwd, state: 'outcome_unknown',
    codex_thread_id: seeded.codex_thread_id, turn_id: 'turn-gone',
    remote_turn_unconfirmed: true, unconfirmed_at: new Date().toISOString(), config_path: f.configPath,
  });
  const clearedGone = await interruptRun(goneId, {
    ...f,
    connect: async () => ({
      disconnected: false,
      request: async () => { throw new Error('Turn not found'); },
      close() {},
    }),
  });
  assert.equal(clearedGone.cleared_unconfirmed, true);
  assert.equal(readRun(goneId, f.sessionsDir).remote_turn_unconfirmed, undefined);

  // Ancient unconfirmed run past hold window does not block forever.
  const oldIso = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  assert.equal(isRecentUnconfirmedRun({
    state: 'failed', remote_turn_unconfirmed: true, unconfirmed_at: oldIso, deadline: Date.now() / 1000 - 300,
  }), false);

  // After clearing, same-session dispatch succeeds.
  const resumed = await dispatchRun({ goal: 'Resume after clear', cwd: subdir, session_id: seeded.session_id, background: true }, f);
  assert.equal((await waitForRun(resumed.run_id, { ...f, timeoutSec: 5 })).state, 'finished');
});

test('pre-connect app-server failure does not leave an unbound session without codex_thread_id', async (t) => {
  const f = fixture(t);
  await appFixture(t, f);
  // Seed one valid session first to verify resume failure also does not corrupt it.
  const okRun = await dispatchRun({ goal: 'Healthy seed run', cwd: f.cwd, background: true }, f);
  const okDone = await waitForRun(okRun.run_id, { ...f, timeoutSec: 5 });
  assert.equal(okDone.state, 'finished', okDone.error);
  const seedFile = join(f.sessionsDir, `${okDone.session_id}.json`);
  const seedBefore = readFileSync(seedFile, 'utf8');

  // Stop app-server state so connectAppServer fails before thread/start.
  writeFileSync(f.env.GEMPT_APP_SERVER_STATE, JSON.stringify({ status: 'stopped' }));
  const broken = await dispatchRun({ goal: 'Connect failure new session', cwd: f.cwd, background: true }, f);
  const failed = await waitForRun(broken.run_id, { ...f, timeoutSec: 5 });
  assert.equal(failed.state, 'failed');
  assert.equal(existsSync(join(f.sessionsDir, `${broken.session_id}.json`)), false);

  const brokenResume = await dispatchRun({ goal: 'Connect failure resume', cwd: f.cwd, session_id: okDone.session_id, background: true }, f);
  const failedResume = await waitForRun(brokenResume.run_id, { ...f, timeoutSec: 5 });
  assert.equal(failedResume.state, 'failed');
  assert.equal(readFileSync(seedFile, 'utf8'), seedBefore);
});

test('pruning a clean shared worktree syncs session cwd back to main repo for future resumes', async (t) => {
  const f = fixture(t);
  const subdir = initRepo(f.cwd);
  await appFixture(t, f);

  const shared = await dispatchRun({ goal: 'Work in isolated worktree', cwd: subdir, workspace: 'share', background: true }, f);
  const done = await waitForRun(shared.run_id, { ...f, timeoutSec: 5 });
  assert.equal(done.state, 'finished', done.error);
  const sessionFile = join(f.sessionsDir, `${done.session_id}.json`);
  const beforePrune = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.equal(beforePrune.worktree_path, done.worktree_path);
  assert.equal(beforePrune.cwd, join(done.worktree_path, 'project'));

  assert.deepEqual(pruneShareWorktrees(f.cwd, { env: f.env, maxAgeMs: 0 }), { removed: [done.worktree_path], kept: [] });
  assert.equal(existsSync(done.worktree_path), false);
  const afterPrune = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.equal(afterPrune.cwd, subdir);
  assert.equal(afterPrune.worktree_path, null);
  assert.ok(afterPrune.worktree_pruned_at);
  assert.equal(afterPrune.pruned_worktree_path, done.worktree_path);

  // Resume with workspace='inherit' in main repo subdir succeeds.
  const resumedInherit = await dispatchRun({ goal: 'Continue in main repo', cwd: subdir, session_id: done.session_id,
    workspace: 'inherit', background: true }, f);
  const doneInherit = await waitForRun(resumedInherit.run_id, { ...f, timeoutSec: 5 });
  assert.equal(doneInherit.state, 'finished', doneInherit.error);
  assert.equal(doneInherit.cwd, subdir);

  // Resume with workspace='share' recreates worktree and succeeds.
  const resumedShare = await dispatchRun({ goal: 'Continue in fresh worktree', cwd: subdir, session_id: done.session_id,
    workspace: 'share', background: true }, f);
  const doneShare = await waitForRun(resumedShare.run_id, { ...f, timeoutSec: 5 });
  assert.equal(doneShare.state, 'finished', doneShare.error);
  assert.equal(doneShare.worktree_path, done.worktree_path);
});

test('gempt-wait batch returns non-zero when first-ready item fails and session_id validation enforces strict rules', (t) => {
  const f = fixture(t);
  const waitScript = fileURLToPath(new URL('../core/wait.mjs', import.meta.url));
  const failedId = '1'.repeat(32);
  const unknownId = '2'.repeat(32);
  const runningId = '3'.repeat(32);
  const waitingId = '4'.repeat(32);
  const finishedId = '5'.repeat(32);
  state(f, failedId, { state: 'failed', error: 'boom' });
  state(f, unknownId, { state: 'outcome_unknown' });
  state(f, runningId, { state: 'running' });
  state(f, waitingId, { state: 'waiting_gemini' });
  state(f, finishedId, { state: 'finished' });

  const batchFailed = spawnSync(process.execPath, [waitScript, `${failedId},${runningId}`], { env: f.env, encoding: 'utf8' });
  assert.equal(batchFailed.status, 1, batchFailed.stderr);
  assert.deepEqual(JSON.parse(batchFailed.stdout).ready, [failedId]);

  const batchUnknown = spawnSync(process.execPath, [waitScript, `${unknownId},${runningId}`], { env: f.env, encoding: 'utf8' });
  assert.equal(batchUnknown.status, 1, batchUnknown.stderr);
  assert.deepEqual(JSON.parse(batchUnknown.stdout).ready, [unknownId]);

  const batchFinished = spawnSync(process.execPath, [waitScript, `${finishedId},${runningId}`], { env: f.env, encoding: 'utf8' });
  assert.equal(batchFinished.status, 0, batchFinished.stderr);
  assert.deepEqual(JSON.parse(batchFinished.stdout).ready, [finishedId]);

  const singleWaiting = spawnSync(process.execPath, [waitScript, waitingId], { env: f.env, encoding: 'utf8' });
  assert.equal(singleWaiting.status, 0, singleWaiting.stderr);
  assert.equal(JSON.parse(singleWaiting.stdout).state, 'waiting_gemini');

  for (const good of ['exec-20261123-abc123', 'consult-1.2_3', 'session-a', 'a'.repeat(128)]) {
    assert.equal(isValidSessionId(good), true, good);
    assert.equal(validateSessionId(` ${good} `), good);
  }
  for (const bad of ['', '.', '..', '.hidden', '-flag', 'exec-a..b', 'exec-end.', 'a'.repeat(129), 'CON', 'nul.txt', '../escape', 'bad/id', 'bad\\id']) {
    assert.equal(isValidSessionId(bad), false, bad);
    assert.throws(() => validateSessionId(bad), /Invalid session_id/);
  }
});

test('runAppServer interrupt confirmation window distinguishes confirmed vs unconfirmed timeout', async (t) => {
  const f = fixture(t);
  let delayInterruptMs = 80;
  let emitCompletedOnInterrupt = true;
  const server = createServer((req, res) => { res.statusCode = 404; res.end('{}'); });
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (opcode, body) => {
      const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
        : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    };
    const send = (data) => frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...data })));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127;
        const offset = length === 126 ? 4 : 2;
        if (buffer.length < offset) return;
        if (offset === 4) length = buffer.readUInt16BE(2);
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const body = buffer.subarray(offset + 4, offset + 4 + length);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) { frame(8, body); socket.end(); continue; }
        if (opcode !== 1) continue;
        const { method, id, params } = JSON.parse(body.toString('utf8'));
        if (method === 'initialized') continue;
        if (method === 'initialize') send({ id, result: {} });
        else if (method === 'thread/start') {
          send({ id, result: { thread: { id: 'th-delay' }, cwd: params.cwd, modelProvider: params.modelProvider, sandbox: { type: 'workspaceWrite' } } });
        } else if (method === 'turn/start') {
          send({ method: 'turn/started', params: { threadId: params.threadId, turnId: 'tu-delay', turn: { id: 'tu-delay', status: 'inProgress' } } });
          send({ id, result: { turn: { id: 'tu-delay' } } });
        } else if (method === 'turn/interrupt') {
          send({ id, result: {} });
          if (emitCompletedOnInterrupt) {
            setTimeout(() => {
              if (!socket.destroyed) {
                send({ method: 'turn/completed', params: { threadId: params.threadId, turnId: params.turnId, turn: { id: params.turnId, status: 'interrupted' } } });
              }
            }, delayInterruptMs);
          }
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const s of sockets) s.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const addr = `127.0.0.1:${server.address().port}`;
  const gateway = `http://${addr}`;
  f.env.GEMPT_APP_SERVER_STATE = join(f.root, 'delay-app-server.json');
  writeFileSync(f.env.GEMPT_APP_SERVER_STATE, JSON.stringify({
    status: 'running', ws_url: `ws://${addr}`, auth_header: 'Authorization', auth_token: 'tok', gateway_url: gateway,
  }));

  const id1 = '6'.repeat(32);
  const file1 = join(runDirectory(id1, f.sessionsDir), 'state.json');
  saveRun(file1, { source: 'magpie_exec', run_id: id1, session_id: 'exec-delay-1', cwd: f.cwd, state: 'running', pid: process.pid });
  await assert.rejects(
    runAppServer({
      configPath: f.configPath, env: f.env, runFile: file1, sessionId: 'exec-delay-1', onIdentity() {},
      prompt: 'Hold', cwd: f.cwd, model: 'codex/gpt-6.2-sol', effort: 'medium', sandbox: 'workspace-write',
      approvalPolicy: 'never', gatewayUrl: gateway, timeoutSec: 0.12, interruptConfirmMs: 400,
    }),
    (err) => /timed out/.test(err.message) && !err.remoteTurnUnconfirmed,
  );

  emitCompletedOnInterrupt = false;
  const id2 = '7'.repeat(32);
  const file2 = join(runDirectory(id2, f.sessionsDir), 'state.json');
  saveRun(file2, { source: 'magpie_exec', run_id: id2, session_id: 'exec-delay-2', cwd: f.cwd, state: 'running', pid: process.pid });
  await assert.rejects(
    runAppServer({
      configPath: f.configPath, env: f.env, runFile: file2, sessionId: 'exec-delay-2', onIdentity() {},
      prompt: 'Hold forever', cwd: f.cwd, model: 'codex/gpt-6.2-sol', effort: 'medium', sandbox: 'workspace-write',
      approvalPolicy: 'never', gatewayUrl: gateway, timeoutSec: 0.12, interruptConfirmMs: 120,
    }),
    (err) => err.remoteTurnUnconfirmed === true && /Remote Codex turn may still be running/.test(err.message),
  );
});

test('Live restricts out-of-workspace files, exposes remote_turn_unconfirmed, and hook applies swarm_split', async (t) => {
  const f = fixture(t);
  const inside = join(f.cwd, 'ok.txt');
  const outside = join(f.root, 'secret.txt');
  writeFileSync(inside, 'ok\n');
  writeFileSync(outside, 'secret\n');
  const id = '5'.repeat(32);
  state(f, id, {
    state: 'failed', codex_thread_id: 'th-1', turn_id: 'tu-1', remote_turn_unconfirmed: true,
    progress: { phase: 'failed', touched_files: ['ok.txt', '../secret.txt', outside] },
  });
  const streamed = await runLiveOperation('stream', { run_id: id }, { ...f, root: f.cwd });
  assert.equal(streamed.run.remote_turn_unconfirmed, true);
  assert.equal(streamed.run.can_interrupt, true);
  assert.ok(streamed.file_uris['ok.txt']);
  assert.equal(streamed.file_uris['../secret.txt'], undefined);
  assert.equal(streamed.file_uris[outside], undefined);
  assert.equal(streamed.restricted_files['../secret.txt'], 'outside_workspace');
  assert.equal(streamed.restricted_files[outside], 'outside_workspace');

  mkdirSync(dirname(f.configPath), { recursive: true });
  writeFileSync(join(dirname(f.configPath), 'app-server.json'),
    JSON.stringify({ status: 'running', pid: process.pid, ws_url: 'ws://127.0.0.1:1' }));
  writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split: 'balanced', swarm_split: 'gpt_first' } }));
  const env = { ...f.env, GEMPT_APP_SERVER_STATE: join(dirname(f.configPath), 'app-server.json') };
  const swarmStart = jsonProcess(process.execPath, [hookPath], {
    env: { ...env, GEMPT_SWARM_MODE: '1' },
    input: JSON.stringify({ hookEventName: 'SessionStart', conversationId: 'swarm-worker', workspacePaths: [f.cwd] }),
  });
  assert.match(swarmStart.injectSteps[0].systemMessage.systemMessage, /80% GPT/);
  writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split: 'balanced', swarm_split: 'inherit' } }));
  const inheritedStart = jsonProcess(process.execPath, [hookPath], {
    env: { ...env, GEMPT_SWARM_MODE: '1' },
    input: JSON.stringify({ hookEventName: 'SessionStart', conversationId: 'swarm-inherit', workspacePaths: [f.cwd] }),
  });
  assert.match(inheritedStart.injectSteps[0].systemMessage.systemMessage, /balanced \(35% GPT, swarm\)/);
});

test('Coordinator detects Swarm tools without a host flag and inherits the coordination policy', (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.configPath), { recursive: true });
  const appState = join(dirname(f.configPath), 'app-server.json');
  writeFileSync(appState, JSON.stringify({ status: 'running', pid: process.pid, ws_url: 'ws://127.0.0.1:1' }));
  const env = { ...f.env, GEMPT_APP_SERVER_STATE: appState, GEMPT_SWARM_MODE: '', GEMPT_IS_SWARM: '', GEMPT_SWARM_ROLE: '' };
  const payload = { conversationId: 'coordinator', workspacePaths: [f.cwd], lastUserInput: 'Review the work.' };
  const invoke = (event) => jsonProcess(process.execPath, [hookPath], { env, input: JSON.stringify({ ...payload, ...event }) });
  const tool = (name, args, fields) => invoke({ hookEventName: 'PreToolUse', toolCall: { name, args }, ...fields });
  const policy = (work_split, swarm_split = 'inherit', extra = {}) =>
    writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split, swarm_split, ...extra } }));
  const path = join(f.cwd, 'index.mjs');
  const statePath = join(dirname(f.configPath), 'hook-state', 'coordinator.json');
  // Default mode (native_swarm: false): shell-free GemPT Swarm allows gpt_run and guides to gpt_swarm / gpt_board.
  policy('gpt_first');
  assert.equal(tool('swarm', { action: 'models' }).decision, 'allow');
  assert.ok(!existsSync(statePath));
  assert.match(tool('edit_file', { Path: path }).reason, /Write Gate.*gpt_swarm/);
  const mcp = (ToolName, fields) => tool('call_mcp_tool', { ServerName: 'gempt_gempt', ToolName }, fields);
  assert.equal(mcp('gpt_run').decision, 'allow');
  assert.match(invoke({ hookEventName: 'SessionStart', conversationId: 'shell-free-default' }).injectSteps[0].systemMessage.systemMessage, /gpt_swarm.*gpt_board/);
  // Opt-in AGY native Swarm mode (native_swarm: true).
  policy('gpt_first', 'inherit', { native_swarm: true });
  assert.equal(tool('swarm', { action: 'add' }).decision, 'allow');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).is_swarm, true);
  assert.match(tool('edit_file', { Path: path }).reason, /80% Write Gate/);
  const denied = mcp('gpt_run');
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /workspace="share".*"inherit".*plan.json.*--host coordinator --title <name> --goal -/);
  assert.equal(mcp('gpt_ask').decision, 'allow');
  assert.equal(mcp('gpt_ctl').decision, 'allow');
  assert.equal(mcp('gpt_run', { lastUserInput: '不用 swarm' }).decision, 'allow');
  assert.equal(mcp('gpt_run', { lastUserInput: 'direct gpt_run' }).decision, 'allow');
  const worker = { conversationId: 'worker', parentConversationId: 'coordinator' };
  assert.equal(mcp('gpt_run', worker).decision, 'allow');
  assert.equal(tool('run_command', { CommandLine: 'cat work.txt | gempt run --goal -' }, { conversationId: 'worker' }).decision, 'allow');
  writeFileSync(appState, JSON.stringify({ status: 'running', healthy: false, pid: process.pid, ws_url: 'ws://127.0.0.1:1' }));
  assert.equal(mcp('gpt_run').decision, 'allow');
  writeFileSync(appState, JSON.stringify({ status: 'running', pid: process.pid, ws_url: 'ws://127.0.0.1:1' }));
  writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split: 'gpt_first', native_swarm: false } }));
  assert.equal(mcp('gpt_run').decision, 'allow');
  writeFileSync(f.configPath, JSON.stringify({ routing_policy: { work_split: 'gpt_first', native_swarm: true, swarm_shell_model: 'gemini-3.8-flash-low' } }));
  const entry = (initialNumSteps) => invoke({ hookEventName: 'PreInvocation', invocationNum: 0, initialNumSteps });
  const message = entry(1).injectSteps[0].systemMessage.systemMessage;
  assert.match(message, /Swarm Coordinator.*gemini-3.8-flash-low/);
  assert.match(message, /gempt run --cwd "\$PWD" --workspace inherit.*wait_command/);
  assert.deepEqual(entry(1), {});
  policy('gemini');
  assert.deepEqual(entry(2), {});
  policy('gemini', 'gpt_first', { native_swarm: true });
  assert.match(entry(3).injectSteps[0].systemMessage.systemMessage, /\[GemPT 80%\]/);
  assert.match(tool('edit_file', { Path: path }).reason, /Write Gate/);
  for (const [name, args] of [
    ...['status', 'title', 'model', 'kill'].map((action) => ['swarm', { action }]),
    ...['post_message', 'read_board', 'swarm_wait', 'define_subagent', 'send_message'].map((name) => [name, {}]),
  ]) {
    const conversationId = name === 'swarm' ? args.action : name;
    tool(name, args, { conversationId });
    const file = join(dirname(statePath), conversationId + '.json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).is_swarm, true);
  }
});

test('packaging guards unsafe output paths and rolls back in-place sync on verify failure', async (t) => {
  const f = fixture(t);
  assert.throws(() => assertSafeOutDir(f.root, { cwd: f.root, repoRoot: f.root, homeDir: f.root, tmpDir: f.root }), /Refusing/);
  const staged = join(f.root, 'staged');
  const target = join(f.root, 'target');
  mkdirSync(staged);
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'original');
  writeFileSync(join(staged, 'keep.txt'), 'updated');
  writeFileSync(join(staged, 'added.txt'), 'extra');
  await assert.rejects(
    syncInPlace(staged, target, { verify: async () => { throw new Error('verify boom'); } }),
    /verify boom/,
  );
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'original');
  assert.equal(existsSync(join(target, 'added.txt')), false);
});

test('Console API saves nested preferences and supports gateway actions', async (t) => {
  const f = fixture(t);
  const gateway = createServer((_req, res) => res.end(JSON.stringify({ data: [{ id: 'vendor/model:small' }] })));
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => gateway.close());
  const url = 'http://127.0.0.1:' + gateway.address().port;
  const set = (args) => updateSettings(args, f);
  const secret = 'mcp-fixture-value-z123';
  assert.equal((await set({ ui: { language: 'zh' } })).ok, true);
  assert.equal((await readOverview(f)).configured, false);
  assert.equal(resetSettings({}, f).keep_gateway, true);
  const saved = await set({
    magpie: { base_url: url + '/', api_key: secret, api_key_env: '' },
    swarm_shell_model: 'vendor/shell:stable@v2',
    routing_policy: { excluded_models: ['  model-to-skip  '] },
    utility: { model: 'vendor/model:small', reasoning_effort: 'high' },
    limits: { consult_timeout_sec: 1800 },
    codex: { cli_path: '', extra_args: [' --strict-config '] },
    ui: { language: 'en' },
  });
  assert.equal(saved.ok, true);
  const state = await readOverview(f);
  assert.equal(state.swarm_shell_model, 'vendor/shell:stable@v2');
  assert.equal(state.magpie_base_url, url);
  assert.equal(state.magpie_api_key_hint, '••••z123');
  assert.equal(state.magpie_api_key_env, '');
  assert.equal(state.utility.model, 'vendor/model:small');
  assert.equal(state.utility.reasoning_effort, 'high');
  assert.deepEqual(state.excluded_models, ['model-to-skip']);
  assert.deepEqual(state.codex_extra_args, ['--strict-config']);
  assert.equal(state.consult_timeout_sec, 1800);
  assert.equal(state.ui.language, 'en');
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal(readRoutingSummary(f).ui.language, 'en');
  assert.equal((await set({ swarm_shell_model: 'shell bad' })).ok, false);
  assert.equal((await set({ codex: { extra_args: [1] } })).ok, false);
  assert.equal((await set({ limits: { consult_timeout_sec: 14 } })).ok, false);
  assert.equal((await set({ ui: { language: 'de' } })).ok, false);
  assert.equal((await set({ codex: { extra_args: ['bad\nflag'] } })).ok, false);
  const probe = await probeGatewaySettings({ base_url: url, api_key: 'draft-secret' }, f);
  assert.equal(probe.reachable, true);
  assert.deepEqual(probe.models, ['vendor/model:small']);
  assert.ok(!JSON.stringify(probe).includes('draft-secret'));
  resetSettings({ keep_gateway: true }, f);
  assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).magpie.api_key, secret);
  resetSettings({ keep_gateway: false }, f);
  assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).magpie.api_key, '');
});

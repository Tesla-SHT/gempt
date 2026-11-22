import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { contextPath, readHostContext, updateHostContext } from '../core/host-context.mjs';
import { APP_RESOURCE, APP_URI, callAppTool, readAppResource } from '../core/mcp-app.mjs';
import { buildWaitCommand, dispatchRun, interruptRun, listActiveRoster, readRun, replyToolCall, runDirectory,
  saveRun, steerRun, waitForRun, waitForRuns } from '../core/runs.mjs';
import { ensureShareWorktree, removeShareWorktree, worktreesRoot } from '../core/worktrees.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gempt-node-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'config', 'config.json');
  const sessionsDir = join(root, 'sessions');
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  return { root, cwd, configPath, sessionsDir, env: { ...process.env, GEMPT_CONFIG: configPath,
    GEMPT_SESSIONS_DIR: sessionsDir, GEMPT_WORKTREES_DIR: join(root, 'worktrees'), GEMPT_WORKSPACE_ROOT: cwd } };
}

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

async function appFixture(t, f) {
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
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    function frame(opcode, body) {
      const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
        : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    }
    const send = (data) => frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...data })));
    let activeTurn;
    function rpc(packet) {
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
        event('turn/started', { turn: { id: turnId, status: 'inProgress' } });
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
    }
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
        if (opcode === 1) rpc(JSON.parse(body.toString('utf8')));
        else if (opcode === 8) { frame(8, body); socket.end(); }
      }
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

test('host context restores the main conversation and tracks subagents across lock contention', async (t) => {
  const { cwd, configPath } = fixture(t);
  const opts = { configPath };
  assert.equal(basename(contextPath(configPath)), 'host-context.json');
  assert.deepEqual(readHostContext(configPath), {});
  await updateHostContext('main', [cwd, 1], { ...opts, geminiFamily: ' pro ' });
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
  assert.equal(removeShareWorktree(cwd, worktree.worktree_root, env), true);
  assert.equal(existsSync(worktree.worktree_root), false);
  assert.doesNotMatch(git(cwd, 'worktree', 'list'), /session-a/);
});

test('background dispatch reuses a shared worktree and upgrades inspect to a fresh writable thread', async (t) => {
  const f = fixture(t);
  const subdir = initRepo(f.cwd);
  const packets = await appFixture(t, f);
  await updateHostContext('host-main', [f.cwd], f);
  const first = await dispatchRun({ goal: 'Read-only inspection', cwd: subdir, workspace: 'share',
    background: true, sandbox: 'read-only' }, f);
  assert.equal(first.state, 'queued');
  assert.equal(first.host_conversation_id, 'host-main');
  assert.equal(first.cwd, join(first.worktree_path, 'project'));
  const done = await waitForRun(first.run_id, { ...f, timeoutSec: 5 });
  assert.equal(done.state, 'finished', done.error);
  assert.equal(done.sandbox, 'read-only');
  const second = await dispatchRun({ goal: 'Make the change', cwd: subdir, session_id: done.session_id,
    workspace: 'inherit', background: true }, f);
  assert.equal(second.worktree_path, first.worktree_path);
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
  const run = await dispatchRun({ goal: 'Hold this turn', cwd: f.cwd, background: true }, f);
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
});

test('Live resource and run list bind to the active conversation and workspace', async (t) => {
  const f = fixture(t);
  assert.match(readAppResource().contents[0].text, /GemPT Live/);
  assert.equal(readAppResource().contents[0].uri, APP_URI);
  const pane = join(f.root, 'blank.html');
  writeFileSync(pane, '\n ');
  assert.throws(() => readAppResource({ env: { GEMPT_APP_HTML: pane } }), /non-empty/);
  const first = '1'.repeat(32);
  await updateHostContext('current', [f.cwd], f);
  state(f, first, { host_conversation_id: 'current' });
  state(f, '2'.repeat(32), { host_conversation_id: 'another' });
  state(f, '3'.repeat(32), { host_conversation_id: 'current', cwd: f.root });
  const opts = { ...f, root: f.cwd };
  const { structuredContent: scoped } = await callAppTool('gempt_app_runs', {}, opts);
  assert.equal(scoped.bound_conversation_id, 'current');
  assert.equal(scoped.bound_workspace_name, 'repo');
  assert.equal(scoped.session_count, 1);
  assert.deepEqual(scoped.runs.map(({ run_id }) => run_id), [first]);
  assert.equal((await callAppTool('gempt_app_runs', { scope: 'all' }, opts)).structuredContent.runs.length, 2);
  assert.equal((await callAppTool('gempt_app_runs', { host_conversation_id: 'another' }, opts)).structuredContent.session_count, 1);
  await assert.rejects(callAppTool('gempt_app_stream', { run_id: '3'.repeat(32) }, opts), /outside host workspace/);
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
  writeFileSync(journal, unrelated + command + message + incomplete);
  const call = async (args) => (await callAppTool('gempt_app_stream', { run_id: id, ...args }, f)).structuredContent;
  const first = await call({ max_events: 1 });
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
});

test('standalone NDJSON MCP advertises three model tools and four app tools and serves Live status', async (t) => {
  const f = fixture(t);
  await appFixture(t, f);
  await updateHostContext('host', [f.cwd], f);
  state(f, 'd'.repeat(32), { goal: '🚦'.repeat(120), host_conversation_id: 'host' });
  const file = fileURLToPath(new URL('../core/mcp-server.mjs', import.meta.url));
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
  send({ method: 'notifications/initialized' });
  assert.deepEqual((await request('ping')).result, {});
  const { tools } = (await request('tools/list')).result;
  assert.deepEqual(tools.filter((tool) => !tool._meta?.ui?.visibility).map(({ name }) => name), ['gpt_run', 'gpt_ask', 'gpt_ctl']);
  assert.deepEqual(tools.slice(3).map(({ name, _meta }) => [name, _meta.ui.visibility]),
    ['runs', 'stream', 'interrupt', 'steer'].map((name) => [`gempt_app_${name}`, ['app']]));
  assert.equal(tools[2]._meta.ui.resourceUri, APP_URI);
  assert.deepEqual(tools[2]._meta['com.google.antigravity/ui'].entrypoints.map(({ type }) => type), ['aux_pane', 'global']);
  assert.deepEqual((await request('resources/list')).result.resources, [APP_RESOURCE]);
  assert.equal((await request('resources/read', { uri: 'ui://unknown' })).error.code, -32002);
  const resource = (await request('resources/read', { uri: APP_URI })).result.contents[0];
  assert.equal(resource.text, readAppResource().contents[0].text);
  const { result } = await request('tools/call', { name: 'gpt_ctl', arguments: {} });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 500);
  assert.equal(JSON.parse(result.content[0].text).active.length, 1);
  assert.equal(result.structuredContent.bound_conversation_id, 'host');
  assert.equal(result.structuredContent.stream.run.run_id, 'd'.repeat(32));
  const oversized = 'e'.repeat(32);
  state(f, oversized, { state: 'failed', host_conversation_id: 'host', title: '🚦'.repeat(40),
    error: '🚧'.repeat(500) });
  const detail = (await request('tools/call', { name: 'gpt_ctl', arguments: { run_id: oversized } })).result;
  assert.ok(Buffer.byteLength(detail.content[0].text) <= 500);
  assert.equal(JSON.parse(detail.content[0].text).id, oversized);
  const asked = await request('tools/call', { name: 'gpt_ask', arguments: { goal: 'Summarize the fixture.' } });
  assert.equal(asked.result.isError, undefined, asked.result.content[0].text);
  assert.equal(JSON.parse(asked.result.content[0].text).text.includes('Consult answer.'), true);
  const launch = await request('tools/call', { name: 'gpt_run', arguments: { goal: 'Inspect the fixture.', cwd: '.', access: 'inspect' } });
  assert.equal(launch.result.isError, false, launch.result.content[0].text);
  const run = JSON.parse(launch.result.content[0].text);
  assert.match(run.wait_command, new RegExp(`${run.run_id}$`));
  const complete = await waitForRun(run.run_id, { ...f, timeoutSec: 5 });
  assert.equal(complete.result?.sandbox, 'read-only', complete.error);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});

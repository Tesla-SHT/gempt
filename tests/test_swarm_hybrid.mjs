import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runDirectory, saveRun } from '../core/runs.mjs';
import { ensureSwarm, postBoardMessage, setSwarmPlan, upsertWorker } from '../core/swarm-bus.mjs';
import { readNativeSwarm } from '../core/swarm-native-reader.mjs';
import { dispatchPageApi } from '../magpie_plugin/lib/page-api.mjs';

const coordinator = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const child = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
const narrator = 'cccccccc-3333-3333-3333-cccccccccccc';
const unrelated = 'dddddddd-4444-4444-4444-dddddddddddd';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAs2p71EAAAAASUVORK5CYII=', 'base64');
const time = (s) => `2026-01-01T12:00:${String(s).padStart(2, '0')}Z`;

function fixture(t, { native = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gempt-hybrid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appData = join(root, 'app-data');
  const brain = join(appData, 'brain');
  const dir = join(brain, coordinator, '.system_generated', 'swarm');
  const cwd = join(root, 'workspace');
  const sessionsDir = join(root, 'session-state');
  mkdirSync(cwd);
  mkdirSync(sessionsDir);
  const options = { sessionsDir, root: cwd, conversationId: coordinator,
    env: { GEMPT_AGY_APP_DATA_DIR: appData, ANTIGRAVITY_APP_DATA_DIR: join(root, 'unused') } };
  const put = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents));
  };
  const shot = join(brain, child, 'evidence.png');
  const secondShot = join(brain, narrator, 'reel.png');
  const members = { title: 'Native lab', members: {
    coordinator: { conversation_id: coordinator, role: 'coordinator', model: 'Gemini Pro', last_read_seq: 1 },
    builder: { conversation_id: child, role: 'worker', model: 'Gemini Flash', wake_mode: 'mentions' },
    'narrator-2': { conversation_id: narrator, role: 'worker', model: 'Gemini Flash' },
  } };
  const file = join(dir, 'board.jsonl');
  const board = [
    { seq: 1, agent: 'coordinator', text: '@builder Draft the panel', time: time(1) },
    { seq: 2, agent: 'builder', text: `@coordinator Drafted #1\nScreenshot: ${shot} | Draft panel`, time: time(3), reply_to_seq: 1 },
  ];
  const post = (msg) => appendFileSync(file, JSON.stringify(msg) + '\n');
  if (native) {
    put(shot, PNG);
    put(secondShot, PNG);
    put(join(dir, 'members.json'), members);
    put(file, '');
    board.forEach(post);
    put(join(dir, 'plan.json'), { goal: { title: 'Native goal' }, tasks: { builder: 'Draft the panel' } });
    const viewDir = join(brain, narrator, 'swarm_view');
    put(join(viewDir, 'view.json'), { headline: 'Native update', as_of_seq: 2,
      reel: { frames: [{ path: secondShot, seq: 2, caption: 'Narrator reel' }] },
      attention: [{ title: 'Panel', refs: [{ seq: 2 }], actions: [{ type: 'board_post', target: '2' }] }] });
    put(join(viewDir, 'view.html'), '<p>Native view</p>');
  }
  const http = async (path, params = {}, overrides = {}) => {
    const url = new URL(path, 'http://gempt.test');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await dispatchPageApi({ method: 'GET', url }, { ...options, ...overrides });
    assert.equal(response.status, 200);
    return response.body;
  };
  return { options, appData, brain, dir, cwd, sessionsDir, http, put, post, shot, secondShot, file, members };
}

test('reads native disk boards, role fallbacks, narrator files and reverse coordinator lookup', async (t) => {
  const f = fixture(t);
  appendFileSync(f.file, '{"seq":');
  const own = readNativeSwarm(coordinator, f.options);
  assert.equal(own.id, coordinator);
  assert.equal(own.self, 'coordinator');
  assert.equal(own.messages.length, 2);
  assert.equal(own.raw.board.endsWith('{"seq":'), true);
  assert.equal(own.members.find(({ name }) => name === 'builder').state, 'waiting');
  assert.equal(own.members.find(({ name }) => name === 'builder').unread, 2);
  assert.equal(own.postedFrames[0].path, f.shot);
  assert.equal(own.narratorFrames[0].path, f.secondShot);
  assert.equal(own.narrator.name, 'narrator-2');
  assert.equal(own.view.html, '<p>Native view</p>');
  assert.equal(readNativeSwarm(child, f.options).self, 'builder');
  assert.equal(readNativeSwarm(child, { env: { ANTIGRAVITY_APP_DATA_DIR: f.appData } }).id, coordinator);
  assert.equal(readNativeSwarm(unrelated, f.options), null);
  assert.equal(readNativeSwarm('../../etc/passwd', f.options), null);

  const snap = await f.http('/api/swarm', { conversationId: child }, { conversationId: undefined });
  assert.equal(snap.source, 'native');
  assert.equal(snap.self, 'builder');
  assert.equal(snap.members.length, 3);
  assert.equal(snap.members[1].cli, 'antigravity');
  assert.equal(snap.edges.find((edge) => edge.from === 'builder').to, 'coordinator');
  assert.equal(snap.plan.goal.title, 'Native goal');
  assert.equal(snap.frames.length, 2);
  assert.equal(snap.raw.native.members, JSON.stringify(f.members));
  const listing = await f.http('/api/swarm/list', { scope: 'session' }, { conversationId: child });
  assert.equal(listing.swarms[0].id, snap.swarm_id);
  assert.equal(listing.swarms[0].source, 'native');
});

function runFixture(f, id, props) {
  const dir = runDirectory(id, f.sessionsDir);
  mkdirSync(dir, { recursive: true });
  saveRun(join(dir, 'state.json'), { run_id: id, cwd: f.cwd, session_id: 'exec-' + id, state: 'running',
    goal: 'Implement the external tasks', ...props });
}

test('fuses two host bindings, standalone and managed runs, attention, timeline and Raw data', async (t) => {
  const f = fixture(t);
  const workerRun = '1'.repeat(32), soloRun = '2'.repeat(32), foreignRun = '3'.repeat(32);
  const finishedRun = '4'.repeat(32);
  await ensureSwarm({ swarmId: 'child-cli', hostConversationId: child, cwd: f.cwd, sessionsDir: f.sessionsDir });
  await ensureSwarm({ swarmId: 'parent-cli', hostConversationId: coordinator, cwd: f.cwd, sessionsDir: f.sessionsDir });
  await ensureSwarm({ swarmId: 'other-cli', hostConversationId: unrelated, cwd: f.cwd, sessionsDir: f.sessionsDir });
  await upsertWorker('child-cli', { name: 'builder', cli: 'codex', state: 'working', run_id: workerRun,
    source_cwd: f.cwd, task_summary: 'Wire the API' }, f.options);
  await setSwarmPlan('child-cli', { threads: [{ id: 'api', workers: ['builder'] }] }, f.options);
  await upsertWorker('parent-cli', { name: 'reviewer', cli: 'opencode', state: 'waiting' }, f.options);
  runFixture(f, workerRun, { cli: 'codex', model: 'gpt-codex', swarm_id: 'child-cli', swarm_agent: 'builder',
    created_at: time(2), host_conversation_id: child, worktree_path: f.cwd,
    usage: { input_tokens: 100, cached_input_tokens: 75 }, progress: { updated_at: time(2) } });
  runFixture(f, soloRun, { cli: 'claude', model: 'Claude Sonnet', created_at: time(4),
    host_conversation_id: coordinator, state: 'waiting_gemini', pending_tool_call: { call_id: 'review', name: 'review' } });
  runFixture(f, finishedRun, { cli: 'opencode', model: 'External reviewer', created_at: time(5),
    finished_at: time(8), host_conversation_id: child, state: 'failed', error: 'Fixture failure' });
  runFixture(f, foreignRun, { cli: 'claude', host_conversation_id: unrelated });
  const gemptShot = join(f.cwd, 'external.png');
  f.put(gemptShot, PNG);
  await postBoardMessage('child-cli', { from: 'builder', text: `@coordinator External SQLite result\nScreenshot: ${gemptShot} | External panel` }, f.options);
  const snap = await f.http('/api/swarm/snapshot');
  const nativeWorker = snap.members.find(({ name }) => name === 'builder');
  const externalWorker = snap.members.find(({ name }) => name === 'gempt:builder');
  assert.equal(snap.source, 'hybrid');
  assert.equal(snap.members.some(({ name }) => name === 'reviewer'), true);
  assert.equal(snap.members.filter(({ role }) => role === 'coordinator').length, 1);
  assert.equal(nativeWorker.origin, 'native');
  assert.equal(externalWorker.origin, 'gempt');
  assert.equal(externalWorker.control_name, 'builder');
  assert.equal(externalWorker.control_swarm_id, 'child-cli');
  assert.equal(externalWorker.cli, 'codex');
  assert.equal(externalWorker.conversationId, child);
  assert.equal(externalWorker.run_id, workerRun);
  assert.equal(externalWorker.model, 'gpt-codex');
  assert.equal(externalWorker.session_id, 'exec-' + workerRun);
  assert.equal(externalWorker.worktree_path, f.cwd);
  assert.equal(externalWorker.cache_hit_ratio, 0.75);
  assert.equal(snap.members.some(({ run_id }) => run_id === foreignRun), false);
  assert.equal(snap.members.find(({ run_id }) => run_id === soloRun).state, 'waiting_reply');
  assert.equal(snap.attention.find(({ kind }) => kind === 'waiting_gemini').run_id, soloRun);
  assert.equal(snap.attention.find(({ kind }) => kind === 'error').run_id, finishedRun);
  assert.equal(snap.attention.find(({ kind, agent }) => kind === 'stuck' && agent === 'gempt:builder').run_id, workerRun);
  assert.deepEqual(snap.messages.slice(0, 4).map(({ origin }) => origin), ['native', 'gempt', 'native', 'gempt']);
  const nativeReply = snap.messages.find(({ origin, source_seq }) => origin === 'native' && source_seq === 2);
  assert.equal(nativeReply.seq, 3);
  assert.equal(nativeReply.reply_to_seq, 1);
  assert.equal(snap.view.json.attention[0].refs[0].seq, 3);
  assert.equal(snap.view.json.attention[0].actions[0].target, '3');
  assert.equal(snap.plan.goal.title, 'Native goal');
  assert.equal(snap.plan.tasks['gempt:builder'], 'Wire the API');
  assert.deepEqual(snap.plan.threads[0].workers, ['gempt:builder']);
  assert.equal(snap.edges.some(({ from, to }) => from === 'gempt:builder' && to === 'builder'), true);
  assert.equal(snap.frames.some(({ path, origin }) => path === gemptShot && origin === 'gempt'), true);
  assert.equal((await f.http('/api/swarm/frame', { path: gemptShot, format: 'dataurl' })).size, PNG.length);
  assert.equal((await f.http('/api/swarm', {}, { conversationId: child })).swarm_id, snap.swarm_id);

  const { swarms } = await f.http('/api/swarm/list', { scope: 'all' });
  assert.deepEqual(swarms.map(({ id }) => id), [snap.swarm_id, 'other-cli']);
  assert.equal(swarms[0].source, 'hybrid');
  const foreign = await f.http('/api/swarm', { swarm_id: 'other-cli', scope: 'all' });
  assert.equal(foreign.source, 'gempt');
  assert.equal(foreign.swarms[0].id, snap.swarm_id);
  const raw = await f.http('/api/swarm/raw', { swarm_id: snap.swarm_id });
  assert.equal(JSON.parse(raw.native.members).title, 'Native lab');
  assert.match(raw.gempt.board, /External SQLite result/);
  assert.equal(JSON.parse(raw.gempt.members).runs.length, 3);
  const externalRaw = await f.http('/api/swarm/raw', { swarm_id: snap.swarm_id, origin: 'gempt', kind: 'board' });
  assert.equal(externalRaw.content, raw.gempt.board);
  const nativeRaw = await f.http('/api/swarm/raw', { origin: 'native', kind: 'view' });
  assert.equal(JSON.parse(nativeRaw.content).as_of_seq, 2);

  const tail = await f.http('/api/swarm', { tail: 1, omitRaw: 1 });
  const cursor = { tail: 1, omitRaw: 1, etag: tail.etag, rosterKey: tail.rosterKey,
    timelineKey: tail.timelineKey, known: tail.totalMessages, since: tail.head };
  const page = { rosterKey: tail.rosterKey, timelineKey: tail.timelineKey, before: tail.offset, beforeSeq: tail.beforeSeq };
  assert.equal((await f.http('/api/swarm', cursor)).mode, 'unchanged');
  assert.deepEqual((await f.http('/api/swarm/messages', page)).messages.map(({ seq }) => seq),
    snap.messages.slice(0, -1).map(({ seq }) => seq));

  f.post({ seq: 3, agent: 'coordinator', text: 'A new native message', time: '2099-01-01T00:00:00Z' });
  const delta = await f.http('/api/swarm', cursor);
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.rosterKey, tail.rosterKey);
  assert.equal(delta.messages[0].seq, tail.head + 1);
  assert.equal(delta.messages[0].source_seq, 3);

  f.post({ seq: 4, agent: 'builder', text: 'A late native message', time: time(2) });
  assert.equal((await f.http('/api/swarm', cursor)).reset, true);
  assert.equal((await f.http('/api/swarm/messages', page)).stale, true);
});

test('frame endpoint checks registered native shots, image bytes and canonical brain containment', async (t) => {
  const f = fixture(t);
  for (const path of [f.shot, f.secondShot]) {
    const result = await f.http('/api/swarm/frame', { path, format: 'dataurl' }, { conversationId: child });
    assert.equal(result.data_url, 'data:image/png;base64,' + PNG.toString('base64'));
  }
  const unseen = join(f.brain, child, 'unregistered.png');
  const outside = join(f.cwd, 'outside.png');
  const escape = join(f.brain, child, 'escape.png');
  const fake = join(f.brain, child, 'fake.png');
  f.put(unseen, PNG);
  f.put(outside, PNG);
  f.put(fake, 'not an image');
  if (process.platform !== 'win32') symlinkSync(outside, escape);
  f.post({ seq: 3, agent: 'builder', text: `Screenshot: ${outside}\nScreenshot: ${escape}\nScreenshot: ${fake}`, time: time(5) });
  for (const path of [unseen, outside, escape, fake]) {
    await assert.rejects(f.http('/api/swarm/frame', { path, format: 'dataurl' }), { status: 404 });
  }
});

test('keeps pure GemPT SQLite sequence, pagination, Raw and list behavior when native directory is absent', async (t) => {
  const f = fixture(t, { native: false });
  const opts = { sessionsDir: f.sessionsDir };
  await ensureSwarm({ swarmId: 'legacy', hostConversationId: coordinator, cwd: f.cwd, ...opts });
  await upsertWorker('legacy', { name: 'worker', cli: 'opencode', state: 'working' }, opts);
  const first = await postBoardMessage('legacy', { text: 'First' }, opts);
  await postBoardMessage('gap', { text: 'Other board' }, opts);
  const last = await postBoardMessage('legacy', { from: 'worker', text: 'Last' }, opts);
  const snap = await f.http('/api/swarm', { tail: 1, omitRaw: 1 });
  assert.equal(snap.source, 'gempt');
  assert.equal(snap.swarm_id, 'legacy');
  assert.equal(snap.head, last.seq);
  assert.equal(snap.timelineKey, undefined);
  assert.deepEqual(snap.messages.map(({ seq }) => seq), [last.seq]);
  const page = await f.http('/api/swarm/messages', { swarm_id: 'legacy', before: snap.offset,
    beforeSeq: snap.beforeSeq, rosterKey: snap.rosterKey });
  assert.deepEqual(page.messages.map(({ seq }) => seq), [first.seq]);
  const raw = await f.http('/api/swarm/raw', { swarm_id: 'legacy', kind: 'board' });
  assert.match(raw.content, /First/);
  assert.equal(raw.native, undefined);
  assert.deepEqual((await f.http('/api/swarm/list')).swarms.map(({ id }) => id), ['legacy']);
});

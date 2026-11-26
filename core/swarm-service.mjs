import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { readHostContext } from './host-context.mjs';
import { cacheHitRatio } from './token-usage.mjs';
import { antigravityApplicationData, checkArgs, readCoordinatorActivity, readMemberActivity, runSummary } from './live-service.mjs';
import { interruptRun, readRun } from './runs.mjs';
import { resolvePath, withinPath } from './state.mjs';
import { recordInWorkspace, workspaceFileRoots } from './worktrees.mjs';
import {
  getBoardHead, getSwarmOverview, getWorker, listRoster, listSwarms, openSwarmDb,
  readBoardMessages, readSwarmSnapshot, resolveSwarmDbPath, updateWorker, validateSwarmId, validateWorkerName,
} from './swarm-bus.mjs';
import { activeAt, channelsAt, effectiveChannels, mentionsOf } from './swarm-channels.mjs';
import { narratorFeedback, readNarratorView } from './swarm-narrator.mjs';
import { handleBoardAction, handleSwarmAction } from './swarm-engine.mjs';

const SWARM_ID_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' };
const string = { type: 'string' };
const seq = { type: 'integer', minimum: 0 };
const scopeParam = { type: 'string', enum: ['session', 'all'] };
const boardIdentity = { swarm_id: SWARM_ID_SCHEMA, conversationId: string, scope: scopeParam };

const WORKER_NAME_SCHEMA = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,23}$' };

export const SWARM_OPERATIONS = {
  snapshot: { properties: { ...boardIdentity, etag: string, omitRaw: { type: 'boolean' }, tail: seq,
    viewKey: string, since: seq, known: seq, rosterKey: string } },
  messages: { properties: { ...boardIdentity, before: seq, beforeSeq: seq, limit: seq, fromSeq: seq, rosterKey: string } },
  frame: { properties: { ...boardIdentity, path: string, format: { type: 'string', enum: ['dataurl'] } }, required: ['path'] },
  feedback: { properties: { ...boardIdentity, target_id: string, text: string }, required: ['swarm_id', 'target_id', 'text'] },

  list: {
    properties: {
      scope: { type: 'string', enum: ['session', 'all'] },
      host_conversation_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  overview: {
    properties: {
      swarm_id: SWARM_ID_SCHEMA,
    },
    required: ['swarm_id'],
  },
  raw: {
    properties: { ...boardIdentity, kind: { type: 'string', enum: ['members', 'board', 'plan', 'view'] } },
  },
  board: {
    properties: {
      swarm_id: SWARM_ID_SCHEMA,
      channel: { type: 'string' },
      since: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['swarm_id'],
  },
  post: {
    properties: {
      swarm_id: SWARM_ID_SCHEMA,
      text: { type: 'string' },
      channel: { type: 'string' },
      reply_to_seq: { type: 'integer', minimum: 1 },
    },
    required: ['swarm_id', 'text'],
  },
  action: {
    properties: {
      swarm_id: SWARM_ID_SCHEMA,
      action: { type: 'string', enum: ['title', 'kill', 'interrupt', 'model', 'channel', 'feedback'] },
      op: { type: 'string', enum: ['create', 'archive'] },
      channel: { type: 'string' },
      topic: { type: 'string' },
      name: WORKER_NAME_SCHEMA, model: string, tier: string, cli: string, reason: string,
      target_id: string, text: string,
      title: { type: 'string' },
    },
    required: ['swarm_id', 'action'],
  },
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message = 'Swarm not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function forbidden(message = 'Swarm outside host workspace') {
  return Object.assign(new Error(message), { status: 403 });
}

function workspaceScope({ root, workspaceRoots } = {}) {
  return (workspaceRoots ?? (root ? [root] : null))?.map((p) => resolvePath(p)) ?? null;
}

function swarmInScope(swarm, roots) {
  if (!roots || typeof swarm.cwd !== 'string' || !swarm.cwd.trim()) return true;
  return recordInWorkspace(swarm, roots);
}

export function countRosterStates(roster) {
  const counts = {
    total: 0,
    working: 0,
    waiting: 0,
    waiting_reply: 0,
    stopped: 0,
    killed: 0,
    active: 0,
  };
  for (const worker of roster || []) {
    counts.total += 1;
    const state = worker?.state;
    if (state === 'working') counts.working += 1;
    else if (state === 'waiting') counts.waiting += 1;
    else if (state === 'waiting_reply') counts.waiting_reply += 1;
    else if (state === 'stopped') counts.stopped += 1;
    else if (state === 'killed') counts.killed += 1;
  }
  counts.visible = counts.total - counts.killed;
  counts.active = counts.working + counts.waiting_reply;
  return counts;
}

function resolveScreenshotUri(file, { cwd, allowedRoots }) {
  if (typeof file !== 'string') return { allowed: false, reason: 'outside_workspace' };
  const raw = file.trim();
  if (!raw || /[\x00-\x1f\x7f]/.test(raw) || !allowedRoots.length) {
    return { allowed: false, reason: 'outside_workspace' };
  }
  try {
    let resolved;
    const windowsPath = /^[a-z]:[\\/]/i.test(raw);
    if (!windowsPath && /^[a-z][a-z\d+.-]*:/i.test(raw)) {
      if (!/^file:\/\//i.test(raw)) return { allowed: false, reason: 'outside_workspace' };
      const parsed = new URL(raw);
      if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password) {
        return { allowed: false, reason: 'outside_workspace' };
      }
      resolved = resolvePath(fileURLToPath(parsed));
    } else {
      if (!cwd && !isAbsolute(raw)) return { allowed: false, reason: 'outside_workspace' };
      resolved = resolvePath(cwd ? resolve(cwd, raw) : raw);
    }
    if (allowedRoots.some((base) => withinPath(resolved, base))) {
      return { allowed: true, uri: pathToFileURL(resolved).href };
    }
  } catch {
    // Malformed or unresolvable path stays restricted.
  }
  return { allowed: false, reason: 'outside_workspace' };
}

function collectScreenshots(db, swarm, roster, roots) {
  const rows = db.all(
    "SELECT seq, from_agent, screenshots_json, created_at FROM messages WHERE swarm_id = ? AND screenshots_json != '[]' ORDER BY seq ASC",
    swarm.id,
  );
  if (!rows.length) return [];
  const cwd = typeof swarm.cwd === 'string' && isAbsolute(swarm.cwd) ? resolvePath(swarm.cwd) : null;
  const allowedRoots = [...new Set([
    ...workspaceFileRoots(swarm, roots),
    ...roster.flatMap((worker) => workspaceFileRoots({
      cwd: worker.worktree_path || worker.cwd,
      worktree_path: worker.worktree_path,
      source_cwd: worker.source_cwd || swarm.cwd,
    }, roots)),
  ])];
  const out = [];
  for (const row of rows) {
    let entries = [];
    try { entries = JSON.parse(row.screenshots_json || '[]'); } catch { entries = []; }
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
      const check = resolveScreenshotUri(item.path, { cwd, allowedRoots });
      out.push({
        seq: Number(row.seq),
        from_agent: row.from_agent,
        created_at: row.created_at,
        path: item.path,
        caption: String(item.caption || ''),
        ...(check.allowed ? { file_uri: check.uri } : { restricted_reason: check.reason }),
      });
    }
  }
  return out;
}

function resolveSessions(options = {}) {
  return resolveSessionsDir(options.sessionsDir || options.env?.GEMPT_SESSIONS_DIR);
}

function swarmDbExists(sessionsDir) {
  return existsSync(resolveSwarmDbPath(sessionsDir));
}

async function listSwarmItems(args, options) {
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  const context = readHostContext(options.configPath, options.root);
  const active = options.conversationId === undefined ? context.conversation_id || null : options.conversationId;
  const bound = args.host_conversation_id || active || null;
  const scope = args.scope ?? (options.conversationId === undefined ? 'all' : 'session');
  const limit = args.limit ?? 30;

  if (!swarmDbExists(sessionsDir)) {
    return {
      ok: true,
      scope,
      active_conversation_id: active,
      bound_conversation_id: bound,
      session_count: 0,
      all_count: 0,
      active_workers_total: 0,
      swarms: [],
    };
  }

  const db = await openSwarmDb(sessionsDir);
  try {
    const allSwarms = (await listSwarms({ limit: 200, db })).filter((sw) => swarmInScope(sw, roots));
    let sessionCount = 0;
    const filtered = [];
    for (const sw of allSwarms) {
      const matchesSession = Boolean(bound && sw.host_conversation_id === bound);
      if (matchesSession) sessionCount += 1;
      if (scope === 'all' || matchesSession) filtered.push(sw);
    }

    const enriched = [];
    let activeWorkersTotal = 0;
    for (const sw of filtered) {
      const roster = await listRoster(sw.id, { includeKilled: true, db });
      const counts = countRosterStates(roster);
      const head = await getBoardHead(sw.id, { db });
      activeWorkersTotal += counts.active;
      enriched.push({
        id: sw.id,
        title: sw.title,
        goal_title: sw.goal_title,
        goal_line: sw.goal_line,
        cwd: sw.cwd,
        host_conversation_id: sw.host_conversation_id,
        created_at: sw.created_at,
        updated_at: sw.updated_at,
        head,
        counts,
      });
    }

    enriched.sort((a, b) => {
      const aAct = a.counts.active > 0 ? 1 : 0;
      const bAct = b.counts.active > 0 ? 1 : 0;
      if (aAct !== bAct) return bAct - aAct;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });

    return {
      ok: true,
      scope,
      active_conversation_id: active,
      bound_conversation_id: bound,
      session_count: sessionCount,
      all_count: allSwarms.length,
      active_workers_total: activeWorkersTotal,
      swarms: enriched.slice(0, limit),
    };
  } finally {
    db.close();
  }
}

async function getOverview(args, options) {
  let swarmId;
  try { swarmId = validateSwarmId(args.swarm_id); } catch (err) { throw badRequest(err.message); }
  const sessionsDir = resolveSessions(options);
  if (!swarmDbExists(sessionsDir)) throw notFound();
  const roots = workspaceScope(options);
  const db = await openSwarmDb(sessionsDir);
  try {
    const overview = await assertExistingScopedSwarm(swarmId, sessionsDir, roots, { db, analytics: true });
    const counts = countRosterStates(overview.roster);
    const roster = overview.roster.map((worker) => {
      if (!worker.run_id) return worker;
      let record;
      try { record = readRun(worker.run_id, sessionsDir, { readonly: true }); }
      catch (err) { if (err.status === 400 || err.status === 404) return worker; throw err; }
      if (!recordInWorkspace(record, roots) || (record.swarm_id && record.swarm_id !== swarmId)
          || (record.swarm_agent && record.swarm_agent !== worker.name)) return worker;
      const run = runSummary(record, true);
      return { ...worker, cli: record.result?.cli || record.cli || worker.cli, model: run.model || worker.model,
        telemetry: { state: run.state, usage: run.usage, cache_hit_ratio: cacheHitRatio(run.usage),
          last_message: run.last_message, can_control: run.can_control, can_interrupt: run.can_interrupt } };
    });
    const screenshots = collectScreenshots(db, overview.swarm, overview.roster, roots);
    return {
      ok: true,
      swarm: overview.swarm,
      roster,
      head: overview.head,
      screenshots, counts, channels: overview.channels, edges: overview.edges, system_attention: overview.system_attention,
    };
  } finally {
    db.close();
  }
}

async function getBoard(args, options) {
  let swarmId;
  try { swarmId = validateSwarmId(args.swarm_id); } catch (err) { throw badRequest(err.message); }
  const sessionsDir = resolveSessions(options);
  if (!swarmDbExists(sessionsDir)) throw notFound();
  const roots = workspaceScope(options);
  const db = await openSwarmDb(sessionsDir);
  try {
    const overview = await assertExistingScopedSwarm(swarmId, sessionsDir, roots, { db });
    const messages = await readBoardMessages(swarmId, {
      since: args.since, channel: args.channel,
      limit: args.limit ?? 100,
      db,
    });
    return {
      ok: true,
      swarm_id: swarmId,
      head: overview.head,
      messages,
    };
  } finally {
    db.close();
  }
}

function buildEngineOptions(options = {}, sessionsDir) {
  return {
    configPath: options.configPath,
    sessionsDir,
    magpieConfigDir: options.magpieConfigDir,
    probeTimeoutMs: options.probeTimeoutMs,
    env: options.env || process.env,
    ...(options.dispatchRunImpl ? { dispatchRunImpl: options.dispatchRunImpl } : {}),
    ...(options.steerRunImpl ? { steerRunImpl: options.steerRunImpl } : {}),
    ...(options.interruptRunImpl ? { interruptRunImpl: options.interruptRunImpl } : {}),
    ...(options.replyToolCallImpl ? { replyToolCallImpl: options.replyToolCallImpl } : {}),
    ...(options.readRunImpl ? { readRunImpl: options.readRunImpl } : {}),
  };
}

async function assertExistingScopedSwarm(swarmId, sessionsDir, roots, options = {}) {
  if (!swarmDbExists(sessionsDir)) throw notFound();
  const overview = await getSwarmOverview(swarmId, { ...options, messageLimit: 0, sessionsDir,
    checkScope(swarm) { if (!swarmInScope(swarm, roots)) throw forbidden(); },
  });
  if (!overview) throw notFound();
  return overview;
}

async function postHumanMessage(args, options) {
  let swarmId;
  try { swarmId = validateSwarmId(args.swarm_id); } catch (err) { throw badRequest(err.message); }
  const text = String(args.text || '').trim();
  if (!text) throw badRequest('Board message text must be non-empty.');
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  await assertExistingScopedSwarm(swarmId, sessionsDir, roots);
  return handleBoardAction({
    action: 'post',
    swarm_id: swarmId,
    from: 'human', channel: args.channel,
    kind: 'message',
    text,
    ...(args.reply_to_seq !== undefined ? { reply_to_seq: args.reply_to_seq } : {}),
  }, { ...buildEngineOptions(options, sessionsDir), actor: 'human' });
}

async function performSwarmAction(args, options) {
  let swarmId;
  try { swarmId = validateSwarmId(args.swarm_id); } catch (err) { throw badRequest(err.message); }
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  await assertExistingScopedSwarm(swarmId, sessionsDir, roots);
  const engineOpts = buildEngineOptions(options, sessionsDir);

  if (args.action === 'feedback') return relayFeedback(args, options);
  if (args.action === 'model') return handleSwarmAction({ ...args, swarm_id: swarmId }, engineOpts);

  if (args.action === 'title') {
    const title = String(args.title || '').trim();
    if (!title || title.length > 200) throw badRequest('Swarm title must be 1-200 characters.');
    return handleSwarmAction({ action: 'title', swarm_id: swarmId, title }, engineOpts);
  }

  if (args.action === 'channel') {
    if (!['create', 'archive'].includes(args.op)) throw badRequest('Expected channel create or archive.');
    return handleSwarmAction({ action: 'channel', swarm_id: swarmId, op: args.op, channel: args.channel, topic: args.topic }, engineOpts);
  }

  let workerName;
  try { workerName = validateWorkerName(args.name); } catch (err) { throw badRequest(err.message); }

  if (args.action === 'kill') {
    try { return await handleSwarmAction({ action: 'kill', swarm_id: swarmId, name: workerName }, engineOpts); }
    catch (err) { if (/not found/.test(err.message)) throw notFound(err.message); throw err; }
  }

  // action === 'interrupt'
  const worker = await getWorker(swarmId, workerName, { sessionsDir });
  if (!worker) throw notFound(`Worker '${workerName}' not found.`);
  if (worker.state === 'killed') {
    throw Object.assign(new Error(`Worker '${workerName}' has already been killed.`), { status: 409 });
  }
  if (!['working', 'waiting_reply'].includes(worker.state)) {
    throw Object.assign(new Error(`Worker '${workerName}' is not currently running (state: ${worker.state}).`), { status: 409 });
  }
  if (!worker.run_id) {
    throw Object.assign(new Error(`Worker '${workerName}' has no active run to interrupt.`), { status: 409 });
  }
  const interruptImpl = options.interruptRunImpl || interruptRun;
  await interruptImpl(worker.run_id, {
    configPath: options.configPath,
    sessionsDir,
    env: options.env || process.env,
    connect: options.connect,
  });
  const updated = await updateWorker(swarmId, workerName, {
    state: 'stopped',
    parked_on: null,
  }, { sessionsDir, expectedRun: worker.run_id, expectedState: worker.state });
  return {
    ok: true,
    swarm_id: swarmId,
    action: 'interrupt',
    interrupted: true,
    worker: updated || worker,
  };
}

export async function runSwarmOperation(operation, args, options = {}) {
  const schema = Object.hasOwn(SWARM_OPERATIONS, operation) && SWARM_OPERATIONS[operation];
  if (!schema) throw Object.assign(new Error('Unknown Swarm operation.'), { status: 404 });
  checkArgs(operation, args, schema);
  if (operation === 'list') return listSwarmItems(args, options);
  if (operation === 'overview') return getOverview(args, options);
  if (operation === 'board') return getBoard(args, options);
  if (operation === 'raw') return getRaw(args, options);
  if (operation === 'snapshot') return getSnapshot(args, options);
  if (operation === 'messages') return getMessages(args, options);
  if (operation === 'frame') return getFrame(args, options);
  if (operation === 'feedback') return relayFeedback(args, options);
  if (operation === 'post') return postHumanMessage(args, options);
  return performSwarmAction(args, options);
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roleWorker = (worker) => worker && !['coordinator', 'worker'].includes(worker.role);
function nativeMessages(snapshot) {
  const { members, messages, channels } = snapshot;
  const active = activeAt(channels, messages);
  const names = members.map(({ name }) => name);
  const sets = members.map((member) => channelsAt(member.name, member.channels, messages));
  return messages.map((message, index) => {
    const named = mentionsOf(message.text, names);
    const exact = new Set([...named.mentions, ...message.mentions.filter((name) => name !== 'all')]);
    const via_channel = message.channel_mentions.length ? members.filter((member, j) => member.name !== message.from_agent &&
      !exact.has(member.name) && message.channel_mentions.some((channel) => active[index]?.(channel) &&
        effectiveChannels(member.role, sets[j][index], member.name).some((value) => value === '*' || value === channel)))
      .map(({ name }) => name) : [];
    return { ...message, mentions: [...exact], agent: message.from_agent, time: message.created_at,
      ts: Date.parse(message.created_at) || 0, all: named.all || message.mentions.includes('all'), via_channel };
  });
}

async function scopedSnapshot(args, options) {
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  const conversationId = options.conversationId === undefined ? (args.conversationId ?? null) : options.conversationId;
  const scope = args.scope ?? (options.conversationId !== undefined || (conversationId && !args.swarm_id) ? 'session' : 'all');
  if (!swarmDbExists(sessionsDir)) return { sessionsDir, roots, conversationId, scope, swarms: [] };
  const snapshot = await readSwarmSnapshot({ sessionsDir, scope, conversationId, swarmId: args.swarm_id,
    inScope: (swarm) => swarmInScope(swarm, roots) });
  if (snapshot.forbidden) throw forbidden();
  return { ...snapshot, sessionsDir, roots, conversationId, scope };
}

function makePlan({ swarm, members }) {
  return { goal: { title: swarm.goal_title, line: swarm.goal_line },
    tasks: Object.fromEntries(members.filter((worker) => worker.task_summary).map((worker) => [worker.name, worker.task_summary])),
    threads: swarm.threads };
}

function viewFiles(snapshot) {
  const all = snapshot.members.filter(({ role }) => role === 'narrator')
    .sort((a, b) => (Number(b.name.split('-').at(-1)) || 0) - (Number(a.name.split('-').at(-1)) || 0));
  const worker = all.find(({ state }) => state !== 'killed') || all[0];
  const view = readNarratorView(snapshot.sessionsDir, snapshot.swarm.id);
  const state = !worker ? 'absent' : worker.state === 'stopped' ? 'paused' : worker.state;
  const narrator = worker ? { ...worker, state, conversation_id: worker.session_id,
    stale: snapshot.messages.filter((m) => m.seq > Math.max(view.json?.as_of_seq || 0, worker.last_read_seq)).length >= 10 && state !== 'working' } : null;
  return { view, narrator, narratorState: state };
}

function framesFor(snapshot, view) {
  const members = new Map(snapshot.members.map((member) => [member.name, member]));
  const posted = new Map();
  for (const msg of snapshot.messages) {
    if (msg.control || ['brief', 'system'].includes(msg.kind) || members.get(msg.from_agent)?.role !== 'worker') continue;
    for (const item of msg.screenshots) {
      if (!isAbsolute(item.path) || !imageType(item.path)) continue;
      posted.delete(item.path);
      posted.set(item.path, { ...item, seq: msg.seq, agent: msg.from_agent, time: msg.created_at });
    }
  }
  const workerFrames = [...posted.values()].slice(-24);
  const narratorFrames = Array.isArray(view.json?.reel?.frames) ? view.json.reel.frames
    .filter((item) => typeof item?.path === 'string' && isAbsolute(item.path) && imageType(item.path)).slice(0, 40)
    .map(({ path, caption, seq }) => ({ path, caption: typeof caption === 'string' ? caption.slice(0, 200) : '', seq: Number(seq) || 0 })) : [];
  const url = (frame) => ({ ...frame, frameUrl: './api/swarm/frame?' + new URLSearchParams({ swarm_id: snapshot.swarm.id, path: frame.path }) });
  return { frames: (narratorFrames.length ? narratorFrames : workerFrames).map(url),
    postedFrames: workerFrames.map(url), narratorFrames: narratorFrames.map(url) };
}

function rosterKeyFor(snapshot) {
  const controls = snapshot.messages.filter((message) => message.control).map(({ seq, control }) => [seq, control]);
  return digest([snapshot.swarm.id, snapshot.members.map(({ name, role, channels, tail_from_seq }) =>
    [name, role, channels, tail_from_seq]), controls]);
}

function membersFor(snapshot, env) {
  return snapshot.members.map((worker) => {
    let run;
    let activity = { steps: 0, activity: '', activityKind: '' };
    if (worker.role === 'coordinator') {
      activity = readCoordinatorActivity(snapshot.swarm.host_conversation_id, env) || activity;
    }
    if (worker.run_id) {
      try {
        const record = readRun(worker.run_id, snapshot.sessionsDir, { readonly: true });
        if (recordInWorkspace(record, snapshot.roots) && record.swarm_id === snapshot.swarm.id && record.swarm_agent === worker.name) {
          run = runSummary(record, true);
          activity = readMemberActivity(record, snapshot.sessionsDir);
        }
      } catch (error) { if (![400, 404].includes(error.status)) throw error; }
    }
    return { ...worker, isSelf: worker.name === snapshot.self, conversation_id: worker.role === 'coordinator' ? snapshot.swarm.host_conversation_id : null,
      status: activity.state || worker.state, killed: worker.state === 'killed', roleWorker: roleWorker(worker),
      narrator: worker.role === 'narrator', channels: effectiveChannels(worker.role, worker.channels, worker.name),
      ...activity, task: worker.task_summary || '', lastPostSeq: worker.last_post_seq,
      lastPostTime: worker.last_post_time,
      ...(run ? { telemetry: { state: run.state, can_control: run.can_control, can_interrupt: run.can_interrupt }, model: run.model || worker.model } : {}) };
  });
}

function snapshotRaw(snapshot, view) {
  const members = Object.fromEntries(snapshot.members.map(({ desired_runtime, ...worker }) => [worker.name, {
    ...worker, conversation_id: worker.session_id, killed: worker.state === 'killed',
  }]));
  return { members: JSON.stringify({ title: snapshot.swarm.title, members }, null, 2),
    board: snapshot.messages.map(({ seq, from_agent: agent, text, created_at: time, kind, channel, control, request_id }) =>
      JSON.stringify({ seq, agent, text, time, kind, channel, ...(control && { control }), ...(request_id && { request_id }) }) + '\n').join(''),
    view: view.json ? JSON.stringify(view.json, null, 2) : '', plan: JSON.stringify(makePlan(snapshot), null, 2) };
}

function pinnedBefore(snapshot, view, frameLists, boundary, messages) {
  if (!boundary) return { posts: [], viewKey: '' };
  const members = new Map(snapshot.members.map((worker) => [worker.name, worker]));
  const prefix = messages.slice(0, boundary);
  const allPins = new Map(), viewPins = new Map();
  const pin = (message) => { if (message && message.seq <= prefix.at(-1).seq) allPins.set(message.seq, message); };
  const isTeamPost = (message) => !message.control && !roleWorker(members.get(message.agent));
  const pinView = (message) => {
    if (!message) return;
    viewPins.set(message.seq, message);
    pin(message);
  };
  pin(prefix.find(isTeamPost));
  pin(prefix.findLast((msg) => msg.meta?.monitor_stall));
  for (const member of snapshot.members) {
    const isAuthor = (msg) => isTeamPost(msg) && msg.from_agent === member.name;
    pin(prefix.findLast(isAuthor));
    pin(prefix.find((msg) => msg.kind === 'brief' && msg.meta?.worker === member.name));
    if (member.state !== 'working' || roleWorker(member)) continue;
    const wakeFrom = Math.max(member.wait_since, messages.findLast(isAuthor)?.seq || 0);
    pin(messages.findLast((msg) => isTeamPost(msg) && msg.agent !== member.name && msg.seq > wakeFrom &&
      (msg.all || msg.mentions.includes(member.name) || msg.via_channel.includes(member.name))));
  }
  for (const item of Array.isArray(view.json?.attention) ? view.json.attention : []) {
    const seq = Array.isArray(item?.refs) && item.refs.find((ref) => ref?.seq)?.seq;
    if (seq) pinView(prefix.find((msg) => msg.seq === Number(seq)));
    for (const action of Array.isArray(item?.actions) ? item.actions : []) {
      if (action?.type === 'board_post') pinView(prefix.find((msg) => msg.seq === Number(action.target)));
    }
  }
  const framePost = (frame) => frame.seq > 0 ? prefix.find((msg) => msg.seq >= frame.seq && isTeamPost(msg)) : null;
  for (const frame of frameLists.narratorFrames) pinView(framePost(frame));
  for (const frame of frameLists.postedFrames) pin(framePost(frame));
  return {
    posts: [...allPins.values()].sort((a, b) => a.seq - b.seq).map((msg) =>
      msg.meta?.monitor_stall || msg.text.length <= 240 ? msg : { ...msg, text: msg.text.slice(0, 240) }),
    viewKey: [...viewPins.keys()].sort((a, b) => a - b).join(','),
  };
}

async function getSnapshot(args, options) {
  const snap = await scopedSnapshot(args, options);
  if (!snap.swarm) return { ok: true, empty: true, unchanged: false, mode: 'empty', reset: false,
    swarm_id: null, swarm: null, self: null, head: 0, members: [], messages: [], swarms: snap.swarms, conversationId: snap.conversationId };
  const { view, narrator, narratorState } = viewFiles(snap);
  const frameLists = framesFor(snap, view);
  const members = membersFor(snap, options.env);
  const rosterKey = rosterKeyFor(snap);
  const plan = makePlan(snap);
  const flags = { builtinOverview: true, graphTab: true, rawTab: true };
  const hasCursor = args.known !== undefined && args.since !== undefined;
  const count = snap.messages.length;
  const canDelta = hasCursor && args.rosterKey === rosterKey && args.known <= count &&
    (args.known === 0 ? args.since === 0 && count === 0 : snap.messages[args.known - 1]?.seq === args.since);
  const boundary = Math.max(0, (canDelta ? args.known : count) - (args.tail || count));
  const messages = nativeMessages(snap);
  const { posts: pinned, viewKey } = pinnedBefore(snap, view, frameLists, boundary, messages);
  const title = snap.swarm.title || snap.swarm.goal_title || '';
  const allowedFiles = allowedViewFiles(snap, view, narrator, options);
  const etag = digest([snap.swarm.id, title, snap.self, rosterKey, snap.head, members, view, plan, frameLists,
    snap.attention, snap.swarms, allowedFiles, args.tail || 0, !!args.omitRaw]);
  const common = { ok: true, empty: false, conversationId: snap.conversationId,
    swarm: snap.swarm.id, swarm_id: snap.swarm.id, self: snap.self, member: snap.self,
    head: snap.head, etag, rosterKey, viewKey };
  if (args.etag === etag && (!hasCursor || canDelta)) return { ...common, unchanged: true, mode: 'unchanged', reset: false };
  const unseen = new Set(snap.unseen);
  const readThrough = members.find((member) => member.isSelf)?.last_read_seq ?? Infinity;
  const firstUnreadSeq = snap.messages.find((m) => !m.control && m.from_agent !== snap.self &&
    m.seq > readThrough && !unseen.has(m.seq))?.seq;
  return { ...common, unchanged: false, mode: canDelta ? 'delta' : 'full', delta: canDelta, reset: hasCursor && !canDelta,
    title, members, messages: messages.slice(canDelta ? args.known : boundary),
    offset: boundary, messagesOffset: boundary, before: boundary, beforeSeq: snap.messages[boundary]?.seq || 0,
    totalMessages: count, hasMore: boundary > 0, firstUnreadSeq,
    ...(!canDelta || args.viewKey !== viewKey ? { pinnedMessages: pinned } : {}),
    edges: snap.edges, channels: snap.channels, unseen: snap.unseen, plan, ...frameLists,
    view: { ...view, htmlKey: view.html ? digest(view.html) : '' }, narrator, narratorState,
    attention: snap.attention.map((item) => ({ ...item, id: item.kind + '-' + item.agent, member: item.agent })),
    systemAttention: snap.attention, flags, ...flags, source: { backend: 'local', label: 'GemPT' },
    allowedFiles, swarms: snap.swarms,
    ...(args.omitRaw ? {} : { raw: snapshotRaw(snap, view) }) };
}

async function getMessages(args, options) {
  const snap = await scopedSnapshot(args, options);
  const rosterKey = snap.swarm ? rosterKeyFor(snap) : '';
  const base = { ok: true, swarm_id: snap.swarm?.id || null, messages: [], hasMore: false, stale: false, notFound: false,
    rosterKey, head: snap.head || 0 };
  if (!snap.swarm) return { ...base, notFound: true };
  const { before, beforeSeq, fromSeq, limit = fromSeq ? 200 : 0 } = args;
  if (args.rosterKey !== rosterKey || !before || snap.messages[before]?.seq !== beforeSeq) return { ...base, stale: true };
  const index = fromSeq ? snap.messages.findIndex((m) => m.seq === fromSeq) : before - 1;
  if (index < 0 || index >= before) return { ...base, notFound: true };
  const amount = limit ? Math.min(limit, 500) : before;
  const offset = Math.max(0, before - Math.ceil((before - index) / amount) * amount);
  return { ...base, offset, before, totalMessages: snap.messages.length, hasMore: offset > 0,
    messages: nativeMessages(snap).slice(offset, before) };
}

async function getRaw(args, options) {
  // The legacy single-file operation has always allowed workspace-scoped IDs.
  const snap = await scopedSnapshot(explicitBoardScope(args), options);
  if (!snap.swarm) throw notFound();
  const raw = snapshotRaw(snap, viewFiles(snap).view);
  return { ok: true, swarm_id: snap.swarm.id, ...raw, raw,
    ...(args.kind ? { kind: args.kind, filename: args.kind + (args.kind === 'board' ? '.jsonl' : '.json'), content: raw[args.kind] } : {}) };
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
function imageType(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return '';
  }
}

function validImage(data, mime) {
  if (mime === 'image/png') return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return data.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
}

function artifactRoots(snapshot, worker, options) {
  const cwd = worker?.worktree_path ?? worker?.source_cwd ?? snapshot.swarm.cwd;
  const workspace = workspaceFileRoots({ cwd, worktree_path: worker?.worktree_path, source_cwd: worker?.source_cwd ?? snapshot.swarm.cwd },
    snapshot.roots, options.env);
  const data = options.appData || antigravityApplicationData(options.env)
    || join(homedir(), '.gemini', 'antigravity');
  const brain = join(data, 'brain');
  const ids = [snapshot.swarm.host_conversation_id, worker?.session_id].filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id ?? ''));
  const scopedBrain = ids.map((id) => join(brain, id)).filter((path) => {
    try { return withinPath(realpathSync(path), realpathSync(brain)) && realpathSync(path) !== realpathSync(brain); }
    catch { return false; }
  });
  return [...workspace, ...scopedBrain];
}

function allowedArtifact(path, roots) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[%\x00-\x1f\x7f]/u.test(path) || path.split(/[\\/]/u).some((part) => part === '..' || part === '.')) return null;
  try {
    const real = realpathSync(path);
    return roots.some((root) => {
      try { const base = realpathSync(root); return real !== base && withinPath(real, base); }
      catch { return false; }
    }) ? real : null;
  } catch { return null; }
}

function allowedViewFiles(snapshot, view, narrator, options) {
  const roots = artifactRoots(snapshot, narrator, options);
  const files = [];
  for (const field of ['attention', 'workstreams', 'milestones', 'risks']) {
    for (const item of Array.isArray(view.json?.[field]) ? view.json[field] : []) {
      for (const action of Array.isArray(item?.actions) ? item.actions : []) {
        if (action?.type !== 'file') continue;
        const path = allowedArtifact(action.target, roots);
        if (path) files.push([action.target, pathToFileURL(path).href]);
      }
    }
  }
  return Object.fromEntries(files);
}

function explicitBoardScope(args) {
  return args.swarm_id && !args.scope ? { ...args, scope: 'all' } : args;
}

async function getFrame(args, options) {
  const snap = await scopedSnapshot(explicitBoardScope(args), options);
  if (!snap.swarm) throw notFound('Frame not found.');
  const { view, narrator } = viewFiles(snap);
  const { postedFrames, narratorFrames } = framesFor(snap, view);
  const candidates = [...postedFrames, ...narratorFrames].filter(({ path }) => path === args.path);
  const mime = imageType(args.path);
  const roots = candidates.flatMap(({ agent }) => artifactRoots(snap,
    agent ? snap.members.find(({ name }) => name === agent) : narrator, options));
  const real = allowedArtifact(args.path, roots);
  if (!real || !mime) throw notFound('Frame not found.');
  let fd;
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FRAME_BYTES) throw notFound('Frame not found.');
    if (process.platform === 'linux' && allowedArtifact(realpathSync('/proc/self/fd/' + fd), roots) !== real) {
      throw notFound('Frame not found.');
    }
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size !== info.size || !validImage(buffer.subarray(0, size), mime)) throw notFound('Frame not found.');
    const bytes = buffer.subarray(0, size);
    return args.format === 'dataurl' || options.sidecarJson
      ? { ok: true, mime, size, data_url: 'data:' + mime + ';base64,' + bytes.toString('base64') }
      : { mime, bytes };
  } catch { throw notFound('Frame not found.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

async function relayFeedback(args, options) {
  const snap = await scopedSnapshot(explicitBoardScope(args), options);
  if (!snap.swarm) throw notFound();
  const { narrator, view } = viewFiles(snap);
  if (!narrator || narrator.state === 'killed') throw notFound('No active narrator.');
  const body = narratorFeedback(view, args.target_id, args.text);
  return handleBoardAction({ action: 'post', swarm_id: snap.swarm.id, from: 'human',
    text: `@${narrator.name} ${body}`, meta: { narrator_feedback: args.target_id },
  }, { ...buildEngineOptions(options, snap.sessionsDir), actor: 'human' });
}

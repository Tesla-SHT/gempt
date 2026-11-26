import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { readHostContext } from './host-context.mjs';
import { cacheHitRatio } from './token-usage.mjs';
import { antigravityApplicationData, checkArgs, readCoordinatorActivity, readMemberActivity, runSummary } from './live-service.mjs';
import { interruptRun, readRun, stateEntries } from './runs.mjs';
import { resolvePath, withinPath } from './state.mjs';
import { recordInWorkspace, workspaceFileRoots } from './worktrees.mjs';
import {
  computeMentionEdges, getBoardHead, getSwarmOverview, getWorker, listRoster, listSwarms, openSwarmDb,
  readBoardMessages, readSwarmSnapshot, resolveSwarmDbPath, updateWorker, validateSwarmId, validateWorkerName,
} from './swarm-bus.mjs';
import { activeAt, channelsAt, effectiveChannels, mentionsOf } from './swarm-channels.mjs';
import { readNativeSwarm } from './swarm-native-reader.mjs';
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
    viewKey: string, timelineKey: string, since: seq, known: seq, rosterKey: string } },
  messages: { properties: { ...boardIdentity, before: seq, beforeSeq: seq, limit: seq, fromSeq: seq, rosterKey: string, timelineKey: string } },
  frame: { properties: { ...boardIdentity, path: string, format: { type: 'string', enum: ['dataurl'] } }, required: ['path'] },
  feedback: { properties: { ...boardIdentity, target_id: string, text: string }, required: ['swarm_id', 'target_id', 'text'] },

  list: {
    properties: {
      scope: { type: 'string', enum: ['session', 'all'] },
      host_conversation_id: { type: 'string' },
      conversationId: string,
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
    properties: { ...boardIdentity, kind: { type: 'string', enum: ['members', 'board', 'plan', 'view', 'html'] }, origin: { type: 'string', enum: ['native', 'gempt'] } },
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

async function listSwarmItems(args, options, gemptOnly = false) {
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  const context = readHostContext(options.configPath, options.root);
  const active = options.conversationId === undefined ? context.conversation_id || null : options.conversationId;
  const bound = args.host_conversation_id || (options.conversationId === undefined ? args.conversationId : null) || active || null;
  const scope = args.scope ?? (options.conversationId === undefined ? 'all' : 'session');
  const limit = args.limit ?? 30;
  const native = gemptOnly ? null : readNativeSwarm(options.conversationId === undefined ? bound : active, options);
  if (native && (bound === native.id || native.members.some((member) => member.conversationId === bound))) {
    const snap = await hybridSnapshot(native, { sessionsDir, roots, conversationId: bound, scope }, {}, options);
    const scoped = await listSwarmItems(args, options, true);
    const associated = new Set(snap.external.map((item) => item.swarm.id));
    const merged = snap.swarms.find((item) => item.id === snap.swarm.id);
    const remaining = scoped.swarms.filter((item) => !associated.has(item.id));
    return { ...scoped, session_count: 1, all_count: Math.max(0, scoped.all_count - associated.size) + 1,
      active_workers_total: merged.counts.active + remaining.reduce((sum, item) => sum + item.counts.active, 0),
      swarms: [merged, ...remaining].slice(0, limit) };
  }

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
      swarms: gemptOnly ? enriched : enriched.slice(0, limit),
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
function boardMessages(snapshot) {
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

const nativeSwarmId = (id) => 'native-' + id;
const runStateOf = (state) => ({ queued: 'working', running: 'working', waiting_gemini: 'waiting_reply' })[state] || 'stopped';
const timeMs = (time) => Date.parse(time) || 0;
const items = (value) => Array.isArray(value) ? value : [];

function runFields(run) {
  const { cli, model, run_id, session_id, worktree_path, host_conversation_id, state, last_message, can_control, can_interrupt } = run;
  const ratio = cacheHitRatio(run.usage);
  return { cli, model, run_id, session_id, worktree_path, host_conversation_id, cache_hit_ratio: ratio,
    telemetry: { state, last_message, can_control, can_interrupt, cache_hit_ratio: ratio } };
}

function relatedRuns({ sessionsDir, roots }, ids, swarmsById) {
  const matching = [];
  for (const { id, stat } of stateEntries(sessionsDir)) {
    let record;
    try { record = readRun(id, sessionsDir, { stat, readonly: true }); } catch { continue; }
    const host = record.host_conversation_id || swarmsById.get(record.swarm_id)?.host_conversation_id;
    if (ids.has(host) && recordInWorkspace(record, roots)) matching.push({ ...record, host_conversation_id: host });
  }
  return matching.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

function projectReferences(view, sourceSeq, memberName = (name) => name) {
  if (!view.json) return view;
  const json = { ...view.json, as_of_seq: sourceSeq(view.json.as_of_seq) };
  for (const field of ['attention', 'workstreams', 'milestones', 'risks']) {
    if (!Array.isArray(json[field])) continue;
    json[field] = json[field].map((item) => {
      if (!item || typeof item !== 'object') return item;
      return { ...item,
        ...(Array.isArray(item.refs) && { refs: item.refs.map((ref) => ref?.seq ? { ...ref, seq: sourceSeq(ref.seq) } : ref) }),
        ...(Array.isArray(item.actions) && { actions: item.actions.map((action) => {
          if (action?.type === 'board_post') return { ...action, target: String(sourceSeq(action.target)) };
          if (action?.type === 'open_conv') return { ...action, target: memberName(action.target) };
          return action;
        }) }),
      };
    });
  }
  if (Array.isArray(json.reel?.frames)) json.reel = { ...json.reel, frames: json.reel.frames.map((frame) =>
    frame?.seq ? { ...frame, seq: sourceSeq(frame.seq) } : frame) };
  return { ...view, json };
}

async function hybridSnapshot(native, context, args, options) {
  const { sessionsDir, roots, scope } = context;
  const id = nativeSwarmId(native.id);
  const ids = new Set([native.id, ...native.members.map(({ conversationId }) => conversationId).filter(Boolean)]);
  const query = { sessionsDir, scope: 'all', inScope: (swarm) => swarmInScope(swarm, roots) };
  const { swarms } = swarmDbExists(sessionsDir) ? await readSwarmSnapshot({ ...query, swarmId: id }) : { swarms: [] };
  const relevant = swarms.filter((swarm) => ids.has(swarm.host_conversation_id));
  const related = new Map(relevant.map((swarm) => [swarm.id, swarm]));
  const external = (await Promise.all(relevant.sort((a, b) => a.id.localeCompare(b.id))
    .map(async (swarm) => ({ ...context, ...await readSwarmSnapshot({ ...query, swarmId: swarm.id }) }))))
    .filter((item) => item.swarm);
  const records = relatedRuns(context, ids, related);
  const recordById = new Map(records.map((record) => [record.run_id, record]));
  const runs = new Map(records.map((record) => [record.run_id, runSummary(record, true)]));
  const nativeByConversation = new Map(native.members.map((member) => [member.conversationId, member.name]));
  const taken = new Set(native.members.map(({ name }) => name));
  function unique(name, suffix) {
    const prefixed = 'gempt:' + name;
    const candidate = taken.has(name) ? taken.has(prefixed) ? prefixed + ':' + suffix : prefixed : name;
    taken.add(candidate);
    return candidate;
  }
  const sources = [{ key: 'native:' + native.id, board: native, messages: boardMessages(native), members: native.members,
    edges: computeMentionEdges(native.messages, native.members, native.channels), attention: native.attention }];
  const attachments = new Map();
  for (const board of external) {
    const swarmId = board.swarm.id;
    const key = 'gempt:' + swarmId;
    const host = board.swarm.host_conversation_id;
    const linkedName = nativeByConversation.get(host);
    const names = new Map(board.members.map(({ name, role }) =>
      [name, role === 'coordinator' && linkedName ? linkedName : unique(name, swarmId)]));
    const nameOf = (name) => names.get(name) || name;
    const members = membersFor(board, options.env).flatMap((worker) => {
      if (worker.role === 'coordinator' && linkedName) return [];
      const record = recordById.get(worker.run_id);
      const run = record?.swarm_id === swarmId && record.swarm_agent === worker.name ? runs.get(record.run_id) : null;
      const name = nameOf(worker.name);
      if (run) attachments.set(run.run_id, name);
      const fields = run ? runFields(run) : {};
      const state = run?.state === 'waiting_gemini' && worker.state !== 'killed' ? 'waiting_reply' : worker.state;
      return [{ ...worker, ...fields, name, state, origin: 'gempt', conversationId: host,
        control_swarm_id: swarmId, control_name: worker.name, isSelf: false }];
    });
    const authors = new Map(members.map(({ control_name, cli }) => [control_name, cli]));
    const remapControl = (control) => {
      if (!control) return control;
      const out = { ...control };
      if (Array.isArray(control.members)) out.members = control.members.map(nameOf);
      for (const key of ['prev', 'next']) {
        if (control[key]) out[key] = Object.fromEntries(Object.entries(control[key]).map(([name, set]) => [nameOf(name), set]));
      }
      return out;
    };
    const messages = boardMessages(board).map((msg) => ({ ...msg,
      origin: 'gempt', cli: authors.get(msg.agent) || null, control: remapControl(msg.control),
      conversationId: host, swarm_id: swarmId, from_agent: nameOf(msg.from_agent), agent: nameOf(msg.agent),
      mentions: msg.mentions.map(nameOf), via_channel: msg.via_channel.map(nameOf),
      ...(msg.meta?.worker && { meta: { ...msg.meta, worker: nameOf(msg.meta.worker) } }) }));
    sources.push({ key, board, messages, members, nameOf, ...viewFiles(board),
      edges: board.edges.map((edge) => ({ ...edge, from: nameOf(edge.from), to: nameOf(edge.to) })),
      attention: board.attention.map((item) => ({ ...item, agent: nameOf(item.agent), origin: 'gempt' })) });
  }

  const runPosts = [], runMembers = [], runEdges = [], runAttention = [];
  for (const record of records) {
    const run = runs.get(record.run_id);
    const attachment = attachments.get(run.run_id);
    const name = attachment ?? unique(record.swarm_agent || 'run-' + run.run_id.slice(0, 12), run.run_id);
    const host = nativeByConversation.get(run.host_conversation_id);
    const common = { agent: name, from_agent: name, origin: 'gempt', cli: run.cli, conversationId: run.host_conversation_id,
      run_id: run.run_id, channel: 'main', channel_mentions: [], via_channel: [], mentions: [], screenshots: [] };
    if (!attachment) {
      const state = runStateOf(run.state);
      runMembers.push({ ...runFields(run), name, role: 'worker', origin: 'gempt', conversationId: run.host_conversation_id,
        state, status: state, channels: [], task_summary: run.title, error: run.error, activity: run.last_message });
    }
    const emit = (event, time, body) => {
      const ts = timeMs(time);
      if (ts) runPosts.push({ ...common, key: run.run_id + ':' + event, time, created_at: time, ts, kind: 'message', text: body,
        ...(host && !attachment && event === 'start' && { mentions: [host] }) });
    };
    emit('start', record.created_at || record.started_at, `${run.cli} · ${run.title || run.run_id}`);
    emit('finish', record.finished_at, `${run.state}${run.error || run.last_message ? ': ' + (run.error || run.last_message) : ''}`);
    if (host && !attachment) runEdges.push({ from: name, to: host, count: 1, direct: 1, viaAll: 0 });
    const since = timeMs(record.progress?.updated_at || record.started_at || record.created_at);
    if (run.state === 'waiting_gemini') runAttention.push({ kind: 'waiting_gemini', agent: name,
      text: run.pending_tool_call?.name || 'External run is waiting for Gemini.', run_id: run.run_id, origin: 'gempt' });
    else if (['failed', 'timed_out', 'outcome_unknown'].includes(run.state)) runAttention.push({ kind: 'error',
      agent: name, text: run.error || run.state, run_id: run.run_id, origin: 'gempt' });
    else if (run.state === 'running' && since && Date.now() - since > 600_000) runAttention.push({ kind: 'stuck',
      agent: name, text: 'External run has had no progress for over 10 minutes.', since, run_id: run.run_id, origin: 'gempt' });
  }

  const rows = sources.flatMap(({ key, messages }) => messages.map((msg) =>
    ({ key, sourceSeq: msg.seq, ts: msg.ts, msg })));
  rows.push(...runPosts.map(({ key, ...msg }) => ({ key: 'run:' + key, ts: msg.ts, msg })));
  rows.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key) || (a.sourceSeq || 0) - (b.sourceSeq || 0));
  const reference = new Map(rows.map(({ key, sourceSeq }, index) => [key + '/' + (sourceSeq ?? ''), index + 1]));
  const resolveSeq = (key, seq) => reference.get(key + '/' + Number(seq)) || 0;
  const messages = rows.map(({ key, sourceSeq, msg }, i) => {
    const refs = sourceSeq ? [...msg.text.matchAll(/#(\d+)/g)] : [];
    return { ...msg, seq: i + 1, source_seq: sourceSeq ?? null, source_key: key,
      ...(refs.length && { references: Object.fromEntries(refs.map(([, seq]) => [seq, resolveSeq(key, seq)])) }),
      ...(msg.reply_to_seq && { reply_to_seq: resolveSeq(key, msg.reply_to_seq) || null }) };
  });
  const members = sources.flatMap(({ key, members }) => members.map((worker) => ({ ...worker,
    last_read_seq: readThrough(key, worker.last_read_seq), wait_since: readThrough(key, worker.wait_since),
    last_post_seq: resolveSeq(key, worker.last_post_seq), lastPostSeq: resolveSeq(key, worker.last_post_seq),
    quota_paused_seq: resolveSeq(key, worker.quota_paused_seq) }))).concat(runMembers);

  // A read cursor can point at an omitted or higher source sequence.
  function readThrough(key, cursor) {
    if (!cursor) return 0;
    const last = sources.find((source) => source.key === key)?.messages.findLast((msg) => msg.seq <= cursor);
    return last ? resolveSeq(key, last.seq) : 0;
  }

  const externalView = sources.slice(1).find((source) => source.view.json || source.view.html || source.narrator);
  const nativeView = native.view.exists ? native.view : null;
  const viewSource = nativeView || !externalView ? sources[0] : externalView;
  const view = projectReferences(nativeView || externalView?.view || native.view, (seq) => resolveSeq(viewSource.key, seq), viewSource.nameOf);
  const rawNarrator = native.narrator || externalView?.narrator || null;
  const narratorSource = native.narrator ? sources[0] : externalView;
  const narrator = rawNarrator && { ...rawNarrator, origin: native.narrator ? 'native' : 'gempt',
    name: narratorSource.nameOf?.(rawNarrator.name) || rawNarrator.name,
    last_read_seq: readThrough(narratorSource.key, rawNarrator.last_read_seq),
    ...(native.narrator && { stale: native.narrator.state !== 'working' && native.messages.filter((msg) =>
      msg.seq > Math.max(rawNarrator.last_read_seq, Number(native.view.json?.as_of_seq) || 0)).length >= 10 }) };
  const narratorState = native.narrator ? native.narratorState : externalView?.narratorState || 'absent';
  const externalGoal = external.find(({ swarm }) => swarm.goal_title || swarm.goal_line);
  const plan = { ...(externalGoal && { goal: makePlan(externalGoal).goal }), ...native.plan, tasks: { ...Object.fromEntries(members.filter((m) => m.task_summary)
    .map((m) => [m.name, m.task_summary])), ...native.plan?.tasks } };
  const planBoards = sources.slice(1).filter(({ board }) => Array.isArray(board.swarm.threads));
  const threads = planBoards.flatMap(({ key, board, nameOf }) => board.swarm.threads.filter((thread) => thread && typeof thread === 'object').map((thread, i) => ({ ...thread,
    id: key + ':' + (thread.id || i), workers: items(thread.workers).map(nameOf), members: items(thread.members).map(nameOf),
    tasks: items(thread.tasks).map((task) => typeof task === 'string' ? nameOf(task) : {
      ...task, ...(task?.worker && { worker: nameOf(task.worker) }), ...(task?.name && { name: nameOf(task.name) }),
    }) })));
  if (threads.length) plan.threads = [...(Array.isArray(plan.threads) ? plan.threads : []), ...threads];

  const swarm = { id, title: native.title || external.find((item) => item.swarm.title)?.swarm.title || '', host_conversation_id: native.id };
  const channels = new Map();
  for (const source of sources) {
    for (const channel of source.board.channels) {
      if (!channels.has(channel.name)) channels.set(channel.name,
        { ...channel, created_by: source.nameOf?.(channel.created_by) || channel.created_by, members: [] });
      const item = channels.get(channel.name);
      item.archived &&= channel.archived;
      item.members = [...new Set([...item.members, ...(channel.members || []).map((name) => source.nameOf?.(name) || name)])];
    }
  }
  const edges = sources.flatMap((source) => source.edges).concat(runEdges);
  const edgeMap = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.from, edge.to]);
    const item = edgeMap.get(key) || { from: edge.from, to: edge.to, count: 0, direct: 0, viaAll: 0, viaChannel: 0 };
    for (const field of ['count', 'direct', 'viaAll', 'viaChannel']) item[field] += edge[field] || 0;
    edgeMap.set(key, item);
  }
  const attention = new Map();
  for (const item of sources.flatMap((source) => source.attention.map((item) => ({ ...item,
    ...(item.seq && { seq: resolveSeq(source.key, item.seq) }) }))).concat(runAttention)) {
    attention.set(item.kind + ':' + item.agent, item);
  }
  const source = external.length || records.length ? 'hybrid' : 'native';
  const hidden = new Set(native.unseen);
  const readCursor = native.members.find(({ name }) => name === native.self)?.last_read_seq || 0;
  const seenAt = timeMs(native.messages.findLast((row) => row.seq <= readCursor)?.created_at);
  const unseen = messages.filter((msg) => msg.origin === 'native' ? hidden.has(msg.source_seq) : msg.ts <= seenAt)
    .map(({ seq }) => seq);
  const merged = { ...swarm, source, goal_title: plan.goal?.title, goal_line: plan.goal?.line,
    updated_at: [native.updatedAt, ...external.map((item) => item.swarm.updated_at),
    ...records.map((record) => record.finished_at || record.started_at || record.created_at)].filter(Boolean).sort().at(-1),
    head: messages.at(-1)?.seq || 0, counts: countRosterStates(members) };
  const visibleSwarms = [merged, ...(scope === 'all' ? swarms.filter((item) => !related.has(item.id)) : [])];
  if (args.swarm_id && args.swarm_id !== id && args.swarm_id !== native.id && !related.has(args.swarm_id)) {
    return { other: true, swarms: visibleSwarms };
  }
  return { ...context, source, native, external, sources, records, resolveSeq, swarm, swarms: visibleSwarms,
    self: native.self, members, messages, head: merged.head, unseen, edges: [...edgeMap.values()],
    channels: [...channels.values()], attention: [...attention.values()], plan, view, narrator, narratorState, viewSource,
    rawKey: digest([native.rawRevision, sources.slice(1).map(({ board, view }) => [board.swarm, board.members, view.jsonMtime]), [...runs.values()].map((run) =>
      [run.run_id, run.cli, run.model, run.state, run.started_at, run.finished_at, run.usage, run.last_message, run.error])]) };
}

// Fused sequence numbers are chronological positions. A late arrival or a
// rewrite can change older positions; bind cursors to their exact prefix.
function timelineKey(messages, count = messages.length) {
  return count + ':' + digest(messages.slice(0, count));
}

function validTimeline(messages, key, expected) {
  if (!key) return false;
  const count = Number(key.split(':', 1)[0]);
  return Number.isSafeInteger(count) && count >= 0 && count <= messages.length &&
    (expected === undefined || count === expected) && key === timelineKey(messages, count);
}

async function scopedSnapshot(args, options) {
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  const conversationId = options.conversationId === undefined ? (args.conversationId ?? null) : options.conversationId;
  const scope = args.scope ?? (options.conversationId !== undefined || (conversationId && !args.swarm_id) ? 'session' : 'all');
  const context = { sessionsDir, roots, conversationId, scope };
  const nativeId = args.swarm_id?.startsWith('native-') ? args.swarm_id.slice(7) : null;
  const host = conversationId ?? (options.conversationId === undefined
    ? nativeId || readHostContext(options.configPath, options.root).conversation_id : null);
  const native = readNativeSwarm(host, options);
  const fused = native && await hybridSnapshot(native, { ...context, conversationId: host }, args, options);
  if (fused && !fused.other) return fused;
  if (!swarmDbExists(sessionsDir)) return { ...context, swarms: fused?.swarms || [] };
  const snapshot = await readSwarmSnapshot({ sessionsDir, scope, conversationId, swarmId: args.swarm_id,
    inScope: (swarm) => swarmInScope(swarm, roots) });
  if (snapshot.forbidden) throw forbidden();
  return { ...snapshot, ...context, ...(fused && { swarms: fused.swarms }) };
}

function makePlan({ swarm, members }) {
  return { goal: { title: swarm.goal_title, line: swarm.goal_line },
    tasks: Object.fromEntries(members.filter((worker) => worker.task_summary).map((worker) => [worker.name, worker.task_summary])),
    threads: swarm.threads };
}

function viewFiles(snapshot) {
  if (snapshot.native) {
    const { view, narrator, narratorState } = snapshot;
    return { view, narrator, narratorState };
  }
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
  if (snapshot.native) {
    const { native, sources, resolveSeq } = snapshot;
    const link = (frame) => ({ ...frame, frameUrl: './api/swarm/frame?' +
      new URLSearchParams({ swarm_id: snapshot.swarm.id, path: frame.path }) });
    const project = (frame, source, owner) => link({ ...frame, source_key: source.key, origin: owner,
      agent: source.nameOf?.(frame.agent) || frame.agent, seq: resolveSeq(source.key, frame.seq) });
    const nativePosted = native.postedFrames.map((frame) => project(frame, sources[0], 'native'));
    const nativeReel = native.narratorFrames.filter(({ path }) => isAbsolute(path) && imageType(path))
      .map((frame) => project(frame, sources[0], 'native'));
    const external = sources.slice(1).map((source) => {
      const lists = framesFor(source.board, source.view);
      return { posted: lists.postedFrames.map((frame) => project(frame, source, 'gempt')),
        reel: lists.narratorFrames.map((frame) => project(frame, source, 'gempt')) };
    });
    const postedFrames = [...nativePosted, ...external.flatMap(({ posted }) => posted)];
    const narratorFrames = [...nativeReel, ...external.flatMap(({ reel }) => reel)];
    const preferred = new Map();
    for (const frame of [...nativeReel, ...postedFrames, ...narratorFrames]) {
      if (!preferred.has(frame.path)) preferred.set(frame.path, frame);
    }
    return { frames: [...preferred.values()],
      postedFrames, narratorFrames };
  }
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
  if (snapshot.native) return digest([snapshot.swarm.id, snapshot.members.map((m) =>
    [m.name, m.role, m.channels, m.origin, m.conversationId, m.control_swarm_id])]);
  const controls = snapshot.messages.filter((message) => message.control).map(({ seq, control }) => [seq, control]);
  return digest([snapshot.swarm.id, snapshot.members.map(({ name, role, channels, tail_from_seq }) =>
    [name, role, channels, tail_from_seq]), controls]);
}

function membersFor(snapshot, env) {
  if (snapshot.native) return snapshot.members;
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
  if (snapshot.native) {
    const boards = Object.fromEntries(snapshot.sources.slice(1).map(({ board, view }) =>
      [board.swarm.id, snapshotRaw(board, view)]));
    const runs = snapshot.records.map((record) => {
      const member = snapshot.members.find((item) => item.run_id === record.run_id);
      return { ...runFields(runSummary(record, true)), name: member?.name,
        state: record.state, started_at: record.started_at, finished_at: record.finished_at, error: record.error };
    });
    const gempt = {
      members: JSON.stringify({ boards: Object.fromEntries(Object.entries(boards).map(([id, files]) => [id, JSON.parse(files.members)])), runs }, null, 2),
      board: Object.entries(boards).flatMap(([id, files]) => files.board.trim().split('\n').filter(Boolean).map((line) =>
        JSON.stringify({ ...JSON.parse(line), swarm_id: id }))).concat(snapshot.messages.filter((m) => m.run_id)
          .map((m) => JSON.stringify(m))).join('\n'),
      plan: JSON.stringify(Object.fromEntries(Object.entries(boards).map(([id, files]) => [id, JSON.parse(files.plan)])), null, 2),
      view: JSON.stringify(Object.fromEntries(Object.entries(boards).filter(([, files]) => files.view)
        .map(([id, files]) => [id, JSON.parse(files.view)])), null, 2),
    };
    const native = snapshot.native.raw;
    return { ...native, native, ...(snapshot.source === 'hybrid' && { gempt }) };
  }
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
  const plan = snap.plan ?? makePlan(snap);
  const flags = { builtinOverview: true, graphTab: true, rawTab: true };
  const hasCursor = args.known !== undefined && args.since !== undefined;
  const count = snap.messages.length;
  const timeline = snap.native ? timelineKey(snap.messages) : null;
  const canDelta = hasCursor && args.rosterKey === rosterKey && args.known <= count &&
    (args.known === 0 ? args.since === 0 && (Boolean(snap.native) || count === 0) : snap.messages[args.known - 1]?.seq === args.since) &&
    (!snap.native || validTimeline(snap.messages, args.timelineKey || args.etag?.split('/')[1], args.known));
  const boundary = Math.max(0, (canDelta ? args.known : count) - (args.tail || count));
  const messages = snap.native ? snap.messages : boardMessages(snap);
  const { posts: pinned, viewKey } = pinnedBefore(snap, view, frameLists, boundary, messages);
  const title = snap.swarm.title || snap.swarm.goal_title || '';
  const allowedFiles = allowedViewFiles(snap, view, narrator, options);
  const raw = args.omitRaw ? undefined : snapshotRaw(snap, view);
  const etag = digest([snap.swarm.id, title, snap.self, rosterKey, snap.head, members, view, plan, frameLists,
    snap.attention, snap.swarms, allowedFiles, args.tail || 0, !!args.omitRaw,
    ...(snap.native ? [snap.source, snap.edges, snap.channels, snap.unseen, snap.rawKey, raw] : [])]) + (timeline ? '/' + timeline : '');
  const common = { ok: true, empty: false, conversationId: snap.conversationId,
    swarm: snap.swarm.id, swarm_id: snap.swarm.id, self: snap.self, member: snap.self,
    head: snap.head, etag, rosterKey, viewKey, source: snap.source || 'gempt', ...(timeline && { timelineKey: timeline }) };
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
    systemAttention: snap.attention, flags, ...flags,
    allowedFiles, swarms: snap.swarms,
    ...(snap.rawKey && { rawKey: snap.rawKey }), ...(raw && { raw }) };
}

async function getMessages(args, options) {
  const snap = await scopedSnapshot(args, options);
  const rosterKey = snap.swarm ? rosterKeyFor(snap) : '';
  const base = { ok: true, swarm_id: snap.swarm?.id || null, messages: [], hasMore: false, stale: false, notFound: false,
    rosterKey, head: snap.head || 0 };
  if (!snap.swarm) return { ...base, notFound: true };
  const { before, beforeSeq, fromSeq, limit = fromSeq ? 200 : 0 } = args;
  if (args.rosterKey !== rosterKey || !before || snap.messages[before]?.seq !== beforeSeq ||
      (snap.native && !validTimeline(snap.messages, args.timelineKey))) return { ...base, stale: true };
  const index = fromSeq ? snap.messages.findIndex((m) => m.seq === fromSeq) : before - 1;
  if (index < 0 || index >= before) return { ...base, notFound: true };
  const amount = limit ? Math.min(limit, 500) : before;
  const offset = Math.max(0, before - Math.ceil((before - index) / amount) * amount);
  return { ...base, offset, before, totalMessages: snap.messages.length, hasMore: offset > 0,
    messages: (snap.native ? snap.messages : boardMessages(snap)).slice(offset, before) };
}

async function getRaw(args, options) {
  // The legacy single-file operation has always allowed workspace-scoped IDs.
  const snap = await scopedSnapshot(explicitBoardScope(args), options);
  if (!snap.swarm) throw notFound();
  const all = snapshotRaw(snap, viewFiles(snap).view);
  const raw = args.origin ? all[args.origin] ?? (!snap.native && args.origin === 'gempt' ? all : null) : all;
  if (!raw) throw notFound('Raw source not found.');
  const filename = args.kind === 'html' ? 'view.html' : args.kind + (args.kind === 'board' ? '.jsonl' : '.json');
  return { ok: true, swarm_id: snap.swarm.id, ...raw, raw,
    ...(args.kind ? { kind: args.kind, filename, content: raw[args.kind] ?? '' } : {}) };
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

function nativeBrainRoots(native, agent) {
  const ids = agent ? native.members.filter((member) => member.name === agent).map((member) => member.conversationId)
    : [native.id, ...native.members.map((member) => member.conversationId)];
  return [...new Set(ids)].filter((id) => /^[0-9a-f-]{8,128}$/i.test(id ?? '')).map((id) => join(native.brain, id))
    .filter((path) => {
      try { return realpathSync(path) === path; }
      catch { return false; }
    });
}

function allowedViewFiles(snapshot, view, narrator, options) {
  const roots = view.origin === 'native' ? nativeBrainRoots(snapshot.native)
    : artifactRoots(snapshot.viewSource?.board?.swarm ? { ...snapshot, swarm: snapshot.viewSource.board.swarm } : snapshot,
      narrator, options);
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
  const roots = candidates.flatMap(({ agent, origin, source_key }) => {
    if (origin === 'native') return nativeBrainRoots(snap.native, agent);
    const source = snap.sources?.find(({ key }) => key === source_key);
    const member = agent ? snap.members.find(({ name }) => name === agent) : source ? source.narrator : narrator;
    return artifactRoots(source?.board || snap, member, options);
  });
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
  if (view.origin === 'native' || narrator?.origin === 'native') throw notFound('Native narrator feedback uses Antigravity.');
  if (!narrator || narrator.state === 'killed') throw notFound('No active narrator.');
  const board = snap.viewSource?.board;
  const target = board ? snap.viewSource.narrator : narrator;
  if (!target) throw notFound('No active GemPT narrator.');
  const body = narratorFeedback(view, args.target_id, args.text);
  return handleBoardAction({ action: 'post', swarm_id: board?.swarm.id || snap.swarm.id, from: 'human',
    text: `@${target.name} ${body}`, meta: { narrator_feedback: args.target_id },
  }, { ...buildEngineOptions(options, snap.sessionsDir), actor: 'human' });
}

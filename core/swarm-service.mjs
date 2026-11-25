import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { readHostContext } from './host-context.mjs';
import { cacheHitRatio } from './token-usage.mjs';
import { checkArgs, runSummary } from './live-service.mjs';
import { interruptRun, readRun } from './runs.mjs';
import { resolvePath, withinPath } from './state.mjs';
import { recordInWorkspace, workspaceFileRoots } from './worktrees.mjs';
import {
  getBoardHead, getSwarmOverview, getWorker, listRoster, listSwarms, openSwarmDb,
  readBoardMessages, resolveSwarmDbPath, updateWorker, validateSwarmId, validateWorkerName,
} from './swarm-bus.mjs';
import { handleBoardAction, handleSwarmAction } from './swarm-engine.mjs';

const SWARM_ID_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' };
const WORKER_NAME_SCHEMA = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,23}$' };

export const SWARM_OPERATIONS = {
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
    properties: { swarm_id: SWARM_ID_SCHEMA, kind: { type: 'string', enum: ['members', 'board', 'plan'] } },
    required: ['swarm_id', 'kind'],
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
      action: { type: 'string', enum: ['title', 'kill', 'interrupt', 'channel'] },
      op: { type: 'string', enum: ['create', 'archive'] },
      channel: { type: 'string' },
      topic: { type: 'string' },
      name: WORKER_NAME_SCHEMA,
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
  }, buildEngineOptions(options, sessionsDir));
}

async function performSwarmAction(args, options) {
  let swarmId;
  try { swarmId = validateSwarmId(args.swarm_id); } catch (err) { throw badRequest(err.message); }
  const sessionsDir = resolveSessions(options);
  const roots = workspaceScope(options);
  await assertExistingScopedSwarm(swarmId, sessionsDir, roots);
  const engineOpts = buildEngineOptions(options, sessionsDir);

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

async function getRaw({ swarm_id: id, kind }, options) {
  const sessionsDir = resolveSessions(options);
  const { roster, swarm } = await assertExistingScopedSwarm(id, sessionsDir, workspaceScope(options));
  let content;
  if (kind === 'board') {
    const messages = await readBoardMessages(id, { sessionsDir, limit: Infinity });
    content = messages.map(({ seq, from_agent: agent, text, created_at: time, kind, channel, control, request_id }) =>
      JSON.stringify({ seq, agent, text, time, kind, channel, ...(control && { control }), ...(request_id && { request_id }) })).join('\n');
    if (messages.length) content += '\n';
  } else if (kind === 'members') {
    const members = Object.fromEntries(roster.map((w) => [w.name, {
      conversation_id: w.session_id, role: w.role, model: w.model, added_by: w.added_by, channels: w.channels,
      wake_mode: w.wake_mode, wait_since: w.wait_since, last_read_seq: w.last_read_seq, last_nudged_seq: w.last_nudged_seq,
      last_park_blocked_seq: w.last_park_blocked_seq, quota_paused_seq: w.quota_paused_seq, killed: w.state === 'killed',
      state: w.state,
    }]));
    content = JSON.stringify({ title: swarm.title, members }, null, 2);
  } else {
    content = JSON.stringify({ goal: { title: swarm.goal_title, line: swarm.goal_line },
      tasks: Object.fromEntries(roster.filter((w) => w.task_summary).map((w) => [w.name, w.task_summary])),
      threads: swarm.threads }, null, 2);
  }
  return { ok: true, swarm_id: id, kind, filename: kind + (kind === 'board' ? '.jsonl' : '.json'), content };
}

export async function runSwarmOperation(operation, args, options = {}) {
  const schema = Object.hasOwn(SWARM_OPERATIONS, operation) && SWARM_OPERATIONS[operation];
  if (!schema) throw Object.assign(new Error('Unknown Swarm operation.'), { status: 404 });
  checkArgs(operation, args, schema);
  if (operation === 'list') return listSwarmItems(args, options);
  if (operation === 'overview') return getOverview(args, options);
  if (operation === 'board') return getBoard(args, options);
  if (operation === 'raw') return getRaw(args, options);
  if (operation === 'post') return postHumanMessage(args, options);
  return performSwarmAction(args, options);
}

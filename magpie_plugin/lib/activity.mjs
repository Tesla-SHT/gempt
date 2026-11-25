import { isRunOccupying, readRun, reconcileRunState, stateEntries } from '../../core/runs.mjs';
import { isValidSessionId } from '../../core/state.mjs';
import {
  existsSync, lstatSync, readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { createBackgroundWorker, serveBackgroundWorker } from './background-worker.mjs';
import { correlateGatewayUsage } from './activity-gateway.mjs';
import { readActivityTimeline } from './activity-timeline.mjs';
import { buildRequestAnalytics, buildSessionAnalytics } from './activity-analytics.mjs';
import { readJsonSafe, resolveConfigPath, resolveMagpieConfigDir, resolveSessionsDir } from '../../core/config.mjs';
import { defaultGatewayFromEnv, resolveMagpieApiKey } from '../../core/magpie.mjs';

const ACTIVITY_CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 8;
const rawActivityCache = new Map();
const enrichedActivityCache = new Map();
const activityCacheStats = { rawHits: 0, rawMisses: 0, enrichedHits: 0, enrichedMisses: 0 };

export function invalidateActivityCache(sessionsDir) {
  if (!sessionsDir) {
    rawActivityCache.clear();
    enrichedActivityCache.clear();
    return;
  }
  const resolved = resolveSessionsDir(sessionsDir);
  rawActivityCache.delete(resolved);
  for (const key of enrichedActivityCache.keys()) {
    try {
      if (JSON.parse(key)[0] === resolved) enrichedActivityCache.delete(key);
    } catch { /* ignore */ }
  }
}

export function getActivityCacheStats() {
  return { ...activityCacheStats };
}

function setBoundedCache(map, key, value) {
  if (!map.has(key) && map.size >= MAX_CACHE_ENTRIES) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

function statSignature(path) {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return 'missing';
  }
}

function sortedMtimeEntries(dirPath, filterFn) {
  if (!existsSync(dirPath)) return [];
  const entries = [];
  for (const name of readdirSync(dirPath)) {
    if (!filterFn(name)) continue;
    const full = join(dirPath, name);
    try {
      const st = statSync(full);
      entries.push({ name, full, mtimeMs: st.mtimeMs });
    } catch {
      // Skip disappeared or unreadable entry.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

const titleSpace = /[\s\u0085\x1c-\x1f]+/g;
const titlePrefix = new RegExp([
  '^[ \\t]*(?:#{1,6}[ \\t]+|[-*+>][ \\t]+|[0-9]+[.)][ \\t]+)',
  '^(?:用户反馈|任务目标|目标|需求|Goal)\\s*[:：]\\s*',
  '^请?在(?:你当前分配的|当前分配的|当前的?)?(?:隔离)?\\s*'
    + '(?:工作区|工作目录|worktree)[^\\n。]*?[中内里][：:,，]?\\s*(?:[（(][^\\n）)]*[）)]\\s*)?',
  '^请?(?:先|帮我|协助我|麻烦你)\\s*|^请\\s*',
  /^(?:[`'"“‘](?:[a-z]:[\\/]|[\\/]{1,2}|~\/)[^`'"”’]+[`'"”’]|(?:[a-z]:[\\/]|[\\/]{1,2}|~\/)[^\s：:,，。；;]+)(?:\s+|[：:,，·—–-]+\s*|$)/.source,
].join('|'), 'i');

export function workspaceName(cwd) {
  return typeof cwd === 'string' ? cwd.replace(/[/\\]+$/, '').split(/[/\\]+/).at(-1) : '';
}

function shortenTitle(text, limit) {
  const characters = Array.from(text);
  return characters.length <= limit ? text : characters.slice(0, limit - 1).join('').trimEnd() + '…';
}

export function explicitTitle(title) {
  return typeof title === 'string' ? shortenTitle(title.replace(titleSpace, ' ').trim(), 48) : '';
}

export function normalizeTitle(title, goal, cwd) {
  const name = explicitTitle(title);
  if (name) return name;
  let text = typeof goal === 'string' ? goal.replace(/\r\n?/g, '\n') : '';
  text = text.replace(/^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[^\n]*(?:\n|$)|(?![\s\S]))/gm, '');
  const section = /^#{1,6}[ \t]+(?:Goal|任务目标|目标)[:：]?[ \t]*$/im.exec(text);
  if (section) text = text.slice(section.index + section[0].length);
  text = text.replace(/^\s*You are executing a task delegated by[^\n]*?(?:\.(?=\s|$)|\n|$)/gim, '');
  for (const raw of text.split(/[\n\v\f\x1c-\x1e\u0085\u2028\u2029]/)) {
    let line = raw.replace(titleSpace, ' ').trim();
    while (line) {
      const stripped = line.replace(titlePrefix, '').trimStart();
      if (stripped === line) break;
      line = stripped;
    }
    const intent = line.replaceAll('`', '').split(/[。！？!?；;]|\.(?= |$)/, 1)[0]
      .replace(/^[ #：:，,·—–-]+|[ #：:，,·—–-]+$/g, '');
    if (intent) {
      const prefix = shortenTitle(workspaceName(cwd), 16);
      return shortenTitle(prefix ? `${prefix} · ${intent}` : intent, 32);
    }
  }
  return shortenTitle(workspaceName(cwd), 32) || 'GPT 任务';
}

export function sessionGoal(record) {
  if (typeof record.goal === 'string' && record.goal.trim()) return record.goal;
  let index = 0;
  for (const turn of Array.isArray(record.turns) ? record.turns : []) {
    if (!turn || typeof turn !== 'object' || (turn.role != null && turn.role !== 'user')) continue;
    index++;
    const goal = record.turn_details?.[index]?.goal || turn.goal || turn.prompt || turn.content;
    if (typeof goal === 'string' && goal.trim()) return goal;
  }
  return '';
}

const ACTIVITY_RUN_ID = /^[a-f0-9]{32}$/;
const safeSessionId = (id) => isValidSessionId(id);

function inferSessionMode(id, data) {
  if (!data || typeof data !== 'object') return null;
  if (data.session_id && data.session_id !== id) return null;
  if (id.startsWith('exec-')) {
    return data.mode && data.mode !== 'exec' ? null : 'exec';
  }
  if (id.startsWith('consult-')) {
    return data.mode && data.mode !== 'consult' ? null : 'consult';
  }
  return data.mode === 'exec' || data.mode === 'consult' ? data.mode : null;
}

export function isActivityId(kind, id) {
  if (kind === 'sessions') return safeSessionId(id);
  if (/^run-[a-f0-9]{32}$/.test(id)) return true;
  const [sid, turn, beyond] = id.split(':');
  return beyond === undefined && safeSessionId(sid) && /^[1-9][0-9]{0,8}$/.test(turn);
}

const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting_gemini']);

function reconcileActivityRun(data, modifiedMs) {
  const record = { ...data };
  return reconcileRunState(record, () => modifiedMs);
}

export function listConsultSessions(sessionsDir, { limit, matches }) {
  const sessions = [];
  for (const entry of sortedMtimeEntries(resolveSessionsDir(sessionsDir), (name) => name.endsWith('.json'))) {
    const id = entry.name.slice(0, -5);
    if (!safeSessionId(id)) continue;
    const record = readJsonSafe(entry.full);
    if (inferSessionMode(id, record) !== 'consult' || !matches(record)) continue;
    sessions.push({
      session_id: id, mode: 'consult', host_conversation_id: record.host_conversation_id ?? null,
      title: normalizeTitle(record.title, sessionGoal(record), record.cwd),
      cwd: record.cwd || null, model: record.model || '', tier: record.tier || '',
      updated_at: record.updated_at || null,
    });
    if (sessions.length >= limit) break;
  }
  return sessions;
}

export function readRecentActivity(sessionsDir, limit = 6) {
  const recentSessions = [];
  for (const entry of sortedMtimeEntries(sessionsDir, (n) => n.endsWith('.json'))) {
    const id = entry.name.slice(0, -5);
    if (!safeSessionId(id)) continue;
    const rec = readJsonSafe(entry.full);
    const mode = inferSessionMode(id, rec);
    if (!mode) continue;
    recentSessions.push({
      session_id: String(rec.session_id || id),
      mode,
      tier: String(rec.tier || ''),
      model: String(rec.model || ''),
      agent: String(rec.agent || ''),
      turns: Array.isArray(rec.turns) ? rec.turns.length : 0,
      cwd_name: workspaceName(rec.cwd),
      title: normalizeTitle(rec.title, sessionGoal(rec), rec.cwd),
      updated_at: String(rec.updated_at || ''),
    });
    if (recentSessions.length >= limit) break;
  }

  const runsDir = join(sessionsDir, 'runs');
  const recentRuns = [];
  if (existsSync(runsDir)) {
    const runDirs = sortedMtimeEntries(runsDir, (name) => ACTIVITY_RUN_ID.test(name));
    for (const dirEntry of runDirs) {
      const stateFile = join(dirEntry.full, 'state.json');
      const file = readActivityFile(stateFile);
      if (!file) continue;
      const { data, modifiedMs } = file;
      if (data.run_id && data.run_id !== dirEntry.name) continue;
      const reconciled = reconcileActivityRun(data, modifiedMs);
      recentRuns.push({
        run_id: String(reconciled.run_id || dirEntry.name),
        session_id: reconciled.session_id ?? null,
        state: String(reconciled.state || 'unknown'),
        cwd_name: workspaceName(reconciled.cwd),
        title: normalizeTitle(reconciled.title, reconciled.goal, reconciled.cwd),
        tier: String(reconciled.result?.tier || ''),
        model: String(reconciled.result?.model || ''),
        verification: String(reconciled.result?.verification?.status || ''),
        ...(reconciled.remote_turn_unconfirmed ? { remote_turn_unconfirmed: true } : {}),
      });
      if (recentRuns.length >= limit) break;
    }
  }

  if (recentSessions.length) {
    const sessionIds = new Set(recentSessions.map(({ session_id }) => session_id));
    for (const { id, stat } of stateEntries(sessionsDir)) {
      if (!sessionIds.size) break;
      let run;
      try { run = readRun(id, sessionsDir, { stat, readonly: true }); } catch { continue; }
      if (sessionIds.delete(run.session_id)) {
        recentSessions.find(({ session_id }) => session_id === run.session_id).has_live_run = true;
      }
    }
  }
  return { recentSessions, recentRuns };
}

export function readActiveRuns(sessionsDir) {
  const nowMs = Date.now();
  const result = [];
  for (const { id, mtime: modifiedMs, stat } of stateEntries(sessionsDir)) {
    let reconciled;
    try { reconciled = readRun(id, sessionsDir, { stat, readonly: true, allowLegacyId: true }); } catch { continue; }
    if (!isRunOccupying(reconciled, nowMs, modifiedMs)) continue;
    result.push({
      run_id: id,
      state: reconciled.state,
      session_id: reconciled.session_id ?? null,
      cwd: reconciled.cwd,
      created_at: reconciled.created_at ?? null,
      started_at: reconciled.started_at ?? null,
      title: normalizeTitle(reconciled.title, reconciled.goal, reconciled.cwd),
      codex_thread_id: reconciled.codex_thread_id ?? null,
      turn_id: reconciled.turn_id ?? null,
      progress: reconciled.progress ?? null,
      pending_tool_call: reconciled.pending_tool_call ?? null,
      ...(reconciled.remote_turn_unconfirmed ? { remote_turn_unconfirmed: true } : {}),
    });
  }
  return result;
}

function activityEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readActivityFile(file) {
  try {
    const stat = lstatSync(file);
    if (stat.isFile()) {
      const data = readJsonSafe(file);
      if (data) return { data, modified: stat.mtime.toISOString(), modifiedMs: stat.mtimeMs };
    }
  } catch {
    // A worker may have replaced or removed the entry since enumeration.
  }
  return null;
}

function sessionsFingerprint(dir) {
  const dirSig = statSignature(dir);
  if (dirSig === 'missing') return 'missing';
  const entries = activityEntries(dir);
  const parts = [`d:${dirSig}`];
  const sessionParts = [];
  let hasRunsDir = false;
  for (const entry of entries) {
    if (entry.name === 'runs' && entry.isDirectory()) {
      hasRunsDir = true;
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!safeSessionId(id)) continue;
    sessionParts.push(`s:${entry.name}:${statSignature(join(dir, entry.name))}`);
  }
  sessionParts.sort();
  parts.push(...sessionParts);
  if (hasRunsDir) {
    const runsDir = join(dir, 'runs');
    parts.push(`rd:${statSignature(runsDir)}`);
    const runParts = [];
    for (const entry of activityEntries(runsDir)) {
      if (!entry.isDirectory() || !ACTIVITY_RUN_ID.test(entry.name)) continue;
      runParts.push(`r:${entry.name}:${statSignature(join(runsDir, entry.name, 'state.json'))}`);
    }
    runParts.sort();
    parts.push(...runParts);
  }
  return parts.join('|');
}

function liveRunStateChanged(liveRunChecks) {
  if (!liveRunChecks?.length) return false;
  const nowMs = Date.now();
  for (const snap of liveRunChecks) {
    const reconciled = reconcileActivityRun(snap.record, snap.modifiedMs);
    const occupying = isRunOccupying(reconciled, nowMs, snap.modifiedMs);
    if (reconciled.state !== snap.state || occupying !== snap.occupying) {
      return true;
    }
  }
  return false;
}

function activityTime(...values) {
  for (const value of values) {
    const ms = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1)
      : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) return new Date(ms).toISOString();
  }
  return null;
}

const activityNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function activityUsage(usage) {
  const input = activityNumber(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = activityNumber(usage?.output_tokens ?? usage?.completion_tokens);
  const cached = activityNumber(usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens);
  const read = cached ?? activityNumber(usage?.cache_read_input_tokens ?? usage?.cache_read_tokens);
  const write = activityNumber(usage?.cache_creation_input_tokens ?? usage?.cache_write_tokens);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: read,
    cache_write_tokens: write,
    cache_hit_rate: read != null && input != null && input + (cached == null ? read + (write ?? 0) : 0) > 0
      ? read / (input + (cached == null ? read + (write ?? 0) : 0)) : null,
    reasoning_tokens: activityNumber(usage?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens
      ?? usage?.completion_tokens_details?.reasoning_tokens),
    total_tokens: activityNumber(usage?.total_tokens) ?? ([input, output, read, write].some((n) => n != null)
      ? (input ?? 0) + (output ?? 0) + (cached == null ? read ?? 0 : 0) + (write ?? 0) : null),
  };
}

function promptSection(prompt, heading) {
  const marker = `## ${heading}\n`;
  const start = prompt.indexOf(marker);
  return start < 0 ? '' : prompt.slice(start + marker.length).split(/\n\n## /, 1)[0].trim();
}

function activityRequest(source, context) {
  const prompt = String(source.prompt || '').replaceAll('\r\n', '\n');
  const verification = source.verification;
  const requested = (typeof verification === 'string' ? verification : verification?.requested)
    || promptSection(prompt, 'Required Verification');
  return {
    ...context,
    timestamp: activityTime(source.timestamp, source.finished_at, source.updated_at, source.started_at, source.created_at),
    started_at: activityTime(source.started_at),
    finished_at: activityTime(source.finished_at),
    cwd: String(source.cwd ?? context.cwd ?? ''),
    agent: String(source.agent ?? context.agent ?? ''),
    tier: String(source.tier ?? context.tier ?? ''),
    model: String(source.served_model || source.model || context.model || ''),
    requested_model: String(source.requested_model || ''),
    sent_model: String(source.sent_model || ''),
    provider: String(source.provider || ''),
    account: String(source.account || ''),
    reasoning_effort: String(source.reasoning_effort ?? context.reasoning_effort ?? ''),
    codex_thread_id: String(source.codex_thread_id ?? context.codex_thread_id ?? ''),
    turn_id: String(source.turn_id ?? source.progress?.turn_id ?? ''),
    response_id: String(source.response_id ?? ''),
    attemptedModels: Array.isArray(source.attempted_models) ? source.attempted_models.filter((model) => typeof model === 'string') : [],
    goal: String(source.goal || promptSection(prompt, 'Goal') || prompt),
    title: explicitTitle(source.title),
    prompt,
    reply: String(source.reply || source.reply_preview || ''),
    reply_is_preview: !source.reply && Boolean(source.reply_preview),
    status: String(source.status || 'succeeded'),
    ...(source.state ? { state: source.state } : {}),
    ...(source.progress ? { progress: source.progress } : {}),
    ...(source.pending_tool_call ? { pending_tool_call: source.pending_tool_call } : {}),
    ...(source.remote_turn_unconfirmed ? { remote_turn_unconfirmed: true } : {}),
    retried: Boolean(source.retried || source.attempted_models?.length > 1),
    error: String(source.error || ''),
    elapsed_sec: activityNumber(source.elapsed_sec),
    ttft_ms: activityNumber(source.ttft_ms),
    output_tokens_per_sec: activityNumber(source.tokens_per_sec ?? source.output_tokens_per_sec),
    cost: activityNumber(source.cost_usd ?? source.cost),
    usage: activityUsage(source.usage),
    verification: {
      status: String(verification?.status || (requested ? 'unverified' : '')),
      requested: String(requested || ''),
      checks: Array.isArray(verification?.checks) ? verification.checks : [],
    },
    commands: Array.isArray(source.commands) ? source.commands : Array.isArray(verification?.commands) ? verification.commands : [],
  };
}

function readActivitySession(dir, id) {
  const file = readActivityFile(join(dir, `${id}.json`));
  if (!file) return null;
  const { data, modified } = file;
  const mode = inferSessionMode(id, data);
  if (!mode) return null;

  // Legacy consult and native exec files store alternating messages. Python
  // exec files store one object per turn, with a reply preview in older files.
  const turns = [];
  for (const entry of Array.isArray(data.turns) ? data.turns : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role === 'assistant') {
      const prior = turns.at(-1);
      if (prior?.role === 'user' && prior.reply === undefined) prior.reply = entry.content;
    } else if (entry.role === 'user') {
      turns.push({ ...entry, prompt: entry.prompt ?? entry.content });
    } else if (!entry.role) {
      turns.push(entry);
    }
  }
  const created = activityTime(data.created_at);
  const updated = activityTime(data.updated_at, modified);
  const requests = turns.map((entry, index) => {
    const turn = index + 1;
    const source = { ...entry, ...data.turn_details?.[turn] };
    return activityRequest({
      ...source,
      timestamp: activityTime(source.timestamp, source.finished_at, source.updated_at, source.created_at,
        turn === turns.length ? updated : turn === 1 ? created : null),
    }, {
      id: `${id}:${turn}`, session_id: id, turn, mode,
      run_id: ACTIVITY_RUN_ID.test(source.run_id ?? '') ? source.run_id : '',
      cwd: data.cwd, agent: data.agent, model: data.model, tier: data.tier,
      reasoning_effort: data.reasoning_effort, codex_thread_id: data.codex_thread_id,
    });
  });
  return { id, mode, created_at: created, updated_at: updated, requests, runs: [],
    title: explicitTitle(data.title), cwd: String(data.cwd || ''), model: String(data.model || ''), tier: String(data.tier || '') };
}

function readActivityRun(dir, id, liveRunChecks) {
  const file = readActivityFile(join(dir, id, 'state.json'));
  if (!file) return null;
  const { data, modified, modifiedMs } = file;
  if ((data.run_id && data.run_id !== id) || !data.state) return null;
  const reconciled = reconcileActivityRun(data, modifiedMs);
  const nowMs = Date.now();
  const occupying = isRunOccupying(reconciled, nowMs, modifiedMs);
  if (ACTIVE_RUN_STATES.has(data.state) || occupying || reconciled.remote_turn_unconfirmed) {
    liveRunChecks?.push({
      record: {
        state: data.state,
        pid: data.pid,
        source: data.source,
        deadline: data.deadline,
        created_at: data.created_at,
        started_at: data.started_at,
        finished_at: data.finished_at,
        unconfirmed_at: data.unconfirmed_at,
        turn_id: data.turn_id,
        remote_turn_unconfirmed: data.remote_turn_unconfirmed,
        progress: data.progress ? { updated_at: data.progress.updated_at } : null,
      },
      modifiedMs,
      state: reconciled.state,
      occupying,
    });
  }
  const result = reconciled.result;
  const sessionId = result?.session_id || reconciled.session_id;
  const status = reconciled.state === 'finished' ? 'succeeded' : reconciled.state;
  const reply = result?.reply ?? String(result?.text || '').replace(/^\[mode=exec \| [^\r\n]+\]\r?\n\r?\n/, '');
  const request = activityRequest({
    ...reconciled,
    ...result,
    status,
    state: status === 'succeeded' ? 'finished' : status,
    reply,
    error: reconciled.error,
    pending_tool_call: reconciled.pending_tool_call,
    remote_turn_unconfirmed: reconciled.remote_turn_unconfirmed,
    timestamp: activityTime(reconciled.finished_at, result?.timestamp, reconciled.updated_at, reconciled.started_at, reconciled.created_at, modified),
  }, {
    id: `run-${id}`, run_id: id, mode: 'exec',
    session_id: safeSessionId(sessionId) && !sessionId.startsWith('consult-') ? sessionId : '',
    turn: null,
  });
  return { request, turn: result?.turn ?? result?.turns ?? reconciled.turn };
}

function joinActivityRun(session, request, turn) {
  // Old native receipts did not include a turn number. Match their full reply
  // only if it identifies one turn in the same session.
  let target = session.requests.find((item) => item.run_id === request.run_id);
  if (!target && request.status === 'succeeded') {
    const candidates = session.requests.filter((item) => !item.run_id);
    if (Number.isSafeInteger(turn) && turn > 0) {
      target = candidates.find((item) => item.turn === turn && (!request.reply || !item.reply
        || (item.reply_is_preview ? request.reply.startsWith(item.reply) : request.reply === item.reply)));
    } else if (request.reply) {
      const matches = candidates.filter((item) => item.reply === request.reply && !item.reply_is_preview);
      if (matches.length === 1) [target] = matches;
    }
  }
  if (target) {
    target.run_id = request.run_id;
    if (request.progress || !ACTIVE_RUN_STATES.has(request.status)) target.status = request.status;
    for (const key of ['state', 'progress', 'pending_tool_call', 'remote_turn_unconfirmed']) {
      if (request[key]) target[key] = request[key];
    }
    target.retried ||= request.retried;
    target.timestamp ||= request.timestamp;
    for (const key of ['cwd', 'agent', 'tier', 'model', 'requested_model', 'sent_model', 'provider', 'account',
      'reasoning_effort', 'codex_thread_id', 'turn_id', 'response_id', 'started_at', 'finished_at', 'goal', 'title', 'prompt', 'error']) {
      if (request[key]) target[key] = request[key];
    }
    if (request.attemptedModels.length) target.attemptedModels = request.attemptedModels;
    if (request.reply) {
      target.reply = request.reply;
      target.reply_is_preview = request.reply_is_preview;
    }
    for (const key of ['elapsed_sec', 'ttft_ms', 'output_tokens_per_sec', 'cost']) {
      target[key] = request[key] ?? target[key];
    }
    for (const [key, value] of Object.entries(request.usage)) {
      if (value != null) target.usage[key] = value;
    }
    if (request.verification.status && (request.verification.status !== 'unverified' || !target.verification.status)) {
      target.verification = request.verification;
    }
    if (request.commands.length) target.commands = request.commands;
  } else {
    if (request.status === 'succeeded' && Number.isSafeInteger(turn) && turn > 0
      && !session.requests.some((item) => item.turn === turn)) request.turn = turn;
    session.requests.push(request);
  }
  session.runs.push({ run_id: request.run_id, request_id: (target || request).id, turn: (target || request).turn,
    status: request.status, timestamp: request.timestamp });
}

function totalUsage(requests) {
  const totals = activityUsage();
  for (const request of requests) {
    for (const key of Object.keys(totals)) {
      if (key !== 'cache_hit_rate' && request.usage[key] != null) totals[key] = (totals[key] ?? 0) + request.usage[key];
    }
  }
  const measured = requests.filter((row) => row.usage.cache_hit_rate != null);
  const input = sumKnown(measured, (row) => row.cacheInput);
  if (input > 0) totals.cache_hit_rate = Math.min(1, sumKnown(measured, (row) => row.usage.cache_read_tokens) / input);
  return totals;
}

function sumKnown(rows, value) {
  return rows.reduce((total, row) => {
    const current = value(row);
    return current == null ? total : (total ?? 0) + current;
  }, null);
}

function activityCost(rows) {
  return sumKnown(rows, (row) => row.cost_usd);
}

function mergeGatewayUsage(request, rows) {
  request.gateway_requests = rows;
  request.gateway_request_count = rows.length;
  request.cost_usd = request.cost = activityCost(rows) ?? request.cost;
  const distinct = (value) => [...new Set(rows.map(value).filter(Boolean))].join(' / ');
  for (const key of ['requested_model', 'sent_model', 'provider', 'account']) {
    request[key] = distinct((row) => row[key]) || request[key];
  }
  request.provider_accounts = distinct((row) => [row.provider, row.account].filter(Boolean).join(' · '));
  const withTtft = rows.filter((row) => row.ttft_ms != null);
  request.ttft_ms = (withTtft.find((row) => row.status_code >= 200 && row.status_code < 300) ?? withTtft[0])?.ttft_ms
    ?? request.ttft_ms;
  const estimates = rows.filter((row) => row.tokens_per_sec != null);
  const generationMs = (row) => row.tokens_per_sec > 0 && row.generated_tokens > 0
    ? row.generated_tokens * 1000 / row.tokens_per_sec : row.generation_ms;
  const duration = sumKnown(estimates, generationMs);
  request.tokens_per_sec = request.output_tokens_per_sec = duration > 0
    ? sumKnown(estimates, (row) => generationMs(row) == null ? null : row.tokens_per_sec * generationMs(row)) / duration
    : estimates[0]?.tokens_per_sec ?? request.output_tokens_per_sec;

  const usage = request.usage;
  const cached = sumKnown(rows, (row) => row.cache_read_tokens);
  const input = sumKnown(rows.filter((row) => row.cache_read_tokens != null), (row) => row.input_tokens == null ? null
    : row.input_tokens + (row.input_includes_cache ? 0 : row.cache_read_tokens + (row.cache_write_tokens ?? 0)));
  if (cached != null) {
    usage.cache_read_tokens = cached;
    usage.cache_hit_rate = input > 0 ? Math.min(1, cached / input) : null;
    request.cacheInput = input;
  } else if (usage.cache_hit_rate != null) {
    request.cacheInput = usage.cache_hit_rate > 0 ? usage.cache_read_tokens / usage.cache_hit_rate : usage.input_tokens;
  }
  usage.cache_write_tokens = sumKnown(rows, (row) => row.cache_write_tokens) ?? usage.cache_write_tokens;
  for (const key of ['input_tokens', 'output_tokens', 'reasoning_tokens']) {
    usage[key] ??= sumKnown(rows, (row) => row[key]);
  }
  usage.total_tokens ??= sumKnown(rows, (row) => row.input_tokens == null && row.output_tokens == null ? null
    : (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
      + (row.input_includes_cache ? 0 : (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0)));
}

function buildDispatchActivity(dir) {
  const entries = activityEntries(dir);
  const sessions = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!safeSessionId(id)) continue;
    const session = readActivitySession(dir, id);
    if (session) sessions.set(id, session);
  }

  const sessionsByRun = new Map();
  for (const session of sessions.values()) {
    for (const request of session.requests) {
      if (request.run_id) sessionsByRun.set(request.run_id, session.id);
    }
  }
  const runsDir = join(dir, 'runs');
  const runRecords = [];
  const liveRunChecks = [];
  if (entries.some((entry) => entry.name === 'runs' && entry.isDirectory())) {
    for (const entry of activityEntries(runsDir)) {
      if (!entry.isDirectory() || !ACTIVITY_RUN_ID.test(entry.name)) continue;
      const run = readActivityRun(runsDir, entry.name, liveRunChecks);
      if (!run) continue;
      const { request } = run;
      request.session_id = sessionsByRun.get(request.run_id) || request.session_id;
      if (request.session_id && (request.status === 'succeeded' || request.progress) && !sessions.has(request.session_id)) {
        sessions.set(request.session_id, { id: request.session_id, mode: 'exec', requests: [], runs: [] });
      }
      runRecords.push(run);
    }
  }

  const ledger = [];
  for (const { request, turn } of runRecords) {
    const session = sessions.get(request.session_id);
    if (session) joinActivityRun(session, request, turn);
    else {
      request.dispatchSessionId = request.session_id;
      request.session_id = '';
      ledger.push(request);
    }
  }
  for (const session of sessions.values()) {
    session.requests.sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity)
      || (a.timestamp || '').localeCompare(b.timestamp || ''));
    const first = session.requests[0];
    const latestWith = (key) => session.requests.findLast((item) => item[key])?.[key] || '';
    session.session_id = session.id;
    session.cwd = latestWith('cwd') || session.cwd || '';
    session.title = session.title || normalizeTitle(first?.title, first?.goal, first?.cwd || session.cwd);
    session.model = latestWith('model') || session.model || '';
    session.tier = latestWith('tier') || session.tier || '';
    session.turn_count = session.requests.length;
    session.created_at = session.created_at || first?.timestamp || null;
    session.updated_at = activityTime([session.updated_at, ...session.requests.map((r) => r.timestamp)].filter(Boolean).sort().at(-1));
    const latest = session.requests.reduce((selected, item) =>
      !selected || (item.timestamp || '') >= (selected.timestamp || '') ? item : selected, null);
    if (latest) {
      session.state = latest.state || (latest.status === 'succeeded' ? 'finished' : latest.status);
      if (latest.progress) session.progress = latest.progress;
      if (latest.pending_tool_call) session.pending_tool_call = latest.pending_tool_call;
      if (latest.remote_turn_unconfirmed) session.remote_turn_unconfirmed = true;
    }
    session.usage = totalUsage(session.requests);
    session.elapsed_sec = session.requests.reduce((total, r) => r.elapsed_sec == null ? total : (total ?? 0) + r.elapsed_sec, null);
    ledger.push(...session.requests);
  }
  for (const request of ledger) request.title = normalizeTitle(request.title, request.goal, request.cwd);
  ledger.sort((a, b) => {
    const time = (item) => item.timestamp || sessions.get(item.session_id)?.updated_at || '';
    return time(b).localeCompare(time(a)) || (b.turn ?? 0) - (a.turn ?? 0) || a.id.localeCompare(b.id);
  });
  const history = [...sessions.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.id.localeCompare(b.id));
  return {
    data: { ledger, history, totals: { requests: ledger.length, sessions: history.length, runs: runRecords.length } },
    liveRunChecks,
  };
}

export function readDispatchActivity(sessionsDir) {
  const dir = resolveSessionsDir(sessionsDir);
  const now = Date.now();
  const fp = sessionsFingerprint(dir);
  const hit = rawActivityCache.get(dir);
  if (hit && hit.fp === fp && now >= hit.at && (now - hit.at) <= ACTIVITY_CACHE_TTL_MS && !liveRunStateChanged(hit.liveRunChecks)) {
    activityCacheStats.rawHits += 1;
    return hit.data;
  }
  activityCacheStats.rawMisses += 1;
  const built = buildDispatchActivity(dir);
  setBoundedCache(rawActivityCache, dir, { fp, at: now, data: built.data, liveRunChecks: built.liveRunChecks });
  return built.data;
}

const overviewWorker = createBackgroundWorker(new URL(import.meta.url), 'gempt-overview');
const overviewReads = new Map();
const overviewSnapshots = new WeakMap();

function snapshotOverviewActivity(dir) {
  const ledger = readDispatchActivity(dir);
  if (!overviewSnapshots.has(ledger)) {
    const { recentSessions, recentRuns } = readRecentActivity(dir, 6);
    overviewSnapshots.set(ledger, {
      activityTotals: ledger.totals, recentSessions, recentRuns, activeRuns: readActiveRuns(dir),
    });
  }
  return overviewSnapshots.get(ledger);
}

export function readOverviewActivity(sessionsDir) {
  const dir = resolveSessionsDir(sessionsDir);
  if (!overviewReads.has(dir)) {
    overviewReads.set(dir, overviewWorker(dir).finally(() => overviewReads.delete(dir)));
  }
  return overviewReads.get(dir);
}

if (!isMainThread && workerData === 'gempt-overview') serveBackgroundWorker(snapshotOverviewActivity);

async function enrichDispatchActivity(sessionsDir, magpieConfigDir, configPath) {
  const dir = resolveSessionsDir(sessionsDir);
  const resolvedMagpieDir = resolveMagpieConfigDir(magpieConfigDir);
  const resolvedCfgPath = resolveConfigPath(configPath);
  const usageFile = join(resolvedMagpieDir, 'usage.jsonl');
  const now = Date.now();
  const fp = `${sessionsFingerprint(dir)}\0${statSignature(usageFile)}\0${statSignature(resolvedCfgPath)}`;
  const cacheKey = JSON.stringify([dir, resolvedMagpieDir, resolvedCfgPath]);
  const hit = enrichedActivityCache.get(cacheKey);
  if (hit && hit.fp === fp && now >= hit.at && (now - hit.at) <= ACTIVITY_CACHE_TTL_MS && !liveRunStateChanged(hit.liveRunChecks)) {
    activityCacheStats.enrichedHits += 1;
    return hit.data;
  }
  activityCacheStats.enrichedMisses += 1;
  const built = buildDispatchActivity(dir);
  const { data, liveRunChecks } = built;
  const cfg = readJsonSafe(resolvedCfgPath);
  const baseUrl = cfg?.magpie?.base_url || defaultGatewayFromEnv();
  const candidates = data.ledger.map((row) => ({ ...row, dispatchSessionId: row.session_id || row.dispatchSessionId,
    active: ACTIVE_RUN_STATES.has(row.status) }));
  const linked = await correlateGatewayUsage(usageFile, candidates,
    { baseUrl, apiKey: cfg ? resolveMagpieApiKey(cfg, baseUrl) : '' });
  data.ledger.forEach((row, index) => mergeGatewayUsage(row, linked.get(candidates[index]) || []));
  for (const session of data.history) {
    session.usage = totalUsage(session.requests);
    session.cost_usd = activityCost(session.requests);
    session.gateway_request_count = session.requests.reduce((total, row) => total + row.gateway_request_count, 0);
  }
  setBoundedCache(enrichedActivityCache, cacheKey, { fp, at: Date.now(), data, liveRunChecks });
  return data;
}

function requestListItem(row) {
  const { prompt, reply, error, verification, commands, gateway_requests, cacheInput, attemptedModels, dispatchSessionId, ...item } = row;
  return { ...item, goal: item.goal.slice(0, 320) };
}

function sessionListItem(row) {
  const { requests, runs, ...item } = row;
  return { ...item, live_run_id: requests.findLast((request) => request.run_id)?.run_id ?? null,
    title: item.title.slice(0, 320) };
}

function activityRange(params) {
  const now = new Date();
  const hours = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24, '90d': 90 * 24 };
  const range = params.get('range') || 'all';
  const invalid = (field) => Object.assign(new Error(`invalid activity ${field}`), { status: 400 });
  const dateBound = (field) => {
    const value = params.get(field);
    if (!value) return undefined;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const bound = date ? Date.parse(`${value}T${field === 'to' ? '23:59:59.999' : '00:00:00.000'}`) : Date.parse(value);
    if (!Number.isFinite(bound)) throw invalid(field);
    return bound;
  };
  let start = -Infinity;
  let end = Infinity;
  if (range === 'today') {
    end = now.getTime();
    start = now.setHours(0, 0, 0, 0);
  } else if (Object.hasOwn(hours, range)) {
    end = now.getTime();
    start = end - hours[range] * 3_600_000;
  } else if (range !== 'all') {
    throw invalid('range');
  }
  const from = dateBound('from');
  const to = dateBound('to');
  if (from > to) throw invalid('from/to');
  start = Math.max(start, from ?? -Infinity);
  end = Math.min(end, to ?? Infinity);
  return start === -Infinity && end === Infinity ? null : (timestamp) => {
    const time = Date.parse(timestamp);
    return time >= start && time <= end;
  };
}

function sessionInRange(session, inRange) {
  const requests = session.requests.filter((row) => inRange(row.timestamp));
  if (!requests.length && (session.requests.length || !inRange(session.updated_at))) return null;
  return { ...session, requests, usage: totalUsage(requests), turn_count: requests.length,
    elapsed_sec: sumKnown(requests, (row) => row.elapsed_sec), cost_usd: activityCost(requests),
    gateway_request_count: requests.reduce((total, row) => total + row.gateway_request_count, 0) };
}

const activityCsvFields = [
  ['时间', (r) => r.timestamp], ['请求 ID', (r) => r.id], ['会话 ID', (r) => r.session_id],
  ['标题', (r) => r.title], ['目标', (r) => r.goal], ['模式', (r) => r.mode], ['Agent', (r) => r.agent],
  ['档位', (r) => r.tier], ['文件夹', (r) => r.cwd], ['请求模型', (r) => r.requested_model],
  ['供应商 · 账号', (r) => r.provider_accounts || [r.provider, r.account].filter(Boolean).join(' · ')],
  ['发送模型', (r) => r.sent_model], ['响应模型', (r) => r.model], ['推理强度', (r) => r.reasoning_effort],
  ['输入 Token', (r) => r.usage.input_tokens], ['输出 Token', (r) => r.usage.output_tokens],
  ['缓存写入 Token', (r) => r.usage.cache_write_tokens], ['缓存读取 Token', (r) => r.usage.cache_read_tokens],
  ['缓存命中率', (r) => r.usage.cache_hit_rate], ['费用 USD', (r) => r.cost_usd], ['TTFT ms', (r) => r.ttft_ms],
  ['耗时 s', (r) => r.elapsed_sec], ['速度 tok/s', (r) => r.tokens_per_sec], ['状态', (r) => r.status],
];

function activityCsv(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^(?:\s*[=+\-@＝＋－＠]|[\t\r\n])/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [activityCsvFields.map(([label]) => cell(label)).join(','),
    ...rows.map((row) => activityCsvFields.map(([, value]) => cell(value(row))).join(','))].join('\r\n') + '\r\n';
}

export async function listDispatchActivity(kind, params, sessionsDir, magpieConfigDir, configPath) {
  const inRange = activityRange(params);
  const range = params.get('range') || 'all';
  const { ledger, history } = await enrichDispatchActivity(sessionsDir, magpieConfigDir, configPath);
  const isRequests = kind === 'requests';
  const records = isRequests ? (inRange ? ledger.filter((row) => inRange(row.timestamp)) : ledger)
    : (inRange ? history.map((row) => sessionInRange(row, inRange)).filter(Boolean) : history);
  const fields = {
    mode: 'mode',
    tier: 'tier',
    workspace: 'cwd',
    model: 'model',
    ...(isRequests ? { provider: 'provider', status: 'status' } : {}),
  };
  const recordValues = (row, field) => {
    if (field === 'status' && row.retried) return [row.status, 'retried'];
    if (!isRequests && (field === 'tier' || field === 'model' || field === 'cwd')) {
      return [...new Set([row[field], ...row.requests.map((request) => request[field])])];
    }
    return [row[field]];
  };
  const matches = (row, key, field) => !params.get(key) || recordValues(row, field).includes(params.get(key));
  const query = (params.get('q') ?? params.get('search') ?? '').trim().toLowerCase();
  const findText = (row) => [row.id, row.session_id, row.run_id, row.title, row.goal, row.prompt, row.reply, row.error, row.model,
    row.tier, row.agent, row.cwd, row.requested_model, row.sent_model, row.provider, row.account]
    .some((value) => value?.toLowerCase().includes(query));
  const linked = records.filter((row) => (!params.get('session_id') || row.session_id === params.get('session_id'))
    && (!params.get('run_id') || (isRequests ? row.run_id === params.get('run_id')
      : row.requests.some((request) => request.run_id === params.get('run_id')))));
  const searchable = query ? linked.filter((row) => findText(row) || row.requests?.some(findText)) : linked;
  const filters = Object.entries(fields);
  const filtered = searchable.filter((row) => filters.every(([key, field]) => matches(row, key, field)));
  if (isRequests && params.get('format') === 'csv') return activityCsv(filtered);
  const facets = Object.fromEntries(filters.map(([key, field]) => {
    const counts = new Map();
    for (const row of searchable) {
      if (!filters.every(([other, prop]) => other === key || matches(row, other, prop))) continue;
      for (const value of recordValues(row, field)) {
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [key, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }))];
  }));
  const integer = (key, fallback) => {
    const value = params.get(key);
    return /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
  };
  const limit = Math.min(100, Math.max(1, integer('limit', 25)));
  const offset = integer('offset', 0);
  const requests = isRequests ? filtered : filtered.flatMap((session) => session.requests);
  const baseSummary = {
    requests: requests.length,
    ...totalUsage(requests),
    cost_usd: activityCost(requests),
    failed: 0,
    retried: 0,
    elapsed_sec: null,
    workspaces: new Set(requests.map((row) => row.cwd).filter(Boolean)).size,
  };
  for (const row of requests) {
    if (row.status === 'failed') baseSummary.failed += 1;
    if (row.retried) baseSummary.retried += 1;
    if (row.elapsed_sec != null) baseSummary.elapsed_sec = (baseSummary.elapsed_sec ?? 0) + row.elapsed_sec;
  }

  let analytics;
  if (isRequests) {
    const unclippedSearchable = query ? ledger.filter((row) => findText(row)) : ledger;
    const unclippedFiltered = unclippedSearchable.filter((row) => filters.every(([key, field]) => matches(row, key, field)));
    const { extra_summary, ...rest } = buildRequestAnalytics(filtered, unclippedFiltered, { range });
    Object.assign(baseSummary, extra_summary);
    analytics = rest;
  } else {
    const { extra_summary, ...rest } = buildSessionAnalytics(filtered);
    Object.assign(baseSummary, extra_summary);
    analytics = rest;
  }

  return {
    total: filtered.length,
    summary: baseSummary,
    analytics,
    items: filtered.slice(offset, offset + limit).map(isRequests ? requestListItem : sessionListItem),
    facets,
    limit,
    offset,
  };
}

export async function getDispatchActivity(kind, id, sessionsDir, magpieConfigDir, configPath) {
  if (!isActivityId(kind, id)) return null;
  const { ledger, history } = await enrichDispatchActivity(sessionsDir, magpieConfigDir, configPath);
  const runsDir = join(resolveSessionsDir(sessionsDir), 'runs');
  let remaining = 192 * 1024;
  const renderTurn = ({ cacheInput, attemptedModels, dispatchSessionId, ...row }) => {
    const { timeline, timeline_truncated, bytes } = row.run_id
      ? readActivityTimeline(join(runsDir, row.run_id, 'events.jsonl'),
        { ...row, active: ACTIVE_RUN_STATES.has(row.status) }, Math.min(48 * 1024, remaining))
      : { timeline: [], timeline_truncated: false, bytes: 0 };
    remaining -= bytes;
    return { ...row, timeline, timeline_truncated };
  };
  if (kind === 'requests') {
    const row = ledger.find((row) => row.id === id);
    return row ? renderTurn(row) : null;
  }
  const session = history.find((row) => row.id === id);
  if (!session) return null;
  const { requests: turns, ...detail } = session;
  return { ...detail, turns: [...turns].reverse().map(renderTurn).reverse(),
    gateway_requests: turns.flatMap((row) => row.gateway_requests).sort((a, b) => a.timestamp.localeCompare(b.timestamp)) };
}

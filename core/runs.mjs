import { once } from 'node:events';
import { launchDetached, pidAlive } from '../magpie_plugin/lib/app-server-process.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectAppServer, readAppServerState, readServerTurn, terminalTurn, TERMINAL_INTERRUPT_ERR, textInput, UNAVAILABLE } from '../magpie_plugin/lib/app-server-client.mjs';
import { normalizeTitle, readJsonSafe, resolveConfigPath, resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { getExecutionConfig, getMcpEffort } from './config.mjs';
import { resolveExecTimeoutSec, validateExecTimeoutSec } from '../magpie_plugin/lib/routing.mjs';
import { resolveNodeExecutable } from './node-executable.mjs';
import { readHostContext } from './host-context.mjs';
import { atomicJson, resolvePath, validateSessionId, withLock, withLockSync, withinPath } from './state.mjs';
import { ensureShareWorktree, recordInWorkspace, recordSourceCwd, resolveExternalWorktreeSourceCwd, samePath } from './worktrees.mjs';

import { turnEvidence } from './run-journal.mjs';
import { resolveImplicitSwarmId, soloWorkerName, upsertWorker, upsertRunLineage } from './swarm-bus.mjs';

const threadOf = (r) => r.codex_thread_id || r.thread_id || r.progress?.thread_id;
const turnOf = (r) => r.turn_id || r.progress?.turn_id;
const codexRun = (r) => (r.cli || 'codex') === 'codex';

export const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_gemini']);
export { EXEC_TIMEOUT_MIN_SEC, EXEC_TIMEOUT_MAX_SEC, validateExecTimeoutSec } from '../magpie_plugin/lib/routing.mjs';
export const UNCONFIRMED_HOLD_MS = 30 * 60 * 1000;
const STARTUP_GRACE_MS = 60_000;
const pending = (state) => state === 'queued' || state === 'running';
const workerPath = fileURLToPath(new URL('../magpie_plugin/lib/exec-worker.mjs', import.meta.url));
const waitPath = fileURLToPath(new URL('./wait.mjs', import.meta.url));
const now = () => Date.now() / 1000;
const readRetry = new Int32Array(new SharedArrayBuffer(4));
const runError = (message, status, cause) => Object.assign(new Error(message, { cause }), { status });

export function isRecentUnconfirmedRun(record, nowMs = Date.now(), modifiedAtMs = null) {
  if (!record?.remote_turn_unconfirmed || ACTIVE_STATES.has(record.state)) return false;
  const deadlineMs = Number.isFinite(record.deadline) ? record.deadline * 1000 : NaN;
  if (Number.isFinite(deadlineMs) && nowMs <= deadlineMs) return true;
  const ts = [record.unconfirmed_at, record.finished_at, record.progress?.updated_at, record.started_at, record.created_at]
    .map((v) => (typeof v === 'string' ? Date.parse(v) : (typeof v === 'number' ? v * (v < 1e12 ? 1000 : 1) : NaN)))
    .find(Number.isFinite) ?? (Number.isFinite(modifiedAtMs) ? modifiedAtMs : deadlineMs);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts <= UNCONFIRMED_HOLD_MS;
}

export function isRunOccupying(record, nowMs = Date.now(), modifiedAtMs = null) {
  return Boolean(record) && (ACTIVE_STATES.has(record.state) || isRecentUnconfirmedRun(record, nowMs, modifiedAtMs));
}

export function runDirectory(runId, sessionsDir) {
  if (typeof runId !== 'string' || !/^[a-f0-9]{32}$/.test(runId)) {
    throw runError('Invalid run_id: expected 32 lowercase hexadecimal characters.', 400);
  }
  return join(resolveSessionsDir(sessionsDir), 'runs', runId);
}

export function saveRun(file, record) {
  for (let attempt = 0; ; attempt++) {
    try {
      atomicJson(file, record);
      return;
    } catch (error) {
      if (attempt === 4 || process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(readRetry, 0, 0, 20);
    }
  }
}

// Commit final identity before exposing a terminal receipt to waiters or recovery readers.
export function saveCompletedRun(file, record, sessionsDir) {
  const result = record.result;
  const cli = result?.cli || record.cli || (record.codex_thread_id ? 'codex' : undefined);
  upsertRunLineage({ run_id: record.run_id, session_id: record.session_id, swarm_id: record.swarm_id,
    worker_name: record.swarm_agent, cli, model: result?.model || record.model,
    native_session_id: cli === 'codex' ? result?.codex_thread_id || record.codex_thread_id
      : result?.runner_session_id || record.runner_session_id,
    fork_mode: result?.fork_mode || record.fork_mode, source_cwd: record.source_cwd || record.cwd,
    worktree_path: record.worktree_path }, { sessionsDir });
  saveRun(file, record);
}

const stateCache = new Map();
const runDirectories = new Map();

function fileVersion(stat) {
  return stat && `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function loadState(path, runId, allowLegacyId) {
  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
      break;
    } catch (error) {
      if (error.code === 'ENOENT') throw runError(`Run '${runId}' not found.`, 404, error);
      if (attempt === 4 || !(error instanceof SyntaxError || ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))) throw error;
      Atomics.wait(readRetry, 0, 0, 20);
    }
  }
  const storedId = data?.run_id || (allowLegacyId ? runId : undefined);
  if (storedId !== runId || typeof data?.state !== 'string') throw new Error('Run state does not match the requested ID.');
  if (allowLegacyId && !data.run_id) data.run_id = runId;
  return data;
}

function applyTerminal(record, turn, evidence = {}) {
  record.state = turn.status === 'completed' ? 'finished' : turn.status;
  record.finished_at = Number.isFinite(turn.completedAt) ? new Date(turn.completedAt * 1000).toISOString()
    : record.finished_at || new Date().toISOString();
  record.waiting_since = record.pending_tool_call = null;
  record.progress = { ...record.progress, phase: record.state, updated_at: record.finished_at };
  if (record.state === 'finished') {
    const text = turn.items?.filter((item) => item.type === 'agentMessage').map((item) => item.text).filter(Boolean).join('\n\n')
      || evidence.text || record.result?.text || record.progress.last_message || '';
    record.result = { cli: record.cli || 'codex', model: record.model, ...record.result, session_id: record.session_id, codex_thread_id: threadOf(record), turn_id: turn.id,
      text, usage: evidence.usage ?? turn.usage ?? record.result?.usage ?? record.progress.token_usage ?? {} };
    delete record.error;
  } else {
    record.error = turn.error?.message || (record.cli || 'Codex') + ' turn ' + turn.status + '.';
  }
  delete record.remote_turn_unconfirmed;
  delete record.unconfirmed_at;
  return record;
}

export function readRun(runId, sessionsDir, { stat, readonly = false, allowLegacyId = false } = {}) {
  const path = join(runDirectory(runId, sessionsDir), 'state.json');
  stat ??= statSync(path, { throwIfNoEntry: false });
  const version = fileVersion(stat);
  const cached = stateCache.get(path);
  let data = version && cached?.version === version ? cached.data : undefined;
  data ??= loadState(path, runId, allowLegacyId);
  if (version && cached?.version !== version) {
    stateCache.delete(path);
    if (stateCache.size >= 1024) stateCache.delete(stateCache.keys().next().value);
    stateCache.set(path, { version, data });
  }
  // Reconcile time and worker liveness even when the file has not changed.
  let record = readonly ? { ...data } : structuredClone(data);
  reconcileRunState(record, () => stat?.mtimeMs, true);
  const changed = record.state !== data.state || record.remote_turn_unconfirmed !== data.remote_turn_unconfirmed;
  if (changed && !(ACTIVE_STATES.has(data.state) && pidAlive(data.pid))) {
    // Once the process is dead its final atomic rename is visible, even if the
    // caller supplied an earlier stat. Serialize competing recovery readers.
    record = withLockSync(join(dirname(path), 'reconcile.lock'), () => {
      const fresh = loadState(path, runId, allowLegacyId);
      const before = fresh.state;
      const staleCli = !codexRun(fresh) && fresh.remote_turn_unconfirmed;
      reconcileRunState(fresh, () => statSync(path).mtimeMs, true);
      if (fresh.state !== before || staleCli) {
        if (turnOf(fresh)) {
          const evidence = turnEvidence(join(dirname(path), 'events.jsonl'), threadOf(fresh), turnOf(fresh));
          if (terminalTurn(evidence.terminal)) applyTerminal(fresh, evidence.terminal, evidence);
        }
        if (fresh.state !== 'outcome_unknown') fresh.finished_at ||= new Date().toISOString();
        fresh.waiting_since = null;
        saveCompletedRun(path, fresh, sessionsDir);
      }
      return fresh;
    });
  }
  const source = recordSourceCwd(record);
  if (source) record.source_cwd = source;
  record.title = normalizeTitle(record.title, record.goal, source || record.cwd);
  return record;
}

export function reconcileRunState(record, modifiedAt, deferToWorker = false) {
  if (!codexRun(record) && record.remote_turn_unconfirmed) {
    record.state = 'failed';
    record.error = record.cli + ' worker exited without saving its result.';
    record.pending_tool_call = null;
    delete record.remote_turn_unconfirmed;
    delete record.unconfirmed_at;
  }
  if (!ACTIVE_STATES.has(record.state)) return record;
  const hasPid = Number.isInteger(record.pid) && record.pid > 0;
  const created = record.state === 'queued' && (!hasPid || record.source === 'magpie_exec') ? Date.parse(record.created_at) : null;
  if (created !== null && Date.now() - (Number.isFinite(created) ? created : modifiedAt?.() ?? Infinity) >= STARTUP_GRACE_MS) {
    return Object.assign(record, { state: 'failed', error: 'Execution worker startup timed out after 60s.',
      pending_tool_call: null });
  }
  const expired = record.state !== 'waiting_gemini' && now() > (record.deadline ?? Infinity);
  const managed = record.source === 'magpie_exec' && hasPid;
  const deadPid = managed && !pidAlive(record.pid);
  // Give a live worker time to interrupt and save at its deadline. A hung
  // process can still time out to readers, but retains ownership of its file.
  if (managed && !deadPid && deferToWorker && now() <= record.deadline + 10) return record;
  if (!expired && !deadPid) return record;
  const phase = record.progress?.phase;
  const threadId = threadOf(record);
  const turnId = turnOf(record);
  record.pending_tool_call = null;
  if (['completed', 'interrupted', 'failed'].includes(phase)) {
    return applyTerminal(record, { id: turnId, status: phase, error: { message: record.error } });
  }
  if (!codexRun(record)) {
    record.state = 'failed';
    record.error = record.cli + (deadPid ? ' worker exited without saving its result.' : ' worker timed out.');
  } else if (deadPid && !threadId && !turnId && !phase) {
    record.state = 'failed';
    record.error = 'Worker process exited before starting a turn.';
  } else if (phase === 'connecting' && !threadId && !turnId) {
    record.state = 'failed';
    record.error = deadPid ? 'Worker process exited before connecting to Codex app-server (phase: connecting).'
      : 'Worker timed out connecting to Codex app-server.';
  } else {
    record.state = 'outcome_unknown';
    if (turnId) {
      record.remote_turn_unconfirmed = true;
      // A read cannot extend the hold. Cap a copied file's mtime at the expired deadline.
      const deadlineMs = expired ? record.deadline * 1000 : Infinity;
      const fileTime = Math.min(modifiedAt?.() ?? Infinity, deadlineMs);
      record.unconfirmed_at ??= record.progress?.updated_at ?? (Number.isFinite(fileTime)
        ? new Date(fileTime).toISOString() : record.started_at ?? record.created_at);
      record.error ||= 'Remote Codex turn may still be running (worker stopped reporting).';
    }
    return record;
  }
  delete record.remote_turn_unconfirmed;
  delete record.unconfirmed_at;
  return record;
}

async function notifyRecovered(record, options) {
  if (!record.swarm_id || !record.swarm_agent) return;
  const { onWorkerTurnFinished } = await import('./swarm-engine.mjs');
  await onWorkerTurnFinished({ ...options, swarmId: record.swarm_id, swarmAgent: record.swarm_agent,
    runId: record.run_id, sessionId: record.session_id, startedAt: record.started_at,
    outcome: record, result: record.result, error: record.error, recovered: true });
}

async function settleTurn(record, turn, options, evidence) {
  const directory = runDirectory(record.run_id, options.sessionsDir);
  const path = join(directory, 'state.json');
  const updated = withLockSync(join(directory, 'reconcile.lock'), () => {
    const fresh = loadState(path, record.run_id, true);
    if ((!fresh.remote_turn_unconfirmed && !ACTIVE_STATES.has(fresh.state)) ||
        turnOf(fresh) !== turn.id || threadOf(fresh) !== threadOf(record)) return null;
    evidence ??= turn.id ? turnEvidence(join(directory, 'events.jsonl'), threadOf(record), turn.id) : {};
    applyTerminal(fresh, terminalTurn(evidence.terminal) ? { ...turn, ...evidence.terminal } : turn, evidence);
    if (options.interruptConfirmed) fresh.interrupt_confirmed_at = new Date().toISOString();
    saveCompletedRun(path, fresh, options.sessionsDir);
    return fresh;
  });
  if (updated) await notifyRecovered(updated, options);
  return readRun(record.run_id, options.sessionsDir, { allowLegacyId: true });
}

const pendingProbes = new Map();
const retryAfter = new Map();

export async function refreshRun(record, options = {}) {
  const threadId = threadOf(record), turnId = turnOf(record);
  if (!record.remote_turn_unconfirmed || !codexRun(record) || !threadId || !turnId) return record;
  const directory = runDirectory(record.run_id, options.sessionsDir);
  if (pendingProbes.has(directory)) return pendingProbes.get(directory);
  if (Date.now() < (retryAfter.get(directory) || 0)) return record;
  const probe = async () => {
    const evidence = turnEvidence(join(directory, 'events.jsonl'), threadId, turnId);
    let turn = evidence.terminal;
    if (!terminalTurn(turn)) {
      let client;
      try {
        const state = readAppServerState(record.config_path || options.configPath, options.env);
        client = await connectAppServer(state);
        turn = await readServerTurn(client, threadId, turnId);
      } catch { /* Older or unavailable servers cannot confirm this turn. */ }
      finally { client?.close(); }
    }
    if (terminalTurn(turn)) return settleTurn(record, turn, options, evidence);
    if (retryAfter.size >= 512) retryAfter.delete(retryAfter.keys().next().value);
    retryAfter.set(directory, Date.now() + 2000);
    return readRun(record.run_id, options.sessionsDir, { allowLegacyId: true });
  };
  pendingProbes.set(directory, probe());
  try { return await pendingProbes.get(directory); }
  finally { pendingProbes.delete(directory); }
}

function normalizeRunIds(runIds) {
  const ids = [...new Set((typeof runIds === 'string' ? runIds.split(',') : runIds)
    .filter((id) => typeof id === 'string').map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error('At least one run_id is required.');
  for (const id of ids) runDirectory(id);
  return ids;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function formatWaitInvocation(args, env = process.env) {
  const shims = process.platform === 'win32' ? ['gempt-wait.cmd', 'gempt-wait.exe', 'gempt-wait'] : ['gempt-wait'];
  const onPath = (env.PATH || env.Path || '').split(delimiter).filter(Boolean).some((dir) =>
    shims.some((shim) => executable(join(dir, shim))));
  if (onPath && !['1', 'true', 'yes'].includes(env.GEMPT_DISABLE_WAIT_SHIM?.trim())) return `gempt-wait ${args}`;
  const nodeBin = resolveNodeExecutable({ env });
  if (process.platform === 'win32') {
    const shell = String(env.GEMPT_SHELL || '').trim().toLowerCase();
    if (shell === 'cmd') {
      const q = (text) => `"${text.replaceAll('"', '""')}"`;
      return `${q(nodeBin)} ${q(waitPath)} ${args}`;
    }
    const q = (text) => `'${text.replaceAll("'", "''")}'`;
    return `& ${q(nodeBin)} ${q(waitPath)} ${args}`;
  }
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  return `${quote(nodeBin)} ${quote(waitPath)} ${args}`;
}

export function buildWaitCommand(runIds, { waitAll = false, env = process.env } = {}) {
  const ids = normalizeRunIds(Array.isArray(runIds) ? runIds : String(runIds));
  const args = `${waitAll ? '--all ' : ''}${ids.join(',')}`;
  return formatWaitInvocation(args, env);
}

export function buildBoardWaitCommand(swarmId, { since = 0, mentionsOnly = true, env = process.env } = {}) {
  const cleanId = String(swarmId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(cleanId)) {
    throw new Error(`Invalid swarm_id '${swarmId}'.`);
  }
  const parts = ['--board', cleanId];
  const after = Math.max(0, Math.trunc(Number(since) || 0));
  if (after > 0) parts.push('--since', String(after));
  if (mentionsOnly === false) parts.push('--all-messages');
  return formatWaitInvocation(parts.join(' '), env);
}

export async function waitForRuns(runIds, { waitAll = false, timeoutSec, sessionsDir, env, configPath, pollInterval = 0.25 } = {}) {
  const ids = normalizeRunIds(runIds);
  if (timeoutSec != null && !Number.isFinite(timeoutSec) && timeoutSec !== Infinity) throw new Error('Invalid wait timeout.');
  const deadline = timeoutSec == null ? Infinity : performance.now() + timeoutSec * 1000;
  while (true) {
    const runs = Object.fromEntries(await Promise.all(ids.map(async (id) =>
      [id, await refreshRun(readRun(id, sessionsDir), { sessionsDir, env, configPath })])));
    const active = ids.filter((id) => pending(runs[id].state));
    const ready = ids.filter((id) => !pending(runs[id].state));
    const remaining = deadline - performance.now();
    if ((waitAll ? !active.length : ready.length) || remaining <= 0) return { ready, active, runs };
    await sleep(Math.min(pollInterval * 1000, remaining));
  }
}

export async function waitForRun(runId, opts) {
  runDirectory(runId, opts?.sessionsDir);
  return (await waitForRuns([runId], opts)).runs[runId];
}

export function compactReceiptText(text, sessionId) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= 3200) return chars.join('');
  const ref = sessionId ? `session_id=${sessionId} / GemPT` : 'GemPT';
  return `${chars.slice(0, 2176).join('').trimEnd()}\n\n...[omitted ${chars.length - 3080} chars; full output in ${ref}]...\n\n${chars.slice(-904).join('').trimStart()}`;
}

async function controlRun(runId, method, message, {
  configPath, sessionsDir, env = process.env, getState, connect = connectAppServer, confirmMs = 500,
} = {}) {
  const record = readRun(runId, sessionsDir);
  const threadId = threadOf(record);
  const turnId = turnOf(record);
  const isInterrupt = method === 'turn/interrupt';
  const isActive = ['running', 'waiting_gemini'].includes(record.state);
  const isUnconfirmed = Boolean(record.remote_turn_unconfirmed);
  const cli = String(record.cli || 'codex').trim().toLowerCase() || 'codex';
  if (cli !== 'codex') {
    const { getRunner } = await import('./runners/registry.mjs');
    const runner = getRunner(cli);
    const runDir = runDirectory(runId, sessionsDir);
    if (isInterrupt) {
      if (!isActive && !isUnconfirmed) throw runError(`Run ${runId} has no active ${cli} turn.`, 409);
      if (runner?.interrupt) {
        return runner.interrupt(record, { runDir, configPath, sessionsDir, env });
      }
      throw runError(`Runner '${cli}' does not support interrupt.`, 409);
    }
    if (!isActive) throw runError(`Run ${runId} has no active ${cli} turn.`, 409);
    if (runner?.steer) {
      return runner.steer(record, message, { runDir, configPath, sessionsDir, env });
    }
    throw runError(`CLI '${cli}' does not support mid-turn steer; message will be delivered on the next turn.`, 409);
  }
  async function confirmInterrupt(turn, note) {
    await settleTurn(record, turn, { sessionsDir, configPath, env, interruptConfirmed: true });
    return { ok: true, run_id: runId, session_id: record.session_id, thread_id: threadId ?? null,
      turn_id: turnId ?? null, cleared_unconfirmed: true, ...(note ? { note } : {}) };
  }
  if (isInterrupt && isUnconfirmed && (!threadId || !turnId)) {
    return confirmInterrupt({ id: turnId, status: 'failed', error: { message: 'Worker stopped without a remote turn identity.' } });
  }
  if ((!isActive && !(isInterrupt && isUnconfirmed)) || !threadId || !turnId) {
    throw runError(`Run ${runId} has no active Codex turn.`, 409);
  }
  let client;
  let observedTerminal;
  let resolveTerminal;
  const onEvent = isInterrupt ? ({ method: evMethod, params: event }) => {
    if (evMethod === 'turn/completed' && event?.threadId === threadId && event.turn?.id === turnId) {
      observedTerminal = event.turn;
      resolveTerminal?.(observedTerminal);
    }
  } : undefined;
  try {
    const state = getState ? getState() : readAppServerState(configPath || record.config_path, env);
    if (state?.status !== 'running') throw new Error(UNAVAILABLE);
    client = await connect(state, onEvent);
  } catch (error) {
    throw runError(error.message, 503, error);
  }
  let note;
  try {
    const params = method === 'turn/steer'
      ? { threadId, expectedTurnId: turnId, input: textInput(message) } : { threadId, turnId };
    try {
      await client.request(method, params);
    } catch (error) {
      if (isInterrupt && !client.disconnected && TERMINAL_INTERRUPT_ERR.test(String(error?.message || ''))) {
        note = String(error.message);
      } else if (!observedTerminal) {
        throw error;
      }
    }
    if (isInterrupt && isUnconfirmed && !observedTerminal && !note && confirmMs > 0 && !client.disconnected) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { resolveTerminal = undefined; resolve(); }, confirmMs);
        resolveTerminal = () => { clearTimeout(timer); resolveTerminal = undefined; resolve(); };
        client.onFailure?.(() => { clearTimeout(timer); resolveTerminal = undefined; resolve(); });
      });
    }
    if (isInterrupt && (note || isUnconfirmed) && !terminalTurn(observedTerminal)) {
      try {
        const snapshot = await readServerTurn(client, threadId, turnId);
        observedTerminal ??= snapshot;
      } catch { /* Use explicit interrupt evidence. */ }
    }
  } finally {
    client.close();
  }
  if (isInterrupt && terminalTurn(observedTerminal) && (isUnconfirmed || note || !pidAlive(record.pid))) {
    return confirmInterrupt(observedTerminal, note);
  }
  if (isInterrupt && note && !observedTerminal) {
    return confirmInterrupt({ id: turnId, status: 'failed', error: { message: note } }, note);
  }
  return { ok: true, run_id: runId, session_id: record.session_id, thread_id: threadId, turn_id: turnId };
}

export async function steerRun(runId, message, opts) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Steering message must be non-empty.');
  return controlRun(runId, 'turn/steer', message, opts);
}

export function interruptRun(runId, opts) {
  return controlRun(runId, 'turn/interrupt', undefined, opts);
}

export function toolReplyPath(directory, callId) {
  if (typeof callId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(callId)) throw new Error('Invalid tool call_id.');
  return join(directory, 'tool_replies', `${callId}.json`);
}

export function replyToolCall(runId, callId, answer, { success = true, sessionsDir } = {}) {
  const path = toolReplyPath(runDirectory(runId, sessionsDir), callId);
  if (typeof answer !== 'string' || typeof success !== 'boolean') {
    throw new Error('Tool reply requires a text answer and boolean success.');
  }
  const record = readRun(runId, sessionsDir);
  if (record.state !== 'waiting_gemini' || record.pending_tool_call?.call_id !== callId) {
    throw new Error(`Run ${runId} is not waiting for tool call ${callId}.`);
  }
  try {
    atomicJson(path, { answer, success }, { exclusive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = JSON.parse(readFileSync(path, 'utf8'));
    if (prior.answer !== answer || prior.success !== success || Object.keys(prior).length !== 2) {
      throw new Error('A different reply was already submitted for this tool call.');
    }
  }
  return { ok: true, run_id: runId, session_id: record.session_id, call_id: callId };
}

export function stateEntries(sessionsDir) {
  const parent = join(resolveSessionsDir(sessionsDir), 'runs');
  const parentStat = statSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory()) {
    runDirectories.delete(parent);
    return [];
  }
  const version = `${fileVersion(parentStat)}:${parentStat.nlink}`;
  const checkedAt = performance.now();
  let index = runDirectories.get(parent);
  // Some filesystems coalesce rapid directory updates. The link count tracks
  // subdirectory additions on Unix, and the timed rescan covers other cases.
  if (index?.version !== version || checkedAt - index.checkedAt >= 1000) {
    const ids = readdirSync(parent, { withFileTypes: true })
      .filter((dir) => dir.isDirectory() && /^[a-f0-9]{32}$/.test(dir.name))
      .map((dir) => dir.name);
    index = { version, checkedAt, ids, signature: null, entries: [] };
    if (!runDirectories.has(parent) && runDirectories.size >= 32) {
      runDirectories.delete(runDirectories.keys().next().value);
    }
    runDirectories.set(parent, index);
  }
  // Workers publish state atomically inside each run directory. The parent
  // signature only tracks additions/removals, so stat the known state files.
  const files = index.ids.map((id) => statSync(join(parent, id, 'state.json'), { throwIfNoEntry: false }));
  const signature = files.map(fileVersion).join('|');
  if (signature !== index.signature) {
    index.signature = signature;
    index.entries = index.ids.flatMap((id, i) => files[i]?.isFile()
      ? [{ id, mtime: files[i].mtimeMs, stat: files[i] }] : [])
      .sort((left, right) => right.mtime - left.mtime);
  }
  return index.entries;
}

export function runWithinRoot(record, root) {
  return !root || recordInWorkspace(record, [resolvePath(root)]);
}

export function listActiveRoster({ limit = 20, root, hostConversationId, sessionId, sessionsDir, includeUnconfirmed = true } = {}) {
  const roster = [];
  const workspace = root && resolvePath(root);
  const foldSession = (id) => process.platform === 'win32' ? id?.toLowerCase() : id;
  const sessionKey = foldSession(sessionId);
  const nowMs = Date.now();
  for (const { id, mtime, stat } of stateEntries(sessionsDir)) {
    if (roster.length >= limit) break;
    let record;
    try { record = readRun(id, sessionsDir, { stat, readonly: true }); } catch { continue; }
    const active = includeUnconfirmed ? isRunOccupying(record, nowMs, mtime) : ACTIVE_STATES.has(record.state);
    if (!active || !runWithinRoot(record, workspace)
        || (hostConversationId && record.host_conversation_id !== hostConversationId)
        || (sessionKey && (typeof record.session_id !== 'string' || foldSession(record.session_id) !== sessionKey))) continue;
    const { run_id, session_id, title, state, model, cwd, worktree_path, source_cwd, host_conversation_id, progress, pending_tool_call,
      remote_turn_unconfirmed } = record;
    roster.push({ run_id, session_id, title, state, model: model ?? null, cwd, worktree_path: worktree_path ?? null,
      source_cwd: source_cwd ?? null, host_conversation_id: host_conversation_id ?? null, phase: progress?.phase ?? null,
      last_message: (progress?.last_message || '').slice(-240), pending_tool_call: pending_tool_call ?? null,
      remote_turn_unconfirmed: Boolean(remote_turn_unconfirmed) });
  }
  return roster;
}

export async function dispatchRun(args, {
  env = process.env, configPath = args.config_path, sessionsDir, magpieConfigDir, agent,
  probeTimeoutMs, waitSec = args.wait_sec, legacyNative = false, swarmFork, swarmWake,
} = {}) {
  if (typeof args.goal !== 'string' || !args.goal.trim()) throw new Error('goal is required and must be a non-empty string.');
  const workspace = args.workspace || 'inherit';
  if (!['inherit', 'share'].includes(workspace)) throw new Error(`Invalid workspace: ${workspace}`);
  const isReadOnly = args.access === 'inspect' || args.sandbox === 'read-only';
  if (workspace === 'share' && isReadOnly) {
    throw runError("workspace='share' is not allowed with read-only access ('inspect'); use workspace='inherit' for read-only inspection.", 400);
  }
  const timeoutSec = validateExecTimeoutSec(args.timeout_sec);
  const config = resolveConfigPath(configPath || env.GEMPT_CONFIG);
  const sessions = resolveSessionsDir(sessionsDir || env.GEMPT_SESSIONS_DIR);
  const { normalizeWorkspaceCwd } = await import('../magpie_plugin/lib/tools.mjs');
  const requestedCwd = normalizeWorkspaceCwd(args.cwd, { configPath: config, magpieConfigDir, env });
  const id = args.run_id || randomUUID().replaceAll('-', '');
  const directory = runDirectory(id, sessions);
  const file = join(directory, 'state.json');
  const sessionId = args.session_id ? validateSessionId(args.session_id) : `exec-${randomUUID()}`;
  let hostContext;
  let hostId;
  const deadline = waitSec == null ? Infinity : performance.now() + waitSec * 1000;
  mkdirSync(join(sessions, 'runs'), { recursive: true });
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!legacyNative) throw new Error(`Run ${id} already exists; query its status.`);
    for (let attempt = 0; ; attempt++) {
      try {
        const record = readRun(id, sessions);
        const originalCwd = record.worktree_path ? record.source_cwd || record.cwd : record.cwd;
        if (record.source !== 'magpie_exec' || originalCwd !== requestedCwd) {
          throw new Error('run_id belongs to a different workspace.');
        }
        return record;
      } catch (err) {
        if (err.cause?.code !== 'ENOENT' || attempt === 10) throw err;
        await sleep(50);
      }
    }
  }
  let cwd = requestedCwd;
  let sourceCwd = requestedCwd;
  let worktreePath = null;
  let record;
  try {
    if (args.session_id) {
      const [prior] = listActiveRoster({ limit: 1, sessionId, sessionsDir: sessions });
      if (prior?.remote_turn_unconfirmed) await refreshRun(readRun(prior.run_id, sessions), { sessionsDir: sessions, configPath: config, env });
    }
    await withLock(join(sessions, `${sessionId}.dispatch.lock`), async () => {
      if (args.session_id) {
        const [busy] = listActiveRoster({ limit: 1, sessionId, sessionsDir: sessions, includeUnconfirmed: true });
        if (busy) {
          const detail = busy.remote_turn_unconfirmed
            ? `Session '${sessionId}' has an unconfirmed remote turn (${busy.run_id}); run gpt_ctl(action='interrupt', run_id='${busy.run_id}') to confirm/clear it, or omit session_id to start a new thread.`
            : `Session '${sessionId}' already has an active run (${busy.run_id}); wait for it to finish, steer it, or omit session_id to start a new thread.`;
          throw runError(detail, 409);
        }
      }
      const prior = args.session_id && readJsonSafe(join(sessions, `${sessionId}.json`));
      if (prior?.worktree_path && statSync(prior.worktree_path, { throwIfNoEntry: false })?.isDirectory()) {
        sourceCwd = resolvePath(prior.source_cwd || requestedCwd);
        cwd = resolvePath(prior.cwd || prior.worktree_path);
        worktreePath = resolvePath(prior.worktree_path);
        if ((!samePath(requestedCwd, sourceCwd) && !samePath(requestedCwd, cwd)) || !withinPath(cwd, worktreePath)) {
          throw new Error(`Exec resume must stay in the original workspace '${sourceCwd}'.`);
        }
      } else if (workspace === 'share') {
        ({ cwd, source_cwd: sourceCwd, worktree_root: worktreePath } = ensureShareWorktree(cwd, sessionId, env));
      } else {
        sourceCwd = resolveExternalWorktreeSourceCwd(cwd) || cwd;
      }
      hostContext = readHostContext(config, sourceCwd);
      hostId = args.host_conversation_id?.trim() || prior?.host_conversation_id || hostContext.conversation_id || null;
      const cfg = readJsonSafe(config);
      const executionTimeout = resolveExecTimeoutSec({ codex: cfg?.codex, timeoutSec, effort: getMcpEffort(cfg?.routing_policy) });
      record = {
        source: 'magpie_exec', run_id: id, cwd, state: 'queued', created_at: new Date().toISOString(),
        worktree_path: worktreePath, source_cwd: worktreePath || sourceCwd !== cwd ? sourceCwd : null, goal: args.goal,
        title: normalizeTitle(args.title, args.goal, sourceCwd), tier: args.tier, agent,
        host_conversation_id: hostId, session_id: sessionId, config_path: config, progress: null,
        verification: args.verification, execution_timeout_sec: executionTimeout, deadline: now() + executionTimeout,
        ...(args.swarm_id ? { swarm_id: String(args.swarm_id) } : {}),
        ...(args.swarm_agent ? { swarm_agent: String(args.swarm_agent) } : {}),
        ...(swarmFork ? { fork_mode: 'summary_fallback' } : {}),
        ...(args.cli ? { cli: String(args.cli) } : {}),
        ...(args.model ? { model: String(args.model) } : {}),
      };
      if (!legacyNative && hostId && !args.swarm_id && !args.swarm_agent) {
        record.swarm_id = resolveImplicitSwarmId(hostId);
        record.swarm_agent = soloWorkerName(sessionId);
        record.implicit_swarm_worker = true;
      }
      upsertRunLineage({ run_id: id, session_id: prior?.session_id || sessionId, swarm_id: record.swarm_id,
        worker_name: record.swarm_agent, parent_run_id: swarmFork?.parentRunId,
        parent_worker: swarmFork?.parentWorker, parent_native_session_id: swarmFork?.source?.id, parent_cli: swarmFork?.source?.cli,
        cli: args.cli || prior?.cli || getExecutionConfig(cfg).default_cli,
        model: args.model || prior?.model, worktree_path: worktreePath, source_cwd: sourceCwd,
        created_at: record.created_at, fork_mode: record.fork_mode }, { sessionsDir: sessions });
      saveRun(file, record);
      if (record.implicit_swarm_worker) {
        await upsertWorker(record.swarm_id, {
          name: record.swarm_agent, run_id: id, session_id: sessionId, state: 'working',
          cli: args.cli || prior?.cli || getExecutionConfig(cfg).default_cli,
          model: args.model || prior?.model || null, tier: args.tier || prior?.tier || null,
          access: isReadOnly ? 'inspect' : 'change', workspace: worktreePath ? 'share' : workspace,
          worktree_path: worktreePath, source_cwd: sourceCwd, brief: args.goal, task_summary: args.goal.slice(0, 120),
          error: null, parked_on: null,
        }, { sessionsDir: sessions, hostConversationId: hostId.trim(), cwd: sourceCwd });
      }
    }, { attempts: 80, delayMs: 25 });
  } catch (error) {
    if (record?.implicit_swarm_worker && existsSync(file)) {
      saveRun(file, { ...record, state: 'failed', error: error.message, finished_at: new Date().toISOString() });
    }
    try { rmdirSync(directory); } catch { /* The claim may already contain state. */ }
    throw error;
  }
  const host = { configPath: config, sessionsDir: sessions, magpieConfigDir, options: { exec: true },
    probeTimeoutMs, swarmFork, swarmWake, allowSandboxUpgrade: !legacyNative, worktreePath, sourceCwd,
    ...(args.swarm_id ? { swarmId: String(args.swarm_id) } : {}),
    ...(args.swarm_agent ? { swarmAgent: String(args.swarm_agent) } : {}) };
  const request = { ...args, cwd, session_id: args.session_id ? sessionId : undefined,
    ...(timeoutSec !== undefined ? { timeout_sec: timeoutSec } : {}),
    host_conversation_id: hostId, gemini_family: args.gemini_family || hostContext.gemini_family };
  const launchEnv = { ...env };
  if (args.swarm_id) {
    launchEnv.GEMPT_SWARM_ID = String(args.swarm_id);
    if (args.swarm_agent) launchEnv.GEMPT_AGENT_NAME = String(args.swarm_agent);
    launchEnv.GEMPT_SESSIONS_DIR = sessions;
  } else if (record.implicit_swarm_worker) {
    delete launchEnv.GEMPT_SWARM_ID;
    delete launchEnv.GEMPT_AGENT_NAME;
  }
  const packetPath = join(directory, 'dispatch.json');
  try {
    atomicJson(packetPath, { file, record, args: request, host, agent });
    const child = await launchDetached(resolveNodeExecutable({ env }), [workerPath, '--packet', packetPath], {
      cwd: process.cwd(), env: launchEnv, windowsHide: true, detached: true, stdio: 'ignore',
    });
    if (!child.pid) await once(child, 'spawn');
    child.unref?.();
    record.pid = child.pid;
    // The worker may already have published a newer state while CIM returned its PID.
    await withLock(join(sessions, sessionId + '.dispatch.lock'), () => {
      const latest = readJsonSafe(file);
      if (latest?.state === 'queued') saveRun(file, { ...latest, pid: child.pid });
      else if (latest) record = latest;
    }, { attempts: 80, delayMs: 25 });
  } catch (error) {
    if (record.pid) throw error;
    rmSync(packetPath, { force: true });
    const failed = { ...record, state: 'failed', error: error.message, finished_at: new Date().toISOString() };
    saveRun(file, failed);
    if (record.implicit_swarm_worker) await notifyRecovered(failed, { sessionsDir: sessions });
    throw error;
  }
  if (args.background === true) return record;
  const result = await waitForRun(id, { sessionsDir: sessions, timeoutSec: Math.max(0, deadline - performance.now()) / 1000 });
  if (legacyNative || ACTIVE_STATES.has(result.state) || result.state === 'interrupted') return result;
  if (!result.result) throw new Error(`${id}: ${result.error || result.state}`);
  return { ...result.result, run_id: id, state: 'finished', execution_timeout_sec: result.execution_timeout_sec };
}

export async function tryDelegateDispatch(args, {
  env = process.env, configPath = args?.config_path, sessionsDir, magpieConfigDir, agent, waitSec = args?.wait_sec,
} = {}) {
  if (String(env?.GEMPT_DISABLE_IPC_DISPATCH || '').trim() === '1') return null;
  const resolvedConfig = resolveConfigPath(configPath || env?.GEMPT_CONFIG);
  const configDir = dirname(resolvedConfig);
  if (!existsSync(configDir)) return null;
  let candidates = [];
  try {
    candidates = readdirSync(configDir)
      .filter((name) => /^page-server-\d+\.ipc$/.test(name))
      .map((name) => {
        const full = join(configDir, name);
        const st = statSync(full, { throwIfNoEntry: false });
        return { full, mtimeMs: st?.mtimeMs || 0 };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  const timeoutMs = Math.max(5000, ((Number(waitSec) || 0) + 15) * 1000);
  const resolvedSessions = sessionsDir || env?.GEMPT_SESSIONS_DIR
    ? resolveSessionsDir(sessionsDir || env?.GEMPT_SESSIONS_DIR) : undefined;
  for (const { full } of candidates) {
    const rec = readJsonSafe(full);
    if (!rec || rec.service !== 'gempt-magpie-plugin'
        || !Number.isInteger(rec.port) || rec.port < 1 || rec.port > 65535
        || typeof rec.token !== 'string' || !rec.token
        || !pidAlive(rec.pid)) {
      continue;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${rec.port}/api/internal/dispatch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gempt-ipc-token': rec.token,
        },
        body: JSON.stringify({
          args,
          options: {
            configPath: resolvedConfig,
            ...(resolvedSessions ? { sessionsDir: resolvedSessions } : {}),
            ...(magpieConfigDir ? { magpieConfigDir } : {}),
            ...(agent ? { agent } : {}),
            ...(waitSec !== undefined ? { waitSec } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.ok && payload.run) return payload.run;
        continue;
      }
      if ([400, 409, 422].includes(response.status)) {
        let message = `Resident dispatch failed with HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) message = String(errBody.error);
        } catch { /* ignore */ }
        throw runError(message, response.status);
      }
    } catch (error) {
      if (error?.status && [400, 409, 422].includes(error.status)) throw error;
    }
  }
  return null;
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectAppServer, readAppServerState, textInput, UNAVAILABLE } from '../magpie_plugin/lib/app-server-client.mjs';
import { normalizeTitle, readJsonSafe, resolveConfigPath, resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { readHostContext } from './host-context.mjs';
import { atomicJson, resolvePath, validateSessionId, withinPath } from './state.mjs';
import { ensureShareWorktree } from './worktrees.mjs';

export const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_gemini']);
const pending = (state) => state === 'queued' || state === 'running';
const workerPath = fileURLToPath(new URL('../magpie_plugin/lib/exec-worker.mjs', import.meta.url));
const waitPath = fileURLToPath(new URL('./wait.mjs', import.meta.url));
const now = () => Date.now() / 1000;
const readRetry = new Int32Array(new SharedArrayBuffer(4));
const runError = (message, status, cause) => Object.assign(new Error(message, { cause }), { status });

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

export function readRun(runId, sessionsDir) {
  const path = join(runDirectory(runId, sessionsDir), 'state.json');
  let record;
  for (let attempt = 0; ; attempt++) {
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
      break;
    } catch (error) {
      if (error.code === 'ENOENT') throw runError(`Run '${runId}' not found.`, 404, error);
      if (attempt === 4 || !(error instanceof SyntaxError || ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))) throw error;
      Atomics.wait(readRetry, 0, 0, 20);
    }
  }
  if (record?.run_id !== runId || typeof record.state !== 'string') throw new Error('Run state does not match the requested ID.');
  if (ACTIVE_STATES.has(record.state)) {
    let expired = now() > (record.deadline ?? Infinity);
    if (!expired && record.source === 'magpie_exec' && Number.isInteger(record.pid) && record.pid > 0) {
      try { process.kill(record.pid, 0); } catch (error) { expired = error.code === 'ESRCH'; }
    }
    if (expired) Object.assign(record, { state: 'outcome_unknown', pending_tool_call: null });
  }
  record.title = normalizeTitle(record.title, record.goal, record.source_cwd || record.cwd);
  return record;
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

export function buildWaitCommand(runIds, { waitAll = false, env = process.env } = {}) {
  const ids = normalizeRunIds(Array.isArray(runIds) ? runIds : String(runIds));
  const args = `${waitAll ? '--all ' : ''}${ids.join(',')}`;
  const shims = process.platform === 'win32' ? ['gempt-wait.cmd', 'gempt-wait.exe', 'gempt-wait'] : ['gempt-wait'];
  const onPath = (env.PATH || env.Path || '').split(delimiter).filter(Boolean).some((dir) =>
    shims.some((shim) => executable(join(dir, shim))));
  if (onPath && !['1', 'true', 'yes'].includes(env.GEMPT_DISABLE_WAIT_SHIM?.trim())) return `gempt-wait ${args}`;
  const quote = process.platform === 'win32' ? (text) => `'${text.replaceAll("'", "''")}'`
    : (text) => `'${text.replaceAll("'", "'\\''")}'`;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(waitPath)} ${args}`;
}

export async function waitForRuns(runIds, { waitAll = false, timeoutSec, sessionsDir, pollInterval = 0.25 } = {}) {
  const ids = normalizeRunIds(runIds);
  if (timeoutSec != null && !Number.isFinite(timeoutSec) && timeoutSec !== Infinity) throw new Error('Invalid wait timeout.');
  const deadline = timeoutSec == null ? Infinity : performance.now() + timeoutSec * 1000;
  while (true) {
    const runs = Object.fromEntries(ids.map((id) => [id, readRun(id, sessionsDir)]));
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
  const ref = sessionId ? `session_id=${sessionId} / GemPT Live` : 'GemPT Live';
  return `${chars.slice(0, 2176).join('').trimEnd()}\n\n...[omitted ${chars.length - 3080} chars; full output in ${ref}]...\n\n${chars.slice(-904).join('').trimStart()}`;
}

async function controlRun(runId, method, message, {
  configPath, sessionsDir, env = process.env, getState, connect = connectAppServer,
} = {}) {
  const record = readRun(runId, sessionsDir);
  const { codex_thread_id: threadId, turn_id: turnId } = record;
  if (!['running', 'waiting_gemini'].includes(record.state) || !threadId || !turnId) {
    throw runError(`Run ${runId} has no active Codex turn.`, 409);
  }
  let client;
  try {
    const state = getState ? getState() : readAppServerState(configPath || record.config_path, env);
    if (state?.status !== 'running') throw new Error(UNAVAILABLE);
    client = await connect(state);
  } catch (error) {
    throw runError(error.message, 503, error);
  }
  try {
    const params = method === 'turn/steer'
      ? { threadId, expectedTurnId: turnId, input: textInput(message) } : { threadId, turnId };
    await client.request(method, params);
  } finally {
    client.close();
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
  let dirs;
  try { dirs = readdirSync(parent, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return dirs.filter((dir) => dir.isDirectory() && /^[a-f0-9]{32}$/.test(dir.name)).flatMap(({ name }) => {
    const stat = statSync(join(parent, name, 'state.json'), { throwIfNoEntry: false });
    return stat?.isFile() ? [{ id: name, mtime: stat.mtimeMs }] : [];
  }).sort((left, right) => right.mtime - left.mtime);
}

export function runWithinRoot(record, root) {
  const cwd = record.source_cwd || record.cwd;
  return !root || (typeof cwd === 'string' && withinPath(resolvePath(cwd), root));
}

export function listActiveRoster({ limit = 20, root, hostConversationId, sessionsDir } = {}) {
  const roster = [];
  const workspace = root && resolvePath(root);
  for (const { id } of stateEntries(sessionsDir)) {
    if (roster.length >= limit) break;
    let record;
    try { record = readRun(id, sessionsDir); } catch { continue; }
    if (!ACTIVE_STATES.has(record.state) || !runWithinRoot(record, workspace)
        || (hostConversationId && record.host_conversation_id !== hostConversationId)) continue;
    const { run_id, session_id, title, state, model, cwd, worktree_path, source_cwd, host_conversation_id, progress, pending_tool_call } = record;
    roster.push({ run_id, session_id, title, state, model: model ?? null, cwd, worktree_path: worktree_path ?? null,
      source_cwd: source_cwd ?? null, host_conversation_id: host_conversation_id ?? null, phase: progress?.phase ?? null,
      last_message: (progress?.last_message || '').slice(-240), pending_tool_call: pending_tool_call ?? null });
  }
  return roster;
}

export async function dispatchRun(args, {
  env = process.env, configPath = args.config_path, sessionsDir, magpieConfigDir, agent,
  probeTimeoutMs, waitSec = args.wait_sec, legacyNative = false,
} = {}) {
  if (typeof args.goal !== 'string' || !args.goal.trim()) throw new Error('goal is required and must be a non-empty string.');
  const workspace = args.workspace || 'inherit';
  if (!['inherit', 'share'].includes(workspace)) throw new Error(`Invalid workspace: ${workspace}`);
  const config = resolveConfigPath(configPath || env.GEMPT_CONFIG);
  const sessions = resolveSessionsDir(sessionsDir || env.GEMPT_SESSIONS_DIR);
  const { normalizeWorkspaceCwd } = await import('../magpie_plugin/lib/tools.mjs');
  const requestedCwd = normalizeWorkspaceCwd(args.cwd, { configPath: config, magpieConfigDir, env });
  const id = args.run_id || randomUUID().replaceAll('-', '');
  const directory = runDirectory(id, sessions);
  const file = join(directory, 'state.json');
  const sessionId = args.session_id ? validateSessionId(args.session_id) : `exec-${randomUUID()}`;
  const prior = args.session_id && readJsonSafe(join(sessions, `${sessionId}.json`));
  const hostContext = readHostContext(config);
  const hostId = args.host_conversation_id || prior?.host_conversation_id || hostContext.conversation_id || null;
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
        if (record.source !== 'magpie_exec' || (record.source_cwd || record.cwd) !== requestedCwd) {
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
    if (prior?.worktree_path && statSync(prior.worktree_path, { throwIfNoEntry: false })?.isDirectory()) {
      sourceCwd = resolvePath(prior.source_cwd || requestedCwd);
      cwd = resolvePath(prior.cwd || prior.worktree_path);
      worktreePath = resolvePath(prior.worktree_path);
      if ((requestedCwd !== sourceCwd && requestedCwd !== cwd) || !withinPath(cwd, worktreePath)) {
        throw new Error(`Exec resume must stay in the original workspace '${sourceCwd}'.`);
      }
    } else if (workspace === 'share') {
      ({ cwd, source_cwd: sourceCwd, worktree_root: worktreePath } = ensureShareWorktree(cwd, sessionId, env));
    }
    record = {
      source: 'magpie_exec', run_id: id, cwd, state: 'queued', created_at: new Date().toISOString(),
      worktree_path: worktreePath, source_cwd: worktreePath ? sourceCwd : null, goal: args.goal,
      title: normalizeTitle(args.title, args.goal, sourceCwd), tier: args.tier, agent,
      host_conversation_id: hostId, session_id: sessionId, config_path: config, progress: null,
      verification: args.verification, deadline: now() + 900 + (Number(args.timeout_sec) || 3600),
    };
    saveRun(file, record);
  } catch (error) {
    try { rmdirSync(directory); } catch { /* The claim may already contain state. */ }
    throw error;
  }
  const host = { configPath: config, sessionsDir: sessions, magpieConfigDir, options: { exec: true },
    probeTimeoutMs, allowSandboxUpgrade: !legacyNative, worktreePath, sourceCwd };
  const request = { ...args, cwd, session_id: args.session_id ? sessionId : undefined,
    host_conversation_id: hostId, gemini_family: args.gemini_family || hostContext.gemini_family };
  try {
    const child = spawn(process.execPath, [workerPath], {
      env, windowsHide: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    const packet = JSON.stringify({ file, record, args: request, host, agent });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('spawn', () => child.stdin.end(packet, resolve));
    });
    child.unref();
  } catch (error) {
    saveRun(file, { ...record, state: 'failed', error: error.message, finished_at: new Date().toISOString() });
    throw error;
  }
  if (args.background === true) return record;
  const result = await waitForRun(id, { sessionsDir: sessions, timeoutSec: Math.max(0, deadline - performance.now()) / 1000 });
  if (legacyNative || ACTIVE_STATES.has(result.state) || result.state === 'interrupted') return result;
  if (!result.result) throw new Error(`${id}: ${result.error || result.state}`);
  return { ...result.result, run_id: id, state: 'finished' };
}

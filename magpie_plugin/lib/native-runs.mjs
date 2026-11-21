import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { normalizeTitle, writeConfigAtomic } from './backend.mjs';

const workerPath = fileURLToPath(new URL('./exec-worker.mjs', import.meta.url));
const pending = (state) => state === 'queued' || state === 'running';
const active = (state) => pending(state) || state === 'waiting_gemini';

function stateFile(sessionsDir, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid run_id.');
  return join(sessionsDir, 'runs', id, 'state.json');
}

export function saveNativeRun(file, record) {
  const saved = writeConfigAtomic(file, record);
  if (!saved.ok) throw new Error(saved.error);
}

export function readNativeRun(sessionsDir, id) {
  const record = JSON.parse(readFileSync(stateFile(sessionsDir, id), 'utf8'));
  if (record.source !== 'magpie_exec') throw new Error('Not a Magpie native exec run.');
  record.title = normalizeTitle(record.title, record.goal, record.cwd);
  if (active(record.state)) {
    if (Date.now() / 1000 > record.deadline) record.state = 'outcome_unknown';
    else if (record.pid) {
      try { process.kill(record.pid, 0); } catch (err) {
        if (err.code === 'ESRCH') record.state = 'outcome_unknown';
      }
    }
  }
  return record;
}

export async function waitForNativeRun(sessionsDir, id, seconds) {
  const until = Date.now() + Math.min(20, Math.max(0, Number(seconds) || 0)) * 1000;
  let record = readNativeRun(sessionsDir, id);
  while (pending(record.state) && Date.now() < until) {
    await sleep(250);
    record = readNativeRun(sessionsDir, id);
  }
  return record;
}

function receipt(record) {
  if (record.state === 'failed') throw new Error(record.error);
  if (record.state === 'finished') return { ...record.result, run_id: record.run_id, state: 'finished' };
  if (record.state === 'interrupted') return record;
  return {
    state: record.state, run_id: record.run_id, cwd: record.cwd, session_id: record.session_id,
    progress: record.progress, pending_tool_call: record.pending_tool_call,
    text: record.state === 'outcome_unknown'
      ? 'The worker stopped reporting. Inspect workspace evidence before deciding whether to retry.'
      : record.state === 'waiting_gemini' ? 'Codex is waiting for a reply to ask_gemini.'
      : 'Codex is working. Poll gempt_status with this run_id and wait_sec=20 until finished or failed. Do not submit the task again.',
  };
}

export async function startNativeRun({ args, host, agent, env }) {
  const id = args.run_id ?? randomUUID().replaceAll('-', '');
  const file = stateFile(host.sessionsDir, id);
  const runs = join(host.sessionsDir, 'runs');
  mkdirSync(runs, { recursive: true });
  try {
    mkdirSync(join(runs, id));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Another host process may have claimed the ID just before publishing its receipt.
    let prior;
    for (let attempt = 0; ; attempt++) {
      try { prior = readNativeRun(host.sessionsDir, id); break; } catch (err) {
        if (err.code !== 'ENOENT' || attempt === 10) throw err;
        await sleep(50);
      }
    }
    if (prior.cwd !== args.cwd) throw new Error('run_id belongs to a different workspace.');
    return receipt(prior);
  }
  const record = { source: 'magpie_exec', run_id: id, cwd: args.cwd, state: 'queued',
    created_at: new Date().toISOString(), goal: args.goal, tier: args.tier, agent,
    title: normalizeTitle(args.title, args.goal, args.cwd), host_conversation_id: args.host_conversation_id || null,
    session_id: args.session_id || `exec-${randomUUID()}`, config_path: host.configPath, progress: null, verification: args.verification,
    deadline: Date.now() / 1000 + 120 + (Number(args.timeout_sec) || 3600) };
  saveNativeRun(file, record);
  try {
    const child = spawn(process.execPath, [workerPath], {
      env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'],
    });
    const packet = JSON.stringify({ file, record, args, host, agent });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('spawn', () => child.stdin.end(packet, resolve));
    });
    child.unref();
  } catch (err) {
    saveNativeRun(file, { ...record, state: 'failed', error: err.message, finished_at: new Date().toISOString() });
    throw err;
  }
  // Keep synchronous results for short jobs. Magpie ends a tool call after 55 seconds.
  return receipt(await waitForNativeRun(host.sessionsDir, id, args.background === true ? 0 : 20));
}

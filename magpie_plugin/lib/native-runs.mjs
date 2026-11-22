import { dispatchRun, readRun, waitForRun } from '../../core/runs.mjs';

function requireNativeRun(record) {
  if (record.source !== 'magpie_exec') throw new Error('Not a Magpie native exec run.');
  return record;
}

export function readNativeRun(sessionsDir, id) {
  return requireNativeRun(readRun(id, sessionsDir));
}

export async function waitForNativeRun(sessionsDir, id, seconds) {
  readNativeRun(sessionsDir, id);
  return requireNativeRun(await waitForRun(id, {
    sessionsDir, timeoutSec: Math.min(20, Math.max(0, Number(seconds) || 0)),
  }));
}

export async function startNativeRun({ args, host, agent, env }) {
  const record = await dispatchRun(args, { ...host, agent, env, waitSec: 20, legacyNative: true });
  if (record.state === 'failed') throw new Error(record.error);
  if (record.state === 'finished') return { ...record.result, run_id: record.run_id, state: 'finished' };
  if (record.state === 'interrupted') return record;
  return {
    state: record.state, run_id: record.run_id, cwd: record.cwd, session_id: record.session_id,
    progress: record.progress, pending_tool_call: record.pending_tool_call,
    text: record.state === 'outcome_unknown'
      ? 'The worker stopped reporting. Inspect workspace evidence before deciding whether to retry.'
      : record.state === 'waiting_gemini' ? 'Codex is waiting for a reply to ask_gemini.'
      : 'Codex is working. Use gempt-wait with this run_id to await completion or gempt_ctl for a status snapshot.',
  };
}

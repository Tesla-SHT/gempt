import { createGemptTools } from './tools.mjs';
import { readRun, saveRun } from '../../core/runs.mjs';
import { TurnInterrupted } from './app-server-run.mjs';
import { join } from 'node:path';
import { withLock } from '../../core/state.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { file, record, args, host, agent } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const running = { ...record, state: 'running', pid: process.pid, started_at: new Date().toISOString() };
let outcome;
try {
  saveRun(file, running);
  const tools = createGemptTools({ ...host, execRunFile: file, newExecSession: record.session_id });
  const result = await withLock(join(host.sessionsDir, `${record.session_id}.node.lock`),
    () => tools.exec.execute({ ...args, run_id: record.run_id }, { agent }));
  outcome = { state: 'finished', result };
} catch (err) {
  outcome = { state: err instanceof TurnInterrupted ? 'interrupted' : 'failed', error: String(err?.message || err) };
}
const latest = readRun(record.run_id, host.sessionsDir);
const finished = { ...latest, ...outcome, pending_tool_call: null, finished_at: new Date().toISOString() };
if (finished.progress) Object.assign(finished.progress, { phase: outcome.state, updated_at: finished.finished_at });
saveRun(file, finished);

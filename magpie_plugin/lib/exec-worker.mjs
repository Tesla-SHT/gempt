import { createGemptTools } from './tools.mjs';
import { readNativeRun, saveNativeRun } from './native-runs.mjs';
import { TurnInterrupted } from './app-server-run.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { file, record, args, host, agent } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const running = { ...record, state: 'running', pid: process.pid, started_at: new Date().toISOString() };
let outcome;
try {
  saveNativeRun(file, running);
  const tools = createGemptTools({ ...host, execRunFile: file, newExecSession: record.session_id });
  const result = await tools.exec.execute({ ...args, run_id: record.run_id }, { agent });
  outcome = { state: 'finished', result };
} catch (err) {
  outcome = { state: err instanceof TurnInterrupted ? 'interrupted' : 'failed', error: String(err?.message || err) };
}
const latest = readNativeRun(host.sessionsDir, record.run_id);
const finished = { ...latest, ...outcome, pending_tool_call: null, finished_at: new Date().toISOString() };
if (finished.progress) Object.assign(finished.progress, { phase: outcome.state, updated_at: finished.finished_at });
saveNativeRun(file, finished);

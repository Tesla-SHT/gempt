import { createGemptTools } from './tools.mjs';
import { saveNativeRun } from './native-runs.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { file, record, args, host, agent } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const running = { ...record, state: 'running', pid: process.pid, started_at: new Date().toISOString() };
try {
  saveNativeRun(file, running);
  const tools = createGemptTools({ ...host, inExecWorker: true });
  const result = await tools.exec.execute({ ...args, run_id: record.run_id }, { agent });
  saveNativeRun(file, { ...running, state: 'finished', result, finished_at: new Date().toISOString() });
} catch (err) {
  saveNativeRun(file, { ...running, state: 'failed', error: String(err?.message || err), finished_at: new Date().toISOString() });
}

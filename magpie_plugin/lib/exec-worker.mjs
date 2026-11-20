import { createGemptTools } from './tools.mjs';
import { saveNativeRun } from './native-runs.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { file, record, args, host, agent } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
try {
  saveNativeRun(file, { ...record, state: 'running', pid: process.pid });
  const tools = createGemptTools({ ...host, inExecWorker: true });
  const result = await tools.exec.execute(args, { agent });
  saveNativeRun(file, { ...record, state: 'finished', result });
} catch (err) {
  saveNativeRun(file, { ...record, state: 'failed', error: String(err?.message || err) });
}

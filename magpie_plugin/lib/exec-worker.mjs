import { createExecutionTools } from './tools.mjs';
import { readRun, saveRun } from '../../core/runs.mjs';
import { TurnInterrupted } from './app-server-run.mjs';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lockStaleMsForBudget, withLock } from '../../core/state.mjs';

let diagnosticFd;
let packet;
let outcome;
let saved = false;

function terminalRecord(latest, outcome) {
  const finished = { ...latest, ...outcome, pending_tool_call: null, waiting_since: null, finished_at: new Date().toISOString() };
  if (outcome.state === 'finished') delete finished.error;
  if (!outcome.remote_turn_unconfirmed) {
    delete finished.remote_turn_unconfirmed;
    delete finished.unconfirmed_at;
  }
  if (finished.progress) finished.progress = { ...finished.progress, phase: outcome.state, updated_at: finished.finished_at };
  return finished;
}

function diagnose(message) {
  try { writeSync(diagnosticFd ?? 2, message + '\n'); } catch { /* Still attempt to persist the state if stderr fails. */ }
}

function fatal(error, origin) {
  diagnose(`exec-worker ${origin}: ${error?.stack || error}`);
  if (packet?.file && !saved) {
    try {
      let latest = packet.record;
      try { latest = readRun(latest.run_id, packet.host.sessionsDir); }
      catch (readError) { diagnose(`Failed to read latest run: ${readError.message}`); }
      const failed = { state: 'failed', error: String(error?.message || error) };
      const unknown = outcome ? outcome.remote_turn_unconfirmed
        : (latest.turn_id || latest.progress?.turn_id) && !['interrupted', 'failed', 'completed'].includes(latest.progress?.phase);
      if (unknown && (!latest.cli || latest.cli === 'codex')) {
        failed.remote_turn_unconfirmed = true;
        failed.unconfirmed_at = outcome?.unconfirmed_at || latest.unconfirmed_at || new Date().toISOString();
      }
      saveRun(packet.file, terminalRecord({ ...latest, progress: latest.progress || {} }, failed));
    } catch (saveError) {
      diagnose(`Failed to persist worker failure: ${saveError.stack || saveError}`);
    }
  }
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', (reason) => fatal(reason, 'unhandledRejection'));

const packetPath = process.argv[2] === '--packet' && process.argv[3];
if (packetPath) {
  diagnosticFd = openSync(join(dirname(packetPath), 'worker.stderr.log'), 'a', 0o600);
  packet = JSON.parse(readFileSync(packetPath, 'utf8'));
  unlinkSync(packetPath);
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const { file, record, args, host, agent } = packet;
diagnosticFd ??= openSync(join(dirname(file), 'worker.stderr.log'), 'a', 0o600);
const running = { ...record, state: 'running', pid: process.pid, started_at: new Date().toISOString() };
try {
  const started = await withLock(join(host.sessionsDir, `${record.session_id}.dispatch.lock`), () => {
    if (readRun(record.run_id, host.sessionsDir).state !== 'queued') return false;
    saveRun(file, running);
    return true;
  }, { attempts: 80, delayMs: 25 });
  if (started) {
    const tools = createExecutionTools({ ...host, projection: record.implicit_swarm_worker ? record : null, execRunFile: file, newExecSession: record.session_id });
    const result = await withLock(join(host.sessionsDir, `${record.session_id}.node.lock`),
      () => tools.exec.execute({ ...args, run_id: record.run_id }, { agent }),
      { attempts: 240, delayMs: 25, staleMs: lockStaleMsForBudget(record.execution_timeout_sec) });
    outcome = { state: 'finished', result };
  }
} catch (err) {
  if (!(err instanceof TurnInterrupted)) diagnose(`exec-worker: ${err?.stack || err}`);
  outcome = { state: err instanceof TurnInterrupted ? 'interrupted' : 'failed', error: String(err?.message || err),
    ...(err?.remoteTurnUnconfirmed ? { remote_turn_unconfirmed: true, unconfirmed_at: new Date().toISOString() } : {}) };
}

if (outcome) {
  const latest = readRun(record.run_id, host.sessionsDir);
  const finished = terminalRecord(latest, outcome);
  saveRun(file, finished);
  saved = true;
  const swarmId = record.swarm_id || host.swarmId;
  const swarmAgent = record.swarm_agent || host.swarmAgent;
  if (swarmId && swarmAgent) {
    try {
      const { onWorkerTurnFinished } = await import('../../core/swarm-engine.mjs');
      await onWorkerTurnFinished({
        swarmId,
        swarmAgent,
        runId: record.run_id,
        sessionId: finished.result?.session_id || record.session_id,
        startedAt: running.started_at,
        outcome: finished,
        result: finished.result,
        error: finished.error,
        sessionsDir: host.sessionsDir,
        configPath: host.configPath,
        env: process.env,
      });
    } catch { /* Best-effort swarm bus sync so run state is never lost. */ }
  }
}

process.once('exit', (code) => {
  closeSync(diagnosticFd);
  if (code !== 0) return;
  const log = join(dirname(file), 'worker.stderr.log');
  try {
    if (statSync(log, { throwIfNoEntry: false })?.size === 0) unlinkSync(log);
  } catch { /* Best-effort cleanup on exit. */ }
});

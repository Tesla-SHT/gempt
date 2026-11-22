#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ACTIVE_STATES, compactReceiptText, readRun, waitForRuns } from './runs.mjs';

function compactRecord(record) {
  const { before, after, goal, progress, result, ...receipt } = record;
  if (after?.status?.trim() && after.status.trim() !== before?.status?.trim()) {
    const files = after.status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    receipt.changed_files = files.slice(0, 20);
    if (files.length > 20) receipt.changed_files_omitted = files.length - 20;
  }
  if (typeof goal === 'string') receipt.goal = goal.length <= 300 ? goal : `${goal.slice(0, 297)}...`;
  if (progress) {
    const { phase, thread_id, turn_id, last_message, recent_commands, token_usage } = progress;
    receipt.progress = ACTIVE_STATES.has(record.state)
      ? { phase, thread_id, turn_id, last_message: (last_message || '').slice(-300),
        recent_commands: (recent_commands || []).slice(-3).map(({ command, exit_code }) =>
          ({ command: String(command || '').slice(0, 160), exit_code })) }
      : { phase, thread_id, turn_id, token_usage };
  } else if (progress === null) {
    receipt.progress = null;
  }
  if (typeof receipt.text === 'string') receipt.text = compactReceiptText(receipt.text, record.session_id);
  if (result) {
    const { formatted, commands, verification, text, ...summary } = result;
    if (typeof text === 'string') summary.text = compactReceiptText(text, result.session_id || record.session_id);
    if (verification) summary.verification = { status: verification.status, checks: (verification.checks || [])
      .map(({ command, exit_code, output }) => ({ command, exit_code,
        ...(exit_code && output ? { output_tail: String(output).slice(-400) } : {}) })) };
    receipt.result = summary;
  }
  return receipt;
}

export async function runWait(args, { sessionsDir, readOnly = false } = {}) {
  const legacy = args[0] === 'status';
  try {
    const { values, positionals } = parseArgs({ args: legacy ? args.slice(1) : args, allowPositionals: !legacy,
      options: legacy ? { 'run-id': { type: 'string' }, 'run-ids': { type: 'string' },
        wait: { type: 'boolean' }, 'wait-all': { type: 'boolean' } }
        : { all: { type: 'boolean' } } });
    const ids = legacy ? values['run-id'] || values['run-ids'] : positionals[0];
    if (!ids || positionals.length > 1 || (values['run-id'] && values['run-ids'])) {
      throw new Error('Usage: gempt-wait [--all] RUN_ID[,RUN_ID...]');
    }
    const wait = !readOnly || values.wait || values['wait-all'];
    const result = wait ? await waitForRuns(ids, { waitAll: values.all || values['wait-all'], sessionsDir }) : (() => {
      const runs = Object.fromEntries(ids.split(',').map((id) => id.trim()).filter(Boolean).map((id) => [id, readRun(id, sessionsDir)]));
      const active = Object.keys(runs).filter((id) => ['queued', 'running'].includes(runs[id].state));
      return { active, ready: Object.keys(runs).filter((id) => !active.includes(id)), runs };
    })();
    const runs = wait ? Object.fromEntries(Object.entries(result.runs).map(([id, record]) => [id, compactRecord(record)])) : result.runs;
    const records = Object.values(runs);
    const single = !values['run-ids'] && records.length === 1;
    console.log(JSON.stringify(single ? records[0] : { ...result, runs }));
    return Number(wait && single && ['failed', 'interrupted', 'outcome_unknown'].includes(records[0].state));
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runWait(process.argv.slice(2));
}

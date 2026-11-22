#!/usr/bin/env node
import { ACTIVE_STATES, compactReceiptText, waitForRuns } from './runs.mjs';

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

const args = process.argv.slice(2);
const waitAll = args[0] === '--all';
if (waitAll) args.shift();
try {
  if (args.length !== 1) throw new Error('Usage: gempt-wait [--all] RUN_ID[,RUN_ID...]');
  const result = await waitForRuns(args[0], { waitAll });
  const runs = Object.fromEntries(Object.entries(result.runs).map(([id, record]) => [id, compactRecord(record)]));
  const records = Object.values(runs);
  console.log(JSON.stringify(records.length === 1 ? records[0] : { ...result, runs }));
  if (records.length === 1 && ['failed', 'interrupted', 'outcome_unknown'].includes(records[0].state)) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

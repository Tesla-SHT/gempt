#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ACTIVE_STATES, compactReceiptText, readRun, waitForRuns } from './runs.mjs';
import { detectSystemAttention, getBoardHead, listChannels, listRoster, mentionMatchesAgent, openSwarmDb, readBoardMessages } from './swarm-bus.mjs';

import { ALL, activeAt, countsUnread, mentionsIn } from './swarm-channels.mjs';

function compactRecord(record) {
  const { before, after, goal, progress, result, config_path, source, pid, ...receipt } = record;
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

function compactRoster(roster) {
  return roster.map(({ name, state, cli, model, run_id, session_id, last_seq, parked_on, error, task_summary }) => ({
    name, state, cli, model, run_id, session_id, last_seq, parked_on, error, task_summary,
  }));
}

function rosterSignature(roster) {
  return roster.map((w) => `${w.name}:${w.state}:${w.run_id || ''}:${w.parked_on || ''}:${w.error || ''}`).join('|');
}

function isAttentionWorker(worker) {
  return worker.state === 'waiting_reply'
    || worker.state === 'failed'
    || worker.state === 'interrupted'
    || (worker.state === 'stopped' && Boolean(worker.error));
}

export async function waitForBoard(swarmId, {
  since = 0, allMessages = false, channel, sessionsDir, pollIntervalMs = 200, timeoutMs = Infinity,
} = {}) {
  const after = Math.max(0, Math.trunc(Number(since) || 0));
  const deadline = Number.isFinite(timeoutMs) ? performance.now() + timeoutMs : Infinity;
  const db = await openSwarmDb(sessionsDir);
  try {
    const initialRoster = await listRoster(swarmId, { includeKilled: false, db });
    const initialSig = rosterSignature(initialRoster);
    let previousHead = -1, previousSig, history = [], channels = [];
    let messages = [], matching = [], system_attention = [];
    while (true) {
      const [head, roster] = await Promise.all([
        getBoardHead(swarmId, { db }),
        listRoster(swarmId, { includeKilled: false, db }),
      ]);
      const boardChanged = head !== previousHead;
      if (boardChanged) {
        const fresh = await readBoardMessages(swarmId, { since: Math.max(0, previousHead), limit: Infinity, db });
        history = history.concat(fresh);
        channels = await listChannels(swarmId, { db });
        previousHead = fresh.at(-1)?.seq ?? head;
        const active = activeAt(channels, fresh);
        const visible = (m) => m.seq > after && (!channel || channel === ALL || m.channel === channel) && countsUnread(m);
        messages = messages.concat(fresh.filter(visible)).slice(0, 100);
        matching = allMessages ? messages : fresh.filter((m, i) => visible(m) && m.from_agent !== 'coordinator' &&
          (m.kind === 'question' || mentionMatchesAgent(m.mentions, 'coordinator') ||
            mentionsIn(m.text, 'coordinator', [ALL], active[i]))).slice(0, 100);
      }
      const attention = roster.some(isAttentionWorker);
      const anyWorking = roster.some((w) => w.state === 'working');
      const sig = rosterSignature(roster);
      if (boardChanged || sig !== previousSig) {
        system_attention = detectSystemAttention(null, roster, history, channels);
        previousSig = sig;
      }
      const allIdleWithChange = roster.length > 0 && !anyWorking && (messages.length || sig !== initialSig);
      const remaining = deadline - performance.now();
      if (matching.length > 0 || system_attention.some((item) => item.kind === 'stall') || attention || allIdleWithChange || remaining <= 0) {
        return {
          swarm_id: swarmId,
          head: previousHead,
          messages: allMessages ? messages : (matching.length ? matching : messages),
          roster: compactRoster(roster), system_attention,
        };
      }
      await sleep(Math.min(pollIntervalMs, Math.max(10, remaining)));
    }
  } finally {
    db.close();
  }
}

export async function runWait(args, { sessionsDir, readOnly = false } = {}) {
  const legacy = args[0] === 'status';
  try {
    const { values, positionals } = parseArgs({ args: legacy ? args.slice(1) : args, allowPositionals: !legacy,
      options: legacy ? { 'run-id': { type: 'string' }, 'run-ids': { type: 'string' },
        wait: { type: 'boolean' }, 'wait-all': { type: 'boolean' } }
        : {
          all: { type: 'boolean' },
          board: { type: 'string' },
          since: { type: 'string' },
          channel: { type: 'string' },
          'all-messages': { type: 'boolean' },
        } });
    if (!legacy && values.board) {
      if (positionals.length > 0) {
        throw new Error('Usage: gempt-wait --board SWARM_ID [--since SEQ] [--channel NAME] [--all-messages]');
      }
      const since = values.since !== undefined ? Number(values.since) : 0;
      if (!Number.isFinite(since) || since < 0) throw new Error('Invalid --since value.');
      const snapshot = await waitForBoard(values.board, {
        since,
        allMessages: Boolean(values['all-messages']),
        channel: values.channel,
        sessionsDir,
      });
      console.log(JSON.stringify(snapshot));
      return 0;
    }
    const ids = legacy ? values['run-id'] || values['run-ids'] : positionals[0];
    if (!ids || positionals.length > 1 || (values['run-id'] && values['run-ids'])) {
      throw new Error('Usage: gempt-wait [--all] RUN_ID[,RUN_ID...] | gempt-wait --board SWARM_ID [--since SEQ] [--channel NAME] [--all-messages]');
    }
    const waitAll = Boolean(values.all || values['wait-all']);
    const wait = !readOnly || values.wait || waitAll;
    const result = wait ? await waitForRuns(ids, { waitAll, sessionsDir }) : (() => {
      const runs = Object.fromEntries(ids.split(',').map((id) => id.trim()).filter(Boolean).map((id) => [id, readRun(id, sessionsDir)]));
      const active = Object.keys(runs).filter((id) => ['queued', 'running'].includes(runs[id].state));
      return { active, ready: Object.keys(runs).filter((id) => !active.includes(id)), runs };
    })();
    const runs = wait ? Object.fromEntries(Object.entries(result.runs).map(([id, record]) => [id, compactRecord(record)])) : result.runs;
    const records = Object.values(runs);
    const single = !values['run-ids'] && records.length === 1;
    console.log(JSON.stringify(single ? records[0] : { ...result, runs }));
    const checked = (single || waitAll) ? records : result.ready.map((id) => runs[id]).filter(Boolean);
    return Number(wait && checked.some(({ state }) => ['failed', 'interrupted', 'outcome_unknown'].includes(state)));
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runWait(process.argv.slice(2));
}

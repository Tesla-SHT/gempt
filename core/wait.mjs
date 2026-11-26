#!/usr/bin/env node
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pidAlive } from '../magpie_plugin/lib/app-server-process.mjs';
import { ACTIVE_STATES, buildReplyCommand, compactReceiptText, pendingToolCalls, readRun, runDirectory, waitForRuns } from './runs.mjs';
import { boardPostPreview, detectSystemAttention, getBoardHead, listChannels, listRoster, mentionMatchesAgent, openSwarmDb, readBoardMessages } from './swarm-bus.mjs';

import { ALL, activeAt, countsUnread, mentionsIn } from './swarm-channels.mjs';

const HEARTBEAT_SEC = 30;
const STALE_SEC = 300;
const monitorUsage = '[--heartbeat-sec N] [--stale-sec N]';
export const waitUsage = (command) => `Usage: ${command} [--all] ${monitorUsage} RUN_ID[,RUN_ID...]\n`
  + `       ${command} --board SWARM_ID [--since SEQ] [--channel NAME] [--all-messages] ${monitorUsage}`;
export const STATUS_USAGE = 'Usage: gempt status [RUN_ID | --run-id RUN_ID | --run-ids RUN_ID[,RUN_ID...]] [--wait | --wait-all] [--heartbeat-sec N] [--stale-sec N] [--config PATH] [--json]';

function replyFields(record) {
  const replies = pendingToolCalls(record).map(({ call_id }) => ({
    call_id, reply_command: buildReplyCommand(record.run_id, call_id),
  }));
  return replies.length ? {
    reply_command: replies[0].reply_command,
    ...(replies.length > 1 ? { reply_commands: replies } : {}),
  } : {};
}

function timestamp(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value) || 0;
}

function activity(record, sessionsDir, fallback) {
  const directory = runDirectory(record.run_id, sessionsDir);
  const journal = join(directory, 'events.jsonl');
  const stats = statSync(journal, { throwIfNoEntry: false });
  return { journal, stats, updated: Math.max(fallback, stats?.mtimeMs ?? 0,
    statSync(join(directory, 'state.json'), { throwIfNoEntry: false })?.mtimeMs ?? 0,
    timestamp(record.progress?.updated_at), timestamp(record.updated_at), timestamp(record.started_at), timestamp(record.created_at)) };
}

function latestJournalCommand({ journal, stats }) {
  if (!stats?.size) return;
  let fd;
  try {
    fd = openSync(journal, 'r');
    const buffer = Buffer.alloc(Math.min(stats.size, 32 * 1024));
    const size = readSync(fd, buffer, 0, buffer.length, stats.size - buffer.length);
    for (const line of buffer.toString('utf8', 0, size).split('\n').reverse()) {
      if (!line.includes('"command"')) continue;
      try {
        const { params, command } = JSON.parse(line);
        const text = params?.item?.command ?? params?.command ?? command;
        if (typeof text === 'string' && text) return text;
      } catch { /* The bounded tail may start or end inside a line. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function waitMonitor(heartbeatSec, staleSec, sessionsDir) {
  const started = performance.now();
  const wallStart = Date.now();
  let nextHeartbeat = heartbeatSec * 1000;
  return {
    inspect(entries, boardHead) {
      const elapsed = performance.now() - started;
      const now = Date.now();
      const heartbeat = heartbeatSec > 0 && elapsed >= nextHeartbeat;
      const summaries = [];
      const stalls = new Map();
      for (const { label, record, updated = 0, active = ['queued', 'running'].includes(record?.state) } of entries) {
        if (record?.worker_pid_exited || (record?.state === 'running'
            && Number.isSafeInteger(record.pid) && record.pid > 0 && !pidAlive(record.pid))) {
          stalls.set(label, { stalled: true, stale_sec: staleSec, reason: 'worker_pid_exited' });
          continue;
        }
        if (!active) continue;
        const info = record ? activity(record, sessionsDir, updated) : { updated };
        const age = Math.max(0, now - (info.updated || wallStart));
        if (staleSec > 0 && age >= staleSec * 1000) {
          stalls.set(label, { stalled: true, stale_sec: staleSec, reason: 'no_progress' });
        }
        if (heartbeat && summaries.length < 6) {
          const phase = record?.progress?.phase || record?.state || 'working';
          const command = (info.stats?.mtimeMs > timestamp(record?.progress?.updated_at) && latestJournalCommand(info))
            || record?.progress?.recent_commands?.at(-1)?.command;
          summaries.push(`${label ? `${label} ` : ''}${record?.state || 'working'} · phase=${phase}`
            + (command ? ` · last_cmd=${JSON.stringify(command.slice(0, 160))}` : '')
            + ` · updated ${Math.floor(age / 1000)}s ago`);
        }
      }
      if (heartbeat) {
        const seconds = Math.floor(elapsed / 1000);
        nextHeartbeat = (Math.floor(elapsed / (heartbeatSec * 1000)) + 1) * heartbeatSec * 1000;
        const head = boardHead === undefined ? '' : `board head=#${boardHead} · `;
        console.error(`[gempt-wait ${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s] ${head}${summaries.join(' | ') || 'waiting'}`);
      }
      return stalls;
    },
  };
}

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
  return { ...receipt, ...replyFields(record) };
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
  heartbeatSec = HEARTBEAT_SEC, staleSec = STALE_SEC,
} = {}) {
  const after = Math.max(0, Math.trunc(Number(since) || 0));
  const deadline = Number.isFinite(timeoutMs) ? performance.now() + timeoutMs : Infinity;
  const monitor = waitMonitor(heartbeatSec, staleSec, sessionsDir);
  const db = await openSwarmDb(sessionsDir);
  try {
    const initialRoster = await listRoster(swarmId, { includeKilled: false, db });
    const initialSig = rosterSignature(initialRoster);
    let previousHead = -1, previousSig, history = [], channels = [];
    const lastPostByWorker = new Map();
    const questionsBySeq = new Map();
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
        for (const message of fresh) {
          if (countsUnread(message)) lastPostByWorker.set(message.from_agent, message.created_at);
          if (message.kind === 'question') questionsBySeq.set(message.seq, message);
        }
        messages = messages.concat(fresh.filter(visible)).slice(0, 100);
        matching = allMessages ? messages : fresh.filter((m, i) => visible(m) && m.from_agent !== 'coordinator' &&
          (m.kind === 'question' || mentionMatchesAgent(m.mentions, 'coordinator') ||
            mentionsIn(m.text, 'coordinator', [ALL], active[i]))).slice(0, 100);
      }
      const records = new Map();
      for (const worker of roster) {
        if (!worker.run_id || !['working', 'waiting_reply', 'stopped'].includes(worker.state)) continue;
        try {
          const record = readRun(worker.run_id, sessionsDir);
          if ((!record.swarm_id || record.swarm_id === swarmId) && (!record.swarm_agent || record.swarm_agent === worker.name)) {
            records.set(worker.name, record);
          }
        } catch (error) {
          if (error.status !== 400 && error.status !== 404) throw error;
        }
      }
      const stalls = monitor.inspect(roster.map((worker) => {
        const record = records.get(worker.name);
        const lastPost = lastPostByWorker.get(worker.name);
        return { label: worker.name, record, updated: Math.max(timestamp(worker.updated_at), timestamp(lastPost)),
          active: worker.state === 'working' && !worker.parked_on?.startsWith('board_wait')
            && (!record || ['queued', 'running'].includes(record.state)) };
      }), previousHead);
      const pending = roster.flatMap((worker) => {
        const record = records.get(worker.name);
        const calls = pendingToolCalls(record);
        if (calls.length) return calls.map((call) => ({
          agent: worker.name, run_id: record.run_id, state: record.state,
          call_id: call.call_id, question: call.arguments?.question,
          reply_command: buildReplyCommand(record.run_id, call.call_id),
        }));
        if (worker.state === 'waiting_reply' && worker.parked_on?.startsWith('board_ask:')) {
          const question = questionsBySeq.get(Number(worker.parked_on.slice('board_ask:'.length)));
          if (question) return [{ agent: worker.name, state: 'waiting_reply', ...boardQuestion(question) }];
        }
        return [];
      });
      const attention = roster.some(isAttentionWorker);
      const anyWorking = roster.some((w) => w.state === 'working');
      const sig = rosterSignature(roster);
      if (boardChanged || sig !== previousSig) {
        system_attention = detectSystemAttention(null, roster, history, channels);
        previousSig = sig;
      }
      const allIdleWithChange = roster.length > 0 && !anyWorking && (messages.length || sig !== initialSig);
      const remaining = deadline - performance.now();
      if (pending.length || stalls.size || matching.length > 0 || system_attention.some((item) => item.kind === 'stall')
          || attention || allIdleWithChange || remaining <= 0) {
        return {
          swarm_id: swarmId,
          head: previousHead,
          messages: (allMessages || !matching.length ? messages : matching).map((message) => {
            const preview = boardPostPreview(message);
            if (message.kind !== 'question') return preview;
            const ask = pending.find((item) => item.agent === message.from_agent && item.call_id
              && item.call_id === message.meta?.call_id && item.run_id === message.meta?.run_id);
            if (ask) return { ...preview, reply_command: ask.reply_command };
            return message.meta?.call_id ? preview : { ...preview, ...boardQuestion(message) };
          }),
          roster: compactRoster(roster).map((worker) => ({
            ...worker, ...replyFields(records.get(worker.name)), ...stalls.get(worker.name),
          })), system_attention,
          ...(pending.length ? { pending_questions: pending } : {}),
          ...(stalls.size ? { ...stalls.values().next().value } : {}),
        };
      }
      await sleep(Math.max(10, Math.min(pollIntervalMs, (heartbeatSec || Infinity) * 1000, remaining)));
    }
  } finally {
    db.close();
  }
}

function boardQuestion(message) {
  return { seq: message.seq, question: boardPostPreview(message).text,
    reply_command: `gempt board post --swarm ${message.swarm_id} --from coordinator --channel ${message.channel}`
      + ` --reply-to ${message.seq} --text "@${message.from_agent} <answer>"` };
}

export async function runWait(args, { sessionsDir, readOnly = false, command = 'gempt-wait' } = {}) {
  const legacy = args[0] === 'status';
  const usage = legacy ? STATUS_USAGE : waitUsage(command);
  try {
    const monitorOptions = {
      help: { type: 'boolean', short: 'h' },
      'heartbeat-sec': { type: 'string' },
      'stale-sec': { type: 'string' },
    };
    const { values, positionals } = parseArgs({ args: legacy ? args.slice(1) : args, allowPositionals: !legacy,
      options: { ...monitorOptions, ...(legacy ? { 'run-id': { type: 'string' }, 'run-ids': { type: 'string' },
        wait: { type: 'boolean' }, 'wait-all': { type: 'boolean' } } : {
          all: { type: 'boolean' },
          board: { type: 'string' },
          since: { type: 'string' },
          channel: { type: 'string' },
          'all-messages': { type: 'boolean' },
        }) } });
    if (values.help) {
      console.log(usage);
      return 0;
    }
    const seconds = (key, fallback) => {
      if (values[key] === undefined) return fallback;
      const value = Number(values[key]);
      if (!values[key].trim() || !Number.isFinite(value) || value < 0) throw new Error(`Invalid --${key} value.`);
      return value;
    };
    const heartbeatSec = seconds('heartbeat-sec', HEARTBEAT_SEC);
    const staleSec = seconds('stale-sec', STALE_SEC);
    if (values.board !== undefined) {
      if (!values.board || positionals.length || values.all) throw new Error('Expected --board SWARM_ID without run IDs or --all.');
      const since = values.since !== undefined ? Number(values.since) : 0;
      if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid --since value.');
      const snapshot = await waitForBoard(values.board, {
        since,
        allMessages: Boolean(values['all-messages']),
        channel: values.channel,
        sessionsDir,
        heartbeatSec,
        staleSec,
      });
      console.log(JSON.stringify(snapshot));
      return Number(Boolean(snapshot.stalled));
    }
    if (values.since !== undefined || values.channel !== undefined || values['all-messages']) {
      throw new Error('--since, --channel and --all-messages require --board.');
    }
    const ids = legacy ? values['run-id'] || values['run-ids'] : positionals[0];
    if (!ids || positionals.length > 1 || (values['run-id'] && values['run-ids'])) {
      throw new Error('Expected run IDs. Choose a single run ID selector.');
    }
    const waitAll = Boolean(values.all || values['wait-all']);
    const wait = !readOnly || values.wait || waitAll;
    const monitor = wait ? waitMonitor(heartbeatSec, staleSec, sessionsDir) : null;
    let stalls = new Map();
    const result = await waitForRuns(ids, { waitAll, sessionsDir, timeoutSec: wait ? undefined : 0,
      pollInterval: Math.max(0.01, Math.min(0.25, heartbeatSec || Infinity, staleSec || Infinity)),
      shouldReturn: monitor && (({ runs }) => {
        const entries = Object.entries(runs);
        stalls = monitor.inspect(entries.map(([id, record]) => ({ label: id, record })));
        return stalls.size > 0 || entries.some(([, record]) => pendingToolCalls(record).length > 0);
      }),
    });
    const runs = Object.fromEntries(Object.entries(result.runs).map(([id, record]) =>
      [id, { ...(wait ? compactRecord(record) : { ...record, ...replyFields(record) }), ...stalls.get(id) }]));
    const records = Object.values(runs);
    const single = !values['run-ids'] && records.length === 1;
    console.log(JSON.stringify(single ? records[0] : { ...result, runs, ...stalls.values().next().value }));
    const checked = (single || waitAll) ? records : result.ready.map((id) => runs[id]).filter(Boolean);
    return Number(Boolean(stalls.size || (wait && checked.some(({ state }) => ['failed', 'interrupted', 'outcome_unknown'].includes(state)))));
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    return 1;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runWait(process.argv.slice(2));
}

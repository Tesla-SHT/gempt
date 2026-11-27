import { deadlineForTimeout } from '../timeout.mjs';
import { cacheHitRatio, normalizeUsage } from '../token-usage.mjs';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNodeExecutable } from '../node-executable.mjs';
import { saveRun } from '../runs.mjs';

const BOARD_MCP_PATH = fileURLToPath(new URL('../board-mcp.mjs', import.meta.url));

export function interruptMarkerPath(runDir) {
  return join(runDir, 'interrupt.flag');
}

export function markRunInterruptRequested(runDir) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(interruptMarkerPath(runDir), `${new Date().toISOString()}\n`, 'utf8');
}

export function isRunInterruptRequested(runDir) {
  return existsSync(interruptMarkerPath(runDir));
}

export function createBoardMcpConfigFile({ runDir, ...options }) {
  const spec = getBoardMcpSpec(options);
  if (!spec) return '';
  mkdirSync(runDir, { recursive: true });
  const mcpPath = join(runDir, 'board-mcp.json');
  const [command, ...args] = spec.command;
  const payload = {
    mcpServers: { gempt_board: { command, args, env: spec.environment } },
  };
  writeFileSync(mcpPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return mcpPath;
}

export function getBoardMcpSpec({ swarmId, swarmAgent, sessionsDir, configPath, env = process.env }) {
  if (!swarmId || !swarmAgent) return null;
  const nodeBin = resolveNodeExecutable({ env });
  return {
    type: 'local',
    command: [nodeBin, BOARD_MCP_PATH],
    environment: {
      GEMPT_SWARM_ID: String(swarmId),
      GEMPT_AGENT_NAME: String(swarmAgent),
      ...(env.GEMPT_RUN_ID?.trim() ? { GEMPT_RUN_ID: env.GEMPT_RUN_ID } : {}),
      ...(sessionsDir ? { GEMPT_SESSIONS_DIR: String(sessionsDir) } : {}),
      ...(configPath ? { GEMPT_CONFIG: String(configPath) } : {}),
    },
    enabled: true,
  };
}

export function createRunJournal({
  runFile,
  sessionId,
  cli,
  model,
  sandbox,
  timeoutSec,
  threadId = null,
  turnId = null,
  onIdentity,
}) {
  const startMs = Date.now();
  const directory = dirname(runFile);
  const eventsPath = join(directory, 'events.jsonl');
  const record = JSON.parse(readFileSync(runFile, 'utf8'));
  const resolvedTurnId = turnId || `${cli}-turn-${randomUUID().slice(0, 8)}`;
  const resolvedThreadId = threadId || `${cli}-${randomUUID().slice(0, 12)}`;

  record.cli = cli;
  record.model = model;
  record.sandbox = sandbox;
  record.execution_timeout_sec = timeoutSec || null;
  record.deadline = deadlineForTimeout(timeoutSec, startMs);
  record.codex_thread_id = resolvedThreadId;
  record.runner_session_id = threadId || null;
  record.turn_id = resolvedTurnId;

  const progress = {
    phase: 'running',
    cli,
    thread_id: resolvedThreadId,
    turn_id: resolvedTurnId,
    last_message: '',
    recent_commands: [],
    touched_files: [],
    token_usage: {},
  };

  const messages = new Map();
  const commands = new Map();
  const touched = new Set();
  let usage = {};
  let lastWrite = 0;

  const save = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 350) return;
    lastWrite = now;
    progress.updated_at = new Date(now).toISOString();
    saveRun(runFile, { ...record, session_id: sessionId, progress });
  };

  const emit = (method, params = {}) => {
    const line = JSON.stringify({
      method,
      params: {
        threadId: progress.thread_id,
        turnId: progress.turn_id,
        ...params,
      },
    });
    appendFileSync(eventsPath, `${line}\n`, 'utf8');
  };

  const setIdentity = (nextThreadId, nextTurnId = progress.turn_id, runnerMeta) => {
    let changed = false;
    if (nextThreadId && nextThreadId !== record.codex_thread_id) {
      record.codex_thread_id = progress.thread_id = String(nextThreadId);
      record.runner_session_id = String(nextThreadId);
      changed = true;
    }
    if (nextTurnId && nextTurnId !== record.turn_id) {
      record.turn_id = progress.turn_id = String(nextTurnId);
      changed = true;
    }
    if (runnerMeta && typeof runnerMeta === 'object') {
      record.runner_meta = { ...(record.runner_meta || {}), ...runnerMeta };
      changed = true;
    }
    if (changed) {
      save(true);
      onIdentity?.(record.codex_thread_id, record.turn_id, record.sandbox, record.runner_session_id);
    }
  };

  const setRunnerPid = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    record.runner_pid = pid;
    save(true);
  };

  const appendDelta = (itemId, delta) => {
    if (typeof delta !== 'string' || !delta) return;
    const id = String(itemId || 'msg-1');
    const next = (messages.get(id) || '') + delta;
    messages.set(id, next);
    progress.last_message = next;
    emit('item/agentMessage/delta', { itemId: id, delta });
    save(false);
  };

  const completeMessage = (itemId, text) => {
    const clean = typeof text === 'string' ? text : '';
    if (!clean) return;
    const id = String(itemId || `msg-${messages.size + 1}`);
    messages.set(id, clean);
    progress.last_message = clean;
    emit('item/completed', { item: { id, type: 'agentMessage', text: clean } });
    save(true);
  };

  const recordReasoning = (itemId, summaryText) => {
    const clean = String(summaryText || '').trim();
    if (!clean) return;
    const id = String(itemId || `reason-${Date.now()}`);
    emit('item/completed', { item: { id, type: 'reasoning', summary: [clean] } });
  };

  const recordCommand = (id, command, exitCode = null, output = '') => {
    const cmdId = String(id || `cmd-${commands.size + 1}`);
    const prev = commands.get(cmdId) || { command: '', exit_code: null, output: '' };
    const next = {
      command: String(command || prev.command || ''),
      exit_code: Number.isInteger(exitCode) ? exitCode : prev.exit_code,
      output: String(output || prev.output || ''),
    };
    commands.set(cmdId, next);
    progress.recent_commands = [...commands.values()].slice(-5);
    emit('item/completed', {
      item: {
        id: cmdId,
        type: 'commandExecution',
        command: next.command,
        exitCode: next.exit_code,
        aggregatedOutput: next.output,
      },
    });
    save(true);
  };

  const recordFiles = (id, paths) => {
    const clean = (Array.isArray(paths) ? paths : [paths])
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    if (!clean.length) return;
    for (const p of clean) touched.add(p);
    progress.touched_files = [...touched].slice(-50);
    emit('item/completed', {
      item: {
        id: String(id || `files-${Date.now()}`),
        type: 'fileChange',
        changes: clean.map((p) => ({ path: p })),
      },
    });
    save(true);
  };

  const messageUsage = new Map();
  const recordUsage = (raw, messageId) => {
    if (!raw || typeof raw !== 'object') return;
    const normalized = normalizeUsage(raw);
    if (!Object.keys(normalized).length) return;
    if (messageId) {
      messageUsage.set(messageId, normalized);
      usage = {};
      for (const tokens of messageUsage.values()) {
        for (const [key, count] of Object.entries(tokens)) usage[key] = (usage[key] ?? 0) + count;
      }
    } else {
      usage = { ...usage, ...normalized };
    }
    usage.cache_hit_ratio = cacheHitRatio(usage);
    progress.token_usage = usage;
    emit('thread/tokenUsage/updated', {
      tokenUsage: {
        last: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: usage.cached_input_tokens,
          cacheWriteInputTokens: usage.cache_write_tokens,
          totalTokens: usage.total_tokens,
          reasoningOutputTokens: usage.reasoning_tokens,
        },
      },
    });
    save(false);
  };

  const finish = (status = 'completed', errorMessage = '') => {
    progress.phase = status;
    emit('turn/completed', {
      turn: {
        id: progress.turn_id,
        status,
        ...(errorMessage ? { error: { message: errorMessage } } : {}),
      },
    });
    save(true);
  };

  save(true);
  emit('turn/started', {});
  onIdentity?.(record.codex_thread_id, record.turn_id, record.sandbox, record.runner_session_id);

  return {
    directory,
    record,
    progress,
    setIdentity,
    setRunnerPid,
    appendDelta,
    completeMessage,
    recordReasoning,
    recordCommand,
    recordFiles,
    recordUsage,
    finish,
    save,
    getThreadId: () => record.codex_thread_id,
    getRunnerSessionId: () => record.runner_session_id,
    getTurnId: () => record.turn_id,
    getText: () => [...messages.values()].map((v) => v.trim()).filter(Boolean).join('\n\n'),
    getCommands: () => [...commands.values()],
    getUsage: () => usage,
    getElapsedSec: () => (Date.now() - startMs) / 1000,
  };
}

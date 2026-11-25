import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listConsultSessions, workspaceName } from '../magpie_plugin/lib/activity.mjs';
import { readRoutingSummary } from '../magpie_plugin/lib/backend.mjs';
import { GEMPT_VERSION } from './config.mjs';
import { readHostContext } from './host-context.mjs';
import { ACTIVE_STATES, interruptRun, readRun, replyToolCall, runDirectory, stateEntries, steerRun } from './runs.mjs';
import { resolvePath, withinPath } from './state.mjs';

const TEXT_BYTES = 96 * 1024;
const GOAL_BYTES = 16 * 1024;
const USAGE_FIELDS = {
  inputTokens: 'input_tokens', outputTokens: 'output_tokens', cachedInputTokens: 'cached_input_tokens',
  totalTokens: 'total_tokens', reasoningOutputTokens: 'reasoning_tokens',
};


const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const text = (value, limit) => typeof value === 'string' ? Array.from(value.slice(0, limit * 2)).slice(0, limit).join('') : '';
const number = (value) => typeof value === 'number' && Math.abs(value) <= 1e18 ? value : null;
const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value));
const firstObject = (...values) => values.map(object).find((value) => Object.keys(value).length) || {};

function timestamp(value) {
  if (typeof value !== 'string') return number(value);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function usage(value) {
  return Object.fromEntries(Object.values(USAGE_FIELDS).filter((key) =>
    Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 2 ** 63).map((key) => [key, value[key]]));
}

function pageText(value, offset, budget = TEXT_BYTES) {
  // Read enough UTF-16 units for the requested code-point page and its lookahead.
  const chars = typeof value === 'string' ? Array.from(value.slice(0, 2 * (offset + budget + 1))) : [];
  let low = Math.min(offset, chars.length);
  let high = Math.min(chars.length, low + budget);
  const start = low;
  if (jsonSize(chars.slice(start, high).join('')) > budget) {
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (jsonSize(chars.slice(start, middle).join('')) <= budget) low = middle;
      else high = middle - 1;
    }
  }
  return { full_text: chars.slice(start, high).join(''), next_text_offset: high < chars.length ? high : null };
}

const bounded = (value, budget) => pageText(value, 0, budget).full_text;

function withinBudget(items, budget) {
  const selected = [];
  for (const item of items) {
    const size = jsonSize(item) + 2;
    if (size <= budget) {
      selected.push(item);
      budget -= size;
    }
  }
  return selected;
}

function pending(value, compact = false) {
  const args = object(value.arguments);
  return {
    call_id: text(value.call_id, 128), tool: 'ask_gemini',
    arguments: { reason: text(args.reason, 64), question: bounded(args.question, compact ? 512 : 8192),
      context: bounded(args.context, compact ? 512 : 16384),
      media_paths: withinBudget(array(args.media_paths).filter((path) => typeof path === 'string'), compact ? 512 : 8192) },
    requested_at: timestamp(value.requested_at),
  };
}

function runSummary(record, compact = false) {
  const result = object(record.result);
  const progress = object(record.progress);
  const started = timestamp(record.started_at);
  const finished = timestamp(record.finished_at);
  const elapsed = number(result.elapsed_sec) ?? (started === null ? null
    : Math.round(Math.max(0, (finished ?? Date.now() / 1000) - started) * 10) / 10);
  const lastCommand = array(progress.recent_commands).at(-1);
  const remoteTurnUnconfirmed = Boolean(record.remote_turn_unconfirmed);
  const cli = text(result.cli || record.cli || 'codex', 32) || 'codex';
  const isNonCodex = cli !== 'codex';
  const activeControllable = ['running', 'waiting_gemini'].includes(record.state);
  return {
    run_id: record.run_id, session_id: text(record.session_id, 128), state: text(record.state, 32),
    cli,
    cwd: bounded(record.cwd, 8192), worktree_path: bounded(record.worktree_path, 8192) || null,
    source_cwd: bounded(record.source_cwd, 8192) || null,
    execution_timeout_sec: number(record.execution_timeout_sec),
    deadline: timestamp(record.deadline),
    title: record.title, workspace_name: bounded(workspaceName(record.source_cwd || record.cwd), 512),
    host_conversation_id: record.host_conversation_id ?? null,
    can_control: isNonCodex
      ? Boolean(activeControllable && cli === 'opencode' && record.runner_meta?.server_url)
      : Boolean(activeControllable && record.codex_thread_id && record.turn_id),
    can_interrupt: Boolean(remoteTurnUnconfirmed
      || (isNonCodex ? activeControllable : (activeControllable && record.codex_thread_id && record.turn_id))),
    remote_turn_unconfirmed: remoteTurnUnconfirmed,
    model: text(result.model || record.model, 128), tier: text(result.tier || record.tier, 64),
    goal: bounded(record.goal, compact ? 512 : GOAL_BYTES), last_message: text(progress.last_message || result.text, 200),
    last_command: text(typeof lastCommand === 'string' ? lastCommand : lastCommand?.command, 160),
    started_at: started, finished_at: finished, elapsed_sec: elapsed,
    usage: usage(firstObject(result.usage, progress.token_usage, record.usage)),
    progress: { phase: text(progress.phase, 64), updated_at: timestamp(progress.updated_at) },
    pending_tool_call: record.pending_tool_call ? pending(record.pending_tool_call, compact) : null,
    error: text(record.error, compact ? 240 : 2000),
  };
}

function workspaceScope({ root, workspaceRoots }) {
  return (workspaceRoots ?? (root ? [root] : null))?.map((path) => resolvePath(path)) ?? null;
}

function inWorkspace(cwd, roots) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  if (!roots) return true;
  const path = resolvePath(cwd);
  return roots.some((root) => withinPath(path, root));
}

function workspaceRun(id, options) {
  const record = readRun(id, options.sessionsDir);
  const roots = workspaceScope(options);
  if (!inWorkspace(record.cwd, roots) && !inWorkspace(record.source_cwd, roots)) {
    throw Object.assign(new Error('Run outside host workspace'), { status: 403 });
  }
  return record;
}

function listRuns(args, { root, workspaceRoots, conversationId, configPath, sessionsDir }) {
  const roots = workspaceScope({ root, workspaceRoots });
  const { routing } = readRoutingSummary({ configPath });
  const context = readHostContext(configPath, root);
  const active = conversationId === undefined ? context.conversation_id || null : conversationId;
  const bound = args.host_conversation_id || active || null;
  const scope = args.scope ?? 'session';
  const workspace = bound && bound === active ? workspaceName(roots?.[0] ?? array(context.workspace_paths)[0]) : '';
  let sessionCount = 0;
  const items = [];
  const workspaces = new Map();
  for (const { id, stat } of stateEntries(sessionsDir)) {
    try {
      const record = readRun(id, sessionsDir, { stat, readonly: true });
      const cwd = record.source_cwd || record.cwd;
      if (!workspaces.has(cwd)) workspaces.set(cwd, inWorkspace(cwd, roots));
      if (!workspaces.get(cwd)) continue;
      const matches = Boolean(bound && record.host_conversation_id === bound);
      if (matches) sessionCount++;
      if ((!args.session_id || record.session_id === args.session_id) && (scope === 'all' || matches)) items.push(record);
    } catch {
      continue;
    }
  }
  items.sort((left, right) => Number(ACTIVE_STATES.has(right.state)) - Number(ACTIVE_STATES.has(left.state)));
  const offset = args.offset ?? 0;
  const limit = args.limit ?? (scope === 'all' ? Infinity : 20);
  let budget = TEXT_BYTES;
  const runs = [];
  for (const record of items.slice(offset, offset + limit)) {
    const item = runSummary(record, true);
    budget -= jsonSize(item) + 2;
    if (budget < 0) break;
    runs.push(item);
  }
  return {
    active_conversation_id: active, bound_conversation_id: bound, scope, unbound_session: !bound && scope === 'session',
    bound_workspace_name: workspace, session_count: sessionCount, routing,
    runs, next_offset: runs.length && offset + runs.length < items.length ? offset + runs.length : null,
    ...(args.include_consults ? {
      consult_sessions: listConsultSessions(sessionsDir, {
        limit: Math.min(limit, 50),
        matches: (record) => (!roots || inWorkspace(record.cwd, roots))
          && (scope === 'all' || Boolean(bound && record.host_conversation_id === bound)),
      }),
    } : {}),
    app_server: { name: 'gempt', version: GEMPT_VERSION },
  };
}

let nextRevision = 1;
const journals = new Map();

class Journal {
  constructor(identity) {
    this.identity = identity;
    this.offset = 0;
    this.rows = new Map();
    this.messages = new Map();
    this.commands = new Map();
    this.files = new Set();
    this.requestIds = new Map();
    this.usage = {};
    this.transcripts = new Map();
  }

  row(type, id, init = { type, id }, index = null) {
    const key = JSON.stringify([type, id, index]);
    if (!this.rows.has(key)) this.rows.set(key, init);
    return this.rows.get(key);
  }

  command(id) {
    this.row('command', id);
    if (!this.commands.has(id)) this.commands.set(id, { id, command: '', exit_code: null, output: '' });
    return this.commands.get(id);
  }

  reasoning(id, index, value, append = false) {
    if (typeof value !== 'string' || !value) return;
    const row = this.row('reasoning', id, { type: 'reasoning', text: '' }, index);
    row.text = text((append ? row.text : '') + value, 4000);
  }

  ask(id, args, status) {
    const row = this.row('ask_gemini', id, { type: 'ask_gemini' });
    if (!row.arguments || args && typeof args === 'object' && !Array.isArray(args)) {
      Object.assign(row, pending({ call_id: id, arguments: args }));
    }
    row.status = status;
  }

  item(value, completed) {
    const { type, id } = object(value);
    if (typeof id !== 'string') return;
    if (type === 'agentMessage') {
      this.row('agent_message', id);
      if (completed && typeof value.text === 'string') this.messages.set(id, [value.text]);
      else if (!this.messages.has(id)) this.messages.set(id, []);
    } else if (type === 'reasoning') {
      const summary = typeof value.summary === 'string' ? [value.summary] : array(value.summary);
      summary.forEach((part, index) => this.reasoning(id, index, part));
    } else if (type === 'commandExecution') {
      const command = this.command(id);
      command.command = text(value.command, 3000) || command.command;
      command.exit_code = number(value.exitCode);
      if (typeof value.aggregatedOutput === 'string' && value.aggregatedOutput) command.output = value.aggregatedOutput.slice(-4000);
    } else if (type === 'fileChange') {
      const paths = array(value.changes).map((change) => change?.path).filter((path) => typeof path === 'string');
      for (const path of paths) this.files.add(path);
      Object.assign(this.row('files', id, { type: 'files' }), { count: paths.length, paths: withinBudget(paths, 4096) });
    } else if (type === 'dynamicToolCall' && value.tool === 'ask_gemini') {
      this.ask(text(value.callId, 200) || id, value.arguments, text(value.status, 32) || (completed ? 'completed' : 'pending'));
    }
  }

  event(raw, record) {
    const { method, params: values, id } = object(raw);
    const params = object(values);
    const turn = object(params.turn);
    const threadId = params.threadId || params.conversationId;
    const turnId = params.turnId || turn.id;
    if ((record.codex_thread_id && threadId && threadId !== record.codex_thread_id)
        || (record.turn_id && turnId && turnId !== record.turn_id)) return;
    const itemId = params.itemId;
    if (method === 'item/started' || method === 'item/completed') {
      this.item(params.item, method === 'item/completed');
    } else if (method === 'turn/completed') {
      for (const item of array(turn.items)) this.item(item, true);
    } else if (method === 'item/agentMessage/delta' && typeof itemId === 'string') {
      this.row('agent_message', itemId);
      if (typeof params.delta === 'string') {
        if (!this.messages.has(itemId)) this.messages.set(itemId, []);
        this.messages.get(itemId).push(params.delta);
      }
    } else if (method === 'item/reasoning/summaryTextDelta' && typeof itemId === 'string' && Number.isInteger(params.summaryIndex ?? 0)) {
      this.reasoning(itemId, params.summaryIndex ?? 0, params.delta, true);
    } else if (method === 'item/commandExecution/outputDelta' && typeof itemId === 'string') {
      const command = this.command(itemId);
      command.output = (command.output + text(params.delta, 4000)).slice(-4000);
    } else if (method === 'item/tool/call' && params.tool === 'ask_gemini' && typeof params.callId === 'string') {
      this.ask(params.callId, params.arguments, 'pending');
      if (typeof id === 'string' || Number.isInteger(id)) this.requestIds.set(id, params.callId);
    } else if (method === 'serverRequest/resolved' && this.requestIds.has(params.requestId)) {
      const callId = this.requestIds.get(params.requestId);
      this.requestIds.delete(params.requestId);
      this.row('ask_gemini', callId).status = 'resolved';
    } else if (method === 'thread/tokenUsage/updated') {
      const totals = firstObject(params.tokenUsage?.last, params.tokenUsage?.total);
      Object.assign(this.usage, usage(Object.fromEntries(Object.entries(USAGE_FIELDS).map(([key, field]) => [field, totals[key]]))));
    }
  }

  read(fd, size, record) {
    let position = this.offset;
    const chunk = Buffer.alloc(64 * 1024);
    let parts = [];
    let skipping = false;
    // GemPT writes method first. Check the short JSON prefix before allocating
    // or decoding a full diff from older, potentially large journals.
    const isDiff = (value) => /^\s*\{\s*"method"\s*:\s*"turn\/diff\/updated"/.test(value.toString('utf8', 0, 128));
    while (position < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!count) break;
      let start = 0;
      for (let end = chunk.indexOf(10, start); end >= 0 && end < count; end = chunk.indexOf(10, start)) {
        const last = chunk.subarray(start, end);
        if (!skipping && (parts.length || !isDiff(last))) {
          try {
            const raw = JSON.parse((parts.length ? Buffer.concat([...parts, last]) : last).toString('utf8'));
            if (raw && raw.method !== 'turn/diff/updated') this.event(raw, record);
          } catch { /* Incomplete or invalid JSON. */ }
        }
        this.offset = position + end + 1;
        start = end + 1;
        parts = [];
        skipping = false;
      }
      if (start < count && !skipping) {
        const tail = chunk.subarray(start, count);
        skipping = !parts.length && isDiff(tail);
        if (!skipping) parts.push(Buffer.from(tail));
      }
      position += count;
    }
  }

  textPage(value) {
    if (this.lastTextPage?.value === value) return this.lastTextPage.page;
    const page = pageText(value, 0);
    this.lastTextPage = { value, page };
    if (page.next_text_offset === null) return page;
    let latest = [...this.transcripts].at(-1);
    if (!latest || latest[1] !== value) {
      latest = [nextRevision++, value];
      this.transcripts.set(...latest);
      if (this.transcripts.size > 2) this.transcripts.delete(this.transcripts.keys().next().value);
    }
    page.text_revision = latest[0];
    return page;
  }
}

function readJournal(path, record) {
  let fd;
  try {
    try { fd = openSync(path, 'r'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stat = fd === undefined ? null : fstatSync(fd, { bigint: true });
    const size = stat && Number(stat.size);
    const identity = JSON.stringify([stat?.dev.toString(), stat?.ino.toString(), record.codex_thread_id, record.turn_id]);
    let journal = journals.get(path);
    const version = stat && `${size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (!journal || journal.identity !== identity || (stat && (size < journal.size
        || (size === journal.size && journal.version !== version)))) journal = new Journal(identity);
    journals.delete(path);
    journals.set(path, journal);
    if (journals.size > 8) journals.delete(journals.keys().next().value);
    if (stat && journal.version !== version) {
      journal.read(fd, size, record);
      journal.messageText = null;
      journal.version = version;
      journal.size = size;
    }
    return journal;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveAllowedFileUri(file, { cwd, allowedRoots }) {
  if (typeof file !== 'string') return { allowed: false, reason: 'outside_workspace' };
  const raw = file.trim();
  if (!raw || /[\x00-\x1f\x7f]/.test(raw) || !allowedRoots.length) {
    return { allowed: false, reason: 'outside_workspace' };
  }
  try {
    let resolved;
    const windowsPath = /^[a-z]:[\\/]/i.test(raw);
    if (!windowsPath && /^[a-z][a-z\d+.-]*:/i.test(raw)) {
      if (!/^file:\/\//i.test(raw)) return { allowed: false, reason: 'outside_workspace' };
      const parsed = new URL(raw);
      if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password) {
        return { allowed: false, reason: 'outside_workspace' };
      }
      resolved = resolvePath(fileURLToPath(parsed));
    } else {
      if (!cwd && !isAbsolute(raw)) return { allowed: false, reason: 'outside_workspace' };
      resolved = resolvePath(cwd ? resolve(cwd, raw) : raw);
    }
    if (allowedRoots.some((base) => withinPath(resolved, base))) {
      return { allowed: true, uri: pathToFileURL(resolved).href };
    }
  } catch {
    // Unresolvable or malformed path stays restricted.
  }
  return { allowed: false, reason: 'outside_workspace' };
}

function stream(record, args, options) {
  const { sessionsDir } = options;
  const roots = workspaceScope(options);
  const journal = readJournal(join(runDirectory(record.run_id, sessionsDir), 'events.jsonl'), record);
  const offset = args.text_offset || 0;
  if (offset && args.text_revision !== undefined) {
    const prior = journal.transcripts.get(args.text_revision);
    return prior === undefined ? { stale_text_revision: true } : pageText(prior, offset);
  }
  const result = object(record.result);
  const progress = object(record.progress);
  const messages = journal.messageText ??= new Map([...journal.messages].map(([id, chunks]) => [id, chunks.join('')]));
  let fullText = typeof result.text === 'string' ? result.text : '';
  const prefix = typeof result.summary === 'string' ? `${result.summary}\n\n` : null;
  if (prefix && fullText.startsWith(prefix)) fullText = fullText.slice(prefix.length);
  fullText ||= [...messages.values()].filter(Boolean).join('\n\n') || text(progress.last_message, 1500);
  if (offset) return pageText(fullText, offset);
  const timeline = [...journal.rows.values()].slice(-(args.max_events ?? 60)).map((row) => {
    if (row.type === 'agent_message') return { ...row, text: text(messages.get(row.id), 1200) };
    if (row.type !== 'command') return row;
    const command = journal.commands.get(row.id);
    return { ...row, command: text(command.command, 600), exit_code: command.exit_code, output: command.output.slice(-600) };
  });
  let commands = [...journal.commands.values()];
  if (!commands.length) {
    const fallback = [result.verification?.commands, result.commands, progress.recent_commands].find((value) => array(value).length);
    commands = array(fallback).flatMap((command, index) => command && typeof command === 'object' && !Array.isArray(command)
      ? [{ id: String(index), command: text(command.command, 3000), exit_code: number(command.exit_code), output: text(command.output, 4000) }]
      : []);
  }
  const files = journal.files.size ? [...journal.files] : array(progress.touched_files).filter((file) => typeof file === 'string');
  const touched = withinBudget([...files].reverse(), 8 * 1024).reverse();
  const cwd = typeof record.cwd === 'string' && isAbsolute(record.cwd) ? resolvePath(record.cwd) : null;
  const allowedRoots = [];
  if (roots) {
    allowedRoots.push(...roots);
    if (typeof record.worktree_path === 'string' && isAbsolute(record.worktree_path) && inWorkspace(record.source_cwd, roots)) {
      allowedRoots.push(resolvePath(record.worktree_path));
    }
  } else if (cwd) {
    allowedRoots.push(cwd);
  }
  const candidateFiles = [];
  const seenFiles = new Set();
  const addCandidate = (file) => {
    if (typeof file !== 'string' || seenFiles.has(file)) return;
    seenFiles.add(file);
    candidateFiles.push(file);
  };
  for (const file of touched) addCandidate(file);
  for (const row of timeline) {
    if (row.type === 'files') {
      for (const file of array(row.paths)) addCandidate(file);
    } else if (row.type === 'ask_gemini') {
      for (const file of array(row.arguments?.media_paths)) addCandidate(file);
    }
  }
  for (const file of array(record.pending_tool_call?.arguments?.media_paths)) addCandidate(file);
  const uris = [];
  const restricted = [];
  for (const file of candidateFiles) {
    const check = resolveAllowedFileUri(file, { cwd, allowedRoots });
    if (check.allowed) uris.push([file, check.uri]);
    else restricted.push([file, check.reason]);
  }
  const totals = usage(firstObject(result.usage, journal.usage, progress.token_usage, record.usage));
  const input = totals.input_tokens ?? 0;
  const cached = totals.cached_input_tokens;
  return {
    run: { ...runSummary(record), usage: totals }, timeline: withinBudget(timeline.reverse(), 56 * 1024).reverse(),
    ...journal.textPage(fullText), commands: withinBudget(commands.reverse(), 48 * 1024).reverse(),
    next_goal_offset: pageText(record.goal, 0, GOAL_BYTES).next_text_offset,
    touched_files: touched, file_uris: Object.fromEntries(withinBudget(uris, 24 * 1024)),
    restricted_files: Object.fromEntries(withinBudget(restricted, 8 * 1024)), usage: totals,
    cache_hit_rate: input > 0 && cached !== undefined ? Math.min(cached, input) / input : null,
  };
}


export async function runLiveOperation(operation, args, options) {
  const schema = Object.hasOwn(LIVE_OPERATIONS, operation) && LIVE_OPERATIONS[operation];
  if (!schema) throw Object.assign(new Error('Unknown Live operation.'), { status: 404 });
  checkArgs(operation, args, schema);
  if (operation === 'runs') return listRuns(args, options);
  if (operation === 'open') {
    const data = listRuns(args, options);
    let record;
    if (args.run_id) {
      try { record = readRun(args.run_id, options.sessionsDir); } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (record && (!inWorkspace(record.source_cwd || record.cwd, workspaceScope(options)) ||
          (data.scope === 'session' && (!data.bound_conversation_id ||
           record.host_conversation_id !== data.bound_conversation_id)))) record = null;
    }
    return { ...data, run_id: record?.run_id ?? null, requested_run: Boolean(record),
      stream: record ? stream(record, {}, options) : null };
  }
  const record = workspaceRun(args.run_id, options);
  if (operation === 'stream') {
    if (args.goal_offset !== undefined) {
      const page = pageText(record.goal, args.goal_offset, GOAL_BYTES);
      return { goal: page.full_text, next_goal_offset: page.next_text_offset };
    }
    return stream(record, args, options);
  }
  if (operation === 'reply') {
    if (!args.message.trim()) throw Object.assign(new Error('A reply message is required.'), { status: 400 });
    if (record.pending_tool_call?.tool !== 'ask_gemini') throw Object.assign(new Error('Run has no pending ask_gemini call.'), { status: 409 });
    return replyToolCall(args.run_id, args.call_id, args.message, options);
  }
  if (operation === 'steer') return steerRun(args.run_id, args.message, options);
  return interruptRun(args.run_id, options);
}

export { workspaceRun };

const RUN_ID = { type: 'string', pattern: '^[0-9a-f]{32}$' };
const SCOPE = {
  host_conversation_id: { type: 'string', description: 'Antigravity conversation to bind to.' },
  scope: { type: 'string', enum: ['session', 'all'], default: 'session' },
};
const STRING = { type: 'string' };
const BOOL = { type: 'boolean' };

export const LIVE_OPERATIONS = {
  runs: { properties: { limit: { type: 'integer', minimum: 1, maximum: 50 },
    offset: { type: 'integer', minimum: 0 }, include_consults: BOOL, session_id: STRING, ...SCOPE } },
  stream: { properties: {
    run_id: RUN_ID, max_events: { type: 'integer', minimum: 1, maximum: 200 },
    text_offset: { type: 'integer', minimum: 0 }, text_revision: { type: 'integer', minimum: 1 },
    goal_offset: { type: 'integer', minimum: 0 },
  }, required: ['run_id'] },
  interrupt: { properties: { run_id: RUN_ID }, required: ['run_id'] },
  steer: { properties: { run_id: RUN_ID, message: STRING }, required: ['run_id', 'message'] },
  reply: { properties: {
    run_id: RUN_ID, call_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,200}$' }, message: STRING,
  }, required: ['run_id', 'call_id', 'message'] },
  open: { properties: { run_id: RUN_ID, ...SCOPE } },
};

export function checkArgs(name, args, { properties, required = [] }) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !Object.hasOwn(properties, key)) || required.some((key) => !Object.hasOwn(args, key))) {
    throw Object.assign(new Error(`Unexpected or missing arguments for ${name}.`), { status: 400 });
  }
  for (const [key, value] of Object.entries(args)) {
    const field = properties[key];
    if (field.type === 'object') {
      checkArgs(key, value, field);
      continue;
    }
    let valid;
    if (field.type === 'string') {
      valid = typeof value === 'string' && (!field.pattern || new RegExp(field.pattern).test(value))
        && (!field.enum || field.enum.includes(value));
    } else if (field.type === 'array') {
      valid = Array.isArray(value) && field.items.type === 'string' && value.every((item) => typeof item === 'string');
    } else if (field.type === 'boolean') {
      valid = typeof value === 'boolean';
    } else {
      valid = (field.type === 'integer' ? Number.isSafeInteger(value) : Number.isFinite(value))
        && value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
    }
    if (!valid) throw Object.assign(new Error(`Invalid ${key}.`), { status: 400 });
  }
}

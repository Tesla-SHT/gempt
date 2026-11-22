import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonSafe, workspaceName } from '../magpie_plugin/lib/backend.mjs';
import { ACTIVE_STATES, interruptRun, readRun, runDirectory, stateEntries, steerRun } from './runs.mjs';
import { readHostContext } from './host-context.mjs';
import { resolvePath, withinPath } from './state.mjs';

const APP_VERSION = readJsonSafe(new URL('../package.json', import.meta.url))?.version
  || readJsonSafe(new URL('../../plugin.json', import.meta.url))?.version || '0.3.0';

export const APP_URI = 'ui://gempt/live.html';
export const APP_RESOURCE = {
  uri: APP_URI, name: 'GemPT Live', mimeType: 'text/html;profile=mcp-app',
  _meta: { ui: { prefersBorder: false } },
};
export const LIVE_META = {
  ui: { resourceUri: APP_URI },
  'com.google.antigravity/ui': { entrypoints: ['aux_pane', 'global'].map((type) => ({ type, title: 'GemPT Live' })) },
};
const RUN_ID = { type: 'string', pattern: '^[0-9a-f]{32}$' };
const SCOPE = {
  host_conversation_id: { type: 'string', description: 'Antigravity conversation to bind to.' },
  scope: { type: 'string', enum: ['session', 'all'], default: 'session' },
};
const MAX_HTML = 10 * 1024 * 1024;
const TEXT_BYTES = 96 * 1024;
const GOAL_BYTES = 16 * 1024;
const USAGE_FIELDS = {
  inputTokens: 'input_tokens', outputTokens: 'output_tokens', cachedInputTokens: 'cached_input_tokens',
  totalTokens: 'total_tokens', reasoningOutputTokens: 'reasoning_tokens',
};

function tool(name, description, properties, required) {
  return [name, { name, description,
    inputSchema: { type: 'object', properties, additionalProperties: false, ...(required ? { required } : {}) },
    _meta: { ui: { visibility: ['app'] } },
  }];
}

export const APP_TOOLS = Object.fromEntries([
  tool('gempt_app_runs', 'List runs in GemPT Live.', { limit: { type: 'integer', minimum: 1, maximum: 50 }, ...SCOPE }),
  tool('gempt_app_stream', 'Read a run snapshot or continue a long transcript.', {
    run_id: RUN_ID, max_events: { type: 'integer', minimum: 1, maximum: 200 },
    text_offset: { type: 'integer', minimum: 0 }, text_revision: { type: 'integer', minimum: 1 },
    goal_offset: { type: 'integer', minimum: 0 },
  }, ['run_id']),
  tool('gempt_app_interrupt', 'Interrupt the selected run.', { run_id: RUN_ID }, ['run_id']),
  tool('gempt_app_steer', 'Steer the selected run.', { run_id: RUN_ID, message: { type: 'string' } }, ['run_id', 'message']),
]);

export function readAppResource({ env = process.env } = {}) {
  const path = env.GEMPT_APP_HTML || new URL('./assets/mcp_app_live.html', import.meta.url);
  const fd = openSync(path, 'r');
  try {
    const size = Math.min(fstatSync(fd).size, MAX_HTML);
    const raw = Buffer.alloc(size);
    const bytes = readSync(fd, raw, 0, size, 0);
    const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(0, bytes));
    if (bytes >= MAX_HTML || !html.trim()) throw new Error('GemPT Live HTML must be non-empty and smaller than 10 MiB.');
    return { contents: [{ ...APP_RESOURCE, text: html }] };
  } finally {
    closeSync(fd);
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const text = (value, limit) => typeof value === 'string' ? Array.from(value).slice(0, limit).join('') : '';
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
  const chars = typeof value === 'string' ? Array.from(value) : [];
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
  return {
    run_id: record.run_id, session_id: text(record.session_id, 128), state: text(record.state, 32),
    cwd: bounded(record.cwd, 8192), worktree_path: bounded(record.worktree_path, 8192) || null,
    title: record.title, workspace_name: bounded(workspaceName(record.source_cwd || record.cwd), 512),
    host_conversation_id: record.host_conversation_id ?? null,
    can_control: Boolean(['running', 'waiting_gemini'].includes(record.state) && record.codex_thread_id && record.turn_id),
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

function inWorkspace(cwd, root) {
  return typeof cwd === 'string' && isAbsolute(cwd) && (!root || withinPath(resolvePath(cwd), root));
}

function workspaceRun(id, { root, sessionsDir }) {
  const record = readRun(id, sessionsDir);
  if (!inWorkspace(record.cwd, root) && !inWorkspace(record.source_cwd, root)) throw new Error('Run outside host workspace');
  return record;
}

function listRuns(args, { root, configPath, sessionsDir }) {
  const context = readHostContext(configPath);
  const active = typeof context.conversation_id === 'string' ? context.conversation_id : null;
  const bound = args.host_conversation_id || active || null;
  const scope = args.scope ?? 'session';
  const workspace = bound && bound === active ? workspaceName(array(context.workspace_paths)[0]) : '';
  let sessionCount = 0;
  const items = [];
  for (const { id } of stateEntries(sessionsDir)) {
    try {
      const record = readRun(id, sessionsDir);
      if (!inWorkspace(record.source_cwd || record.cwd, root)) continue;
      const matches = Boolean(bound && record.host_conversation_id === bound);
      if (matches) sessionCount++;
      if (scope === 'all' || matches) items.push(runSummary(record, true));
    } catch {
      continue;
    }
  }
  items.sort((left, right) => Number(ACTIVE_STATES.has(right.state)) - Number(ACTIVE_STATES.has(left.state)));
  return {
    bound_conversation_id: bound, scope, unbound_session: !bound && scope === 'session',
    bound_workspace_name: workspace, session_count: sessionCount,
    runs: withinBudget(items.slice(0, args.limit ?? 20), TEXT_BYTES),
    app_server: { name: 'gempt', version: APP_VERSION },
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
    while (position < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!count) break;
      let start = 0;
      for (let end = chunk.indexOf(10, start); end >= 0 && end < count; end = chunk.indexOf(10, start)) {
        const last = chunk.subarray(start, end);
        let raw;
        try { raw = JSON.parse((parts.length ? Buffer.concat([...parts, last]) : last).toString('utf8')); } catch { /* Incomplete or invalid JSON. */ }
        if (raw) this.event(raw, record);
        this.offset = position + end + 1;
        start = end + 1;
        parts = [];
      }
      if (start < count) parts.push(Buffer.from(chunk.subarray(start, count)));
      position += count;
    }
  }

  textPage(value) {
    const page = pageText(value, 0);
    if (page.next_text_offset === null) return page;
    let latest = [...this.transcripts].at(-1);
    if (!latest || latest[1] !== value) {
      latest = [nextRevision++, value];
      this.transcripts.set(...latest);
      if (this.transcripts.size > 2) this.transcripts.delete(this.transcripts.keys().next().value);
    }
    return { ...page, text_revision: latest[0] };
  }
}

function readJournal(path, record) {
  let fd;
  try {
    try { fd = openSync(path, 'r'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stat = fd === undefined ? null : fstatSync(fd);
    const identity = JSON.stringify([stat?.dev, stat?.ino, record.codex_thread_id, record.turn_id]);
    let journal = journals.get(path);
    if (!journal || journal.identity !== identity || (stat && stat.size < journal.offset)) journal = new Journal(identity);
    journals.delete(path);
    journals.set(path, journal);
    if (journals.size > 8) journals.delete(journals.keys().next().value);
    if (stat) journal.read(fd, stat.size, record);
    return journal;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function stream(record, args, { root, sessionsDir }) {
  const journal = readJournal(join(runDirectory(record.run_id, sessionsDir), 'events.jsonl'), record);
  const offset = args.text_offset || 0;
  if (offset && args.text_revision !== undefined) {
    const prior = journal.transcripts.get(args.text_revision);
    return prior === undefined ? { stale_text_revision: true } : pageText(prior, offset);
  }
  const result = object(record.result);
  const progress = object(record.progress);
  const messages = new Map([...journal.messages].map(([id, chunks]) => [id, chunks.join('')]));
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
  const cwd = resolvePath(record.cwd);
  const uris = touched.flatMap((file) => {
    try {
      const path = resolvePath(resolve(cwd, file));
      return withinPath(path, root || cwd) ? [[file, pathToFileURL(path).href]] : [];
    } catch { return []; }
  });
  const totals = usage(firstObject(result.usage, journal.usage, progress.token_usage, record.usage));
  const input = totals.input_tokens ?? 0;
  const cached = totals.cached_input_tokens;
  return {
    run: { ...runSummary(record), usage: totals }, timeline: withinBudget(timeline.reverse(), 56 * 1024).reverse(),
    ...journal.textPage(fullText), commands: withinBudget(commands.reverse(), 48 * 1024).reverse(),
    next_goal_offset: pageText(record.goal, 0, GOAL_BYTES).next_text_offset,
    touched_files: touched, file_uris: Object.fromEntries(withinBudget(uris, 24 * 1024)), usage: totals,
    cache_hit_rate: input > 0 && cached !== undefined ? Math.min(cached, input) / input : null,
  };
}

function result(text, data) {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function checkArgs(name, args, { properties, required = [] }) {
  if (Object.keys(args).some((key) => !Object.hasOwn(properties, key)) || required.some((key) => !Object.hasOwn(args, key))) {
    throw new Error(`Unexpected or missing arguments for ${name}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const field = properties[key];
    const valid = field.type === 'string'
      ? typeof value === 'string' && (!field.pattern || new RegExp(field.pattern).test(value)) && (!field.enum || field.enum.includes(value))
      : Number.isInteger(value) && value >= field.minimum && value <= (field.maximum ?? Infinity);
    if (!valid) throw new Error(`Invalid ${key}.`);
  }
}

export async function callAppTool(name, args = {}, opts = {}) {
  const options = { ...opts, configPath: opts.configPath ?? opts.config, root: opts.root && resolvePath(opts.root) };
  const live = name === 'gempt_live_view';
  const schema = live ? { properties: { run_id: RUN_ID, ...SCOPE } } : APP_TOOLS[name]?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  checkArgs(name, args, schema);
  if (name === 'gempt_app_runs') return result('GemPT Live runs.', listRuns(args, options));
  let record = args.run_id ? workspaceRun(args.run_id, options) : null;
  if (live) {
    const data = listRuns(args, options);
    if (data.scope === 'session' && record?.host_conversation_id !== data.bound_conversation_id) record = null;
    for (const run of data.runs) {
      if (record) break;
      try { record = workspaceRun(run.run_id, options); } catch { /* The run can disappear after listing. */ }
    }
    return result('Opened GemPT Live.', { ...data, run_id: record?.run_id ?? null,
      requested_run: Boolean(args.run_id), stream: record ? stream(record, {}, options) : null });
  }
  if (name === 'gempt_app_stream') {
    if (args.goal_offset !== undefined) {
      const page = pageText(record.goal, args.goal_offset, GOAL_BYTES);
      return result('GemPT Live task goal.', { goal: page.full_text, next_goal_offset: page.next_text_offset });
    }
    return result('GemPT Live snapshot.', stream(record, args, options));
  }
  if (name === 'gempt_app_steer') return result('Steering sent.', await steerRun(args.run_id, args.message, options));
  return result('Interrupt requested.', await interruptRun(args.run_id, options));
}

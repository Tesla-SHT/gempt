#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath, resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { GEMPT_VERSION } from './config.mjs';
import { resolvePath } from './state.mjs';
import { getBoardHead, getSwarmOverview, listRoster, postBoardMessage, updateWorker } from './swarm-bus.mjs';
import { TOOLS } from './tool-schemas.mjs';
import { handleBoardAction, handleSwarmAction } from './swarm-engine.mjs';

function tool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required ? { required } : {}),
    },
  };
}

export const BOARD_TOOLS = [
  tool('board_post',
    'Post a message to the shared GemPT Swarm board and notify @mentioned workers.',
    {
      text: { type: 'string', description: 'Message content. Use @name or @coordinator to wake/address targets.' },
      kind: { type: 'string', enum: ['message', 'summary', 'handoff', 'question', 'system'], default: 'message' },
      channel: { type: 'string' },
      request_id: { type: 'string' },
      reply_to_seq: { type: 'integer', description: 'Optional sequence number being replied to.' },
    }, ['text']),
  tool('board_read',
    'Read messages from the shared GemPT Swarm board, oldest first.',
    {
      channel: { type: 'string' },
      status: { type: 'boolean' },
      since: { type: 'integer', description: 'Return oldest messages after this sequence number.' },
      seqs: { type: 'array', items: { type: 'integer' }, description: 'Return exact sequence numbers.' },
      limit: { type: 'integer', description: 'Maximum messages to return (default 20).' },
    }),
  tool('board_ask',
    'Ask @coordinator a question on the Swarm board and park this worker until a reply arrives.',
    {
      question: { type: 'string', description: 'Specific question for the coordinator.' },
      reason: { type: 'string', enum: ['visual_check', 'clarification', 'decision', 'blocked'], default: 'clarification' },
      context: { type: 'string', description: 'Optional supporting context.' },
      media_paths: { type: 'array', items: { type: 'string' }, description: 'Optional local media/screenshot paths.' },
    }, ['question']),
  tool('board_roster',
    'List all workers on the current Swarm roster along with their states and board head.',
    {}),
  tool('board_wait', 'Park until a concerning post arrives. Pass the highest sequence actually read. End your turn if parked.',
    { since: { type: 'integer', minimum: 0 }, mentions_only: { type: 'boolean', default: true }, channel: { type: 'string' } }, ['since']),
  tool('board_swarm', 'Inspect this swarm, manage channels and add, kill or switch your own helpers.',
    Object.fromEntries(Object.entries(TOOLS.find((t) => t.name === 'gpt_swarm').inputSchema.properties)
      .filter(([key]) => ['action', 'op', 'channel', 'channels', 'topic', 'targets', 'name', 'brief', 'role', 'fork', 'tasks',
        'n', 'model', 'tier', 'workspace', 'access', 'cli', 'reason', 'timeout_sec'].includes(key))
      .map(([key, schema]) => [key, key === 'action' ? { type: 'string', enum: ['status', 'add', 'kill', 'model', 'channel'] } : schema])), ['action']),
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textResult = (data, extras) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], ...extras });
const errorResponse = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

export async function handleBoardMcpTool(name, args = {}, env = process.env, overrides = {}) {
  const swarmId = String(overrides.swarmId || env.GEMPT_SWARM_ID || '').trim();
  if (!swarmId) throw new Error('GEMPT_SWARM_ID is required for board MCP.');
  const agentName = String(overrides.agentName || env.GEMPT_AGENT_NAME || 'worker').trim().toLowerCase();
  const sessionsDir = resolveSessionsDir(overrides.sessionsDir || env.GEMPT_SESSIONS_DIR);
  const configPath = resolveConfigPath(overrides.configPath || env.GEMPT_CONFIG);

  const options = { ...overrides, sessionsDir, configPath, env, actor: agentName };
  const runId = overrides.runId || env.GEMPT_RUN_ID || null;
  if (['board_post', 'board_read', 'board_wait'].includes(name)) {
    const result = await handleBoardAction({
      text: args.text, kind: args.kind, reply_to_seq: args.reply_to_seq, request_id: args.request_id, channel: args.channel,
      since: args.since, seqs: args.seqs, limit: args.limit, status: args.status, mentions_only: args.mentions_only,
      meta: runId ? { run_id: runId } : undefined,
      action: name.slice(6), swarm_id: swarmId, from: agentName,
    }, options);
    return textResult(result);
  }
  if (name === 'board_swarm') {
    const schema = BOARD_TOOLS.find((t) => t.name === name).inputSchema;
    if (!schema.properties.action.enum.includes(args.action)) throw new Error('Unsupported worker swarm action.');
    const clean = Object.fromEntries(Object.entries(args).filter(([k]) => Object.hasOwn(schema.properties, k)));
    const overview = await getSwarmOverview(swarmId, { sessionsDir, messageLimit: 0 });
    const parent = overview?.roster.find((w) => w.name === agentName);
    return textResult(await handleSwarmAction({ ...clean, swarm_id: swarmId, added_by: agentName,
      host_conversation_id: overview?.swarm.host_conversation_id, cwd: parent?.worktree_path || parent?.source_cwd || overview?.swarm.cwd }, options));
  }
  if (name === 'board_ask') {
    const q = String(args.question || '').trim();
    if (!q) throw new Error('`question` is required for board_ask.');
    const ctxLine = args.context ? `\n\nContext: ${String(args.context).trim()}` : '';
    const mediaLines = Array.isArray(args.media_paths)
      ? args.media_paths.filter(Boolean).map((p) => `\nScreenshot: ${p} | attachment`).join('')
      : '';
    const message = await postBoardMessage(swarmId, {
      from: agentName,
      kind: 'question',
      text: `@coordinator ${q}${ctxLine}${mediaLines}`,
      meta: { ...(runId ? { run_id: runId } : {}), reason: args.reason || 'clarification' },
    }, { sessionsDir });
    try {
      await updateWorker(swarmId, agentName, { state: 'waiting_reply', parked_on: `board_ask:${message.seq}` }, { sessionsDir });
    } catch { /* Sender may not be a roster worker (e.g., external helper). */ }
    return textResult({ ok: true, swarm_id: swarmId, message, head: message.seq });
  }
  if (name === 'board_roster') {
    const roster = await listRoster(swarmId, { sessionsDir });
    const head = await getBoardHead(swarmId, { sessionsDir });
    return textResult({ ok: true, swarm_id: swarmId, head, roster });
  }
  throw new Error(`Unknown board tool: ${name}`);
}

async function dispatch(request, env, overrides) {
  const { id, method, params = {} } = request;
  if (id == null || String(method).startsWith('notifications/')) return;
  const response = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return response({
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gempt-board', version: GEMPT_VERSION },
        });
      case 'ping':
        return response({});
      case 'tools/list':
        return response({ tools: BOARD_TOOLS });
      case 'tools/call': {
        const name = String(params?.name || '');
        const args = params?.arguments ?? {};
        if (!isObject(args)) throw new Error('Tool arguments must be a JSON object.');
        try {
          return response(await handleBoardMcpTool(name, args, env, overrides));
        } catch (error) {
          return response({ content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true });
        }
      }
      default:
        return errorResponse(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return errorResponse(id, -32603, error.message);
  }
}

export async function serveBoardStdio(input = process.stdin, output = process.stdout, env = process.env, overrides = {}) {
  const pending = new Set();
  const write = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch (error) {
      write(errorResponse(null, -32700, `Parse error: ${error.message}`));
      continue;
    }
    if (!isObject(request)) continue;
    const task = dispatch(request, env, overrides).then(write);
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  await serveBoardStdio();
}

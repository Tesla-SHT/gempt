import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expandUser, resolveConfigPath } from './backend.mjs';
import { openAppServerSocket } from './app-server-socket.mjs';

export const UNAVAILABLE = '未检测到 Magpie 插件托管的共享 codex app-server（请先启动 Magpie 并确认 GemPT 插件已启用）。';
export const PROVIDER = 'gempt_gateway';
export const TERMINAL_INTERRUPT_ERR = /not found|no active|already (?:completed|finished|interrupted|stopped|ended)|unknown turn|invalid turn/i;
export const SANDBOX_TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
export const DEVELOPER_INSTRUCTIONS = 'Use ask_gemini for visual checks, clarifications, decisions, or blockers that require the coordinating Gemini. Provide a specific question and include the relevant context and local media paths when appropriate.';
export const SWARM_DEVELOPER_INSTRUCTIONS = 'You are a worker on a shared GemPT Swarm message board. Use board_post to coordinate with peers (@peer-name) and report final results (@coordinator [done] ...), board_read to read board messages, and board_roster to inspect teammates.';
export const ASK_GEMINI = {
  type: 'function',
  name: 'ask_gemini',
  description: 'Ask the coordinating Gemini for input and continue this turn when it replies.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: ['visual_check', 'clarification', 'decision', 'blocked'] },
      question: { type: 'string' },
      context: { type: 'string' },
      media_paths: { type: 'array', items: { type: 'string' } },
    },
    required: ['reason', 'question'],
    additionalProperties: false,
  },
};
export const BOARD_POST = {
  type: 'function',
  name: 'board_post',
  description: 'Post a message to the shared Swarm message board. Mention peers with @name or @coordinator to wake/notify them.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Message text. Use @name or @coordinator to address recipients.' },
      kind: { type: 'string', enum: ['message', 'summary', 'question', 'system'], description: 'Optional message kind (default: message).' },
      reply_to_seq: { type: 'integer', description: 'Optional board message sequence number being replied to.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
};
export const BOARD_READ = {
  type: 'function',
  name: 'board_read',
  description: 'Read messages from the shared Swarm message board, oldest first.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'integer', description: 'Return messages with seq > since.' },
      seqs: { type: 'array', items: { type: 'integer' }, description: 'Return specific messages by sequence number.' },
      limit: { type: 'integer', description: 'Maximum messages to return (default 20).' },
    },
    additionalProperties: false,
  },
};
export const BOARD_ROSTER = {
  type: 'function',
  name: 'board_roster',
  description: 'List all workers in the current Swarm along with their states and board head.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};
export const SWARM_TOOLS = [BOARD_POST, BOARD_READ, BOARD_ROSTER];

export const textInput = (text) => [{ type: 'text', text }];

export function appServerStatePath(configPath, env = process.env) {
  const override = env.GEMPT_APP_SERVER_STATE?.trim();
  return override ? resolve(expandUser(override)) : join(dirname(resolveConfigPath(configPath)), 'app-server.json');
}

export function readAppServerState(configPath, env) {
  try {
    const state = JSON.parse(readFileSync(appServerStatePath(configPath, env), 'utf8'));
    if (state.status === 'running') return state;
  } catch { /* Missing, unreadable or stopped. */ }
  throw new Error(UNAVAILABLE);
}

export async function connectAppServer(state, onEvent = () => {}, { timeoutMs = 3000 } = {}) {
  let socket;
  let id = 0;
  const pending = new Map();
  let failure;
  let onFailure;
  const disconnected = (err) => {
    if (failure) return;
    failure = err;
    for (const request of pending.values()) request.reject(err);
    onFailure?.(err);
    socket?.close();
  };
  const received = (data) => {
    try {
      const message = JSON.parse(data);
      if (message.method) {
        onEvent(message);
        return;
      }
      const request = pending.get(message.id);
      if (request) {
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { rpcError: true }));
        else request.resolve(message.result);
      }
    } catch (err) {
      disconnected(err);
    }
  };

  const send = (message) => {
    if (failure) throw failure;
    socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
  };
  const request = async (method, params, limit = 4000) => {
    const requestId = ++id;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`${method} timed out.`)), limit);
        send({ id: requestId, method, params });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  };

  try {
    const url = new URL(state.ws_url);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
        || url.hash || state.auth_header?.toLowerCase() !== 'authorization'
        || typeof state.auth_token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(state.auth_token)) throw new Error('Invalid endpoint.');
    socket = await openAppServerSocket(url, state.auth_token, timeoutMs, received, disconnected);
    await request('initialize', {
      clientInfo: { name: 'gempt', version: '2.0' }, capabilities: { experimentalApi: true },
    }, timeoutMs);
    send({ method: 'initialized' });
  } catch (err) {
    socket?.close();
    throw new Error(UNAVAILABLE, { cause: err });
  }
  return {
    request,
    get disconnected() { return Boolean(failure); },
    reply: (id, result) => send({ id, result }),
    reject: (id) => send({ id, error: { code: -32601, message: 'Unsupported server request' } }),
    onFailure(callback) {
      onFailure = callback;
      if (failure) callback(failure);
    },
    close: () => socket.close(),
  };
}

export function approvalReply(method, params, sandbox) {
  const full = sandbox === 'danger-full-access';
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { decision: full || (params.kind === 'writeStdin' && !params.additionalPermissions
        && !params.networkApprovalContext) ? 'accept' : 'decline' };
    case 'item/fileChange/requestApproval':
      return { decision: full ? 'accept' : 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: full ? params.permissions : {}, scope: 'turn' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: full ? 'approved' : { denied: { rejection: 'Configured sandbox' } } };
    default:
      return null;
  }
}

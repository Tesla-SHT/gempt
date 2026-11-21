import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expandUser, resolveConfigPath } from './backend.mjs';

export const UNAVAILABLE = '未检测到 Magpie 插件托管的共享 codex app-server（请先启动 Magpie 并确认 GemPT 插件已启用）。';
export const PROVIDER = 'gempt_gateway';
export const SANDBOX_TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
export const DEVELOPER_INSTRUCTIONS = 'Use ask_gemini for visual checks, clarifications, decisions, or blockers that require the coordinating Gemini. Provide a specific question and include the relevant context and local media paths when appropriate.';
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
  try {
    const url = new URL(state.ws_url);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
        || url.hash || state.auth_header?.toLowerCase() !== 'authorization'
        || typeof state.auth_token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(state.auth_token)) throw new Error('Invalid endpoint.');
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${state.auth_token}` } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket upgrade timed out.')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket upgrade failed.')); }, { once: true });
    });
  } catch (err) {
    socket?.close();
    throw new Error(UNAVAILABLE, { cause: err });
  }

  let id = 0;
  const pending = new Map();
  let failure;
  let onFailure;
  const disconnected = (err) => {
    if (failure) return;
    failure = err;
    for (const request of pending.values()) request.reject(err);
    onFailure?.(err);
    socket.close();
  };
  socket.addEventListener('close', () => disconnected(new Error('Codex app-server closed the WebSocket.')));
  socket.addEventListener('error', () => disconnected(new Error('Codex app-server WebSocket failed.')));
  socket.addEventListener('message', ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.method) {
        onEvent(message);
        return;
      }
      const request = pending.get(message.id);
      if (request) {
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    } catch (err) {
      disconnected(err);
    }
  });

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
    await request('initialize', {
      clientInfo: { name: 'gempt', version: '2.0' }, capabilities: { experimentalApi: true },
    }, timeoutMs);
    send({ method: 'initialized' });
  } catch (err) {
    socket.close();
    throw new Error(UNAVAILABLE, { cause: err });
  }
  return {
    request,
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

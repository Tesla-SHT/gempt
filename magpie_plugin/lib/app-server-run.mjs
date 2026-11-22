import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { approvalReply, ASK_GEMINI, connectAppServer, DEVELOPER_INSTRUCTIONS, PROVIDER, readAppServerState, SANDBOX_TYPES, textInput } from './app-server-client.mjs';
import { saveRun, toolReplyPath } from '../../core/runs.mjs';

export class TurnInterrupted extends Error {}

export async function runAppServer({ configPath, env, runFile, sessionId, onIdentity, prompt, cwd, model,
  effort, sandbox, approvalPolicy, threadId, gatewayUrl, timeoutSec, sandboxUpgraded }) {
  const start = Date.now();
  const deadline = start + timeoutSec * 1000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const directory = dirname(runFile);
  const record = JSON.parse(readFileSync(runFile, 'utf8'));
  const state = readAppServerState(configPath, env);
  if (state.gateway_url?.replace(/\/+$/, '') !== gatewayUrl) {
    throw new Error('共享 codex app-server 的 Magpie 网关与 GemPT 配置不一致。');
  }
  const messages = new Map();
  const commands = new Map();
  const touched = new Set();
  const tools = new Map();
  let usage = {};
  let lastWrite = 0;
  let client;
  let acceptTurn = false;
  let terminal;
  let complete;
  let fail;
  const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // The socket can close while a thread/turn RPC is still awaiting its response.
  completion.catch(() => {});
  const progress = { phase: 'connecting', thread_id: threadId || null, turn_id: null, last_message: '',
    recent_commands: [], touched_files: [], token_usage: {} };
  const save = (force = false) => {
    if (force || Date.now() - lastWrite >= 500) {
      lastWrite = Date.now();
      progress.updated_at = new Date(lastWrite).toISOString();
      saveRun(runFile, { ...record, session_id: sessionId, progress });
    }
  };
  const identity = (id, turnId = progress.turn_id) => {
    if (id === record.codex_thread_id && turnId === progress.turn_id) return;
    record.codex_thread_id = progress.thread_id = id;
    record.turn_id = progress.turn_id = turnId;
    save(true);
    onIdentity(id, turnId, record.sandbox);
  };
  const pendingChanged = () => {
    const pending = tools.values().next().value;
    record.pending_tool_call = pending || null;
    progress.phase = record.state = pending ? 'waiting_gemini' : 'running';
    save(true);
  };
  const item = (entry) => {
    if (entry.type === 'agentMessage') {
      messages.set(entry.id, entry.text);
      progress.last_message = entry.text.slice(-1500);
    } else if (entry.type === 'commandExecution') {
      commands.set(entry.id, { command: entry.command, exit_code: entry.exitCode ?? null,
        output: (entry.aggregatedOutput || '').slice(-4000) });
      progress.recent_commands = [...commands.values()].slice(-5);
    } else if (entry.type === 'fileChange') {
      for (const change of entry.changes) touched.add(change.path);
      progress.touched_files = [...touched].slice(-50);
    }
  };

  const onEvent = ({ method, params = {}, id, ...extra }) => {
    // Shared codex app-server broadcasts thread/started to all clients. Never overwrite
    // progress.thread_id from broadcasts — bind strictly from thread/start|resume RPC response.
    if (method === 'thread/started') {
      if (!progress.thread_id || params.thread?.id !== progress.thread_id) return;
      appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ method, params, id, ...extra }) + '\n');
      return;
    }
    const eventThread = params.threadId ?? params.conversationId;
    if (progress.thread_id && eventThread && eventThread !== progress.thread_id) {
      if (id !== undefined) client.reject(id);
      return;
    }
    appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ method, params, id, ...extra }) + '\n');
    const related = eventThread === progress.thread_id;
    const eventTurn = params.turnId ?? params.turn?.id;
    const sameTurn = !eventTurn || !progress.turn_id || eventTurn === progress.turn_id;
    if (id !== undefined) {
      if (!related || !sameTurn || terminal) {
        client.reject(id);
      } else if (method === 'item/tool/call') {
        if (params.tool === 'ask_gemini' && /^[A-Za-z0-9_-]{1,200}$/.test(params.callId)) {
          identity(params.threadId, params.turnId);
          tools.set(id, { call_id: params.callId, tool: 'ask_gemini',
            arguments: params.arguments, requested_at: new Date().toISOString() });
          pendingChanged();
        } else client.reply(id, { success: false, contentItems: [{ type: 'inputText', text: 'Unsupported tool.' }] });
      } else {
        const approval = approvalReply(method, params, sandbox);
        if (approval) client.reply(id, approval);
        else client.reject(id);
      }
      return;
    }
    if (!acceptTurn || !related || !sameTurn) return;
    switch (method) {
      case 'turn/started':
        progress.phase = 'running';
        identity(params.threadId, eventTurn);
        break;
      case 'turn/completed':
        identity(params.threadId, eventTurn);
        terminal = params.turn;
        tools.clear();
        record.state = 'running';
        record.pending_tool_call = null;
        progress.phase = terminal.status;
        save(true);
        complete(terminal);
        break;
      case 'serverRequest/resolved':
        if (tools.delete(params.requestId)) pendingChanged();
        break;
      case 'item/started':
      case 'item/completed':
        item(params.item);
        save(true);
        break;
      case 'item/agentMessage/delta': {
        const text = (messages.get(params.itemId) || '') + params.delta;
        messages.set(params.itemId, text);
        progress.last_message = text.slice(-1500);
        save();
        break;
      }
      case 'thread/tokenUsage/updated': {
        const last = params.tokenUsage.last;
        usage = { input_tokens: last.inputTokens, output_tokens: last.outputTokens, cached_input_tokens: last.cachedInputTokens,
          total_tokens: last.totalTokens, reasoning_tokens: last.reasoningOutputTokens };
        progress.token_usage = usage;
        save();
        break;
      }
    }
  };

  let poll;
  let timeout;
  save(true);
  try {
    client = await connectAppServer(state, onEvent);
    client.onFailure(fail);
    const common = { cwd, model, modelProvider: PROVIDER, sandbox, approvalPolicy, developerInstructions: DEVELOPER_INSTRUCTIONS };
    const thread = threadId
      ? await client.request('thread/resume', { ...common, threadId, excludeTurns: true }, remaining())
      : await client.request('thread/start', { ...common, dynamicTools: [ASK_GEMINI], allowProviderModelFallback: false }, remaining());
    if (threadId && thread.thread.id !== threadId) throw new Error('Codex returned a different thread on resume.');
    const sandboxTypes = Object.values(SANDBOX_TYPES);
    const actual = sandboxTypes.indexOf(thread.sandbox?.type);
    const fold = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (!thread.cwd || fold(thread.cwd) !== fold(cwd) || actual < 0 || actual > sandboxTypes.indexOf(SANDBOX_TYPES[sandbox])
        || (sandboxUpgraded && actual !== sandboxTypes.indexOf(SANDBOX_TYPES[sandbox]))
        || thread.modelProvider !== PROVIDER) {
      throw new Error('Codex app-server did not confirm the requested workspace, sandbox and Magpie provider.');
    }
    record.sandbox = Object.keys(SANDBOX_TYPES)[actual];
    record.model = model;
    if (sandboxUpgraded) record.sandbox_upgraded = true;
    identity(thread.thread.id);

    acceptTurn = true;
    const result = await client.request('turn/start', { threadId: progress.thread_id, input: textInput(prompt), model, effort,
      cwd, approvalPolicy, sandboxPolicy: { type: SANDBOX_TYPES[sandbox] } }, remaining());
    identity(progress.thread_id, result.turn.id);
    poll = setInterval(() => {
      try {
        const [id, pending] = tools.entries().next().value || [];
        if (!pending) return;
        const reply = JSON.parse(readFileSync(toolReplyPath(directory, pending.call_id), 'utf8'));
        if (typeof reply.answer !== 'string' || typeof reply.success !== 'boolean') throw new Error('Invalid ask_gemini reply.');
        client.reply(id, { success: reply.success, contentItems: [{ type: 'inputText', text: reply.answer }] });
        tools.delete(id);
        pendingChanged();
      } catch (err) {
        if (!['ENOENT', 'EPERM', 'EBUSY'].includes(err.code)) fail(err);
      }
    }, 100);
    timeout = setTimeout(() => fail(new Error(`Codex turn timed out after ${timeoutSec}s.`)), remaining());
    const turn = await completion;
    if (turn.status === 'interrupted') throw new TurnInterrupted('Codex turn interrupted.');
    if (turn.status !== 'completed') throw new Error(turn.error?.message || `Codex turn ${turn.status}.`);
    const text = [...messages.values()].map((value) => value.trim()).filter(Boolean).join('\n\n');
    if (!text) throw new Error('Codex finished without an assistant message.');
    return { threadId: progress.thread_id, turnId: progress.turn_id, sandbox: Object.keys(SANDBOX_TYPES)[actual],
      text, elapsedSec: (Date.now() - start) / 1000, commands: [...commands.values()], usage };
  } catch (err) {
    if (err.message.includes('timed out') && progress.turn_id) {
      await client.request('turn/interrupt', { threadId: progress.thread_id, turnId: progress.turn_id }).catch(() => {});
    }
    throw err;
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
    client?.close();
  }
}

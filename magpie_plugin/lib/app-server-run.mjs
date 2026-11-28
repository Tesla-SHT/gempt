import { deadlineForTimeout, scheduleTimeout } from '../../core/timeout.mjs';
import { getBoardMcpSpec } from '../../core/runners/journal.mjs';
import { cacheHitRatio, normalizeUsage } from '../../core/token-usage.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import {
  approvalReply, ASK_GEMINI, connectAppServer, DEVELOPER_INSTRUCTIONS, PROVIDER,
  readAppServerState, readServerTurn, terminalTurn, SANDBOX_TYPES, SWARM_DEVELOPER_INSTRUCTIONS, TERMINAL_INTERRUPT_ERR, textInput,
} from './app-server-client.mjs';
import { saveRun, toolReplyPath } from '../../core/runs.mjs';
import { readJsonSafe, resolveConfigPath } from '../../core/config.mjs';

export class TurnInterrupted extends Error {}

export async function runAppServer({ configPath, env, runFile, sessionId, onIdentity, prompt, cwd, model,
  effort, sandbox, approvalPolicy, threadId, gatewayUrl, timeoutSec, sandboxUpgraded, interruptConfirmMs = 3000,
  sessionsDir, swarmId, swarmAgent, nativeFork, onForkMode, useBoardMcp }) {
  const isSwarm = Boolean(swarmId && swarmAgent);
  const board = isSwarm ? await import('../../core/board-mcp.mjs') : null;
  const swarmTools = board?.BOARD_TOOLS.filter((tool) => tool.name !== 'board_ask').map((t) => ({ type: 'function', ...t })) || [];
  const isBoardTool = (name) => swarmTools.some((t) => t.name === name);
  const swarmHooks = [];
  const trackSwarmHook = (promise) => {
    const tracked = Promise.resolve(promise).catch(() => {});
    swarmHooks.push(tracked);
    tracked.finally(() => {
      const idx = swarmHooks.indexOf(tracked);
      if (idx >= 0) swarmHooks.splice(idx, 1);
    });
  };
  const start = Date.now();
  let deadline = deadlineForTimeout(timeoutSec, start);
  let pausedAt = null;
  let pausedMs = 0;
  let observeTurn;
  const observedTurn = new Promise((resolve) => { observeTurn = resolve; });
  const remaining = () => deadline === null ? Infinity : Math.max(1, Math.round(deadline * 1000 - (pausedAt ?? Date.now())));
  const directory = dirname(runFile);
  const record = JSON.parse(readFileSync(runFile, 'utf8'));
  const cacheSwarmId = swarmId || record.swarm_id;
  async function registerCache(threadId, parentThreadId, resume) {
    if (!state.proxy_port || !(parentThreadId || resume || cacheSwarmId)) return;
    const port = state.proxy_port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Codex proxy port.');
    const ipc = readJsonSafe(join(dirname(resolveConfigPath(configPath)), `page-server-${port}.ipc`));
    if (!ipc?.token || ipc.port !== port) throw new Error('Codex proxy registration unavailable.');
    const response = await fetch(`http://127.0.0.1:${port}/api/internal/cache-key`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(5000, remaining())),
      headers: { 'content-type': 'application/json', 'x-gempt-ipc-token': ipc.token },
      body: JSON.stringify({ threadId, parentThreadId, resume, runId: record.run_id, swarmId: cacheSwarmId, model }),
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Codex proxy registration failed (HTTP ${response.status}).`);
  }
  record.cli = 'codex';
  record.execution_timeout_sec = timeoutSec || null;
  record.deadline = deadline;
  const state = readAppServerState(configPath, env);
  if (state.gateway_url?.replace(/\/+$/, '') !== gatewayUrl) {
    throw new Error('共享 codex app-server 的 Magpie 网关与 GemPT 配置不一致。');
  }
  const messages = new Map();
  const commands = new Map();
  const touched = new Set();
  const tools = new Map();
  let usage = {};
  let usageBaseline;
  let boardToolErrors = 0;
  let lastWrite = 0;
  let client;
  let acceptTurn = false;
  let observedTurnId;
  let terminal;
  let confirmResolve;
  let complete;
  let fail;
  let completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // The socket can close while a thread/turn RPC is still awaiting its response.
  completion.catch(() => {});
  const progress = { phase: 'connecting', thread_id: threadId || null, turn_id: null, last_message: '',
    recent_commands: [], touched_files: [], token_usage: {} };
  let poll;
  let cancelTimeout;
  const armTimeout = () => {
    cancelTimeout?.();
    cancelTimeout = undefined;
    if (deadline === null || pausedAt !== null || terminal) return;
    cancelTimeout = scheduleTimeout(() => fail(new Error(`Codex turn timed out after ${timeoutSec}s.`)), remaining() / 1000);
  };
  const finishPause = () => {
    if (pausedAt === null) return;
    const deltaMs = Math.max(0, Date.now() - pausedAt);
    pausedAt = null;
    pausedMs += deltaMs;
    if (deadline !== null) deadline += deltaMs / 1000;
    record.waiting_since = null;
    record.waiting_gemini_sec = Math.round((pausedMs / 1000) * 1000) / 1000;
    record.deadline = deadline;
  };
  const notifyTerminal = (turn) => {
    terminal = turn;
    confirmResolve?.(turn);
  };
  const waitForTerminal = (ms, socketClient) => {
    if (terminal || ms <= 0) return Promise.resolve(terminal);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        confirmResolve = undefined;
        resolve(terminal);
      };
      const timer = setTimeout(done, ms);
      confirmResolve = done;
      socketClient?.onFailure?.(done);
    });
  };
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
    if (pending && pausedAt === null) {
      pausedAt = Date.now();
      cancelTimeout?.();
      cancelTimeout = undefined;
      record.waiting_since = new Date(pausedAt).toISOString();
    } else if (!pending && pausedAt !== null) {
      finishPause();
      armTimeout();
    }
    record.pending_tool_call = pending || null;
    if (tools.size > 1) record.pending_tool_calls = [...tools.values()];
    else delete record.pending_tool_calls;
    progress.phase = record.state = pending ? 'waiting_gemini' : 'running';
    save(true);
  };
  const item = (entry) => {
    if (entry.type === 'agentMessage') {
      messages.set(entry.id, entry.text);
      progress.last_message = entry.text;
    } else if (entry.type === 'commandExecution') {
      commands.set(entry.id, { command: entry.command, exit_code: entry.exitCode ?? null,
        output: entry.aggregatedOutput || '' });
      progress.recent_commands = [...commands.values()].slice(-5);
    } else if (entry.type === 'fileChange') {
      for (const change of entry.changes) touched.add(change.path);
      progress.touched_files = [...touched].slice(-50);
    }
  };

  const onEvent = ({ method, params = {}, id, ...extra }) => {
    if (method === 'turn/diff/updated' && id === undefined) return;
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
    const related = eventThread === progress.thread_id;
    const eventTurn = params.turnId ?? params.turn?.id;
    const sameTurn = !eventTurn || !progress.turn_id || eventTurn === progress.turn_id;
    if (acceptTurn && related && sameTurn && eventTurn) {
      if (method === 'turn/started' || method === 'turn/completed'
          || (id !== undefined && method === 'item/tool/call'
            && (params.tool === 'ask_gemini' || isBoardTool(params.tool)))) {
        observedTurnId = eventTurn;
        observeTurn(eventTurn);
      }
      if (method === 'turn/completed') notifyTerminal(params.turn);
    }
    if (acceptTurn && related && sameTurn && method === 'thread/tokenUsage/updated') {
      const last = normalizeUsage(params.tokenUsage.last);
      const total = normalizeUsage(params.tokenUsage.total);
      if (Object.keys(total).length) {
        // Codex totals are thread-wide. Exclude history already charged to a parent or earlier turn.
        usageBaseline ??= Object.fromEntries(Object.entries(total).map(([key, value]) =>
          [key, threadId || record.fork_mode === 'native' ? Math.max(0, value - (last[key] ?? 0)) : 0]));
        usage = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - (usageBaseline[key] ?? 0))]));
      } else {
        for (const [key, value] of Object.entries(last)) usage[key] = (usage[key] ?? 0) + value;
      }
      usage.cache_hit_ratio = cacheHitRatio(usage);
      extra.runUsage = usage;
    }
    appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ method, params, id, ...extra }) + '\n');
    if (id !== undefined) {
      if (!acceptTurn || !related || !sameTurn || terminal) {
        client.reject(id);
      } else if (method === 'item/tool/call') {
        if (params.tool === 'ask_gemini' && /^[A-Za-z0-9_-]{1,200}$/.test(params.callId)) {
          identity(params.threadId, params.turnId);
          tools.set(id, { call_id: params.callId, tool: 'ask_gemini',
            arguments: params.arguments, requested_at: new Date().toISOString() });
          pendingChanged();
          if (isSwarm) {
            trackSwarmHook((async () => {
              const { postBoardMessage } = await import('../../core/swarm-bus.mjs');
              const q = String(params.arguments?.question || '').trim() || 'Needs coordinator input.';
              const ctxLine = params.arguments?.context ? `\n\nContext: ${String(params.arguments.context).trim()}` : '';
              const mediaLines = Array.isArray(params.arguments?.media_paths)
                ? params.arguments.media_paths.filter(Boolean).map((p) => `\nScreenshot: ${p} | ask_gemini attachment`).join('')
                : '';
              await postBoardMessage(swarmId, {
                from: swarmAgent,
                kind: 'question',
                text: `@coordinator ${q}${ctxLine}${mediaLines}`,
                meta: {
                  call_id: params.callId,
                  run_id: record.run_id,
                  reason: params.arguments?.reason || 'clarification',
                },
              }, { sessionsDir, workerTurn: { name: swarmAgent, runId: record.run_id }, parkForReply: true });
            })());
          }
        } else if (isBoardTool(params.tool)) {
          identity(params.threadId, params.turnId);
          trackSwarmHook((async () => {
            try {
              const toolArgs = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
              const result = await board.handleBoardMcpTool(params.tool, toolArgs, env, {
                swarmId, agentName: swarmAgent, sessionsDir, configPath, runId: record.run_id,
              });
              const payload = JSON.parse(result.content[0].text);
              if (params.tool === 'board_post') {
                payload.seq = payload.message.seq;
                payload.mentions = payload.message.mentions;
              }
              if (!client.disconnected) {
                client.reply(id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(payload) }] });
              }
            } catch (toolErr) {
              boardToolErrors += 1;
              if (!client.disconnected) {
                client.reply(id, { success: false, contentItems: [{ type: 'inputText', text: String(toolErr?.message || toolErr) }] });
              }
            }
          })());
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
        if (pausedAt === null) progress.phase = 'running';
        identity(params.threadId, eventTurn);
        break;
      case 'turn/completed':
        finishPause();
        cancelTimeout?.();
        cancelTimeout = undefined;
        identity(params.threadId, eventTurn);
        tools.clear();
        record.state = 'running';
        record.pending_tool_call = null;
        delete record.pending_tool_calls;
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
        progress.last_message = text;
        save();
        break;
      }
      case 'thread/tokenUsage/updated': {
        progress.token_usage = usage;
        save();
        break;
      }
    }
  };

  function finishTurn(turn) {
    for (const entry of turn.items || []) item(entry);
    if (turn.status === 'interrupted') throw new TurnInterrupted('Codex turn interrupted.');
    if (turn.status !== 'completed') throw new Error(turn.error?.message || `Codex turn ${turn.status}.`);
    const text = [...messages.values()].map((value) => value.trim()).filter(Boolean).join('\n\n');
    if (!text) throw new Error('Codex finished without an assistant message.');
    return { forkMode: record.fork_mode, threadId: progress.thread_id, turnId: progress.turn_id, sandbox: record.sandbox,
      boardToolMode: record.board_tool_mode, boardToolErrors,
      text, elapsedSec: (Date.now() - start) / 1000, commands: [...commands.values()], usage };
  }

  save(true);
  try {
    client = await connectAppServer(state, onEvent);
    client.onFailure(fail);
    const developerInstructions = isSwarm
      ? `${DEVELOPER_INSTRUCTIONS}\n${SWARM_DEVELOPER_INSTRUCTIONS}`
      : DEVELOPER_INSTRUCTIONS;
    const dynamicTools = isSwarm ? [ASK_GEMINI, ...swarmTools] : [ASK_GEMINI];
    const common = { cwd, model, modelProvider: PROVIDER, sandbox, approvalPolicy, developerInstructions };
    // Fork and resume inherit dynamic tools. A child of a solo thread needs its own board MCP identity.
    const spec = useBoardMcp && getBoardMcpSpec({ swarmId, swarmAgent, sessionsDir, configPath, env });
    const inherited = spec ? { ...common, config: { mcp_servers: { gempt_board: {
      command: spec.command[0], args: spec.command.slice(1), env: spec.environment,
    } } } } : common;
    const sandboxTypes = Object.values(SANDBOX_TYPES);
    const fold = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    function confirmedSandbox(thread) {
      const actual = sandboxTypes.indexOf(thread.sandbox?.type);
      const requested = sandboxTypes.indexOf(SANDBOX_TYPES[sandbox]);
      if (!thread.cwd || fold(thread.cwd) !== fold(cwd) || actual < 0 || actual > requested
          || (sandboxUpgraded && actual !== requested) || thread.modelProvider !== PROVIDER) {
        throw new Error('Codex app-server did not confirm the requested workspace, sandbox and Magpie provider.');
      }
      return actual;
    }
    let thread;
    let usedFreshStart = false;
    if (nativeFork) {
      try {
        // Dynamic tools are persisted with the parent. ThreadForkParams does not accept dynamicTools.
        thread = await client.request('thread/fork', { ...inherited, threadId: nativeFork.id, excludeTurns: true }, deadline === null ? undefined : remaining());
        if (!thread?.thread?.id || thread.thread.id === nativeFork.id) throw new Error('Missing child thread identity.');
        confirmedSandbox(thread);
        if (thread.model && thread.model !== model) throw new Error('Fork model mismatch.');
        record.fork_mode = 'native';
        prompt = nativeFork.prompt;
      } catch {
        record.fork_mode = 'summary_fallback';
        thread = null;
      }
    }
    if (nativeFork) await onForkMode?.(record.fork_mode);
    if (!thread) {
      if (threadId) {
        thread = await client.request('thread/resume', { ...inherited, threadId, excludeTurns: true }, deadline === null ? undefined : remaining());
      } else {
        usedFreshStart = true;
        thread = await client.request('thread/start', { ...common, dynamicTools, allowProviderModelFallback: false }, deadline === null ? undefined : remaining());
      }
    }
    if (threadId && thread.thread.id !== threadId) throw new Error('Codex returned a different thread on resume.');
    const actual = confirmedSandbox(thread);
    const parentThreadId = nativeFork && record.fork_mode === 'native' ? nativeFork.id : null;
    await registerCache(thread.thread.id, parentThreadId, Boolean(threadId));
    record.sandbox = Object.keys(SANDBOX_TYPES)[actual];
    record.model = model;
    record.board_tool_mode = !isSwarm ? 'none' : (usedFreshStart ? 'dynamic' : (spec ? 'mcp' : 'dynamic'));
    record.board_capable = record.board_tool_mode !== 'none';
    if (sandboxUpgraded) record.sandbox_upgraded = true;
    identity(thread.thread.id);

    acceptTurn = true;
    poll = setInterval(() => {
      if (client.disconnected) return;
      for (const [id, pending] of tools) try {
        const reply = JSON.parse(readFileSync(toolReplyPath(directory, pending.call_id), 'utf8'));
        if (typeof reply.answer !== 'string' || typeof reply.success !== 'boolean') throw new Error('Invalid ask_gemini reply.');
        client.reply(id, { success: reply.success, contentItems: [{ type: 'inputText', text: reply.answer }] });
        tools.delete(id);
        pendingChanged();
        if (isSwarm && !tools.size) {
          trackSwarmHook((async () => {
            const { updateWorker } = await import('../../core/swarm-bus.mjs');
            await updateWorker(swarmId, swarmAgent, { state: 'working', parked_on: null },
              { sessionsDir, expectedState: 'waiting_reply', expectedRun: record.run_id });
          })());
        }
      } catch (err) {
        if (!['ENOENT', 'EPERM', 'EBUSY'].includes(err.code)) {
          fail(err);
          return;
        }
      }
    }, 100);
    armTimeout();
    // A matching turn event proves start even when the RPC acknowledgement is delayed.
    // The short RPC timer can only fail startup before that proof arrives.
    const acknowledgement = client.request('turn/start', { threadId: progress.thread_id, input: textInput(prompt), model, effort,
      cwd, approvalPolicy, sandboxPolicy: { type: SANDBOX_TYPES[sandbox] } }, 15_000).then(({ turn }) => turn.id);
    try {
      const startedTurnId = await Promise.race([observedTurn, acknowledgement, completion.then((turn) => turn.id)]);
      identity(progress.thread_id, startedTurnId);
      return finishTurn(await completion);
    } catch (err) {
      if (terminal || !client.disconnected || !progress.turn_id) throw err;
    }

    // A plugin reload may briefly unpublish the endpoint. Rejoin the original
    // thread, including notifications that arrived between read and resume.
    let recoveryError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(Math.min(remaining(), 250 * attempt));
      try {
        const latest = readAppServerState(configPath, env);
        if (latest.gateway_url?.replace(/\/+$/, '') !== gatewayUrl) throw new Error('Codex gateway changed.');
        completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
        completion.catch(() => {});
        client = await connectAppServer(latest, onEvent);
        client.onFailure(fail);
        let turn = await readServerTurn(client, progress.thread_id, progress.turn_id);
        if (!turn) throw new Error('Codex could not identify the disconnected turn.');
        if (!terminalTurn(turn)) {
          tools.clear();
          pendingChanged();
          const resumed = await client.request('thread/resume', { ...common, threadId: progress.thread_id });
          if (resumed.thread?.id !== progress.thread_id) throw new Error('Codex returned a different thread on rejoin.');
          confirmedSandbox(resumed);
          await registerCache(progress.thread_id, null, true);
          turn = resumed.thread.turns?.find((entry) => entry.id === progress.turn_id);
          if (!terminalTurn(turn)) turn = await completion;
        }
        notifyTerminal(turn);
        return finishTurn(turn);
      } catch (err) {
        if (terminal || (client && !client.disconnected && deadline !== null && Date.now() / 1000 >= deadline && pausedAt === null)) throw err;
        recoveryError = err;
        client?.close();
      }
    }
    throw Object.assign(recoveryError, { transportLost: true });
  } catch (err) {
    clearInterval(poll);
    cancelTimeout?.();
    cancelTimeout = undefined;
    const turnId = progress.turn_id ?? observedTurnId;
    // After acceptTurn, turn/start is the only outstanding RPC that can reject this try block.
    if (acceptTurn && err.rpcError && !turnId) throw err;
    let noActiveTurn = false;
    if (!terminal && turnId && !err.transportLost) {
      const params = { threadId: progress.thread_id, turnId };
      const interrupt = async (connection) => {
        try {
          await connection.request('turn/interrupt', params);
          if (!terminal) await waitForTerminal(interruptConfirmMs, connection);
        } catch (error) {
          noActiveTurn = !connection.disconnected && error.rpcError && TERMINAL_INTERRUPT_ERR.test(error.message);
          if (noActiveTurn) {
            try {
              const ended = await readServerTurn(connection, params.threadId, params.turnId);
              if (terminalTurn(ended)) notifyTerminal(ended);
            } catch { /* The interrupt error still confirms inactivity. */ }
          }
        }
      };
      if (client && !client.disconnected) await interrupt(client);
    }
    if (terminal?.status === 'completed') return finishTurn(terminal);
    if (acceptTurn && !terminal && !noActiveTurn) {
      throw Object.assign(new Error(`Remote Codex turn may still be running (no terminal status confirmed). ${err.message}`,
        { cause: err }), { remoteTurnUnconfirmed: true });
    }
    throw err;
  } finally {
    clearInterval(poll);
    cancelTimeout?.();
    client?.close();
    if (swarmHooks.length) await Promise.allSettled([...swarmHooks]);
  }
}

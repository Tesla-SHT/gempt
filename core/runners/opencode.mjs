import { scheduleTimeout } from '../timeout.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { TurnInterrupted } from '../../magpie_plugin/lib/app-server-run.mjs';
import {
  buildRunnerBaseEnv,
  findExecutable,
  resolveExecutableInvocation,
  terminateProcessTree,
} from './detect.mjs';
import {
  createRunJournal,
  getBoardMcpSpec,
  isRunInterruptRequested,
  markRunInterruptRequested,
} from './journal.mjs';

function pickFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
  });
}

function buildOpenCodeConfigContent({ gatewayUrl, apiKey, model, swarmId, swarmAgent, sessionsDir, configPath, env }) {
  const cleanGateway = String(gatewayUrl || '').replace(/\/+$/, '');
  const config = {};
  if (cleanGateway) {
    const modelId = model || 'codex/gpt-6.2-sol';
    config.provider = {
      magpie: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Magpie',
        options: {
          baseURL: `${cleanGateway}/v1`,
          apiKey: apiKey || 'gempt-local',
        },
        models: {
          [modelId]: { name: modelId },
        },
      },
    };
    config.model = `magpie/${modelId}`;
  }
  const boardMcp = getBoardMcpSpec({ swarmId, swarmAgent, sessionsDir, configPath, env });
  if (boardMcp) {
    config.mcp = { gempt_board: boardMcp };
  }
  return JSON.stringify(config);
}

function extractPartsText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
    .map((p) => String(p.text || ''))
    .join('\n')
    .trim();
}

async function waitForOpenCodeServer(baseUrl, child, startupMs = 6000) {
  const deadline = Date.now() + startupMs;
  let exited = false;
  const onExit = () => { exited = true; };
  child.once('exit', onExit);
  child.once('error', onExit);
  try {
    while (!exited && Date.now() < deadline) {
      for (const path of ['/global/health', '/health', '/session']) {
        if (exited) return false;
        try {
          const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(600) });
          await res.body?.cancel();
          if (res.ok) return !exited;
        } catch { /* retry */ }
      }
      await sleep(80);
    }
    return false;
  } finally {
    child.off('exit', onExit);
    child.off('error', onExit);
  }
}

async function consumeOpenCodeSse({ baseUrl, sessionId, journal, signal, onIdle, onError }) {
  const endpoints = ['/event', '/global/event'];
  let res = null;
  for (const ep of endpoints) {
    try {
      const candidate = await fetch(`${baseUrl}${ep}`, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (candidate.ok && candidate.body) {
        res = candidate;
        break;
      }
      await candidate.body?.cancel();
    } catch { /* try next endpoint */ }
  }
  if (!res?.body) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let msgSeq = 0;

  const handlePayload = (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    const payload = ev?.payload && typeof ev.payload === 'object' ? ev.payload : ev;
    const type = String(payload?.type || '');
    const props = payload?.properties && typeof payload.properties === 'object' ? payload.properties : payload;
    const evSid = props?.sessionID || props?.sessionId || props?.part?.sessionID || props?.info?.sessionID;
    if (sessionId && evSid && evSid !== sessionId) return;

    if (type === 'message.part.updated' && props?.part) {
      const part = props.part;
      const partId = String(part.id || `oc-part-${++msgSeq}`);
      if (part.type === 'text') {
        if (typeof props.delta === 'string' && props.delta) {
          journal.appendDelta(partId, props.delta);
        } else if (typeof part.text === 'string' && part.text) {
          journal.completeMessage(partId, part.text);
        }
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        journal.recordReasoning(partId, part.text);
      } else if (part.type === 'tool') {
        const name = String(part.tool || '');
        const state = part.state || {};
        if (/bash|shell|command/i.test(name)) {
          journal.recordCommand(
            partId,
            String(state.input?.command || state.title || ''),
            state.status === 'completed' ? 0 : (state.status === 'error' ? 1 : null),
            String(state.output || ''),
          );
        } else if (/edit|write|patch/i.test(name)) {
          const file = state.input?.filePath || state.input?.path;
          if (file) journal.recordFiles(partId, [file]);
        }
      }
    } else if (type === 'message.updated' && props?.info) {
      if (props.info.tokens) journal.recordUsage(props.info.tokens, props.info.id);
    } else if (type === 'session.idle' || (type === 'session.status' && props?.status?.type === 'idle')) {
      onIdle?.();
    } else if (type === 'session.error') {
      onError?.(new Error(String(props?.error?.message || props?.error || 'OpenCode session error.')));
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (data) handlePayload(data);
      }
    }
  }
}

async function runViaServe({ cliPath, ctx, journal, childEnv }) {
  const [bin, ...prefix] = resolveExecutableInvocation(cliPath, { env: ctx.env });
  const externalUrl = String(ctx.env?.OPENCODE_SERVER_URL || '').trim().replace(/\/+$/, '');
  let baseUrl = externalUrl;
  let serverChild = null;

  if (!baseUrl) {
    const port = await pickFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverChild = spawn(bin, [...prefix, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: ctx.cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    journal.setRunnerPid(serverChild.pid);
    const ready = await waitForOpenCodeServer(baseUrl, serverChild, Number(ctx.env?.GEMPT_OPENCODE_STARTUP_MS) || 5000);
    if (!ready) {
      terminateProcessTree(serverChild);
      return { fallback: true };
    }
  }

  const abortController = new AbortController();
  const timeoutTimer = scheduleTimeout(() => {
    abortController.abort(new Error(`OpenCode turn timed out after ${ctx.timeoutSec}s.`));
  }, ctx.timeoutSec);
  const onServerExit = (code, signal) => abortController.abort(
    new Error(`OpenCode serve exited unexpectedly (${(signal || code) ?? 'unknown'}).`),
  );
  if (serverChild) {
    serverChild.once('exit', onServerExit);
    if (serverChild.exitCode !== null || serverChild.signalCode !== null) {
      onServerExit(serverChild.exitCode, serverChild.signalCode);
    }
  }

  try {
    let ocSessionId = ctx.runnerSessionId || '';
    let prompt = ctx.prompt;
    if (ocSessionId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const check = await fetch(`${baseUrl}/session/${encodeURIComponent(ocSessionId)}`, {
          signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(2000)]),
        }).catch(() => null);
        await check?.body?.cancel();
        if (check?.ok) break;
        if (check?.status === 404) {
          ocSessionId = '';
          prompt = ctx.onSessionMissing?.() ?? prompt;
          break;
        }
        abortController.signal.throwIfAborted();
        if (attempt === 2 || (check && check.status < 500 && ![408, 429].includes(check.status))) {
          throw new Error(`OpenCode session lookup failed (${check?.status ?? 'network error'}); preserving session ${ocSessionId}.`);
        }
        await sleep(100 * (attempt + 1));
      }
    }
    if (!ocSessionId) {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: ctx.sessionId || 'gempt-opencode' }),
        signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(5000)]),
      });
      if (!createRes.ok) {
        const body = await createRes.text().catch(() => '');
        throw new Error(`OpenCode POST /session failed (${createRes.status}): ${body}`);
      }
      const created = await createRes.json();
      ocSessionId = String(created?.id || created?.session?.id || '');
      if (!ocSessionId) throw new Error('OpenCode /session did not return a session id.');
    }

    journal.setIdentity(ocSessionId, undefined, { server_url: baseUrl, session_id: ocSessionId });

    let resolveIdle;
    let rejectStream;
    let settled = false;
    const idlePromise = new Promise((resIdle, rejIdle) => {
      resolveIdle = () => { if (!settled) { settled = true; resIdle(); } };
      rejectStream = (err) => { if (!settled) { settled = true; rejIdle(err); } };
    });
    idlePromise.catch(() => {});

    const onAbort = () => rejectStream(abortController.signal.reason instanceof Error
      ? abortController.signal.reason
      : new Error('OpenCode turn aborted.'));
    if (abortController.signal.aborted) onAbort();
    else abortController.signal.addEventListener('abort', onAbort, { once: true });

    const streamClosed = consumeOpenCodeSse({
      baseUrl,
      sessionId: ocSessionId,
      journal,
      signal: abortController.signal,
      onIdle: resolveIdle,
      onError: rejectStream,
    }).then(
      () => new Error('OpenCode SSE stream closed before session idle.'),
      (cause) => new Error('OpenCode SSE stream disconnected before session idle.', { cause }),
    );

    try {
      const messagePayload = {
        parts: [{ type: 'text', text: String(prompt || '') }],
        ...(ctx.model ? { model: { providerID: 'magpie', modelID: ctx.model } } : {}),
      };
      const msgRes = await fetch(`${baseUrl}/session/${encodeURIComponent(ocSessionId)}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(messagePayload),
        signal: abortController.signal,
      });
      if (!msgRes.ok) {
        const errBody = await msgRes.text().catch(() => '');
        throw new Error(`OpenCode POST /session/${ocSessionId}/message failed (${msgRes.status}): ${errBody}`);
      }

      let responseText = '';
      const ct = String(msgRes.headers.get('content-type') || '');
      if (ct.includes('application/json')) {
        const data = await msgRes.json().catch(() => null);
        if (data?.info?.tokens) journal.recordUsage(data.info.tokens, data.info.id);
        if (data?.usage) journal.recordUsage(data.usage);
        responseText = extractPartsText(data?.parts) || String(data?.text || '');
        if (responseText && !journal.getText()) {
          journal.completeMessage(data?.info?.id || 'oc-reply', responseText);
        }
      } else {
        await msgRes.body?.cancel();
      }

      // A complete HTTP reply can finish the turn even if SSE has already closed.
      const streamError = await Promise.race(responseText
        ? [idlePromise, streamClosed, sleep(50)]
        : [idlePromise, streamClosed]);
      abortController.signal.throwIfAborted();
      if (streamError && !responseText) throw streamError;
      abortController.abort();
      await streamClosed;

      if (isRunInterruptRequested(journal.directory)) {
        journal.finish('interrupted', 'OpenCode turn interrupted.');
        throw new TurnInterrupted('OpenCode turn interrupted.');
      }

      const finalText = responseText || journal.getText();
      if (!finalText) {
        journal.finish('failed', 'OpenCode finished without an assistant message.');
        throw new Error('OpenCode finished without an assistant message.');
      }
      journal.finish('completed');
      return {
        fallback: false,
        result: {
          threadId: journal.getThreadId(),
          runnerSessionId: ocSessionId,
          turnId: journal.getTurnId(),
          sandbox: ctx.sandbox,
          text: finalText,
          elapsedSec: journal.getElapsedSec(),
          commands: journal.getCommands(),
          usage: journal.getUsage(),
        },
      };
    } finally {
      abortController.signal.removeEventListener('abort', onAbort);
    }
  } catch (err) {
    if (isRunInterruptRequested(journal.directory)) {
      journal.finish('interrupted', 'OpenCode turn interrupted.');
      throw new TurnInterrupted('OpenCode turn interrupted.');
    }
    if (abortController.signal.aborted && abortController.signal.reason instanceof Error) {
      journal.finish('failed', abortController.signal.reason.message);
      throw abortController.signal.reason;
    }
    journal.finish('failed', String(err?.message || err));
    throw err;
  } finally {
    timeoutTimer?.();
    serverChild?.off('exit', onServerExit);
    abortController.abort();
    if (serverChild) terminateProcessTree(serverChild);
  }
}

async function runViaCliFallback({ cliPath, ctx, journal, childEnv }) {
  const [bin, ...prefix] = resolveExecutableInvocation(cliPath, { env: ctx.env });
  const args = [...prefix, 'run', '--format', 'json'];
  if (ctx.model) args.push('--model', `magpie/${ctx.model}`);
  if (ctx.runnerSessionId) args.push('--session', String(ctx.runnerSessionId));

  const child = spawn(bin, args, {
    cwd: ctx.cwd,
    env: childEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  journal.setRunnerPid(child.pid);

  let timedOut = false;
  let stderr = '';
  let msgSeq = 0;
  const timer = scheduleTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
  }, ctx.timeoutSec);

  child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rlClosed = new Promise((r) => rl.once('close', r));
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const ev = JSON.parse(trimmed);
      const sid = ev.sessionID || ev.session_id || ev.part?.sessionID;
      if (typeof sid === 'string' && sid.trim()) journal.setIdentity(sid.trim());
      if (ev.type === 'text' && typeof ev.part?.text === 'string') {
        journal.completeMessage(ev.part.id || `oc-run-${++msgSeq}`, ev.part.text);
      } else if (ev.type === 'step_finish' && ev.part?.tokens) {
        journal.recordUsage(ev.part.tokens, ev.part.id);
      } else if (typeof ev.text === 'string' && ev.text) {
        journal.completeMessage(`oc-run-${++msgSeq}`, ev.text);
      } else if (typeof ev.delta === 'string' && ev.delta) {
        journal.appendDelta('oc-run-stream', ev.delta);
      }
    } catch {
      journal.appendDelta('oc-run-raw', `${trimmed}\n`);
    }
  });

  child.stdin.on('error', () => {});
  child.stdin.end(String(ctx.prompt || ''));

  const exitResult = await new Promise((resolveExit, rejectExit) => {
    child.once('error', (err) => {
      rl.close();
      rejectExit(err);
    });
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  }).finally(() => {
    timer?.();
  });
  await rlClosed;

  if (isRunInterruptRequested(journal.directory)) {
    journal.finish('interrupted', 'OpenCode turn interrupted.');
    throw new TurnInterrupted('OpenCode turn interrupted.');
  }
  if (timedOut) {
    const msg = `OpenCode turn timed out after ${ctx.timeoutSec}s.`;
    journal.finish('failed', msg);
    throw new Error(msg);
  }
  if (exitResult.code !== 0) {
    const detail = stderr.trim() || `OpenCode exited with code ${exitResult.code ?? exitResult.signal}`;
    journal.finish('failed', detail);
    throw new Error(detail);
  }
  const finalText = journal.getText();
  if (!finalText) {
    journal.finish('failed', 'OpenCode finished without an assistant message.');
    throw new Error('OpenCode finished without an assistant message.');
  }
  journal.finish('completed');
  return {
    threadId: journal.getThreadId(),
    runnerSessionId: journal.getRunnerSessionId(),
    turnId: journal.getTurnId(),
    sandbox: ctx.sandbox,
    text: finalText,
    elapsedSec: journal.getElapsedSec(),
    commands: journal.getCommands(),
    usage: journal.getUsage(),
  };
}

export const opencodeRunner = {
  id: 'opencode',
  label: 'OpenCode',
  binaryNames: ['opencode'],
  envVars: ['OPENCODE_CLI_PATH', 'OPENCODE_BIN'],
  installHint: 'npm install -g opencode-ai',
  capabilities: Object.freeze({
    persistent: true,
    steer: true,
    askGemini: false,
    boardMcp: true,
    osSandbox: false,
    resume: true,
  }),

  detect(cfg = {}, env = process.env, opts = {}) {
    const configured = String(cfg?.execution?.cli_paths?.opencode || '').trim();
    const resolvedPath = findExecutable({
      configuredPath: configured,
      envVars: this.envVars,
      binaryNames: this.binaryNames,
      env,
      ...opts,
    });
    const autoDetectedPath = configured
      ? findExecutable({ envVars: this.envVars, binaryNames: this.binaryNames, env, ...opts })
      : resolvedPath;
    return {
      id: this.id,
      label: this.label,
      available: Boolean(resolvedPath),
      path: resolvedPath,
      configured_path: configured,
      auto_detected_path: autoDetectedPath,
      binary_names: [...this.binaryNames],
      install_hint: this.installHint,
      capabilities: { ...this.capabilities },
    };
  },

  async runTurn(ctx) {
    const journal = createRunJournal({
      runFile: ctx.runFile,
      sessionId: ctx.sessionId,
      cli: this.id,
      model: ctx.model,
      sandbox: ctx.sandbox || 'workspace-write',
      timeoutSec: ctx.timeoutSec ?? null,
      threadId: ctx.runnerSessionId || ctx.threadId,
      onIdentity: ctx.onIdentity,
    });

    const configContent = buildOpenCodeConfigContent({
      gatewayUrl: ctx.gatewayUrl,
      apiKey: ctx.apiKey,
      model: ctx.model,
      swarmId: ctx.swarmId,
      swarmAgent: ctx.swarmAgent,
      sessionsDir: ctx.sessionsDir,
      configPath: ctx.configPath,
      env: ctx.env,
    });
    const childEnv = buildRunnerBaseEnv({
      env: ctx.env,
      gatewayUrl: ctx.gatewayUrl,
      apiKey: ctx.apiKey,
      swarmId: ctx.swarmId,
      swarmAgent: ctx.swarmAgent,
      sessionsDir: ctx.sessionsDir,
      configPath: ctx.configPath,
      extra: {
        OPENCODE_CONFIG_CONTENT: configContent,
      },
    });

    const preferRunOnly = String(ctx.env?.GEMPT_OPENCODE_FORCE_RUN || '').trim() === '1';
    if (!preferRunOnly) {
      const served = await runViaServe({ cliPath: ctx.cliPath, ctx, journal, childEnv });
      if (!served.fallback) return served.result;
    }
    return runViaCliFallback({ cliPath: ctx.cliPath, ctx, journal, childEnv });
  },

  async steer(record, message) {
    const serverUrl = record?.runner_meta?.server_url;
    const ocSessionId = record?.runner_meta?.session_id || record?.runner_session_id;
    if (!serverUrl || !ocSessionId) {
      throw Object.assign(new Error(`OpenCode run ${record?.run_id} has no live HTTP session to steer.`), { status: 409 });
    }
    const endpoints = [
      `${serverUrl}/session/${encodeURIComponent(ocSessionId)}/prompt_async`,
      `${serverUrl}/session/${encodeURIComponent(ocSessionId)}/message`,
    ];
    let lastErr;
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parts: [{ type: 'text', text: String(message) }] }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          await res.body?.cancel();
          return { ok: true, run_id: record.run_id, session_id: record.session_id, cli: this.id };
        }
        lastErr = new Error(`OpenCode steer failed (${res.status})`);
        await res.body?.cancel();
      } catch (err) {
        lastErr = err;
      }
    }
    throw Object.assign(lastErr || new Error('OpenCode steer failed.'), { status: 503 });
  },

  async interrupt(record, { runDir } = {}) {
    if (runDir) markRunInterruptRequested(runDir);
    const serverUrl = record?.runner_meta?.server_url;
    const ocSessionId = record?.runner_meta?.session_id || record?.runner_session_id;
    if (serverUrl && ocSessionId) {
      try {
        const res = await fetch(`${serverUrl}/session/${encodeURIComponent(ocSessionId)}/abort`, {
          method: 'POST',
          signal: AbortSignal.timeout(3000),
        });
        await res.body?.cancel();
      } catch { /* Fall through to process termination. */ }
    }
    terminateProcessTree(record.runner_pid || record.pid);
    return { ok: true, run_id: record.run_id, session_id: record.session_id, cli: this.id };
  },
};

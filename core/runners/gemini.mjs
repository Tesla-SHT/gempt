import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TurnInterrupted } from '../../magpie_plugin/lib/app-server-run.mjs';
import {
  buildRunnerBaseEnv,
  findExecutable,
  resolveExecutableInvocation,
  terminateProcessTree,
} from './detect.mjs';
import {
  createRunJournal,
  isRunInterruptRequested,
  markRunInterruptRequested,
} from './journal.mjs';

export const geminiRunner = {
  id: 'gemini',
  label: 'Gemini CLI',
  binaryNames: ['gemini'],
  envVars: ['GEMINI_CLI_PATH', 'GEMINI_BIN'],
  installHint: 'npm install -g @google/gemini-cli',
  capabilities: Object.freeze({
    persistent: false,
    steer: false,
    askGemini: false,
    boardMcp: false,
    osSandbox: false,
    resume: true,
  }),

  detect(cfg = {}, env = process.env, opts = {}) {
    const configured = String(cfg?.execution?.cli_paths?.gemini || '').trim();
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
    const {
      cliPath,
      env = process.env,
      runFile,
      sessionId,
      onIdentity,
      prompt,
      cwd,
      model,
      sandbox = 'workspace-write',
      threadId,
      runnerSessionId,
      gatewayUrl,
      apiKey,
      timeoutSec = 3600,
      sessionsDir,
      configPath,
      swarmId,
      swarmAgent,
    } = ctx;

    const journal = createRunJournal({
      runFile,
      sessionId,
      cli: this.id,
      model,
      sandbox,
      timeoutSec,
      threadId: runnerSessionId || threadId,
      onIdentity,
    });

    const [bin, ...prefix] = resolveExecutableInvocation(cliPath, {
      env,
      npmEntryRelative: 'node_modules/@google/gemini-cli/dist/index.js',
    });
    const promptText = String(prompt || '');
    const useInlinePrompt = promptText.length <= 4000;
    const args = [
      ...prefix,
      '-p', useInlinePrompt ? promptText : '',
      '--output-format', 'stream-json',
    ];
    if (model) args.push('--model', model);
    if (runnerSessionId) {
      args.push('--resume', String(runnerSessionId));
    }

    const cleanGateway = String(gatewayUrl || '').replace(/\/+$/, '');
    const token = String(apiKey || '').trim() || 'gempt-local';
    const childEnv = buildRunnerBaseEnv({
      env,
      gatewayUrl: cleanGateway,
      apiKey: token,
      swarmId,
      swarmAgent,
      sessionsDir,
      configPath,
      extra: cleanGateway ? {
        GEMINI_API_BASE: cleanGateway,
        GOOGLE_GEMINI_BASE_URL: cleanGateway,
        GEMINI_API_KEY: token,
      } : {},
    });

    const child = spawn(bin, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    journal.setRunnerPid(child.pid);

    let timedOut = false;
    let stderr = '';
    let resultText = '';
    let resultError = '';
    let msgCounter = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, Math.max(1000, timeoutSec * 1000));

    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      const sid = ev.session_id || ev.sessionId;
      if (typeof sid === 'string' && sid.trim()) {
        journal.setIdentity(sid.trim());
      }
      if (ev.type === 'message' && (ev.role === 'assistant' || ev.role === 'model' || !ev.role)) {
        const chunk = typeof ev.content === 'string' ? ev.content : (typeof ev.text === 'string' ? ev.text : '');
        if (chunk) {
          if (ev.delta) journal.appendDelta('gemini-msg', chunk);
          else journal.completeMessage(`gemini-msg-${++msgCounter}`, chunk);
        }
        return;
      }
      if (ev.type === 'tool_use') {
        const toolId = String(ev.tool_id || ev.id || `tool-${++msgCounter}`);
        const name = String(ev.tool_name || ev.name || '');
        const params = ev.parameters || ev.input || {};
        if (/shell|bash|command/i.test(name)) {
          journal.recordCommand(toolId, String(params.command || params.cmd || ''), null, '');
        } else if (/write|edit|replace/i.test(name)) {
          const file = params.file_path || params.path;
          if (file) journal.recordFiles(toolId, [file]);
        }
        return;
      }
      if (ev.type === 'tool_result') {
        const toolId = String(ev.tool_id || ev.id || '');
        if (toolId) {
          const out = typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output || '');
          journal.recordCommand(toolId, undefined, ev.status === 'error' ? 1 : 0, out);
        }
        return;
      }
      if (ev.type === 'result') {
        if (ev.stats || ev.usage) journal.recordUsage(ev.stats || ev.usage);
        if (typeof ev.response === 'string' && ev.response.trim()) resultText = ev.response.trim();
        else if (typeof ev.result === 'string' && ev.result.trim()) resultText = ev.result.trim();
        if (ev.status === 'error' || ev.error) {
          resultError = String(ev.error?.message || ev.error || 'Gemini CLI reported error.');
        }
      }
    };

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rlClosed = new Promise((r) => rl.once('close', r));
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        journal.appendDelta('gemini-raw', `${trimmed}\n`);
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(useInlinePrompt ? '' : promptText);

    const exitResult = await new Promise((resolveExit, rejectExit) => {
      child.once('error', (err) => {
        rl.close();
        rejectExit(err);
      });
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    }).finally(() => {
      clearTimeout(timer);
    });
    await rlClosed;

    if (isRunInterruptRequested(journal.directory)) {
      journal.finish('interrupted', 'Gemini turn interrupted.');
      throw new TurnInterrupted('Gemini turn interrupted.');
    }
    if (timedOut) {
      const msg = `Gemini turn timed out after ${timeoutSec}s.`;
      journal.finish('failed', msg);
      throw new Error(msg);
    }
    if (exitResult.code !== 0 || resultError) {
      const detail = resultError || stderr.trim() || `Gemini exited with code ${exitResult.code ?? exitResult.signal}`;
      journal.finish('failed', detail);
      throw new Error(detail);
    }

    const finalText = journal.getText() || resultText;
    if (!finalText) {
      journal.finish('failed', 'Gemini finished without an assistant message.');
      throw new Error('Gemini finished without an assistant message.');
    }
    if (!journal.getText() && resultText) {
      journal.completeMessage('gemini-final', resultText);
    }
    journal.finish('completed');

    return {
      threadId: journal.getThreadId(),
      runnerSessionId: journal.getRunnerSessionId(),
      turnId: journal.getTurnId(),
      sandbox,
      text: finalText,
      elapsedSec: journal.getElapsedSec(),
      commands: journal.getCommands(),
      usage: journal.getUsage(),
    };
  },

  async interrupt(record, { runDir }) {
    if (runDir) markRunInterruptRequested(runDir);
    terminateProcessTree(record.runner_pid || record.pid);
    return { ok: true, run_id: record.run_id, session_id: record.session_id, cli: this.id };
  },
};

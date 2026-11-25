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

export const DECLARATIVE_SPECS = [
  {
    id: 'pi',
    label: 'Pi',
    binaryNames: ['pi'],
    envVars: ['PI_CLI_PATH', 'PI_BIN'],
    installHint: 'npm install -g @mariozechner/pi-coding-agent',
    buildArgs: ({ model }) => ['-p', '--mode', 'json', ...(model ? ['--model', model] : [])],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { PI_BASE_URL: `${gatewayUrl}/v1`, PI_API_KEY: apiKey } : {},
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    binaryNames: ['cursor-agent', 'agent'],
    envVars: ['CURSOR_CLI_PATH', 'CURSOR_AGENT_BIN'],
    installHint: 'curl https://cursor.com/install -fsS | bash',
    buildArgs: ({ model, runnerSessionId }) => [
      '-p', '--output-format', 'stream-json',
      ...(model ? ['--model', model] : []),
      ...(runnerSessionId ? ['--resume', runnerSessionId] : []),
    ],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { CURSOR_API_BASE_URL: `${gatewayUrl}/v1`, CURSOR_API_KEY: apiKey } : {},
    resume: true,
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    binaryNames: ['kimi'],
    envVars: ['KIMI_CLI_PATH', 'KIMI_BIN'],
    installHint: 'uv tool install kimi-cli',
    buildArgs: ({ model }) => ['--print', '--output-format', 'stream-json', ...(model ? ['--model', model] : [])],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { KIMI_BASE_URL: `${gatewayUrl}/v1`, KIMI_API_KEY: apiKey } : {},
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    binaryNames: ['grok'],
    envVars: ['GROK_CLI_PATH', 'GROK_BIN'],
    installHint: 'npm install -g @vibe-kit/grok-cli',
    buildArgs: ({ model }) => ['-p', ...(model ? ['--model', model] : [])],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { GROK_BASE_URL: `${gatewayUrl}/v1`, XAI_API_KEY: apiKey } : {},
  },
  {
    id: 'kilo',
    label: 'Kilo Code',
    binaryNames: ['kilocode', 'kilo'],
    envVars: ['KILO_CLI_PATH', 'KILOCODE_BIN'],
    installHint: 'npm install -g @kilocode/cli',
    buildArgs: ({ model }) => ['--auto', '--json', ...(model ? ['--model', model] : [])],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { KILOCODE_BASE_URL: `${gatewayUrl}/v1`, KILOCODE_API_KEY: apiKey } : {},
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    binaryNames: ['copilot'],
    envVars: ['COPILOT_CLI_PATH', 'COPILOT_BIN'],
    installHint: 'npm install -g @github/copilot',
    buildArgs: ({ model }) => ['-p', ...(model ? ['--model', model] : [])],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { GITHUB_COPILOT_BASE_URL: `${gatewayUrl}/v1`, COPILOT_API_KEY: apiKey } : {},
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    binaryNames: ['qodercli', 'qoder'],
    envVars: ['QODER_CLI_PATH', 'QODER_BIN'],
    installHint: 'npm install -g @qoder-ai/qodercli',
    buildArgs: ({ model }) => ['-p', '--output-format', 'stream-json', ...(model ? ['--model', model] : [])],
    extraEnv: ({ gatewayUrl, apiKey }) => gatewayUrl ? { QODER_BASE_URL: `${gatewayUrl}/v1`, QODER_API_KEY: apiKey } : {},
  },
];

function ingestStructuredLine(ev, journal, state) {
  if (!ev || typeof ev !== 'object') return false;
  const sid = ev.session_id || ev.sessionId || ev.sessionID;
  if (typeof sid === 'string' && sid.trim()) {
    journal.setIdentity(sid.trim());
  }
  if (ev.usage || ev.stats || ev.tokens) {
    journal.recordUsage(ev.usage || ev.stats || ev.tokens);
  }
  if (typeof ev.delta === 'string' && ev.delta) {
    journal.appendDelta(`${state.id}-stream`, ev.delta);
    return true;
  }
  if (ev.type === 'assistant' && ev.message) {
    const content = ev.message.content;
    if (typeof content === 'string' && content) {
      journal.completeMessage(`${state.id}-msg-${++state.msgSeq}`, content);
      return true;
    }
    if (Array.isArray(content)) {
      const text = content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n').trim();
      if (text) {
        journal.completeMessage(`${state.id}-msg-${++state.msgSeq}`, text);
        return true;
      }
    }
  }
  if (ev.type === 'tool_use' || ev.type === 'command') {
    const cmd = ev.command || ev.input?.command || ev.parameters?.command;
    if (cmd) journal.recordCommand(String(ev.id || `cmd-${++state.msgSeq}`), String(cmd), ev.exit_code ?? null, String(ev.output || ''));
    return true;
  }
  if (ev.type === 'result') {
    if (typeof ev.result === 'string' && ev.result.trim()) state.resultText = ev.result.trim();
    else if (typeof ev.text === 'string' && ev.text.trim()) state.resultText = ev.text.trim();
    if (ev.is_error || ev.error) state.resultError = String(ev.error?.message || ev.error || 'CLI reported error.');
    return true;
  }
  const textCandidate = typeof ev.text === 'string' ? ev.text
    : (typeof ev.content === 'string' ? ev.content
      : (typeof ev.message === 'string' ? ev.message : ''));
  if (textCandidate) {
    journal.completeMessage(`${state.id}-msg-${++state.msgSeq}`, textCandidate);
    return true;
  }
  return false;
}

export function createDeclarativeRunner(spec) {
  const capabilities = Object.freeze({
    persistent: false,
    steer: false,
    askGemini: false,
    boardMcp: false,
    osSandbox: false,
    resume: Boolean(spec.resume),
  });

  return {
    id: spec.id,
    label: spec.label,
    binaryNames: [...spec.binaryNames],
    envVars: [...spec.envVars],
    installHint: spec.installHint,
    capabilities,

    detect(cfg = {}, env = process.env, opts = {}) {
      const configured = String(cfg?.execution?.cli_paths?.[spec.id] || '').trim();
      const resolvedPath = findExecutable({
        configuredPath: configured,
        envVars: spec.envVars,
        binaryNames: spec.binaryNames,
        env,
        ...opts,
      });
      const autoDetectedPath = configured
        ? findExecutable({ envVars: spec.envVars, binaryNames: spec.binaryNames, env, ...opts })
        : resolvedPath;
      return {
        id: spec.id,
        label: spec.label,
        available: Boolean(resolvedPath),
        path: resolvedPath,
        configured_path: configured,
        auto_detected_path: autoDetectedPath,
        binary_names: [...spec.binaryNames],
        install_hint: spec.installHint,
        capabilities: { ...capabilities },
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
        cli: spec.id,
        model,
        sandbox,
        timeoutSec,
        threadId: runnerSessionId || threadId,
        onIdentity,
      });

      const [bin, ...prefix] = resolveExecutableInvocation(cliPath, { env });
      const args = [...prefix, ...spec.buildArgs({ model, sandbox, runnerSessionId })];
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
        extra: spec.extraEnv ? spec.extraEnv({ gatewayUrl: cleanGateway, apiKey: token }) : {},
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
      const parseState = { id: spec.id, msgSeq: 0, resultText: '', resultError: '' };
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, Math.max(1000, timeoutSec * 1000));

      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4096);
      });

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const rlClosed = new Promise((r) => rl.once('close', r));
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (!ingestStructuredLine(parsed, journal, parseState)) {
            journal.appendDelta(`${spec.id}-raw`, `${trimmed}\n`);
          }
        } catch {
          journal.appendDelta(`${spec.id}-raw`, `${trimmed}\n`);
        }
      });

      child.stdin.on('error', () => {});
      child.stdin.end(String(prompt || ''));

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
        journal.finish('interrupted', `${spec.label} turn interrupted.`);
        throw new TurnInterrupted(`${spec.label} turn interrupted.`);
      }
      if (timedOut) {
        const msg = `${spec.label} turn timed out after ${timeoutSec}s.`;
        journal.finish('failed', msg);
        throw new Error(msg);
      }
      if (exitResult.code !== 0 || parseState.resultError) {
        const detail = parseState.resultError || stderr.trim()
          || `${spec.label} exited with code ${exitResult.code ?? exitResult.signal}`;
        journal.finish('failed', detail);
        throw new Error(detail);
      }

      const finalText = journal.getText() || parseState.resultText;
      if (!finalText) {
        journal.finish('failed', `${spec.label} finished without an assistant message.`);
        throw new Error(`${spec.label} finished without an assistant message.`);
      }
      if (!journal.getText() && parseState.resultText) {
        journal.completeMessage(`${spec.id}-final`, parseState.resultText);
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

    async interrupt(record, { runDir } = {}) {
      if (runDir) markRunInterruptRequested(runDir);
      terminateProcessTree(record.runner_pid || record.pid);
      return { ok: true, run_id: record.run_id, session_id: record.session_id, cli: spec.id };
    },
  };
}

export const declarativeRunners = DECLARATIVE_SPECS.map(createDeclarativeRunner);

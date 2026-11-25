import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TurnInterrupted } from '../../magpie_plugin/lib/app-server-run.mjs';
import {
  buildRunnerBaseEnv,
  findExecutable,
  resolveExecutableInvocation,
  terminateProcessTree,
} from './detect.mjs';
import {
  createBoardMcpConfigFile,
  createRunJournal,
  isRunInterruptRequested,
  markRunInterruptRequested,
} from './journal.mjs';

function extractTextBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => String(b.text || ''))
    .join('');
}

export const claudeRunner = {
  id: 'claude',
  label: 'Claude Code',
  binaryNames: ['claude'],
  envVars: ['CLAUDE_CLI_PATH', 'CLAUDE_BIN'],
  installHint: 'npm install -g @anthropic-ai/claude-code',
  capabilities: Object.freeze({
    persistent: false,
    steer: false,
    askGemini: false,
    boardMcp: true,
    osSandbox: false,
    resume: true,
  }),

  detect(cfg = {}, env = process.env, opts = {}) {
    const configured = String(cfg?.execution?.cli_paths?.claude || '').trim();
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
      threadId,
      onIdentity,
    });

    const permissionMode = sandbox === 'read-only' ? 'plan' : 'acceptEdits';
    const [bin, ...prefix] = resolveExecutableInvocation(cliPath, {
      env,
      npmEntryRelative: 'node_modules/@anthropic-ai/claude-code/cli.js',
    });
    const args = [
      ...prefix,
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode,
    ];
    if (model) args.push('--model', model);
    let fork = ctx.nativeFork;
    if (fork) {
      const help = spawnSync(bin, [...prefix, '--help'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (help.status !== 0 || !/--resume\b/.test(help.stdout) || !/--fork-session\b/.test(help.stdout)) fork = null;
    }
    if (fork) {
      args.push('--resume', fork.id, '--fork-session');
    } else if (threadId && !String(threadId).startsWith('claude-')) {
      args.push('--resume', String(threadId));
    } else if (ctx.runnerSessionId) {
      args.push('--resume', String(ctx.runnerSessionId));
    }

    const mcpConfigPath = createBoardMcpConfigFile({
      runDir: journal.directory,
      swarmId,
      swarmAgent,
      sessionsDir,
      configPath,
      env,
    });
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }

    const childEnv = buildRunnerBaseEnv({
      env,
      gatewayUrl,
      apiKey,
      swarmId,
      swarmAgent,
      sessionsDir,
      configPath,
      extra: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
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
    let resultIsError = false;
    let assistantStarted = false;
    let forkRecorded;
    let msgCounter = 0;
    const toolNames = new Map();

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, Math.max(1000, timeoutSec * 1000));

    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (typeof ev.session_id === 'string' && ev.session_id.trim()) {
        const id = ev.session_id.trim();
        if (fork && id !== fork.id && journal.record.fork_mode !== 'native') {
          journal.record.fork_mode = 'native';
          forkRecorded = ctx.onForkMode?.('native');
          forkRecorded?.catch(() => {});
        }
        if (id !== fork?.id) journal.setIdentity(id);
      }
      if (ev.type === 'assistant' || ev.type === 'stream_event' || ev.type === 'user') assistantStarted = true;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        const delta = ev.event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          journal.appendDelta('claude-stream', delta.text);
        }
        return;
      }
      if (ev.type === 'assistant' && ev.message) {
        const content = Array.isArray(ev.message.content) ? ev.message.content : [];
        const textParts = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            journal.recordReasoning(`reason-${++msgCounter}`, block.thinking);
          } else if (block.type === 'tool_use') {
            const toolId = String(block.id || `tool-${++msgCounter}`);
            const name = String(block.name || '');
            toolNames.set(toolId, name);
            const input = block.input && typeof block.input === 'object' ? block.input : {};
            if (name === 'Bash' || name === 'bash' || name === 'run_command') {
              journal.recordCommand(toolId, String(input.command || input.cmd || ''), null, '');
            } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
              const target = input.file_path || input.path || input.notebook_path;
              if (target) journal.recordFiles(toolId, [target]);
            }
          }
        }
        const joined = textParts.join('\n').trim();
        if (joined) {
          journal.completeMessage(ev.message.id || `claude-msg-${++msgCounter}`, joined);
        }
        if (ev.message.usage) journal.recordUsage(ev.message.usage, ev.message.id);
        return;
      }
      if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            const name = toolNames.get(block.tool_use_id);
            if (name === 'Bash' || name === 'bash' || name === 'run_command') {
              const outText = extractTextBlocks(block.content);
              journal.recordCommand(block.tool_use_id, undefined, block.is_error ? 1 : 0, outText);
            }
          }
        }
        return;
      }
      if (ev.type === 'result') {
        if (ev.usage) journal.recordUsage(ev.usage);
        if (typeof ev.result === 'string' && ev.result.trim()) {
          resultText = ev.result.trim();
        }
        if (ev.is_error) resultIsError = true;
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
        journal.appendDelta('claude-raw', `${trimmed}\n`);
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(String(fork?.prompt ?? prompt));

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
    await forkRecorded;

    if (isRunInterruptRequested(journal.directory)) {
      journal.finish('interrupted', 'Claude turn interrupted.');
      throw new TurnInterrupted('Claude turn interrupted.');
    }
    if (timedOut) {
      const msg = `Claude turn timed out after ${timeoutSec}s.`;
      journal.finish('failed', msg);
      throw new Error(msg);
    }
    if (exitResult.code !== 0 || resultIsError) {
      const detail = resultText || stderr.trim() || `Claude exited with code ${exitResult.code ?? exitResult.signal}`;
      if (fork && !assistantStarted && exitResult.code !== null) {
        journal.record.fork_mode = 'summary_fallback';
        await ctx.onForkMode?.('summary_fallback');
        journal.save(true);
        return this.runTurn({ ...ctx, nativeFork: null });
      }
      journal.finish('failed', detail);
      throw new Error(detail);
    }

    if (fork && !journal.getRunnerSessionId()) throw new Error('Claude did not return a new forked session ID.');
    const finalText = journal.getText() || resultText;
    if (!finalText) {
      journal.finish('failed', 'Claude finished without an assistant message.');
      throw new Error('Claude finished without an assistant message.');
    }
    if (!journal.getText() && resultText) {
      journal.completeMessage('claude-final', resultText);
    }
    journal.finish('completed');

    return {
      forkMode: journal.record.fork_mode,
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

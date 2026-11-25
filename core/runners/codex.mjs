import { runAppServer } from '../../magpie_plugin/lib/app-server-run.mjs';
import { findExecutable } from './detect.mjs';

export const codexRunner = {
  id: 'codex',
  label: 'Codex CLI',
  binaryNames: ['codex'],
  envVars: ['CODEX_CLI_PATH', 'CODEX_BIN'],
  installHint: 'npm install -g @openai/codex',
  capabilities: Object.freeze({
    persistent: true,
    steer: true,
    askGemini: true,
    boardMcp: true,
    osSandbox: true,
    resume: true,
  }),

  detect(cfg = {}, env = process.env, opts = {}) {
    const configured = String(cfg?.execution?.cli_paths?.codex || cfg?.codex?.cli_path || '').trim();
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
    return runAppServer({
      configPath: ctx.configPath,
      env: ctx.env,
      runFile: ctx.runFile,
      sessionId: ctx.sessionId,
      onIdentity: ctx.onIdentity,
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      model: ctx.model,
      effort: ctx.effort,
      sandbox: ctx.sandbox,
      approvalPolicy: ctx.approvalPolicy,
      threadId: ctx.threadId,
      nativeFork: ctx.nativeFork,
      useBoardMcp: ctx.useBoardMcp,
      onForkMode: ctx.onForkMode,
      gatewayUrl: ctx.gatewayUrl,
      timeoutSec: ctx.timeoutSec,
      sandboxUpgraded: ctx.sandboxUpgraded,
      sessionsDir: ctx.sessionsDir,
      swarmId: ctx.swarmId,
      swarmAgent: ctx.swarmAgent,
    });
  },
};

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { installAgy } from '../core/agy-install.mjs';
import { agyInstallPaths } from '../core/bundle-paths.mjs';
import { CLI_CHOICES } from '../core/config.mjs';
import { handleTool, serveStdio } from '../core/mcp-server.mjs';
import { ACTIVE_STATES, buildWaitCommand, compactReceiptText, dispatchRun, interruptRun, replyToolCall,
  steerRun, tryDelegateDispatch, validateExecTimeoutSec } from '../core/runs.mjs';
import { resolvePath } from '../core/state.mjs';
import { handleBoardAction, handleSwarmAction } from '../core/swarm-engine.mjs';
import { runWait } from '../core/wait.mjs';
import { pruneShareWorktrees } from '../core/worktrees.mjs';
import { findCodexCli } from '../magpie_plugin/lib/app-server-manager.mjs';
import {
  DEFAULT_TIERS, TIER_ORDER, VALID_FAILOVER_MODES, VALID_SANDBOXES, buildMcpSnippet,
  findMagpieCli, initSubscriptionConfig, normalizeDefaultTier, readJsonSafe, readState,
  resolveConfigPath, setDefaultSandbox, setDefaultTier, setEffortSettings,
} from '../magpie_plugin/lib/backend.mjs';

const string = { type: 'string' };
const flag = { type: 'boolean' };
const goalOptions = { goal: string, 'goal-file': string, cwd: string, tier: string,
  family: string, session: string, host: string };
const commands = {
  'install-agy': { target: string, source: string, force: flag },
  run: { ...goalOptions, access: string, workspace: string, title: string, timeout: string, cli: string },
  ask: { ...goalOptions, file: { ...string, multiple: true } },
  mcp: {}, discover: {}, status: { 'run-id': string, 'run-ids': string, wait: flag, 'wait-all': flag },
  init: { 'non-interactive': flag, failover: string, sandbox: string,
    'utility-model': string, 'dry-run': flag },
  tier: {}, sandbox: {}, effort: { tier: string }, steer: {}, interrupt: {},
  'reply-tool': { failure: flag }, 'prune-worktrees': { 'max-age-hours': string },
  'print-mcp': { installed: flag, target: string },
  board: { swarm: string, from: string, kind: string, text: string, since: string, seqs: string, limit: string, 'reply-to': string },
  swarm: { swarm: string, cwd: string, title: string, brief: string, 'brief-file': string, access: string, workspace: string,
    cli: string, model: string, tier: string, n: string, task: { ...string, multiple: true }, reason: string,
    'goal-title': string, 'goal-line': string, 'plan-json': string, host: string, family: string, timeout: string },
};
const print = (value) => console.log(JSON.stringify(value, null, 2));

function choose(value, allowed, label) {
  if (value !== undefined && !allowed.includes(value)) throw new Error(`Invalid ${label} '${value}'. Choose ${allowed.join(', ')}.`);
  return value;
}

async function goalArgs(values, tiers) {
  const tier = choose(values.tier, tiers, '--tier');
  const family = choose(values.family, ['hydrogen', 'neon', 'carbon'], '--family');
  const goalFile = values['goal-file'];
  if (values.goal !== undefined && goalFile !== undefined) throw new Error('Choose --goal or --goal-file.');
  let goal = values.goal ?? '';
  if (goalFile !== undefined) {
    goal = readFileSync(resolvePath(goalFile), 'utf8');
  } else if (values.goal === '-' || (values.goal === undefined && !process.stdin.isTTY)) {
    goal = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) goal += chunk;
  }
  goal = goal.trim();
  if (!goal) throw new Error('goal is required and must be a non-empty string.');
  return { goal, cwd: resolvePath(values.cwd ?? process.cwd()), tier, gemini_family: family,
    session_id: values.session?.trim(), host_conversation_id: values.host };
}

async function settings(options) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (label, fallback) => (await rl.question(`${label} [${fallback}] `)).trim() || fallback;
  try {
    const sandbox = choose(await ask('Default Codex sandbox', options.sandbox || 'workspace-write'), VALID_SANDBOXES, 'sandbox');
    const utilityModel = await ask('Utility model', options.utilityModel ?? options.plan.utility_model);
    return { failover: options.failover, sandbox, utilityModel };
  } finally {
    rl.close();
  }
}

async function main([command, ...args]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage: gempt <${[...Object.keys(commands), 'wait'].join('|')}> [options]`);
    console.log('Run: --goal - reads stdin. --timeout SECONDS accepts 30–7200 (default 3600).');
    return;
  }
  if (command === 'wait') return runWait(args);
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command '${command}'.`);
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { ...commands[command], config: string, json: flag } });
  const sizes = {
    tier: [0, 1], sandbox: [0, 1], effort: [0, 1], steer: [2], interrupt: [1], 'reply-tool': [3], 'prune-worktrees': [0, 1],
    board: [1, 2], swarm: [1, 2],
  };
  if (!(sizes[command] || [0]).includes(positionals.length)) throw new Error(`Unexpected arguments for gempt ${command}.`);
  const configPath = resolveConfigPath(values.config);
  const config = readJsonSafe(configPath);
  const [value, second, third] = positionals;
  const target = agyInstallPaths(values.target).target;
  let result;
  switch (command) {
    case 'mcp':
      return serveStdio(process.stdin, process.stdout, { ...process.env, GEMPT_CONFIG: configPath });
    case 'run': {
      const access = choose(values.access, ['change', 'inspect'], '--access') ?? 'change';
      const workspace = choose(values.workspace, ['inherit', 'share'], '--workspace') ?? 'inherit';
      const cliChoice = choose(values.cli, CLI_CHOICES, '--cli');
      const timeoutSec = validateExecTimeoutSec(values.timeout === undefined ? undefined : Number(values.timeout));
      const args = await goalArgs(values, TIER_ORDER);
      const syncBudget = Number(process.env.GEMPT_GPT_RUN_SYNC_SEC);
      const waitSec = Number.isFinite(syncBudget) && syncBudget > 0 ? Math.min(syncBudget, 10) : 0;
      const runPayload = { ...args, access, workspace, title: values.title, timeout_sec: timeoutSec,
        ...(cliChoice ? { cli: cliChoice } : {}),
        background: waitSec === 0, sandbox: access === 'inspect' ? 'read-only' : undefined, mcp: true,
        expected_report: 'Report concisely: changed files, verification commands/results, and any remaining blockers. Omit verbose raw logs.',
      };
      const runOpts = { configPath, waitSec };
      const run = (await tryDelegateDispatch(runPayload, runOpts)) ?? (await dispatchRun(runPayload, runOpts));
      const { run_id, session_id, state, worktree_path = null, cwd, tier = null, execution_timeout_sec } = run;
      const receipt = { run_id, session_id, state, worktree_path, cwd, tier, execution_timeout_sec };
      if (ACTIVE_STATES.has(state) || state === 'interrupted') {
        const wait_command = buildWaitCommand(run_id);
        print({ ...receipt, wait_command,
          ...(state === 'waiting_gemini' ? { pending_tool_call: run.pending_tool_call } : {}) });
        return Number(state === 'interrupted');
      }
      const { model, reasoning_effort, verification, usage, text } = run;
      print({ ...receipt, model, reasoning_effort, verification, usage, text: compactReceiptText(text, session_id) });
      return Number(['failed', 'unverified'].includes(verification?.status));
    }
    case 'ask': {
      const args = await goalArgs(values, ['chore', ...TIER_ORDER]);
      const response = await handleTool('gpt_ask', { ...args, file_paths: values.file }, process.env, { configPath });
      console.log(response.content[0].text);
      return Number(Boolean(response.isError));
    }
    case 'install-agy':
      result = await installAgy({ target, source: values.source, force: values.force });
      break;
    case 'print-mcp':
      result = values.installed ? JSON.parse(readFileSync(join(target, 'mcp_config.json'), 'utf8'))
        : buildMcpSnippet({ antigravityPluginDir: target, preferInstalled: false }).config;
      break;
    case 'status':
      if (values['run-id'] || values['run-ids'] || values.wait || values['wait-all']) {
        return runWait(['status', ...Object.entries(values).filter(([key]) => !['config', 'json'].includes(key))
          .flatMap(([key, entry]) => entry === true ? [`--${key}`] : [`--${key}`, entry])], { readOnly: true });
      }
      result = await readState({ configPath });
      break;
    case 'discover': {
      const [state, codex] = await Promise.all([readState({ configPath }), findCodexCli(config?.codex?.cli_path)]);
      const magpieCli = findMagpieCli(config?.magpie?.cli_path);
      result = { ...state, config: { path: configPath, exists: !!config },
        magpie: { ...state.magpie, cli_path: magpieCli }, codex: { found: Boolean(codex), path: codex || '' } };
      break;
    }
    case 'init':
      result = await initSubscriptionConfig({ configPath,
        failover: choose(values.failover, VALID_FAILOVER_MODES, 'failover'),
        sandbox: choose(values.sandbox, VALID_SANDBOXES, 'sandbox'),
        utilityModel: values['utility-model'],
        dryRun: values['dry-run'], chooseSettings: process.stdin.isTTY && !values['non-interactive'] ? settings : undefined });
      break;
    case 'tier':
    case 'sandbox':
    case 'effort': {
      if (!config) throw new Error(`GemPT config not found: ${configPath}`);
      const defaultTier = normalizeDefaultTier(config.routing_policy?.default_tier) || 'sonnet';
      if (command === 'tier') {
        const tier = choose(value, TIER_ORDER, 'tier') || defaultTier;
        if (value) result = setDefaultTier(tier, { configPath });
        else {
          const entry = { ...DEFAULT_TIERS[tier], ...config.tiers?.[tier] };
          result = { default_tier: tier, config_path: configPath,
            resolved: { model: entry.consult_model, reasoning_effort: entry.reasoning_effort } };
        }
      } else if (command === 'sandbox') {
        result = value ? setDefaultSandbox(choose(value, VALID_SANDBOXES, 'sandbox'), { configPath })
          : { default_sandbox: config.codex?.default_sandbox || 'workspace-write', config_path: configPath };
      } else {
        const tier = choose(values.tier, TIER_ORDER, 'tier') || defaultTier;
        choose(value, ['low', 'medium', 'high', 'xhigh', 'auto'], 'effort');
        result = value ? setEffortSettings({ tier, tierEffort: value === 'auto' ? undefined : value,
          autoEffort: value === 'auto' }, { configPath })
          : { tier, default_tier: defaultTier, auto_effort: Boolean(config.routing_policy?.auto_effort),
            reasoning_effort: config.tiers?.[tier]?.reasoning_effort || DEFAULT_TIERS[tier].reasoning_effort, config_path: configPath };
      }
      break;
    }
    case 'steer':
      result = await steerRun(value, second, { configPath });
      break;
    case 'interrupt':
      result = await interruptRun(value, { configPath });
      break;
    case 'reply-tool':
      result = replyToolCall(value, second, third, { success: !values.failure });
      break;
    case 'prune-worktrees': {
      const repoPath = resolvePath(value || process.cwd());
      const hours = values['max-age-hours'] !== undefined ? Number(values['max-age-hours']) : 168;
      if (!Number.isFinite(hours) || hours < 0) throw new Error('Invalid --max-age-hours value.');
      result = pruneShareWorktrees(repoPath, { maxAgeMs: hours * 3600 * 1000 });
      break;
    }
    case 'board': {
      const sub = choose(value, ['post', 'read', 'roster'], 'board action');
      const swarmId = values.swarm || process.env.GEMPT_SWARM_ID;
      let text = values.text ?? second;
      if (sub === 'post' && (text === '-' || (text === undefined && !process.stdin.isTTY))) {
        text = '';
        for await (const chunk of process.stdin.setEncoding('utf8')) text += chunk;
      }
      const seqs = values.seqs ? values.seqs.split(',').map((s) => Number(s.trim())).filter(Boolean) : undefined;
      result = await handleBoardAction({
        action: sub,
        swarm_id: swarmId,
        from: values.from || process.env.GEMPT_AGENT_NAME || 'coordinator',
        kind: values.kind,
        text,
        since: values.since !== undefined ? Number(values.since) : undefined,
        seqs,
        limit: values.limit !== undefined ? Number(values.limit) : undefined,
        reply_to_seq: values['reply-to'] !== undefined ? Number(values['reply-to']) : undefined,
      }, { configPath });
      break;
    }
    case 'swarm': {
      const sub = choose(value, ['title', 'plan', 'add', 'status', 'kill', 'model'], 'swarm action');
      const swarmId = values.swarm || process.env.GEMPT_SWARM_ID;
      const cwd = values.cwd ? resolvePath(values.cwd) : process.cwd();
      if (sub === 'title') {
        result = await handleSwarmAction({ action: 'title', swarm_id: swarmId, cwd, host_conversation_id: values.host,
          title: values.title ?? second }, { configPath });
      } else if (sub === 'plan') {
        const plan = values['plan-json'] ? JSON.parse(values['plan-json']) : {};
        if (values['goal-title'] || values['goal-line']) {
          plan.goal = { ...(plan.goal || {}), ...(values['goal-title'] ? { title: values['goal-title'] } : {}),
            ...(values['goal-line'] ? { line: values['goal-line'] } : {}) };
        }
        result = await handleSwarmAction({ action: 'plan', swarm_id: swarmId, cwd, host_conversation_id: values.host,
          ...plan }, { configPath });
      } else if (sub === 'add') {
        let brief = values.brief;
        if (values['brief-file']) brief = readFileSync(resolvePath(values['brief-file']), 'utf8');
        else if (brief === '-' || (brief === undefined && !process.stdin.isTTY)) {
          brief = '';
          for await (const chunk of process.stdin.setEncoding('utf8')) brief += chunk;
        }
        result = await handleSwarmAction({
          action: 'add',
          swarm_id: swarmId,
          cwd,
          host_conversation_id: values.host,
          gemini_family: values.family,
          name: second,
          brief,
          access: choose(values.access, ['change', 'inspect'], '--access'),
          workspace: choose(values.workspace, ['inherit', 'share'], '--workspace'),
          cli: values.cli,
          model: values.model,
          tier: values.tier,
          n: values.n !== undefined ? Number(values.n) : undefined,
          tasks: values.task?.length ? values.task : undefined,
          timeout_sec: values.timeout !== undefined ? Number(values.timeout) : undefined,
        }, { configPath });
      } else if (sub === 'status') {
        result = await handleSwarmAction({ action: 'status', swarm_id: swarmId, cwd, host_conversation_id: values.host }, { configPath });
      } else if (sub === 'kill') {
        result = await handleSwarmAction({ action: 'kill', swarm_id: swarmId, name: second }, { configPath });
      } else if (sub === 'model') {
        result = await handleSwarmAction({
          action: 'model', swarm_id: swarmId, cwd, name: second,
          model: values.model, tier: values.tier, cli: values.cli, reason: values.reason,
        }, { configPath });
      }
      break;
    }
  }
  if (result?.ok === false) throw new Error(result.error || `${command} failed.`);
  print(result);
}

try {
  process.exitCode = (await main(process.argv.slice(2))) || 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

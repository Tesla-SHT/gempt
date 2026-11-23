#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_AGY_TARGET, installAgy } from '../core/agy-install.mjs';
import { handleTool, serveStdio } from '../core/mcp-server.mjs';
import { ACTIVE_STATES, buildWaitCommand, compactReceiptText, dispatchRun, interruptRun, replyToolCall,
  steerRun, validateExecTimeoutSec } from '../core/runs.mjs';
import { resolvePath } from '../core/state.mjs';
import { runWait } from '../core/wait.mjs';
import { pruneShareWorktrees } from '../core/worktrees.mjs';
import { findCodexCli } from '../magpie_plugin/lib/app-server-manager.mjs';
import {
  DEFAULT_TIERS, TIER_ORDER, VALID_FAILOVER_MODES, VALID_SANDBOXES, buildMcpSnippet, createNativeGroups,
  findMagpieCli, initSubscriptionConfig, normalizeDefaultTier, previewNativeGroups, readJsonSafe, readState,
  resolveConfigPath, setDefaultSandbox, setDefaultTier, setEffortSettings,
} from '../magpie_plugin/lib/backend.mjs';

const string = { type: 'string' };
const flag = { type: 'boolean' };
const goalOptions = { goal: string, 'goal-file': string, cwd: string, tier: string,
  family: string, session: string, host: string };
const commands = {
  'install-agy': { target: string, source: string, force: flag },
  run: { ...goalOptions, access: string, workspace: string, title: string, timeout: string },
  ask: { ...goalOptions, file: { ...string, multiple: true } },
  mcp: {}, discover: {}, status: { 'run-id': string, 'run-ids': string, wait: flag, 'wait-all': flag },
  init: { 'non-interactive': flag, failover: string, strategy: string, sandbox: string,
    'utility-model': string, 'sync-magpie': flag, 'use-groups': flag, 'dry-run': flag },
  tier: {}, sandbox: {}, effort: { tier: string }, steer: {}, interrupt: {},
  'reply-tool': { failure: flag }, 'prune-worktrees': { 'max-age-hours': string },
  presets: { preview: flag, apply: flag }, 'print-mcp': { installed: flag, target: string },
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
    const failover = choose(await ask('Failover mode', options.failover), VALID_FAILOVER_MODES, 'failover');
    const sandbox = choose(await ask('Default Codex sandbox', options.sandbox || 'workspace-write'), VALID_SANDBOXES, 'sandbox');
    const utilityModel = await ask('Utility model', options.utilityModel ?? options.plan.utility_model);
    const syncGroups = /^y(?:es)?$/i.test(await ask('Sync Magpie harness groups? (y/n)', options.syncGroups ? 'y' : 'n'));
    const useGroups = syncGroups ? /^y(?:es)?$/i.test(await ask('Use the harness groups for GemPT tiers? (y/n)', 'y')) : options.useGroups;
    return { failover, sandbox, utilityModel, syncGroups, useGroups };
  } finally {
    rl.close();
  }
}

async function main([command, ...args]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage: gempt <${[...Object.keys(commands), 'wait'].join('|')}> [options]`);
    return;
  }
  if (command === 'wait') return runWait(args);
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command '${command}'.`);
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { ...commands[command], config: string, json: flag } });
  const sizes = { tier: [0, 1], sandbox: [0, 1], effort: [0, 1], steer: [2], interrupt: [1], 'reply-tool': [3], 'prune-worktrees': [0, 1] };
  if (!(sizes[command] || [0]).includes(positionals.length)) throw new Error(`Unexpected arguments for gempt ${command}.`);
  const configPath = resolveConfigPath(values.config);
  const config = readJsonSafe(configPath);
  const [value, second, third] = positionals;
  const target = resolvePath(values.target || DEFAULT_AGY_TARGET);
  let result;
  switch (command) {
    case 'mcp':
      return serveStdio(process.stdin, process.stdout, { ...process.env, GEMPT_CONFIG: configPath });
    case 'run': {
      const access = choose(values.access, ['change', 'inspect'], '--access') ?? 'change';
      const workspace = choose(values.workspace, ['inherit', 'share'], '--workspace') ?? 'inherit';
      const timeoutSec = validateExecTimeoutSec(values.timeout === undefined ? undefined : Number(values.timeout));
      const args = await goalArgs(values, TIER_ORDER);
      const syncBudget = Number(process.env.GEMPT_GPT_RUN_SYNC_SEC);
      const waitSec = Number.isFinite(syncBudget) && syncBudget > 0 ? Math.min(syncBudget, 10) : 0;
      const run = await dispatchRun({ ...args, access, workspace, title: values.title, timeout_sec: timeoutSec,
        background: waitSec === 0, sandbox: access === 'inspect' ? 'read-only' : undefined, mcp: true,
        expected_report: 'Report concisely: changed files, verification commands/results, and any remaining blockers. Omit verbose raw logs.',
      }, { configPath, waitSec });
      const { run_id, session_id, state, worktree_path = null, cwd, tier = null } = run;
      const receipt = { run_id, session_id, state, worktree_path, cwd, tier };
      if (ACTIVE_STATES.has(state) || state === 'interrupted') {
        const wait_command = buildWaitCommand(run_id);
        print({ ...receipt, wait_command, text: state === 'waiting_gemini'
          ? `Run ${run_id} is waiting for ask_gemini reply (use gempt reply-tool).`
          : `Run ${run_id} started. Execute \`${wait_command}\` via run_command(WaitMsBeforeAsync=500) for zero-poll wakeup.` });
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
        strategy: choose(values.strategy, ['order', 'smart', 'rotate', 'pace', 'drain', 'usage'], 'strategy'),
        sandbox: choose(values.sandbox, VALID_SANDBOXES, 'sandbox'),
        utilityModel: values['utility-model'], syncGroups: values['sync-magpie'], useGroups: values['use-groups'],
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
    case 'presets':
      if (values.apply && values.preview) throw new Error('Choose --preview or --apply.');
      result = values.apply ? await createNativeGroups({ configPath }) : previewNativeGroups();
      if (values.apply && result.ok) result.applied = true;
      break;
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

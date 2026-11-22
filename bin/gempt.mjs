#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_AGY_TARGET, installAgy } from '../core/agy-install.mjs';
import { serveStdio } from '../core/mcp-server.mjs';
import { interruptRun, replyToolCall, steerRun } from '../core/runs.mjs';
import { resolvePath } from '../core/state.mjs';
import { runWait } from '../core/wait.mjs';
import { findCodexCli } from '../magpie_plugin/lib/app-server-manager.mjs';
import {
  DEFAULT_TIERS, TIER_ORDER, VALID_FAILOVER_MODES, VALID_SANDBOXES, buildMcpSnippet, createNativeGroups,
  findMagpieCli, initSubscriptionConfig, normalizeDefaultTier, previewNativeGroups, readJsonSafe, readState,
  resolveConfigPath, setDefaultSandbox, setDefaultTier, setEffortSettings,
} from '../magpie_plugin/lib/backend.mjs';

const string = { type: 'string' };
const flag = { type: 'boolean' };
const commands = {
  'install-agy': { target: string, source: string, force: flag },
  mcp: {}, discover: {}, status: { 'run-id': string, 'run-ids': string, wait: flag, 'wait-all': flag },
  init: { 'non-interactive': flag, failover: string, strategy: string, sandbox: string,
    'utility-model': string, 'sync-magpie': flag, 'use-groups': flag, 'dry-run': flag },
  tier: {}, sandbox: {}, effort: { tier: string }, steer: {}, interrupt: {},
  'reply-tool': { failure: flag }, presets: { preview: flag, apply: flag }, 'print-mcp': { installed: flag, target: string },
};
const print = (value) => console.log(JSON.stringify(value, null, 2));

function choose(value, allowed, label) {
  if (value !== undefined && !allowed.includes(value)) throw new Error(`Invalid ${label} '${value}'. Choose ${allowed.join(', ')}.`);
  return value;
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
  const sizes = { tier: [0, 1], sandbox: [0, 1], effort: [0, 1], steer: [2], interrupt: [1], 'reply-tool': [3] };
  if (!(sizes[command] || [0]).includes(positionals.length)) throw new Error(`Unexpected arguments for gempt ${command}.`);
  const configPath = resolveConfigPath(values.config);
  const config = readJsonSafe(configPath);
  const [value, second, third] = positionals;
  const target = resolvePath(values.target || DEFAULT_AGY_TARGET);
  let result;
  switch (command) {
    case 'mcp':
      return serveStdio(process.stdin, process.stdout, { ...process.env, GEMPT_CONFIG: configPath });
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

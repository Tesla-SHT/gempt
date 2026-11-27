#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { installAgy } from '../core/agy-install.mjs';
import { handleBoardMcpTool } from '../core/board-mcp.mjs';
import { agyInstallPaths } from '../core/bundle-paths.mjs';
import { CLI_CHOICES } from '../core/config.mjs';
import { readHostContext } from '../core/host-context.mjs';
import { handleTool, serveStdio } from '../core/mcp-server.mjs';
import { ACTIVE_STATES, buildReplyCommand, buildWaitCommand, dispatchRun, interruptRun, pendingToolCalls,
  readRun, replyToolCall, steerRun, tryDelegateDispatch, validateExecTimeoutSec } from '../core/runs.mjs';
import { resolvePath } from '../core/state.mjs';
import { resolveSwarmId } from '../core/swarm-bus.mjs';
import { handleSwarmAction } from '../core/swarm-engine.mjs';
import { runWait, STATUS_USAGE, waitUsage } from '../core/wait.mjs';
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
  ask: { ...goalOptions, 'max-output-tokens': string, file: { ...string, multiple: true } },
  mcp: {}, discover: {}, status: { 'run-id': string, 'run-ids': string, wait: flag, 'wait-all': flag,
    'heartbeat-sec': string, 'stale-sec': string },
  init: { 'non-interactive': flag, failover: string, sandbox: string,
    'utility-model': string, 'dry-run': flag },
  tier: {}, sandbox: {}, effort: { tier: string }, steer: {}, interrupt: {},
  'reply-tool': { failure: flag, text: string, message: string }, 'prune-worktrees': { 'max-age-hours': string },
  'print-mcp': { installed: flag, target: string },
  board: { swarm: string, from: string, kind: string, text: string, since: string, seqs: string, limit: string,
    'reply-to': string, channel: string, 'request-id': string, status: flag, 'no-mentions-only': flag,
    reason: string, context: string, media: { ...string, multiple: true }, 'args-json': string },
  swarm: { swarm: string, cwd: string, title: string, brief: string, 'brief-file': string, access: string, workspace: string,
    cli: string, model: string, tier: string, n: string, task: { ...string, multiple: true }, reason: string,
    'goal-title': string, 'goal-line': string, 'plan-json': string, host: string, family: string, timeout: string },
};
const goalUsage = '[--goal TEXT|- | --goal-file PATH] [--cwd PATH] [--tier TIER] [--family FAMILY] [--session ID] [--host ID]';
const usages = {
  'install-agy': '[--target PATH] [--source PATH] [--force]',
  run: `${goalUsage} [--access change|inspect] [--workspace inherit|share] [--title TITLE] [--timeout SECONDS|none|unlimited] [--cli CLI]`,
  ask: `${goalUsage} [--file PATH ...] [--max-output-tokens N]`,
  mcp: '',
  discover: '',
  init: '[--non-interactive] [--failover MODE] [--sandbox MODE] [--utility-model MODEL] [--dry-run]',
  tier: '[TIER]',
  sandbox: '[MODE]',
  effort: '[low|medium|high|xhigh|auto] [--tier TIER]',
  steer: 'RUN_ID MESSAGE',
  interrupt: 'RUN_ID',
  'reply-tool': 'RUN_ID CALL_ID TEXT|- [--failure]\n       gempt reply-tool RUN_ID [CALL_ID] (--text | --message) TEXT|- [--failure]',
  'prune-worktrees': '[REPO_PATH] [--max-age-hours N]',
  'print-mcp': '[--installed] [--target PATH]',
  board: {
    post: '[TEXT|- | --text TEXT|-] [--from NAME] [--kind KIND] [--channel NAME] [--reply-to SEQ] [--request-id ID]',
    read: '[--since SEQ] [--seqs SEQ[,SEQ...]] [--limit N] [--channel NAME] [--status]',
    roster: '',
    wait: '--since N [--no-mentions-only] [--channel NAME]',
    ask: 'QUESTION|- [--reason visual_check|clarification|decision|blocked] [--context TEXT] [--media PATH ...]',
    'publish-view': '[- | --args-json JSON|-]',
    swarm: '<status|add|kill|model|models|channel> [--args-json JSON|-]',
  },
  swarm: {
    title: '[TITLE | --title TITLE]',
    plan: '[--plan-json JSON] [--goal-title TITLE] [--goal-line TEXT]',
    add: 'NAME [--brief TEXT|- | --brief-file PATH] [--access change|inspect] [--workspace inherit|share]'
      + ' [--cli CLI] [--model MODEL] [--tier TIER] [--n N] [--task TEXT ...] [--family FAMILY] [--timeout SECONDS|none|unlimited]',
    status: '',
    kill: 'NAME',
    model: 'NAME [--model MODEL] [--tier TIER] [--cli CLI] [--reason TEXT]',
  },
};

function usage(command, action) {
  if (command === 'wait') return waitUsage('gempt wait');
  if (command === 'status') return STATUS_USAGE;
  const syntax = Object.hasOwn(usages, command) ? usages[command] : undefined;
  if (syntax === undefined) return `Usage: gempt <${[...Object.keys(commands), 'wait'].join('|')}> [options]\n       gempt COMMAND --help`;
  if (typeof syntax === 'string') return `Usage: gempt ${command}${syntax ? ` ${syntax}` : ''} [--config PATH] [--json]`;
  const actions = Object.hasOwn(syntax, action) ? [action] : Object.keys(syntax);
  const shared = command === 'swarm' ? ' [--cwd PATH] [--host ID]' : '';
  return actions.map((name, i) => `${i ? '       ' : 'Usage: '}gempt ${command} ${name}${syntax[name] ? ` ${syntax[name]}` : ''}`
    + ` [--swarm SWARM_ID]${shared} [--config PATH] [--json]`).join('\n');
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) text += chunk;
  return text;
}
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
    goal = await readStdin();
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

function parseTimeout(value) {
  if (value === undefined) return undefined;
  if (/^(none|unlimited)$/i.test(value.trim())) return null;
  return validateExecTimeoutSec(value.trim() ? Number(value) : NaN);
}

async function readBoardJson(source) {
  const args = JSON.parse(source === '-' ? await readStdin() : source);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected a JSON object.');
  return args;
}

async function boardToolArgs(action, operand, values) {
  if (operand !== undefined && ['read', 'roster', 'wait'].includes(action)) {
    throw new Error(`Unexpected arguments for gempt board ${action}.`);
  }
  switch (action) {
    case 'post': {
      if (operand !== undefined && values.text !== undefined) throw new Error('Choose TEXT or --text.');
      let text = values.text ?? operand;
      if (text === '-' || (text === undefined && !process.stdin.isTTY)) text = await readStdin();
      return { text, kind: values.kind, channel: values.channel, request_id: values['request-id'],
        reply_to_seq: values['reply-to'] !== undefined ? Number(values['reply-to']) : undefined };
    }
    case 'read':
      return { since: values.since !== undefined ? Number(values.since) : undefined,
        seqs: values.seqs ? values.seqs.split(',').map((s) => Number(s.trim())).filter(Boolean) : undefined,
        limit: values.limit !== undefined ? Number(values.limit) : undefined, channel: values.channel, status: values.status };
    case 'roster':
      return {};
    case 'wait':
      if (!values.since?.trim()) throw new Error('board wait requires --since N.');
      return { since: Number(values.since), channel: values.channel, mentions_only: !values['no-mentions-only'] };
    case 'ask':
      return { question: operand === '-' ? await readStdin() : operand,
        reason: choose(values.reason, ['visual_check', 'clarification', 'decision', 'blocked'], '--reason'),
        context: values.context, media_paths: values.media };
    case 'publish-view': {
      if (operand !== undefined && (operand !== '-' || values['args-json'] !== undefined)) throw new Error('Use --args-json JSON or stdin.');
      const source = values['args-json'] ?? operand;
      if (source === undefined && process.stdin.isTTY) throw new Error('A narrator view is required.');
      return readBoardJson(source ?? '-');
    }
    case 'swarm': {
      if (!operand) throw new Error('A swarm action is required.');
      const args = values['args-json'] === undefined ? {} : await readBoardJson(values['args-json']);
      return { ...args, action: operand };
    }
  }
}

async function runBoard(action, operand, values, configPath) {
  choose(action, Object.keys(usages.board), 'board action');
  const env = process.env;
  const options = { configPath };
  if (env.GEMPT_SWARM_ID && env.GEMPT_AGENT_NAME) {
    if (values.from !== undefined && values.from.trim().toLowerCase() !== env.GEMPT_AGENT_NAME.trim().toLowerCase()) {
      throw new Error('--from must match GEMPT_AGENT_NAME for a swarm worker.');
    }
    if (values.swarm !== undefined && values.swarm.trim() !== env.GEMPT_SWARM_ID.trim()) {
      throw new Error('--swarm must match GEMPT_SWARM_ID for a swarm worker.');
    }
  } else {
    const swarmId = (values.swarm || env.GEMPT_SWARM_ID)?.trim();
    if (!swarmId) options.hostConversationId = readHostContext(configPath).conversation_id;
    options.swarmId = swarmId || await resolveSwarmId({
      hostConversationId: options.hostConversationId, sessionsDir: env.GEMPT_SESSIONS_DIR });
    const from = values.from || env.GEMPT_AGENT_NAME || 'coordinator';
    // Manual post/read/roster historically run as coordinator, with a selectable sender or viewer.
    if (['post', 'read', 'roster'].includes(action)) {
      options.agentName = 'coordinator';
      options.defaultFrom = from;
    } else {
      options.agentName = from;
    }
  }
  const args = await boardToolArgs(action, operand, values);
  const response = await handleBoardMcpTool(`board_${action.replace('-', '_')}`, args, env, options);
  return JSON.parse(response.content[0].text);
}

async function main([command, ...args]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'wait') return runWait(args, { command: 'gempt wait' });
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command '${command}'.`);
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: command === 'board',
    options: { ...commands[command], config: string, json: flag, help: { ...flag, short: 'h' } } });
  if (values.help) {
    console.log(usage(command, positionals[0]));
    return;
  }
  // parseArgs collects repeated --media flags. Also collect consecutive paths after each flag.
  if (command === 'board' && positionals[0] === 'ask' && values.media && positionals.length > 2) {
    values.media = [];
    positionals.length = 0;
    let readingMedia = false;
    for (const token of tokens) {
      if (token.kind === 'positional') {
        if (readingMedia && positionals.length >= 2) values.media.push(token.value);
        else positionals.push(token.value);
      } else {
        readingMedia = token.name === 'media';
        if (readingMedia) values.media.push(token.value);
      }
    }
  }
  const sizes = {
    tier: [0, 1], sandbox: [0, 1], effort: [0, 1], steer: [2], interrupt: [1], status: [0, 1],
    'reply-tool': [1, 2, 3], 'prune-worktrees': [0, 1],
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
      const timeoutSec = parseTimeout(values.timeout);
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
      const { run_id, session_id, state, worktree_path = null, cwd, tier = null, execution_timeout_sec, deadline } = run;
      const receipt = { run_id, session_id, state, worktree_path, cwd, tier, execution_timeout_sec, deadline };
      if (ACTIVE_STATES.has(state) || state === 'interrupted') {
        const wait_command = buildWaitCommand(run_id);
        const pending = pendingToolCalls(run)[0];
        print({ ...receipt, wait_command, ...(pending && {
          pending_tool_call: pending, reply_command: buildReplyCommand(run_id, pending.call_id),
        }) });
        return Number(state === 'interrupted');
      }
      const { model, reasoning_effort, verification, usage, text } = run;
      print({ ...receipt, model, reasoning_effort, verification, usage, text });
      return Number(['failed', 'unverified'].includes(verification?.status));
    }
    case 'ask': {
      const args = await goalArgs(values, ['chore', ...TIER_ORDER]);
      const response = await handleTool('gpt_ask', { ...args, file_paths: values.file,
        max_output_tokens: values['max-output-tokens'] === undefined ? undefined : Number(values['max-output-tokens']) }, process.env, { configPath });
      console.log(response.content[0].text);
      if (response.isError) console.error(usage(command));
      return Number(Boolean(response.isError));
    }
    case 'install-agy':
      result = await installAgy({ target, source: values.source, force: values.force });
      break;
    case 'print-mcp':
      result = values.installed ? JSON.parse(readFileSync(join(target, 'mcp_config.json'), 'utf8'))
        : buildMcpSnippet({ antigravityPluginDir: target, preferInstalled: false }).config;
      break;
    case 'status': {
      if (value !== undefined && (values['run-id'] !== undefined || values['run-ids'] !== undefined)) {
        throw new Error('Use a positional RUN_ID or a run ID option.');
      }
      if (value !== undefined) values['run-id'] = value;
      if (Object.keys(values).some((key) => !['config', 'json'].includes(key))) {
        return runWait(['status', ...Object.entries(values).filter(([key]) => !['config', 'json'].includes(key))
          .flatMap(([key, entry]) => entry === true ? [`--${key}`] : [`--${key}`, entry])], { readOnly: true });
      }
      result = await readState({ configPath });
      break;
    }
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
    case 'reply-tool': {
      if (values.text !== undefined && values.message !== undefined) throw new Error('Choose --text or --message.');
      const optionText = values.text ?? values.message;
      if ((optionText === undefined && third === undefined) || (optionText !== undefined && third !== undefined)) {
        throw new Error('Expected a reply body once. Use CALL_ID TEXT or [CALL_ID] --text TEXT.');
      }
      let callId = second;
      if (callId === undefined) {
        const pending = pendingToolCalls(readRun(value));
        if (pending.length !== 1) throw new Error(pending.length
          ? `Run ${value} has multiple pending tool calls (${pending.map((call) => call.call_id).join(', ')}). Specify CALL_ID.`
          : `Run ${value} has no pending waiting_gemini tool call.`);
        callId = pending[0].call_id;
      }
      const body = optionText ?? third;
      result = replyToolCall(value, callId, body === '-' ? await readStdin() : body, { success: !values.failure });
      break;
    }
    case 'prune-worktrees': {
      const repoPath = resolvePath(value || process.cwd());
      const hours = values['max-age-hours'] !== undefined ? Number(values['max-age-hours']) : 168;
      if (!Number.isFinite(hours) || hours < 0) throw new Error('Invalid --max-age-hours value.');
      result = pruneShareWorktrees(repoPath, { maxAgeMs: hours * 3600 * 1000 });
      break;
    }
    case 'board':
      result = await runBoard(value, second, values, configPath);
      break;
    case 'swarm': {
      const sub = choose(value, ['title', 'plan', 'add', 'status', 'kill', 'model'], 'swarm action');
      const requiresName = ['add', 'kill', 'model'].includes(sub);
      if ((requiresName && !second) || (!requiresName && second !== undefined && (sub !== 'title' || values.title !== undefined))) {
        throw new Error(`Unexpected arguments for gempt swarm ${sub}.`);
      }
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
          brief = await readStdin();
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
          timeout_sec: parseTimeout(values.timeout),
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
  const [, , command, firstArgument] = process.argv;
  console.error(usage(command, firstArgument));
  process.exitCode = 1;
}

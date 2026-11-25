import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const runtime = existsSync(new URL('./runtime/core/host-context.mjs', import.meta.url)) ? './runtime/' : '../';
const [{ WORKLOAD }, { readHostContext, updateHostContext }, { atomicJson, resolvePath, withLock }, backend, { GEMPT_VERSION, getNativeSwarmPolicy }] = await Promise.all([
  import(`${runtime}core/assets.mjs`), import(`${runtime}core/host-context.mjs`),
  import(`${runtime}core/state.mjs`), import(`${runtime}magpie_plugin/lib/backend.mjs`), import(`${runtime}core/config.mjs`),
]);
const { explicitTitle, readJsonSafe, resolveConfigPath, resolveSessionsDir } = backend;
const configPath = resolveConfigPath();
const readTools = new Set('read_file view_file view_file_outline view_code_item grep_search find_by_name list_dir'.split(' '));
const assetExts = new Set('png jpg jpeg webp gif bmp ico svg mp4 mov webm wav mp3 pdf'.split(' '));
const docExts = new Set('md mdx txt rst adoc'.split(' '));
const configExts = new Set('json toml yaml yml ini cfg conf env'.split(' '));
const sourceExts = new Set('py pyi js mjs cjs ts tsx jsx go rs java kt scala c cc cpp cxx h hpp cs rb php sh bash zsh ps1 psm1 bat cmd css scss less html htm vue svelte sql lua gd swift m mm r jl dart ex exs zig'.split(' '));
const exemptParts = [
  '/.gemini/antigravity/mcp/', '/.gemini/antigravity/brain/', '/.gemini/config/plugins/',
  '/.zcode/skills/', '/agent-skills/', '/.config/gempt/',
];
const override = /自己改|自己查|自己做|不用\s*gpt|别用\s*gpt|别派\s*gpt|不要\s*gpt|别转\s*gpt|gemini\s*(?:自己|直接)?(?:做|改|查|处理)|\b(?:no\s+gpt|skip\s+gempt|bypass\s+gempt|don'?t\s+use\s+gpt)\b/i;
const swarmOverride = /(?:不用|别用|不要|跳过)\s*swarm|\b(?:direct\s+gpt_run|skip\s+swarm|no\s+swarm)\b/i;
const waitCommand = /\bgempt-wait\b|\bgempt\s+status\b[^\n]*--wait\b/i;
const readCommand = /(?:^|[;&|\r\n]\s*)(?:(?:sudo|command|time)\s+)?(?:Get-Content|Select-String|Get-ChildItem|gc|sls|gci|cat|head|tail|rg|ripgrep|grep|findstr|find|ls|dir|tree|sed|awk|wc|git\s+(?:diff|show|log|grep|status)|type)(?:\.exe)?(?=\s|$)/i;
const milestones = [120, 200, 280];
const banners = {
  gemini_first: 'Handle routine edits/reads in Gemini; route heavy debugging, long test loops, expert review, or multi-worker tasks to gpt_swarm / gpt_run / gpt_ask.',
  balanced: 'Coordinate conversation & design in Gemini; delegate engineering, source edits, and multi-worker tasks via shell-free gpt_swarm(action="add") / gpt_board or gpt_run.',
  gpt: "Route repo investigation & code changes to shell-free gpt_swarm(action='add') / gpt_board (or single-task gpt_run) / gpt_ask(file_paths); keep quick Gemini checks <=5 steps.",
  gpt_first: 'Delegate this turn immediately via shell-free gpt_swarm(action="add") + gpt_board or a persistent gpt_run(cwd, session_id=...) thread; reserve Gemini for <=2 quick checks/visuals (for coding-only workspaces, consider using Codex CLI directly).',
};
const now = () => Date.now() / 1000;
const text = (value) => typeof value === 'string' ? value.trim() : '';
const step = (systemMessage) => ({ systemMessage: { systemMessage } });

const swarmTools = new Set(['swarm', 'post_message', 'read_board', 'swarm_wait', 'define_subagent', 'send_message']);

function readRoutingPolicy() {
  try {
    const policy = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))?.routing_policy;
    const work = typeof policy?.work_split === 'string' && Object.hasOwn(WORKLOAD.profiles, policy.work_split)
      ? policy.work_split : 'balanced';
    const rawSwarm = typeof policy?.swarm_split === 'string' ? policy.swarm_split : 'inherit';
    const swarm = rawSwarm === 'inherit' || Object.hasOwn(WORKLOAD.profiles, rawSwarm)
      ? rawSwarm : 'inherit';
    return { work_split: work, swarm_split: swarm, ...getNativeSwarmPolicy(policy) };
  } catch {
    return { work_split: 'balanced', swarm_split: 'inherit', ...getNativeSwarmPolicy() };
  }
}

function truthyEnv(value) {
  const raw = text(value).toLowerCase();
  return Boolean(raw) && !['0', 'false', 'no', 'off', 'solo', 'none'].includes(raw);
}

function envSwarmSignal(env = process.env) {
  return truthyEnv(env.GEMPT_SWARM_MODE) || truthyEnv(env.GEMPT_IS_SWARM) || truthyEnv(env.GEMPT_SWARM_ROLE);
}

function payloadSwarmSignal(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.isSwarm === true || payload.is_swarm === true
      || payload.isSubagent === true || payload.is_subagent === true) return true;
  for (const key of ['swarmId', 'swarm_id', 'swarmName', 'swarm_name', 'subagentType', 'subagent_type']) {
    if (text(payload[key])) return true;
  }
  for (const key of ['swarmRole', 'swarm_role', 'agentRole', 'agent_role', 'role']) {
    const role = text(payload[key]).toLowerCase();
    if (role && role !== 'solo') return true;
  }
  const conversation = text(payload.conversationId);
  const parent = text(payload.parentConversationId) || text(payload.parent_conversation_id);
  if (parent && parent !== conversation) return true;
  const toolName = text(payload.toolCall?.name);
  if (swarmTools.has(toolName)) return toolName !== 'swarm' || payload.toolCall?.args?.action !== 'models';
  if (toolName === 'invoke_subagent' && text(payload.toolCall?.args?.TypeName) !== 'gempt-worker') return true;
  return false;
}

function workerSignal(payload) {
  const parent = text(payload.parentConversationId) || text(payload.parent_conversation_id);
  const role = [payload.swarmRole, payload.swarm_role, payload.agentRole, payload.agent_role, payload.role, process.env.GEMPT_SWARM_ROLE]
    .map((value) => text(value).toLowerCase()).find(Boolean);
  return payload.isSubagent === true || payload.is_subagent === true || Boolean(text(payload.subagentType) || text(payload.subagent_type))
    || Boolean(parent && parent !== payload.conversationId) || ['worker', 'verifier', 'narrator', 'subagent', 'member'].includes(role)
    || (!role && envSwarmSignal()) || hostSubagentSignal(payload.conversationId);
}

function hostSubagentSignal(conversation) {
  if (!text(conversation)) return false;
  const ctx = readHostContext(configPath);
  return Array.isArray(ctx?.subagent_conversations) && ctx.subagent_conversations.includes(conversation);
}

function stateFilePath(conversation) {
  return join(dirname(configPath), 'hook-state', `${conversation.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}.json`);
}

async function updateState(conversation, operation) {
  if (!text(conversation)) return operation({});
  const file = stateFilePath(conversation);
  try {
    return await withLock(`${file}.node.lock`, () => {
      const stored = readJsonSafe(file);
      const state = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      const previous = JSON.stringify(state);
      const result = operation(state);
      if (JSON.stringify(state) !== previous) {
        try { atomicJson(file, state); } catch {}
      }
      return result;
    });
  } catch {
    return operation(readJsonSafe(file) || {});
  }
}

function setCount(state, key, count) {
  state.explore_count = count;
  if (key) state.turn_key = key;
  state.updated_at = now();
  return count;
}

function healthy() {
  const cfg = readJsonSafe(configPath);
  const configuredCli = String(cfg?.execution?.default_cli || 'auto').trim().toLowerCase();
  const requiresAppServer = !configuredCli || configuredCli === 'auto' || configuredCli === 'codex';
  if (requiresAppServer) {
    const overridePath = text(process.env.GEMPT_APP_SERVER_STATE);
    let state;
    try {
      state = readJsonSafe(overridePath ? resolvePath(overridePath) : join(dirname(configPath), 'app-server.json'));
    } catch {
      return false;
    }
    const pid = Math.trunc(Number(state?.pid));
    if (state?.status !== 'running' || state.healthy === false || !state.ws_url || !(pid > 0)) return false;
    try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  }
  const runs = join(resolveSessionsDir(), 'runs');
  let files;
  try {
    files = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(runs, entry.name, 'state.json');
        return { path, mtime: statSync(path, { throwIfNoEntry: false })?.mtimeMs };
      }).filter(({ mtime }) => mtime !== undefined).sort((left, right) => right.mtime - left.mtime);
  } catch {
    return true;
  }
  const configuredWindow = Number(text(process.env.GEMPT_CIRCUIT_WINDOW_SEC) || 600);
  const window = Number.isNaN(configuredWindow) ? 600 : configuredWindow;
  let failures = 0;
  for (const { path, mtime } of files.slice(0, 10)) {
    const record = readJsonSafe(path);
    if (!['finished', 'failed', 'outcome_unknown'].includes(record?.state)) continue;
    const finished = typeof record.finished_at === 'number' ? record.finished_at : mtime / 1000;
    if (now() - finished > window || record.state === 'finished') break;
    if (++failures >= 2) return false;
  }
  return true;
}

function normalizedPath(path) {
  return path.replaceAll('\\', '/').toLowerCase();
}

function exemptPath(path) {
  const normalized = normalizedPath(path);
  return basename(normalized) === 'skill.md' || exemptParts.some((part) => normalized.includes(part))
    || assetExts.has(extname(normalized).slice(1));
}

function sourceWrite(path, args) {
  if (!path || exemptPath(path)) return false;
  const normalized = normalizedPath(path);
  const suffix = extname(normalized).slice(1);
  if (docExts.has(suffix)) return false;
  if (configExts.has(suffix)) {
    return ['Target', 'Replacement', 'Content', 'OldString', 'NewString'].some((key) => {
      if (typeof args[key] !== 'string' || !args[key]) return false;
      const lines = args[key].split(/\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/);
      return lines.length - (lines.at(-1) === '' ? 1 : 0) > 15;
    });
  }
  return sourceExts.has(suffix) || ['dockerfile', 'makefile', 'cmakelists.txt', 'justfile', 'procfile'].includes(basename(normalized));
}

function contextTokens(path) {
  if (!text(path)) return 0;
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65_536));
    const length = readSync(fd, tail, 0, tail.length, size - tail.length);
    for (const line of tail.toString('utf8', 0, length).split(/\r?\n/).reverse()) {
      if (!line.includes('PLANNER_RESPONSE')) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.type === 'PLANNER_RESPONSE') {
        return ['input_tokens', 'output_tokens', 'cache_read_tokens']
          .reduce((sum, key) => sum + (Math.trunc(Number(value[key])) || 0), 0);
      }
    }
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return 0;
}

async function handle(payload) {
  const { conversationId, workspacePaths, modelName, hookEventName, toolCall } = payload;
  const family = modelName === 'gemini-pro-orchestrator' ? 'carbon'
    : /(?:^|[^a-z0-9])(hydrogen|neon|carbon)(?:$|[^a-z0-9])/i.exec(String(modelName))?.[1]?.toLowerCase();
  await updateHostContext(conversationId, workspacePaths, { geminiFamily: family, configPath });
  const routing = readRoutingPolicy();
  const detectedSwarm = payloadSwarmSignal(payload) || hostSubagentSignal(conversationId);
  let isWorker = workerSignal(payload);
  let storedSwarm = false;
  if (text(conversationId)) {
    const existing = readJsonSafe(stateFilePath(conversationId));
    storedSwarm = Boolean(existing?.is_swarm);
    if ((detectedSwarm && !storedSwarm) || (isWorker && !existing?.is_worker)) {
      await updateState(conversationId, (state) => {
        state.is_swarm ||= detectedSwarm;
        state.is_worker ||= isWorker;
        state.updated_at = now();
      });
    }
    isWorker ||= Boolean(existing?.is_worker);
  }
  const isSwarm = envSwarmSignal() || detectedSwarm || storedSwarm || isWorker;
  const ordinary = isSwarm && routing.swarm_split !== 'inherit' ? routing.swarm_split : routing.work_split;
  const pct = WORKLOAD.profiles[ordinary]?.gpt_share ?? WORKLOAD.profiles.balanced.gpt_share;
  const userInput = String(payload.lastUserInput || '');
  const bypass = override.test(userInput);
  const nativeSwarm = routing.native_swarm && routing.work_split !== 'gemini' && !isWorker
    && !bypass && !swarmOverride.test(userInput) && healthy();
  const workerCommand = 'gempt run --cwd "$PWD" --workspace inherit --host '
    + (text(conversationId) || '<conversationId>') + ' --title <name> --goal -';
  const swarmDispatch = `Use swarm(action="title") and spawn an AGY native Swarm worker with `
    + `swarm(action="add", model="${routing.swarm_shell_model}", workspace="share" for edits or "inherit" for inspection). `
    + 'Record each worker task in plan.json per swarm_pane. In the worker brief, give the command '
    + `\`${workerCommand}\` (add --access inspect for read-only work), then execute its wait_command.`;
  const key = userInput.trim() ? createHash('sha1').update(userInput.trim()).digest('hex').slice(0, 16) : '';
  if (Object.hasOwn(payload, 'toolCall') || hookEventName === 'PreToolUse') {
    const allow = { decision: 'allow' };
    const { name, args = {} } = toolCall || {};
    const input = args || {};
    if (name === 'invoke_subagent' && input.TypeName === 'gempt-worker') {
      await updateState(conversationId, (state) => setCount(state, key, 0));
      if (text(conversationId) && typeof input.Prompt === 'string' && !/^GemPT metadata: /m.test(input.Prompt)) {
        const meta = { host_conversation_id: conversationId, title: explicitTitle(input.Role) };
        allow.overwrite = { Prompt: `${input.Prompt}\nGemPT metadata: ${JSON.stringify(meta)}` };
      }
      return allow;
    }
    if (name === 'call_mcp_tool') {
      if (input.ServerName !== 'gempt_gempt') return allow;
      const dispatchesSwarm = input.ToolName === 'gpt_swarm'
        && ['add', 'title', 'plan'].includes(String(input.Arguments?.action || '').trim());
      if (nativeSwarm && (input.ToolName === 'gpt_run' || dispatchesSwarm)) {
        return { decision: 'deny', reason: swarmDispatch };
      }
      if (['gpt_run', 'gpt_ask', 'gpt_swarm', 'gpt_board'].includes(input.ToolName)) {
        await updateState(conversationId, (state) => setCount(state, key, 0));
        const parentId = text(input.Arguments?.host_conversation_id);
        if (parentId && parentId !== conversationId) {
          await updateHostContext(conversationId, workspacePaths, { parentId, geminiFamily: family, configPath });
        }
      }
      return allow;
    }
    if (['gemini', 'gemini_first'].includes(ordinary) || bypass || !healthy()) return allow;
    if (isWorker && name === 'run_command' && /\bgempt\s+run\b/i.test(String(input.CommandLine || ''))) return allow;
    const target = ['Path', 'TargetFile', 'AbsolutePath', 'SearchPath', 'DirectoryPath'].map((key) => text(input[key])).find(Boolean) || '';
    const cwd = text(payload.cwd) || text(workspacePaths?.[0]) || (extname(target) ? dirname(target) : target) || '.';
    if (['edit_file', 'write_file'].includes(name)) {
      if (!sourceWrite(target, input)) return allow;
      return { decision: 'deny', reason: `[GemPT ${pct}% Write Gate] Source edit (${basename(target)}) routed to GemPT execution. `
        + (nativeSwarm ? swarmDispatch : `Use call_mcp_tool(ServerName="gempt_gempt", ToolName="gpt_swarm", Arguments={"action": "add", "name": "worker", "brief": "Edit ${target}: <change & verify>", "cwd": "${cwd}", "access": "change"}) (or single-task gpt_run) `
        + 'then run the returned `gempt-wait` command via run_command(WaitMsBeforeAsync=500). (User can say "自己改" to bypass.)') };
    }
    if (ordinary === 'balanced') return allow;
    const command = String(input.CommandLine || '').trim();
    if (!(readTools.has(name) && !exemptPath(target)) &&
        !(name === 'run_command' && !waitCommand.test(command) && readCommand.test(command))) return allow;
    const limit = ordinary === 'gpt' ? 5 : 2;
    const count = await updateState(conversationId, (state) => setCount(state, key,
      1 + (key && state.turn_key && key !== state.turn_key ? 0 : Number(state.explore_count) || 0)));
    if (count <= limit) return allow;
    const extra = ordinary === 'gpt_first' ? ' For coding-only workspaces, prefer Codex CLI directly.' : '';
    return { decision: 'deny', reason: `[GemPT ${pct}% Explore Stop-Loss] ${count} non-exempt workspace reads/searches this turn (limit ${limit}). `
      + (nativeSwarm ? swarmDispatch : `Dispatch deep inspection via gpt_swarm(action="add", access="inspect") or gpt_run(cwd="${cwd}", access="inspect") `
      + `then run the returned \`gempt-wait\` command via run_command(WaitMsBeforeAsync=500).${extra} (Say "自己查" to bypass.)`) };
  }
  const routingKey = JSON.stringify([ordinary, pct, isSwarm, nativeSwarm, nativeSwarm && routing.swarm_shell_model]);
  const rememberRouting = (state) => {
    if (state.routing_key === routingKey) return false;
    state.routing_key = routingKey;
    state.updated_at = now();
    return true;
  };
  if (hookEventName === 'SessionStart') {
    if (pct <= 0 && !nativeSwarm) return {};
    if (!await updateState(conversationId, rememberRouting)) return {};
    return { injectSteps: [step(`GemPT v${GEMPT_VERSION} active: ${ordinary} (${pct}% GPT${family ? `, family=${family}` : ''}${isSwarm ? ', swarm' : ''}).\n`
      + (nativeSwarm ? `Delegate via native Swarm (model=${routing.swarm_shell_model}).`
        : 'Use gpt_swarm and gpt_board for workers, gpt_run for single tasks, and the returned gempt-wait command.'))] };
  }
  const tokens = Math.floor(contextTokens(payload.transcriptPath) / 1000);
  const steps = await updateState(conversationId, (state) => {
    const result = [];
    const shown = new Set((Array.isArray(state.milestones_shown) ? state.milestones_shown : []).filter(Number.isFinite));
    const highest = milestones.findLast((value) => tokens >= value && !shown.has(value));
    if (highest) {
      milestones.filter((value) => value <= highest).forEach((value) => shown.add(value));
      state.milestones_shown = [...shown].sort((left, right) => left - right);
      state.updated_at = now();
      result.push({ systemMessage: { systemMessage: '', metadata: {
        user_markdown: `⚠️ 当前会话上下文已达 **${tokens}k tokens**（越过 ${highest}k 里程碑），继续多轮对话将成倍重放 Gemini 缓存。建议输入 \`/compact\` 压缩上下文，或开新对话继续。`,
      } } });
    }
    const entry = `${payload.initialNumSteps ?? ''}:${key}`;
    if ([0, 1].includes(payload.invocationNum) &&
        !(conversationId && state.last_entry_key === entry && (entry !== ':' || now() - state.last_entry_at < 15))) {
      setCount(state, key, 0);
      state.last_entry_key = entry;
      state.last_entry_at = now();
    }
    if (state.routing_key !== routingKey && !bypass) {
      if (nativeSwarm) {
        rememberRouting(state);
        result.push(step(`[GemPT ${pct}%] Swarm Coordinator: dispatch coding and execution work via native Swarm. ${swarmDispatch} `
          + 'Keep quick gpt_ask (including tier="chore") and gpt_ctl direct.'));
      } else if (ordinary === 'gemini' && state.routing_key) {
        rememberRouting(state);
        result.push(step('[GemPT 0%] Handle this work in Gemini.'));
      } else if (Object.hasOwn(banners, ordinary) && healthy()) {
        rememberRouting(state);
        result.push(step(`[GemPT ${pct}%] ${banners[ordinary]}`));
      }
    }
    return result;
  });
  return steps.length ? { injectSteps: steps } : {};
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
console.log(JSON.stringify(await handle(JSON.parse(Buffer.concat(chunks).toString('utf8')))));

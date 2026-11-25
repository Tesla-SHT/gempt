import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const runtime = existsSync(new URL('./runtime/core/host-context.mjs', import.meta.url)) ? './runtime/' : '../';
const [{ WORKLOAD }, { readHostContext, updateHostContext }, { atomicJson, resolvePath, withLock }, backend, { GEMPT_VERSION }, { resolveRunnerId }] = await Promise.all([
  import(`${runtime}core/assets.mjs`), import(`${runtime}core/host-context.mjs`),
  import(`${runtime}core/state.mjs`), import(`${runtime}magpie_plugin/lib/backend.mjs`), import(`${runtime}core/config.mjs`), import(`${runtime}core/runners/registry.mjs`),
]);
const { readJsonSafe, resolveConfigPath, resolveSessionsDir } = backend;
const configPath = resolveConfigPath();
const readTools = new Set('read_file view_file view_file_outline view_code_item grep_search'.split(' '));
const assetExts = new Set('png jpg jpeg webp gif bmp ico svg mp4 mov webm wav mp3 pdf'.split(' '));
const docExts = new Set('md mdx txt rst adoc'.split(' '));
const configExts = new Set('json toml yaml yml ini cfg conf env'.split(' '));
const sourceExts = new Set('py pyi js mjs cjs ts tsx jsx go rs java kt scala c cc cpp cxx h hpp cs rb php sh bash zsh ps1 psm1 bat cmd css scss less html htm vue svelte sql lua gd swift m mm r jl dart ex exs zig'.split(' '));
const exemptParts = [
  '/.gemini/antigravity/mcp/', '/.gemini/antigravity/brain/', '/.gemini/config/plugins/',
  '/.zcode/skills/', '/agent-skills/', '/.config/gempt/',
];
const override = /自己改|自己查|自己做|不用\s*gpt|别用\s*gpt|别派\s*gpt|不要\s*gpt|别转\s*gpt|gemini\s*(?:自己|直接)?(?:做|改|查|处理)|\b(?:no\s+gpt|skip\s+gempt|bypass\s+gempt|don'?t\s+use\s+gpt)\b/i;
const readCommand = /^(?:(?:sudo|command|time)\s+)?(?:Get-Content|Select-String|Get-ChildItem|gc|sls|gci|cat|head|tail|rg|ripgrep|grep|findstr|find|ls|dir|tree|sed|awk|wc|git(?:\.exe)?\s+(?:diff|show|log|grep|status|branch|rev-parse|tag)|type)(?:\.exe)?(?=\s|$)/i;

function metadataSegment(segment) {
  // Nested shell evaluation and redirection can read content inside a listing.
  if (/[&`$(){}<>]/.test(segment)) return false;
  if (/^(?:ls|dir|Get-ChildItem|gci|tree)(?:\.exe)?(?:\s|$)/i.test(segment)) return true;
  if (/^rg(?:\.exe)?\s+(?:(?:--hidden|--no-ignore|-uu?)\s+)*--files(?:\s|$)/i.test(segment)) return true;
  const [, verb, rest = ''] = /^git(?:\.exe)?\s+(status|branch|log|rev-parse|tag)(?:\s+(.*))?$/i.exec(segment) || [];
  if (!verb) return false;
  if (verb.toLowerCase() === 'rev-parse') return true;
  if (verb.toLowerCase() === 'status') return !/(?:^|\s)(?:-\w*v\w*|--verbose)(?:\s|$)/.test(rest);
  const args = rest.split(/\s+/).filter(Boolean);
  if (verb.toLowerCase() === 'log') {
    // Options such as -p, -L and --stat turn a history probe into a diff.
    return args.every(arg => /^(?:[^-]\S*|-\d+|-n\d*|--(?:oneline|graph|all|decorate|no-decorate|first-parent|merges|no-merges|reverse|date-order|topo-order)|--(?:max-count|format|pretty|date|since|until|author)=\S+|--)$/.test(arg));
  }
  // Bare branch/tag names create refs. Only exempt listing forms.
  return args.every(arg => /^(?:-a|-r|-v{1,2}|-l|--(?:list|all|remotes|show-current)|--(?:sort|format)=\S+)$/.test(arg)
    || (args.includes('--list') || args.includes('-l')) && !arg.startsWith('-'));
}

function exploreCommand(command) {
  const segments = command.split(/[;&|\r\n]+/).map(part => part.trim()).filter(Boolean);
  return segments.some(segment => readCommand.test(segment)) && !segments.every(metadataSegment);
}

const reviewRoute = 'For review or analysis of 1–5 known files, use synchronous gpt_ask(file_paths) (fast, cached).';
const milestones = [120, 200, 280];
const banners = {
  gemini_first: 'Handle routine edits/reads in Gemini; route heavy debugging, long test loops, expert review, or multi-worker tasks to gpt_swarm / gpt_run / gpt_ask.',
  balanced: 'Coordinate conversation & design in Gemini; delegate engineering, source edits, and multi-worker tasks via shell-free gpt_swarm(action="add") / gpt_board or gpt_run.',
  gpt: "Route repo investigation & code changes to shell-free gpt_swarm(action='add') / gpt_board (or single-task gpt_run) / gpt_ask(file_paths); keep quick Gemini checks <=5 steps.",
  gpt_first: `${reviewRoute} For repo exploration or edits, use a single-track gpt_swarm / gpt_run. Track via gpt_board.`,
};
const now = () => Date.now() / 1000;
const text = (value) => typeof value === 'string' ? value.trim() : '';
const step = (systemMessage) => ({ systemMessage: { systemMessage } });


function workSplit() {
  const profile = readJsonSafe(configPath)?.routing_policy?.work_split;
  return Object.hasOwn(WORKLOAD.profiles, profile) ? profile : 'balanced';
}

function truthyEnv(value) {
  const raw = text(value).toLowerCase();
  return Boolean(raw) && !['0', 'false', 'no', 'off', 'solo', 'none'].includes(raw);
}

function envSwarmSignal(env = process.env) {
  return truthyEnv(env.GEMPT_SWARM_MODE) || truthyEnv(env.GEMPT_IS_SWARM) || truthyEnv(env.GEMPT_SWARM_ROLE);
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

function healthy(family) {
  const cfg = readJsonSafe(configPath);
  const policy = cfg?.routing_policy;
  const pairing = policy?.pairings?.[family];
  const tier = cfg?.tiers?.[policy?.default_tier || 'sonnet'];
  const model = pairing && pairing !== 'default' ? pairing : tier?.exec_model || tier?.consult_model;
  const runner = resolveRunnerId({ cfg: cfg || {}, model });
  if (!runner.ok && !['auto', 'codex'].includes(cfg?.execution?.default_cli || 'auto')) return false;
  if (!runner.ok || runner.cli === 'codex') {
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
  const ordinary = workSplit();
  let isWorker = workerSignal(payload);
  let existing;
  if (text(conversationId)) {
    existing = readJsonSafe(stateFilePath(conversationId));
    if (isWorker && !existing?.is_worker) {
      await updateState(conversationId, (state) => { state.is_worker = true; });
    }
    isWorker ||= Boolean(existing?.is_worker);
  }
  const pct = WORKLOAD.profiles[ordinary]?.gpt_share ?? WORKLOAD.profiles.balanced.gpt_share;
  const userInput = String(payload.lastUserInput || '');
  const bypass = override.test(userInput);
  const key = userInput.trim() ? createHash('sha1').update(userInput.trim()).digest('hex').slice(0, 16) : '';
  if (bypass && key && conversationId && ordinary !== 'gemini') {
    const entry = payload.initialNumSteps != null ? `${payload.initialNumSteps}:${key}`
      : existing?.last_entry_key?.endsWith(`:${key}`) ? existing.last_entry_key : `:${key}`;
    if (!existing?.bypass_turns?.[entry]) {
      await updateState(conversationId, (state) => {
        const at = now();
        const turns = state.bypass_turns ||= {};
        if (turns[entry]) return;
        for (const [prior, time] of Object.entries(turns)) {
          if (time < at - 7 * 86400) delete turns[prior];
        }
        turns[entry] = at;
        state.bypass_count = (Number(state.bypass_count) || 0) + 1;
        state.updated_at = at;
      });
    }
  }
  if (Object.hasOwn(payload, 'toolCall') || hookEventName === 'PreToolUse') {
    const allow = { decision: 'allow' };
    const { name, args = {} } = toolCall || {};
    const input = args || {};
    if (name === 'call_mcp_tool') {
      if (input.ServerName !== 'gempt_gempt') return allow;
      if (['gpt_run', 'gpt_ask', 'gpt_swarm', 'gpt_board'].includes(input.ToolName)) {
        await updateState(conversationId, (state) => setCount(state, key, 0));
        const parentId = text(input.Arguments?.host_conversation_id);
        if (parentId && parentId !== conversationId) {
          await updateHostContext(conversationId, workspacePaths, { parentId, geminiFamily: family, configPath });
        }
      }
      return allow;
    }
    if (['gemini', 'gemini_first'].includes(ordinary) || bypass) return allow;
    if (isWorker && name === 'run_command' && /\bgempt\s+run\b/i.test(String(input.CommandLine || ''))) return allow;
    const target = ['Path', 'TargetFile', 'AbsolutePath', 'SearchPath', 'DirectoryPath'].map((key) => text(input[key])).find(Boolean) || '';
    const cwd = text(payload.cwd) || text(workspacePaths?.[0]) || (extname(target) ? dirname(target) : target) || '.';
    if (['edit_file', 'write_file'].includes(name)) {
      if (!sourceWrite(target, input) || !healthy(family)) return allow;
      return { decision: 'deny', reason: `[GemPT ${pct}% Write Gate] Source edit (${basename(target)}) routed to GemPT execution. `
        + `Use call_mcp_tool(ServerName="gempt_gempt", ToolName="gpt_swarm", Arguments={"action": "add", "name": "worker", "brief": "Edit ${target}: <change & verify>", "cwd": "${cwd}", "access": "change"}) (or single-task gpt_run) `
        + 'then run the returned `gempt-wait` command via run_command(WaitMsBeforeAsync=500). (User can say "自己改" to bypass.)' };
    }
    if (ordinary === 'balanced') return allow;
    const command = String(input.CommandLine || '').trim();
    if (!(readTools.has(name) && !exemptPath(target)) &&
        !(name === 'run_command' && exploreCommand(command))) return allow;
    if (!healthy(family)) return allow;
    const limit = ordinary === 'gpt' ? 5 : 2;
    const count = await updateState(conversationId, (state) => setCount(state, key,
      1 + (key && state.turn_key && key !== state.turn_key ? 0 : Number(state.explore_count) || 0)));
    if (count <= limit) return allow;
    const review = ordinary === 'gpt_first' ? reviewRoute + ' ' : '';
    return { decision: 'deny', reason: `[GemPT ${pct}% Explore Stop-Loss] ${count} workspace content reads/searches this turn (limit ${limit}). ${review}`
      + `For repo exploration or edits use a single-track gpt_swarm or gpt_run(cwd="${cwd}"). `
      + 'Use access="inspect" for exploration, then run the returned gempt-wait command. (Say "自己查" to bypass.)' };
  }
  const routingKey = ordinary;
  const rememberRouting = (state) => {
    if (state.routing_key === routingKey) return false;
    state.routing_key = routingKey;
    state.updated_at = now();
    return true;
  };
  if (hookEventName === 'SessionStart') {
    if (pct <= 0) return {};
    if (!await updateState(conversationId, rememberRouting)) return {};
    return { injectSteps: [step(`GemPT v${GEMPT_VERSION} active: ${ordinary} (${pct}% GPT${family ? `, family=${family}` : ''}).\n`
      + (ordinary === 'gpt_first' ? banners.gpt_first : 'Use gpt_swarm and gpt_board for workers, gpt_run for single tasks, and the returned gempt-wait command.'))] };
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
      if (ordinary === 'gemini' && state.routing_key) {
        rememberRouting(state);
        result.push(step('[GemPT 0%] Handle this work in Gemini.'));
      } else if (Object.hasOwn(banners, ordinary) && healthy(family)) {
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

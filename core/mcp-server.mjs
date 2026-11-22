import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonSafe, resolveConfigPath, resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { resolveBudget } from '../magpie_plugin/lib/token-ratio.mjs';
import { createExecutionTools } from '../magpie_plugin/lib/tools.mjs';
import { readHostContext } from './host-context.mjs';
import { APP_RESOURCE, APP_TOOLS, APP_URI, callAppTool, readAppResource } from './mcp-app.mjs';
import { ACTIVE_STATES, buildWaitCommand, compactReceiptText, dispatchRun, interruptRun, readRun, replyToolCall, runWithinRoot, steerRun } from './runs.mjs';
import { resolvePath, validateSessionId, withLock } from './state.mjs';
import { TOOLS } from './tool-schemas.mjs';
export { TOOLS };

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (value, limit) => Array.from(String(value || '')).slice(0, limit).join('');
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const textResult = (data, extras) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], ...extras });
const VERSION = readJsonSafe(new URL('../package.json', import.meta.url))?.version || '0.1.0';

function compact(payload) {
  const data = { ...payload };
  for (const key of ['recent', 'active']) {
    if (!Array.isArray(data[key])) continue;
    data[key] = [...data[key]];
    while (data[key].length && bytes(data) > 500) data[key].pop();
  }
  for (const key of ['err', 'msg']) {
    if (bytes(data) <= 500 || typeof data[key] !== 'string') continue;
    const chars = Array.from(data[key]).slice(0, 80);
    do { data[key] = chars.join(''); } while (bytes(data) > 500 && chars.pop() !== undefined);
  }
  if (bytes(data) <= 500) return data;
  if (typeof payload.id === 'string') return { id: payload.id, st: payload.st, sid: short(payload.sid, 64) };
  return { ok: true, active_n: payload.active?.length ?? 0 };
}

function compactStatus(live, record, options) {
  if (record) {
    const item = { id: record.run_id, st: record.state, sid: record.session_id, title: short(record.title, 32) };
    if (ACTIVE_STATES.has(record.state)) item.wait = buildWaitCommand(record.run_id, options);
    if (record.pending_tool_call) {
      const pending = record.pending_tool_call;
      item.ask = { call_id: pending.call_id, q: short(pending.arguments?.question, 100) };
      while (bytes(item) > 500 && item.ask.q) item.ask.q = short(item.ask.q, Array.from(item.ask.q).length - 1);
    } else if (record.error) item.err = short(record.error, 140);
    else if (record.result?.text) item.msg = short(record.result.text, 140);
    return compact(item);
  }
  const policy = readJsonSafe(options.configPath)?.routing_policy || {};
  const profile = String(policy.work_split || 'balanced');
  const budget = resolveBudget(profile, { policy, configPath: options.configPath, env: options.env });
  const summary = (run, limit) => ({ id: run.run_id, st: run.state, t: short(run.title, limit) });
  return compact({ split: profile, target: budget.target_gpt_share, gpt: budget.actual_gpt_share,
    active: live.runs.filter((run) => ACTIVE_STATES.has(run.state)).slice(0, 4).map((run) => summary(run, 24)),
    recent: live.runs.filter((run) => !ACTIVE_STATES.has(run.state)).slice(0, 3).map((run) => summary(run, 20)) });
}

async function control(args, options) {
  if (Object.hasOwn(args, 'wait_sec')) {
    throw new Error('gpt_ctl does not support wait_sec polling; use `gempt-wait <run_id>` via background run_command.');
  }
  const action = String(args.action || 'status').trim();
  if (!['status', 'steer', 'interrupt', 'reply'].includes(action)) throw new Error(`Invalid action: ${action}`);
  const runId = typeof args.run_id === 'string' && args.run_id ? args.run_id : null;
  if (!runId && action !== 'status') throw new Error(`run_id is required for action='${action}'.`);
  const record = runId && readRun(runId, options.sessionsDir);
  if (record && !runWithinRoot(record, options.root)) throw new Error('Run outside host workspace');
  if (action === 'steer') return textResult(compact(await steerRun(runId, String(args.message || ''), options)));
  if (action === 'interrupt') return textResult(compact(await interruptRun(runId, options)));
  if (action === 'reply') return textResult(compact(replyToolCall(runId, String(args.call_id || ''), String(args.message || ''), options)));
  const liveArgs = {
    ...(runId ? { run_id: runId } : {}),
    ...(['session', 'all'].includes(args.scope) ? { scope: args.scope } : {}),
  };
  const { structuredContent } = await callAppTool('gempt_live_view', liveArgs, options);
  return textResult(compactStatus(structuredContent, record, options), { structuredContent });
}

export async function handleTool(name, args, env = process.env, overrides = {}, callCtx) {
  const options = {
    configPath: resolveConfigPath(env.GEMPT_CONFIG), sessionsDir: resolveSessionsDir(env.GEMPT_SESSIONS_DIR),
    root: env.GEMPT_WORKSPACE_ROOT?.trim() ? resolvePath(env.GEMPT_WORKSPACE_ROOT.trim()) : null, env,
    magpieConfigDir: env.MAGPIE_CONFIG_DIR, ...overrides,
  };
  if (Object.hasOwn(APP_TOOLS, name)) return callAppTool(name, args, options);
  if (name === 'gpt_ctl') return control(args, options);
  if (!['gpt_run', 'gpt_ask'].includes(name)) throw new Error(`Unknown tool: ${name}`);
  const goal = String(args.goal || '').trim();
  if (!goal) throw new Error('`goal` is required.');
  const cwd = options.root && (args.cwd == null || typeof args.cwd === 'string')
    ? resolve(options.root, args.cwd || '.') : args.cwd;
  const context = readHostContext(options.configPath);
  const hostId = args.host_conversation_id || context.conversation_id;
  const family = args.gemini_family || context.gemini_family;
  const sessionId = String(args.session_id || '').trim();
  if (name === 'gpt_ask') {
    const consult = createExecutionTools(options).consult;
    if (!cwd && args.file_paths != null) throw new Error('cwd is required when providing file_paths.');
    const execute = () => consult.execute({ goal, tier: args.tier, cwd, file_paths: args.file_paths,
      session_id: sessionId, gemini_family: family, host_conversation_id: hostId }, callCtx);
    const res = sessionId ? await withLock(join(options.sessionsDir, `${validateSessionId(sessionId)}.node.lock`), execute) : await execute();
    return textResult({ session_id: res.session_id, model: res.served_model, tier: res.tier,
      text: compactReceiptText(res.text, res.session_id) });
  }
  const access = String(args.access || 'change').trim();
  if (!['inspect', 'change'].includes(access)) throw new Error(`Invalid access: ${access}`);
  const syncBudget = Number(env.GEMPT_GPT_RUN_SYNC_SEC);
  const waitSec = Number.isFinite(syncBudget) && syncBudget > 0 ? Math.min(syncBudget, 10) : 0;
  const res = await dispatchRun({ goal, cwd, workspace: args.workspace, title: args.title, tier: args.tier,
    host_conversation_id: hostId, gemini_family: family, session_id: sessionId,
    background: args.background ?? waitSec === 0, sandbox: access === 'inspect' ? 'read-only' : undefined,
    expected_report: 'Report concisely: changed files, verification commands/results, and any remaining blockers. Omit verbose raw logs.',
  }, { ...options, waitSec, agent: typeof callCtx?.agent === 'string' ? callCtx.agent : undefined });
  if (ACTIVE_STATES.has(res.state) || res.state === 'interrupted') {
    const wait = buildWaitCommand(res.run_id, options);
    return textResult({ run_id: res.run_id, session_id: res.session_id, state: res.state, wait_command: wait,
      text: res.state === 'waiting_gemini'
        ? `Run ${res.run_id} is waiting for ask_gemini reply (use gpt_ctl action='reply').`
        : `Run ${res.run_id} started. Execute \`${wait}\` via run_command(WaitMsBeforeAsync=500) for zero-poll wakeup.`,
      ...(res.worktree_path ? { worktree_path: res.worktree_path } : {}),
    }, { isError: res.state === 'interrupted' });
  }
  const { run_id, session_id, model, worktree_path, verification, usage, text } = res;
  return textResult({ run_id, session_id, model, worktree_path, verification, usage,
    text: compactReceiptText(text, session_id) }, { isError: ['failed', 'unverified'].includes(verification?.status) });
}

const errorResponse = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

async function dispatch(request, env) {
  const { id, method, params = {} } = request;
  if (id == null || String(method).startsWith('notifications/')) return;
  const response = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return response({ protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: 'gempt', version: VERSION } });
      case 'ping': return response({});
      case 'tools/list': return response({ tools: TOOLS });
      case 'resources/list': return response({ resources: [APP_RESOURCE] });
      case 'resources/read':
        if (params?.uri !== APP_URI) return errorResponse(id, -32002, 'Resource not found', { uri: params?.uri });
        return response(readAppResource({ env }));
      case 'tools/call': {
        const name = String(params?.name || '');
        const args = params?.arguments ?? {};
        if (!object(args)) throw new Error('Tool arguments must be a JSON object.');
        try {
          return response(await handleTool(name, args, env));
        } catch (error) {
          return response({ content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true });
        }
      }
      default: return errorResponse(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return errorResponse(id, -32603, error.message);
  }
}

export async function serveStdio(input = process.stdin, output = process.stdout, env = process.env) {
  const pending = new Set();
  const write = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch (error) {
      write(errorResponse(null, -32700, `Parse error: ${error.message}`));
      continue;
    }
    if (!object(request)) continue;
    const task = dispatch(request, env).then(write);
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await serveStdio();

/**
 * Zero-dependency native Magpie tool definitions for GemPT.
 *
 * Exposes `run`, `ask`, and `ctl` (registered by Magpie as
 * `gempt_run`, `gempt_ask`, `gempt_ctl` at
 * `http://127.0.0.1:3425/mcp/magpie/tools/gempt`).
 *
 * Safety defaults follow `@magpie-community/tools-layerfs`:
 * - Writable `gempt_run` requires plugin option `exec: true` (or env override).
 * - Gateway HTTP requests talk directly via node:http/https (bypassing proxies) and refuse 3xx redirects.
 * - Workspace paths reject sensitive roots (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/{magpie,gempt}, ~, /)
 *   and file attachments enforce realpath containment + secret-file filtering.
 */
import { readNativeRun, startNativeRun, waitForNativeRun } from './native-runs.mjs';
import { findCodexCli } from './app-server-manager.mjs';
import { runAppServer, TurnInterrupted } from './app-server-run.mjs';
import { validateSessionId } from '../../core/state.mjs';
import { TOOLS } from '../../core/tool-schemas.mjs';
import { resolveBudget } from './token-ratio.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readSync, realpathSync, statSync, closeSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import {
  DEFAULT_MAGPIE_URL,
  DEFAULT_TIERS,
  DEFAULT_UTILITY,
  WORKLOAD,
  EFFORT_RANK,
  TIER_ORDER,
  VALID_EFFORTS,
  VALID_SANDBOXES,
  defaultGatewayFromEnv,
  expandUser,
  explicitTitle,
  isCodexModelId,
  isHarnessGroup,
  normalizeDefaultTier,
  normalizeTitle,
  pickSubscriptionPlan,
  probeMagpie,
  readJsonSafe,
  readState,
  resolveConfigPath,
  resolveExcludedTokens,
  resolveMagpieApiKey,
  resolveMagpieConfigDir,
  resolveSessionsDir,
  sessionGoal,
  verifySubscriptionGroup,
  writeConfigAtomic,
} from './backend.mjs';
import {
  buildEscalationSuggestion,
  classifyTaskEffort,
  effortTimeoutFloor,
} from './routing.mjs';

const CONSULT_TIERS = ['chore', ...TIER_ORDER];
const VALID_EFFORTS_SET = new Set(VALID_EFFORTS);
const VALID_API_MODES = new Set(['responses', 'chat']);
const SANDBOX_RANK = Object.freeze({ 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 });
const MAX_CONTEXT_FILE_BYTES = 131072;
const MAX_TOTAL_CONTEXT_BYTES = 393216;
const EXEC_STRIP_ENV = [
  'CODEX_WINDOWS_REGISTERED_CORE',
  'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_TOOL_CALL_ID',
];

const CONSULT_SYSTEM_PROMPT = [
  'You are a specialist GPT reasoning collaborator working behind Gemini (the human-facing orchestrator).',
  'Produce dense, precise, verifiable technical analysis rather than conversational filler.',
  'Cite exact file paths, line numbers, invariants, failure modes, and concrete verification steps.',
  'If provided evidence is insufficient to prove a claim, state the exact missing evidence explicitly.',
].join('\n');

const EXEC_SYSTEM_HEADER = [
  'You are executing a task delegated by Gemini (the human-facing orchestrator).',
  'Follow the scope and hard constraints strictly, verify your changes by running the requested checks,',
  'and conclude with a concise engineering report: changed files, exact commands run and results, and remaining risks.',
].join('\n');

export function isExecEnabled(options = {}, env = process.env) {
  return options?.exec === true || String(env?.GEMPT_MAGPIE_TOOLS_EXEC || '') === '1';
}

function callingAgent(callCtx) {
  const raw = callCtx?.agent;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 40) : '';
}

function realOrResolve(target) {
  const expanded = resolve(expandUser(String(target || '')));
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

function foldCase(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

function isSameOrInside(candidate, root) {
  const rel = relative(foldCase(root), foldCase(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export function normalizeWorkspaceCwd(rawCwd, { configPath, magpieConfigDir, env = process.env } = {}) {
  if (typeof rawCwd !== 'string' || !rawCwd.trim()) {
    throw new Error('cwd is required and must be a non-empty directory path.');
  }
  const resolved = realOrResolve(rawCwd.trim());
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved}`);
  }

  const fsRoot = realOrResolve(parse(resolved).root);
  const homeRoot = realOrResolve(homedir());
  if (foldCase(resolved) === foldCase(fsRoot) || foldCase(resolved) === foldCase(homeRoot)) {
    throw new Error(`Refused blocked workspace root: ${resolved}`);
  }

  const sensitiveRoots = [
    realOrResolve(resolveMagpieConfigDir(magpieConfigDir)),
    realOrResolve(dirname(resolveConfigPath(configPath))),
    realOrResolve(join(homedir(), '.ssh')),
    realOrResolve(join(homedir(), '.aws')),
    realOrResolve(join(homedir(), '.gnupg')),
  ];
  for (const sensitive of sensitiveRoots) {
    if (isSameOrInside(resolved, sensitive) || isSameOrInside(sensitive, resolved)) {
      throw new Error(`Refused sensitive directory as workspace: ${resolved}`);
    }
  }

  const workspaceRootEnv = String(env?.GEMPT_WORKSPACE_ROOT || '').trim();
  if (workspaceRootEnv) {
    const allowedRoot = realOrResolve(workspaceRootEnv);
    if (!isSameOrInside(resolved, allowedRoot)) {
      throw new Error(`cwd is outside GEMPT_WORKSPACE_ROOT (${allowedRoot}): ${resolved}`);
    }
  }
  return resolved;
}

function isSecretPath(relPath) {
  const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === '.git' || lower === '.ssh' || lower === '.aws' || lower === '.gnupg') return true;
    if (lower === '.env' || lower.startsWith('.env.')) return true;
    if (lower === 'id_rsa' || lower === 'id_ed25519' || lower === 'id_ecdsa') return true;
    if (lower.endsWith('.pem') || lower.endsWith('.key')) return true;
  }
  return false;
}

function readContextFiles(filePaths, cwd, { maxFileBytes = MAX_CONTEXT_FILE_BYTES, maxTotalBytes = MAX_TOTAL_CONTEXT_BYTES } = {}) {
  const list = Array.isArray(filePaths) ? filePaths : [];
  const blocks = [];
  const warnings = [];
  if (!list.length) return { blocks, warnings };
  if (!cwd) {
    throw new Error('cwd is required when file_paths are provided.');
  }

  const base = realOrResolve(cwd);
  let totalUsed = 0;

  for (const rawItem of list) {
    const rawStr = String(rawItem || '').trim();
    if (!rawStr) continue;
    const expanded = expandUser(rawStr);
    const candidate = isAbsolute(expanded) ? expanded : join(base, expanded);
    const resolvedFile = realOrResolve(candidate);

    if (!isSameOrInside(resolvedFile, base)) {
      throw new Error(`Context file is outside workspace: ${rawStr}`);
    }
    const rel = relative(base, resolvedFile);
    if (isSecretPath(rel) || isSecretPath(basename(resolvedFile))) {
      throw new Error(`Refused secret-shaped file path: ${rawStr}`);
    }
    if (!existsSync(resolvedFile)) {
      warnings.push(`Skipped missing file: ${rawStr}`);
      continue;
    }
    let st;
    try {
      st = statSync(resolvedFile);
    } catch (err) {
      warnings.push(`Failed to stat ${resolvedFile}: ${err.message}`);
      continue;
    }
    if (!st.isFile()) {
      warnings.push(`Skipped non-file path: ${rawStr}`);
      continue;
    }

    const remaining = maxTotalBytes - totalUsed;
    if (remaining <= 0) {
      warnings.push(`Total context budget (${maxTotalBytes} bytes) reached; skipped ${resolvedFile}`);
      break;
    }

    const limit = Math.min(maxFileBytes, remaining);
    const buf = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    let fd;
    try {
      fd = openSync(resolvedFile, 'r');
      while (bytesRead < buf.length) {
        const n = readSync(fd, buf, bytesRead, buf.length - bytesRead, bytesRead);
        if (n <= 0) break;
        bytesRead += n;
      }
    } catch (err) {
      warnings.push(`Failed to read ${resolvedFile}: ${err.message}`);
      continue;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    const sampleEnd = Math.min(bytesRead, 4096);
    if (buf.subarray(0, sampleEnd).includes(0)) {
      warnings.push(`Skipped binary file: ${resolvedFile}`);
      continue;
    }

    const truncated = bytesRead > limit;
    const sliceLen = truncated ? limit : bytesRead;
    const sliced = buf.subarray(0, sliceLen);
    totalUsed += sliceLen;
    const text = sliced.toString('utf-8');
    const lines = text.split(/\r?\n/);
    let numbered = lines.map((line, idx) => `${idx + 1}: ${line}`).join('\n');
    if (truncated) {
      numbered += `\n... [truncated at ${limit} bytes of ${st.size} total bytes]`;
    }
    blocks.push({ path: resolvedFile, content: numbered });
  }

  return { blocks, warnings };
}

function buildConsultPrompt({ goal, context = '', fileBlocks = [], constraints = '', expectedOutput = '' }) {
  const sections = [`## Goal\n${String(goal || '').trim()}`];
  if (String(context || '').trim()) sections.push(`## Context\n${String(context).trim()}`);
  if (String(constraints || '').trim()) sections.push(`## Hard Constraints\n${String(constraints).trim()}`);
  if (fileBlocks.length) {
    const rendered = fileBlocks.map((blk) => `### File: ${blk.path}\n\`\`\`text\n${blk.content}\n\`\`\``);
    sections.push(`## Referenced Files\n${rendered.join('\n\n')}`);
  }
  if (String(expectedOutput || '').trim()) {
    sections.push(`## Expected Output\n${String(expectedOutput).trim()}`);
  } else {
    sections.push(
      '## Expected Output\n1. Direct conclusion / recommendation\n2. Key reasoning, edge cases, and failure modes\n3. Concrete verification steps or exact next actions',
    );
  }
  return sections.join('\n\n');
}

function buildExecPrompt({
  goal,
  context = '',
  fileBlocks = [],
  constraints = '',
  verification = '',
  expectedReport = '',
  isResume = false,
}) {
  const sections = [];
  if (!isResume) sections.push(EXEC_SYSTEM_HEADER);
  sections.push(`## Goal\n${String(goal || '').trim()}`);
  if (String(context || '').trim()) sections.push(`## Context\n${String(context).trim()}`);
  if (String(constraints || '').trim()) sections.push(`## Hard Constraints\n${String(constraints).trim()}`);
  if (fileBlocks.length) {
    const rendered = fileBlocks.map((blk) => `### File: ${blk.path}\n\`\`\`text\n${blk.content}\n\`\`\``);
    sections.push(`## Preloaded Files\n${rendered.join('\n\n')}`);
  }
  if (String(verification || '').trim()) sections.push(`## Required Verification\n${String(verification).trim()}`);
  if (String(expectedReport || '').trim()) {
    sections.push(`## Required Report\n${String(expectedReport).trim()}`);
  } else {
    sections.push(
      '## Required Report\nSummarize: (1) modified/created files, (2) exact commands run and observed pass/fail results, (3) any open risks or unverified gaps.',
    );
  }
  return sections.join('\n\n');
}

function postGatewayJson(url, { apiKey = '', payload = {}, timeoutMs = 180000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return Promise.reject(new Error(`Invalid gateway URL '${url}': ${err.message}`));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported URL scheme: ${parsed.protocol}`));
  }
  const client = parsed.protocol === 'https:' ? https : http;
  const bodyStr = JSON.stringify(payload);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return new Promise((resolveReq, rejectReq) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) rejectReq(err);
      else resolveReq(val);
    };

    const req = client.request(parsed, { method: 'POST', headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        finish(Object.assign(new Error(`Magpie HTTP ${res.statusCode} redirect rejected at ${url}`), { statusCode: res.statusCode }));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total <= 8 * 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(Object.assign(new Error(`Magpie HTTP ${res.statusCode} at ${url}: ${raw.slice(0, 800)}`), { statusCode: res.statusCode }));
          return;
        }
        try {
          const data = JSON.parse(raw);
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            finish(new Error(`Unexpected JSON payload from ${url}`));
            return;
          }
          finish(null, data);
        } catch (err) {
          finish(new Error(`Magpie returned non-JSON from ${url}: ${err.message}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Magpie request timed out after ${Math.round(timeoutMs / 1000)}s at ${url}`));
    });
    req.on('error', (err) => finish(err));
    req.write(bodyStr);
    req.end();
  });
}

function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string' && item.text.trim()) chunks.push(item.text.trim());
    for (const block of Array.isArray(item.content) ? item.content : []) {
      if (!block || typeof block !== 'object') continue;
      if ((block.type === 'output_text' || block.type === 'text' || block.type === undefined) && typeof block.text === 'string' && block.text.trim()) {
        chunks.push(block.text.trim());
      }
    }
  }
  return chunks.join('\n\n').trim();
}

function extractChatText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  if (!choices.length || typeof choices[0] !== 'object') return '';
  const content = choices[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();
  }
  return '';
}

async function callResponses({ baseUrl, apiKey, model, messages, reasoningEffort = '', instructions = '', maxOutputTokens = 16384, timeoutMs = 180000 }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/responses`;
  const payload = { model, input: messages, max_output_tokens: maxOutputTokens };
  if (String(instructions || '').trim()) payload.instructions = String(instructions).trim();
  if (reasoningEffort && reasoningEffort !== 'none') payload.reasoning = { effort: reasoningEffort };

  const data = await postGatewayJson(url, { apiKey, payload, timeoutMs });
  if (data.error) {
    throw new Error(`Model error from ${model}: ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error)}`);
  }
  const text = extractResponsesText(data);
  const usage = data.usage || {};
  if (!text) {
    const rTokens = usage?.output_tokens_details?.reasoning_tokens;
    throw new Error(`Empty output from '${model}' on /v1/responses (status=${data.status}, reasoning_tokens=${rTokens ?? '-'}). Try increasing max_output_tokens.`);
  }
  return {
    text,
    servedModel: String(data.model || model),
    usage,
    responseId: data.id || '',
  };
}

async function callChat({ baseUrl, apiKey, model, messages, reasoningEffort = '', instructions = '', maxOutputTokens = 16384, timeoutMs = 180000 }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const fullMessages = String(instructions || '').trim()
    ? [{ role: 'system', content: String(instructions).trim() }, ...messages]
    : [...messages];
  const payload = { model, messages: fullMessages, max_tokens: maxOutputTokens };
  if (reasoningEffort && reasoningEffort !== 'none') payload.reasoning_effort = reasoningEffort;

  const data = await postGatewayJson(url, { apiKey, payload, timeoutMs });
  if (data.error) {
    throw new Error(`Model error from ${model}: ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error)}`);
  }
  const text = extractChatText(data);
  const usage = data.usage || {};
  if (!text) {
    const rTokens = usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(`Empty output from '${model}' on /v1/chat/completions (reasoning_tokens=${rTokens ?? '-'}). Try increasing max_output_tokens.`);
  }
  return {
    text,
    servedModel: String(data.model || model),
    usage,
    responseId: data.id || '',
  };
}

function nowIso() {
  return new Date().toISOString();
}

function generateSessionId(mode) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${mode}-${stamp}-${randomBytes(4).toString('hex')}`;
}

function sessionPath(sessionsDir, sessionId) {
  return join(sessionsDir, `${validateSessionId(sessionId)}.json`);
}

function loadSession(sessionsDir, sessionId) {
  const file = sessionPath(sessionsDir, sessionId);
  if (!existsSync(file)) return null;
  return readJsonSafe(file);
}

function saveSession(sessionsDir, record) {
  const file = sessionPath(sessionsDir, record.session_id);
  const stamped = {
    ...record,
    created_at: record.created_at || nowIso(),
    updated_at: nowIso(),
  };
  const written = writeConfigAtomic(file, stamped);
  if (!written.ok) throw new Error(written.error);
  return file;
}

function formatSummaryHeader({ mode, tier, model, effort, sessionId, elapsedSec, usage, extra = {} }) {
  const parts = [
    `mode=${mode}`,
    `tier=${tier}`,
    `model=${model}`,
    `effort=${effort || 'default'}`,
    `session_id=${sessionId}`,
    `elapsed=${elapsedSec.toFixed(2)}s`,
  ];
  const tokIn = usage?.input_tokens ?? usage?.prompt_tokens;
  const tokOut = usage?.output_tokens ?? usage?.completion_tokens;
  if (tokIn !== undefined || tokOut !== undefined) {
    parts.push(`tokens=in:${tokIn || 0}/out:${tokOut || 0}`);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${v}`);
  }
  return `[${parts.join(' | ')}]`;
}

async function resolveRuntimeConfig({ configPath, tierForProbe, allowUtilityOnly = false, probeTimeoutMs = 2000, env = process.env } = {}) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const rawCfg = readJsonSafe(resolvedConfigPath);
  const baseUrl = String(rawCfg?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const trusted = String(env?.GEMPT_TRUSTED_GATEWAY || DEFAULT_MAGPIE_URL).replace(/\/+$/, '');
  const apiKey = rawCfg
    ? resolveMagpieApiKey(rawCfg, baseUrl)
    : (baseUrl === trusted || isLoopbackUrl(baseUrl) ? resolveMagpieApiKey({ magpie: { base_url: baseUrl } }) : '');

  if (rawCfg) {
    return {
      configured: true,
      configSource: 'config',
      configPath: resolvedConfigPath,
      baseUrl,
      apiKey,
      cfg: rawCfg,
    };
  }

  const excluded = resolveExcludedTokens({});
  const probe = await probeMagpie(baseUrl, apiKey, probeTimeoutMs, excluded);
  if (!probe.reachable) {
    throw new Error(`Cannot reach local Magpie gateway at ${baseUrl}: ${probe.error || 'offline'}`);
  }
  const subPlan = pickSubscriptionPlan(probe);
  const wantUtility = allowUtilityOnly && String(tierForProbe || '').trim().toLowerCase() === 'chore';
  if (!subPlan && (!wantUtility || !(probe.utility_candidates || []).length)) {
    throw new Error('未检测到 Codex 订阅模型，请先在 Magpie 中登录 ChatGPT/Codex 订阅账号。');
  }

  const synthTiers = subPlan ? subPlan.tiers : DEFAULT_TIERS;
  const utilityModel = probe.utility_candidates?.[0] || subPlan?.utility_model || DEFAULT_UTILITY.model;
  return {
    configured: false,
    configSource: 'auto_subscription',
    configPath: resolvedConfigPath,
    baseUrl,
    apiKey,
    cfg: {
      version: 1,
      magpie: { base_url: baseUrl },
      codex: { default_sandbox: 'workspace-write', timeout_sec: 600 },
      routing_policy: { default_tier: 'sonnet', failover_mode: 'subscription_only' },
      tiers: synthTiers,
      utility: { ...DEFAULT_UTILITY, model: utilityModel },
      limits: {
        max_context_file_bytes: MAX_CONTEXT_FILE_BYTES,
        max_total_context_bytes: MAX_TOTAL_CONTEXT_BYTES,
        consult_timeout_sec: 180,
      },
    },
  };
}

function isAllowedFallbackTarget(modelId) {
  const m = String(modelId || '').trim();
  return isCodexModelId(m) || m.startsWith('openai/') || m.startsWith('group/gempt-harness-');
}

function shouldRetryFallback(err) {
  const code = err?.statusCode;
  if (code === 429) return true;
  if (Number.isFinite(code) && code >= 500) return true;
  if (code !== undefined) return false;
  return !/redirect rejected/i.test(String(err?.message || ''));
}

function pairedModel(cfg, args, session) {
  if (args.tier) return '';
  const family = args.gemini_family;
  const saved = session?.paired_model;
  if (!session && !Object.hasOwn(WORKLOAD.pairings, family)) return '';
  const group = cfg.tiers?.[family === 'carbon' ? 'fable' : 'sonnet']?.consult_model;
  const model = session ? saved : cfg.routing_policy?.pairings?.[family] ?? (isHarnessGroup(group) ? group : WORKLOAD.pairings[family]);
  if (!model || model === 'default') return '';
  if (!isCodexModelId(model) && !isHarnessGroup(model)) throw new Error('Gemini pairing requires a Codex subscription model.');
  if (resolveExcludedTokens(cfg).some(token => model.toLowerCase().includes(token))) {
    throw new Error('The paired Codex model is excluded. Change the pairing in GemPT.');
  }
  return model;
}

function resolveTierTarget(cfg, requestedTier, { allowChore = false, escalate = false, effortOverride = '', paired = '' } = {}) {
  const policy = cfg?.routing_policy || {};
  const failoverMode = String(policy.failover_mode || 'subscription_only').trim() || 'subscription_only';
  const raw = String(requestedTier || '').trim().toLowerCase();
  const effectiveTier = raw ? (raw === 'chore' ? 'chore' : normalizeDefaultTier(raw)) : (normalizeDefaultTier(policy.default_tier) || 'sonnet');

  const valid = allowChore ? CONSULT_TIERS : TIER_ORDER;
  if (!effectiveTier || !valid.includes(effectiveTier)) {
    throw new Error(`Invalid tier '${String(requestedTier || '')}'. Expected one of: ${valid.join(', ')}.`);
  }

  if (effectiveTier === 'chore') {
    const util = cfg?.utility || DEFAULT_UTILITY;
    return {
      tier: 'chore',
      failoverMode,
      model: String(util.model || DEFAULT_UTILITY.model),
      effort: effortOverride || String(util.reasoning_effort || 'low'),
      apiMode: String(util.api_mode || 'chat'),
      maxOutputTokens: Number(util.max_output_tokens || 4096),
      fallbackModels: Array.isArray(util.fallback_models) ? util.fallback_models.filter(Boolean).map(String) : [],
      escalated: false,
    };
  }

  const tierCfg = { ...DEFAULT_TIERS[effectiveTier], ...(cfg?.tiers?.[effectiveTier] || {}) };
  let model = String(paired || tierCfg.consult_model || DEFAULT_TIERS[effectiveTier].consult_model).trim();
  let effort = String(effortOverride || tierCfg.reasoning_effort || 'medium').trim();
  const thresh = String(tierCfg.escalate_effort_threshold || DEFAULT_TIERS[effectiveTier].escalate_effort_threshold || 'high').trim();
  const threshRank = EFFORT_RANK[thresh] ?? 4;
  if (escalate && !effortOverride && (EFFORT_RANK[effort] ?? 3) < threshRank) {
    effort = thresh;
  }

  let escalated = false;
  const meetsThreshold = (EFFORT_RANK[effort] ?? 3) >= threshRank;
  if (!paired && (escalate || meetsThreshold) && tierCfg.escalate_model) {
    if (!model.startsWith('group/') && !model.startsWith('auto/')) {
      model = String(tierCfg.escalate_model).trim();
      escalated = true;
    } else if (model.startsWith('group/gempt-harness-')) {
      escalated = true;
    }
  }

  if (failoverMode === 'subscription_only') {
    if (!isCodexModelId(model) && !isHarnessGroup(model)) {
      throw new Error(`Subscription-only mode requires a codex/* model for tier '${effectiveTier}', got '${model}'.`);
    }
  } else if (!isAllowedFallbackTarget(model)) {
    throw new Error(`Unsupported target model '${model}' for tier '${effectiveTier}'.`);
  }

  const seenFallbacks = new Set([model]);
  const fallbackModels = [];
  if (!paired && failoverMode !== 'subscription_only' && Array.isArray(tierCfg.fallback_models)) {
    for (const item of tierCfg.fallback_models) {
      const fb = String(item || '').trim();
      if (!fb || seenFallbacks.has(fb)) continue;
      seenFallbacks.add(fb);
      fallbackModels.push(fb);
    }
  }

  return {
    tier: effectiveTier,
    failoverMode,
    model,
    execModel: (paired || escalated) ? model : (String(tierCfg.exec_model || '').trim() || model),
    effort,
    apiMode: String(tierCfg.api_mode || 'responses'),
    maxOutputTokens: Number(tierCfg.max_output_tokens || 16384),
    fallbackModels,
    escalated,
  };
}

export function createGemptTools({ options = {}, env = process.env, ...host } = {}) {
  return Object.fromEntries(TOOLS.filter(({ name }) => name.startsWith('gpt_')).map((tool) => {
    const { name, description, inputSchema } = tool;
    const key = name.slice(4);
    return [key, {
      description,
      args: inputSchema,
      async execute(args = {}, callCtx) {
        if (key === 'run' && args.access !== 'inspect' && !isExecEnabled(options, env)) {
          throw new Error('Writable gempt_run is disabled. Enable the GemPT plugin option `exec: true`.');
        }
        const overrides = { ...host, configPath: resolveConfigPath(host.configPath || env.GEMPT_CONFIG),
          sessionsDir: resolveSessionsDir(host.sessionsDir || env.GEMPT_SESSIONS_DIR) };
        const { handleTool } = await import('../../core/mcp-server.mjs');
        const result = await handleTool(name, args, env, overrides, callCtx);
        const receipt = JSON.parse(result.content[0].text);
        return result.isError ? { ...receipt, isError: true } : receipt;
      },
    }];
  }));
}

export function createExecutionTools({
  configPath,
  sessionsDir,
  magpieConfigDir,
  antigravityPluginDir,
  codexCliPath,
  options = {},
  execRunFile,
  newExecSession,
  allowSandboxUpgrade,
  worktreePath,
  sourceCwd,
  env = process.env,
  probeTimeoutMs = 2000,
} = {}) {
  const resolvedMagpieDir = resolveMagpieConfigDir(magpieConfigDir);
  const resolvedSessionsDir = resolveSessionsDir(sessionsDir);

  const tools = {
    dispatch: {
      description: "First action for substantive work. Apply the live ordinary or Antigravity Swarm work split and perform the selected GPT consultation or execution. Supply the goal before investigation.",
      args: WORKLOAD.schema,
      async execute(args, callCtx) {
        const { goal, kind, access, role = 'solo', assignment_id: assignment } = args;
        if (typeof goal !== 'string' || !goal.trim()) throw new Error('A task goal is required.');
        for (const [key, value] of Object.entries({ kind, access, role })) {
          if (!WORKLOAD.schema.properties[key].enum.includes(value)) throw new Error('Invalid ' + key);
        }
        const path = resolveConfigPath(configPath);
        const cfg = readJsonSafe(path);
        if (!cfg && existsSync(path)) throw new Error('Cannot read GemPT work split from the host configuration.');
        const policy = cfg?.routing_policy || {};
        const ordinary = policy.work_split ?? 'balanced';
        const profile = role !== 'solo' && policy.swarm_split && policy.swarm_split !== 'inherit'
          ? policy.swarm_split : ordinary;
        if (!Object.hasOwn(WORKLOAD.profiles, profile)) throw new Error('Invalid work split in host config.');
        const plan = WORKLOAD.profiles[profile];
        const result = { profile, role, kind };
        if (!plan.kinds.length) {
          return { ...result, action: 'gemini', disabled: true,
            text: 'GemPT automatic delegation is off. Handle this task directly in Gemini.' };
        }
        if (role === 'coordinator' || role === 'narrator') {
          return { ...result, action: 'board', text: 'Keep this role on the board. Give each task one owner and summarize the results.' };
        }
        if (kind === 'visual' && access === 'change') throw new Error('Separate visual observation from implementation.');
        const budget = resolveBudget(profile, {
          policy, configPath: path, sessionsDir: resolvedSessionsDir, magpieConfigDir: resolvedMagpieDir, env,
        });
        const effectiveKinds = budget.effective_kinds;
        result.budget = {
          target_gpt_share: budget.target_gpt_share,
          actual_gpt_share: budget.actual_gpt_share,
          actual_gpt_fresh_share: budget.actual_gpt_fresh_share,
          adjustment: budget.adjustment,
          effective_kinds: effectiveKinds,
          window_hours: budget.window_hours,
        };
        const delegated = effectiveKinds.includes(kind);
        const action = access === 'provided' ? 'consult' : 'exec';
        if (delegated && action === 'exec' && !isExecEnabled(options, env)) {
          throw new Error('Codex execution is disabled. Enable the Magpie GemPT exec option for workspace tasks. Report this blocker to the user.');
        }
        if (delegated && action === 'exec') normalizeWorkspaceCwd(args.cwd, { configPath, magpieConfigDir: resolvedMagpieDir, env });
        if (role === 'verifier' && access === 'change') throw new Error('Verifier is read-only. Send fixes to the owner.');
        if (role === 'worker' || role === 'verifier') {
          if (typeof assignment !== 'string' || !/^[a-f0-9]{32}$/.test(assignment)) {
            throw new Error('Use the unique 32-hex assignment_id from the board.');
          }
          const claims = join(resolvedSessionsDir, 'swarm-claims');
          mkdirSync(claims, { recursive: true });
          try { mkdirSync(join(claims, assignment)); } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            return { ...result, action: 'already_assigned', text: 'Check the assignment on the board with its owner before retrying.' };
          }
        }
        if (!delegated) {
          return { ...result, action: 'gemini', text: 'Handle this part in Gemini. Report to the board if assigned there.' };
        }
        const task = { goal, cwd: args.cwd, tier: args.tier, gemini_family: args.gemini_family,
          context: args.context, file_paths: args.file_paths, session_id: args.session_id,
          title: args.title, host_conversation_id: args.host_conversation_id };
        const reply = action === 'consult'
          ? await tools.consult.execute({ ...task, expected_output: WORKLOAD.report }, callCtx)
          : await tools.exec.execute({ ...task, run_id: role === 'worker' || role === 'verifier' ? assignment : undefined, verification: args.verification, expected_report: WORKLOAD.report,
            sandbox: access === 'inspect' ? 'read-only' : undefined }, callCtx);
        if (reply.run_id && reply.state !== 'finished') return { ...result, action, ...reply };
        let leanText = String(reply.text || '');
        if (leanText.length > 3200) {
          const head = leanText.slice(0, 2176).trimEnd();
          const tail = leanText.slice(-900).trimStart();
          const omitted = leanText.length - head.length - tail.length;
          const ref = reply.session_id ? `session_id=${reply.session_id} / GemPT Live` : 'GemPT Live';
          leanText = `${head}\n\n...[omitted ${omitted} chars; full output in ${ref}]...\n\n${tail}`;
        }
        return { ...result, action, ...(reply.run_id ? { run_id: reply.run_id, state: reply.state } : {}), model: reply.served_model || reply.model, session_id: reply.session_id,
          text: leanText, usage: reply.usage, warnings: reply.warnings,
          ...(reply.commands ? { commands: reply.commands.map(({ command, exit_code }) => ({ command, exit_code })) } : {}) };
      },
    },
    discover: {
      description:
        'Scan local Magpie gateway for available Codex subscription models, Gemini/utility models, native group/gempt-* routing groups, Codex CLI readiness, and active GemPT config.',
      args: {
        type: 'object',
        properties: {
          magpie_url: { type: 'string', description: 'Optional local Magpie gateway URL override.' },
        },
      },
      async execute(args = {}) {
        const rawCfg = readJsonSafe(resolveConfigPath(configPath));
        const baseUrl = String(args?.magpie_url || rawCfg?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
        const apiKey = rawCfg
          ? resolveMagpieApiKey(rawCfg, baseUrl)
          : (isLoopbackUrl(baseUrl) ? resolveMagpieApiKey({ magpie: { base_url: baseUrl } }) : '');
        const probe = await probeMagpie(baseUrl, apiKey, probeTimeoutMs, resolveExcludedTokens(rawCfg || {}));
        const subPlan = pickSubscriptionPlan(probe);
        const codexPath = findCodexCli(codexCliPath || rawCfg?.codex?.cli_path || '', env);
        return {
          configured: Boolean(rawCfg),
          config_path: resolveConfigPath(configPath),
          failover_mode: String(rawCfg?.routing_policy?.failover_mode || 'subscription_only'),
          api_fallback_available: (probe.openai_models || []).length > 0,
          exec_enabled: isExecEnabled(options, env),
          magpie: {
            reachable: probe.reachable,
            url: probe.url,
            total_models: probe.total_models,
            codex_models: probe.codex_models,
            openai_models: probe.openai_models || [],
            gemini_models: probe.gemini_models,
            utility_candidates: probe.utility_candidates,
            native_groups: probe.native_groups,
            error: probe.error,
          },
          codex_cli: {
            found: Boolean(codexPath),
            path: codexPath,
          },
          recommended_subscription_plan: subPlan,
        };
      },
    },

    status: {
      description: 'Show redacted GemPT configuration, connected Magpie clients/native groups/tools readiness, and recent sessions/runs.',
      args: {
        type: 'object',
        properties: {
          run_id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Retrieve the state and final result of an existing native Codex job.' },
          wait_sec: { type: 'number', minimum: 0, maximum: 20, description: 'Wait up to 20 seconds for a terminal result when polling a run.' },
          session_limit: { type: 'number', description: 'Max recent items to return (1-20, default 6).' },
        },
      },
      async execute(args = {}) {
        if (args.run_id !== undefined) {
          const record = readNativeRun(resolvedSessionsDir, args.run_id);
          normalizeWorkspaceCwd(record.cwd, { configPath, magpieConfigDir: resolvedMagpieDir, env });
          return args.wait_sec ? waitForNativeRun(resolvedSessionsDir, args.run_id, args.wait_sec) : record;
        }
        const execEnabled = isExecEnabled(options, env);
        const state = await readState({
          configPath,
          sessionsDir: resolvedSessionsDir,
          magpieConfigDir: resolvedMagpieDir,
          antigravityPluginDir,
          execEnabled,
          probeTimeoutMs,
        });
        const limit = Number.isFinite(Number(args?.session_limit)) ? Math.max(1, Math.min(20, Number(args.session_limit))) : 6;
        return {
          ...state,
          recent_sessions: (state.recent_sessions || []).slice(0, limit),
          recent_runs: (state.recent_runs || []).slice(0, limit),
        };
      },
    },

    consult: {
      description:
        'Consult GPT/Codex/DeepSeek via local Magpie without Codex CLI ~18K-50K token overhead. Use tier="chore" for free fast log summarization/cleanup, sonnet (~75%, Sol@medium), opus (~20%, Sol@high; escalate=true -> Astra@xhigh), or fable (~5%, Astra@xhigh). On failure retry in a fresh thread without session_id.',
      args: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Clear statement of what the collaborator should solve, critique, summarize, or decide.' },
          gemini_family: WORKLOAD.schema.properties.gemini_family,
          tier: { type: 'string', enum: CONSULT_TIERS, description: 'Target tier (chore, sonnet, opus, fable). Omit for the current Gemini pairing or configured default tier.' },
          escalate: { type: 'boolean', description: 'For opus tier: escalate from Sol to Astra and bump reasoning effort.' },
          context: { type: 'string', description: 'Verified facts, observations, error messages, and current state.' },
          file_paths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace files to attach (requires cwd).' },
          cwd: { type: 'string', description: 'Workspace directory used to contain relative/validated file_paths.' },
          constraints: { type: 'string', description: 'Hard constraints, invariants, or non-goals.' },
          expected_output: { type: 'string', description: 'Required response structure.' },
          session_id: { type: 'string', description: 'Optional consult session_id to continue prior dialogue.' },
          reasoning_effort: { type: 'string', enum: [...VALID_EFFORTS_SET] },
          max_output_tokens: { type: 'number', description: 'Max output tokens (256-128000).' },
          api_mode: { type: 'string', enum: ['responses', 'chat'] },
        },
        required: ['goal'],
      },
      async execute(args = {}, callCtx = {}) {
        const goal = typeof args?.goal === 'string' ? args.goal.trim() : '';
        if (!goal) throw new Error('goal is required and must be a non-empty string.');

        let priorSession = null;
        if (args?.session_id) {
          priorSession = loadSession(resolvedSessionsDir, args.session_id);
          if (!priorSession) throw new Error(`Unknown consult session '${args.session_id}'.`);
          if (priorSession.mode && priorSession.mode !== 'consult') {
            throw new Error(`Session '${args.session_id}' is mode='${priorSession.mode}', not 'consult'.`);
          }
        }

        const runtime = await resolveRuntimeConfig({
          configPath,
          tierForProbe: args?.tier ?? priorSession?.tier,
          allowUtilityOnly: true,
          probeTimeoutMs,
          env,
        });
        const explicitEffort = args?.reasoning_effort
          ? (VALID_EFFORTS_SET.has(args.reasoning_effort) ? args.reasoning_effort : (() => { throw new Error(`Invalid reasoning_effort '${args.reasoning_effort}'.`); })())
          : '';
        const isResume = Boolean(priorSession);
        const lockedResumeEffort = isResume && !explicitEffort ? String(priorSession?.reasoning_effort || '').trim() : '';
        const paired = pairedModel(runtime.cfg, args, priorSession);
        const baseResolved = resolveTierTarget(runtime.cfg, args?.tier || priorSession?.tier, {
          allowChore: true,
          escalate: Boolean(args?.escalate),
          paired,
          effortOverride: explicitEffort || lockedResumeEffort,
        });

        const fileList = Array.isArray(args?.file_paths) ? args.file_paths : [];
        let autoEffortInfo = null;
        let resolved = baseResolved;
        if (Boolean(runtime.cfg?.routing_policy?.auto_effort) && !explicitEffort && !isResume && baseResolved.tier !== 'chore') {
          autoEffortInfo = classifyTaskEffort({
            tier: baseResolved.tier,
            tierDefaultEffort: baseResolved.effort,
            modelId: baseResolved.model,
            escalate: Boolean(args?.escalate),
            goal,
            context: args?.context || '',
            constraints: args?.constraints || '',
            fileCount: fileList.length,
            isResume: false,
          });
          resolved = resolveTierTarget(runtime.cfg, args?.tier || priorSession?.tier, {
            allowChore: true,
            escalate: Boolean(args?.escalate),
            paired,
            effortOverride: autoEffortInfo.effort,
          });
        }

        const effort = resolved.effort;
        if (resolved.failoverMode === 'subscription_only' && resolved.tier !== 'chore' && isHarnessGroup(resolved.model)) {
          await verifySubscriptionGroup(runtime.cfg, resolved.model);
        }
        const apiMode = args?.api_mode
          ? (VALID_API_MODES.has(args.api_mode) ? args.api_mode : (() => { throw new Error(`Invalid api_mode '${args.api_mode}'.`); })())
          : resolved.apiMode;
        const maxTokens = args?.max_output_tokens !== undefined
          ? Math.max(256, Math.min(128000, Number(args.max_output_tokens) || resolved.maxOutputTokens))
          : resolved.maxOutputTokens;

        let validatedCwd = '';
        if (args?.cwd || fileList.length) {
          validatedCwd = normalizeWorkspaceCwd(args?.cwd || priorSession?.cwd || '', {
            configPath,
            magpieConfigDir: resolvedMagpieDir,
            env,
          });
        }

        const limits = runtime.cfg?.limits || {};
        const { blocks, warnings } = readContextFiles(fileList, validatedCwd, {
          maxFileBytes: Number(limits.max_context_file_bytes) || MAX_CONTEXT_FILE_BYTES,
          maxTotalBytes: Number(limits.max_total_context_bytes) || MAX_TOTAL_CONTEXT_BYTES,
        });

        const prompt = buildConsultPrompt({
          goal,
          context: args?.context || '',
          fileBlocks: blocks,
          constraints: args?.constraints || '',
          expectedOutput: args?.expected_output || '',
        });

        const priorTurns = Array.isArray(priorSession?.turns) ? priorSession.turns : [];
        const messages = [...priorTurns, { role: 'user', content: prompt }];
        const timeoutMs = Math.max(
          10,
          Number(limits.consult_timeout_sec) || 180,
          effortTimeoutFloor(effort, { mode: 'consult' }),
        ) * 1000;
        const caller = apiMode === 'chat' ? callChat : callResponses;
        const candidates = [resolved.model, ...(resolved.fallbackModels || [])];
        const attemptedModels = [];
        const t0 = Date.now();
        let reply = null;
        let usedModel = resolved.model;
        let lastErr = null;
        for (let idx = 0; idx < candidates.length; idx += 1) {
          const cand = candidates[idx];
          attemptedModels.push(cand);
          try {
            reply = await caller({
              baseUrl: runtime.baseUrl,
              apiKey: runtime.apiKey,
              model: cand,
              messages,
              reasoningEffort: resolved.tier === 'chore' && !args?.reasoning_effort ? '' : effort,
              instructions: resolved.tier === 'chore' ? 'Be concise, faithful to exact facts, and omit conversational filler.' : CONSULT_SYSTEM_PROMPT,
              maxOutputTokens: maxTokens,
              timeoutMs,
            });
            usedModel = cand;
            break;
          } catch (err) {
            lastErr = err;
            if (idx + 1 >= candidates.length || !shouldRetryFallback(err)) {
              const hint = buildEscalationSuggestion({
                mode: 'consult',
                tier: resolved.tier,
                effort,
                errorMessage: String(err?.message || err),
              });
              throw new Error(hint ? `${err.message} | ${hint}` : err.message);
            }
          }
        }
        if (!reply) throw lastErr || new Error('All consult candidates failed.');
        const elapsedSec = (Date.now() - t0) / 1000;

        const sessionId = priorSession?.session_id || generateSessionId('consult');
        const agent = callingAgent(callCtx) || priorSession?.agent || '';
        const turn = Math.floor(messages.length / 2) + 1;
        const cwd = validatedCwd || priorSession?.cwd || '';
        const title = normalizeTitle(args.title, goal, cwd);
        const hostId = args.host_conversation_id || priorSession?.host_conversation_id || null;
        saveSession(resolvedSessionsDir, {
          ...(priorSession || {}),
          title: explicitTitle(args.title) || (priorSession ? normalizeTitle(priorSession.title, sessionGoal(priorSession), cwd) : title),
          host_conversation_id: hostId,
          paired_model: paired,
          session_id: sessionId,
          mode: 'consult',
          tier: resolved.tier,
          model: reply.servedModel || usedModel,
          reasoning_effort: effort,
          cwd,
          agent,
          turns: [...messages, { role: 'assistant', content: reply.text }],
          turn_details: {
            ...priorSession?.turn_details,
            [turn]: {
              goal, title, host_conversation_id: hostId, timestamp: nowIso(), cwd, agent,
              tier: resolved.tier, served_model: reply.servedModel || usedModel,
              requested_model: resolved.model, sent_model: usedModel, reasoning_effort: effort,
              attempted_models: attemptedModels, elapsed_sec: elapsedSec, usage: reply.usage, response_id: reply.responseId,
            },
          },
        });

        const summary = formatSummaryHeader({
          mode: 'consult',
          tier: resolved.tier,
          model: reply.servedModel || usedModel,
          effort,
          sessionId,
          elapsedSec,
          usage: reply.usage,
          extra: {
            escalated: resolved.escalated ? 'yes' : '',
            auto_effort: autoEffortInfo ? `${autoEffortInfo.effort}(score=${autoEffortInfo.score})` : '',
          },
        });
        return {
          summary,
          text: `${summary}\n\n${reply.text}`,
          session_id: sessionId,
          tier: resolved.tier,
          model: usedModel,
          attempted_models: attemptedModels,
          served_model: reply.servedModel,
          reasoning_effort: effort,
          escalated: resolved.escalated,
          auto_effort: autoEffortInfo,
          elapsed_sec: Number(elapsedSec.toFixed(2)),
          usage: reply.usage,
          warnings,
          agent,
          config_source: runtime.configSource,
        };
      },
    },

    exec: {
      description:
        'Delegate an autonomous coding, refactoring, or verification task to the Magpie-managed Codex app-server inside cwd. Tiers: sonnet (~75%, Sol@medium), opus (~20%, Sol@high; escalate=true -> Astra@xhigh), fable (~5%, Astra@xhigh). Disabled by default until plugin option `exec: true` (or GEMPT_MAGPIE_TOOLS_EXEC=1) is enabled.',
      args: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Exact engineering task and scope for Codex to implement/verify.' },
          title: WORKLOAD.schema.properties.title,
          host_conversation_id: WORKLOAD.schema.properties.host_conversation_id,
          cwd: { type: 'string', description: 'Target workspace directory (cannot be /, ~, ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/magpie, ~/.config/gempt).' },
          gemini_family: WORKLOAD.schema.properties.gemini_family,
          tier: { type: 'string', enum: TIER_ORDER, description: 'Target tier (sonnet, opus, fable). Omit for the current Gemini pairing or configured default tier.' },
          escalate: { type: 'boolean', description: 'For opus tier: escalate from Sol to Astra and bump reasoning effort.' },
          context: { type: 'string', description: 'Verified files, symbols, design choices, and current state.' },
          file_paths: { type: 'array', items: { type: 'string' }, description: 'Optional key workspace files to preload.' },
          constraints: { type: 'string', description: 'Hard constraints or files that must NOT change.' },
          verification: { type: 'string', description: 'Exact tests/commands Codex should run to verify completion.' },
          expected_report: { type: 'string', description: 'Structure for Codex final report.' },
          session_id: { type: 'string', description: 'Optional exec session_id to resume.' },
          sandbox: { type: 'string', enum: VALID_SANDBOXES },
          reasoning_effort: { type: 'string', enum: [...VALID_EFFORTS_SET] },
          background: { type: 'boolean', description: 'Return a run_id immediately. Use gempt-wait to await completion or gempt_ctl for a status snapshot.' },
          run_id: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Optional caller-generated ID; repeat delivery of the same job will not start another worker.' },
          timeout_sec: { type: 'number', description: 'Execution timeout seconds (30-3600).' },
        },
        required: ['goal', 'cwd'],
      },
      async execute(args = {}, callCtx = {}) {
        if (!isExecEnabled(options, env)) {
          throw new Error(
            'Writable gempt_run is disabled by default because Magpie plugin tools can be called by any client holding a gateway key. '
              + 'To enable it, set plugin option `"exec": true` (`magpie plugin options gempt \'{"exec":true}\'`) or `GEMPT_MAGPIE_TOOLS_EXEC=1`.',
          );
        }

        const goal = typeof args?.goal === 'string' ? args.goal.trim() : '';
        if (!goal) throw new Error('goal is required and must be a non-empty string.');

        if (!execRunFile) {
          return startNativeRun({
            args, agent: callingAgent(callCtx), env,
            host: { configPath: resolveConfigPath(configPath), sessionsDir: resolvedSessionsDir,
              magpieConfigDir: resolvedMagpieDir, options: { exec: true }, probeTimeoutMs },
          });
        }

        const runtime = await resolveRuntimeConfig({
          configPath,
          tierForProbe: args?.tier,
          allowUtilityOnly: false,
          probeTimeoutMs,
          env,
        });

        if (worktreePath) normalizeWorkspaceCwd(sourceCwd, { configPath, magpieConfigDir: resolvedMagpieDir, env });
        const workdir = normalizeWorkspaceCwd(args?.cwd, {
          configPath,
          magpieConfigDir: resolvedMagpieDir,
          env: worktreePath ? {} : env,
        });

        const hostDefaultSandbox = VALID_SANDBOXES.includes(runtime.cfg?.codex?.default_sandbox)
          ? runtime.cfg.codex.default_sandbox
          : 'workspace-write';

        let priorSession = null;
        if (args?.session_id) {
          priorSession = loadSession(resolvedSessionsDir, args.session_id);
          if (!priorSession) throw new Error(`Unknown exec session '${args.session_id}'.`);
          if (priorSession.mode && priorSession.mode !== 'exec') {
            throw new Error(`Session '${args.session_id}' is mode='${priorSession.mode}', not 'exec'.`);
          }
          if (!priorSession.cwd || foldCase(realOrResolve(priorSession.cwd)) !== foldCase(workdir)) {
            throw new Error(`Exec resume must stay in the original workspace '${priorSession.cwd || '-'}'.`);
          }
          if (!priorSession.sandbox || !VALID_SANDBOXES.includes(priorSession.sandbox)) {
            throw new Error(`Exec session '${args.session_id}' is missing a valid recorded sandbox.`);
          }
          if (!priorSession.codex_thread_id) {
            throw new Error(`Exec session '${args.session_id}' is missing codex_thread_id.`);
          }
          if (priorSession.gateway && String(priorSession.gateway).replace(/\/+$/, '') !== runtime.baseUrl) {
            throw new Error(`Exec session '${args.session_id}' is bound to gateway '${priorSession.gateway}'.`);
          }
        }

        const requestedSandbox = args.sandbox || hostDefaultSandbox;
        const sandboxUpgraded = Boolean(allowSandboxUpgrade && priorSession?.sandbox === 'read-only'
          && ['workspace-write', 'danger-full-access'].includes(requestedSandbox));
        const ceiling = priorSession && !sandboxUpgraded && SANDBOX_RANK[priorSession.sandbox] < SANDBOX_RANK[hostDefaultSandbox]
          ? priorSession.sandbox : hostDefaultSandbox;
        let effectiveSandbox = ceiling;
        if (args?.sandbox) {
          const reqSbx = String(args.sandbox).trim();
          if (!VALID_SANDBOXES.includes(reqSbx)) {
            throw new Error(`Invalid sandbox '${reqSbx}'. Expected one of: ${VALID_SANDBOXES.join(', ')}.`);
          }
          if (SANDBOX_RANK[reqSbx] > SANDBOX_RANK[ceiling]) {
            throw new Error(`Requested sandbox '${reqSbx}' cannot increase ceiling '${ceiling}'.`);
          }
          effectiveSandbox = reqSbx;
        }

        const explicitEffort = args?.reasoning_effort
          ? (VALID_EFFORTS_SET.has(args.reasoning_effort) ? args.reasoning_effort : (() => { throw new Error(`Invalid reasoning_effort '${args.reasoning_effort}'.`); })())
          : '';
        const isResume = Boolean(priorSession);
        const lockedResumeEffort = isResume && !explicitEffort ? String(priorSession?.reasoning_effort || '').trim() : '';
        const paired = pairedModel(runtime.cfg, args, priorSession);
        const baseResolved = resolveTierTarget(runtime.cfg, args?.tier || priorSession?.tier, {
          allowChore: false,
          escalate: Boolean(args?.escalate),
          paired,
          effortOverride: explicitEffort || lockedResumeEffort,
        });

        const fileList = Array.isArray(args?.file_paths) ? args.file_paths : [];
        let autoEffortInfo = null;
        let resolved = baseResolved;
        if (Boolean(runtime.cfg?.routing_policy?.auto_effort) && !explicitEffort && !isResume) {
          autoEffortInfo = classifyTaskEffort({
            tier: baseResolved.tier,
            tierDefaultEffort: baseResolved.effort,
            modelId: baseResolved.model,
            escalate: Boolean(args?.escalate),
            goal,
            context: args?.context || '',
            constraints: args?.constraints || '',
            fileCount: fileList.length,
            isResume: false,
          });
          resolved = resolveTierTarget(runtime.cfg, args?.tier || priorSession?.tier, {
            allowChore: false,
            escalate: Boolean(args?.escalate),
            paired,
            effortOverride: autoEffortInfo.effort,
          });
        }

        const targetModel = resolved.execModel || resolved.model;
        if (resolved.failoverMode === 'subscription_only') {
          if (isHarnessGroup(targetModel)) {
            await verifySubscriptionGroup(runtime.cfg, targetModel);
          } else if (!isCodexModelId(targetModel)) {
            throw new Error(`Subscription-only exec requires a codex/* model, got '${targetModel}'.`);
          }
        } else if (!isAllowedFallbackTarget(targetModel)) {
          throw new Error(`Unsupported exec model '${targetModel}' for tier '${resolved.tier}'.`);
        }

        const effort = resolved.effort;

        const limits = runtime.cfg?.limits || {};
        const { blocks, warnings } = readContextFiles(args?.file_paths, workdir, {
          maxFileBytes: Number(limits.max_context_file_bytes) || MAX_CONTEXT_FILE_BYTES,
          maxTotalBytes: Number(limits.max_total_context_bytes) || MAX_TOTAL_CONTEXT_BYTES,
        });

        const priorTurns = Array.isArray(priorSession?.turns) ? priorSession.turns : [];
        let carryover = '';
        if (sandboxUpgraded) {
          const latest = priorTurns.slice(-2).flatMap((entry) => {
            if (typeof entry?.content === 'string') return [`${entry.role || 'Prior turn'}: ${entry.content.slice(0, 1200)}`];
            return [entry?.goal, entry?.reply ?? entry?.text].filter((text) => typeof text === 'string').map((text) => text.slice(0, 1200));
          });
          carryover = ['Carryover from the prior read-only Codex thread (for context):', ...latest].join('\n');
        }
        const prompt = buildExecPrompt({
          goal,
          context: [carryover, args.context].filter(Boolean).join('\n\n'),
          fileBlocks: blocks,
          constraints: args?.constraints || '',
          verification: args?.verification || '',
          expectedReport: args?.expected_report || '',
          isResume: isResume && !sandboxUpgraded,
        });

        const timeoutSec = args?.timeout_sec !== undefined
          ? Math.max(30, Math.min(3600, Number(args.timeout_sec) || 600))
          : Math.max(
            Number(runtime.cfg?.codex?.timeout_sec) || 600,
            effortTimeoutFloor(effort, { mode: 'exec' }),
          );

        if (runtime.cfg?.codex?.extra_args?.length) throw new Error('Unrestricted Codex extra_args conflict with gateway and sandbox enforcement.');
        const sessionId = priorSession?.session_id || newExecSession;
        const agent = callingAgent(callCtx) || priorSession?.agent || '';
        const title = normalizeTitle(args.title, goal, workdir);
        const hostId = args.host_conversation_id || priorSession?.host_conversation_id || null;
        const session = {
          ...(priorSession || {}),
          title: explicitTitle(args.title) || (priorSession ? normalizeTitle(priorSession.title, sessionGoal(priorSession), workdir) : title),
          host_conversation_id: hostId,
          paired_model: paired, session_id: sessionId, mode: 'exec', tier: resolved.tier, model: targetModel,
          reasoning_effort: effort, cwd: workdir, sandbox: effectiveSandbox, gateway: runtime.baseUrl, agent,
          ...(worktreePath ? { worktree_path: worktreePath, source_cwd: sourceCwd } : {}),
          ...(sandboxUpgraded ? { sandbox_upgraded: true } : {}),
        };
        if (!sandboxUpgraded) saveSession(resolvedSessionsDir, session);
        let res;
        try {
          res = await runAppServer({
            configPath, env, runFile: execRunFile, sessionId, prompt, cwd: workdir, model: targetModel, effort,
            sandbox: effectiveSandbox, threadId: sandboxUpgraded ? undefined : priorSession?.codex_thread_id,
            sandboxUpgraded, gatewayUrl: runtime.baseUrl,
            approvalPolicy: effectiveSandbox === 'danger-full-access' ? runtime.cfg?.codex?.approval_policy || 'never' : 'never',
            timeoutSec,
            onIdentity(threadId, turnId, observedSandbox) {
              session.codex_thread_id = threadId;
              session.turn_id = turnId;
              session.sandbox = observedSandbox;
              saveSession(resolvedSessionsDir, session);
            },
          });
        } catch (err) {
          if (err instanceof TurnInterrupted) throw err;
          const msg = String(err?.message || err);
          const hint = buildEscalationSuggestion({
            mode: 'exec',
            tier: resolved.tier,
            effort,
            timedOut: msg.toLowerCase().includes('timed out'),
            errorMessage: msg,
          });
          throw new Error(hint && !msg.includes(hint) ? `${msg} | ${hint}` : msg);
        }

        const turn = priorTurns.filter((entry) => !entry.role || entry.role === 'user').length + 1;
        const timestamp = nowIso();
        saveSession(resolvedSessionsDir, {
          ...session, sandbox: res.sandbox, codex_thread_id: res.threadId, turn_id: res.turnId,
          turns: [...priorTurns, { role: 'user', content: prompt }, { role: 'assistant', content: res.text }],
          turn_details: {
            ...priorSession?.turn_details,
            [turn]: {
              goal, title, host_conversation_id: hostId, timestamp, cwd: workdir, agent, tier: resolved.tier, model: targetModel,
              reasoning_effort: effort, codex_thread_id: res.threadId, run_id: args.run_id,
              elapsed_sec: res.elapsedSec, usage: res.usage, verification: args.verification, commands: res.commands,
            },
          },
        });

        const summary = formatSummaryHeader({
          mode: 'exec',
          tier: resolved.tier,
          model: targetModel,
          effort,
          sessionId,
          elapsedSec: res.elapsedSec,
          usage: res.usage,
          extra: {
            sandbox: res.sandbox,
            codex_thread: res.threadId,
            escalated: resolved.escalated ? 'yes' : '',
            auto_effort: autoEffortInfo ? `${autoEffortInfo.effort}(score=${autoEffortInfo.score})` : '',
          },
        });
        return {
          summary,
          text: `${summary}\n\n${res.text}`,
          session_id: sessionId,
          title,
          host_conversation_id: hostId,
          turns: turn,
          timestamp,
          codex_thread_id: res.threadId,
          turn_id: res.turnId,
          tier: resolved.tier,
          model: targetModel,
          reasoning_effort: effort,
          escalated: resolved.escalated,
          auto_effort: autoEffortInfo,
          sandbox: res.sandbox,
          ...(worktreePath ? { worktree_path: worktreePath, source_cwd: sourceCwd } : {}),
          ...(sandboxUpgraded ? { sandbox_upgraded: true } : {}),
          cwd: workdir,
          elapsed_sec: Number(res.elapsedSec.toFixed(2)),
          commands: res.commands,
          usage: res.usage,
          warnings,
          agent,
        };
      },
    },
  };
  return tools;
}

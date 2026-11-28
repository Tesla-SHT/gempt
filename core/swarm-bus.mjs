import { ACTIVE_STATES, readRun, refreshRun, runBoardTelemetry } from './runs.mjs';
import { pidAlive } from '../magpie_plugin/lib/app-server-process.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { openDatabaseSync } from './sqlite.mjs';
import { resolvePath, withinPath } from './state.mjs';

import {
  ALL, MAIN, ROLE_WORKER_RE, activeAt, channelMentions, channelRegistry,
  channelsAt, countsUnread, effectiveChannels, memberView, mentionsIn, mentionsOf, seesIn,
  validateChannelName, validateTopic, visibleUnread,
} from './swarm-channels.mjs';

const IMPLICIT_ID_GLOB = 'conversation-' + '[0-9a-f]'.repeat(64);
const isImplicitSwarmId = (id) => /^conversation-[a-f0-9]{64}$/.test(id);
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const SWARM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RESERVED_WORKER_NAMES = new Set(['all', 'coordinator', 'human']);
const MENTION_RE = /(?<![\p{L}\p{Nd}_-])@([a-z0-9][a-z0-9_-]{0,23})(?![\p{L}\p{Nd}_-])/giu;
const SCREENSHOT_RE = /^[ \t]*(?:[-*][ \t]+)?Screenshot:[ \t]*([^|\r\n]+?)(?:[ \t]*\|[ \t]*([^\r\n]*))?[ \t]*$/gmi;

const SCHEMA_VERSION = 5;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_lineage (
  run_id TEXT PRIMARY KEY, swarm_id TEXT, worker_name TEXT, session_id TEXT,
  parent_run_id TEXT, root_run_id TEXT, parent_worker TEXT, cli TEXT NOT NULL,
  model TEXT, protocol TEXT, native_session_id TEXT, parent_native_session_id TEXT,
  fork_mode TEXT, cache_group_key TEXT, worktree_path TEXT, source_cwd TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_native ON run_lineage(native_session_id);
CREATE INDEX IF NOT EXISTS idx_lineage_session ON run_lineage(session_id);
CREATE INDEX IF NOT EXISTS idx_lineage_worker ON run_lineage(swarm_id, worker_name);
CREATE INDEX IF NOT EXISTS idx_lineage_cache ON run_lineage(cache_group_key);
CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY,
  host_conversation_id TEXT,
  cwd TEXT,
  title TEXT,
  goal_title TEXT,
  goal_line TEXT,
  threads_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_monitor_ticks (
  swarm_id TEXT PRIMARY KEY REFERENCES swarms(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roster (
  swarm_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cli TEXT,
  model TEXT,
  tier TEXT,
  access TEXT,
  workspace TEXT,
  worktree_path TEXT,
  source_cwd TEXT,
  state TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  brief TEXT,
  task_summary TEXT,
  last_seq INTEGER DEFAULT 0,
  parked_on TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (swarm_id, name),
  FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions_json TEXT NOT NULL,
  screenshots_json TEXT NOT NULL,
  reply_to_seq INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deliveries (
  seq INTEGER NOT NULL,
  swarm_id TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (seq, target_agent),
  FOREIGN KEY (seq) REFERENCES messages(seq) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_swarm_seq ON messages(swarm_id, seq);
CREATE INDEX IF NOT EXISTS idx_roster_swarm_state ON roster(swarm_id, state);
CREATE INDEX IF NOT EXISTS idx_swarms_host_conv ON swarms(host_conversation_id);
`;

const migrations = {
  roster: {
    role: "TEXT DEFAULT 'worker'", added_by: "TEXT DEFAULT 'coordinator'", channels_json: 'TEXT',
    fork_mode: 'TEXT', desired_model: 'TEXT', applied_model: 'TEXT', tail_from_seq: 'INTEGER DEFAULT 0',
    desired_runtime_json: 'TEXT', timeout_sec: 'REAL',
    wake_mode: "TEXT DEFAULT 'mentions'", wait_since: 'INTEGER DEFAULT 0', last_read_seq: 'INTEGER DEFAULT 0',
    last_nudged_seq: 'INTEGER DEFAULT 0', last_park_blocked_seq: 'INTEGER DEFAULT 0', quota_paused_seq: 'INTEGER DEFAULT 0',
  },
  messages: { channel: "TEXT DEFAULT 'main'", control_json: 'TEXT', request_id: 'TEXT' },
};
const nowIso = () => new Date().toISOString();

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function normalizeCwdKey(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  try {
    const resolved = resolvePath(cwd.trim());
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return cwd.trim();
  }
}

export function resolveSwarmDbPath(sessionsDir) {
  return join(resolveSessionsDir(sessionsDir), 'swarm.sqlite');
}

export async function openSwarmDb(sessionsDir) {
  return openSwarmDbSync(sessionsDir);
}

function hasMissingMigrationColumn(db) {
  for (const [table, columns] of Object.entries(migrations)) {
    const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    if (existing.size === 0) return true;
    for (const column of Object.keys(columns)) {
      if (!existing.has(column)) return true;
    }
  }
  return false;
}

function openSwarmDbSync(sessionsDir) {
  const db = openDatabaseSync(resolveSwarmDbPath(sessionsDir));
  try {
    const { user_version } = db.get('PRAGMA user_version');
    if (user_version < SCHEMA_VERSION || !db.get("SELECT 1 FROM sqlite_master WHERE name='swarm_monitor_ticks'")
        || !db.get("SELECT 1 FROM sqlite_master WHERE name='idx_swarm_request_id'")
        || hasMissingMigrationColumn(db)) {
      db.transaction(() => {
        db.exec(SCHEMA_SQL);
        for (const [table, columns] of Object.entries(migrations)) {
          const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
          for (const [column, type] of Object.entries(columns)) {
            if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
          }
        }
        db.exec(`CREATE TABLE IF NOT EXISTS post_window (swarm_id TEXT, agent TEXT, posted_ms INTEGER);
          CREATE INDEX IF NOT EXISTS idx_post_window ON post_window(swarm_id, agent, posted_ms);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_request_id ON messages(swarm_id, request_id) WHERE request_id IS NOT NULL`);
        db.exec(`INSERT OR IGNORE INTO roster (swarm_id, name, role, state, channels_json, session_id, created_at, updated_at)
          SELECT id, 'coordinator', 'coordinator', 'waiting', '["*"]', host_conversation_id, created_at, updated_at FROM swarms`);
        db.exec("UPDATE roster SET role='coordinator', channels_json='[\"*\"]' WHERE name='coordinator'");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function withDb(sessionsDir, fn, existingDb) {
  if (existingDb) return fn(existingDb);
  const db = await openSwarmDb(sessionsDir);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function withLineageDb(sessionsDir, fn, existingDb) {
  if (existingDb) return fn(existingDb);
  const db = openSwarmDbSync(sessionsDir);
  try { return fn(db); }
  finally { db.close(); }
}

export function lineageProtocol(cli) {
  return ({ codex: 'openai-responses', claude: 'anthropic-messages', gemini: 'gemini',
    opencode: 'openai-chat' })[cli] || (cli && cli !== 'auto' ? 'cli:' + cli : null);
}

function groupHash(parts) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function resolveLineageCacheKey(row, parent) {
  if (parent?.cache_group_key && parent.cli === row.cli && parent.model === row.model && parent.protocol === row.protocol)
    return parent.cache_group_key;
  if (row.swarm_id && row.model && row.protocol) {
    const parts = [row.swarm_id, row.model];
    if (row.protocol !== 'openai-responses') parts.push(row.protocol);
    return groupHash(parts);
  }
  const id = row.native_session_id;
  if (row.protocol && row.protocol !== 'openai-responses') return groupHash([row.protocol, row.model, id || row.run_id]);
  return id && id.length > 64 ? groupHash([row.protocol, id]) : id || null;
}

export function getRunLineage(runId, { sessionsDir, db } = {}) {
  return withLineageDb(sessionsDir, (conn) => conn.get('SELECT * FROM run_lineage WHERE run_id=?', runId), db);
}

// Only a Codex Responses registration can authorize a proxy rewrite.
export function findCacheKeyByNativeSession(id, { sessionsDir, db, model } = {}) {
  if (!id || typeof id !== 'string') return null;
  return withLineageDb(sessionsDir, (conn) => conn.get(`SELECT r.*, COALESCE(root.parent_native_session_id, root.native_session_id) AS root_thread_id
    FROM run_lineage r LEFT JOIN run_lineage root ON root.run_id=r.root_run_id AND root.cli=r.cli
    WHERE r.native_session_id=? AND r.cli='codex' AND r.protocol='openai-responses' AND r.cache_group_key IS NOT NULL
    AND (? IS NULL OR r.model IS NULL OR r.model=?) ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 1`,
    id, model ?? null, model ?? null), db);
}

const lineageColumns = ['run_id', 'swarm_id', 'worker_name', 'session_id', 'parent_run_id', 'root_run_id',
  'parent_worker', 'cli', 'model', 'protocol', 'native_session_id', 'parent_native_session_id', 'fork_mode',
  'cache_group_key', 'worktree_path', 'source_cwd', 'created_at', 'updated_at'];

export function upsertRunLineage(patch, { sessionsDir, db } = {}) {
  if (!patch.run_id) throw new Error('Lineage requires a run_id.');
  return withLineageDb(sessionsDir, (conn) => conn.transaction(() => {
    const old = getRunLineage(patch.run_id, { db: conn });
    const row = { ...old };
    for (const key of lineageColumns) if (patch[key] != null) row[key] = patch[key];
    row.parent_run_id = old?.parent_run_id || row.parent_run_id;
    let parent = row.parent_run_id && getRunLineage(row.parent_run_id, { db: conn });
    if (!row.parent_run_id && row.parent_native_session_id && patch.parent_cli) {
      parent = conn.get(`SELECT * FROM run_lineage WHERE native_session_id=? AND cli=?
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`, row.parent_native_session_id, patch.parent_cli);
    }
    if (!old && !parent && !row.parent_run_id && row.session_id) {
      parent = conn.get('SELECT * FROM run_lineage WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', row.session_id);
    }
    row.parent_run_id ??= parent?.run_id;
    row.root_run_id = parent?.root_run_id || row.root_run_id || row.parent_run_id || row.run_id;
    row.parent_worker ??= parent?.worker_name;
    row.parent_native_session_id ??= parent?.native_session_id;
    row.cli ??= 'auto';
    row.protocol = patch.protocol ?? (old?.cli === row.cli ? old.protocol : null) ?? lineageProtocol(row.cli);
    const sameScope = old && old.cli === row.cli && old.model === row.model && old.protocol === row.protocol;
    row.cache_group_key = patch.cache_group_key || (sameScope && old.cache_group_key) || resolveLineageCacheKey(row, parent);
    if (row.cache_group_key?.length > 64) throw new Error('Cache group key exceeds 64 characters.');
    row.updated_at = nowIso();
    row.created_at ??= row.updated_at;
    conn.run(`INSERT INTO run_lineage (${lineageColumns.join(',')}) VALUES (${lineageColumns.map(() => '?')})
      ON CONFLICT(run_id) DO UPDATE SET ${lineageColumns.slice(1).map((k) => k + '=excluded.' + k)}`,
      ...lineageColumns.map((key) => row[key] ?? null));
    return row;
  }), db);
}

export function validateWorkerName(name) {
  if (typeof name !== 'string') {
    throw new Error('Worker name must be a non-empty string.');
  }
  const trimmed = name.trim();
  if (!WORKER_NAME_RE.test(trimmed)) {
    throw new Error(`Invalid worker name '${name}': expected 1-24 lowercase alphanumeric, '-' or '_' starting with a-z or 0-9.`);
  }
  if (RESERVED_WORKER_NAMES.has(trimmed) || trimmed.startsWith('coordinator-')) {
    throw new Error(`Reserved worker name '${trimmed}' is not allowed.`);
  }
  return trimmed;
}

export function validateSwarmId(id) {
  if (typeof id !== 'string') throw new Error('swarm_id must be a non-empty string.');
  const trimmed = id.trim();
  if (!SWARM_ID_RE.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`Invalid swarm_id '${id}'.`);
  }
  return trimmed;
}

export function parseMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const target = match[1].toLowerCase();
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

export function parseScreenshots(text, { absoluteImagesOnly = false } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const match of text.matchAll(SCREENSHOT_RE)) {
    const path = match[1].trim().replace(/^`(.+)`$/, '$1');
    const caption = (match[2] || '').trim();
    if (absoluteImagesOnly && (!/^(?:\/|[a-z]:[\\/])/i.test(path) || !/\.(?:png|jpe?g|webp)$/i.test(path))) continue;
    if (path) out.push({ path, caption });
  }
  return out;
}

function formatSwarm(row) {
  if (!row) return null;
  return {
    id: row.id,
    host_conversation_id: row.host_conversation_id ?? null,
    cwd: row.cwd ?? null,
    title: row.title ?? null,
    goal_title: row.goal_title ?? null,
    goal_line: row.goal_line ?? null,
    threads: safeJsonParse(row.threads_json, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatWorker(row) {
  if (!row) return null;
  return {
    swarm_id: row.swarm_id,
    name: row.name,
    implicit: isImplicitSwarmId(row.swarm_id) && /^solo-[a-f0-9]{12}$/.test(row.name),
    cli: row.cli ?? 'codex',
    model: row.model ?? null,
    tier: row.tier ?? null,
    desired_model: row.desired_model ?? row.model ?? null,
    applied_model: row.applied_model ?? row.model ?? null,
    // SQL NULL inherits configuration. Zero records an explicitly unlimited worker.
    ...(row.timeout_sec != null ? { timeout_sec: row.timeout_sec || null } : {}),
    desired_runtime: safeJsonParse(row.desired_runtime_json, null),
    tail_from_seq: Number(row.tail_from_seq || 0),
    access: row.access ?? 'change',
    workspace: row.workspace ?? 'inherit',
    worktree_path: row.worktree_path ?? null,
    source_cwd: row.source_cwd ?? null,
    role: row.role || 'worker',
    added_by: row.added_by || 'coordinator',
    channels: safeJsonParse(row.channels_json, null),
    fork_mode: row.fork_mode ?? null,
    wake_mode: row.wake_mode || 'mentions',
    wait_since: Number(row.wait_since || 0),
    last_read_seq: Number(row.last_read_seq || 0),
    last_nudged_seq: Number(row.last_nudged_seq || 0),
    last_park_blocked_seq: Number(row.last_park_blocked_seq || 0),
    quota_paused_seq: Number(row.quota_paused_seq || 0),
    state: row.state,
    run_id: row.run_id ?? null,
    session_id: row.session_id ?? null,
    brief: row.brief ?? null,
    task_summary: row.task_summary ?? null,
    last_seq: Number(row.last_seq ?? 0),
    parked_on: row.parked_on ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}


function formatMessage(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    swarm_id: row.swarm_id,
    from_agent: row.from_agent,
    channel: row.channel || MAIN,
    channel_mentions: channelMentions(row.text),
    control: safeJsonParse(row.control_json, null),
    request_id: row.request_id ?? null,
    kind: row.kind,
    text: row.text,
    mentions: safeJsonParse(row.mentions_json, []),
    screenshots: safeJsonParse(row.screenshots_json, []),
    reply_to_seq: row.reply_to_seq == null ? null : Number(row.reply_to_seq),
    meta: safeJsonParse(row.meta_json, null),
    created_at: row.created_at,
  };
}

function deterministicId(prefix, seed) {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

export function resolveImplicitSwarmId(hostConversationId) {
  const conversation = typeof hostConversationId === 'string' && hostConversationId.trim();
  return conversation ? 'conversation-' + createHash('sha256').update(conversation).digest('hex') : null;
}

export function soloWorkerName(sessionId) {
  return deterministicId('solo', sessionId);
}

export async function resolveSwarmId({ swarmId, hostConversationId, cwd, sessionsDir, db, workspaceRoots, bindingCwd, envRoot } = {}) {
  if (typeof swarmId === 'string' && swarmId.trim()) {
    const id = validateSwarmId(swarmId);
    if (workspaceRoots) {
      const inScope = (path) => typeof path === 'string' && isAbsolute(path) &&
        workspaceRoots.some((root) => withinPath(resolvePath(path), resolvePath(root))) &&
        (!envRoot || withinPath(resolvePath(path), resolvePath(envRoot)));
      const existing = await withDb(sessionsDir, (conn) => conn.get('SELECT cwd FROM swarms WHERE id = ?', id), db);
      if (!inScope(existing ? existing.cwd : cwd) || (bindingCwd && !inScope(bindingCwd))) {
        throw Object.assign(new Error('Swarm outside host workspace.'), { status: 403 });
      }
    }
    return id;
  }
  const implicit = resolveImplicitSwarmId(hostConversationId);
  if (implicit) return implicit;
  return withDb(sessionsDir, (conn) => {
    const cwdKey = normalizeCwdKey(cwd);
    if (cwdKey) {
      const rows = conn.all('SELECT id, cwd FROM swarms WHERE cwd IS NOT NULL AND id NOT GLOB ? ORDER BY updated_at DESC LIMIT 100', IMPLICIT_ID_GLOB);
      const match = rows.find((row) => normalizeCwdKey(row.cwd) === cwdKey);
      return match?.id || deterministicId('swarm', `cwd:${cwdKey}`);
    }
    const latest = conn.get('SELECT id FROM swarms WHERE id NOT GLOB ? ORDER BY updated_at DESC LIMIT 1', IMPLICIT_ID_GLOB);
    return latest?.id || `swarm-${randomBytes(6).toString('hex')}`;
  }, db);
}

function ensureSwarmInDb(conn, { swarmId, hostConversationId = null, cwd = null, title = null, goalTitle = null, goalLine = null, threads } = {}) {
  const id = validateSwarmId(swarmId);
  const now = nowIso();
  const existing = conn.get('SELECT * FROM swarms WHERE id = ?', id);
  if (isImplicitSwarmId(id)) {
    // An explicit reference may reopen this board, but cannot create or rebind its namespace.
    if (resolveImplicitSwarmId(existing ? existing.host_conversation_id : hostConversationId) !== id) throw new Error('Reserved conversation swarm ID.');
    if (existing) {
      hostConversationId = existing.host_conversation_id;
      cwd = existing.cwd || cwd;
    }
  }
  if (!existing) {
    conn.run(
      `INSERT INTO swarms (id, host_conversation_id, cwd, title, goal_title, goal_line, threads_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      hostConversationId ?? null,
      cwd ?? null,
      title ?? null,
      goalTitle ?? null,
      goalLine ?? null,
      threads !== undefined ? JSON.stringify(threads) : null,
      now,
      now,
    );
  } else {
    const nextConv = hostConversationId ?? existing.host_conversation_id;
    const nextCwd = cwd ?? existing.cwd;
    const nextTitle = title ?? existing.title;
    const nextGoalTitle = goalTitle ?? existing.goal_title;
    const nextGoalLine = goalLine ?? existing.goal_line;
    const nextThreads = threads !== undefined ? JSON.stringify(threads) : existing.threads_json;
    if (nextConv !== existing.host_conversation_id || nextCwd !== existing.cwd
        || nextTitle !== existing.title || nextGoalTitle !== existing.goal_title
        || nextGoalLine !== existing.goal_line || nextThreads !== existing.threads_json) {
      conn.run(
        `UPDATE swarms SET host_conversation_id = ?, cwd = ?, title = ?, goal_title = ?, goal_line = ?, threads_json = ?, updated_at = ?
         WHERE id = ?`,
        nextConv, nextCwd, nextTitle, nextGoalTitle, nextGoalLine, nextThreads, now, id,
      );
    }
  }
  conn.run(`INSERT INTO roster (swarm_id, name, role, state, channels_json, session_id, created_at, updated_at)
    SELECT id, 'coordinator', 'coordinator', 'waiting', '["*"]', host_conversation_id, created_at, updated_at FROM swarms WHERE id = ?
    ON CONFLICT(swarm_id,name) DO UPDATE SET session_id=excluded.session_id`, id);
  return formatSwarm(conn.get('SELECT * FROM swarms WHERE id = ?', id));
}

export async function ensureSwarm({
  swarmId, hostConversationId, cwd, title, goalTitle, goalLine, threads, sessionsDir, db,
} = {}) {
  return withDb(sessionsDir, async (conn) => {
    const id = await resolveSwarmId({ swarmId, hostConversationId, cwd, sessionsDir, db: conn });
    return ensureSwarmInDb(conn, { swarmId: id, hostConversationId, cwd, title, goalTitle, goalLine, threads });
  }, db);
}

export async function setSwarmTitle(swarmId, title, { hostConversationId, cwd, sessionsDir, db } = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('Swarm title must be a non-empty string.');
  return withDb(sessionsDir, (conn) => {
    const id = validateSwarmId(swarmId);
    ensureSwarmInDb(conn, { swarmId: id, hostConversationId, cwd });
    conn.run('UPDATE swarms SET title = ?, updated_at = ? WHERE id = ?', cleanTitle, nowIso(), id);
    return formatSwarm(conn.get('SELECT * FROM swarms WHERE id = ?', id));
  }, db);
}

export async function setSwarmPlan(swarmId, { goal, tasks, threads } = {}, { hostConversationId, cwd, sessionsDir, db } = {}) {
  return withDb(sessionsDir, (conn) => conn.transaction(() => {
    const id = validateSwarmId(swarmId);
    const swarm = ensureSwarmInDb(conn, { swarmId: id, hostConversationId, cwd });
    const now = nowIso();
    const goalTitle = goal && typeof goal.title === 'string' ? goal.title.trim() : swarm.goal_title;
    const goalLine = goal && typeof goal.line === 'string' ? goal.line.trim() : swarm.goal_line;
    const threadsJson = threads !== undefined ? JSON.stringify(Array.isArray(threads) ? threads : []) : (
      swarm.threads.length ? JSON.stringify(swarm.threads) : null
    );
    conn.run(
      'UPDATE swarms SET goal_title = ?, goal_line = ?, threads_json = ?, updated_at = ? WHERE id = ?',
      goalTitle ?? null,
      goalLine ?? null,
      threadsJson,
      now,
      id,
    );
    const updatedTasks = {};
    if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) {
      for (const [rawName, summary] of Object.entries(tasks)) {
        const workerName = validateWorkerName(rawName);
        const text = String(summary ?? '').trim();
        const res = conn.run(
          'UPDATE roster SET task_summary = ?, updated_at = ? WHERE swarm_id = ? AND name = ?',
          text || null,
          now,
          id,
          workerName,
        );
        if (res.changes > 0) updatedTasks[workerName] = text;
      }
    }
    return {
      swarm: formatSwarm(conn.get('SELECT * FROM swarms WHERE id = ?', id)),
      updated_tasks: updatedTasks,
    };
  }), db);
}

export async function upsertWorker(swarmId, worker, { hostConversationId, cwd, sessionsDir, db } = {}) {
  if (!worker || typeof worker !== 'object') throw new Error('Worker record is required.');
  const name = validateWorkerName(worker.name);
  return withDb(sessionsDir, (conn) => conn.transaction(() =>
    saveWorker(conn, validateSwarmId(swarmId), name, worker, { hostConversationId, cwd })), db);
}

function saveWorker(conn, id, name, worker, { hostConversationId, cwd }) {
  ensureSwarmInDb(conn, { swarmId: id, hostConversationId, cwd });
  const now = nowIso();
  const patch = serializeWorkerPatch(worker);
  const supplied = WORKER_UPDATABLE_COLS.filter((key) => patch[key] !== undefined);
  conn.run('UPDATE swarms SET updated_at = ? WHERE id = ?', now, id);
  const initial = { cli: 'codex', access: 'change', workspace: 'inherit', state: 'working',
    ...Object.fromEntries(supplied.map((key) => [key, patch[key]])) };
  const columns = Object.keys(initial);
  const updates = [...supplied, 'updated_at'].map((key) => `${key} = excluded.${key}`);
  conn.run(`INSERT INTO roster (swarm_id, name, created_at, updated_at, ${columns.join(', ')})
    VALUES (?, ?, ?, ?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(swarm_id, name) DO UPDATE SET ${updates.join(', ')}`,
    id, name, now, now, ...Object.values(initial));
  return formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, name));
}

function serializeWorkerPatch(worker) {
  return {
    ...worker,
    // Undefined resets a newly added worker to inherit. Null pins it to unlimited.
    ...(Object.hasOwn(worker, 'timeout_sec') ? { timeout_sec: worker.timeout_sec === null ? 0 : worker.timeout_sec ?? null } : {}),
    ...(worker.channels === undefined ? {} : { channels_json: worker.channels === null ? null : JSON.stringify(worker.channels) }),
    ...(worker.desired_runtime === undefined ? {} : { desired_runtime_json: worker.desired_runtime === null ? null : JSON.stringify(worker.desired_runtime) }),
  };
}

export async function addWorkerBriefs(swarmId, specs, options = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(options.sessionsDir, (conn) => conn.transaction(() => {
    checkWorkerTurn(conn, id, options.workerTurn);
    const live = conn.all("SELECT name FROM roster WHERE swarm_id = ? AND name != 'coordinator' AND state != 'killed'", id);
    if (live.length + specs.length > 32) throw new Error('At most 32 live workers are supported.');
    const registry = registryInDb(conn, id);
    const briefs = specs.map(({ worker, channel }) => {
      const name = validateWorkerName(worker.name);
      if (isImplicitSwarmId(id) && /^solo-[a-f0-9]{12}$/.test(name)) throw new Error('Reserved solo worker name.');
      if (live.some((w) => w.name === name)) throw new Error(`Worker '${name}' already exists.`);
      for (const c of worker.channels || []) {
        if (c !== ALL) requireActive(registry, c);
      }
      const message = appendMessage(conn, id, { from: worker.added_by, kind: 'brief', channel,
        text: `@${name} ${worker.brief}`, meta: { worker: name } }, { skipRateLimit: true });
      saveWorker(conn, id, name, { ...worker, timeout_sec: worker.timeout_sec, run_id: worker.run_id ?? null, session_id: null, worktree_path: null,
        last_seq: message.seq, last_read_seq: message.seq, tail_from_seq: message.seq, wait_since: 0, last_nudged_seq: 0,
        last_park_blocked_seq: 0, quota_paused_seq: 0, wake_mode: 'mentions' }, options);
      conn.run('INSERT INTO deliveries VALUES (?, ?, ?, ?)', message.seq, id, name, nowIso());
      return message;
    });
    if (briefs.length > 1) {
      const head = briefs.at(-1).seq;
      const names = briefs.slice(0, -1).map((brief) => brief.meta.worker);
      conn.run(`UPDATE roster SET last_read_seq = ?, last_seq = ? WHERE swarm_id = ? AND name IN (${names.map(() => '?').join(',')})`,
        head, head, id, ...names);
    }
    return briefs;
  }), options.db);
}

const WORKER_UPDATABLE_COLS = [
  ...Object.keys(migrations.roster),
  'cli', 'model', 'tier', 'access', 'workspace', 'worktree_path', 'source_cwd',
  'state', 'run_id', 'session_id', 'brief', 'task_summary', 'last_seq', 'parked_on', 'error',
];

export async function updateWorker(swarmId, name, patch = {}, { sessionsDir, db, expectedState, expectedRun, workerTurn } = {}) {
  const id = validateSwarmId(swarmId);
  const workerName = name === 'coordinator' ? name : validateWorkerName(name);
  return withDb(sessionsDir, (conn) => withWorkerTurn(conn, id, workerTurn, () => {
    const existing = conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, workerName);
    if (!existing) return null;
    patch = serializeWorkerPatch(patch);
    const sets = [];
    const params = [];
    for (const col of WORKER_UPDATABLE_COLS) {
      if (Object.hasOwn(patch, col) && patch[col] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(col === 'last_seq' ? Number(patch[col]) : patch[col]);
      }
    }
    if (!sets.length) return formatWorker(existing);
    sets.push('updated_at = ?');
    params.push(nowIso(), id, workerName);
    let where = 'swarm_id = ? AND name = ?';
    if (expectedState !== undefined) { where += ' AND state = ?'; params.push(expectedState); }
    if (expectedRun !== undefined) { where += ' AND run_id IS ?'; params.push(expectedRun); }
    if (!conn.run(`UPDATE roster SET ${sets.join(', ')} WHERE ${where}`, ...params).changes) return null;
    return formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, workerName));
  }), db);
}

export async function killWorkerRecord(swarmId, name, { error = null, ...options } = {}) {
  return updateWorker(swarmId, name, { state: 'killed', parked_on: null, desired_runtime: null, error }, options);
}

export async function cleanKilledWorkspace(swarmId, killed, clean, { sessionsDir } = {}) {
  // A worker name can be reused while the interrupt is in flight. Hold the
  // roster write lock until this run's directory and its pointer are retired.
  return withDb(sessionsDir, (conn) => conn.transaction(() => {
    const worker = conn.get("SELECT * FROM roster WHERE swarm_id = ? AND name = ? AND state = 'killed' AND run_id = ? AND worktree_path = ?",
      swarmId, killed.name, killed.run_id, killed.worktree_path);
    if (!worker || !clean(worker)) return false;
    conn.run('UPDATE roster SET worktree_path = NULL, updated_at = ? WHERE swarm_id = ? AND name = ?', nowIso(), swarmId, killed.name);
    return true;
  }));
}

export async function getWorker(swarmId, name, { sessionsDir, db } = {}) {
  const id = validateSwarmId(swarmId);
  const workerName = name === 'coordinator' ? name : validateWorkerName(name);
  return withDb(sessionsDir, (conn) =>
    formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, workerName)), db);
}

export async function listRoster(swarmId, { includeKilled = true, includeCoordinator = false, sessionsDir, db } = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(sessionsDir, async (conn) => {
    const sql = includeKilled
      ? 'SELECT * FROM roster WHERE swarm_id = ? ORDER BY created_at ASC, name ASC'
      : "SELECT * FROM roster WHERE swarm_id = ? AND state != 'killed' ORDER BY created_at ASC, name ASC";
    const roster = conn.all(sql, id).filter((row) => includeCoordinator || row.name !== 'coordinator').map(formatWorker);
    const options = { sessionsDir: sessionsDir || dirname(conn.filePath) };
    for (const [index, worker] of roster.entries()) {
      worker.board_capable = false;
      if (!worker.run_id) continue;
      let record;
      try { record = readRun(worker.run_id, options.sessionsDir, { readonly: true }); }
      catch (error) {
        if (error.status === 400 || error.status === 404) continue;
        throw error;
      }
      if (record.swarm_id && record.swarm_id !== id || record.swarm_agent && record.swarm_agent !== worker.name) continue;
      if (record.remote_turn_unconfirmed) {
        record = await refreshRun(record, options);
        Object.assign(worker, formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, worker.name)));
      }
      worker.implicit ||= record.implicit_swarm_worker === true;
      worker.board_capable = !worker.implicit && runBoardTelemetry(record).board_capable;
      if (!['working', 'waiting_reply'].includes(worker.state) || ACTIVE_STATES.has(record.state) || pidAlive(record.pid)) continue;
      const next = record.state === 'finished' ? 'waiting' : 'stopped';
      const updated = await updateWorker(id, worker.name, { state: next, parked_on: null, error: record.error || null },
        { db: conn, expectedState: worker.state, expectedRun: worker.run_id });
      if (updated) roster[index] = { ...worker, ...updated, implicit: worker.implicit };
    }
    return roster;
  }, db);
}

export async function listSwarms({ hostConversationId, cwd, limit = 20, sessionsDir, db } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 20));
  return withDb(sessionsDir, (conn) => {
    let rows;
    if (hostConversationId) {
      rows = conn.all(
        'SELECT * FROM swarms WHERE host_conversation_id = ? ORDER BY updated_at DESC LIMIT ?',
        String(hostConversationId).trim(),
        max,
      );
    } else {
      rows = conn.all('SELECT * FROM swarms ORDER BY updated_at DESC LIMIT ?', max);
    }
    const cwdKey = normalizeCwdKey(cwd);
    if (cwdKey) {
      rows = rows.filter((row) => normalizeCwdKey(row.cwd) === cwdKey);
    }
    return rows.map(formatSwarm);
  }, db);
}

const rateDatabases = new Set();
const resetPending = new Set();

export function resetRateLimiter() {
  for (const path of rateDatabases) resetPending.add(path);
}

function recordPost(conn, id, sender) {
  const path = conn.get('PRAGMA database_list').file;
  rateDatabases.add(path);
  if (resetPending.delete(path)) conn.run('DELETE FROM post_window');
  const now = Date.now();
  conn.run('DELETE FROM post_window WHERE posted_ms <= ?', now - 60_000);
  const { n } = conn.get('SELECT COUNT(*) AS n FROM post_window WHERE swarm_id = ? AND agent = ?', id, sender);
  if (n >= 60) throw Object.assign(new Error('Rate limit exceeded (60 posts a minute).'), { status: 429 });
  conn.run('INSERT INTO post_window VALUES (?, ?, ?)', id, sender, now);
}

function registryInDb(conn, id, throughSeq) {
  const sql = 'SELECT seq, from_agent, control_json FROM messages WHERE swarm_id = ? AND control_json IS NOT NULL';
  const controls = throughSeq === undefined ? conn.all(sql + ' ORDER BY seq', id)
    : conn.all(sql + ' AND seq <= ? ORDER BY seq', id, throughSeq);
  return channelRegistry(controls.map((r) => ({ agent: r.from_agent, control: safeJsonParse(r.control_json, null) })));
}

function requireActive(registry, channel) {
  const entry = registry.find((r) => r.name === channel);
  if (!entry || entry.archived) throw Object.assign(new Error(`Unknown or archived channel '#${channel}'.`), { status: 400 });
  return entry;
}

function withWarnings(message, registry) {
  const warnings = message.channel_mentions.flatMap((name) => {
    const entry = registry.find((r) => r.name === name);
    return entry && !entry.archived ? [] : [`@#${name} addressed nobody (${entry ? 'archived' : 'unknown'} channel)`];
  });
  if (warnings.length) message.warnings = warnings;
  return message;
}

function appendMessage(conn, id, {
  from = 'coordinator', kind = 'message', text, mentions, screenshots, replyToSeq = null,
  meta = null, channel = MAIN, control = null, requestId = null,
}, { skipRateLimit = false } = {}) {
  if (requestId != null) {
    const existing = conn.get('SELECT * FROM messages WHERE swarm_id = ? AND request_id = ?', id, requestId);
    if (existing) {
      const message = formatMessage(existing);
      return withWarnings(message, message.channel_mentions.length ? registryInDb(conn, id, message.seq) : []);
    }
  }
  const body = String(text ?? '').trim();
  if (!body) throw new Error('Board message text must be non-empty.');
  const sender = String(from || 'coordinator').trim().toLowerCase();
  if (conn.get('SELECT role FROM roster WHERE swarm_id = ? AND name = ?', id, sender)?.role === 'narrator') {
    throw new Error('Narrator is read-only except for publishing the view.');
  }
  if (channel == null || channel === '') channel = MAIN;
  const addressed = channelMentions(body);
  if (addressed.includes(MAIN)) throw Object.assign(new Error('@#main is everyone; write @all'), { status: 400 });
  const registry = addressed.length || channel !== MAIN ? registryInDb(conn, id) : [];
  if (channel !== MAIN && !control) requireActive(registry, validateChannelName(channel));
  const allMentions = new Set(parseMentions(body));
  for (const m of Array.isArray(mentions) ? mentions : []) {
    const name = String(m || '').trim().toLowerCase().replace(/^@/, '');
    if (name) allMentions.add(name);
  }
  const shots = parseScreenshots(body);
  for (const shot of Array.isArray(screenshots) ? screenshots : []) {
    if (typeof shot?.path !== 'string' || !shot.path.trim()) continue;
    const path = shot.path.trim(), caption = String(shot.caption || '').trim();
    if (!shots.some((s) => s.path === path && s.caption === caption)) shots.push({ path, caption });
  }
  if (!skipRateLimit) recordPost(conn, id, sender);
  const now = nowIso();
  const res = conn.run(`INSERT INTO messages
    (swarm_id, from_agent, kind, text, mentions_json, screenshots_json, reply_to_seq, meta_json,
     created_at, channel, control_json, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, sender, String(kind || 'message'), body, JSON.stringify([...allMentions]), JSON.stringify(shots),
    replyToSeq, meta == null ? null : JSON.stringify(meta), now, channel, control && JSON.stringify(control), requestId);
  conn.run('UPDATE swarms SET updated_at = ? WHERE id = ?', now, id);
  return withWarnings(formatMessage(conn.get('SELECT * FROM messages WHERE seq = ?', res.lastInsertRowid)), registry);
}

export async function withLiveNarrator(swarmId, name, publish, { sessionsDir, workerTurn } = {}) {
  return withDb(sessionsDir, (conn) => conn.transaction(() => {
    const member = conn.get('SELECT role, run_id, state FROM roster WHERE swarm_id = ? AND name = ?', swarmId, name);
    if (member?.role !== 'narrator' || member.state === 'killed') throw new Error('Only a live narrator can publish a view.');
    if (workerTurn) requireWorkerTurn(member, workerTurn);
    return publish();
  }));
}

function requireWorkerTurn(worker, turn) {
  if (!worker || worker.run_id !== turn.runId || !['working', 'waiting_reply'].includes(worker.state)) {
    throw new Error('Worker run is no longer current.');
  }
}

function checkWorkerTurn(conn, id, turn) {
  if (turn) requireWorkerTurn(conn.get('SELECT run_id, state FROM roster WHERE swarm_id = ? AND name = ?', id, turn.name), turn);
}

// Keep the identity check and its write under the same SQLite write lock.
function withWorkerTurn(conn, id, turn, write) {
  if (!turn) return write();
  return conn.transaction(() => {
    checkWorkerTurn(conn, id, turn);
    return write();
  });
}

export async function postBoardMessage(swarmId, input = {}, options = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(options.sessionsDir, (conn) => conn.transaction(() => {
    ensureSwarmInDb(conn, { ...options, swarmId: id });
    checkWorkerTurn(conn, id, options.workerTurn);
    const message = appendMessage(conn, id, { ...input, control: null, requestId: input.requestId ?? options.requestId }, options);
    if (options.parkForReply) {
      conn.run("UPDATE roster SET state = 'waiting_reply', parked_on = ?, updated_at = ? WHERE swarm_id = ? AND name = ?",
        message.meta?.call_id ?? 'board_ask:' + message.seq, nowIso(), id, message.from_agent);
    }
    return message;
  }), options.db);
}

function changeChannel(swarmId, options, prepare) {
  const id = validateSwarmId(swarmId);
  return withDb(options.sessionsDir, (conn) => conn.transaction(() => {
    ensureSwarmInDb(conn, { ...options, swarmId: id });
    checkWorkerTurn(conn, id, options.workerTurn);
    const { actor, text, control } = prepare(conn, id, registryInDb(conn, id));
    return appendMessage(conn, id, { from: actor, kind: 'system', text, control }, { skipRateLimit: true });
  }), options.db);
}

export async function createChannel(id, { actor = 'coordinator', channel, topic = '' }, options = {}) {
  validateChannelName(channel);
  validateTopic(topic);
  return changeChannel(id, options, (_conn, _id, registry) => {
    if (registry.some((r) => r.name === channel)) throw Object.assign(new Error(`Channel #${channel} already exists.`), { status: 409 });
    return { actor, text: `[channel] ${actor} created #${channel}${topic ? ': ' + topic : ''}`,
      control: { op: 'create', channel, topic } };
  });
}

export async function archiveChannel(id, { actor = 'coordinator', channel }, options = {}) {
  return changeChannel(id, options, (_conn, _id, registry) => {
    const entry = requireActive(registry, validateChannelName(channel));
    if (actor !== 'coordinator' && entry.created_by !== actor) throw new Error(`Only coordinator or creator may archive #${channel}.`);
    return { actor, text: `[channel] ${actor} archived #${channel}`, control: { op: 'archive', channel } };
  });
}

export async function subscribeChannels(id, { actor = 'coordinator', op, channel, targets = [actor] }, options = {}) {
  if (!['subscribe', 'unsubscribe'].includes(op)) throw new Error('Invalid subscription operation.');
  if (!Array.isArray(targets) || !targets.length) throw new Error('Subscription targets must be a nonempty list.');
  return changeChannel(id, options, (conn, swarmId, registry) => {
    if (channel !== ALL) requireActive(registry, validateChannelName(channel));
    const members = [...new Set(targets)];
    const prev = Object.create(null), next = Object.create(null);
    for (const name of members) {
      const worker = formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', swarmId, name));
      if (!worker || worker.state === 'killed') throw new Error(`Unknown live member '${name}'.`);
      if (actor !== 'coordinator' && name !== actor && worker.added_by !== actor) throw new Error(`Cannot manage '${name}'.`);
      prev[name] = worker.channels;
      const set = effectiveChannels(worker.role, worker.channels, name);
      if (set.includes(ALL) && channel !== ALL) throw new Error(`Unsubscribe '${name}' from * first.`);
      next[name] = op === 'unsubscribe' ? set.filter((c) => c !== channel)
        : channel === ALL ? [ALL] : [...new Set([...set, channel])];
      conn.run('UPDATE roster SET channels_json = ? WHERE swarm_id = ? AND name = ?', JSON.stringify(next[name]), swarmId, name);
    }
    return { actor, text: `[channel] ${actor} ${op}d ${members.join(', ')} ${op === 'subscribe' ? 'to' : 'from'} #${channel}`,
      control: { op, channel, members, prev, next } };
  });
}

function channelMembers(registry, roster) {
  return registry.map((entry) => ({ ...entry, members: roster.filter((w) => {
    const set = effectiveChannels(w.role, w.channels, w.name);
    return w.state !== 'killed' && (set.includes(ALL) || set.includes(entry.name));
  }).map((w) => w.name) }));
}

export async function listChannels(swarmId, { db, sessionsDir } = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(sessionsDir, (conn) => channelMembers(registryInDb(conn, id),
    conn.all('SELECT * FROM roster WHERE swarm_id = ? ORDER BY name', id).map(formatWorker)), db);
}

function advanceRead(conn, id, viewer, seq) {
  conn.run('UPDATE roster SET last_read_seq = MAX(last_read_seq, ?) WHERE swarm_id = ? AND name = ?', seq, id, viewer);
}

export async function markRead(swarmId, name, seq, { db, sessionsDir } = {}) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid read sequence.');
  return withDb(sessionsDir, (conn) => advanceRead(conn, validateSwarmId(swarmId), name, seq), db);
}

export async function parkWorker(swarmId, name, { since, mentionsOnly = true, channel, db, sessionsDir, workerTurn } = {}) {
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('Pass the highest sequence actually read as since.');
  return updateWorker(swarmId, name, { wake_mode: mentionsOnly ? 'mentions' : 'anything', wait_since: since,
    parked_on: channel ? 'board_wait:' + channel : 'board_wait' }, { db, sessionsDir, workerTurn });
}

export async function readBoardMessages(swarmId, {
  since, seqs, limit = 20, channel, viewer, includeControl = true, sessionsDir, db, workerTurn,
} = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(sessionsDir, (conn) => {
    const args = [id], conditions = ['swarm_id = ?'];
    const worker = viewer && formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, viewer));
    const exact = Array.isArray(seqs);
    const max = limit === Infinity ? Infinity : Math.max(1, Math.min(500, Number(limit) || 20));
    const after = since == null ? null : Math.max(0, Math.trunc(Number(since) || 0));
    if (channel && channel !== ALL) { conditions.push('channel = ?'); args.push(channel); }
    if (after !== null && !exact) { conditions.push('seq > ?'); args.push(after); }
    // Historical membership needs the contiguous suffix through the head, including its controls.
    const history = worker && !channel;
    if (!history && !includeControl) conditions.push('control_json IS NULL');
    if (exact && !history) {
      const wanted = seqs.filter(Number.isSafeInteger);
      if (!wanted.length) return [];
      conditions.push('seq IN (' + wanted.map(() => '?').join(',') + ')');
      args.push(...wanted);
    }
    const descending = !history && !exact && after === null;
    let sql = 'SELECT * FROM messages WHERE ' + conditions.join(' AND ') + ' ORDER BY seq ' + (descending ? 'DESC' : 'ASC');
    if (!history && !exact && max !== Infinity) { sql += ' LIMIT ?'; args.push(max); }
    let rows = conn.all(sql, ...args).map(formatMessage);
    if (descending) rows.reverse();
    if (history) {
      const { visible } = memberView(viewer, worker.role, worker.channels, rows, registryInDb(conn, id));
      const wanted = exact && new Set(seqs);
      rows = rows.filter((m, i) => visible[i] && (includeControl || countsUnread(m)) && (!wanted || wanted.has(m.seq)));
      if (!exact && max < Infinity) rows = after === null ? rows.slice(-max) : rows.slice(0, max);
    }
    if (worker && !channel && rows.length) withWorkerTurn(conn, id, workerTurn, () => advanceRead(conn, id, viewer, rows.at(-1).seq));
    return rows;
  }, db);
}

export async function readWorkerTurnPosts(swarmId, workerName, { runId, startedAt, sessionsDir } = {}) {
  const start = Date.parse(startedAt);
  return withDb(sessionsDir, (conn) => conn.all(`SELECT * FROM messages
    WHERE swarm_id = ? AND from_agent = ? AND (json_extract(meta_json, '$.run_id') = ? OR created_at >= ?)
    ORDER BY seq`, validateSwarmId(swarmId), validateWorkerName(workerName), runId ?? null,
  Number.isFinite(start) ? new Date(start).toISOString() : null).map(formatMessage).filter((msg) =>
    msg.meta?.run_id && runId ? msg.meta.run_id === runId : Date.parse(msg.created_at) >= start));
}

export async function getBoardHead(swarmId, { sessionsDir, db } = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(sessionsDir, (conn) => {
    const row = conn.get('SELECT COALESCE(MAX(seq), 0) AS head FROM messages WHERE swarm_id = ?', id);
    return Number(row?.head ?? 0);
  }, db);
}

export function mentionMatchesAgent(mentions, agentName) {
  if (!Array.isArray(mentions) || !agentName) return false;
  const target = String(agentName).toLowerCase();
  const prefix = target.match(/^(.+)-\d+$/)?.[1];
  return mentions.some((m) => m === target || m === 'all' || m === prefix);
}

export async function listUndeliveredForWorker(swarmId, workerName, { since = 0, channel, includeDelivered = false, sessionsDir, db } = {}) {
  const id = validateSwarmId(swarmId);
  const target = validateWorkerName(workerName);
  return withDb(sessionsDir, (conn) => conn.transaction(() => {
    const worker = formatWorker(conn.get('SELECT * FROM roster WHERE swarm_id = ? AND name = ?', id, target));
    if (!worker || worker.state === 'killed') return [];
    if (worker.quota_paused_seq) {
      const { head } = conn.get('SELECT MAX(seq) AS head FROM messages WHERE swarm_id = ?', id);
      if (head <= worker.quota_paused_seq) return [];
      conn.run('UPDATE roster SET quota_paused_seq = 0 WHERE swarm_id = ? AND name = ?', id, target);
    }
    const after = Math.max(0, Number(since) || 0, worker.last_read_seq, worker.wait_since);
    const rows = conn.all(`SELECT m.*, d.seq AS delivered FROM messages m
      LEFT JOIN deliveries d ON d.seq = m.seq AND d.target_agent = ?
      WHERE m.swarm_id = ? AND m.seq > ? ORDER BY m.seq`, target, id, after);
    const messages = rows.map(formatMessage);
    const sets = channelsAt(target, worker.channels, messages);
    const active = activeAt(registryInDb(conn, id), messages);
    const filter = channel || (worker.parked_on?.startsWith('board_wait:') ? worker.parked_on.slice(11) : null);
    return messages.filter((m, i) => {
      if ((!includeDelivered && rows[i].delivered) || !countsUnread(m) || m.from_agent === target || (filter && filter !== ALL && m.channel !== filter)) return false;
      const set = effectiveChannels(worker.role, sets[i], target);
      if (mentionMatchesAgent(m.mentions, target)) return true;
      return worker.wake_mode === 'anything' ? seesIn(target, set, m, active[i]) : mentionsIn(m.text, target, set, active[i]);
    });
  }), db);
}

export const QUOTA_ERROR = /RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit/i;

export function computeMentionEdges(messages, roster, channels) {
  const edges = new Map();
  const active = activeAt(channels, messages);
  const participants = roster.some((w) => w.name === 'coordinator') ? roster : [{ name: 'coordinator', role: 'coordinator' }, ...roster];
  const observers = new Set(roster.filter((w) => ['narrator', 'monitor'].includes(w.role) || ROLE_WORKER_RE.test(w.name)).map((w) => w.name));
  for (const w of participants) {
    if (observers.has(w.name)) continue;
    const sets = channelsAt(w.name, w.channels, messages);
    messages.forEach((m, i) => {
      const from = m.from_agent ?? m.agent;
      if (!countsUnread(m) || observers.has(from) || from === w.name) return;
      const { mentions, all } = mentionsOf(m.text, [w.name]);
      const direct = mentions.length || mentionMatchesAgent((m.mentions || []).filter((n) => n !== 'all'), w.name);
      const set = effectiveChannels(w.role, sets[i], w.name);
      const viaChannel = (m.channel_mentions || channelMentions(m.text)).some((c) =>
        c !== MAIN && active[i]?.(c) && (set.includes(c) || set.includes(ALL)));
      const field = direct ? 'direct' : viaChannel ? 'viaChannel' : all || m.mentions?.includes('all') ? 'viaAll' : null;
      if (!field) return;
      const key = JSON.stringify([from, w.name]);
      const edge = edges.get(key) || { from, to: w.name, count: 0, direct: 0, viaAll: 0, viaChannel: 0 };
      edge[field]++;
      edge.count++;
      edges.set(key, edge);
    });
  }
  return [...edges.values()];
}

export function detectSystemAttention(swarm, roster, messages, channels, nowMs = Date.now()) {
  const items = [];
  const live = roster.filter((w) => w.state !== 'killed' && w.name !== 'coordinator');
  const ordinary = live.filter((w) => !['monitor', 'narrator'].includes(w.role) && !ROLE_WORKER_RE.test(w.name));
  const posts = messages.filter(countsUnread);
  const sender = (m) => m?.from_agent ?? m?.agent;
  for (const w of live) {
    let kind, text;
    if (w.quota_paused_seq > 0 || QUOTA_ERROR.test(w.error || '')) {
      kind = 'quota'; text = w.error || `Quota paused at #${w.quota_paused_seq}.`;
    } else if (w.state === 'stopped' && w.error) {
      kind = 'error'; text = w.error;
    } else if (w.state === 'working') {
      const last = posts.findLast((m) => sender(m) === w.name);
      const activity = Math.max(Date.parse(w.updated_at || w.created_at || swarm?.created_at) || 0,
        Date.parse(last?.created_at || last?.time) || 0);
      if (activity && nowMs - activity > 600_000) {
        kind = 'stuck'; text = 'Working without a board or state update for over 10 minutes.';
      }
    }
    if (kind) items.push({ kind, agent: w.name, text });
  }
  if (ordinary.length && ordinary.every((w) => ['waiting', 'stopped'].includes(w.state))) {
    const last = posts.at(-1);
    if (sender(last) !== 'coordinator' || !/\[done\]/i.test(last.text)) {
      const member = ordinary.find((w) => {
        const sets = channelsAt(w.name, w.channels, messages);
        const active = activeAt(channels, messages);
        const lastPost = posts.findLast((m) => sender(m) === w.name)?.seq || 0;
        return messages.some((m, i) => countsUnread(m) && m.seq > lastPost && sender(m) !== w.name &&
          mentionsIn(m.text, w.name, effectiveChannels(w.role, sets[i], w.name), active[i]));
      });
      const coordinatorSeq = posts.findLast((m) => sender(m) === 'coordinator')?.seq || 0;
      const result = posts.findLast((m) => m.seq > coordinatorSeq && sender(m) !== 'coordinator'
        && !(m.mentions || parseMentions(m.text)).length && !channelMentions(m.text).length);
      const text = member ? `Unanswered mention for @${member.name} while all workers are parked.`
        : result ? `Result #${result.seq} has no addressee and all workers are parked.`
        : 'All workers are parked before the coordinator marked the task [done].';
      items.push({ kind: 'stall', agent: member?.name || sender(result) || 'coordinator', text });
    }
  }
  return items;
}

export async function markDelivered(swarmId, seqs, targetAgent, { sessionsDir, db } = {}) {
  const id = validateSwarmId(swarmId);
  const target = String(targetAgent || '').trim().toLowerCase();
  if (!target) throw new Error('targetAgent is required.');
  const list = [...new Set((Array.isArray(seqs) ? seqs : [seqs]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return 0;
  return withDb(sessionsDir, (conn) => conn.transaction(() => {
    const now = nowIso();
    let count = 0;
    let maxSeq = 0;
    for (const seq of list) {
      const res = conn.run(
        'INSERT OR IGNORE INTO deliveries (seq, swarm_id, target_agent, delivered_at) VALUES (?, ?, ?, ?)',
        seq,
        id,
        target,
        now,
      );
      count += res.changes;
      if (seq > maxSeq) maxSeq = seq;
    }
    if (maxSeq > 0) {
      conn.run(
        'UPDATE roster SET last_seq = MAX(COALESCE(last_seq, 0), ?), last_nudged_seq = MAX(last_nudged_seq, ?), updated_at = ? WHERE swarm_id = ? AND name = ?',
        maxSeq, maxSeq,
        now,
        id,
        target,
      );
    }
    return count;
  }), db);
}

export async function getSwarmOverview(swarmId, { messageLimit = 20, analytics = false, includeCoordinator = false, sessionsDir, db, checkScope } = {}) {
  const id = validateSwarmId(swarmId);
  return withDb(sessionsDir, async (conn) => {
    const swarm = formatSwarm(conn.get('SELECT * FROM swarms WHERE id = ?', id));
    if (!swarm) return null;
    checkScope?.(swarm);
    const roster = await listRoster(id, { includeKilled: true, includeCoordinator, db: conn });
    const head = await getBoardHead(id, { db: conn });
    const recent_messages = messageLimit > 0 ? await readBoardMessages(id, { limit: messageLimit, db: conn }) : [];
    if (!analytics) return { swarm, roster, head, recent_messages };
    const messages = await readBoardMessages(id, { limit: Infinity, db: conn });
    const channels = channelMembers(channelRegistry(messages), roster);
    const enriched = roster.map((w) => {
      const posts = messages.filter((m) => m.seq > w.tail_from_seq && countsUnread(m) && m.from_agent === w.name);
      return { ...w, channels: effectiveChannels(w.role, w.channels, w.name), posts: posts.length,
        unread: visibleUnread(w.name, w.role, w.channels, messages, w.last_read_seq, channels),
        last_post_seq: posts.at(-1)?.seq || 0, last_post_time: posts.at(-1)?.created_at || null };
    });
    return { swarm, roster: enriched, head, recent_messages, channels,
      edges: computeMentionEdges(messages, roster, channels), system_attention: detectSystemAttention(swarm, roster, messages, channels) };
  }, db);
}

// Board rows come from one SQLite transaction. Run journals and narrator
// files are projected separately and cannot change the board cursor.
function collectSnapshot(conn, { swarmId, conversationId, scope, inScope = () => true }) {
  const swarms = conn.all('SELECT * FROM swarms ORDER BY updated_at DESC, id').map(formatSwarm).filter(inScope);
  const owned = (swarm) => conversationId && swarm.host_conversation_id === conversationId;
  const memberNames = new Map(conversationId ? conn.all(
    "SELECT swarm_id, name FROM roster WHERE session_id = ? AND state != 'killed' ORDER BY name DESC", conversationId)
    .map(({ swarm_id, name }) => [swarm_id, name]) : []);
  const membership = (swarm) => memberNames.get(swarm.id);
  const visible = scope === 'session' ? swarms.filter((swarm) => owned(swarm) || membership(swarm)) : swarms;
  const chosen = swarmId ? visible.find((swarm) => swarm.id === swarmId)
    : visible.find(owned) || visible.find(membership) || (scope === 'all' ? visible[0] : null);
  if (!chosen) return { swarms: visible, forbidden: !!swarmId && swarms.every((swarm) => swarm.id !== swarmId)
    && !!conn.get('SELECT 1 FROM swarms WHERE id = ?', swarmId) };
  const roster = conn.all('SELECT * FROM roster WHERE swarm_id = ? ORDER BY name', chosen.id).map(formatWorker);
  const messages = conn.all('SELECT * FROM messages WHERE swarm_id = ? ORDER BY seq', chosen.id).map(formatMessage);
  const channels = channelMembers(channelRegistry(messages), roster);
  const self = owned(chosen) ? 'coordinator' : membership(chosen) || null;
  const member = roster.find((worker) => worker.name === self);
  const visibility = member && memberView(self, member.role, member.channels, messages, channels).visible;
  const members = roster.map((worker) => {
    const posts = messages.filter((message) => message.from_agent === worker.name && message.seq > worker.tail_from_seq && countsUnread(message));
    return { ...worker, posts: posts.length, last_post_seq: posts.at(-1)?.seq || 0,
      last_post_time: posts.at(-1)?.created_at || null,
      unread: visibleUnread(worker.name, worker.role, worker.channels, messages, worker.last_read_seq, channels) };
  });
  return { swarm: chosen, swarms: visible, self, members, messages, channels,
    head: messages.at(-1)?.seq || 0,
    unseen: visibility ? messages.filter((_, index) => !visibility[index]).map(({ seq }) => seq) : [],
    edges: computeMentionEdges(messages, roster, channels),
    attention: detectSystemAttention(chosen, roster, messages, channels) };
}
export async function readSwarmSnapshot({ sessionsDir, ...options } = {}) {
  return withDb(sessionsDir, (conn) => conn.transaction(() => collectSnapshot(conn, options)));
}

// Persist both the daemon transition and its message together so process
// takeover cannot count or lose an unpublished stall alert.
export function commitMonitorTick(db, swarmId, decide) {
  const id = validateSwarmId(swarmId);
  return db.transaction(() => {
    if (!db.get("SELECT 1 FROM roster WHERE swarm_id = ? AND role = 'monitor' AND state != 'killed' LIMIT 1", id)) return null;
    const snapshot = collectSnapshot(db, { swarmId: id, scope: 'all' });
    const prior = safeJsonParse(db.get('SELECT state FROM swarm_monitor_ticks WHERE swarm_id = ?', id)?.state, {});
    const { state, alert } = decide(snapshot, prior);
    if (state !== prior) db.run('INSERT INTO swarm_monitor_ticks VALUES (?, ?) ON CONFLICT(swarm_id) DO UPDATE SET state=excluded.state',
      id, JSON.stringify(state));
    if (!alert) return null;
    const { from, target, detail, refs, kind } = alert;
    return appendMessage(db, id, { from, kind: 'message', text: `@${target} [stall] ${detail} ${refs.map((seq) => '#' + seq).join(' ')}`.trim(),
      meta: { monitor_stall: kind } }, { skipRateLimit: true });
  });
}

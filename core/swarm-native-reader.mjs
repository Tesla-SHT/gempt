import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { antigravityApplicationData, readCoordinatorActivity } from './live-service.mjs';
import { channelMentions, channelRegistry, controlOf, effectiveChannels, memberView, ROLE_WORKER_RE } from './swarm-channels.mjs';
import { parseScreenshots } from './swarm-bus.mjs';
import { withinPath } from './state.mjs';

const CONVERSATION_ID = /^[0-9a-f-]{8,128}$/i;
const VIEW_LIMIT = 64 * 1024;
const goodViews = new Map();
const rosterScans = new Map();
const swarmDir = (brain, id) => join(brain, id, '.system_generated', 'swarm');

function rosterOwners(brain) {
  const now = Date.now();
  const cached = rosterScans.get(brain);
  if (cached && now - cached.time < 3000) return cached.ids;
  const ids = readdirSync(brain).filter((id) => CONVERSATION_ID.test(id) &&
    existsSync(join(swarmDir(brain, id), 'members.json'))).sort();
  rosterScans.delete(brain);
  rosterScans.set(brain, { time: now, ids });
  if (rosterScans.size > 16) rosterScans.delete(rosterScans.keys().next().value);
  return ids;
}

function readText(path, maxBytes = Infinity) {
  const boundary = dirname(path);
  let fd;
  try {
    const canonical = realpathSync(path);
    if (!withinPath(canonical, boundary)) return null;
    fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    if (process.platform === 'linux') {
      if (!withinPath(realpathSync('/proc/self/fd/' + fd), boundary)) return null;
    } else {
      const openedPath = realpathSync(path);
      if (!withinPath(openedPath, boundary)) return null;
      const current = statSync(openedPath);
      if (current.dev !== stat.dev || current.ino !== stat.ino) return null;
    }
    let text;
    if (maxBytes === Infinity) text = readFileSync(fd, 'utf8');
    else {
      const data = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < data.length) {
        const length = readSync(fd, data, size, data.length - size, null);
        if (!length) break;
        size += length;
      }
      if (size !== stat.size) return null;
      text = data.toString('utf8', 0, size);
    }
    return { text, mtime: stat.mtimeMs, revision: [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseObject(text) {
  try { return object(JSON.parse(text)); }
  catch { return null; }
}

function roleOf(name, member) {
  const role = member.role;
  if (typeof role === 'string' && role && role !== 'worker') return role;
  return ROLE_WORKER_RE.test(name) ? name.split('-')[0] : 'worker';
}

function boardRows(raw, members) {
  const rows = new Map();
  for (const line of raw.split('\n')) {
    const row = parseObject(line);
    if (!Number.isSafeInteger(row?.seq) || row.seq < 1) continue;
    const agent = String(row.agent ?? '');
    const body = String(row.text ?? '');
    const control = controlOf(row);
    const ts = Date.parse(String(row.time || '').replace(' ', 'T'));
    const screenshots = !control && members.get(agent)?.role === 'worker'
      ? parseScreenshots(body, { absoluteImagesOnly: true }).map(({ path, caption }) => ({ path, caption: caption.slice(0, 80) }))
      : [];
    rows.set(row.seq, {
      seq: row.seq, from_agent: agent, text: body, control, screenshots,
      channel: row.channel || 'main', mentions: [], channel_mentions: control ? [] : channelMentions(body),
      created_at: Number.isFinite(ts) ? new Date(ts).toISOString() : '',
      kind: row.kind || 'message', reply_to_seq: row.reply_to_seq || null,
      request_id: row.request_id || null, origin: 'native', cli: 'antigravity',
      conversationId: members.get(agent)?.conversationId ?? null,
    });
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

// The native sidecar first checks the conversation's own roster, then looks
// for its conversation_id in the rosters under brain/. The host's explicit
// app-data override wins over the sidecar's inferred app-data directory.
export function readNativeSwarm(conversationId, { env = process.env, appData } = {}) {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) return null;
  const data = env.GEMPT_AGY_APP_DATA_DIR || env.ANTIGRAVITY_APP_DATA_DIR || appData
    || antigravityApplicationData(env) || join(homedir(), '.gemini', 'antigravity');
  let brain;
  const rosterAt = (id) => {
    const dir = swarmDir(brain, id);
    const file = readText(join(dir, 'members.json'));
    const roster = parseObject(file?.text);
    return object(roster?.members) ? { id, dir, file, roster } : null;
  };
  let hit;
  try {
    brain = realpathSync(join(data, 'brain'));
    hit = rosterAt(conversationId);
    if (!hit) {
      for (const id of rosterOwners(brain)) {
        if (id === conversationId) continue;
        const candidate = rosterAt(id);
        if (candidate && Object.values(candidate.roster.members).some((m) => m?.conversation_id === conversationId)) {
          hit = candidate;
          break;
        }
      }
    }
  } catch { return null; }
  if (!hit) return null;
  const { id, dir, file, roster } = hit;
  const transcriptEnv = { ANTIGRAVITY_EXECUTABLE_DATA_DIR: data };
  const memberRows = Object.entries(roster.members).flatMap(([name, row]) => {
    if (!object(row)) return [];
    const role = roleOf(name, row);
    const conv = row.conversation_id || (role === 'coordinator' ? id : null);
    const activity = typeof conv === 'string' && CONVERSATION_ID.test(conv)
      ? readCoordinatorActivity(conv, transcriptEnv) : null;
    const parked = ['mentions', 'anything'].includes(row.wake_mode);
    const state = row.killed ? 'killed' : activity?.state || row.state || row.status || (parked ? 'waiting' : 'working');
    return [{ ...activity, name, role, state, status: state, killed: state === 'killed',
      origin: 'native', cli: 'antigravity', model: row.model || '', conversationId: conv,
      conversation_id: conv, run_id: null, channels: effectiveChannels(role, row.channels, name),
      roleWorker: !['coordinator', 'worker'].includes(role), narrator: role === 'narrator',
      wake_mode: row.wake_mode, wait_since: Number(row.wait_since) || 0, last_read_seq: Number(row.last_read_seq) || 0 }];
  }).sort((a, b) => Number(b.role === 'coordinator') - Number(a.role === 'coordinator') || a.name.localeCompare(b.name));
  const board = readText(join(dir, 'board.jsonl'));
  const messages = boardRows(board?.text || '', new Map(memberRows.map((m) => [m.name, m])));
  const channels = channelRegistry(messages).map((channel) => ({ ...channel, members: memberRows.filter((m) =>
    !m.killed && (m.channels.includes('*') || m.channels.includes(channel.name))).map((m) => m.name) }));
  const head = messages.at(-1)?.seq || 0;
  const self = memberRows.find((m) => m.conversationId === conversationId)?.name || null;
  const unseen = [];
  const members = memberRows.map((m) => {
    const { visible, unread } = memberView(m.name, m.role, m.channels, messages, channels);
    const posts = messages.filter((msg) => msg.from_agent === m.name && !msg.control);
    if (m.name === self) messages.forEach((msg, i) => { if (!visible[i]) unseen.push(msg.seq); });
    return { ...m, isSelf: m.name === self, unread: channels.length ? messages.filter((msg, i) =>
      msg.seq > m.last_read_seq && unread[i]).length : Math.max(0, head - m.last_read_seq),
      posts: posts.length, last_post_seq: posts.at(-1)?.seq || 0, last_post_time: posts.at(-1)?.created_at || '' };
  });
  const attention = members.flatMap((m) => {
    if (m.roleWorker || m.killed) return [];
    const kind = m.state === 'stopped' ? 'error' : m.state === 'working' && m.transcriptMtime &&
      Date.now() - m.transcriptMtime > 600_000 ? 'stuck' : null;
    return kind ? [{ kind, agent: m.name, origin: 'native', conversationId: m.conversationId,
      text: kind === 'error' ? 'Last native step failed.' : 'Native conversation has had no progress for over 10 minutes.' }] : [];
  });
  const narratorRank = (m) => Number(m.name.match(/-(\d+)$/)?.[1]) || 1;
  const lead = members.filter((m) => m.narrator).sort((a, b) =>
    Number(a.killed) - Number(b.killed) || narratorRank(b) - narratorRank(a))[0];
  const narratorState = !lead ? 'absent' : lead.state === 'stopped' ? 'paused' : lead.state;
  const narrator = lead ? { ...lead, state: narratorState } : null;

  let viewDir = dir;
  let viewFile = readText(join(dir, 'view.json'), VIEW_LIMIT);
  if (!viewFile && CONVERSATION_ID.test(narrator?.conversationId ?? '')) {
    const alternative = join(brain, narrator.conversationId, 'swarm_view');
    const alternativeFile = readText(join(alternative, 'view.json'), VIEW_LIMIT);
    if (alternativeFile) { viewDir = alternative; viewFile = alternativeFile; }
  }
  const html = readText(join(viewDir, 'view.html'), VIEW_LIMIT);
  const parsed = parseObject(viewFile?.text);
  const prior = goodViews.get(viewDir);
  goodViews.delete(viewDir);
  const good = parsed ? { json: parsed, mtime: viewFile.mtime } : viewFile ? prior : null;
  if (good) {
    goodViews.set(viewDir, good);
    if (goodViews.size > 64) goodViews.delete(goodViews.keys().next().value);
  }
  const json = good?.json ?? null;
  const view = { exists: Boolean(viewFile || html), origin: 'native', json, html: html?.text || null,
    jsonMtime: good?.mtime || 0, jsonError: viewFile && !parsed ? 'invalid_json' : '' };
  const planFile = readText(join(dir, 'plan.json'), VIEW_LIMIT);
  const plan = parseObject(planFile?.text);
  const posted = new Map();
  for (const msg of messages) {
    for (const shot of msg.screenshots) {
      posted.delete(shot.path);
      posted.set(shot.path, { ...shot, seq: msg.seq, agent: msg.from_agent, time: msg.created_at });
    }
  }
  const postedFrames = [...posted.values()].slice(-24);
  const narratorFrames = Array.isArray(json?.reel?.frames) ? json.reel.frames.filter((frame) =>
    typeof frame?.path === 'string' && /\.(png|jpe?g|webp)$/i.test(frame.path)).slice(0, 40)
    .map(({ path, caption, seq }) => ({ path, caption: String(caption || '').slice(0, 200), seq: Number(seq) || 0 })) : [];
  return {
    id, brain, self, head, title: typeof roster.title === 'string' ? roster.title : '', members, messages, channels, unseen,
    view, narrator, narratorState, plan, attention, postedFrames, narratorFrames,
    frames: narratorFrames.length ? narratorFrames : postedFrames,
    rawRevision: [file, board, planFile, viewFile, html].map((entry) => entry?.revision),
    updatedAt: new Date(Math.max(file.mtime, board?.mtime || 0, viewFile?.mtime || 0, html?.mtime || 0,
      planFile?.mtime || 0)).toISOString(),
    raw: { members: file.text, board: board?.text || '', plan: planFile?.text || '', view: viewFile?.text || '', html: html?.text || '' },
  };
}

import { existsSync } from 'node:fs';
import { readCoordinatorActivity } from './live-service.mjs';
import { commitMonitorTick, listSwarms, mentionMatchesAgent, openSwarmDb, resolveSwarmDbPath } from './swarm-bus.mjs';
import { activeAt, channelsAt, effectiveChannels, mentionsIn } from './swarm-channels.mjs';

export const MONITOR_INTERVAL_MS = 3 * 60_000;
const parked = new Set(['waiting', 'stopped', 'waiting_reply']);
const isResult = (post) => ['summary', 'handoff'].includes(post.kind) || /\[done\]|\[handoff\]/i.test(post.text);

function cycleOf(edges) {
  const visit = (node, path) => {
    if (path.includes(node)) return [...path.slice(path.indexOf(node)), node];
    for (const edge of edges.get(node) ?? []) {
      const cycle = visit(edge.target, [...path, node]);
      if (cycle) return cycle;
    }
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return null;
}

export function detectMonitorStall({ members, messages, channels }) {
  const team = members.filter(({ role, state }) => !['monitor', 'narrator'].includes(role) && state !== 'killed');
  const lead = team.find(({ role }) => role === 'coordinator');
  if (!lead || team.length < 2 || team.some(({ state }) => !parked.has(state))) return null;
  const posts = messages.filter((post) => !post.control && !['brief', 'system'].includes(post.kind) &&
    !post.meta?.monitor_stall && !members.some((m) => ['monitor', 'narrator'].includes(m.role) && m.name === post.from_agent));
  const lastBy = new Map(posts.map((post) => [post.from_agent, post.seq]));
  const attention = (kind, target, refs, detail) => ({ kind, target, refs, detail });
  const lost = posts.findLast((m) => m.seq > lead.last_read_seq && m.from_agent !== lead.name && isResult(m)
    && !m.mentions.length && !m.channel_mentions.length);
  if (lost) return attention('unaddressed', lead.name, [lost.seq], `Result #${lost.seq} had no addressee.`);
  const unread = posts.findLast((m) => m.seq > lead.last_read_seq && m.from_agent !== lead.name &&
    (mentionMatchesAgent(m.mentions, lead.name) || (!m.mentions.length && !m.channel_mentions.length && m.channel === 'main')));
  if (unread) return attention('coordinator_unread', lead.name, [unread.seq], `The coordinator has unread post #${unread.seq}.`);
  const graph = new Map();
  const at = activeAt(channels, messages);
  const indexBySeq = new Map(messages.map(({ seq }, index) => [seq, index]));
  for (const member of team.filter(({ name }) => name !== lead.name)) {
    const sets = channelsAt(member.name, member.channels, messages);
    for (const post of posts) {
      const i = indexBySeq.get(post.seq);
      if (post.from_agent === member.name || post.seq <= (member.tail_from_seq || 0) ||
          post.mentions.includes('all') ||
          !(mentionMatchesAgent(post.mentions, member.name) || mentionsIn(post.text, member.name,
            effectiveChannels(member.role, sets[i], member.name), at[i]))) continue;
      const edges = graph.get(post.from_agent) || [];
      edges.push({ target: member.name, post });
      graph.set(post.from_agent, edges);
    }
  }
  for (const channel of channels.filter((entry) => !entry.archived && entry.name !== 'main')) {
    const scoped = new Map([...graph].map(([sender, edges]) => [sender, edges.filter(({ post }) => post.channel === channel.name && post.seq === lastBy.get(sender))]));
    const cycle = cycleOf(scoped);
    if (cycle) {
      const refs = cycle.slice(0, -1).map((name, index) => scoped.get(name).find((edge) => edge.target === cycle[index + 1]).post.seq);
      return attention('channel_deadlock', lead.name, refs, `Members in #${channel.name} are waiting on each other (${cycle.join(' → ')}).`);
    }
  }
  const dependencies = new Map([...graph].map(([sender, edges]) => [sender, edges.filter(({ post }) => post.seq === lastBy.get(sender))]));
  const cycle = cycleOf(dependencies);
  if (cycle) {
    const refs = cycle.slice(0, -1).map((name, index) => dependencies.get(name).find((edge) => edge.target === cycle[index + 1]).post.seq);
    return attention('waiting_chain', lead.name, refs, `Members are waiting on each other (${cycle.join(' → ')}).`);
  }
  const edge = [...graph.values()].flat().filter(({ target, post }) => post.seq > (lastBy.get(target) || 0)).sort((a, b) => b.post.seq - a.post.seq)[0];
  if (edge) return attention('unanswered_mention', edge.target, [edge.post.seq], `Post #${edge.post.seq} is for you.`);
  return attention('parked', lead.name, [], 'All task members are parked before the coordinator marked the task done.');
}

// Pure transition function, with one clock input for deterministic fixtures.
export function runMonitorTick(snapshot, previous = {}, now = Date.now()) {
  const monitors = snapshot.members.filter(({ role, state }) => role === 'monitor' && state !== 'killed').sort((a, b) => a.name.localeCompare(b.name));
  const monitor = monitors[0];
  if (!monitor) return { state: previous, alert: null };
  const prior = previous.monitor === monitor.name ? previous : {};
  const teamPosts = snapshot.messages.filter((post) => post.from_agent !== monitor.name);
  const newest = teamPosts.at(-1)?.seq || 0;
  const resume = teamPosts.some((post) => post.seq > (prior.head || 0) && /\bresume\b/i.test(post.text)
    && mentionMatchesAgent(post.mentions.filter((name) => name !== 'all'), monitor.name));
  if (prior.lastTick != null && now - prior.lastTick < MONITOR_INTERVAL_MS && !resume && !prior.dormant) {
    return { state: prior, alert: null };
  }
  if (prior.dormant && newest <= prior.head && !resume) return { state: prior, alert: null };
  const done = teamPosts.findLast((post) => post.from_agent === 'coordinator' && /^\s*\[done\]/i.test(post.text));
  const hasWorker = snapshot.members.some(({ role, state }) => role === 'worker' && state !== 'killed');
  const current = { ...prior, monitor: monitor.name, head: newest, lastTick: now };
  if (!hasWorker || (done && done.seq === newest && !resume)) return { state: { ...current, dormant: true }, alert: null };
  const fingerprint = JSON.stringify(snapshot.members.filter(({ role }) => role !== 'monitor').map(({ name, state }) => [name, state]));
  const changed = resume || newest !== prior.head || fingerprint !== prior.fingerprint;
  const idleTicks = changed || snapshot.members.some(({ role, state }) => role !== 'monitor' && state === 'working') ? 0 : (prior.idleTicks || 0) + 1;
  const candidate = detectMonitorStall(snapshot);
  const key = candidate ? JSON.stringify(candidate) : '';
  const same = key === prior.key && !resume;
  const count = same ? prior.count || 0 : 0;
  const elapsed = same ? (prior.elapsed || 0) + 1 : 3;
  const send = candidate && count < 3 && (changed || elapsed >= 3);
  const dormant = idleTicks >= 5 && (!candidate || (count >= 3 && !send));
  const state = { ...current, fingerprint, idleTicks, key, count: send ? count + 1 : count,
    elapsed: send ? 0 : elapsed, dormant };
  const alert = send ? { ...candidate, from: monitor.name,
    ...(candidate.kind === 'unanswered_mention' && count ? {
      target: 'coordinator', detail: `${candidate.target} has not answered #${candidate.refs[0]} after a reminder.`,
    } : {}) } : null;
  return { state, alert };
}

export async function sweepSwarmMonitors(options, now = Date.now()) {
  const { sessionsDir, dispatchAlert, swarmId } = options;
  if (!sessionsDir || !existsSync(resolveSwarmDbPath(sessionsDir))) return [];
  const swarms = swarmId ? [{ id: swarmId }] : await listSwarms({ sessionsDir, limit: 200 });
  const db = await openSwarmDb(sessionsDir);
  const alerts = [];
  try {
    for (const { id } of swarms) {
      const post = commitMonitorTick(db, id, (snapshot, prior) => {
        const coordinator = snapshot.members.find(({ role }) => role === 'coordinator');
        const activity = readCoordinatorActivity(snapshot.swarm.host_conversation_id, options.env);
        if (coordinator && activity) coordinator.state = activity.state;
        return runMonitorTick(snapshot, prior, now);
      });
      if (!post) continue;
      alerts.push(post);
      await dispatchAlert?.(id);
    }
  } finally { db.close(); }
  return alerts;
}

export function startSwarmMonitor(options) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweepSwarmMonitors(options); }
    catch (error) { console.error('[gempt swarm monitor]', error.message); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), MONITOR_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

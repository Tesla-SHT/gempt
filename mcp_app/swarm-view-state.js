export const BOARD_WINDOW = 200;

export function boardGroup(previous, message) {
  const gap = Date.parse(message.created_at) - Date.parse(previous?.created_at);
  return Boolean(previous && !previous.control && !message.control
    && previous.from_agent === message.from_agent && previous.channel === message.channel
    && gap >= 0 && gap <= 10 * 60_000);
}

export function unreadBoundary(messages, self, unseen = []) {
  if (!self?.name) return null;
  const hidden = new Set(unseen);
  return messages.find(({ seq, from_agent, control }) =>
    !control && seq > (self.last_read_seq || 0) && from_agent !== self.name && !hidden.has(seq))?.seq ?? null;
}

export function memberGroups(members) {
  const groups = { active: [], waiting: [], killed: [] };
  const sorted = [...members].sort((a, b) =>
    Number(b.role === "coordinator") - Number(a.role === "coordinator") || a.name.localeCompare(b.name));
  for (const member of sorted) {
    const state = member.state || member.status;
    groups[member.killed || state === "killed" ? "killed" :
      ["working", "waiting_reply"].includes(state) ? "active" : "waiting"].push(member);
  }
  return groups;
}

export function normalizeMessage(message) {
  return { ...message, channel: message.channel ?? "main", from_agent: message.from_agent ?? message.agent,
    created_at: message.created_at ?? message.time };
}

export function snapshotQuery({ swarmId, scope, cursor }) {
  return { ...(swarmId && { swarm_id: swarmId }), scope, omitRaw: 1, tail: 1,
    ...(cursor && { etag: cursor.etag, since: cursor.head, known: cursor.known,
      rosterKey: cursor.rosterKey, viewKey: cursor.viewKey ?? "" }) };
}

export function historyQuery(swarmId, cursor, first, fromSeq) {
  return { swarm_id: swarmId, rosterKey: cursor.rosterKey, before: cursor.offset,
    beforeSeq: first, limit: BOARD_WINDOW, ...(fromSeq != null && { fromSeq }) };
}

export function selectBoardRows(messages, limit, focusSeq) {
  if (focusSeq == null) return messages.slice(-limit);
  const index = messages.findIndex(({ seq }) => seq === focusSeq);
  if (index < 0) return messages.slice(-limit);
  const start = Math.max(0, Math.min(index - Math.floor(limit / 2), messages.length - limit));
  return messages.slice(start, start + limit);
}

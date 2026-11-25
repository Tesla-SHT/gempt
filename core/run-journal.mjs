import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export function visitJournal(fd, size, offset, visit) {
  let position = offset;
  const chunk = Buffer.alloc(64 * 1024);
  let parts = [];
  let skipping = false;
  // GemPT writes method first. Check the short JSON prefix before allocating
  // or decoding a full diff from older, potentially large journals.
  const isDiff = (value) => /^\s*\{\s*"method"\s*:\s*"turn\/diff\/updated"/.test(value.toString('utf8', 0, 128));
  while (position < size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
    if (!count) break;
    let start = 0;
    for (let end = chunk.indexOf(10, start); end >= 0 && end < count; end = chunk.indexOf(10, start)) {
      const last = chunk.subarray(start, end);
      if (!skipping && (parts.length || !isDiff(last))) {
        try {
          const raw = JSON.parse((parts.length ? Buffer.concat([...parts, last]) : last).toString('utf8'));
          if (raw && raw.method !== 'turn/diff/updated') visit(raw);
        } catch { /* Incomplete or invalid JSON. */ }
      }
      offset = position + end + 1;
      start = end + 1;
      parts = [];
      skipping = false;
    }
    if (start < count && !skipping) {
      const tail = chunk.subarray(start, count);
      skipping = !parts.length && isDiff(tail);
      if (!skipping) parts.push(Buffer.from(tail));
    }
    position += count;
  }
  return offset;
}

export function turnEvidence(file, threadId, turnId) {
  const messages = new Map();
  let terminal;
  let usage;
  let fd;
  try {
    fd = openSync(file, 'r');
    visitJournal(fd, fstatSync(fd).size, 0, ({ method, params, runUsage }) => {
      if ((threadId && params?.threadId !== threadId) || (params?.turnId ?? params?.turn?.id) !== turnId) return;
      if (method === 'turn/completed' && params.turn?.id === turnId) terminal = params.turn;
      if (method === 'thread/tokenUsage/updated' && runUsage) usage = runUsage;
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        messages.set(params.item.id, params.item.text);
      } else if (method === 'item/agentMessage/delta') {
        messages.set(params.itemId, (messages.get(params.itemId) || '') + params.delta);
      }
    });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { terminal, text: [...messages.values()].filter(Boolean).join('\n\n'), usage };
}

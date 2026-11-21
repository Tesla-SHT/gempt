import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_JOURNAL_BYTES = 768 * 1024;
const MAX_ITEMS = 80;
const clip = (value, length = 2400) => typeof value === 'string' ? value.slice(0, length) : '';
const array = (value) => Array.isArray(value) ? value : [];

function readJournal(path) {
  let fd;
  try {
    if (!lstatSync(dirname(path)).isDirectory() || !lstatSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - MAX_JOURNAL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
      if (!read) break;
      bytes += read;
    }
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    if (start) lines.shift();
    if (lines.at(-1)?.trim()) {
      // A journal being appended to can end in half an event.
      try { JSON.parse(lines.at(-1)); } catch { lines.pop(); }
    }
    return { lines, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function normalizeEvents(lines, request) {
  const items = new Map();
  const callIds = new Map();
  const upsert = (type, id, fields) => {
    const key = `${type}:${id}`;
    const item = items.get(key) ?? { type, id };
    if (!items.has(key)) items.set(key, item);
    return Object.assign(item, fields);
  };
  const reasoning = (id, index, text, append) => {
    if (!text || typeof text !== 'string') return;
    const item = upsert('reasoning', `${id}:${index}`);
    item.text = clip(`${append ? item.text || '' : ''}${text}`);
  };
  const ask = (id, args, status) => {
    const item = upsert('ask_gemini', id, { status });
    if (args && typeof args === 'object') {
      item.arguments = { question: clip(args.question), context: clip(args.context),
        reason: clip(args.reason, 100), media_paths: array(args.media_paths).slice(0, 8).map((p) => clip(p, 400)) };
    }
    return item;
  };
  const recordItem = (item, completed) => {
    const id = clip(item?.id, 200);
    if (!id) return;
    switch (item.type) {
      case 'reasoning':
        (typeof item.summary === 'string' ? [item.summary] : array(item.summary))
          .slice(0, 20).forEach((text, index) => reasoning(id, index, text, false));
        break;
      case 'agentMessage': {
        const message = upsert('agent_message', id);
        if (item.phase) message.phase = clip(item.phase, 32);
        if (typeof item.text === 'string' && (completed || item.text || !message.text)) message.text = clip(item.text);
        break;
      }
      case 'commandExecution': {
        const command = upsert('command', id);
        command.command = clip(item.command, 1200) || command.command || '';
        if (Number.isInteger(item.exitCode)) command.exit_code = item.exitCode;
        if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) command.output = item.aggregatedOutput.slice(-2400);
        break;
      }
      case 'fileChange': {
        const changes = array(item.changes);
        upsert('files', id, { count: changes.length, paths: changes.slice(0, 25)
          .map((change) => clip(change?.path, 600)).filter(Boolean) });
        break;
      }
      case 'dynamicToolCall':
        if (item.tool === 'ask_gemini') {
          const call = ask(clip(item.callId, 200) || id, item.arguments,
            clip(item.status, 32) || (completed ? 'completed' : 'pending'));
          const result = array(item.contentItems).map((entry) => clip(entry?.text)).filter(Boolean).join('\n');
          if (result) call.result = clip(result);
        }
        break;
    }
  };
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const params = event?.params ?? {};
    const thread = params.threadId ?? params.conversationId;
    const turn = params.turnId ?? params.turn?.id;
    if ((thread && request.codex_thread_id && thread !== request.codex_thread_id)
      || (turn && request.turn_id && turn !== request.turn_id)) continue;
    const itemId = clip(params.itemId, 200);
    switch (event?.method) {
      case 'item/started':
      case 'item/completed':
        recordItem(params.item, event.method === 'item/completed');
        break;
      case 'turn/completed':
        for (const item of array(params.turn?.items)) recordItem(item, true);
        break;
      case 'item/agentMessage/delta':
        if (itemId && typeof params.delta === 'string') {
          const item = upsert('agent_message', itemId);
          item.text = clip((item.text ?? '') + params.delta);
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (itemId) reasoning(itemId, Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0, params.delta, true);
        break;
      case 'item/commandExecution/outputDelta':
        if (itemId && typeof params.delta === 'string') {
          const item = upsert('command', itemId);
          item.output = ((item.output ?? '') + params.delta).slice(-2400);
        }
        break;
      case 'item/tool/call':
        if (params.tool === 'ask_gemini' && typeof params.callId === 'string') {
          const id = clip(params.callId, 200);
          ask(id, params.arguments, 'pending');
          if (event.id != null) callIds.set(event.id, id);
        }
        break;
      case 'serverRequest/resolved': {
        const id = callIds.get(params.requestId);
        if (id) ask(id, null, 'resolved');
        break;
      }
    }
  }
  const rows = [...items.values()].filter((item) => item.type !== 'agent_message' || item.text);
  const messages = rows.filter((item) => item.type === 'agent_message');
  if (!request.active && messages.length && !messages.some((item) => item.phase === 'final_answer')) {
    const last = messages.at(-1);
    if (!last.phase) last.phase = 'final_answer';
  }
  return rows;
}

export function readActivityTimeline(path, request, budget) {
  const journal = readJournal(path);
  if (!journal) return { timeline: [], timeline_truncated: false, bytes: 0 };
  const rows = normalizeEvents(journal.lines, request);
  const timeline = [];
  let bytes = 0;
  for (const row of rows.slice(-MAX_ITEMS).reverse()) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > budget) continue;
    timeline.push(row);
    bytes += size;
  }
  return { timeline: timeline.reverse(), timeline_truncated: journal.truncated || timeline.length < rows.length, bytes };
}

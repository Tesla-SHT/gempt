import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

const app = new App({ name: "GemPT Live", version: "1.0.0" }, {});
const active = new Set(["queued", "running", "waiting_gemini"]);
const statuses = {
  queued: "排队中", running: "运行中", waiting_gemini: "等待回复", finished: "已完成",
  failed: "失败", interrupted: "已中止", outcome_unknown: "状态未确认",
};
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const number = new Intl.NumberFormat("zh-CN");
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const put = (id, value) => {
  const el = $(id);
  if (el && el.textContent !== value) el.textContent = value;
};
const statusLabel = (run) => statuses[run?.state] || "未知";
const basename = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");

let ready = false;
let supportsTools = false;
let runs = [];
let selected = null;
let viewMode = "list"; // "list" | "detail"
let selection = 0;
let snapshot = null;
let transcript = { text: "", complete: false };
let fullGoal = null;
let goalLoading = null;
let boundConversation = null;
let listLoaded = false;
let listVersion = 0;
let listTimer, streamTimer;
let readingList = false;
let listWanted = false;
let readingStream = false;
let streamWanted = false;
let control = null;
let confirming = false;
const hostStyleKeys = new Set();
const openSteps = new Set();

function applyHost(context) {
  applyDocumentTheme(context?.theme ?? (systemTheme.matches ? "dark" : "light"));
  const variables = context?.styles?.variables ?? {};
  for (const key of hostStyleKeys) {
    if (!(key in variables)) document.documentElement.style.removeProperty(key);
  }
  hostStyleKeys.clear();
  for (const key of Object.keys(variables)) hostStyleKeys.add(key);
  applyHostStyleVariables(variables);
}

function notify(message = "", error = false) {
  for (const id of ["notice", "notice-list"]) {
    const el = $(id);
    if (!el) continue;
    el.hidden = !message;
    el.dataset.error = String(error);
    el.textContent = message;
  }
}

async function call(name, args) {
  const result = await app.callServerTool({ name, arguments: args }, { timeout: 15_000 });
  if (result.isError || !result.structuredContent) {
    throw new Error(result.content?.find((item) => item.type === "text")?.text || "GemPT 暂无可用数据");
  }
  return result.structuredContent;
}

const currentRun = () => snapshot?.run ?? runs.find((run) => run.run_id === selected);
const isActive = () => active.has(currentRun()?.state);
const canFetch = () => ready && supportsTools && !document.hidden;

function formatElapsed(seconds) {
  if (seconds == null) return "";
  const elapsed = Math.max(0, Math.floor(seconds));
  return elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

/* Group runs strictly belonging to this conversation by session_id (1 card per GPT session). */
function groupSessions(runList) {
  const bySession = new Map();
  for (const run of runList) {
    const key = run.session_id || run.run_id;
    let group = bySession.get(key);
    if (!group) {
      group = { key, session_id: run.session_id || "", runs: [], latest: run };
      bySession.set(key, group);
    }
    group.runs.push(run);
  }
  const groups = [...bySession.values()].map((g) => {
    // Chronological turns (oldest -> newest) for turn pills; latest is active or most recent.
    const chrono = [...g.runs].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
    const latest = g.runs.find((r) => active.has(r.state)) || chrono[chrono.length - 1] || g.latest;
    return { ...g, runs: chrono, latest };
  });
  groups.sort((a, b) => {
    const aAct = active.has(a.latest.state) ? 1 : 0;
    const bAct = active.has(b.latest.state) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    return (b.latest.started_at || 0) - (a.latest.started_at || 0);
  });
  return groups;
}

/* Safe DOM-only Markdown renderer (zero innerHTML, 100% CSP-safe). */
function appendInline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) parent.append(node("code", token.slice(1, -1)));
    else parent.append(node("strong", token.slice(2, -2)));
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function renderMarkdown(raw) {
  const root = node("div", "", "md");
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = node("pre");
      pre.append(node("code", codeLines.join("\n")));
      root.append(pre);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const h = node("h" + Math.min(4, heading[1].length));
      appendInline(h, heading[2]);
      root.append(h);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = node("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = node("li");
        appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ""));
        ul.append(li);
        i++;
      }
      root.append(ul);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = node("ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = node("li");
        appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
        ol.append(li);
        i++;
      }
      root.append(ol);
      continue;
    }
    if (line.startsWith(">")) {
      const bq = node("blockquote");
      const parts = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        parts.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      appendInline(bq, parts.join("\n"));
      root.append(bq);
      continue;
    }
    const para = [];
    while (
      i < lines.length && lines[i].trim()
      && !lines[i].trim().startsWith("```")
      && !/^(#{1,4})\s+/.test(lines[i])
      && !/^\s*[-*]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !lines[i].startsWith(">")
    ) {
      para.push(lines[i]);
      i++;
    }
    const p = node("p");
    appendInline(p, para.join("\n"));
    root.append(p);
  }
  return root;
}

const fileResult = z.object({ isError: z.boolean().optional() }).passthrough();
function makeFileChip(path, uri) {
  const label = basename(path);
  if (!uri) {
    const span = node("span", label, "file-chip");
    span.title = path;
    return span;
  }
  const btn = node("button", label, "file-chip");
  btn.type = "button";
  btn.title = path;
  btn.addEventListener("click", async () => {
    try {
      await app.request({
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri },
      }, fileResult, { timeout: 3000 });
    } catch { /* Graceful fallback on hosts without fileView. */ }
  });
  return btn;
}

function openSessionDetail(runId) {
  if (!runId) return;
  viewMode = "detail";
  if (runId !== selected) {
    selected = runId;
    selection++;
    snapshot = null;
    transcript = { text: "", complete: false };
    fullGoal = null;
    goalLoading = null;
    confirming = false;
    openSteps.clear();
    $("steer").value = "";
    $("control-status").hidden = true;
    put("control-status", "");
    $("meta-drawer").hidden = true;
    $("info-toggle").setAttribute("aria-expanded", "false");
    notify();
  }
  render();
  void refreshStream();
}

function backToList() {
  viewMode = "list";
  confirming = false;
  $("meta-drawer").hidden = true;
  $("info-toggle").setAttribute("aria-expanded", "false");
  notify();
  render();
  scheduleStream();
}

function buildStatusGlyph(state) {
  const wrap = node("span", "", "sc-glyph");
  wrap.dataset.state = state || "";
  if (state === "finished") {
    wrap.textContent = "✓";
  } else if (state === "failed" || state === "interrupted") {
    wrap.textContent = "×";
  } else {
    const dot = node("span", "", "status-dot");
    dot.dataset.state = state || "";
    wrap.append(dot);
  }
  return wrap;
}

function sessionPreview(run) {
  if (run.state === "waiting_gemini" && run.pending_tool_call?.arguments?.question) {
    return { text: `等待回复：${run.pending_tool_call.arguments.question}`, cls: "sc-preview is-ask" };
  }
  if (run.error && (run.state === "failed" || run.state === "interrupted")) {
    return { text: run.error.replace(/\s+/g, " ").trim(), cls: "sc-preview is-err" };
  }
  if (active.has(run.state) && run.last_command) {
    return { text: `$ ${run.last_command.replace(/\s+/g, " ").trim()}`, cls: "sc-preview is-cmd" };
  }
  if (run.last_message) {
    return { text: run.last_message.replace(/\s+/g, " ").trim(), cls: "sc-preview" };
  }
  if (run.goal) {
    return { text: run.goal.replace(/\s+/g, " ").trim(), cls: "sc-preview" };
  }
  return { text: statusLabel(run), cls: "sc-preview" };
}

function renderList() {
  const sessions = groupSessions(runs);
  const countEl = $("session-count");
  countEl.hidden = !sessions.length;
  countEl.textContent = number.format(sessions.length);
  $("refresh-list").disabled = !supportsTools;

  const hasSessions = sessions.length > 0;
  $("list-wrap").hidden = !hasSessions;
  $("empty").hidden = hasSessions;
  if (!hasSessions) {
    put("empty-message", !ready ? "正在连接 GemPT…" : !listLoaded && supportsTools ? "正在读取当前对话的 GPT 会话…" : "当前对话暂无 GPT 会话");
    return;
  }

  const list = $("session-cards");
  const key = JSON.stringify(sessions.map((s) => [
    s.key, s.runs.length, s.latest.run_id, s.latest.state, s.latest.title,
    s.latest.elapsed_sec, s.latest.last_command, s.latest.last_message,
    s.latest.pending_tool_call?.arguments?.question,
  ]));
  if (list.dataset.key === key) return;
  list.dataset.key = key;

  list.replaceChildren(...sessions.map((sess) => {
    const run = sess.latest;
    const li = node("li");
    const card = node("button", "", "session-card");
    card.type = "button";
    card.dataset.state = run.state || "";

    const top = node("div", "", "sc-top");
    const title = (run.title || run.goal || run.session_id || run.run_id).replace(/\s+/g, " ").trim();
    const titleEl = node("span", title, "sc-title");
    titleEl.title = title;

    const metaParts = [];
    if (sess.runs.length > 1) metaParts.push(`${sess.runs.length} 轮`);
    if (run.state === "waiting_gemini") metaParts.push("等待回复");
    else if (active.has(run.state)) metaParts.push(formatElapsed(run.elapsed_sec) || "运行中");
    else metaParts.push(formatElapsed(run.elapsed_sec) || statusLabel(run));
    const metaEl = node("span", metaParts.join(" · "), "sc-meta");
    metaEl.dataset.state = run.state || "";

    top.append(buildStatusGlyph(run.state), titleEl, metaEl, node("span", "›", "sc-chevron"));

    const prev = sessionPreview(run);
    const prevEl = node("p", prev.text, prev.cls);
    prevEl.title = prev.text;

    card.append(top, prevEl);
    card.addEventListener("click", () => openSessionDetail(run.run_id));
    li.append(card);
    return li;
  }));
}

function buildStepDetails(key, iconChar, tone, titleText, metaText, bodyText, { muted = false, prose = false, failed = false } = {}) {
  const det = node("details", "", "step-row");
  det.dataset.stepKey = key;
  if (openSteps.has(key)) det.open = true;
  det.addEventListener("toggle", () => {
    if (det.open) openSteps.add(key);
    else openSteps.delete(key);
  });
  const sum = node("summary");
  const ic = node("span", iconChar, "step-icon");
  if (tone) ic.dataset.tone = tone;
  const title = node("span", titleText, muted ? "step-title is-muted" : "step-title");
  sum.append(ic, title);
  if (metaText) {
    const meta = node("span", metaText, "step-meta");
    if (failed) meta.dataset.failed = "true";
    sum.append(meta);
  }
  det.append(sum);
  if (bodyText) {
    det.append(node("pre", bodyText, prose ? "step-body is-prose" : "step-body"));
  }
  return det;
}

function renderTurnStrip(run) {
  const strip = $("turn-strip");
  if (!run) { strip.hidden = true; return; }
  const sessKey = run.session_id || run.run_id;
  const group = groupSessions(runs).find((g) => g.key === sessKey);
  const turns = group && group.runs.length >= 2 ? group.runs : [];
  strip.hidden = !turns.length;
  if (!turns.length) return;
  const key = JSON.stringify([selected, turns.map((t) => [t.run_id, t.state])]);
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  strip.replaceChildren(...turns.map((turn, idx) => {
    const btn = node("button", "", "turn-pill");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(turn.run_id === selected));
    const dot = node("span", "", "status-dot");
    dot.dataset.state = turn.state || "";
    btn.append(dot, node("span", `第 ${idx + 1} 轮`));
    btn.addEventListener("click", () => openSessionDetail(turn.run_id));
    return btn;
  }));
}

function renderStream() {
  const wrap = $("feed-wrap");
  const list = $("stream");
  const run = currentRun();
  const follow = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 48;
  const events = snapshot?.timeline || [];
  const fileUris = snapshot?.file_uris || {};
  const hasAgentMsg = events.some((e) => e.type === "agent_message" && e.text);
  const fullText = transcript.text || "";

  const renderKey = JSON.stringify([
    selected, run?.state, events.length,
    events.map((e) => [e.type, e.id, e.exit_code, e.text?.length || 0, e.output?.length || 0, e.paths?.length || 0]),
    hasAgentMsg ? "" : fullText.length, transcript.complete,
  ]);
  if (list.dataset.key === renderKey) return;
  list.dataset.key = renderKey;

  const nodes = [];
  let lastMsgIdx = -1;
  events.forEach((ev, idx) => {
    if (ev.type === "agent_message" && ev.text) lastMsgIdx = idx;
  });

  const pendingAsk = run?.state === "waiting_gemini" ? run.pending_tool_call : null;
  events.forEach((ev, idx) => {
    const li = node("li");
    const stepKey = ev.id || `${ev.type}-${idx}`;
    if (ev.type === "reasoning") {
      const preview = String(ev.text || "").replace(/\s+/g, " ").trim().slice(0, 72) || "思考中…";
      li.append(buildStepDetails(stepKey, "·", "", `思考：${preview}`, "", ev.text || "", { muted: true, prose: true }));
    } else if (ev.type === "command") {
      const running = ev.exit_code == null;
      const ok = ev.exit_code === 0;
      const icon = running ? "◌" : ok ? "✓" : "✗";
      const tone = running ? "run" : ok ? "ok" : "err";
      const meta = running ? "运行中" : `exit ${ev.exit_code}`;
      const body = [ev.command, ev.output].filter(Boolean).join("\n\n");
      li.append(buildStepDetails(stepKey, icon, tone, ev.command || "执行命令", meta, body, { failed: !running && !ok }));
    } else if (ev.type === "files") {
      const paths = ev.paths || [];
      const row = node("div", "", "step-row step-files");
      row.append(node("span", "✎", "step-icon"), node("span", `变更 ${paths.length || ev.count || 0} 个文件`, "step-title is-muted"));
      for (const p of paths) row.append(makeFileChip(p, fileUris[p]));
      li.append(row);
    } else if (ev.type === "ask_gemini") {
      const isPendingDup = pendingAsk && (
        (pendingAsk.call_id && ev.id === pendingAsk.call_id)
        || (pendingAsk.arguments?.question && ev.arguments?.question === pendingAsk.arguments.question)
      );
      if (isPendingDup) return;
      const q = ev.arguments?.question || "等待主 Gemini 回复";
      li.append(buildStepDetails(stepKey, "?", "run", `请求 Gemini：${q}`, ev.arguments?.reason || "", ev.arguments?.context || "", { prose: true }));
    } else if (ev.type === "agent_message" && ev.text) {
      const box = node("div", "", "msg-block");
      if (idx === lastMsgIdx) {
        const head = node("div", "", "msg-head");
        head.append(node("span", "GPT", "msg-role"));
        const copyBtn = node("button", transcript.complete ? "复制" : "补齐中…", "copy-btn");
        copyBtn.type = "button";
        copyBtn.disabled = !transcript.complete;
        copyBtn.addEventListener("click", () => copy(fullText || ev.text));
        head.append(copyBtn);
        box.append(head);
      }
      box.append(renderMarkdown(idx === lastMsgIdx && fullText.length > ev.text.length ? fullText : ev.text));
      li.append(box);
    } else {
      return;
    }
    nodes.push(li);
  });

  if (!hasAgentMsg && fullText) {
    const li = node("li");
    const box = node("div", "", "msg-block");
    const head = node("div", "", "msg-head");
    head.append(node("span", "GPT", "msg-role"));
    const copyBtn = node("button", transcript.complete ? "复制" : "补齐中…", "copy-btn");
    copyBtn.type = "button";
    copyBtn.disabled = !transcript.complete;
    copyBtn.addEventListener("click", () => copy(fullText));
    head.append(copyBtn);
    box.append(head, renderMarkdown(fullText));
    li.append(box);
    nodes.push(li);
  }

  if (isActive() && !pendingAsk) {
    const li = node("li");
    li.append(node("div", "GPT 执行中…", "streaming-indicator"));
    nodes.push(li);
  } else if (!nodes.length && !pendingAsk) {
    const li = node("li");
    li.append(node("div", snapshot ? "暂无输出内容" : "正在加载执行流…", "streaming-indicator"));
    nodes.push(li);
  }

  list.replaceChildren(...nodes);
  if (follow) wrap.scrollTop = wrap.scrollHeight;
}

function renderControls(run = currentRun()) {
  const usable = supportsTools && run?.can_control && !control;
  $("controls").hidden = !active.has(run?.state);
  $("steer").disabled = !usable;
  $("send-steer").disabled = !usable || !$("steer").value.trim();
  $("interrupt").disabled = !usable;
  $("cancel-interrupt").hidden = !confirming;
  put("interrupt", confirming ? "确认中止" : "中止");
}

function renderDetail() {
  const run = currentRun();
  if (!run) {
    viewMode = "list";
    render();
    return;
  }
  const title = (run.title || run.goal || run.session_id || run.run_id).replace(/\s+/g, " ").trim();
  put("detail-title", title);
  $("detail-title").title = title;
  $("dot").dataset.state = run.state || "";
  $("dot").title = statusLabel(run);
  $("info-toggle").disabled = false;
  $("refresh").disabled = !supportsTools;

  renderTurnStrip(run);
  renderControls(run);

  const usage = snapshot?.usage ?? run.usage ?? {};
  const tokens = usage.total_tokens ?? (usage.input_tokens != null ? usage.input_tokens + (usage.output_tokens ?? 0) : null);
  const rate = snapshot?.cache_hit_rate ?? (usage.input_tokens && usage.cached_input_tokens != null
    ? Math.min(1, usage.cached_input_tokens / usage.input_tokens) : null);
  put("badge", statusLabel(run));
  put("model", run.model || "—");
  put("elapsed", formatElapsed(run.elapsed_sec) || "—");
  put("tokens", tokens == null ? "—" : number.format(tokens));
  put("cache", rate == null ? "—" : percent.format(rate));
  put("goal", fullGoal ?? (run.goal || "未记录任务目标"));
  put("workspace", run.worktree_path || run.cwd || "—");
  put("run-id", run.run_id);
  put("session-id", run.session_id || "—");
  $("session-id").disabled = !run.session_id;
  if (run.error) notify(run.error, true);

  const ask = run.state === "waiting_gemini" && run.pending_tool_call?.arguments;
  $("ask").hidden = !ask;
  if (ask) {
    put("ask-reason", ask.reason || "ask_gemini");
    put("ask-question", ask.question || "正在等待回应");
    $("ask-context").hidden = !ask.context;
    put("ask-context", ask.context || "");
    const media = ask.media_paths || [];
    $("ask-media").hidden = !media.length;
    $("ask-media").replaceChildren(...media.map((p) => {
      const li = node("li");
      li.append(makeFileChip(p, snapshot?.file_uris?.[p]));
      return li;
    }));
  }
  renderStream();
}

function render() {
  const showDetail = viewMode === "detail" && Boolean(currentRun());
  $("view-list").hidden = showDetail;
  $("view-detail").hidden = !showDetail;
  if (showDetail) renderDetail();
  else renderList();
}

function acceptSnapshot(data) {
  const previousRevision = snapshot?.text_revision;
  snapshot = data;
  if (data.next_text_offset == null || !transcript.complete || previousRevision !== data.text_revision) {
    transcript = { text: data.full_text, complete: data.next_text_offset == null };
  }
  render();
  if ($("goal-details").open) void loadGoal();
}

async function loadGoal() {
  const generation = selection;
  let offset = snapshot?.next_goal_offset;
  if (offset == null || fullGoal !== null || goalLoading === generation || !canFetch()) return;
  const runId = selected;
  let goal = snapshot.run.goal;
  goalLoading = generation;
  try {
    while (offset != null && generation === selection) {
      const page = await call("gempt_app_stream", { run_id: runId, goal_offset: offset });
      if (generation !== selection) return;
      goal += page.goal;
      offset = page.next_goal_offset;
    }
    if (generation === selection) {
      fullGoal = goal;
      render();
    }
  } catch (error) {
    if (generation === selection) notify(error.message, true);
  } finally {
    if (goalLoading === generation) goalLoading = null;
  }
}

async function loadMoreTranscript(generation, runId, offset, revision) {
  let text = transcript.text;
  try {
    while (offset != null && generation === selection && canFetch()) {
      const page = await call("gempt_app_stream", {
        run_id: runId, text_offset: offset, ...(revision ? { text_revision: revision } : {}),
      });
      if (generation !== selection) return;
      if (page.stale_text_revision) {
        transcript = { text: "", complete: false };
        void refreshStream();
        return;
      }
      text += page.full_text;
      offset = page.next_text_offset;
    }
    if (generation === selection && offset == null) {
      transcript = { text, complete: true };
      render();
    }
  } catch (error) {
    if (generation === selection) notify(error.message, true);
  }
}

function scheduleList() {
  clearTimeout(listTimer);
  if (canFetch()) listTimer = setTimeout(() => void refreshRuns(), 2500);
}

function scheduleStream() {
  clearTimeout(streamTimer);
  if (canFetch() && viewMode === "detail" && selected) {
    streamTimer = setTimeout(() => void refreshStream(), isActive() ? 1000 : 4000);
  }
}

function filterConversationRuns(rawRuns, convId) {
  if (!convId) return [];
  return (rawRuns || []).filter((r) => r.host_conversation_id === convId);
}

function applyRunList(data, { explicitRunId = null } = {}) {
  const nextConversation = data.bound_conversation_id || boundConversation;
  const conversationChanged = Boolean(nextConversation && boundConversation && nextConversation !== boundConversation);
  boundConversation = nextConversation || null;
  listLoaded = true;
  runs = filterConversationRuns(data.runs, boundConversation);

  if (conversationChanged) {
    selected = null;
    snapshot = null;
    viewMode = "list";
  }

  if (explicitRunId && runs.some((r) => r.run_id === explicitRunId)) {
    selected = explicitRunId;
    viewMode = "detail";
  } else if (viewMode === "detail" && selected && !runs.some((r) => r.run_id === selected)) {
    selected = null;
    snapshot = null;
    viewMode = "list";
  }
  render();
}

async function refreshRuns() {
  if (!canFetch()) return;
  if (readingList) { listWanted = true; return; }
  readingList = true;
  listWanted = false;
  clearTimeout(listTimer);
  const version = listVersion;
  try {
    const args = { scope: "session", limit: 50, ...(boundConversation ? { host_conversation_id: boundConversation } : {}) };
    const data = await call("gempt_app_runs", args);
    if (version !== listVersion) return;
    applyRunList(data);
    if (viewMode === "detail" && selected && !snapshot) void refreshStream();
    notify();
  } catch (error) {
    notify(error.message, true);
  } finally {
    readingList = false;
    if (listWanted) void refreshRuns();
    else scheduleList();
  }
}

async function refreshStream() {
  if (!canFetch() || viewMode !== "detail" || !selected) return;
  if (readingStream) { streamWanted = true; return; }
  readingStream = true;
  streamWanted = false;
  clearTimeout(streamTimer);
  const generation = selection;
  const runId = selected;
  try {
    const data = await call("gempt_app_stream", { run_id: runId });
    if (generation !== selection) return;
    acceptSnapshot(data);
    if (data.next_text_offset != null) void loadMoreTranscript(generation, runId, data.next_text_offset, data.text_revision);
    if (!data.run.error) notify();
  } catch (error) {
    if (generation === selection) notify(error.message, true);
  } finally {
    readingStream = false;
    if (streamWanted) void refreshStream();
    else scheduleStream();
  }
}

function setControlStatus(message = "", error = false) {
  $("control-status").hidden = !message;
  $("control-status").dataset.error = String(error);
  put("control-status", message);
}

async function sendControl(name, args, doneMessage) {
  if (!selected || control) return;
  const generation = selection;
  control = name;
  confirming = false;
  renderControls();
  setControlStatus("发送中…");
  try {
    await call(name, args);
    if (generation !== selection) return;
    if (name === "gempt_app_steer") $("steer").value = "";
    setControlStatus(doneMessage);
    void refreshStream();
    void refreshRuns();
  } catch (error) {
    if (generation === selection) setControlStatus(error.message, true);
  } finally {
    control = null;
    renderControls();
  }
}

async function copy(value) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    notify("已复制");
    setTimeout(() => { if ($("notice").textContent === "已复制") notify(); }, 1200);
  } catch {
    notify("当前环境不支持剪贴板复制", true);
  }
}

app.onhostcontextchanged = applyHost;
app.ontoolresult = (result) => {
  const data = result?.structuredContent;
  if (!data) return;
  listVersion++;
  // Only drill directly into Detail when explicitly opened with a specific run_id;
  // otherwise land on the conversation's Subagent Sessions list.
  const explicitId = data.requested_run && data.run_id && data.stream?.run?.run_id === data.run_id ? data.run_id : null;
  if (Array.isArray(data.runs)) applyRunList(data, { explicitRunId: explicitId });
  if (explicitId && data.stream?.run?.host_conversation_id === boundConversation) {
    selected = explicitId;
    viewMode = "detail";
    selection++;
    fullGoal = null;
    goalLoading = null;
    acceptSnapshot(data.stream);
    if (data.stream.next_text_offset != null) {
      void loadMoreTranscript(selection, explicitId, data.stream.next_text_offset, data.stream.text_revision);
    }
    scheduleStream();
  }
  scheduleList();
};

$("back-btn").addEventListener("click", backToList);
$("refresh-list").addEventListener("click", () => void refreshRuns());
$("refresh").addEventListener("click", () => { void refreshRuns(); void refreshStream(); });
$("info-toggle").addEventListener("click", () => {
  const drawer = $("meta-drawer");
  const open = drawer.hidden;
  drawer.hidden = !open;
  $("info-toggle").setAttribute("aria-expanded", String(open));
});
$("goal-details").addEventListener("toggle", () => { if ($("goal-details").open) void loadGoal(); });
$("run-id").addEventListener("click", () => copy($("run-id").textContent));
$("session-id").addEventListener("click", () => copy($("session-id").textContent));
$("steer").addEventListener("input", () => renderControls());
$("steer").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !$("send-steer").disabled) $("send-steer").click();
});
$("send-steer").addEventListener("click", () => {
  const message = $("steer").value.trim();
  if (message) void sendControl("gempt_app_steer", { run_id: selected, message }, "已发送纠偏指令");
});
$("interrupt").addEventListener("click", () => {
  if (!confirming) { confirming = true; renderControls(); return; }
  void sendControl("gempt_app_interrupt", { run_id: selected }, "已请求中止当前回合");
});
$("cancel-interrupt").addEventListener("click", () => { confirming = false; renderControls(); });
systemTheme.addEventListener("change", () => applyHost(app.getHostContext()));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(listTimer); clearTimeout(streamTimer); }
  else { void refreshRuns(); if (viewMode === "detail") void refreshStream(); }
});

render();
app.connect().then(() => {
  ready = true;
  supportsTools = Boolean(app.getHostCapabilities()?.serverTools);
  applyHost(app.getHostContext());
  render();
  if (supportsTools) void refreshRuns();
  else notify("当前宿主未开放实时工具调用。");
}).catch((error) => notify(error.message, true));

import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

const app = new App({ name: "GemPT Live", version: "1.0.0" }, {});
const active = new Set(["queued", "running", "waiting_gemini"]);
const statuses = {
  queued: "排队中", running: "运行中", waiting_gemini: "等待 Gemini", finished: "已完成",
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
let selection = 0;
let snapshot = null;
let transcript = { text: "", complete: false };
let fullGoal = null;
let goalLoading = null;
let scope = "session";
let boundConversation = null;
let boundWorkspace = null;
let sessionCount = null;
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
  $("notice").hidden = !message;
  $("notice").dataset.error = String(error);
  put("notice", message);
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

function renderRunPicker() {
  const displayed = currentRun();
  const options = displayed && !runs.some((run) => run.run_id === displayed.run_id) ? [displayed, ...runs] : runs;
  const key = JSON.stringify(options.map((run) => [run.run_id, run.state, run.title || run.goal]));
  const select = $("runs");
  if (select.dataset.list !== key) {
    const emptyLabel = !ready ? "连接中…" : !listLoaded && supportsTools ? "读取中…"
      : scope === "session" ? "当前会话暂无任务" : "暂无任务";
    const placeholder = new Option(options.length ? "切换任务…" : emptyLabel, "");
    placeholder.disabled = true;
    select.replaceChildren(placeholder, ...options.map((run) => {
      const label = (run.title || run.goal || run.run_id).replace(/\s+/g, " ").trim();
      return new Option(`${statusLabel(run)} · ${label}`, run.run_id);
    }));
    select.dataset.list = key;
  }
  select.disabled = !options.length;
  select.value = selected ?? "";

  const chipsEl = $("run-chips");
  if (chipsEl) {
    const activeRuns = options.filter((run) => active.has(run.state));
    const showChips = activeRuns.length >= 2 || (activeRuns.length >= 1 && options.length >= 2);
    const chipItems = showChips ? options.slice(0, 8) : [];
    const chipKey = JSON.stringify([selected, chipItems.map((r) => [r.run_id, r.state, r.title || r.goal])]);
    chipsEl.hidden = !showChips;
    if (showChips && chipsEl.dataset.key !== chipKey) {
      chipsEl.dataset.key = chipKey;
      chipsEl.replaceChildren(...chipItems.map((run) => {
        const btn = node("button", "", "run-chip");
        btn.type = "button";
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", String(run.run_id === selected));
        btn.dataset.state = run.state || "";
        const label = (run.title || run.goal || run.run_id).replace(/\s+/g, " ").trim();
        btn.title = `${statusLabel(run)} · ${label}`;
        const dot = node("span", "", "status-dot");
        dot.dataset.state = run.state || "";
        btn.append(dot, node("span", label, "run-chip-label"));
        btn.addEventListener("click", () => {
          selectRun(run.run_id);
          void refreshStream();
        });
        return btn;
      }));
    }
  }
}

function selectRun(id) {
  if (id === selected) return;
  selected = id || null;
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
  notify();
  render();
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

function formatElapsed(seconds) {
  if (seconds == null) return "—";
  const elapsed = Math.max(0, Math.floor(seconds));
  return elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

function render() {
  const run = currentRun();
  renderRunPicker();
  const scopeBtn = $("scope-toggle");
  scopeBtn.disabled = !supportsTools || (scope === "all" && listLoaded && !boundConversation);
  scopeBtn.dataset.active = String(scope === "session");
  put("scope-toggle", scope === "session"
    ? (sessionCount == null ? "本会话" : `本会话 ${number.format(sessionCount)}`)
    : "全部");
  scopeBtn.title = boundWorkspace ? `当前绑定：${boundWorkspace}（点击切换范围）` : "切换当前会话 / 全部任务";
  $("info-toggle").disabled = !run;
  if (!run) {
    $("meta-drawer").hidden = true;
    $("info-toggle").setAttribute("aria-expanded", "false");
  }
  $("refresh").disabled = !supportsTools;
  $("dot").dataset.state = run?.state ?? "";
  $("dot").title = run ? statusLabel(run) : (ready ? "无任务" : "连接中");
  $("feed-wrap").hidden = !run;
  $("empty").hidden = !!run;
  put("empty-message", !ready ? "正在连接 GemPT…" : !listLoaded && supportsTools ? "正在读取…"
    : scope === "session" ? "当前会话暂无 GPT 任务" : "暂无 GPT 任务");
  $("empty-all").hidden = scope !== "session" || !listLoaded || !supportsTools;
  renderControls(run);
  if (!run) return;

  const usage = snapshot?.usage ?? run.usage ?? {};
  const tokens = usage.total_tokens ?? (usage.input_tokens != null ? usage.input_tokens + (usage.output_tokens ?? 0) : null);
  const rate = snapshot?.cache_hit_rate ?? (usage.input_tokens && usage.cached_input_tokens != null
    ? Math.min(1, usage.cached_input_tokens / usage.input_tokens) : null);
  put("badge", statusLabel(run));
  put("model", run.model || "—");
  put("elapsed", formatElapsed(run.elapsed_sec));
  put("tokens", tokens == null ? "—" : number.format(tokens));
  put("cache", rate == null ? "—" : percent.format(rate));
  put("goal", fullGoal ?? (run.goal || "未记录任务目标"));
  put("workspace", run.cwd || "—");
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
      goal += page.goal;
      offset = page.next_goal_offset;
    }
    if (generation === selection) {
      fullGoal = goal;
      put("goal", goal);
    }
  } catch (error) {
    if (generation === selection) notify(`读取任务目标失败：${error.message}`, true);
  } finally {
    if (goalLoading === generation) goalLoading = null;
  }
}

async function loadTranscript(data, generation, runId) {
  let offset = data.next_text_offset;
  if (offset == null || transcript.complete) return;
  let text = data.full_text;
  while (offset != null && canFetch() && generation === selection && !control) {
    const page = await call("gempt_app_stream", { run_id: runId, text_offset: offset, text_revision: data.text_revision });
    if (page.stale_text_revision) return;
    text += page.full_text;
    offset = page.next_text_offset;
  }
  if (generation === selection && offset == null) {
    transcript = { text, complete: true };
    renderStream();
  }
}

function stopTimers() {
  clearTimeout(listTimer);
  clearTimeout(streamTimer);
}

function acceptRuns(data, preferred) {
  const prior = currentRun();
  scope = data.scope;
  boundConversation = data.bound_conversation_id;
  boundWorkspace = data.bound_workspace_name;
  sessionCount = boundConversation ? data.session_count : null;
  runs = data.runs;
  listLoaded = true;
  const keepSelected = prior && (scope === "all" || prior.host_conversation_id === boundConversation);
  const next = preferred || (keepSelected ? selected : runs[0]?.run_id);
  if ((next || null) !== selected) {
    selectRun(next);
    refreshStream();
  } else {
    render();
  }
}

function selectScope(next) {
  if (scope === next) return;
  scope = next;
  listVersion++;
  listLoaded = false;
  runs = [];
  selectRun(null);
  render();
  void refreshRuns();
}

async function refreshRuns() {
  clearTimeout(listTimer);
  listWanted = true;
  if (readingList || !canFetch()) return;
  readingList = true;
  listWanted = false;
  const version = listVersion;
  try {
    const args = boundConversation ? { scope, host_conversation_id: boundConversation } : { scope };
    const data = await call("gempt_app_runs", args);
    if (version === listVersion) acceptRuns(data);
  } catch (error) {
    if (version === listVersion) notify(`刷新任务失败：${error.message}`, true);
  } finally {
    readingList = false;
    if (canFetch() && listWanted) refreshRuns();
    else if (canFetch()) listTimer = setTimeout(refreshRuns, isActive() ? 4000 : 10000);
  }
}

function refreshStream() {
  streamWanted = true;
  void driveStream();
}

async function driveStream() {
  clearTimeout(streamTimer);
  if (readingStream || !canFetch() || (!streamWanted && !control)) return;
  readingStream = true;
  const generation = selection;
  const action = control;
  try {
    if (action) {
      try {
        await call(action.name, action.args);
        if (action.generation === selection) {
          if (action.args.message) $("steer").value = "";
          $("control-status").hidden = false;
          put("control-status", action.args.message ? "已发送纠偏" : "已请求中止");
        }
      } catch (error) {
        if (action.generation === selection) {
          $("control-status").hidden = false;
          put("control-status", error.message);
        }
      } finally {
        control = null;
      }
    }
    const runId = selected;
    if (runId && canFetch()) {
      const current = selection;
      streamWanted = false;
      const data = await call("gempt_app_stream", { run_id: runId });
      if (current === selection) {
        if (!data.run.error && $("notice").dataset.error === "true") notify();
        acceptSnapshot(data);
        await loadTranscript(data, current, runId);
      }
    } else {
      streamWanted = false;
    }
  } catch (error) {
    if (generation === selection) notify(`读取进度失败：${error.message}`, true);
  } finally {
    readingStream = false;
    renderControls();
    if (control || streamWanted) void driveStream();
    else if (canFetch() && isActive()) streamTimer = setTimeout(refreshStream, 1200);
    else clearTimeout(listTimer);
  }
}

async function copy(value) {
  if (!value) return;
  if (navigator.clipboard && document.featurePolicy?.allowsFeature("clipboard-write") !== false) {
    try {
      await navigator.clipboard.writeText(value);
      notify("已复制");
      return;
    } catch { /* fallback */ }
  }
  const focused = document.activeElement;
  const input = node("textarea", "", "clipboard");
  input.value = value;
  input.readOnly = true;
  document.body.append(input);
  input.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* restricted */ } finally {
    input.remove();
    focused?.focus();
  }
  notify(copied ? "已复制" : "复制受限，请选中文字后手动复制。", !copied);
}

function queueControl(name, args) {
  if (!currentRun()?.can_control || !canFetch() || control) return;
  confirming = false;
  control = { name, args: { ...args, run_id: selected }, generation: selection };
  $("control-status").hidden = false;
  put("control-status", "正在发送…");
  renderControls();
  void driveStream();
}

$("refresh").addEventListener("click", () => { refreshRuns(); refreshStream(); });
$("scope-toggle").addEventListener("click", () => selectScope(scope === "session" ? "all" : "session"));
$("empty-all").addEventListener("click", () => selectScope("all"));
$("info-toggle").addEventListener("click", () => {
  const next = $("meta-drawer").hidden;
  $("meta-drawer").hidden = !next;
  $("info-toggle").setAttribute("aria-expanded", String(next));
});
$("goal-details").addEventListener("toggle", () => { if ($("goal-details").open) void loadGoal(); });
$("runs").addEventListener("change", (event) => {
  selectRun(event.target.value);
  if (isActive()) refreshRuns();
  refreshStream();
});
$("run-id").addEventListener("click", () => copy(currentRun()?.run_id));
$("session-id").addEventListener("click", () => copy(currentRun()?.session_id));
$("steer").addEventListener("input", () => renderControls());
$("steer").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    const message = $("steer").value.trim();
    if (message) queueControl("gempt_app_steer", { message });
  }
});
$("send-steer").addEventListener("click", () => {
  const message = $("steer").value.trim();
  if (message) queueControl("gempt_app_steer", { message });
});
$("interrupt").addEventListener("click", () => {
  if (confirming) queueControl("gempt_app_interrupt", {});
  else { confirming = true; renderControls(); }
});
$("cancel-interrupt").addEventListener("click", () => { confirming = false; renderControls(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTimers();
  else {
    refreshRuns();
    if (isActive() || !transcript.complete || control) refreshStream();
  }
});
systemTheme.addEventListener("change", () => applyHost(app.getHostContext()));

app.ontoolinput = ({ arguments: args }) => {
  if (!args || listLoaded) return;
  listVersion++;
  boundConversation = args.host_conversation_id || null;
  scope = args.scope || "session";
};
app.ontoolresult = (result) => {
  const data = result.structuredContent;
  if (!data) {
    if (result.isError) notify(result.content?.[0]?.text || "无法打开 GemPT Live", true);
    return;
  }
  listVersion++;
  acceptRuns(data, data.run_id);
  if (data.stream?.run?.run_id === selected) acceptSnapshot(data.stream);
  else render();
  refreshRuns();
  refreshStream();
};
app.onhostcontextchanged = () => applyHost(app.getHostContext());

async function connect() {
  applyHost();
  try {
    await app.connect();
    ready = true;
    supportsTools = !!app.getHostCapabilities()?.serverTools;
    applyHost(app.getHostContext());
    render();
    if (supportsTools) {
      refreshRuns();
      refreshStream();
    } else {
      notify("当前宿主未提供实时读取和控制能力。");
    }
  } catch (error) {
    put("badge", "连接失败");
    $("empty").hidden = true;
    notify(`无法连接 GemPT：${error.message}`, true);
  }
}
void connect();

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
  if ($(id).textContent !== value) $(id).textContent = value;
};
const status = (run) => statuses[run?.state] || "未知状态";

let ready = false;
let supportsTools = false;
let runs = [];
let scope = "session";
let boundConversation = null;
let boundWorkspace = "";
let sessionCount = null;
let listVersion = 0;
let listLoaded = false;
let selected = null;
let selection = 0;
let snapshot = null;
let transcript = { text: "", complete: false };
let fullGoal = null;
let goalLoading = null;
let listTimer, streamTimer;
let readingList = false;
let listWanted = false;
let readingStream = false;
let streamWanted = false;
let control = null;
let confirming = false;
const hostStyleKeys = new Set();

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

function renderRunPicker() {
  const displayed = currentRun();
  const options = displayed && !runs.some((run) => run.run_id === displayed.run_id) ? [displayed, ...runs] : runs;
  const key = JSON.stringify(options.map((run) => [run.run_id, run.state, run.title]));
  const select = $("runs");
  if (select.dataset.list !== key) {
    const placeholder = new Option(options.length ? "选择任务" : "暂无任务", "");
    placeholder.disabled = true;
    select.replaceChildren(placeholder, ...options.map((run) => new Option(
      `${status(run)} · ${run.title || run.workspace_name || run.run_id.slice(0, 8)}`, run.run_id,
    )));
    select.dataset.list = key;
  }
  select.disabled = !options.length;
  select.value = selected ?? "";
}

function selectRun(id) {
  if (id === selected) return;
  selected = id || null;
  selection++;
  snapshot = null;
  transcript = { text: "", complete: false };
  fullGoal = null;
  $("goal-details").open = false;
  confirming = false;
  $("steer").value = "";
  $("output").scrollTop = 0;
  put("control-status", "");
  notify();
  render();
}

function renderTranscript() {
  const out = $("output");
  const follow = out.scrollHeight > out.clientHeight && out.scrollHeight - out.scrollTop - out.clientHeight < 20;
  put("output", transcript.text || (snapshot ? "等待 GPT 输出…" : "正在读取…"));
  out.dataset.empty = String(!transcript.text);
  $("copy-output").disabled = !transcript.complete || !transcript.text;
  put("copy-output", transcript.text && !transcript.complete ? "正在补齐全文…" : "复制全文");
  if (follow) out.scrollTop = out.scrollHeight;
}

function updateList(id, data, placeholder, item) {
  const list = $(id);
  const value = JSON.stringify(data);
  if (list.dataset.value === value) return;
  const opened = new Set([...list.querySelectorAll("details[open]")].map((detail) => detail.dataset.id));
  list.replaceChildren(...(data.length ? data.map((entry) => item(entry, opened)) : [node("li", placeholder, "placeholder")]));
  list.dataset.value = value;
}

function exitLabel(code) {
  const label = node("span", code == null ? "执行中" : `退出码 ${code}`, "exit");
  label.dataset.failed = String(code != null && code !== 0);
  return label;
}

function eventItem(event) {
  const li = node("li");
  const labels = { reasoning: "思考摘要", agent_message: "GPT 消息", command: "命令", files: "文件变更", ask_gemini: "请求 Gemini" };
  const title = node("span", labels[event.type], "event-label");
  let detail = event.text;
  if (event.type === "command") {
    title.append(exitLabel(event.exit_code));
    detail = [event.command, event.output].filter(Boolean).join("\n");
  } else if (event.type === "files") {
    detail = event.paths?.join("\n") || `${event.count} 个文件`;
  } else if (event.type === "ask_gemini") {
    detail = event.arguments?.question;
  }
  li.append(title, node("div", detail, "event-text"));
  return li;
}

function commandItem(command, opened) {
  const li = node("li");
  const detail = node("details", "", "command");
  detail.dataset.id = command.id;
  detail.open = opened.has(command.id);
  const summary = node("summary");
  summary.append(node("code", command.command || "命令执行"), exitLabel(command.exit_code));
  detail.append(summary, node("pre", command.output || "暂无命令输出"));
  li.append(detail);
  return li;
}

const fileResult = z.object({ isError: z.boolean().optional() }).passthrough();
function fileItem([path, uri]) {
  const li = node("li");
  if (!uri) {
    li.textContent = path;
    return li;
  }
  const button = node("button", path, "file-link");
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await app.request({
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri },
      }, fileResult, { timeout: 3000 });
    } catch {
      // Hosts without the file pane still show the path.
    }
  });
  li.append(button);
  return li;
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
  return elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
}

function render() {
  const run = currentRun();
  renderRunPicker();
  for (const mode of ["session", "all"]) {
    const button = $("scope-" + mode);
    button.setAttribute("aria-pressed", String(scope === mode));
    button.disabled = !supportsTools || (mode === "session" && listLoaded && !boundConversation);
  }
  put("scope-session", sessionCount == null ? "当前会话" : `当前会话 ${number.format(sessionCount)}`);
  $("bound-workspace").hidden = !listLoaded;
  $("bound-workspace").title = boundConversation || "";
  put("bound-workspace", boundWorkspace || boundConversation?.slice(0, 8) || "未绑定会话");
  $("refresh").disabled = !supportsTools;
  $("run").hidden = !run;
  $("empty").hidden = !!run;
  $("metrics").hidden = !run;
  $("badge").dataset.state = run?.state ?? "";
  put("badge", run ? status(run) : ready ? "无任务" : "连接中");
  put("empty-message", !ready ? "正在连接 GemPT…" : !listLoaded && supportsTools ? "正在读取 GPT 任务…"
    : scope === "session" ? "当前会话暂无 GPT 任务" : "暂无 GPT 任务");
  $("empty-all").hidden = scope !== "session" || !listLoaded || !supportsTools;
  renderControls(run);
  if (!run) return;

  const usage = snapshot?.usage ?? run.usage ?? {};
  const tokens = usage.total_tokens ?? (usage.input_tokens != null ? usage.input_tokens + (usage.output_tokens ?? 0) : null);
  const rate = snapshot?.cache_hit_rate ?? (usage.input_tokens && usage.cached_input_tokens != null
    ? Math.min(1, usage.cached_input_tokens / usage.input_tokens) : null);
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
    put("ask-context", ask.context || "");
    updateList("ask-media", ask.media_paths || [], "", (path) => node("li", path));
    $("ask-media").hidden = !ask.media_paths?.length;
  }
  renderTranscript();
  const commands = snapshot?.commands || [];
  const files = snapshot?.touched_files || [];
  put("command-count", number.format(commands.length));
  put("file-count", number.format(files.length));
  updateList("timeline", snapshot?.timeline || [], "暂无进度事件", eventItem);
  updateList("commands", commands, "暂无命令", commandItem);
  updateList("files", files.map((path) => [path, snapshot?.file_uris?.[path]]), "暂无文件变更", fileItem);
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
    renderTranscript();
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
          put("control-status", action.args.message ? "已发送纠偏" : "已请求中止");
        }
      } catch (error) {
        if (action.generation === selection) put("control-status", error.message);
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
    } catch {
      // Fall back when clipboard access is denied.
    }
  }

  const focused = document.activeElement;
  const input = node("textarea", "", "clipboard");
  input.value = value;
  input.readOnly = true;
  document.body.append(input);
  input.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // Opaque iframes may also restrict the legacy copy path.
  } finally {
    input.remove();
    focused?.focus();
  }
  notify(copied ? "已复制" : "复制受限，请选中文字后手动复制。", !copied);
}

function queueControl(name, args) {
  if (!currentRun()?.can_control || !canFetch() || control) return;
  confirming = false;
  control = { name, args: { ...args, run_id: selected }, generation: selection };
  put("control-status", "正在发送…");
  renderControls();
  void driveStream();
}

$("refresh").addEventListener("click", () => { refreshRuns(); refreshStream(); });
$("scope-session").addEventListener("click", () => selectScope("session"));
$("scope-all").addEventListener("click", () => selectScope("all"));
$("empty-all").addEventListener("click", () => selectScope("all"));
$("goal-details").addEventListener("toggle", () => { if ($("goal-details").open) void loadGoal(); });
$("runs").addEventListener("change", (event) => {
  selectRun(event.target.value);
  if (isActive()) refreshRuns();
  refreshStream();
});
$("run-id").addEventListener("click", () => copy(currentRun()?.run_id));
$("session-id").addEventListener("click", () => copy(currentRun()?.session_id));
$("copy-output").addEventListener("click", () => copy(transcript.text));
$("steer").addEventListener("input", () => renderControls());
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

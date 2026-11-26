import { BOARD_WINDOW, boardGroup, historyQuery, memberGroups, normalizeMessage, selectBoardRows, snapshotQuery, unreadBoundary } from "./swarm-view-state.js";
import { buildNarratorSrcdoc, frameDataUrl } from "./narrator-bootstrap.js";
import { channelsAt, channelRegistry, effectiveChannels } from "../core/swarm-channels.mjs";
import { createBeeAvatar, createHiveView, graphSnapshot, renderMentions, replayDelay, exportGraphGif } from "./swarm-visuals.js";
import { errorText, locale, localizedFormat, tr as hostTranslate } from "../magpie_plugin/ui/i18n.js";
import { icon } from "./icons.js";
import { linkTarget } from "./live-state.js";

const english = {
  "成员": "Members", "原始数据": "Raw", "自定义视图": "Custom view", "纯文本视图": "Plain view",
  "选择数据文件": "Select data file", "显示已终止成员": "Show killed members", "展开截图": "Show screenshots",
  "跟随最新": "Follow", "跳到最新": "Latest", "清除筛选": "Clear filters", "加载更早消息": "Show earlier posts",
  "未读消息": "Unread", "展开全文": "Show more", "收起全文": "Show less", "你": "you",
  "已读至 #{0}": "Read through #{0}", "{0} 步": "{0} steps", "打开成员会话": "Open member session",
  "模型名称": "Model name", "切换模型": "Switch model", "已切换 {0} 的模型": "Switched model for {0}",
  "记录员更新于 {0}": "Narrator updated {0}", "记录员更新不及时": "Narrator is behind",
  "记录员视图无法加载，已切换到纯文本视图。": "Narrator view could not load. Showing the plain view.",
  "已完成 {0}/{1}": "{0}/{1} complete", "反馈": "Send feedback", "反馈内容": "Feedback", "已提交反馈": "Feedback sent",
  "按频道与成员查看消息": "Filter by channel and member", "尚无已读取的原始数据": "Raw data is unavailable",
  "实时": "Live", "最新消息 {0}": "Last post {0}", "查看完整回放": "Load full replay",
  "在新窗口打开": "Open in new window", "显示了部分消息，加载更早消息以继续筛选。": "Search covers loaded posts. Load earlier posts to search more.",
};
const tr = (value, ...args) => locale() === "en" && Object.hasOwn(english, value)
  ? english[value].replace(/\{(\d+)\}/g, (_, index) => args[index] ?? "")
  : hostTranslate(value, ...args);

const WORKER_STATUS_LABELS = {
  working: "运行中",
  waiting: "待命",
  waiting_reply: "等待回复",
  stopped: "已停止",
  killed: "已终止",
};

const KIND_LABELS = {
  brief: "任务单",
  question: "提问",
  summary: "总结",
  error: "错误",
  system: "系统",
};

const MENTION_TOKEN_RE = /@#[a-z][a-z0-9-]{0,23}(?![\w-])|@[a-z0-9][a-z0-9_-]{0,23}|\[done\]|#\d+(?![\w-])/gi;

function node(tag, text = "", className = "") {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function basename(p) {
  return String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
}

function agentPaletteIndex(name) {
  const raw = String(name || "").toLowerCase();
  if (raw === "coordinator") return "coordinator";
  if (raw === "human") return "human";
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return `w${Math.abs(hash) % 6}`;
}

function senderDisplayName(name) {
  const raw = String(name || "").toLowerCase();
  if (raw === "coordinator") return tr("协调者");
  if (raw === "human") return tr("用户");
  return String(name || "");
}

export function compactSwarmView(overview, messages = []) {
  if (!overview?.swarm) return false;
  const visible = overview.roster.filter(worker => worker.state !== "killed");
  if (visible.length !== 1 || visible.some(worker => worker.state === "waiting_reply" || worker.telemetry?.state === "waiting_gemini")) return false;
  for (const message of messages) {
    if (message.kind !== "system" && !message.control) return false;
  }
  return true;
}

export function groupWorkersByThreads(threads, roster = []) {
  const list = Array.isArray(roster) ? roster : [];
  if (!Array.isArray(threads) || !threads.length) {
    return [{
      id: "__all__",
      title: null,
      goal: "",
      tasks: [],
      workers: list,
      isDefault: true,
    }];
  }

  const byName = new Map(list.map((worker) => [worker.name, worker]));
  const assigned = new Set();
  const groups = threads.map((thread, index) => {
    const workers = [];
    const seenLocal = new Set();
    const extraTasks = [];
    const claim = (candidate) => {
      const key = typeof candidate === "string" ? candidate.trim() : "";
      if (key && byName.has(key) && !seenLocal.has(key)) {
        seenLocal.add(key);
        assigned.add(key);
        workers.push(byName.get(key));
        return true;
      }
      return false;
    };
    for (const candidate of [...(thread?.workers || []), ...(thread?.members || [])]) {
      claim(candidate);
    }
    for (const task of Array.isArray(thread?.tasks) ? thread.tasks : []) {
      if (typeof task === "string") {
        if (!claim(task) && task.trim()) extraTasks.push(task.trim());
      } else if (task && typeof task === "object") {
        const claimed = claim(task.worker || task.name);
        const label = String(task.summary || task.title || task.label || "").trim();
        if (!claimed && label) extraTasks.push(label);
      }
    }
    return {
      id: String(thread?.id || `thread-${index + 1}`),
      title: String(thread?.title || tr("线程 {0}", index + 1)),
      goal: String(thread?.goal || "").trim(),
      tasks: extraTasks,
      workers,
      isDefault: false,
      isOther: false,
    };
  });

  const remaining = list.filter((worker) => !assigned.has(worker.name));
  if (remaining.length) {
    groups.push({
      id: "__other__",
      title: null,
      goal: "",
      tasks: [],
      workers: remaining,
      isDefault: false,
      isOther: true,
    });
  }
  return groups;
}

export function tokenizeBoardText(text) {
  const raw = String(text || "");
  if (!raw) return [];
  const tokens = [];
  let lastIndex = 0;
  for (const match of raw.matchAll(MENTION_TOKEN_RE)) {
    const start = match.index;
    const value = match[0];
    // Avoid matching email addresses like foo@bar.
    if (value.startsWith("@") && start > 0 && /[A-Za-z0-9_.-]/.test(raw[start - 1])) continue;
    if (value.startsWith("#") && start > 0 && /[\w@#-]/.test(raw[start-1])) continue;
    if (start > lastIndex) tokens.push({ type: "text", value: raw.slice(lastIndex, start) });
    if (value.startsWith("@#")) tokens.push({ type: "channel_mention", value, channel: value.slice(2).toLowerCase() });
    else if (value.startsWith("#")) tokens.push({ type: "seq_ref", value, seq: Number(value.slice(1)) });
    else tokens.push({ type: value.startsWith("@") ? "mention" : "done", value });
    lastIndex = start + value.length;
  }
  if (lastIndex < raw.length) tokens.push({ type: "text", value: raw.slice(lastIndex) });
  return tokens;
}

export function mountSwarm({ transport, sidecar, navigate, openLink, copy, showToast }) {
  const $ = (id) => document.getElementById(id);
  const put = (id, value) => {
    const el = $(id);
    if (el && el.textContent !== value) el.textContent = value;
  };
  const timeFmt = localizedFormat(Intl.DateTimeFormat, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const pctFmt = localizedFormat(Intl.NumberFormat, { style: "percent", maximumFractionDigits: 1 });
  const dateFmt = localizedFormat(Intl.DateTimeFormat, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  let active = false;
  let scope = sidecar ? "session" : "all";
  const tabs = ["overview", "board", "members", "graph", "raw"];
  let subtab = "overview";
  let cursor = null, historyCursor = null, loadOlder = null, focusSeq = null;
  let following = true, raw = null, rawRequest = null, showKilled = false;
  let narratorFrame = null, narratorFrameKey = null, narratorLastGood = null, narratorRequested = false;
  let narratorWatchdog, narratorFailure = false, narratorData = null, frameSelection = 0;
  let narratorInputsAt = -Infinity, narratorActivationAt = -Infinity;
  const languageLabels = [...panelTextBindings()];
  function* panelTextBindings() {
    const panel = $("swarm-panel");
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const item = walker.currentNode;
      const source = item.data.trim();
      if (Object.hasOwn(english, source)) yield () => { item.data = tr(source); };
    }
    for (const item of panel.querySelectorAll("[aria-label]")) {
      const source = item.getAttribute("aria-label");
      if (Object.hasOwn(english, source)) yield () => item.setAttribute("aria-label", tr(source));
    }
  }
  let historyLowerBound = null;
  const frameRequests = new Map();
  const read = (operation, query) => transport.listActivity(`swarm/${operation}`, { scope, ...query });
  const panel = $("swarm-panel");
  let channel = "*", channelBusy = false;
  let loadingGraph = false;
  let graphMode = "hive", step = null, replayTimer, playing = false, exporting = false;
  let graphKey = "", graphDrawKey = "", snapshot, hive, boardRevision = 0;
  let selectionVersion = 0;
  const messages = () => [...boardBySeq.values()].sort((a,b) => a.seq-b.seq);
  const registry = () => overview?.channels || [];
  let swarms = [];
  let activeWorkersTotal = 0;
  let selectedSwarmId = null;
  let linkedSwarmId = null;
  let overview = null;
  let boardHead = 0;
  const boardBySeq = new Map();
  let listLoaded = false;
  let loading = false;
  let fetching = false;
  let fetchWanted = false;
  let pollTimer = null;
  let opaqueWriteBlocked = Boolean(transport.opaqueOrigin);
  let posting = false;
  let replyTo = null; // { seq, from }
  let pendingConfirm = null; // { action: "interrupt" | "kill", name }
  let busyWorkerAction = null; // `${action}:${name}`
  let editingTitle = false;
  let savingTitle = false;

  function formatStamp(iso) {
    if (!iso) return "";
    const ms = typeof iso === "number" ? iso : Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const diffSec = Math.round((Date.now() - ms) / 1000);
    if (diffSec >= 0 && diffSec < 45) return tr("刚刚");
    const d = new Date(ms);
    const now = new Date();
    return d.toDateString() === now.toDateString() ? timeFmt.format(d) : dateFmt.format(d);
  }

  function updateTabBadge(count) {
    const badge = $("swarm-tab-badge");
    if (!badge) return;
    const total = Number.isFinite(count) && count > 0 ? count : 0;
    badge.textContent = total > 0 ? String(total) : "";
    badge.hidden = total <= 0;
  }

  function updateStandaloneLink() {
    const banner = $("swarm-opaque-banner");
    if (!banner) return;
    banner.hidden = !opaqueWriteBlocked;
    if (!opaqueWriteBlocked) return;
    const base = transport.installPage || "";
    const href = base ? `${base}#swarm${selectedSwarmId ? "/" + encodeURIComponent(selectedSwarmId) : ""}` : "";
    const link = $("swarm-standalone-link");
    const copyBtn = $("swarm-copy-link");
    if (link) {
      link.hidden = !href;
      if (href) link.href = href;
    }
    if (copyBtn) {
      copyBtn.hidden = !href;
      copyBtn.dataset.href = href;
    }
  }

  function setError(message = "") {
    put("swarm-error", message);
    $("swarm-error").hidden = !message;
  }

  function setComposerStatus(message = "", error = false) {
    const el = $("swarm-composer-status");
    if (!el) return;
    el.hidden = !message;
    el.dataset.error = String(error);
    el.textContent = message;
  }

  function resetBoardCache() {
    selectionVersion++;
    openMetadata.clear();
    cursor = historyCursor = null;
    historyLowerBound = null;
    focusSeq = null; following = true;
    raw = rawRequest = null;
    frameRequests.clear(); frameSelection++;
    if ($("swarm-frame-dialog").open) $("swarm-frame-dialog").close();
    narratorRequested = narratorFailure = false; narratorLastGood = null;
    removeNarratorFrame();
    loadOlder = null;
    stopReplay();
    graphKey = graphDrawKey = "";
    $("swarm-gif-modal")?.close();
    channel = "*"; step = null; snapshot = null; hive?.reset();
    $("swarm-search").value = ""; $("swarm-from").value = ""; $("swarm-mentioned").value = "";
    $("swarm-target").value = "main"; $("swarm-channel-actions").open = false;
    boardRevision++;
    $("swarm-composer-input").value = "";
    setComposerStatus();
    boardHead = 0;
    boardBySeq.clear();
    replyTo = null;
    pendingConfirm = null;
    delete $("swarm-board-feed").dataset.key;
  }

  function readFrame(item) {
    if (!item.path || item.restricted_reason) return Promise.resolve(null);
    const key = JSON.stringify([item.path, item.seq ?? null]);
    const cached = frameRequests.get(key);
    if (cached) return cached;
    const request = read("frame", { swarm_id: selectedSwarmId, path: item.path, format: "dataurl" })
      .then(frameDataUrl, () => null);
    frameRequests.set(key, request);
    if (frameRequests.size > 24) frameRequests.delete(frameRequests.keys().next().value);
    void request.then(data => { if (!data && frameRequests.get(key) === request) frameRequests.delete(key); });
    return request;
  }

  async function previewFrame(item) {
    const version = selectionVersion, request = ++frameSelection;
    const data = await readFrame(item);
    if (version !== selectionVersion || request !== frameSelection || !active) return;
    if (!data) { openScreenshot(item); return; }
    put("swarm-frame-caption", item.caption || basename(item.path));
    const img = $("swarm-frame-preview");
    img.src = data; img.alt = item.caption || basename(item.path);
    $("swarm-frame-dialog").showModal();
  }

  function renderFrameThumbnails() {
    const version = selectionVersion;
    for (const chip of $("swarm-screenshots-list").querySelectorAll("[data-frame]")) {
      const path = chip.dataset.frame;
      const seq = Number(chip.dataset.seq) || null;
      if (chip.dataset.loaded) continue;
      chip.dataset.loaded = "true";
      void readFrame({ path, seq }).then(data => {
        if (!data || !chip.isConnected || version !== selectionVersion) return;
        const image = node("img");
        image.src = data; image.alt = ""; image.loading = "lazy";
        chip.prepend(image);
      });
    }
  }

  function openScreenshot(item) {
    const target = item.restricted_reason ? null : item.file_uri
      ? linkTarget(item.file_uri, null, { approved: true })
      : linkTarget(item.path, sidecar ? null : overview?.swarm?.cwd);
    if (target?.kind === "file" && sidecar?.ui?.toggleAuxPane && item.file_uri) {
      sidecar.ui.toggleAuxPane({ tabType: "fileView", uri: item.file_uri });
      return;
    }
    if (target?.kind === "file" && !sidecar && openLink) {
      void openLink(target, item.path);
      return;
    }
    void copy(item.path, tr("已复制路径。"));
  }

  function makeScreenshotChip(item) {
    const btn = node("button", "", "file-chip swarm-shot-chip");
    btn.type = "button";
    btn.title = item.path;
    btn.append(icon("image"), node("span", basename(item.path)));
    btn.addEventListener("click", () => void previewFrame(item));
    return btn;
  }

  function renderHeader() {
    const scopeSwitch = $("swarm-scope-switch");
    if (scopeSwitch) {
      scopeSwitch.hidden = false;
      $("swarm-scope-session").setAttribute("aria-pressed", String(scope === "session"));
      $("swarm-scope-all").setAttribute("aria-pressed", String(scope === "all"));
    }

    const picker = $("swarm-picker");
    const hasSwarm = Boolean(selectedSwarmId && overview?.swarm);
    if (picker) {
      picker.hidden = false;
      picker.disabled = !swarms.length;
      if (swarms.length) {
        const key = JSON.stringify([selectedSwarmId, swarms.map((s) => [s.id, s.title, s.counts?.active, s.head])]);
        if (picker.dataset.key !== key) {
          picker.dataset.key = key;
          picker.replaceChildren(...swarms.map((item) => {
            const opt = document.createElement("option");
            opt.value = item.id;
            const label = item.title || item.goal_title || item.id;
            const suffix = item.counts?.active > 0 ? ` (${item.counts.active})` : "";
            opt.textContent = `${label}${suffix}`;
            opt.selected = item.id === selectedSwarmId;
            return opt;
          }));
        }
        picker.value = selectedSwarmId || "";
      } else { picker.replaceChildren(new Option(tr("暂无协作 Swarm"), "")); delete picker.dataset.key; }
    }

    const swarm = overview?.swarm;
    const displayTitle = swarm ? (swarm.title || swarm.goal_title || (swarm.id.startsWith("conversation-") ? tr("会话协作") : swarm.id)) : tr("Swarm 协作");
    put("swarm-title", displayTitle);
    $("swarm-title").title = swarm ? `${displayTitle} (${swarm.id})` : displayTitle;
    $("swarm-edit-title").hidden = !hasSwarm || opaqueWriteBlocked || editingTitle;
    $("swarm-title-form").hidden = !hasSwarm || !editingTitle;

    const goalEl = $("swarm-goal");
    const goalParts = [swarm?.goal_title, swarm?.goal_line].filter(Boolean);
    if (hasSwarm && goalParts.length) {
      goalEl.hidden = false;
      goalEl.replaceChildren();
      if (swarm.goal_title) goalEl.append(node("strong", swarm.goal_title));
      if (swarm.goal_title && swarm.goal_line) goalEl.append(document.createTextNode(" · "));
      if (swarm.goal_line) goalEl.append(document.createTextNode(swarm.goal_line));
    } else {
      goalEl.hidden = true;
    }

    const pills = $("swarm-pills");
    if (hasSwarm && overview?.counts) {
      pills.hidden = false;
      const c = overview.counts;
      const items = [];
      if (c.working > 0) items.push({ state: "working", label: tr("运行中 {0}", c.working) });
      if (c.waiting_reply > 0) items.push({ state: "waiting_reply", label: tr("等待回复 {0}", c.waiting_reply) });
      if (c.waiting > 0) items.push({ state: "waiting", label: tr("待命 {0}", c.waiting) });
      if (c.stopped > 0) items.push({ state: "stopped", label: tr("已停止 {0}", c.stopped) });
      if (c.killed > 0) items.push({ state: "killed", label: tr("已终止 {0}", c.killed) });
      if (!items.length) items.push({ state: "idle", label: tr("共 {0} 个工位", c.total) });

      const key = JSON.stringify(items);
      if (pills.dataset.key !== key) {
        pills.dataset.key = key;
        pills.replaceChildren(...items.map((item) => {
          const pill = node("span", "", "swarm-pill");
          pill.dataset.state = item.state;
          pill.append(node("span", "", "swarm-dot"));
          pill.append(node("span", item.label));
          return pill;
        }));
      }
    } else {
      pills.hidden = true;
    }

    const latest = boardBySeq.get(boardHead)?.created_at;
    const freshness = $("swarm-freshness");
    freshness.hidden = !latest;
    if (latest) freshness.textContent = tr("最新消息 {0}", formatStamp(latest));
    const subtabs = $("swarm-subtabs");
    subtabs.hidden = false;
    for (const name of tabs) {
      const tab = $(`swarm-subtab-${name}`);
      tab.setAttribute("aria-selected", String(subtab === name));
      tab.tabIndex = subtab === name ? 0 : -1;
    }
  }

  const openMetadata = new Set();

  function renderWorkerRow(worker) {
    const li = node("li", "", "swarm-worker-row");
    li.dataset.worker = worker.name;
    li.dataset.state = worker.state || "";

    const main = node("div", "", "swarm-worker-main");
    const top = node("div", "", "swarm-worker-top");

    const dot = node("span", "", "swarm-dot");
    const nameEl = node("span", worker.name, "swarm-worker-name mono");
    nameEl.dataset.palette = agentPaletteIndex(worker.name);
    const state = worker.telemetry?.state === "waiting_gemini" ? "waiting_reply" : worker.state;
    dot.dataset.state = state;
    const stateLabel = node("span", tr(WORKER_STATUS_LABELS[state] || "未知"), "swarm-worker-state");
    stateLabel.dataset.state = state || "";

    top.append(createBeeAvatar(worker.name, worker.state), dot, nameEl, stateLabel);
    if (["monitor", "narrator"].includes(worker.role)) top.append(node("span", tr(worker.role === "monitor" ? "监控员" : "记录员"), "sw-meta-pill"));
    if (worker.name === (overview.self?.name ?? overview.self)) top.append(node("span", tr("你"), "sw-meta-pill"));
    if (worker.unread) {
      const unread = node("span", tr("{0} 条未读", worker.unread), "sw-unread");
      unread.title = tr("已读至 #{0}", worker.last_read_seq || 0);
      top.append(unread);
    }
    if (worker.steps != null) top.append(node("span", tr("{0} 步", worker.steps), "sw-meta-pill"));

    const details = node("div", "", "sw-worker-details");
    if (worker.cli) {
      const cliPill = node("span", worker.cli, "swarm-cli-pill mono");
      cliPill.dataset.cli = worker.cli;
      cliPill.title = tr("执行 CLI：{0}", worker.cli);
      top.append(cliPill);
    }

    if (worker.model) {
      const rt = node("span", worker.model, "swarm-worker-runtime mono");
      rt.title = worker.model;
      top.append(rt);
    }

    const ratio = worker.telemetry?.cache_hit_ratio;
    if (Number.isFinite(ratio)) details.append(node("span", tr("缓存命中率") + " " + pctFmt.format(ratio), "sw-meta-pill"));
    if (worker.workspace === "share" || worker.worktree_path) {
      const wt = node("span", "Worktree", "run-kind");
      if (worker.worktree_path) wt.title = worker.worktree_path;
      details.append(wt);
    }

    main.append(top);
    for (const ch of worker.channels || []) details.append(node("span", ch === "*" ? tr("全部频道") : "#" + ch, "sw-meta-pill"));
    if (worker.wake_mode) details.append(node("span", tr(worker.wake_mode === "anything" ? "任意消息唤醒" : "提及时唤醒")));
    if (worker.added_by) details.append(node("span", tr("由 @{0} 添加", worker.added_by)));
    if (worker.worktree_path) details.append(node("span", worker.worktree_path, "mono"));
    if (worker.quota_paused_seq) {
      const note = node("p", tr("配额暂停于"), "swarm-worker-wait");
      note.append(citation(worker.quota_paused_seq));
      main.append(note);
    }

    const summary = String(worker.task_summary || "").trim()
      || String(worker.brief || "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (summary) {
      const summaryEl = node("p", summary, "swarm-worker-task");
      summaryEl.title = summary;
      main.append(summaryEl);
    }
    if (worker.error) {
      const errEl = node("p", errorText(worker.error), "swarm-worker-error");
      errEl.title = worker.error;
      main.append(errEl);
    }

    if (details.childNodes.length) {
      const key = selectedSwarmId + "/" + worker.name;
      const more = node("details");
      more.open = openMetadata.has(key);
      more.ontoggle = () => more.open ? openMetadata.add(key) : openMetadata.delete(key);
      more.append(node("summary", tr("详情")), details);
      main.append(more);
    }
    const activity = worker.activity || worker.telemetry?.last_message;
    if (activity && ["working", "waiting_reply"].includes(state)) {
      const current = node("p", activity, "sw-member-activity");
      current.title = activity;
      main.append(current);
    }
    const actions = node("div", "", "swarm-worker-actions");
    const hostConversation = worker.host_conversation_id
      || (worker.conversation_id !== worker.session_id ? worker.conversation_id : null);
    const jump = worker.run_id ? () => navigate("live", { id: worker.run_id, focus: true })
      : hostConversation && sidecar?.ui?.toggleConversation ? () => sidecar.ui.toggleConversation(hostConversation) : null;
    if (jump) {
      const open = node("button", worker.name, "sw-member-link");
      open.type = "button"; open.title = tr("打开成员会话");
      open.onclick = jump;
      nameEl.replaceChildren(open);
      li.onclick = event => { if (!event.target.closest("button,summary,a,input")) jump(); };
    }

    const canInterrupt = !opaqueWriteBlocked && Boolean(worker.run_id)
      && (worker.telemetry?.can_interrupt ?? (worker.state === "working" || worker.state === "waiting_reply"));
    const canKill = !opaqueWriteBlocked && worker.state !== "killed" && worker.role !== "coordinator";

    if (canInterrupt) {
      const isConfirm = pendingConfirm?.action === "interrupt" && pendingConfirm?.name === worker.name;
      const busy = busyWorkerAction === `interrupt:${worker.name}`;
      const btn = node("button", isConfirm ? tr("确认中断") : tr("中断"), "btn-ghost swarm-action-btn");
      btn.type = "button";
      btn.disabled = Boolean(busyWorkerAction);
      btn.dataset.workerAction = "interrupt";
      if (isConfirm) btn.dataset.confirm = "true";
      btn.addEventListener("click", () => {
        if (!isConfirm) {
          pendingConfirm = { action: "interrupt", name: worker.name };
          render();
          return;
        }
        if (!busy) void runWorkerAction("interrupt", worker.name);
      });
      actions.append(btn);
    }

    if (canKill) {
      const isConfirm = pendingConfirm?.action === "kill" && pendingConfirm?.name === worker.name;
      const busy = busyWorkerAction === `kill:${worker.name}`;
      const btn = node("button", isConfirm ? tr("确认终止") : tr("终止"), "btn-danger swarm-action-btn");
      btn.type = "button";
      btn.disabled = Boolean(busyWorkerAction);
      btn.dataset.workerAction = "kill";
      if (isConfirm) btn.dataset.confirm = "true";
      btn.addEventListener("click", () => {
        if (!isConfirm) {
          pendingConfirm = { action: "kill", name: worker.name };
          render();
          return;
        }
        if (!busy) void runWorkerAction("kill", worker.name);
      });
      actions.append(btn);
    }

    if (!opaqueWriteBlocked && worker.role !== "coordinator" && ["waiting", "stopped"].includes(worker.state)) {
      const form = node("form", "", "sw-tool-row sw-model-form");
      const input = node("input");
      input.placeholder = tr("模型名称"); input.setAttribute("aria-label", input.placeholder);
      input.required = true;
      const submit = node("button", tr("切换模型"), "btn-ghost");
      submit.disabled = Boolean(busyWorkerAction);
      form.append(input, submit);
      form.onclick = event => event.stopPropagation();
      form.onsubmit = event => {
        event.preventDefault();
        if (input.value.trim()) void runWorkerAction("model", worker.name, { model: input.value.trim() });
      };
      const menu = node("details"); menu.append(node("summary", tr("模型")), form); actions.append(menu);
    }
    li.append(main, actions);
    return li;
  }

  function narratorTheme() {
    const style = getComputedStyle(panel);
    const bridge = { "--background": "--bg", "--foreground": "--fg", "--muted-foreground": "--muted-ink",
      "--border": "--line", "--card": "--surface", "--primary": "--info" };
    const tokens = Object.fromEntries(Object.entries(bridge).map(([host, local]) =>
      [host, style.getPropertyValue(host).trim() || style.getPropertyValue(local).trim()]));
    const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const scheme = document.documentElement.dataset.theme || (prefersDark ? "dark" : "light");
    return { tokens, scheme };
  }

  function removeNarratorFrame() {
    clearTimeout(narratorWatchdog);
    narratorFrame?.remove();
    narratorFrame = null;
    narratorFrameKey = narratorData = null;
  }

  function narratorFallback() {
    narratorFailure = true;
    removeNarratorFrame();
    renderNarrator();
  }

  function renderNarrator() {
    const root = $("swarm-narrator"), body = $("swarm-narrator-body"), mode = $("swarm-narrator-mode");
    const view = overview?.view;
    const json = view?.json ?? (view?.headline || view?.workstreams ? view : null);
    if (json && typeof json === "object" && !Array.isArray(json)) narratorLastGood = json;
    else if (!view?.jsonError) narratorLastGood = null;
    const model = narratorLastGood;
    const narrator = overview?.narrator;
    root.hidden = !model && !narrator;
    if (root.hidden) { removeNarratorFrame(); return; }
    const date = formatStamp(model?.updated_at || view?.jsonMtime);
    const stale = narrator?.stale ?? Boolean(narrator && overview.head - Math.max(model?.as_of_seq || 0, narrator.last_read_seq || 0) >= 10
      && narrator.state !== "working");
    put("swarm-narrator-status", [narrator?.name, date && tr("记录员更新于 {0}", date),
      stale && tr("记录员更新不及时"), narratorFailure && tr("记录员视图无法加载，已切换到纯文本视图。")].filter(Boolean).join(" · "));
    const template = typeof view?.html === "string" && new TextEncoder().encode(view.html).length <= 65536 ? view.html : "";
    const key = template && (view.htmlKey || template);
    if (narratorFailure && body.dataset.failedKey !== key) narratorFailure = false;
    mode.hidden = !model || !template;
    mode.textContent = tr(narratorRequested && !narratorFailure ? "纯文本视图" : "自定义视图");
    if (model && template && narratorRequested && !narratorFailure && active) {
      const meta = { head: overview.head, narrator, members: overview.roster.map(({ name, role, state }) => ({ name, role, status: state })) };
      const data = JSON.stringify([model, meta]);
      if (narratorFrame && narratorFrameKey === key) {
        if (narratorData !== data) {
          narratorFrame.contentWindow?.postMessage({ type: "DATA_UPDATE", view: model, meta }, "*");
          narratorData = data;
          clearTimeout(narratorWatchdog);
          narratorWatchdog = setTimeout(narratorFallback, 3000);
        }
        return;
      }
      removeNarratorFrame();
      body.replaceChildren();
      const frame = node("iframe");
      frame.title = tr("自定义视图");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.srcdoc = buildNarratorSrcdoc(template, model, meta, narratorTheme());
      narratorFrame = frame;
      narratorFrameKey = key;
      narratorData = data;
      body.dataset.failedKey = key;
      let loads = 0;
      frame.addEventListener("load", () => { if (++loads > 1 && narratorFrame === frame) narratorFallback(); });
      body.append(frame);
      narratorWatchdog = setTimeout(narratorFallback, 3000);
      return;
    }
    removeNarratorFrame();
    const plainKey = JSON.stringify([locale(), model, opaqueWriteBlocked]);
    if (body.dataset.key === plainKey && body.childElementCount) return;
    body.dataset.key = plainKey;
    body.replaceChildren();
    if (!model) return;
    if (model.headline) body.append(node("p", model.headline, "sw-narrator-headline"));
    for (const name of ["attention", "workstreams", "milestones", "risks"]) {
      if (!Array.isArray(model[name]) || !model[name].length) continue;
      const group = node("div", "", "sw-narrator-items");
      const heading = { attention: "需要关注", workstreams: "线程", milestones: "里程碑", risks: "风险" };
      group.append(node("h3", tr(heading[name])));
      for (const item of model[name].slice(0, 30)) {
        if (!item || typeof item !== "object") continue;
        const row = node("p", item.title || item.text || "");
        if (item.why || item.note) row.append(document.createTextNode(" · " + (item.why || item.note)));
        for (const ref of Array.isArray(item.refs) ? item.refs.slice(0, 12) : []) {
          if (Number.isSafeInteger(ref?.seq) && ref.seq > 0 && ref.seq <= overview.head) row.append(citation(ref.seq));
        }
        if (!opaqueWriteBlocked && typeof item.id === "string") {
          const feedback = node("button", tr("反馈"), "btn-ghost");
          feedback.type = "button";
          feedback.onclick = () => requestFeedback(item.id);
          row.append(feedback);
        }
        group.append(row);
      }
      body.append(group);
    }
    if (model.feedback_ack?.text) body.append(node("p", model.feedback_ack.text));
  }

  function narratorAction(action) {
    const target = action?.target;
    if (action?.type === "board_post" && Number.isSafeInteger(Number(target)) && Number(target) <= overview.head) {
      void jumpTo(Number(target));
    } else if (action?.type === "open_conv" && typeof target === "string") {
      const member = overview.roster.find(({ name }) => name === target);
      if (member?.run_id) navigate("live", { id: member.run_id, focus: true });
      else {
        const conv = member?.host_conversation_id ?? member?.conversation_id;
        if (conv && conv !== member?.session_id) sidecar?.ui?.toggleConversation?.(conv);
      }
    } else if (action?.type === "url" && typeof target === "string") {
      try {
        const url = new URL(target);
        const hosts = ["docs.google.com", ...(Array.isArray(overview.urlHosts) ? overview.urlHosts : [])];
        if (url.protocol === "https:" && !url.username && !url.password
          && hosts.some(host => url.hostname === host || url.hostname.endsWith("." + host))) {
          window.open(url.href, "_blank", "noopener,noreferrer");
        }
      } catch { /* Ignore malformed destinations. */ }
    } else if (action?.type === "file" && typeof target === "string" && Object.hasOwn(overview.allowedFiles || {}, target)) {
      const uri = overview.allowedFiles[target];
      if (typeof uri === "string" && uri.startsWith("file://")) sidecar?.ui?.toggleAuxPane?.({ tabType: "fileView", uri });
    }
  }

  function requestFeedback(id) {
    const valid = typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id)
      && ["attention", "workstreams", "milestones", "risks"].some(key =>
        Array.isArray(narratorLastGood?.[key]) && narratorLastGood[key].some(item => item?.id === id));
    if (!valid) return;
    if (opaqueWriteBlocked) { showToast?.(tr("嵌入式只读视图")); return; }
    const swarmId = selectedSwarmId, feedbackScope = scope;
    const dialog = node("dialog", "", "sw-feedback-dialog");
    const form = node("form", "", "sw-tool-row");
    const field = node("textarea"); field.required = true; field.maxLength = 2000;
    field.setAttribute("aria-label", tr("反馈内容"));
    const submit = node("button", tr("反馈"), "btn-primary");
    const dismiss = node("button", tr("取消"), "btn-ghost"); dismiss.type = "button";
    dismiss.onclick = () => dialog.close();
    form.append(field, submit, dismiss);
    form.onsubmit = async event => {
      event.preventDefault();
      const text = field.value.trim();
      if (!text || selectedSwarmId !== swarmId || submit.disabled) return;
      submit.disabled = true;
      try {
        await transport.swarm("feedback", { swarm_id: swarmId, scope: feedbackScope, target_id: id, text });
        dialog.close();
        showToast?.(tr("已提交反馈"));
      } catch (error) { handleWriteError(error); }
      finally { submit.disabled = false; }
    };
    dialog.append(form);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    panel.append(dialog);
    dialog.showModal();
  }

  function renderOverview() {
    const container = $("swarm-threads");
    const shotsCard = $("swarm-screenshots-card");
    const shotsList = $("swarm-screenshots-list");
    if (!overview?.swarm) {
      container.replaceChildren();
      shotsCard.hidden = true;
      return;
    }

    renderNarrator();
    const done = new Set([...overview.pinned, ...boardBySeq.values()]
      .filter(message => /(?:^|\s)\[done\](?:\s|$)/i.test(message.text || ""))
      .map(message => message.from_agent));
    const overviewKey = JSON.stringify([locale(), selectedSwarmId, overview.roster, overview.swarm.threads,
      overview.screenshots, overview.system_attention, [...done]]);
    if (container.dataset.key === overviewKey) return;
    container.dataset.key = overviewKey;
    renderAttention();
    const groups = groupWorkersByThreads(overview.swarm.threads,
      overview.roster.filter(member => member.state !== "killed" && !["coordinator", "narrator", "monitor"].includes(member.role)));
    container.replaceChildren(...groups.map((group) => {
      const card = node("section", "", "swarm-card");
      card.dataset.threadId = group.id;
      const head = node("header", "", "swarm-card-head");
      const titleText = group.isDefault
        ? tr("工位")
        : group.isOther
          ? tr("其他工位")
          : group.title;
      head.append(node("h2", titleText, "swarm-card-title"));
      if (group.workers.length) {
        const completed = group.workers.filter(worker => done.has(worker.name)).length;
        head.append(node("span", tr("已完成 {0}/{1}", completed, group.workers.length), "swarm-card-meta"));
      }
      card.append(head);

      if (group.goal) {
        card.append(node("p", group.goal, "swarm-thread-goal"));
      }
      if (group.tasks.length) {
        const taskList = node("ul", "", "swarm-thread-tasks");
        for (const t of group.tasks) taskList.append(node("li", t));
        card.append(taskList);
      }

      if (group.workers.length) {
        const ul = node("ul", "", "swarm-worker-list");
        for (const worker of group.workers) {
          const row = node("li", "", "sw-thread-member");
          const status = node("span", "", "swarm-dot"); status.dataset.state = worker.state;
          row.append(status, node("strong", worker.name), node("span", worker.task_summary || ""));
          if (worker.last_post_seq) row.append(citation(worker.last_post_seq));
          ul.append(row);
        }
        card.append(ul);
      } else {
        card.append(node("p", tr("暂无工位"), "swarm-card-empty"));
      }
      return card;
    }));

    const shots = (overview.screenshots || [])
      .filter(item => typeof item?.path === "string").slice(-40);
    shotsCard.hidden = shots.length === 0;
    if (shots.length) {
      put("swarm-screenshots-count", tr(shots.length === 1 ? "1 张截图" : "{0} 张截图", shots.length));
      shotsList.replaceChildren(...shots.map((item) => {
        const li = node("li", "", "swarm-shot-item");
        const meta = node("div", "", "swarm-shot-meta");
        meta.append(
          node("span", senderDisplayName(item.from_agent || item.agent || "narrator"), "swarm-sender-pill"),
        );
        meta.lastChild.dataset.palette = agentPaletteIndex(item.from_agent || item.agent);
        if (Number.isSafeInteger(item.seq)) meta.prepend(citation(item.seq));
        const stamp = formatStamp(item.created_at ?? item.time);
        if (stamp) meta.append(node("span", stamp, "swarm-time"));
        li.append(meta);
        if (item.caption) li.append(node("p", item.caption, "swarm-shot-caption"));
        const chip = makeScreenshotChip(item);
        chip.dataset.frame = item.path;
        if (item.seq) chip.dataset.seq = String(item.seq);
        li.append(chip);
        return li;
      }));
    }
    if ($("swarm-reel").open) renderFrameThumbnails();
  }

  function renderMembers() {
    const root = $("swarm-members");
    const grouped = memberGroups(overview.roster);
    const toggle = $("swarm-show-killed");
    toggle.parentElement.hidden = !grouped.killed.length;
    const key = JSON.stringify([locale(), grouped, overview.self, showKilled, pendingConfirm, busyWorkerAction, opaqueWriteBlocked]);
    if (root.dataset.key === key) return;
    if (!busyWorkerAction && root.contains(document.activeElement) && document.activeElement.closest(".sw-model-form")) return;
    root.dataset.key = key;
    root.replaceChildren(...Object.entries(grouped).filter(([state, rows]) =>
      rows.length && (state !== "killed" || showKilled)).map(([state, rows]) => {
      const section = node("section", "", "sw-member-group");
      section.dataset.state = state;
      const names = { active: "运行中", waiting: "待命", killed: "已终止" };
      section.append(node("h2", tr(names[state]) + " · " + rows.length));
      const list = node("ul", "", "swarm-worker-list");
      list.append(...rows.map(renderWorkerRow));
      section.append(list);
      return section;
    }));
  }

  async function renderRaw() {
    const version = selectionVersion;
    const key = JSON.stringify([selectedSwarmId, boardHead, cursor?.rosterKey, overview.view?.jsonMtime, overview.plan, overview.swarm.title]);
    const output = $("swarm-raw");
    const kind = $("swarm-raw-kind").value;
    if (raw?.key === key) {
      const value = raw.data[kind];
      output.textContent = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
      $("swarm-raw-copy").disabled = false;
      return;
    }
    if (rawRequest === key) return;
    rawRequest = key;
    $("swarm-raw-copy").disabled = true;
    output.textContent = tr("正在加载…");
    try {
      const data = await read("raw", { swarm_id: selectedSwarmId });
      if (version !== selectionVersion || rawRequest !== key) return;
      raw = { key, data };
      void renderRaw();
    } catch (error) {
      if (version === selectionVersion && rawRequest === key) output.textContent = errorText(error.message);
    } finally {
      if (version === selectionVersion && rawRequest === key) rawRequest = null;
    }
  }

  function renderMentionChips() {
    const wrap = $("swarm-mention-chips");
    if (!wrap) return;
    const roster = (overview?.roster || []).filter((w) => w.state !== "killed");
    const names = [...new Set(["all", "coordinator", ...roster.map((w) => w.name), ...registry().filter(c => !c.archived && c.name !== "main").map(c => "#" + c.name)])];
    const key = JSON.stringify([opaqueWriteBlocked, names]);
    if (wrap.dataset.key === key) return;
    wrap.dataset.key = key;
    wrap.replaceChildren(...names.map((name) => {
      const chip = node("button", `@${name}`, "swarm-mention-chip mono");
      chip.type = "button";
      chip.disabled = opaqueWriteBlocked;
      chip.dataset.mention = name;
      chip.addEventListener("click", () => insertMention(name));
      return chip;
    }));
  }

  function insertMention(name) {
    const input = $("swarm-composer-input");
    if (!input || input.disabled) return;
    const token = `@${name} `;
    const val = input.value;
    const start = input.selectionStart ?? val.length;
    const end = input.selectionEnd ?? val.length;
    const prefix = start > 0 && !/\s$/.test(val.slice(0, start)) ? " " : "";
    const next = val.slice(0, start) + prefix + token + val.slice(end);
    input.value = next;
    const caret = start + prefix.length + token.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    syncComposerControls();
  }

  function startReplyTo(msg) {
    replyTo = { seq: msg.seq, from: msg.from_agent };
    if ([...$("swarm-target").options].some(o => o.value === msg.channel)) $("swarm-target").value = msg.channel;
    renderReplyBanner();
    const input = $("swarm-composer-input");
    if (input && !input.disabled) {
      const prefix = `@${msg.from_agent} `;
      if (!input.value.trim().toLowerCase().startsWith(`@${msg.from_agent.toLowerCase()}`)) {
        input.value = input.value ? `${prefix}${input.value}` : prefix;
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      syncComposerControls();
    }
  }

  function renderReplyBanner() {
    const banner = $("swarm-reply-banner");
    if (!banner) return;
    banner.hidden = !replyTo;
    if (replyTo) {
      put("swarm-reply-label", tr("正在回复 #{0}（@{1}）", replyTo.seq, replyTo.from));
    }
  }

  function syncComposerControls() {
    const input = $("swarm-composer-input");
    const send = $("swarm-composer-send");
    if (!input || !send) return;
    input.disabled = opaqueWriteBlocked || !selectedSwarmId || registry().some(c => c.name === channel && c.archived);
    const disabled = input.disabled || posting;
    send.disabled = disabled || !input.value.trim();
  }

  function filterBoard(all) {
    const query = $("swarm-search").value.trim().toLowerCase();
    const from = $("swarm-from").value;
    const target = $("swarm-mentioned").value;
    return all.filter(m => (channel === "*" || m.channel === channel)
      && (!from || m.from_agent === from) && (!target || recipients(m).includes(target))
      && (!query || [m.text, m.from_agent, m.channel, "#" + m.seq].join(" ").toLowerCase().includes(query)));
  }

  function renderBoard() {
    const feed = $("swarm-board-feed");
    const wrap = $("swarm-board-wrap");
    const empty = $("swarm-board-empty");
    const all = messages();
    renderBoardTools(all);
    const visible = filterBoard(all);
    const self = typeof overview.self === "string"
      ? overview.roster.find(member => member.name === overview.self) ?? { name: overview.self }
      : overview.self;
    const mounted = selectBoardRows(visible, BOARD_WINDOW, focusSeq);
    const divider = unreadBoundary(mounted, self, overview.unseen);
    $("swarm-earlier").hidden = !historyCursor?.hasMore && mounted[0] === visible[0];
    $("swarm-earlier").disabled = Boolean(loadOlder);
    $("swarm-latest").hidden = following;
    $("swarm-follow").checked = following;
    empty.hidden = visible.length > 0;
    empty.querySelector(".empty-title").textContent = tr(all.length ? "没有符合筛选条件的消息" : "消息板暂无消息");
    empty.querySelector("p:last-child").hidden = Boolean(all.length);
    renderMentionChips();
    renderReplyBanner();
    syncComposerControls();

    const key = JSON.stringify([locale(), opaqueWriteBlocked, selectedSwarmId, boardRevision, mounted.map(m => m.seq), divider]);
    if (feed.dataset.key === key) return;
    feed.dataset.key = key;
    const old = new Map([...feed.children].map(el => [el.dataset.seq ?? "divider", el]));
    const desired = [];
    const predecessor = new Map(all.map((message, index) => [message, all[index - 1]]));
    mounted.forEach((msg, index) => {
      const previous = mounted[index - 1];
      const grouped = msg.seq !== divider && predecessor.get(msg)?.seq === previous?.seq && boardGroup(previous, msg);
      if (msg.seq === divider) desired.push(node("li", tr("未读消息"), "sw-unread-divider"));
      const itemKey = JSON.stringify([locale(), opaqueWriteBlocked, grouped, msg, self?.name]);
      const existing = old.get(String(msg.seq));
      if (existing?.dataset.key === itemKey) { desired.push(existing); return; }
      const li = node("li", "", "swarm-msg");
      li.dataset.seq = String(msg.seq);
      li.tabIndex = 0;
      li.dataset.key = itemKey;
      li.classList.toggle("sw-grouped", grouped);
      li.classList.toggle("sw-addressed", Boolean(self?.name && recipients(msg).includes("@" + self.name)));
      li.dataset.kind = msg.kind || "message";
      li.dataset.from = msg.from_agent || "";

      const head = node("div", "", "swarm-msg-head");
      const seqEl = node("span", `#${msg.seq}`, "swarm-seq mono");
      const sender = node("span", senderDisplayName(msg.from_agent), "swarm-sender-pill");
      sender.dataset.palette = agentPaletteIndex(msg.from_agent);
      sender.title = `@${msg.from_agent}`;
      head.append(seqEl, sender);
      head.append(node("span", "#" + (msg.channel || "main"), "sw-meta-pill mono"));
      const to = recipients(msg);
      if (to.length) head.append(node("span", "→ " + to.join(" "), "sw-recipients"));
      if (msg.control) li.classList.add("sw-control");

      if (msg.kind && msg.kind !== "message" && Object.hasOwn(KIND_LABELS, msg.kind)) {
        const badge = node("span", tr(KIND_LABELS[msg.kind]), "swarm-kind-badge");
        badge.dataset.kind = msg.kind;
        head.append(badge);
      }
      if (msg.reply_to_seq) {
        head.append(citation(msg.reply_to_seq));
      }
      const stamp = formatStamp(msg.created_at);
      if (stamp) {
        const time = node("span", stamp, "swarm-time");
        time.title = `#${msg.seq} · ${msg.created_at}`;
        head.append(time);
      }
      head.hidden = grouped && JSON.stringify(to) === JSON.stringify(recipients(previous));
      li.append(head);

      const body = node("div", "", "swarm-msg-body");
      for (const token of tokenizeBoardText(msg.text)) {
        if (token.type === "seq_ref") {
          body.append(citation(token.seq));
        } else if (token.type === "mention" || token.type === "channel_mention") {
          body.append(node("span", token.value, "swarm-mention mono"));
        } else if (token.type === "done") {
          body.append(node("span", token.value, "swarm-done-tag mono"));
        } else {
          body.append(document.createTextNode(token.value));
        }
      }
      if (String(msg.text).length > 700) {
        const more = node("button", tr("展开全文"), "btn-ghost");
        more.type = "button"; more.setAttribute("aria-expanded", "false");
        body.classList.add("sw-collapsed-text");
        more.onclick = () => {
          const expanded = !body.classList.toggle("sw-collapsed-text");
          more.setAttribute("aria-expanded", String(expanded));
          more.textContent = tr(expanded ? "收起全文" : "展开全文");
        };
        li.append(body, more);
      } else li.append(body);

      if (Array.isArray(msg.screenshots) && msg.screenshots.length) {
        const chips = node("div", "", "swarm-msg-shots");
        const shotLookup = new Map((overview?.screenshots || [])
          .filter((s) => s.seq === msg.seq)
          .map((s) => [s.path, s]));
        for (const shot of msg.screenshots) {
          const enriched = shotLookup.get(shot.path) || { seq: msg.seq, from_agent: msg.from_agent, ...shot };
          chips.append(makeScreenshotChip(enriched));
        }
        li.append(chips);
      }

      if (!msg.control && !opaqueWriteBlocked && msg.from_agent && msg.from_agent !== "human") {
        const actions = node("div", "", "swarm-msg-actions");
        const replyBtn = node("button", tr("回复 @{0}", msg.from_agent), "btn-ghost swarm-reply-btn");
        replyBtn.type = "button";
        replyBtn.addEventListener("click", () => startReplyTo(msg));
        actions.append(replyBtn);
        li.append(actions);
      }

      desired.push(li);
    });
    const wanted = new Set(desired);
    for (const child of [...feed.children]) if (!wanted.has(child)) child.remove();
    desired.forEach((child, index) => {
      const actual = feed.children[index];
      if (actual !== child) feed.insertBefore(child, actual ?? null);
    });
    if (following) wrap.scrollTop = wrap.scrollHeight;
  }

  function render() {
    updateStandaloneLink();
    renderHeader();
    const hasSwarm = Boolean(selectedSwarmId && overview?.swarm);
    const showLoading = !listLoaded && loading && !hasSwarm;
    $("swarm-loading").hidden = !showLoading;
    $("swarm-empty").hidden = showLoading || hasSwarm;
    for (const name of tabs) $("swarm-sub-" + name).hidden = !hasSwarm || subtab !== name;
    $("swarm-view-overview").hidden = !hasSwarm || subtab !== "overview";
    $("swarm-view-board").hidden = !hasSwarm || subtab !== "board";

    if (!hasSwarm && !showLoading) {
      const inSessionEmpty = scope === "session";
      put("swarm-empty-title", inSessionEmpty ? tr("当前会话暂无 Swarm") : tr("暂无协作 Swarm"));
      put("swarm-empty-message", inSessionEmpty
        ? tr("当前会话尚无 Swarm，可切换到「全部」查看其他工作区协作。")
        : tr("在当前会话发起任务后，工位会显示在这里。"));
      $("swarm-empty-show-all").hidden = !inSessionEmpty;
    }

    if (hasSwarm) {
      if (subtab === "overview") renderOverview();
      if (subtab === "board") { renderBoard(); void fillBoardWindow(); }
      if (subtab === "members") renderMembers();
      if (subtab === "graph") renderGraph();
      if (subtab === "raw") void renderRaw();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!active || document.hidden) return;
    pollTimer = setTimeout(() => void refresh({ silent: true }), overview ? 1500 : 3000);
  }

  async function refresh({ silent = false, forceBoard = false } = {}) {
    if (fetching) { fetchWanted ||= forceBoard ? "full" : "delta"; return; }
    fetching = true;
    const version = selectionVersion;
    fetchWanted = false;
    clearTimeout(pollTimer);
    if (!silent && !listLoaded) { loading = true; render(); }
    let needsRender = true;
    try {
      const requested = linkedSwarmId || selectedSwarmId;
      const result = await read("snapshot", snapshotQuery({
        swarmId: requested, scope, cursor: forceBoard ? null : cursor,
      }));
      if (version !== selectionVersion) return;
      listLoaded = true;
      if (result.unchanged) { needsRender = false; return; }
      if (Array.isArray(result.swarms)) {
        swarms = result.swarms.map(item => ({ ...item, id: item.id ?? item.swarm_id }));
        activeWorkersTotal = swarms.reduce((sum, item) => sum + (item.counts?.active || 0), 0);
        updateTabBadge(activeWorkersTotal);
      }
      const nextId = result.empty ? null : result.swarm_id;
      if (nextId !== selectedSwarmId) {
        if (nextId) resetBoardCache();
        selectedSwarmId = nextId;
      }
      if (!nextId) {
        cursor = historyCursor = null; overview = null; boardBySeq.clear();
        setError("");
        return;
      }
      const delta = result.mode === "delta" && !result.reset && cursor;
      const rows = (result.messages || []).map(normalizeMessage);
      if (!delta) {
        boardBySeq.clear();
        for (const message of rows) boardBySeq.set(message.seq, message);
        historyLowerBound = result.beforeSeq || rows[0]?.seq || null;
        historyCursor = { offset: result.offset ?? 0,
          hasMore: result.hasMore };
      } else {
        for (const message of rows) boardBySeq.set(message.seq, message);
      }
      cursor = { etag: result.etag, head: result.head, rosterKey: result.rosterKey, viewKey: result.viewKey,
        known: result.totalMessages };
      if (historyCursor) historyCursor.rosterKey = result.rosterKey;
      boardHead = result.head;
      boardRevision++;
      const members = (result.members || []).map(member => ({ ...member, state: member.state ?? member.status }));
      const grouped = memberGroups(members);
      const plan = result.plan || {};
      overview = { ...result,
        swarm: { id: nextId, title: result.title, goal_title: plan.goal?.title, goal_line: plan.goal?.line, threads: plan.threads },
        roster: members.map(member => ({ ...member, task_summary: plan.tasks?.[member.name] ?? member.task_summary })),
        pinned: Array.isArray(result.pinnedMessages) ? result.pinnedMessages.map(normalizeMessage)
          : (delta ? overview?.pinned || [] : []),
        screenshots: result.frames || [],
        system_attention: result.attention || [],
        counts: { active: grouped.active.length, working: grouped.active.filter(m => m.state === "working").length,
          waiting: grouped.waiting.filter(m => m.state === "waiting").length,
          waiting_reply: grouped.active.filter(m => m.state === "waiting_reply").length,
          stopped: grouped.waiting.filter(m => m.state === "stopped").length, killed: grouped.killed.length, total: members.length },
      };
      if (!swarms.some(item => item.id === nextId)) swarms = [{ id: nextId, title: result.title }, ...swarms];
      setError("");
    } catch (error) {
      if (version !== selectionVersion) return;
      listLoaded = true;
      setError(errorText(error.message));
    } finally {
      loading = false;
      fetching = false;
      if (needsRender) render();
      if (fetchWanted) void refresh({ silent: true, forceBoard: fetchWanted === "full" });
      else schedulePoll();
    }
  }

  async function pollBadge() {
    if (active || document.hidden || !transport.swarm) return;
    try {
      const listRes = await transport.swarm("list", { scope });
      activeWorkersTotal = Number(listRes.active_workers_total ?? 0);
      updateTabBadge(activeWorkersTotal);
    } catch {
      /* Badge refresh is best-effort. */
    }
  }

  function handleWriteError(error, statusFn) {
    if (error?.status === 403 && /invalid origin/i.test(String(error.message || ""))) {
      opaqueWriteBlocked = true;
      render();
    }
    const msg = errorText(error?.message || "Request failed");
    if (statusFn) statusFn(msg, true);
    else showToast?.(msg, "error");
  }

  async function submitPost() {
    const input = $("swarm-composer-input");
    const text = input?.value.trim();
    if (!selectedSwarmId || !text || posting || input.disabled) return;
    const version = selectionVersion;
    posting = true;
    syncComposerControls();
    setComposerStatus(tr("发送中…"));
    try {
      const payload = {
        swarm_id: selectedSwarmId,
        text,
        channel: channel === "*" ? $("swarm-target").value : channel,
        ...(replyTo?.seq ? { reply_to_seq: replyTo.seq } : {}),
      };
      const res = await transport.swarm("post", payload);
      if (version !== selectionVersion) return;
      input.value = "";
      replyTo = null;
      if (res?.message) {
        boardBySeq.set(res.message.seq, res.message);
        boardRevision++;
      }
      const delivered = (res?.deliveries || []).filter(d => ["reply", "steer", "wake"].includes(d.mode)).map(d => "@" + d.worker);
      setComposerStatus(delivered.length
        ? tr("已发送 #{0} · 已传达 {1}", res.head, delivered.join(", "))
        : tr("已发送 #{0}", res.head));
      render();
      void refresh({ silent: true });
    } catch (error) {
      if (version === selectionVersion) handleWriteError(error, setComposerStatus);
    } finally {
      posting = false;
      syncComposerControls();
    }
  }

  async function runWorkerAction(action, name, extras = {}) {
    if (!selectedSwarmId || busyWorkerAction || opaqueWriteBlocked) return;
    busyWorkerAction = `${action}:${name}`;
    pendingConfirm = null;
    render();
    try {
      await transport.swarm("action", { swarm_id: selectedSwarmId, action, name, ...extras });
      showToast?.(tr({ kill: "已终止工位 {0}", interrupt: "已中断 {0}", model: "已切换 {0} 的模型" }[action], name));
      await refresh({ silent: true });
    } catch (error) {
      handleWriteError(error);
    } finally {
      busyWorkerAction = null;
      render();
    }
  }

  async function submitTitle(event) {
    event.preventDefault();
    const nextTitle = $("swarm-title-input").value.trim();
    if (!selectedSwarmId || !nextTitle || savingTitle || opaqueWriteBlocked) return;
    savingTitle = true;
    $("swarm-title-save").disabled = true;
    try {
      await transport.swarm("action", { swarm_id: selectedSwarmId, action: "title", title: nextTitle });
      editingTitle = false;
      showToast?.(tr("已重命名 Swarm"));
      await refresh({ silent: true });
    } catch (error) {
      handleWriteError(error);
    } finally {
      savingTitle = false;
      $("swarm-title-save").disabled = false;
    }
  }

  function setSubtab(next, { focus = false } = {}) {
    if (!tabs.includes(next)) return;
    if (next !== "graph") stopReplay();
    if (next !== "overview") removeNarratorFrame();
    subtab = next;
    render();
    if (next === "graph" && overview && historyCursor?.hasMore) void loadFullGraph();
    if (focus) $(`swarm-subtab-${next}`)?.focus();
    if (next === "board" && following) {
      const wrap = $("swarm-board-wrap");
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function changeScope(next) {
    if (next === scope) return;
    scope = next;
    linkedSwarmId = null;
    listLoaded = false;
    selectedSwarmId = null;
    overview = null;
    resetBoardCache();
    render();
    void refresh();
  }


  function recipients(msg) {
    const tokens = tokenizeBoardText(msg.text).filter(t => t.type === "mention" || t.type === "channel_mention");
    return [...new Set([...tokens.map(t => t.value.toLowerCase()), ...(msg.mentions || []).map(name =>
      "@" + name.replace(/^@/, "")), ...(msg.all ? ["@all"] : [])])];
  }

  function citation(seq) {
    const btn = node("button", "#" + seq, "sw-citation mono");
    btn.type = "button";
    btn.setAttribute("aria-label", tr("跳转到消息 #{0}", seq));
    btn.onclick = () => jumpTo(seq);
    return btn;
  }

  async function loadHistory(fromSeq) {
    if (!cursor || !historyCursor?.offset || !historyLowerBound || loadOlder) return null;
    const version = selectionVersion;
    const target = historyCursor;
    const marker = {};
    loadOlder = marker;
    $("swarm-earlier").disabled = true;
    try {
      const response = await read("messages", historyQuery(selectedSwarmId, {
        rosterKey: cursor.rosterKey, offset: target?.offset ?? 0,
      }, historyLowerBound, fromSeq));
      if (selectionVersion !== version) return null;
      if (response.stale || (response.rosterKey && response.rosterKey !== cursor?.rosterKey)) {
        await refresh({ silent: true, forceBoard: true });
        return null;
      }
      const rows = (response.messages || []).map(normalizeMessage);
      for (const message of rows) boardBySeq.set(message.seq, message);
      // A citation page can lie apart from the tail. Only a sequential page
      // moves the older-history cursor.
      if (fromSeq == null && rows.length && target === historyCursor) {
        historyLowerBound = rows[0].seq;
        historyCursor = { ...target, hasMore: response.hasMore,
          offset: response.offset ?? Math.max(0, target.offset - rows.length) };
      }
      boardRevision++;
      return response;
    } catch (error) {
      if (version === selectionVersion) showToast?.(errorText(error.message));
      return null;
    } finally {
      if (loadOlder === marker) {
        loadOlder = null;
        $("swarm-earlier").disabled = false;
      }
    }
  }

  async function fillBoardWindow() {
    if (loadOlder || !historyCursor?.hasMore || boardBySeq.size >= BOARD_WINDOW) return;
    const version = selectionVersion;
    const result = await loadHistory();
    if (result && version === selectionVersion && subtab === "board") renderBoard();
  }

  async function loadFullGraph() {
    const version = selectionVersion;
    if (loadingGraph || !historyCursor?.hasMore) return;
    loadingGraph = true;
    $("swarm-full-graph").disabled = true;
    try {
      while (version === selectionVersion && subtab === "graph" && historyCursor?.hasMore) {
        const oldOffset = historyCursor.offset;
        if (!await loadHistory() || historyCursor.offset >= oldOffset) break;
      }
      if (version === selectionVersion && subtab === "graph") renderGraph();
    } finally {
      loadingGraph = false;
      $("swarm-full-graph").disabled = false;
    }
  }

  async function showEarlier() {
    const version = selectionVersion;
    const wrap = $("swarm-board-wrap");
    const first = Number($("swarm-board-feed").querySelector("[data-seq]")?.dataset.seq);
    const before = filterBoard(messages());
    const previous = before.findIndex(message => message.seq === first);
    if (historyCursor?.hasMore && previous < BOARD_WINDOW) await loadHistory();
    if (version !== selectionVersion || subtab !== "board") return;
    following = false;
    const visible = filterBoard(messages());
    const anchor = visible.findIndex(message => message.seq === first);
    focusSeq = visible[Math.max(0, anchor - Math.floor(BOARD_WINDOW / 2) + 20)]?.seq ?? null;
    renderBoard();
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function jumpTo(seq) {
    seq = Number(seq);
    if (!Number.isSafeInteger(seq) || seq <= 0) return;
    const version = selectionVersion;
    if (!boardBySeq.has(seq) && historyCursor?.hasMore) await loadHistory(seq);
    if (version !== selectionVersion) return;
    const msg = boardBySeq.get(seq);
    if (!msg) { showToast?.(tr("找不到消息 #{0}", seq)); return; }
    if (channel !== "*" && channel !== (msg.channel || "main")) channel = "*";
    $("swarm-from").value = $("swarm-mentioned").value = $("swarm-search").value = "";
    following = false; focusSeq = seq;
    setSubtab("board");
    const el = $("swarm-board-feed").querySelector(`[data-seq="${seq}"]`);
    if (!el) return;
    el.tabIndex = -1; el.focus({ preventScroll:true }); el.scrollIntoView({block:"center"});
    el.classList.remove("sw-jump"); void el.offsetWidth; el.classList.add("sw-jump");
  }

  function renderAttention() {
    const roster = overview.roster || [];
    const attention = $("swarm-attention");
    const alerts = overview.system_attention || [];
    const labels = { error:"错误", quota:"配额暂停", stuck:"工位无更新", stall:"协作停滞" };
    attention.hidden = !alerts.length;
    attention.replaceChildren(...alerts.map(a => {
      const actor = a.agent ?? a.member;
      const worker = roster.find(w => w.name === actor);
      const row = node("button","","sw-alert");
      row.type = "button"; row.dataset.severity = a.kind;
      row.append(node("strong",tr(labels[a.kind] || "需要关注")),node("span",[actor && ("@"+actor),errorText(a.text ?? a.title)].filter(Boolean).join(" · ")));
      const seq = a.seq || Number(a.text?.match(/#(\d+)/)?.[1]) || worker?.last_post_seq || boardHead;
      row.onclick = () => worker?.run_id && a.kind!=="stall" ? navigate("live",{id:worker.run_id,focus:true}) : seq ? jumpTo(seq) : setSubtab("board");
      return row;
    }));
  }

  function selectOptions(id, entries) {
    const select = $(id), key = JSON.stringify(entries);
    if (select.dataset.key === key) return;
    const previous = select.value;
    select.replaceChildren(...entries.map(([value,label]) => new Option(label,value)));
    if (entries.some(([value]) => previous===value)) select.value=previous;
    select.dataset.key=key;
  }

  function renderBoardTools(all) {
    const channels = registry().filter(c=>c.name!=="main");
    const choices = [["*",tr("全部")],["main","#main"],...channels.map(c=>[c.name,c.archived ? tr("#{0}（已归档）",c.name) : "#"+c.name])];
    const authors = new Set(all.map(m=>m.from_agent));
    const targets = new Set(all.flatMap(recipients));
    selectOptions("swarm-from",[["",tr("全部")],...[...authors].sort().map(n=>[n,"@"+n])]);
    selectOptions("swarm-mentioned",[["",tr("全部")],...[...targets].sort().map(n=>[n,n])]);
    selectOptions("swarm-channel-filter",choices);
    $("swarm-channel-filter").value=channel;
    selectOptions("swarm-target",[["main","#main"],...channels.filter(c=>!c.archived).map(c=>[c.name,"#"+c.name])]);
    $("swarm-target-label").hidden = channel !== "*" || !channels.some(c => !c.archived) || opaqueWriteBlocked;
    $("swarm-channel-actions").hidden = opaqueWriteBlocked;
    $("swarm-archive").hidden=opaqueWriteBlocked || !channels.some(c=>c.name===channel && !c.archived);
    $("swarm-archive").disabled=channelBusy;
  }

  async function writeChannel(op) {
    if (opaqueWriteBlocked || channelBusy || !selectedSwarmId) return;
    const name = op==="create" ? $("swarm-channel-name").value.trim() : channel;
    const version=selectionVersion;
    channelBusy=true;
    const form=$("swarm-channel-form");form.querySelector("button").disabled=true;$("swarm-archive").disabled=true;
    try {
      await transport.swarm("action",{swarm_id:selectedSwarmId, action:"channel", op, channel:name, ...(op==="create" ? {topic:$("swarm-channel-topic").value.trim()} : {})});
      if(version!==selectionVersion) return;
      form.reset(); $("swarm-channel-actions").open = false;
      channel=op==="create" ? name : "*";
      await refresh({silent:true});
    } catch(e) {handleWriteError(e);}
    finally {channelBusy=false;form.querySelector("button").disabled=false;$("swarm-archive").disabled=false;}
  }

  function graphData() {
    const key=JSON.stringify([selectedSwarmId,boardRevision,overview.roster,overview.channels,overview.system_attention,overview.swarm]);
    if(key!==graphKey) {snapshot=graphSnapshot(overview,messages());graphKey=key;graphDrawKey="";}
    return snapshot;
  }

  function hiveGroups(seq) {
    const groups=groupWorkersByThreads(overview.swarm.threads,overview.roster);
    const threads=groups.filter(g=>!g.isDefault && !g.isOther).map(g=>({id:"thread:"+g.id,title:g.title,goal:g.goal,names:g.workers.map(w=>w.name)}));
    let channelsAtStep = registry();
    if (seq != null) {
      const history = messages();
      const past = history.filter(m => m.seq <= seq);
      const index = past.length - 1;
      const members = overview.roster.map(w => ({
        name: w.name,
        channels: effectiveChannels(w.role, channelsAt(w.name, w.channels, history)[index], w.name),
      }));
      channelsAtStep = channelRegistry(past).map(c => ({
        ...c, members: members.filter(w => w.channels.includes("*") || w.channels.includes(c.name)).map(w => w.name),
      }));
    }
    const channels = channelsAtStep.filter(c => !c.archived && c.name !== "main").map(c => ({
      id: "channel:" + c.name, title: "#" + c.name, goal: c.topic, names: (c.members || []).filter(n => n !== "coordinator"),
    }));
    const result=[...threads,...channels];
    const assigned=new Set(result.flatMap(g=>g.names));
    const rest=overview.roster.filter(w=>!assigned.has(w.name) && w.name!=="coordinator");
    if (result.length && rest.length) result.push({id:"other",title:tr("其他工位"),names:rest.map(w=>w.name)});
    return result;
  }

  function graphOptions() {
    return {step,expandAll:$("swarm-expand").checked,hideInactive:$("swarm-hide-inactive").checked,
      real:$("swarm-pace").value==="real",speed:Number($("swarm-speed").value)};
  }

  function renderGraph() {
    const data=graphData(), posts=data.messages, n=posts.length;
    if (step!==null) step=Math.min(step,n);
    const current=step===null ? null : posts[step-1];
    const options=graphOptions(), isHive=graphMode==="hive";
    $("swarm-full-graph").hidden = !historyCursor?.hasMore;
    $("swarm-export").hidden = isHive;
    $("swarm-hive-view").hidden=!isHive;$("swarm-mentions-wrap").hidden=isHive;
    for(const btn of document.querySelectorAll("[data-graph-mode]")) btn.setAttribute("aria-pressed",String(btn.dataset.graphMode===graphMode));
    $("swarm-hide-label").hidden=$("swarm-expand-label").hidden=isHive;
    const scrubber=$("swarm-scrubber");scrubber.max=n;scrubber.value=step ?? n;
    put("swarm-step",(step ?? n)+" / "+n);
    put("swarm-play",playing ? "Ⅱ" : "▶");
    $("swarm-play").title=tr(playing ? "暂停" : "播放");$("swarm-play").setAttribute("aria-label",$("swarm-play").title);
    $("swarm-play").disabled=!n;$("swarm-prev").disabled=(step ?? n)===0;$("swarm-next").disabled=(step ?? n)>=n;
    $("swarm-live").setAttribute("aria-pressed",String(step===null));
    const svg=$("swarm-mentions-svg");
    const key=JSON.stringify([graphKey,locale(),graphMode,step,options.expandAll,options.hideInactive,svg.clientWidth]);
    if(key===graphDrawKey) return;
    graphDrawKey=key;
    if(isHive) {
      hive ??= createHiveView($("swarm-hive-view"));
      const seq = step === null ? null : current?.seq || 0;
      hive.update(data, hiveGroups(seq), seq);
    } else renderMentions(svg,data,options);
    const legend=isHive ? [["progress","任务完成度"],["beam","最近消息"],["waiting","等待回复"]] :
      [["direct","直接提及"],["waiting","群发或频道提及"],["ring","未指定接收者"]];
    $("swarm-legend").replaceChildren(...legend.map(([kind,label])=>{
      const item=node("span"); item.append(node("i","","sw-key-"+kind),document.createTextNode(tr(label)));return item;
    }));
    const caption=$("swarm-replay-caption");
    const post=step===null ? posts.at(-1) : current;
    if(post) caption.replaceChildren(citation(post.seq),node("strong","@"+post.agent),node("span",post.text));
    else caption.textContent=tr(n ? "回放起点" : "消息板暂无消息");
  }

  function stopReplay() {clearTimeout(replayTimer);playing=false;}
  function seek(value) {stopReplay();step=value;renderGraph();}
  function scheduleStep() {
    const posts=graphData().messages;
    if(step>=posts.length) {stopReplay();renderGraph();return;}
    const {real,speed}=graphOptions();
    replayTimer=setTimeout(()=>{step++;renderGraph();scheduleStep();},replayDelay(posts,step,real,speed));
  }
  async function exportReplay() {
    if(exporting || !overview || graphMode !== "mentions") return;
    const version=selectionVersion, btn=$("swarm-export");
    exporting=true;btn.disabled=true;btn.textContent=tr("导出中…");
    try {
      const {dataUrl,filename}=await exportGraphGif(graphData(),{...graphOptions(),width:$("swarm-sub-graph").clientWidth,
        onProgress:n=>{btn.textContent=tr("导出中 {0}%",n);}});
      if(version!==selectionVersion || !active || subtab!=="graph" || graphMode !== "mentions") return;
      const dialog = node("dialog");
      dialog.id = "swarm-gif-modal";
      dialog.setAttribute("aria-labelledby", "swarm-gif-title");
      const title = node("h2", tr("关系图回放")); title.id = "swarm-gif-title";
      const img = node("img"); img.id = "swarm-gif-preview"; img.src = dataUrl; img.alt = tr("提及关系动画");
      const actions = node("form", "", "sw-tool-row"); actions.method = "dialog";
      const download = node("a", tr("下载 GIF"), "btn-primary");
      download.id = "swarm-download"; download.href = dataUrl; download.download = filename;
      const open = node("button", tr("在新窗口打开"), "btn-ghost");
      open.type = "button";
      open.onclick = () => {
        const preview = window.open("", "_blank");
        if (!preview) return;
        const image = preview.document.createElement("img");
        image.alt = img.alt; image.src = dataUrl; image.style.maxWidth = "100%";
        preview.document.title = title.textContent;
        preview.document.body.append(image);
        preview.opener = null;
      };
      const close = node("button", tr("关闭"), "btn-ghost"); close.autofocus = true;
      actions.append(download, open, close); dialog.append(title, img, actions);
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
      $("swarm-panel").append(dialog);
      btn.disabled = false; btn.focus({ preventScroll: true });
      dialog.showModal();
    } catch(e) {showToast?.(errorText(e.message));}
    finally {exporting=false;btn.disabled=false;btn.textContent=tr("导出提及 GIF");}
  }

  // Event bindings
  $("swarm-picker")?.addEventListener("change", (event) => {
    const next = event.target.value || null;
    if (next && next !== selectedSwarmId) {
      linkedSwarmId = null;
      selectedSwarmId = next;
      overview = null;
      editingTitle = false;
      resetBoardCache();
      render();
      void refresh({ forceBoard: true });
    }
  });
  $("swarm-scope-session")?.addEventListener("click", () => changeScope("session"));
  $("swarm-scope-all")?.addEventListener("click", () => changeScope("all"));
  $("swarm-empty-show-all")?.addEventListener("click", () => changeScope("all"));
  $("swarm-edit-title")?.addEventListener("click", () => {
    editingTitle = true;
    const input = $("swarm-title-input");
    input.value = overview?.swarm?.title || "";
    renderHeader();
    input.focus();
    input.select();
  });
  $("swarm-title-cancel")?.addEventListener("click", () => {
    editingTitle = false;
    renderHeader();
  });
  $("swarm-title-form")?.addEventListener("submit", (event) => void submitTitle(event));

  for (const name of tabs) {
    const btn = $(`swarm-subtab-${name}`);
    btn?.addEventListener("click", () => setSubtab(name));
    btn?.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? "overview"
          : event.key === "End" ? tabs.at(-1)
            : tabs[(tabs.indexOf(name) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        setSubtab(next, { focus: true });
      }
    });
  }

  $("swarm-composer-input")?.addEventListener("input", syncComposerControls);
  $("swarm-composer-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submitPost();
    }
  });
  $("swarm-composer-send")?.addEventListener("click", () => void submitPost());
  $("swarm-reply-clear")?.addEventListener("click", () => {
    replyTo = null;
    renderReplyBanner();
  });
  $("swarm-copy-link")?.addEventListener("click", () => {
    const href = $("swarm-copy-link").dataset.href || transport.installPage || "";
    if (href) void copy(href);
  });


  $("swarm-show-killed").onchange = event => { showKilled = event.target.checked; renderMembers(); };
  $("swarm-earlier").onclick = () => void showEarlier();
  function followLatest() {
    following = true; focusSeq = null;
    renderBoard();
    const wrap = $("swarm-board-wrap"); wrap.scrollTop = wrap.scrollHeight;
  }
  $("swarm-latest").onclick = followLatest;
  $("swarm-follow").onchange = event => {
    if (event.target.checked) followLatest();
    else { following = false; $("swarm-latest").hidden = false; }
  };
  $("swarm-board-wrap").onscroll = () => {
    const wrap = $("swarm-board-wrap");
    if (!following || wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 48) return;
    following = false; $("swarm-follow").checked = false; $("swarm-latest").hidden = false;
  };
  $("swarm-clear-filters").onclick = () => {
    channel = "*";
    $("swarm-search").value = $("swarm-from").value = $("swarm-mentioned").value = "";
    focusSeq = null;
    renderBoard();
  };
  $("swarm-narrator-mode").onclick = () => {
    narratorRequested = narratorFailure || !narratorRequested;
    narratorFailure = false;
    renderNarrator();
  };
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => {
    narratorInputsAt = performance.now();
  }, true);
  window.addEventListener("message", event => {
    const frame = narratorFrame, data = event.data;
    if (!frame || event.source !== frame.contentWindow || !data || typeof data !== "object") return;
    if (data.type === "READY") {
      frame.contentWindow?.postMessage({ type: "THEME", theme: narratorTheme() }, "*");
    } else if (data.type === "RENDERED" && Number.isFinite(data.height)) {
      clearTimeout(narratorWatchdog);
      frame.style.height = `${Math.max(120, Math.min(20000, data.height))}px`;
    } else if (data.type === "ERROR") narratorFallback();
    else if (["NAVIGATE", "FEEDBACK_INTENT"].includes(data.type)) {
      const now = performance.now();
      if (!navigator.userActivation?.isActive || document.activeElement !== frame
        || now - narratorInputsAt < 5500 || now - narratorActivationAt < 250
        || typeof (data.target_id ?? data.action?.target) !== "string"
        || String(data.target_id ?? data.action?.target).length > 2048) return;
      narratorActivationAt = now;
      setTimeout(() => {
        if (narratorFrame !== frame || document.activeElement !== frame || narratorInputsAt >= now) return;
        if (data.type === "NAVIGATE") narratorAction(data.action);
        else requestFeedback(data.target_id);
      }, 100);
    }
  });
  const sendNarratorTheme = () => {
    narratorFrame?.contentWindow?.postMessage({ type: "THEME", theme: narratorTheme() }, "*");
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sendNarratorTheme);
  new MutationObserver(sendNarratorTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ["style", "data-theme"],
  });
  $("swarm-reel").ontoggle = () => { if ($("swarm-reel").open) renderFrameThumbnails(); };
  $("swarm-raw-kind").onchange = () => void renderRaw();
  $("swarm-raw-copy").onclick = () => void copy($("swarm-raw").textContent);
  $("swarm-filter-toggle").onclick = e => {
    const filters=$("swarm-filters");filters.hidden=!filters.hidden;
    e.currentTarget.setAttribute("aria-expanded",String(!filters.hidden));
  };
  $("swarm-channel-form").onsubmit = e => {e.preventDefault();void writeChannel("create");};
  $("swarm-archive").onclick = () => void writeChannel("archive");
  $("swarm-search").oninput = () => { focusSeq = null; renderBoard(); };
  $("swarm-from").onchange = $("swarm-mentioned").onchange = renderBoard;
  $("swarm-channel-filter").onchange = e => {channel=e.target.value;replyTo=null;renderReplyBanner();renderBoard();};
  for(const btn of document.querySelectorAll("[data-graph-mode]")) btn.onclick=()=>{graphMode=btn.dataset.graphMode;renderGraph();};
  $("swarm-hide-inactive").onchange=$("swarm-expand").onchange=renderGraph;
  $("swarm-scrubber").oninput=e=>seek(Number(e.target.value));
  $("swarm-start").onclick=()=>seek(0);
  $("swarm-prev").onclick=()=>seek(Math.max(0,(step ?? graphData().messages.length)-1));
  $("swarm-next").onclick=()=>seek(Math.min(graphData().messages.length,(step ?? 0)+1));
  $("swarm-live").onclick=()=>seek(null);
  $("swarm-play").onclick=()=>{
    if(playing) stopReplay();
    else {
      if(step===null || step===graphData().messages.length) step=0;
      playing=true;scheduleStep();
    }
    renderGraph();
  };
  $("swarm-speed").onchange=$("swarm-pace").onchange=()=>{if(playing){clearTimeout(replayTimer);scheduleStep();}};
  new ResizeObserver(()=>{if(active && overview && subtab==="graph" && graphMode==="mentions") renderGraph();}).observe($("swarm-mentions-wrap"));
  $("swarm-full-graph").onclick = () => void loadFullGraph();
  $("swarm-export").onclick=()=>void exportReplay();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(pollTimer); stopReplay(); }
    else if (active) void refresh({ silent: true });
  });

  languageLabels.forEach(update => update());
  return {
    setActive(isActive, { swarmId } = {}) {
      active = Boolean(isActive);
      if (!active) { stopReplay(); removeNarratorFrame(); }
      if (swarmId && swarmId !== selectedSwarmId && swarmId !== linkedSwarmId) {
        linkedSwarmId = swarmId;
        selectedSwarmId = swarmId;
        overview = null;
        resetBoardCache();
      }
      clearTimeout(pollTimer);
      if (active) {
        render();
        void refresh();
      }
    },
    refresh: () => refresh({ forceBoard: true }),
    pollBadge,
    renderLanguage() {
      languageLabels.forEach(update => update());
      delete $("swarm-pills").dataset.key;
      delete $("swarm-board-feed").dataset.key;
      render();
    },
    onWorkspaceChange() {
      linkedSwarmId = null;
      listLoaded = false;
      selectedSwarmId = null;
      overview = null;
      resetBoardCache();
      if (active) void refresh({ forceBoard: true });
      else void pollBadge();
    },
  };
}

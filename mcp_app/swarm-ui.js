import { channelsAt, channelRegistry, effectiveChannels } from "../core/swarm-channels.mjs";
import { createBeeAvatar, createHiveView, graphSnapshot, renderMentions, replayDelay, exportGraphGif } from "./swarm-visuals.js";
import { errorText, locale, localizedFormat, tr } from "../magpie_plugin/ui/i18n.js";
import { icon } from "./icons.js";
import { linkTarget } from "./live-state.js";

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
  const dateFmt = localizedFormat(Intl.DateTimeFormat, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  let active = false;
  let scope = sidecar ? "session" : "all";
  const tabs = ["overview", "board", "graph", "raw"];
  let subtab = "overview";
  let channel = "*", channelBusy = false;
  let rawKind = "members", rawRevision = "", rawRequest = 0;
  let graphMode = "hive", step = null, replayTimer, playing = false, exporting = false;
  let graphKey = "", graphDrawKey = "", snapshot, hive, boardRevision = 0;
  let selectionVersion = 0;
  const messages = () => [...boardBySeq.values()].sort((a,b) => a.seq-b.seq);
  const registry = () => overview?.channels || [];
  let swarms = [];
  let allCount = 0;
  let activeWorkersTotal = 0;
  let selectedSwarmId = null;
  let pendingSwarmId = null;
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
    const ms = Date.parse(iso);
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
    stopReplay();
    rawRequest++; rawRevision = graphKey = graphDrawKey = "";
    $("swarm-gif-modal")?.close();
    channel = "*"; step = null; snapshot = null; hive?.reset();
    $("swarm-search").value = ""; $("swarm-from").value = ""; $("swarm-mentioned").value = "";
    $("swarm-target").value = "main"; $("swarm-channel-form").hidden = true;
    $("swarm-new-channel").setAttribute("aria-expanded", "false");
    boardRevision++;
    $("swarm-composer-input").value = "";
    setComposerStatus();
    boardHead = 0;
    boardBySeq.clear();
    replyTo = null;
    pendingConfirm = null;
    delete $("swarm-board-feed").dataset.key;
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
    btn.addEventListener("click", () => openScreenshot(item));
    return btn;
  }

  function renderHeader() {
    const scopeSwitch = $("swarm-scope-switch");
    if (scopeSwitch) {
      scopeSwitch.hidden = !sidecar;
      $("swarm-scope-session").setAttribute("aria-pressed", String(scope === "session"));
      $("swarm-scope-all").setAttribute("aria-pressed", String(scope === "all"));
    }

    const picker = $("swarm-picker");
    const hasSwarm = Boolean(selectedSwarmId && overview?.swarm);
    if (picker) {
      picker.hidden = swarms.length < 2;
      if (swarms.length >= 2) {
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
      }
    }

    const swarm = overview?.swarm;
    const displayTitle = swarm ? (swarm.title || swarm.goal_title || swarm.id) : tr("Swarm 协作");
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
      items.push({ state: "head", label: `#${overview.head ?? boardHead ?? 0}` });

      const key = JSON.stringify(items);
      if (pills.dataset.key !== key) {
        pills.dataset.key = key;
        pills.replaceChildren(...items.map((item) => {
          const pill = node("span", "", "swarm-pill");
          pill.dataset.state = item.state;
          if (item.state !== "head") pill.append(node("span", "", "swarm-dot"));
          pill.append(node("span", item.label));
          return pill;
        }));
      }
    } else {
      pills.hidden = true;
    }

    const subtabs = $("swarm-subtabs");
    subtabs.hidden = !hasSwarm;
    for (const name of tabs) {
      const tab = $(`swarm-subtab-${name}`);
      tab.setAttribute("aria-selected", String(subtab === name));
      tab.tabIndex = subtab === name ? 0 : -1;
    }
    const headCount = overview?.head ?? boardHead ?? 0;
    put("swarm-subtab-board", headCount > 0 ? `${tr("消息板")} (${headCount})` : tr("消息板"));
  }

  function renderWorkerRow(worker) {
    const li = node("li", "", "swarm-worker-row");
    li.dataset.worker = worker.name;
    li.dataset.state = worker.state || "";

    const main = node("div", "", "swarm-worker-main");
    const top = node("div", "", "swarm-worker-top");

    const dot = node("span", "", "swarm-dot");
    dot.dataset.state = worker.state || "";
    const nameEl = node("span", worker.name, "swarm-worker-name mono");
    nameEl.dataset.palette = agentPaletteIndex(worker.name);
    const stateLabel = node("span", tr(WORKER_STATUS_LABELS[worker.state] || "未知"), "swarm-worker-state");
    stateLabel.dataset.state = worker.state || "";

    top.append(createBeeAvatar(worker.name, worker.state), dot, nameEl, stateLabel);
    if (["monitor", "narrator"].includes(worker.role)) top.append(node("span", tr(worker.role === "monitor" ? "监控员" : "记录员"), "sw-meta-pill"));
    if (worker.unread) top.append(node("span", tr("{0} 条未读", worker.unread), "sw-unread"));

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

    if (worker.workspace === "share" || worker.worktree_path) {
      const wt = node("span", "Worktree", "run-kind");
      if (worker.worktree_path) wt.title = worker.worktree_path;
      top.append(wt);
    }

    main.append(top);
    const details = node("div", "", "sw-worker-details");
    for (const ch of worker.channels || []) details.append(node("span", ch === "*" ? tr("全部频道") : "#" + ch, "sw-meta-pill"));
    if (worker.wake_mode) details.append(node("span", tr(worker.wake_mode === "anything" ? "任意消息唤醒" : "提及时唤醒")));
    if (worker.added_by) details.append(node("span", tr("由 @{0} 添加", worker.added_by)));
    if (worker.worktree_path) details.append(node("span", worker.worktree_path, "mono"));
    if (details.childNodes.length) main.append(details);
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
    if (worker.state === "waiting_reply") {
      const waitNote = node("p", worker.parked_on
        ? tr("等待回复（{0}）", worker.parked_on)
        : tr("工位 {0} 正在等待回复", worker.name), "swarm-worker-wait");
      main.append(waitNote);
    }
    if (worker.error) {
      const errEl = node("p", errorText(worker.error), "swarm-worker-error");
      errEl.title = worker.error;
      main.append(errEl);
    }

    const actions = node("div", "", "swarm-worker-actions");
    if (worker.run_id) {
      const streamBtn = node("button", tr("看流"), "btn-ghost swarm-action-btn");
      streamBtn.type = "button";
      streamBtn.title = tr("查看实时流");
      streamBtn.dataset.workerAction = "stream";
      streamBtn.addEventListener("click", () => {
        navigate("live", { id: worker.run_id, focus: true });
      });
      actions.append(streamBtn);
    }

    const canInterrupt = !opaqueWriteBlocked && Boolean(worker.run_id)
      && (worker.state === "working" || worker.state === "waiting_reply");
    const canKill = !opaqueWriteBlocked && worker.state !== "killed";

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
          renderOverview();
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
          renderOverview();
          return;
        }
        if (!busy) void runWorkerAction("kill", worker.name);
      });
      actions.append(btn);
    }

    li.append(main, actions);
    return li;
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

    const overviewKey = JSON.stringify([locale(), selectedSwarmId, overview.roster, overview.swarm.threads, overview.screenshots, overview.system_attention, pendingConfirm, busyWorkerAction, opaqueWriteBlocked]);
    if (container.dataset.key === overviewKey) return;
    container.dataset.key = overviewKey;
    renderTeam();
    const groups = groupWorkersByThreads(overview.swarm.threads, overview.roster);
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
        head.append(node("span", tr("共 {0} 个工位", group.workers.length), "swarm-card-meta"));
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
        for (const worker of group.workers) ul.append(renderWorkerRow(worker));
        card.append(ul);
      } else {
        card.append(node("p", tr("暂无工位"), "swarm-card-empty"));
      }
      return card;
    }));

    const shots = Array.isArray(overview.screenshots) ? overview.screenshots : [];
    shotsCard.hidden = shots.length === 0;
    if (shots.length) {
      put("swarm-screenshots-count", tr("{0} 张截图", shots.length));
      shotsList.replaceChildren(...shots.map((item) => {
        const li = node("li", "", "swarm-shot-item");
        const meta = node("div", "", "swarm-shot-meta");
        meta.append(
          citation(item.seq),
          node("span", senderDisplayName(item.from_agent), "swarm-sender-pill"),
        );
        meta.lastChild.dataset.palette = agentPaletteIndex(item.from_agent);
        const stamp = formatStamp(item.created_at);
        if (stamp) meta.append(node("span", stamp, "swarm-time"));
        li.append(meta);
        if (item.caption) li.append(node("p", item.caption, "swarm-shot-caption"));
        const chip = makeScreenshotChip(item);
        if (!item.restricted_reason && /^data:image\/(?:png|jpeg|webp);base64,/.test(item.thumbnail || "")) {
          const img = node("img"); img.src = item.thumbnail; img.alt = ""; img.loading = "lazy";
          chip.prepend(img);
        }
        li.append(chip);
        return li;
      }));
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
    const disabled = opaqueWriteBlocked || !selectedSwarmId || posting;
    input.disabled = opaqueWriteBlocked || !selectedSwarmId;
    send.disabled = disabled || !input.value.trim();
  }

  function renderBoard() {
    const feed = $("swarm-board-feed");
    const wrap = $("swarm-board-wrap");
    const empty = $("swarm-board-empty");
    const all = messages();
    renderBoardTools(all);
    const query = $("swarm-search").value.trim().toLowerCase(), from = $("swarm-from").value, target = $("swarm-mentioned").value;
    const visible = all.filter(m => (channel === "*" || (m.channel || "main") === channel)
      && (!from || m.from_agent === from) && (!target || recipients(m).includes(target))
      && (!query || [m.text, m.from_agent, m.channel, "#" + m.seq].join(" ").toLowerCase().includes(query)));
    empty.hidden = visible.length > 0;
    empty.querySelector(".empty-title").textContent = tr(all.length ? "没有符合筛选条件的消息" : "消息板暂无消息");
    empty.querySelector("p:last-child").hidden = Boolean(all.length);
    renderMentionChips();
    renderReplyBanner();
    syncComposerControls();

    const key = JSON.stringify([locale(), opaqueWriteBlocked, selectedSwarmId, boardRevision, visible.map(m => m.seq), overview.roster.map(w => w.state)]);
    if (feed.dataset.key === key) return;
    const shouldFollow = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 64 || !feed.dataset.key;
    feed.dataset.key = key;

    feed.replaceChildren(...visible.map((msg) => {
      const li = node("li", "", "swarm-msg");
      li.dataset.seq = String(msg.seq);
      li.dataset.kind = msg.kind || "message";
      li.dataset.from = msg.from_agent || "";

      const head = node("div", "", "swarm-msg-head");
      const seqEl = node("span", `#${msg.seq}`, "swarm-seq mono");
      const sender = node("span", senderDisplayName(msg.from_agent), "swarm-sender-pill");
      sender.dataset.palette = agentPaletteIndex(msg.from_agent);
      sender.title = `@${msg.from_agent}`;
      head.append(createBeeAvatar(msg.from_agent, overview.roster.find(w => w.name === msg.from_agent)?.state || "landed"), seqEl, sender);
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
      if (stamp) head.append(node("span", stamp, "swarm-time"));
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
      li.append(body);

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

      if (msg.kind === "question" && !opaqueWriteBlocked && msg.from_agent && msg.from_agent !== "human") {
        const actions = node("div", "", "swarm-msg-actions");
        const replyBtn = node("button", tr("回复 @{0}", msg.from_agent), "btn-ghost swarm-reply-btn");
        replyBtn.type = "button";
        replyBtn.addEventListener("click", () => startReplyTo(msg));
        actions.append(replyBtn);
        li.append(actions);
      }

      return li;
    }));

    if (shouldFollow) wrap.scrollTop = wrap.scrollHeight;
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
      const inSessionEmpty = sidecar && scope === "session" && allCount > 0;
      put("swarm-empty-title", inSessionEmpty ? tr("当前会话暂无 Swarm") : tr("暂无协作 Swarm"));
      put("swarm-empty-message", inSessionEmpty
        ? tr("当前会话尚无 Swarm，可切换到「全部」查看其他工作区协作。")
        : tr("通过 gpt_swarm 或 gempt swarm 启动协作后，工位与消息板会显示在这里。"));
      $("swarm-empty-show-all").hidden = !inSessionEmpty;
    }

    if (hasSwarm) {
      if (subtab === "overview") renderOverview();
      if (subtab === "board") renderBoard();
      if (subtab === "graph") renderGraph();
      if (subtab === "raw") void renderRaw();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!active || document.hidden) return;
    const hasActiveWorkers = (overview?.counts?.active ?? activeWorkersTotal) > 0;
    pollTimer = setTimeout(() => void refresh({ silent: true }), hasActiveWorkers ? 1800 : 4500);
  }

  async function refresh({ silent = false, forceBoard = false } = {}) {
    if (fetching) { fetchWanted = true; return; }
    fetching = true;
    fetchWanted = false;
    clearTimeout(pollTimer);
    if (!silent && !listLoaded) {
      loading = true;
      render();
    }
    const listVersion = selectionVersion;
    try {
      const listRes = await transport.swarm("list", { scope });
      if (selectionVersion !== listVersion) return;
      listLoaded = true;
      swarms = Array.isArray(listRes.swarms) ? listRes.swarms : [];
      allCount = Number(listRes.all_count ?? swarms.length);
      activeWorkersTotal = Number(listRes.active_workers_total ?? 0);
      updateTabBadge(activeWorkersTotal);

      let nextId = pendingSwarmId || selectedSwarmId;
      pendingSwarmId = null;
      if (nextId && !swarms.some((s) => s.id === nextId)) {
        nextId = null;
      }
      if (!nextId && swarms.length) {
        nextId = swarms[0].id;
      }

      if (nextId !== selectedSwarmId) {
        selectedSwarmId = nextId;
        overview = null;
        editingTitle = false;
        resetBoardCache();
      }

      if (selectedSwarmId) {
        const id = selectedSwarmId, version = selectionVersion;
        const since = forceBoard ? 0 : boardHead;
        const page = (cursor) => transport.swarm("board", { swarm_id: id, since: cursor, limit: 500 });
        let [ovRes, slice] = await Promise.all([transport.swarm("overview", { swarm_id:id }), page(since)]);
        if (version !== selectionVersion) return;
        const head = slice.head, rows = [...(slice.messages || [])];
        while (slice.messages?.length && rows.at(-1).seq < head) {
          const cursor = rows.at(-1).seq;
          slice = await page(cursor);
          if (version !== selectionVersion) return;
          if (!(slice.messages?.at(-1)?.seq > cursor)) break;
          rows.push(...slice.messages);
        }
        overview = ovRes;
        if (forceBoard) boardBySeq.clear();
        if (forceBoard || rows.length) boardRevision++;
        for (const msg of rows) boardBySeq.set(msg.seq, msg);
        boardHead = rows.at(-1)?.seq ?? since;
      } else {
        overview = null;
        resetBoardCache();
      }
      setError("");
    } catch (error) {
      listLoaded = true;
      setError(errorText(error.message));
    } finally {
      loading = false;
      fetching = false;
      render();
      if (fetchWanted) void refresh({ silent: true });
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
    if (!selectedSwarmId || !text || posting || opaqueWriteBlocked) return;
    const version = selectionVersion;
    posting = true;
    syncComposerControls();
    setComposerStatus(tr("发送中…"));
    try {
      const payload = {
        swarm_id: selectedSwarmId,
        text,
        ...($("swarm-target").value ? { channel: $("swarm-target").value } : {}),
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
      const delivered = (res?.deliveries || []).map((d) => `${d.worker} (${d.mode})`);
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

  async function runWorkerAction(action, name) {
    if (!selectedSwarmId || busyWorkerAction || opaqueWriteBlocked) return;
    busyWorkerAction = `${action}:${name}`;
    pendingConfirm = null;
    renderOverview();
    try {
      await transport.swarm("action", { swarm_id: selectedSwarmId, action, name });
      showToast?.(action === "kill" ? tr("已终止工位 {0}", name) : tr("已中断 {0}", name));
      await refresh({ silent: true });
    } catch (error) {
      handleWriteError(error);
    } finally {
      busyWorkerAction = null;
      renderOverview();
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
    subtab = next;
    render();
    if (focus) $(`swarm-subtab-${next}`)?.focus();
    if (next === "board") {
      const wrap = $("swarm-board-wrap");
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function changeScope(next) {
    if (next === scope) return;
    scope = next;
    listLoaded = false;
    selectedSwarmId = null;
    overview = null;
    resetBoardCache();
    render();
    void refresh();
  }


  function recipients(msg) {
    const tokens = tokenizeBoardText(msg.text).filter(t => t.type === "mention" || t.type === "channel_mention");
    return [...new Set(tokens.map(t => t.value.toLowerCase()))];
  }

  function citation(seq) {
    const btn = node("button", "#" + seq, "sw-citation mono");
    btn.type = "button";
    btn.setAttribute("aria-label", tr("跳转到消息 #{0}", seq));
    btn.onclick = () => jumpTo(seq);
    return btn;
  }

  function jumpTo(seq) {
    const msg = boardBySeq.get(Number(seq));
    if (!msg) { showToast?.(tr("找不到消息 #{0}", seq)); return; }
    if (channel !== "*" && channel !== (msg.channel || "main")) channel = "*";
    $("swarm-from").value = $("swarm-mentioned").value = $("swarm-search").value = "";
    setSubtab("board");
    const el = $("swarm-board-feed").querySelector(`[data-seq="${msg.seq}"]`);
    if (!el) return;
    el.tabIndex = -1; el.focus({ preventScroll:true }); el.scrollIntoView({block:"center"});
    el.classList.remove("sw-jump"); void el.offsetWidth; el.classList.add("sw-jump");
  }

  function renderTeam() {
    const team = $("swarm-team");
    const roster = overview.roster || [];
    team.replaceChildren(...[{name:"coordinator",state:"working"},...roster.filter(w=>w.name!=="coordinator")].map(w => {
      const member = node("span", "", "sw-team-member");
      member.title = "@" + w.name + " · " + tr(WORKER_STATUS_LABELS[w.state] || "未知");
      member.append(createBeeAvatar(w.name,w.state), node("span",senderDisplayName(w.name)));
      return member;
    }));
    const attention = $("swarm-attention");
    const alerts = overview.system_attention || [];
    const labels = { error:"错误", quota:"配额暂停", stuck:"工位无更新", stall:"协作停滞" };
    attention.hidden = !alerts.length;
    attention.replaceChildren(...alerts.map(a => {
      const worker = roster.find(w => w.name === a.agent);
      const row = node("button","","sw-alert");
      row.type = "button"; row.dataset.severity = a.kind;
      row.append(node("strong",tr(labels[a.kind] || "需要关注")),node("span",[a.agent && ("@"+a.agent),errorText(a.text)].filter(Boolean).join(" · ")));
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
    const bar=$("swarm-channel-tabs"), key=JSON.stringify([choices,channel]);
    if (bar.dataset.key!==key) {
      bar.dataset.key=key;
      bar.replaceChildren(...choices.map(([value,label])=>{
        const btn=node("button",label,"btn-ghost"); btn.type="button";
        btn.dataset.channel=value; btn.setAttribute("aria-pressed", String(channel===value));
        btn.onclick=()=>{channel=value;renderBoard();};return btn;
      }));
    }
    selectOptions("swarm-target",[["main","#main"],...channels.filter(c=>!c.archived).map(c=>[c.name,"#"+c.name])]);
    $("swarm-target-label").hidden=!channels.length || opaqueWriteBlocked;
    $("swarm-new-channel").hidden=opaqueWriteBlocked;
    if (opaqueWriteBlocked) $("swarm-channel-form").hidden=true;
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
      form.reset();form.hidden=true;$("swarm-new-channel").setAttribute("aria-expanded","false");
      channel=op==="create" ? name : "*";
      await refresh({silent:true});
    } catch(e) {handleWriteError(e);}
    finally {channelBusy=false;form.querySelector("button").disabled=false;$("swarm-archive").disabled=false;}
  }

  async function renderRaw() {
    const key=JSON.stringify([selectedSwarmId,rawKind,locale(),rawKind==="board" ? boardRevision : rawKind==="plan" ? [overview.swarm,overview.roster.map(w=>w.task_summary)] : [overview.swarm.title,overview.roster]]);
    if (key===rawRevision) return;
    rawRevision=key;
    const token=++rawRequest, pre=$("swarm-raw-content"), copyBtn=$("swarm-raw-copy");
    pre.textContent="";copyBtn.disabled=true;put("swarm-raw-meta",tr("加载中…"));
    for (const b of document.querySelectorAll("[data-raw]")) b.setAttribute("aria-pressed",String(b.dataset.raw===rawKind));
    try {
      const result=await transport.swarm("raw",{swarm_id:selectedSwarmId,kind:rawKind});
      if(token!==rawRequest) return;
      const content=result.content || "";
      pre.textContent=content;copyBtn.disabled=false;
      put("swarm-raw-meta",tr("{0} 字节 · {1} 行",new TextEncoder().encode(content).length,content ? content.split("\n").length-Number(content.endsWith("\n")) : 0));
    } catch(e) {if(token===rawRequest) {rawRevision="";put("swarm-raw-meta",errorText(e.message));}}
  }

  function graphData() {
    const key=JSON.stringify([selectedSwarmId,boardRevision,overview.roster,overview.channels,overview.swarm]);
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
    if(exporting || !overview) return;
    const version=selectionVersion, btn=$("swarm-export");
    exporting=true;btn.disabled=true;btn.textContent=tr("导出中…");
    try {
      const {dataUrl,filename}=await exportGraphGif(graphData(),{...graphOptions(),width:$("swarm-sub-graph").clientWidth,
        onProgress:n=>{btn.textContent=tr("导出中 {0}%",n);}});
      if(version!==selectionVersion || !active || subtab!=="graph") return;
      const dialog = node("dialog");
      dialog.id = "swarm-gif-modal";
      dialog.setAttribute("aria-labelledby", "swarm-gif-title");
      const title = node("h2", tr("关系图回放")); title.id = "swarm-gif-title";
      const img = node("img"); img.id = "swarm-gif-preview"; img.src = dataUrl; img.alt = tr("提及关系动画");
      const actions = node("form", "", "sw-tool-row"); actions.method = "dialog";
      const download = node("a", tr("下载 GIF"), "btn-primary");
      download.id = "swarm-download"; download.href = dataUrl; download.download = filename;
      const close = node("button", tr("关闭"), "btn-ghost"); close.autofocus = true;
      actions.append(download, close); dialog.append(title, img, actions);
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
      $("swarm-panel").append(dialog);
      btn.disabled = false; btn.focus({ preventScroll: true });
      dialog.showModal();
    } catch(e) {showToast?.(errorText(e.message));}
    finally {exporting=false;btn.disabled=false;btn.textContent=tr("导出 GIF");}
  }

  // Event bindings
  $("swarm-picker")?.addEventListener("change", (event) => {
    const next = event.target.value || null;
    if (next && next !== selectedSwarmId) {
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
  $("swarm-refresh")?.addEventListener("click", async () => {
    const btn = $("swarm-refresh");
    btn.disabled = true;
    btn.classList.add("is-spinning");
    try { await refresh({ forceBoard: true }); }
    finally { btn.disabled = false; btn.classList.remove("is-spinning"); }
  });
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
          : event.key === "End" ? "raw"
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


  $("swarm-filter-toggle").onclick = e => {
    const filters=$("swarm-filters");filters.hidden=!filters.hidden;
    e.currentTarget.setAttribute("aria-expanded",String(!filters.hidden));
  };
  $("swarm-new-channel").onclick = e => {
    const form=$("swarm-channel-form");form.hidden=!form.hidden;
    e.currentTarget.setAttribute("aria-expanded",String(!form.hidden));
    if(!form.hidden) $("swarm-channel-name").focus();
  };
  $("swarm-channel-form").onsubmit = e => {e.preventDefault();void writeChannel("create");};
  $("swarm-archive").onclick = () => void writeChannel("archive");
  $("swarm-search").oninput = renderBoard;
  $("swarm-from").onchange = $("swarm-mentioned").onchange = renderBoard;
  $("swarm-channel-filter").onchange = e => {channel=e.target.value;renderBoard();};
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
  $("swarm-export").onclick=()=>void exportReplay();
  for(const btn of document.querySelectorAll("[data-raw]")) btn.onclick=()=>{rawKind=btn.dataset.raw;void renderRaw();};
  $("swarm-raw-copy").onclick=()=>void copy($("swarm-raw-content").textContent);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(pollTimer); stopReplay(); }
    else if (active) void refresh({ silent: true });
  });

  return {
    setActive(isActive, { swarmId } = {}) {
      active = Boolean(isActive);
      if (!active) stopReplay();
      if (swarmId) pendingSwarmId = swarmId;
      clearTimeout(pollTimer);
      if (active) {
        render();
        void refresh();
      }
    },
    refresh: () => refresh({ forceBoard: true }),
    pollBadge,
    renderLanguage() {
      delete $("swarm-pills").dataset.key;
      delete $("swarm-board-feed").dataset.key;
      render();
    },
    onWorkspaceChange() {
      listLoaded = false;
      selectedSwarmId = null;
      overview = null;
      resetBoardCache();
      if (active) void refresh({ forceBoard: true });
      else void pollBadge();
    },
  };
}

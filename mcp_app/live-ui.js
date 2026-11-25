import { bindLanguage, locale, localizedFormat, tr, errorText } from '../magpie_plugin/ui/i18n.js';
import { mountConsole } from "../magpie_plugin/ui/app.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { linkTarget, listArguments, streamRenderKey, timelineMessages } from "./live-state.js";
import { mountSwarm } from "./swarm-ui.js";

export function mountLive({ transport, sidecar }) {
  const applyLanguage = bindLanguage(document.body);
  const params = new URLSearchParams(location.search);
  const tabs = ["live", "swarm", "overview", "requests", "sessions"];
  const active = new Set(["queued", "running", "waiting_gemini"]);
  const statuses = {
    queued: "排队中", running: "运行中", waiting_gemini: "等待回复", finished: "已完成",
    failed: "失败", interrupted: "已中止", outcome_unknown: "状态未确认",
  };
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const number = localizedFormat(Intl.NumberFormat);
  const percent = localizedFormat(Intl.NumberFormat, { style: "percent", maximumFractionDigits: 1 });
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
  const statusLabel = (run) => tr(statuses[run?.state]) || tr("未知");
  const basename = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");

  let ready = false;
  let appTab = "live";
  let sharedConsole;
  let swarmController;
  let latestMagpieStatus;
  let languagePreference = "auto";
  let savingLanguage = false;
  let languageRevision = 0;
  let replyBusy = false;
  let replyKey = "";
  let submittedReply = "";
  let runs = [];
  let selected = null;
  let viewMode = "list"; // "list" | "detail"
  let selection = 0;
  let snapshot = null;
  let transcript = { text: "", complete: false };
  let fullGoal = null;
  let goalLoading = null;
  let scope = sidecar ? "session" : "all";
  let linkedSession = null;
  let focusRun = null;
  let magpieCheck;
  let magpieTimer;
  let lockedConversation = null;
  let nextOffset = null;
  let requestedCount = 0;
  let lastListConversation = null;
  let listLoaded = false;
  let listVersion = 0;
  let listTimer, streamTimer;
  let readingList = false;
  let listWanted = false;
  let readingStream = false;
  let streamWanted = false;
  let control = null;
  let confirming = false;
  let toastTimer;
  let toastPath = "";
  const hostStyleKeys = new Set();
  const openSteps = new Set();

  function applyHost(context) {
    const theme = context?.theme ?? (systemTheme.matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    $("view-console").dataset.theme = theme;
    const variables = context?.styles?.variables ?? {};
    for (const key of hostStyleKeys) {
      if (!(key in variables)) document.documentElement.style.removeProperty(key);
    }
    hostStyleKeys.clear();
    for (const key of Object.keys(variables)) hostStyleKeys.add(key);
    for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value);
  }

  function notice(id, message = "") {
    put(id, message);
    $(id).hidden = !message;
  }

  function toast(message, path = "", kind = "info") {
    clearTimeout(toastTimer);
    toastPath = path;
    put("toast-message", message);
    $("toast").hidden = !message;
    $("toast-copy").hidden = !path;
    $("toast").dataset.kind = kind;
    if (message && !path) toastTimer = setTimeout(() => toast(""), 3200);
  }


  const currentRun = () => snapshot?.run ?? runs.find((run) => run.run_id === selected);
  const isActive = () => active.has(currentRun()?.state);
  const canFetch = () => appTab === "live" && ready && !document.hidden;

  function updateHash(tab, id) {
    const hash = `#${tab}${id ? "/" + encodeURIComponent(id) : ""}`;
    if (hash !== location.hash) history.pushState(null, "", hash);
  }

  function hashLocation() {
    const [tab, raw] = location.hash.slice(1).split("/");
    let id;
    try { if (raw) id = decodeURIComponent(raw); } catch { /* Ignore invalid fragments. */ }
    return { tab: tabs.includes(tab) ? tab : sidecar ? "live" : "overview", id };
  }

  function navigate(tab, { id, sessionId, focus = false, fromHash = false } = {}) {
    appTab = tab;
    if (!fromHash) updateHash(tab, id);
    for (const name of tabs) {
      const chosen = name === tab;
      const button = $(`tab-${name}`);
      button.tabIndex = chosen ? 0 : -1;
      button.setAttribute("aria-selected", String(chosen));
    }
    if (focus) $(`tab-${tab}`).focus();
    const live = tab === "live";
    const swarm = tab === "swarm";
    const consoleTab = !live && !swarm;
    $("live-panel").hidden = !live;
    $("swarm-panel").hidden = !swarm;
    $("view-console").hidden = !consoleTab;
    swarmController?.setActive(swarm, { swarmId: swarm ? id : undefined });
    if (consoleTab && !sharedConsole) {
      sharedConsole = mountConsole($("view-console"), transport, {
        onState: (state) => {
          if (!savingLanguage && state.ui?.language) setLanguage(state.ui.language);
        },
        onLanguage: saveLanguage,
        refreshGateway: () => void Promise.resolve(magpieCheck).then(() => refreshMagpieStatus(true)),
        navigate,
        showToast: (message, kind) => toast(message, "", kind),
        copyText: copy,
      });
      if (latestMagpieStatus) sharedConsole.patchGatewayStatus(latestMagpieStatus);
    }
    if (consoleTab) sharedConsole?.setTab(tab, { id });
    else sharedConsole?.setTab("live", {});
    clearTimeout(listTimer);
    clearTimeout(streamTimer);
    if (live) {
      if (id || sessionId) {
        scope = "all";
        linkedSession = sessionId || null;
        lockedConversation = null;
        requestedCount = 0;
        listVersion++;
        if (id !== selected || fromHash) resetSelection(id || null);
        focusRun = focus ? id || true : null;
        render();
      } else {
        resetSelection();
        linkedSession = null;
        lockedConversation = null;
        listVersion++;
        render();
      }
      void refreshRuns();
      if (selected) void refreshStream();
    } else if (tab === "overview" && ready) {
      void refreshMagpieStatus();
    }
  }

  function renderMagpieStatus(status) {
    const dot = $("magpie-status");
    dot.dataset.state = status.reachable === null ? "checking" : status.reachable ? "online" : "offline";
    dot.title = status.reachable === null ? tr("正在检查 Magpie 连接") : status.reachable ? tr("Magpie 在线") : tr("Magpie 离线");
    dot.setAttribute("aria-label", dot.title);
  }

  function refreshMagpieStatus(force = false) {
    if (magpieCheck) return magpieCheck;
    const revision = languageRevision;
    magpieCheck = transport.getMagpieStatus(force).then((status) => {
      latestMagpieStatus = status;
      if (!savingLanguage && status.ui?.language && revision === languageRevision) setLanguage(status.ui.language);
      renderMagpieStatus(status);
      sharedConsole?.patchGatewayStatus(status);
    }).catch(() => renderMagpieStatus({ reachable: false })).finally(() => { magpieCheck = null; });
    return magpieCheck;
  }

  function scheduleMagpieStatus(delay = 15_000) {
    clearTimeout(magpieTimer);
    magpieTimer = setTimeout(async () => {
      if (!document.hidden) {
        await refreshMagpieStatus();
        void swarmController?.pollBadge();
      }
      scheduleMagpieStatus();
    }, delay);
  }

  function setLanguage(preference) {
    if (languagePreference === preference) return;
    languagePreference = preference;
    const previous = locale();
    applyLanguage(preference);
    if (locale() === previous) return;
    if (latestMagpieStatus) renderMagpieStatus(latestMagpieStatus);
    delete $("stream").dataset.key;
    render();
    sharedConsole?.renderLanguage();
    swarmController?.renderLanguage();
  }

  async function saveLanguage(preference) {
    if (savingLanguage) return;
    const previous = languagePreference;
    savingLanguage = true;
    languageRevision++;
    $("language-toggle").disabled = true;
    setLanguage(preference);
    try {
      await transport.saveSettings({ ui: { language: preference } });
      toast(tr("语言设置已保存"));
    } catch (error) {
      setLanguage(previous);
      toast(tr("无法保存语言：{0}", errorText(error.message)), "", "error");
    } finally {
      savingLanguage = false;
      $("language-toggle").disabled = false;
    }
  }

  $("language-toggle").onclick = () => void saveLanguage(locale() === "zh" ? "en" : "zh");

  function formatElapsed(seconds) {
    if (seconds == null) return "";
    const elapsed = Math.max(0, Math.floor(seconds));
    return elapsed < 60 ? tr("{0} 秒", elapsed) : tr("{0} 分 {1} 秒", Math.floor(elapsed / 60), elapsed % 60);
  }

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

  async function openLink(target, path = target.value) {
    try {
      if (target.kind === "web") {
        window.open(target.value, "_blank", "noopener,noreferrer");
        return;
      }
      if (sidecar?.ui?.toggleAuxPane && target.kind === "file") {
        const approved = linkTarget(target.value, null, { fileUris: snapshot?.file_uris });
        if (!approved) throw new Error("File preview was not approved");
        sidecar.ui.toggleAuxPane({ tabType: "fileView", uri: approved.value });
        return;
      }
      toast(tr("当前视图无法打开文件预览。"), path);
    } catch {
      if (target.kind === "file") toast(tr("当前视图无法打开文件预览。"), path);
      else toast(tr("当前视图无法打开链接。"));
    }
  }

  function makeFileChip(path, uri, restrictedReason = "") {
    const target = !restrictedReason
      ? (uri ? linkTarget(uri, null, { approved: true }) : linkTarget(path, sidecar ? null : currentRun()?.cwd))
      : null;
    if (target?.kind === "file") {
      const button = node("button", "", "file-chip");
      button.type = "button";
      button.title = path;
      button.append(icon("file"), node("span", basename(path)));
      button.addEventListener("click", () => void openLink(target, path));
      return button;
    }
    const chip = node("span", "", "file-chip is-restricted");
    const outside = restrictedReason === "outside_workspace";
    chip.title = outside ? tr("{0}（位于工作区外，已禁止预览）", path) : tr("{0}（仅只读显示）", path);
    chip.append(icon("file"), node("span", basename(path)), node("span", outside ? tr("工作区外") : tr("只读"), "file-chip-tag"));
    return chip;
  }

  function resetSelection(runId = null) {
    selected = runId;
    viewMode = runId ? "detail" : "list";
    selection++;
    snapshot = null;
    transcript = { text: "", complete: false };
    fullGoal = null;
    goalLoading = null;
    confirming = false;
    openSteps.clear();
    $("steer").value = "";
    $("feed-wrap").scrollTop = 0;
    $("meta-drawer").hidden = true;
    $("goal-details").open = false;
    $("info-toggle").setAttribute("aria-expanded", "false");
    notice("stream-error");
    setControlStatus();
  }

  function openSessionDetail(runId, { focus = true } = {}) {
    const run = runs.find((item) => item.run_id === runId);
    if (!run) return;
    if (scope === "session" && run.host_conversation_id && lockedConversation !== run.host_conversation_id) {
      lockedConversation = run.host_conversation_id;
      listVersion++;
      void refreshRuns();
    }
    if (selected !== runId) resetSelection(runId);
    updateHash("live", runId);
    render();
    if (focus) $("detail-title").focus();
    void refreshStream();
  }

  function backToList() {
    const previous = selected;
    linkedSession = null;
    lockedConversation = null;
    updateHash("live");
    listVersion++;
    resetSelection();
    render();
    scheduleStream();
    const card = [...$("session-cards").querySelectorAll("button")].find((button) => button.dataset.runId === previous);
    (card || $("scope-session")).focus();
    void refreshRuns();
  }

  function statusIcon(state) {
    return icon(state === "finished" ? "check" : ["failed", "interrupted"].includes(state) ? "close" : "dot");
  }

  function buildStatusGlyph(state) {
    const wrap = node("span", "", "status-glyph");
    wrap.dataset.state = state || "";
    wrap.append(statusIcon(state));
    return wrap;
  }

  function runTitle(run) {
    const title = (run.title || run.goal || run.session_id || run.run_id).replace(/\s+/g, " ").trim();
    const workspace = run.workspace_name;
    const prefix = workspace && (workspace + " · ");
    return prefix && title.toLowerCase().startsWith(prefix.toLowerCase()) ? title.slice(prefix.length) || title : title;
  }

  function sessionPreview(run) {
    return (run.pending_tool_call?.arguments?.question || run.error || run.last_command || run.last_message || "")
      .replace(/\s+/g, " ").trim();
  }

  function renderList() {
    const sessions = groupSessions(runs);
    const loading = !listLoaded && !sessions.length;
    $("list-loading").hidden = !loading;
    $("list-wrap").setAttribute("aria-busy", String(loading));
    $("empty").hidden = loading || sessions.length > 0;
    $("load-more").hidden = nextOffset == null;
    $("load-more").disabled = readingList;
    $("scope-session").setAttribute("aria-pressed", String(scope === "session"));
    $("scope-all").setAttribute("aria-pressed", String(scope === "all" && !linkedSession));
    $("clear-live-session").hidden = !linkedSession;
    if (!sessions.length && !loading) {
      put("empty-title", scope === "all" ? tr("暂无任务") : tr("当前会话暂无任务"));
      put("empty-message", scope === "all" ? tr("发起任务后，执行进度会显示在这里。") : tr("可发起任务，或切换到「全部」查看记录。"));
    }

    const list = $("session-cards");
    const key = JSON.stringify([scope, selected, sessions.map(({ key, latest, runs }) => [key, latest, runs.length])]);
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.runId : null;

    list.replaceChildren(...sessions.map((session) => {
      const run = session.latest;
      const li = node("li");
      const card = node("button", "", "session-card");
      card.type = "button";
      card.dataset.runId = run.run_id;
      if (session.runs.some((item) => item.run_id === selected)) card.setAttribute("aria-current", "true");
      const title = runTitle(run);
      const label = node("span", title, "sc-title");
      label.title = title;
      const meta = node("span", "", "sc-meta");
      meta.append(node("span", statusLabel(run)));
      if (run.worktree_path) meta.append(node("span", "Worktree", "run-kind"));
      if (run.remote_turn_unconfirmed) meta.append(node("span", tr("远端终态未确认"), "unconfirmed-badge"));
      const elapsed = formatElapsed(run.elapsed_sec);
      if (elapsed) meta.append(node("span", elapsed));
      if (session.runs.length > 1) meta.append(node("span", tr("{0} 轮", session.runs.length)));
      if (scope === "all" && run.workspace_name) meta.append(node("span", run.workspace_name, "sc-workspace"));
      const preview = sessionPreview(run);
      card.append(buildStatusGlyph(run.state), label, icon("chevron", "sc-chevron"), meta);
      if (preview) {
        const line = node("span", preview, "sc-preview");
        line.title = preview;
        card.append(line);
      }
      card.addEventListener("click", () => openSessionDetail(run.run_id));
      li.append(card);
      return li;
    }));
    if (focused) [...list.querySelectorAll("button")].find((button) => button.dataset.runId === focused)?.focus({ preventScroll: true });
  }

  function buildStepDetails(key, symbol, title, meta, body, { prose = false, failed = false } = {}) {
    const details = node("details", "", "step-row");
    const generation = selection;
    details.open = openSteps.has(key);
    details.addEventListener("toggle", () => {
      if (generation !== selection) return;
      if (details.open) openSteps.add(key);
      else openSteps.delete(key);
    });
    const summary = node("summary");
    summary.append(icon(symbol), node("span", title, "step-title"));
    if (meta) {
      const label = node("span", meta, "step-meta");
      if (failed) label.dataset.failed = "true";
      summary.append(label);
    }
    summary.append(icon("chevron", "step-chevron"));
    details.append(summary);
    if (typeof body === "string" && body) details.append(node("pre", body, prose ? "step-body is-prose" : "step-body"));
    else if (body && typeof body !== "string") details.append(body);
    return details;
  }


  function renderTurnStrip(run) {
    const strip = $("turn-strip");
    const group = groupSessions(runs).find((item) => item.key === (run.session_id || run.run_id));
    const turns = group?.runs || [];
    const bar = $("turn-bar");
    bar.hidden = turns.length < 2;
    const panel = $("turn-panel");
    if (bar.hidden) {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-labelledby");
      panel.removeAttribute("tabindex");
      return;
    }
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `turn-${selected}`);
    panel.tabIndex = 0;
    const key = JSON.stringify([selected, turns.map((turn) => [turn.run_id, turn.state])]);
    if (strip.dataset.key === key) return;
    strip.dataset.key = key;
    const focused = strip.contains(document.activeElement) ? document.activeElement.id : null;
    strip.replaceChildren(...turns.map((turn, index) => {
      const button = node("button", "", "turn-pill");
      const chosen = turn.run_id === selected;
      button.id = `turn-${turn.run_id}`;
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "turn-panel");
      button.setAttribute("aria-selected", String(chosen));
      button.tabIndex = chosen ? 0 : -1;
      button.append(buildStatusGlyph(turn.state), node("span", tr("第 {0} 轮", index + 1)));
      button.addEventListener("click", () => {
        openSessionDetail(turn.run_id, { focus: false });
        $(button.id)?.focus({ preventScroll: true });
      });
      return button;
    }));
    if (focused) $(focused)?.focus({ preventScroll: true });
  }

  function renderStream() {
    const wrap = $("feed-wrap");
    const list = $("stream");
    const run = currentRun();
    const follow = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 48;
    const events = snapshot?.timeline || [];
    const fileUris = snapshot?.file_uris || {};
    const restrictedFiles = snapshot?.restricted_files || {};
    const pendingAsk = run?.state === "waiting_gemini" ? run.pending_tool_call : null;
    const key = streamRenderKey(selected, run?.state, events, fileUris, transcript, pendingAsk,
      Boolean(snapshot), restrictedFiles, Boolean(run?.remote_turn_unconfirmed));
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    const fullText = transcript.text;
    const messages = timelineMessages(events, fullText);
    const lastMessage = [...messages.keys()].at(-1);
    const options = { cwd: sidecar ? null : run?.cwd, fileUris, openLink, copy };

    function message(text, showCopy) {
      const box = node("div", "", "msg-block");
      if (showCopy) {
        const head = node("div", "", "msg-head");
        const button = node("button", "", "copy-btn");
        button.type = "button";
        button.append(icon("copy"), tr("复制全文"));
        button.disabled = !transcript.complete;
        button.addEventListener("click", () => void copy(fullText || text));
        head.append(node("span", tr("GPT 输出")), button);
        box.append(head);
      }
      box.append(renderMarkdown(text, options));
      return box;
    }

    const nodes = events.flatMap((event, index) => {
      const li = node("li");
      const stepKey = `${event.type}-${event.id || index}`;
      if (event.type === "reasoning") {
        const preview = (event.text || "").replace(/\s+/g, " ").trim();
        li.append(buildStepDetails(stepKey, "think", preview ? tr("思考：{0}", preview) : tr("思考"), "", event.text, { prose: true }));
      } else if (event.type === "command") {
        const running = event.exit_code == null;
        li.append(buildStepDetails(stepKey, "terminal", event.command || tr("执行命令"),
          running ? tr("执行中") : tr("退出码 {0}", event.exit_code),
          [event.command, event.output].filter(Boolean).join("\n\n"), { failed: !running && event.exit_code !== 0 }));
      } else if (event.type === "files") {
        const paths = event.paths || [];
        const body = node("div", "", "step-files step-body");
        body.append(...paths.map((path) => makeFileChip(path, fileUris[path], restrictedFiles[path])));
        li.append(buildStepDetails(stepKey, "files", tr("变更 {0} 个文件", event.count || paths.length), "", body));
      } else if (event.type === "ask_gemini") {
        if (pendingAsk && (pendingAsk.call_id === event.id ||
            pendingAsk.arguments?.question === event.arguments?.question)) return [];
        li.append(buildStepDetails(stepKey, "chat", event.arguments?.question || tr("请求主对话回复"), "",
          event.arguments?.context, { prose: true }));
      } else if (messages.has(event)) {
        li.append(message(messages.get(event), event === lastMessage));
      } else return [];
      return [li];
    });

    if (messages.has(undefined)) {
      const li = node("li");
      li.append(message(messages.get(undefined), true));
      nodes.push(li);
    }
    if (!snapshot && !nodes.length) {
      const li = node("li", "", "skeleton-stream");
      li.setAttribute("role", "status");
      li.setAttribute("aria-label", tr("正在加载执行流"));
      nodes.push(li);
    } else if (isActive() && !pendingAsk) {
      const li = node("li", "", "streaming-indicator");
      li.append(buildStatusGlyph(run.state), statusLabel(run));
      nodes.push(li);
    } else if (!nodes.length && !pendingAsk) {
      const li = node("li", "", "empty");
      const symbol = node("span", "", "empty-icon");
      symbol.append(icon("chat"));
      li.append(symbol, node("p", tr("暂无输出"), "empty-title"), node("p", tr("产生输出后会显示在这里。")));
      nodes.push(li);
    }

    list.replaceChildren(...nodes);
    if (follow && list.dataset.runId === selected) wrap.scrollTop = wrap.scrollHeight;
    list.dataset.runId = selected;
  }


  function renderControls(run = currentRun()) {
    const usable = run?.can_control && !control;
    $("controls").hidden = !active.has(run?.state);
    const instruction = tr("补充执行指令");
    $("steer").placeholder = instruction + "…";
    $("steer").setAttribute("aria-label", instruction);
    $("steer").disabled = !usable;
    $("send-steer").disabled = !usable || !$("steer").value.trim();
    $("interrupt").disabled = !run?.can_interrupt || Boolean(control);
    $("cancel-interrupt").hidden = !confirming;
    put("interrupt", confirming ? tr("确认中止") : tr("中止"));
    const canConfirmInterrupt = Boolean(run?.remote_turn_unconfirmed && (run?.can_interrupt ?? run?.can_control));
    $("unconfirmed-interrupt").hidden = !canConfirmInterrupt;
    $("unconfirmed-interrupt").disabled = !canConfirmInterrupt || Boolean(control);
  }

  function renderAsk(run) {
    const ask = run.state === "waiting_gemini" && run.pending_tool_call?.arguments;
    $("ask").hidden = !ask;
    if (!ask) return;
    const keyForCall = `${run.run_id}:${run.pending_tool_call.call_id}`;
    if (replyKey !== keyForCall) {
      replyKey = keyForCall;
      $("reply-message").value = "";
      notice("reply-status");
    }
    $("reply-message").disabled = replyBusy || submittedReply === replyKey;
    syncReplyButton();
    put("ask-question", ask.question || tr("正在等待回应"));
    $("ask-context").hidden = !ask.context;
    put("ask-context", ask.context || "");
    const media = ask.media_paths || [];
    const uris = snapshot?.file_uris || {};
    const restricted = snapshot?.restricted_files || {};
    const mediaList = $("ask-media");
    mediaList.hidden = !media.length;
    const key = JSON.stringify([run.run_id, media.map((path) => [path, uris[path], restricted[path]])]);
    if (mediaList.dataset.key !== key) {
      mediaList.dataset.key = key;
      mediaList.replaceChildren(...media.map((path) => {
        const li = node("li");
        li.append(makeFileChip(path, uris[path], restricted[path]));
        return li;
      }));
    }
  }

  function syncReplyButton() {
    const field = $("reply-message");
    $("send-reply").disabled = field.disabled || !field.value.trim();
  }

  async function replyToAsk() {
    const run = currentRun();
    const callId = run?.pending_tool_call?.call_id;
    const message = $("reply-message").value.trim();
    if (replyBusy || submittedReply === replyKey || run?.state !== "waiting_gemini" || !callId || !message) return;
    const key = replyKey;
    replyBusy = true;
    renderAsk(run);
    try {
      await transport.live("reply", { run_id: run.run_id, call_id: callId, message });
      submittedReply = key;
      if (replyKey === key) notice("reply-status", tr("已发送回复。"));
      void refreshStream();
      void refreshRuns();
    } catch (error) {
      if (replyKey === key) notice("reply-status", errorText(error.message));
    } finally {
      replyBusy = false;
      if (currentRun()) renderAsk(currentRun());
    }
  }

  function renderDetail(run) {
    const title = runTitle(run);
    put("detail-title", title);
    $("detail-title").title = title;
    $("open-run-swarm").hidden = !run.swarm_id || !transport.swarm;
    const dot = $("dot");
    if (dot.dataset.state !== run.state || !dot.firstChild) {
      dot.dataset.state = run.state || "";
      dot.replaceChildren(statusIcon(run.state));
    }
    put("detail-status", statusLabel(run));
    const unconfirmed = Boolean(run.remote_turn_unconfirmed);
    $("unconfirmed-banner").hidden = !unconfirmed;
    if (unconfirmed) {
      const canConfirmInterrupt = Boolean((run.can_interrupt ?? run.can_control));
      put("unconfirmed-text", canConfirmInterrupt
        ? tr("远端 Codex 回合可能仍在运行。请勿对同一会话盲目并发派发；可点击「尝试中断确认」向远端补发中断。")
        : tr("远端 Codex 回合可能仍在运行。请勿对同一会话盲目并发派发，待确认远端结束后再继续。"));
    }
    $("open-run-session").hidden = !run.session_id;

    renderTurnStrip(run);
    renderControls(run);
    const usage = snapshot?.usage ?? run.usage ?? {};
    const tokens = usage.total_tokens ?? (usage.input_tokens != null ? usage.input_tokens + (usage.output_tokens ?? 0) : null);
    const rate = snapshot?.cache_hit_rate ?? (usage.input_tokens && usage.cached_input_tokens != null
      ? Math.min(1, usage.cached_input_tokens / usage.input_tokens) : null);
    put("model", run.model || "—");
    put("elapsed", formatElapsed(run.elapsed_sec) || "—");
    put("tokens", tokens == null ? "—" : number.format(tokens));
    put("cache", rate == null ? "—" : percent.format(rate));
    put("goal", fullGoal ?? (run.goal || tr("未记录任务目标")));
    $("detail-worktree").hidden = !run.worktree_path;
    put("workspace", run.worktree_path || run.cwd || "—");
    put("run-id", run.run_id);
    put("session-id", run.session_id || "—");
    $("session-id").disabled = !run.session_id;
    notice("run-error", errorText(run.error || ""));
    renderAsk(run);
    renderStream();
  }

  function render() {
    const run = viewMode === "detail" ? currentRun() : null;
    document.querySelector(".shell").dataset.view = run ? "detail" : "list";
    $("detail-empty").hidden = Boolean(run);
    $("detail-bar").hidden = $("turn-panel").hidden = !run;
    renderList();
    if (run) renderDetail(run);
    else $("turn-bar").hidden = true;
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
        const page = await transport.live("stream", { run_id: runId, goal_offset: offset });
        if (generation !== selection) return;
        goal += page.goal;
        offset = page.next_goal_offset;
      }
      if (generation === selection) {
        fullGoal = goal;
        render();
      }
    } catch (error) {
      if (generation === selection) {
        if (!currentRun()) notice("list-error", errorText(error.message));
        else notice("stream-error", errorText(error.message));
      }
    } finally {
      if (goalLoading === generation) goalLoading = null;
    }
  }

  async function loadMoreTranscript(data) {
    let offset = data.next_text_offset;
    if (offset == null || transcript.complete || !canFetch()) return;
    let text = data.full_text;
    while (offset != null && snapshot === data && canFetch()) {
      const page = await transport.live("stream", {
        run_id: data.run.run_id, text_offset: offset, text_revision: data.text_revision,
      });
      if (snapshot !== data || page.stale_text_revision) return;
      text += page.full_text;
      offset = page.next_text_offset;
    }
    if (snapshot === data && offset == null) {
      transcript = { text, complete: true };
      render();
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

  function changeScope(next) {
    if (next === scope && !lockedConversation && !linkedSession) return;
    scope = next;
    linkedSession = null;
    updateHash("live");
    lockedConversation = null;
    requestedCount = 0;
    nextOffset = null;
    lastListConversation = null;
    listLoaded = false;
    runs = [];
    listVersion++;
    resetSelection();
    notice("list-error");
    render();
    void refreshRuns();
  }

  function applyRunList(data) {
    lastListConversation = data.bound_conversation_id ?? null;
    listLoaded = true;
    runs = data.runs;
    nextOffset = data.next_offset ?? null;
    if (!selected && linkedSession && runs[0]) {
      const id = runs[0].run_id;
      resetSelection(id);
      updateHash("live", id);
      void refreshStream();
    }
    render();
  }

  async function refreshRuns() {
    if (!canFetch() && !(sidecar && appTab === "live" && ready && !listLoaded)) return;
    if (readingList) { listWanted = true; return; }
    readingList = true;
    listWanted = false;
    clearTimeout(listTimer);
    const version = listVersion;
    $("load-more").disabled = true;
    try {
      const args = listArguments(scope, lockedConversation);
      if (linkedSession) args.session_id = linkedSession;
      const first = await transport.live("runs", args);
      if (version !== listVersion) return;
      if (scope === "session" && !lockedConversation && lastListConversation !== first.bound_conversation_id) requestedCount = 0;
      const collected = new Map(first.runs.map((run) => [run.run_id, run]));
      let cursor = first.next_offset;
      while (cursor != null && collected.size < requestedCount) {
        const page = await transport.live("runs", { ...args, offset: cursor });
        if (version !== listVersion) return;
        if (scope === "session" && page.bound_conversation_id !== first.bound_conversation_id) {
          listWanted = true;
          return;
        }
        for (const run of page.runs) collected.set(run.run_id, run);
        cursor = page.next_offset > cursor ? page.next_offset : null;
      }
      applyRunList({ ...first, next_offset: cursor, runs: [...collected.values()] });
      notice("list-error");
    } catch (error) {
      if (version === listVersion) {
        listLoaded = true;
        notice("list-error", errorText(error.message));
        render();
      }
    } finally {
      readingList = false;
      $("load-more").disabled = false;
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
      const data = await transport.live("stream", { run_id: runId });
      if (generation !== selection) return;
      const openingLinkedRun = scope === "all" && !currentRun();
      acceptSnapshot(data);
      if (openingLinkedRun && !linkedSession && data.run.session_id) {
        linkedSession = data.run.session_id;
        listVersion++;
        void refreshRuns();
      }
      if (focusRun === true || focusRun === runId) {
        focusRun = null;
        $("detail-title").focus();
      }
      await loadMoreTranscript(data);
      if (snapshot === data) notice("stream-error");
    } catch (error) {
      if (generation === selection) notice("stream-error", errorText(error.message));
    } finally {
      readingStream = false;
      if (streamWanted) void refreshStream();
      else scheduleStream();
    }
  }

  function setControlStatus(message = "", error = false) {
    for (const id of ["control-status", "unconfirmed-status"]) {
      const el = $(id);
      if (!el) continue;
      const show = Boolean(message) && (id === "unconfirmed-status" ? !$("unconfirmed-banner").hidden : !$("controls").hidden);
      el.hidden = !show;
      el.dataset.error = String(error);
      put(id, show ? message : "");
    }
  }

  async function sendControl(name, args, doneMessage) {
    if (!selected || control) return;
    const generation = selection;
    control = name;
    confirming = false;
    renderControls();
    setControlStatus(tr("发送中…"));
    try {
      await transport.live(name, args);
      if (generation !== selection) return;
      if (name === "steer") $("steer").value = "";
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

  async function copy(value, message = "") {
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
    } catch {
      const field = $("console-copy-text");
      const dialog = $("console-copy-dialog");
      field.value = value;
      if (!dialog.open) dialog.showModal();
      field.select();
      return;
    }
    toast(message || tr("已复制。"));
  }

  for (const element of document.querySelectorAll("[data-icon]")) element.append(icon(element.dataset.icon));
  for (const [index, tab] of tabs.entries()) {
    const button = $(`tab-${tab}`);
    button.onclick = () => {
      if (tab !== appTab) navigate(tab);
    };
    button.onkeydown = (event) => {
      const direction = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      const next = direction ? tabs[(index + direction + tabs.length) % tabs.length]
        : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : null;
      if (next) {
        event.preventDefault();
        navigate(next, { focus: true });
      }
    };
  }
  $("refresh-btn").onclick = async () => {
    const button = $("refresh-btn");
    button.disabled = true;
    button.classList.add("is-spinning");
    try {
      if (appTab === "live") await Promise.all([refreshRuns(), refreshStream()]);
      else if (appTab === "swarm") await swarmController?.refresh();
      else if (appTab === "overview") {
        await Promise.all([refreshMagpieStatus(true), sharedConsole?.refresh()]);
      } else await sharedConsole?.refresh();
    } finally {
      button.disabled = false;
      button.classList.remove("is-spinning");
    }
  };
  $("open-run-requests").onclick = () => {
    const run = currentRun();
    if (run) navigate("requests", { id: `run-${run.run_id}`, focus: true });
  };
  $("open-run-session").onclick = () => {
    const run = currentRun();
    if (run?.session_id) navigate("sessions", { id: run.session_id, focus: true });
  };
  $("console-copy-close").onclick = () => $("console-copy-dialog").close();
  $("send-reply").addEventListener("click", () => void replyToAsk());
  $("reply-message").addEventListener("input", syncReplyButton);
  $("reply-message").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && !$("send-reply").disabled) void replyToAsk();
  });
  $("scope-session").addEventListener("click", () => changeScope("session"));
  $("scope-all").addEventListener("click", () => changeScope("all"));
  $("clear-live-session").addEventListener("click", () => changeScope("all"));
  $("load-more").addEventListener("click", () => {
    requestedCount = runs.length + 50;
    void refreshRuns();
  });
  $("toast-copy").addEventListener("click", () => void copy(toastPath, tr("已复制路径。")));
  $("toast-dismiss").addEventListener("click", () => toast(""));
  $("turn-strip").addEventListener("keydown", (event) => {
    const tabs = [...$("turn-strip").querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    const offsets = { ArrowLeft: -1, ArrowRight: 1 };
    if (index < 0 || (!Object.hasOwn(offsets, event.key) && !["Home", "End"].includes(event.key))) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + offsets[event.key] + tabs.length) % tabs.length;
    tabs[next]?.click();
  });

  $("open-run-swarm").onclick = () => {
    const id = currentRun()?.swarm_id;
    if (id) navigate("swarm", { id, focus: true });
  };
  $("back-btn").addEventListener("click", backToList);
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
    if (message) void sendControl("steer", { run_id: selected, message }, tr("已发送纠偏指令"));
  });
  $("interrupt").addEventListener("click", () => {
    if (!confirming) { confirming = true; renderControls(); return; }
    void sendControl("interrupt", { run_id: selected }, tr("已请求中止当前回合"));
  });
  $("unconfirmed-interrupt").addEventListener("click", () => {
    void sendControl("interrupt", { run_id: selected }, tr("已尝试向远端发送中断确认"));
  });
  $("cancel-interrupt").addEventListener("click", () => { confirming = false; renderControls(); });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(listTimer); clearTimeout(streamTimer); }
    else { void refreshRuns(); if (viewMode === "detail") void refreshStream(); }
  });

  function start() {
    $("language-toggle").disabled = false;
    render();
    const revision = languageRevision;
    void transport.getSummary().then(({ magpie, ui }) => {
      if (ui?.language && revision === languageRevision) setLanguage(ui.language);
      if (!magpieCheck && $("magpie-status").dataset.state === "checking") renderMagpieStatus(magpie);
    }).catch(() => {});
    void refreshMagpieStatus().finally(() => scheduleMagpieStatus(1500));
    if (transport.swarm && !swarmController) {
      swarmController = mountSwarm({
        transport,
        sidecar,
        navigate,
        openLink,
        copy,
        showToast: (message, kind) => toast(message, "", kind),
      });
    }
    void swarmController?.pollBadge();
    const location = hashLocation();
    navigate(location.tab, { id: location.id, fromHash: true });
  }

  const context = () => {
    const theme = params.get("theme");
    const variables = {};
    for (const [key, target] of Object.entries({
      "--magpie-bg": "--color-background-primary", "--magpie-card": "--color-background-secondary",
      "--magpie-surface": "--color-background-secondary", "--magpie-subtle": "--color-background-tertiary",
      "--magpie-fg": "--color-text-primary", "--magpie-muted": "--color-text-secondary",
      "--magpie-border": "--color-border-secondary", "--magpie-accent": "--color-ring-primary",
      "--magpie-font": "--font-sans", "--magpie-mono": "--font-mono",
    })) variables[key] = target;
    let hostVariables = {};
    if (params.has("tokens")) {
      try {
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(params.get("tokens")), (c) => c.charCodeAt(0)));
        for (const [key, value] of Object.entries(JSON.parse(decoded))) {
          const val = String(value ?? "").trim();
          if (!/^--[a-z0-9-]+$/i.test(key) || !val || val.length > 200 || /[;{}]|url\(/i.test(val)) continue;
          hostVariables[key] = val;
          if (Object.hasOwn(variables, key)) hostVariables[variables[key]] = val;
        }
      } catch { /* Fall back to the standalone theme. */ }
    }
    applyHost({ theme: ["light", "dark"].includes(theme) ? theme : undefined, styles: { variables: hostVariables } });
  };
  context();
  systemTheme.addEventListener("change", context);
  if (sidecar) {
    document.documentElement.dataset.sidecar = "";
    let hasWorkspace = false;
    sidecar.onWorkspaceChange((uris) => {
      const first = !hasWorkspace;
      hasWorkspace = true;
      // The initial request can already be in flight. Apply a late workspace
      // scope while retaining the URL's original run or session selection.
      if (first && !uris.length) return;
      listVersion++;
      if (!first) {
        lockedConversation = null;
        linkedSession = null;
      }
      requestedCount = 0;
      nextOffset = null;
      lastListConversation = null;
      listLoaded = false;
      runs = [];
      resetSelection(first ? selected : null);
      if (!first && appTab === "live") updateHash("live");
      render();
      void refreshRuns();
      if (first && selected) void refreshStream();
      swarmController?.onWorkspaceChange();
    });
  } else {
    $("scope-session").hidden = true;
    $("scope-all").parentElement.hidden = true;
  }
  ready = true;
  window.addEventListener("hashchange", () => {
    const location = hashLocation();
    navigate(location.tab, { id: location.id, fromHash: true });
  });
  start();
}

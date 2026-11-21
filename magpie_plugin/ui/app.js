/*
 * GemPT Magpie Page Plugin UI controller.
 * Applies Magpie theme/tokens from boot query parameters, authenticates API
 * calls with the injected <meta name="gempt-key"> secret, supports both universal
 * MCP orchestration and native Magpie routing groups for any client, and
 * persists default_tier, default_sandbox, optional failover_mode, and native group creation.
 */
(() => {
  const POLL_MS = 15000;
  const LIVE_POLL_MS = 2800;
  const MODE_STORAGE_KEY = 'gempt_view_mode';
  const SUPPORTS_HAS = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:has(*))');
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const queryViewMode = (() => {
    const m = String(params.get('mode') || '').trim().toLowerCase();
    return m === 'mcp' || m === 'native' ? m : '';
  })();
  const apiKey = document.querySelector('meta[name="gempt-key"]')?.getAttribute('content') || '';

  const ROLE_TEXT = {
    sonnet: '日常高频 · ~75%',
    opus: '复杂工程 · ~20%',
    fable: '顶配攻坚 · ~5%',
  };

  const EFFORT_LABELS = {
    none: '思考：关',
    minimal: '思考：极低',
    low: '思考：低',
    medium: '思考：中',
    high: '思考：高',
    xhigh: '思考：极高',
    max: '思考：最高',
    ultra: '思考：极限',
  };

  const NODE_ROLE_LABELS = {
    primary: '首选',
    escalate: '疑难升级',
    fallback: '备用兜底',
    exec: '执行',
    planner: '对话规划',
    coder: '代码执行',
    utility: '压缩杂活',
  };

  const SANDBOX_HINTS = {
    'read-only': '仅分析代码，禁止写入文件',
    'workspace-write': '仅允许修改当前工作区内的文件',
    'danger-full-access': '无沙箱限制，允许完整本地权限（请谨慎）',
  };

  const FAILOVER_HINTS = {
    subscription_only: '仅用 ChatGPT/Codex 订阅额度，不走按量付费 API',
    api_fallback: '按档位路由时，订阅失败可转按量 API。指定配对的任务只用所选订阅模型。',
  };

  const EFFORT_HINTS = {
    medium: '当前档固定中等思考（适合日常开发、UI 与常规修改）',
    high: '当前档固定高思考（适合跨文件排查与复杂工程；Opus 甜点档）',
    xhigh: '当前档固定极高思考（适合算法/数学与核心攻坚；Opus 自动升 Astra）',
    auto: '按任务风险自动定档（low..xhigh，Astra 兜底 ≥ 高；续跑锁档不中途加码）',
  };

  const EFFORT_NAMES = {
    medium: '中',
    high: '高',
    xhigh: '极高',
    auto: '智能定档',
  };

  const SANDBOX_NAMES = {
    'read-only': '只读',
    'workspace-write': '工作区',
    'danger-full-access': '全权限',
  };

  let latestState = null;
  let stateFetch = null;
  let currentDefaultTier = 'sonnet';
  let currentDefaultSandbox = 'workspace-write';
  let currentFailoverMode = 'subscription_only';
  let currentEffortChoice = 'high';
  let currentAutoEffort = false;
  let currentViewMode = queryViewMode || readStoredMode();
  let toastTimer = null;

  function readStoredMode() {
    try {
      const saved = window.localStorage?.getItem(MODE_STORAGE_KEY);
      return saved === 'native' || saved === 'mcp' ? saved : '';
    } catch {
      return '';
    }
  }

  function writeStoredMode(mode) {
    try {
      window.localStorage?.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures inside restricted sandboxes.
    }
  }

  function applyHostTheme() {
    const theme = params.get('theme');
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.dataset.theme = theme;
    }
    const rawTokens = params.get('tokens');
    if (!rawTokens) return;
    try {
      const json = decodeURIComponent(escape(atob(rawTokens)));
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (!/^--[a-z0-9-]+$/i.test(k)) continue;
          const val = String(v ?? '').trim();
          if (!val || val.length > 200 || /[;{}]|url\(/i.test(val)) continue;
          document.documentElement.style.setProperty(k, val);
        }
      }
    } catch {
      // Fall back to default Magpie CSS tokens.
    }
  }

  applyHostTheme();

  function syncHasFallbackClasses() {
    if (SUPPORTS_HAS) return;
    for (const row of document.querySelectorAll('.tier-row')) {
      const radio = row.querySelector('.tier-radio');
      row.classList.toggle('is-checked', Boolean(radio?.checked));
      row.classList.toggle('is-disabled', Boolean(radio?.disabled));
    }
    for (const opt of document.querySelectorAll('.seg-option')) {
      const radio = opt.querySelector('.seg-radio');
      opt.classList.toggle('is-checked', Boolean(radio?.checked));
      opt.classList.toggle('is-disabled', Boolean(radio?.disabled));
    }
  }

  async function apiFetch(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
      'x-gempt-key': apiKey,
    };
    return fetch(path, { ...options, headers });
  }

  function showToast(message, kind = 'info') {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  function titleCaseTier(id) {
    if (!id) return 'Sonnet';
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  function formatEffortLabel(effort, { detailed = true, escalated = false, threshold = 'high', auto = false } = {}) {
    const raw = String(effort || 'medium').trim().toLowerCase();
    const shortWord = (EFFORT_LABELS[raw] || `思考：${raw}`).replace(/^思考：/, '');
    const threshRaw = String(threshold || 'high').trim().toLowerCase();
    const threshWord = (EFFORT_LABELS[threshRaw] || `思考：${threshRaw}`).replace(/^思考：/, '');
    const showEscalation = Boolean(escalated && threshWord && threshWord !== shortWord);
    if (auto) {
      return showEscalation
        ? `智能定档 · 基准${shortWord} → ${threshWord}`
        : `智能定档 · 基准${shortWord}`;
    }
    if (showEscalation) {
      return detailed ? `思考深度：${shortWord} → ${threshWord}` : `思考：${shortWord} → ${threshWord}`;
    }
    return detailed ? `思考深度：${shortWord}` : `思考：${shortWord}`;
  }

  function humanizeModel(rawId) {
    const id = String(rawId || '').trim();
    if (!id) return '未知模型';
    if (id.startsWith('group/')) return id.slice('group/'.length);
    const tail = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
    return tail
      .replace(/^gpt-/i, 'GPT-')
      .replace(/^gemini-/i, 'Gemini ')
      .replace(/\bhydrogen\b/gi, 'Hydrogen')
      .replace(/\bneon\b/gi, 'Neon')
      .replace(/\bargon\b/gi, 'Argon')
      .replace(/\bcarbon\b/gi, 'Carbon')
      .replace(/\bsol\b/gi, 'Sol')
      .replace(/\bastra\b/gi, 'Astra')
      .replace(/\bterra\b/gi, 'Terra')
      .replace(/\bluna\b/gi, 'Luna')
      .replace(/\bdeepseek\b/gi, 'DeepSeek')
      .replace(/-?flash\b/gi, ' Flash')
      .replace(/-v(\d)/gi, ' V$1');
  }

  function resolveEffectiveViewMode(state) {
    if (currentViewMode === 'mcp' || currentViewMode === 'native') {
      return currentViewMode;
    }
    if (state?.native_groups?.complete && !state?.clients?.antigravity_installed) {
      return 'native';
    }
    return 'mcp';
  }

  function buildMcpChain(tier) {
    const nodes = [];
    const seen = new Set();
    const pushNode = (raw, role) => {
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      nodes.push({ id, human: humanizeModel(id), role });
    };

    const members = Array.isArray(tier.magpie_group_members) ? tier.magpie_group_members : [];
    const consult = String(tier.consult_model || '').trim();
    const isGroup = consult.startsWith('group/');

    if (isGroup && members.length) {
      members.forEach((m, idx) => {
        if (idx === 0) pushNode(m, 'primary');
        else if (tier.escalate_model && m === tier.escalate_model) pushNode(m, 'escalate');
        else pushNode(m, 'fallback');
      });
    } else {
      pushNode(consult, 'primary');
      if (tier.exec_model && tier.exec_model !== consult) {
        pushNode(tier.exec_model, 'exec');
      }
      if (tier.escalate_model) {
        pushNode(tier.escalate_model, 'escalate');
      }
      for (const fb of tier.fallback_models || []) {
        pushNode(fb, 'fallback');
      }
    }
    return nodes;
  }

  function buildNativeChain(nativeTier) {
    const rawNodes = Array.isArray(nativeTier?.nodes) ? nativeTier.nodes : [];
    return rawNodes
      .filter((n) => n && n.id)
      .map((n) => ({
        id: String(n.id),
        human: humanizeModel(n.id),
        role: String(n.role || 'coder'),
      }));
  }

  function formatMcpSummary(tier) {
    const chain = buildMcpChain(tier);
    if (!chain.length) return formatEffortLabel(tier.reasoning_effort, { detailed: false });
    let summary = chain[0].human;
    const escNode = chain.slice(1).find((n) => n.role === 'escalate');
    const fbCount = chain.slice(1).filter((n) => n.role !== 'escalate').length;
    if (escNode) summary += ` ↗ 升级 ${escNode.human}`;
    else if (fbCount === 1) summary += ` → 备用 ${chain[1].human}`;
    if (escNode && fbCount > 0) summary += ` · +${fbCount} 备用`;
    else if (!escNode && fbCount > 1) summary += ` · +${fbCount} 备用`;
    return summary;
  }

  function formatNativeSummary(nativeTier) {
    const chain = buildNativeChain(nativeTier);
    if (!chain.length) return '尚未检测到 Gemini + Codex 订阅模型';
    const planner = chain.find((n) => n.role === 'planner')?.human || '';
    const coders = chain.filter((n) => n.role === 'coder' || n.role === 'escalate').map((n) => n.human);
    const hasUtil = chain.some((n) => n.role === 'utility');
    let text = planner && coders.length
      ? `${planner} → ${coders.join(' / ')}`
      : (coders.join(' / ') || planner);
    if (hasUtil) text += ' · DeepSeek 压缩';
    return text;
  }

  function formatMcpClientSubtitle(clients) {
    const parts = [];
    if (clients?.antigravity_installed) parts.push('Antigravity（官方 Gemini）');
    for (const ext of clients?.external_clients || []) {
      if (!parts.includes(ext)) parts.push(ext);
      if (parts.length >= 4) break;
    }
    if (!parts.length) return 'Claude Code · ZCode · Cursor · CLI';
    if (parts.length === 1) return `${parts[0]} · CLI · 任意 MCP 客户端`;
    return parts.join(' · ');
  }

  function formatNativeClientSubtitle(clients) {
    const ext = clients?.external_clients || [];
    if (!ext.length) return 'Claude Code · ZCode · OpenCode · Cursor';
    const slice = ext.slice(0, 3);
    return `${slice.join(' · ')} · 任意客户端`;
  }

  function renderSetupBanner(state, viewMode) {
    const banner = $('setup-banner');
    const textEl = $('setup-banner-text');
    const btn = $('init-sub-btn');
    if (!banner || !textEl || !btn) return;

    const reachable = Boolean(state.magpie?.reachable);
    const subReady = Boolean(state.subscription?.connected);
    const configured = Boolean(state.configured);

    if (!reachable) {
      banner.hidden = false;
      banner.dataset.tone = 'warn';
      textEl.textContent = '尚未连上本地 Magpie — 请先启动 Magpie，再点右上角刷新。';
      btn.hidden = true;
      return;
    }

    if (viewMode === 'native') {
      if (!subReady && !state.native_groups?.complete) {
        banner.hidden = false;
        banner.dataset.tone = 'warn';
        textEl.textContent = '尚未检测到 Codex 订阅 — 请先在 Magpie 左侧接入你的 ChatGPT / Codex 订阅账号，完成后点右上角刷新。';
        btn.hidden = true;
        return;
      }
      banner.hidden = true;
      btn.hidden = true;
      return;
    }

    if (configured && subReady) {
      banner.hidden = true;
      btn.hidden = true;
      return;
    }

    banner.hidden = false;
    if (!subReady) {
      banner.dataset.tone = 'warn';
      textEl.textContent = '尚未检测到 Codex 订阅 — 请先在 Magpie 左侧接入你的 ChatGPT / Codex 订阅账号，完成后点右上角刷新即可自动连上。';
      btn.hidden = true;
    } else {
      banner.dataset.tone = 'ready';
      const rec = state.subscription?.recommended;
      const sonnetHuman = humanizeModel(rec?.tiers?.sonnet?.consult_model);
      const fableHuman = humanizeModel(rec?.tiers?.fable?.consult_model);
      const modelNote = sonnetHuman && fableHuman && sonnetHuman !== fableHuman
        ? `${sonnetHuman} / ${fableHuman}`
        : (sonnetHuman || 'Codex 订阅模型');
      textEl.textContent = `已检测到 Codex 订阅（${modelNote}），点击即可启用全客户端共享的 MCP / CLI 配置：`;
      btn.hidden = false;
      btn.disabled = false;
    }
  }

  function renderWorkSplit(state, viewMode) {
    const controls = $('work-controls');
    controls.hidden = viewMode !== 'mcp';
    const profiles = state.work_profiles;
    if (!profiles) return;
    const list = $('work-options');
    const swarm = $('swarm-split');
    if (!list.children.length) {
      swarm.add(new Option('跟随普通对话', 'inherit'));
      for (const [id, profile] of Object.entries(profiles)) {
        const isOff = profile.gpt_share === 0;
        const label = document.createElement('label');
        label.className = 'work-option';
        label.classList.toggle('is-off', isOff);
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'work_split';
        radio.value = id;
        const title = document.createElement('strong');
        title.textContent = profile.label;
        const weight = document.createElement('small');
        weight.textContent = isOff ? '纯 Gemini · 不派单' : 'GPT 约 ' + profile.gpt_share + '%';
        label.append(radio, title, weight);
        list.append(label);
        swarm.add(new Option(isOff ? profile.label + ' · 纯 Gemini' : profile.label + ' · ' + weight.textContent, id));
      }
    }
    for (const radio of list.querySelectorAll('input')) {
      radio.checked = radio.value === state.work_split;
      radio.disabled = !state.configured;
    }
    swarm.disabled = !state.configured;
    swarm.value = state.swarm_split;
    renderPairings(state);
    const ordinary = profiles[state.work_split];
    const team = profiles[state.swarm_split] || ordinary;
    const workDetail = $('work-detail');
    workDetail.textContent = ordinary?.detail || '';
    if (ordinary?.gpt_share !== 0) {
      workDetail.textContent += ' 比例表示工作量倾向，实际额度随任务变化。';
      if (state.tools?.exec_enabled === false) {
        workDetail.textContent += ' Magpie 原生工具目前仅可咨询。需要 Codex 操作文件时，在 GemPT 插件选项开启 exec。';
      }
    }
    $('swarm-detail').textContent = team?.gpt_share === 0
      ? team.detail
      : (team?.label || '') + ' · 协调者拆单和解说，成员按各自职责派单，核验者独立检查。';
  }

  function renderPairings(state) {
    const list = $('pairing-options');
    const models = state.magpie?.codex_models || [];
    for (const [family, current] of Object.entries(state.pairings || {})) {
      let select = list.querySelector(`[name="pair-${family}"]`);
      if (!select) {
        const label = document.createElement('label');
        label.textContent = family.charAt(0).toUpperCase() + family.slice(1);
        select = document.createElement('select');
        select.name = 'pair-' + family;
        select.dataset.family = family;
        label.append(select);
        list.append(label);
      }
      const choices = [new Option('沿用默认档位', 'default')];
      for (const id of models) choices.push(new Option(humanizeModel(id), id));
      if (current !== 'default' && !models.includes(current)) {
        choices.push(new Option(humanizeModel(current) + '（未检测到）', current));
      }
      select.replaceChildren(...choices);
      select.value = current;
      select.disabled = !state.configured;
    }
  }

  function renderControls(state, viewMode) {
    renderWorkSplit(state, viewMode);
    const mcpBar = $('mcp-controls-bar');
    const nativeBar = $('native-controls-bar');
    if (mcpBar) mcpBar.hidden = viewMode !== 'mcp';
    if (nativeBar) nativeBar.hidden = viewMode !== 'native';

    const configured = Boolean(state.configured);
    currentDefaultSandbox = state.default_sandbox || 'workspace-write';
    for (const radio of document.querySelectorAll('input[name="default_sandbox"]')) {
      radio.checked = radio.value === currentDefaultSandbox;
      radio.disabled = !configured;
    }
    const sbxHint = $('sandbox-hint');
    if (sbxHint) {
      const baseHint = SANDBOX_HINTS[currentDefaultSandbox] || currentDefaultSandbox;
      sbxHint.textContent = state.tools?.exec_enabled === false
        ? `${baseHint} · gempt_exec 默认关闭（插件选项设 exec: true 后生效）`
        : baseHint;
    }

    const activeTier = (state.tiers || []).find((t) => t.id === currentDefaultTier) || state.tiers?.[0];
    currentAutoEffort = Boolean(state.auto_effort);
    const activeTierEffort = String(activeTier?.reasoning_effort || 'medium').trim().toLowerCase();
    currentEffortChoice = currentAutoEffort ? 'auto' : activeTierEffort;
    for (const radio of document.querySelectorAll('input[name="active_effort"]')) {
      radio.checked = radio.value === currentEffortChoice;
      radio.disabled = !configured;
    }
    const effHint = $('effort-hint');
    if (effHint) {
      if (!configured) {
        effHint.textContent = '未初始化配置前默认按订阅甜点档执行';
      } else if (currentAutoEffort) {
        effHint.textContent = EFFORT_HINTS.auto;
      } else {
        effHint.textContent = EFFORT_HINTS[activeTierEffort]
          || `当前 ${titleCaseTier(currentDefaultTier)} 档思考深度：${activeTierEffort}`;
      }
    }

    const failoverGroup = $('failover-control-group');
    const apiEnabled = Boolean(state.features?.api_fallback);
    currentFailoverMode = state.failover_mode || 'subscription_only';

    if (failoverGroup) {
      failoverGroup.hidden = !apiEnabled;
      if (apiEnabled) {
        const apiAvailable = Boolean(state.api_fallback?.available) || currentFailoverMode === 'api_fallback';
        for (const radio of document.querySelectorAll('input[name="failover_mode"]')) {
          radio.checked = radio.value === currentFailoverMode;
          if (!configured) {
            radio.disabled = true;
          } else if (radio.value === 'api_fallback') {
            radio.disabled = !apiAvailable;
          } else {
            radio.disabled = false;
          }
        }
        const fmHint = $('failover-hint');
        if (fmHint) {
          fmHint.textContent = !apiAvailable
            ? '未检测到按量 openai/* 渠道，当前仅可用订阅直连'
            : (FAILOVER_HINTS[currentFailoverMode] || FAILOVER_HINTS.subscription_only);
        }
      }
    }

    const nativeCopy = $('native-status-copy');
    const nativePills = $('native-ready-pills');
    const createBtn = $('create-native-btn');
    const ng = state.native_groups || {};
    if (nativeCopy && nativePills && createBtn) {
      const installedSet = new Set((ng.tiers || []).filter((t) => t.installed).map((t) => t.group_id));
      for (const pill of nativePills.querySelectorAll('[data-copy]')) {
        pill.hidden = !installedSet.has(pill.getAttribute('data-copy'));
      }
      if (ng.complete) {
        nativeCopy.textContent = '已就绪（3/3）· 在任意接入 Magpie 的客户端模型栏直接选下方 ID：';
        nativePills.hidden = false;
        createBtn.hidden = true;
      } else if (ng.can_create) {
        const ready = Number(ng.ready_count || 0);
        nativeCopy.textContent = ready > 0
          ? `已创建 ${ready}/3 个路由组，点击可补齐剩余直连路由组（不会覆盖已有组）：`
          : '无需安装客户端插件 — 点击一键在 Magpie 创建 group/gempt-* 即可在任何客户端直选使用：';
        nativePills.hidden = ready === 0;
        createBtn.hidden = false;
        createBtn.disabled = false;
        createBtn.textContent = ready > 0 ? '补齐缺失路由组' : '一键创建直连路由组';
      } else {
        nativeCopy.textContent = ng.missing_reason || '需要 Magpie 中同时接入 Gemini 与 Codex 订阅模型后才能创建直连路由组。';
        nativePills.hidden = true;
        createBtn.hidden = false;
        createBtn.disabled = true;
        createBtn.textContent = '一键创建直连路由组';
      }
    }
  }

  function renderChainNodes(chainEl, nodes, emptyText) {
    if (!chainEl) return;
    chainEl.replaceChildren();
    if (!nodes.length) {
      const li = document.createElement('li');
      li.className = 'route-node';
      const left = document.createElement('span');
      left.className = 'node-left';
      const human = document.createElement('span');
      human.className = 'node-human';
      human.textContent = emptyText;
      left.append(human);
      li.append(left);
      chainEl.appendChild(li);
      return;
    }

    for (const node of nodes.slice(0, 4)) {
      const isPrimaryLike = node.role === 'primary' || node.role === 'planner';
      const isDashedLike = node.role === 'fallback' || node.role === 'utility';
      const li = document.createElement('li');
      li.className = `route-node${isPrimaryLike ? ' is-primary' : ''}${isDashedLike ? ' is-fallback' : ''}`;

      const left = document.createElement('span');
      left.className = 'node-left';
      const dot = document.createElement('span');
      dot.className = 'node-dot';
      dot.setAttribute('aria-hidden', 'true');
      const human = document.createElement('span');
      human.className = 'node-human';
      human.textContent = node.human;
      const code = document.createElement('code');
      code.className = 'pill-code';
      code.textContent = node.id;
      left.append(dot, human, code);

      const role = document.createElement('span');
      role.className = 'node-role';
      role.textContent = NODE_ROLE_LABELS[node.role] || node.role;

      li.append(left, role);
      chainEl.appendChild(li);
    }
  }

  function renderActiveRoute(state, activeTier, activeNativeTier, viewMode) {
    const nameEl = $('active-tier-name');
    const targetBtn = $('active-tier-target');
    const readyBadge = $('active-tier-ready-badge');
    const effortEl = $('active-tier-effort');
    const sourceTitle = $('source-title');
    const sourceSub = $('source-sub');
    const copyMcpBtn = $('copy-mcp-btn');
    const copyRulesBtn = $('copy-rules-btn');
    const slashBtn = $('active-slash-btn');
    const hubBox = $('flow-hub-box');
    const hubModeText = $('hub-mode-text');
    const chainEl = $('route-chain');

    const tierId = activeTier?.id || state.default_tier || 'sonnet';
    if (nameEl) nameEl.textContent = titleCaseTier(tierId);
    if (hubBox) hubBox.title = state.magpie?.url || 'http://127.0.0.1:3425';

    if (viewMode === 'native') {
      const groupId = activeNativeTier?.group_id || `group/gempt-${tierId}`;
      const installed = Boolean(activeNativeTier?.installed);
      if (targetBtn) {
        targetBtn.textContent = groupId;
        targetBtn.setAttribute('data-copy', groupId);
        targetBtn.title = `点击复制 ${groupId}`;
        targetBtn.hidden = false;
      }
      if (readyBadge) {
        readyBadge.hidden = false;
        readyBadge.dataset.tone = installed ? 'ok' : 'warn';
        readyBadge.textContent = installed ? '已就绪' : '未创建';
      }
      if (effortEl) effortEl.textContent = '按意图自动分流';
      if (sourceTitle) sourceTitle.textContent = '外部客户端直连';
      if (sourceSub) sourceSub.textContent = formatNativeClientSubtitle(state.clients);
      if (copyMcpBtn) copyMcpBtn.hidden = true;
      if (copyRulesBtn) copyRulesBtn.hidden = true;
      if (slashBtn) {
        slashBtn.hidden = false;
        slashBtn.textContent = groupId;
        slashBtn.setAttribute('data-copy', groupId);
        slashBtn.title = `点击复制 ${groupId}`;
      }
      if (hubModeText) hubModeText.textContent = '意图路由分流';
      renderChainNodes(chainEl, buildNativeChain(activeNativeTier), '需先在 Magpie 接入 Gemini 与 Codex 模型');
      return;
    }

    const consultModel = String(activeTier?.consult_model || 'codex/gpt-6.2-sol');
    const isGroup = consultModel.startsWith('group/');
    if (targetBtn) {
      targetBtn.textContent = consultModel;
      targetBtn.setAttribute('data-copy', consultModel);
      targetBtn.title = `点击复制 ${consultModel}`;
      targetBtn.hidden = !isGroup;
    }
    if (readyBadge) readyBadge.hidden = true;
    if (effortEl) {
      effortEl.textContent = formatEffortLabel(activeTier?.reasoning_effort, {
        detailed: true,
        escalated: Boolean(activeTier?.escalate_model),
        threshold: activeTier?.escalate_effort_threshold || 'high',
        auto: currentAutoEffort,
      });
    }
    if (sourceTitle) sourceTitle.textContent = 'MCP 客户端';
    if (sourceSub) sourceSub.textContent = formatMcpClientSubtitle(state.clients);
    if (copyMcpBtn) copyMcpBtn.hidden = false;
    if (copyRulesBtn) copyRulesBtn.hidden = false;
    if (slashBtn) {
      const hasAgy = Boolean(state.clients?.antigravity_installed);
      slashBtn.hidden = !hasAgy;
      if (hasAgy) {
        const cmd = `/gempt-${tierId}`;
        slashBtn.textContent = cmd;
        slashBtn.setAttribute('data-copy', `${cmd} `);
        slashBtn.title = '点击复制 Antigravity 单轮快捷指令';
      }
    }
    if (hubModeText) {
      if (state.features?.api_fallback && state.failover_mode === 'api_fallback') {
        hubModeText.textContent = '订阅优先 · API 兜底';
      } else if (state.features?.api_fallback) {
        hubModeText.textContent = '仅用 Codex 订阅';
      } else {
        hubModeText.textContent = 'Codex 订阅直连';
      }
    }
    renderChainNodes(chainEl, buildMcpChain(activeTier), '尚未配置模型');
  }

  function renderReadiness(state) {
    const ng = state.native_groups || {};
    const clients = state.clients || {};

    const chipNative = $('chip-native');
    const chipNativeVal = $('chip-native-val');
    if (chipNative && chipNativeVal) {
      const ready = Number(ng.ready_count || 0);
      chipNative.dataset.tone = ng.complete ? 'ok' : (ready > 0 ? 'warn' : 'neutral');
      chipNativeVal.textContent = ng.complete ? '3/3 已就绪' : (ready > 0 ? `${ready}/3` : '未创建');
    }

    const chipMcp = $('chip-mcp');
    const chipMcpVal = $('chip-mcp-val');
    if (chipMcp && chipMcpVal) {
      if (clients.native_tools_registered) {
        chipMcp.dataset.tone = 'ok';
        const agentCount = Array.isArray(clients.native_tools_agents) ? clients.native_tools_agents.length : 0;
        chipMcpVal.textContent = agentCount > 0 ? `已自动同步 ${agentCount} 端` : 'Magpie 自动托管';
      } else if (clients.magpie_mcp_registered) {
        chipMcp.dataset.tone = 'ok';
        chipMcpVal.textContent = 'Magpie MCP 已接入';
      } else {
        chipMcp.dataset.tone = 'neutral';
        chipMcpVal.textContent = '复制独立配置';
      }
    }

    const chipAgy = $('chip-agy');
    const chipAgyVal = $('chip-agy-val');
    if (chipAgy && chipAgyVal) {
      chipAgy.dataset.tone = clients.antigravity_installed ? 'ok' : 'neutral';
      chipAgyVal.textContent = clients.antigravity_installed ? '插件已安装' : '未安装';
    }
  }

  function formatRunMeta(run) {
    if (run.verification === 'passed') return '已通过';
    if (run.verification === 'failed' || run.state === 'failed') return '失败';
    if (run.state === 'waiting_gemini') return '等待 Gemini';
    if (run.state === 'interrupted') return '已中止';
    if (run.state === 'running' || run.state === 'queued') return '进行中';
    if (run.state === 'finished') return '已完成';
    if (run.state === 'outcome_unknown') return '状态未知';
    return run.state || '已记录';
  }

  function formatGroupStatus(status) {
    const code = Number(status || 0);
    if (code >= 200 && code < 400) return '正常';
    if (code >= 400) return `HTTP ${code}`;
    return '已记录';
  }

  function renderActivity(state) {
    const list = $('activity-list');
    const count = $('activity-count');
    if (!list || !count) return;

    const runs = (state.recent_runs || []).map((run) => ({
      tone: run.verification === 'passed' ? 'ok' : (run.state === 'failed' || run.verification === 'failed' ? 'err' : 'neutral'),
      text: `执行 · ${titleCaseTier(run.tier || 'exec')} · ${run.title || run.cwd_name || run.run_id.slice(0, 8)}`,
      meta: formatRunMeta(run),
    }));
    const sessions = (state.recent_sessions || []).map((sess) => {
      const agentTag = sess.agent ? ` · ${sess.agent}` : '';
      return {
        tone: 'ok',
        text: `${sess.mode === 'exec' ? '执行' : '咨询'} · ${titleCaseTier(sess.tier || 'sonnet')}${agentTag} · ${sess.title || sess.cwd_name || 'GPT 任务'}`,
        meta: `${Math.max(1, Math.floor((sess.turns || 0) / 2))} 轮`,
      };
    });
    const groupCalls = (state.recent_group_calls || []).map((call) => {
      const status = Number(call.status || 0);
      const tone = status >= 200 && status < 400 ? 'ok' : (status >= 400 ? 'err' : 'neutral');
      const clientLabel = call.agent || '外部客户端';
      const servedLabel = call.served_model ? ` (${humanizeModel(call.served_model)})` : '';
      return {
        tone,
        text: `路由组 · ${titleCaseTier(call.tier || 'sonnet')} · ${clientLabel}${servedLabel}`,
        meta: formatGroupStatus(status),
      };
    });

    const rows = [...runs, ...sessions, ...groupCalls].slice(0, 5);
    const totals = state.activity_totals;
    count.textContent = totals ? `${number(totals.requests)} 个请求 · ${number(totals.sessions)} 个会话 · ${number(totals.runs)} 次运行` : '—';
    list.replaceChildren();

    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'recent-empty';
      li.textContent = '暂无最近委派或路由组记录。';
      list.appendChild(li);
      return;
    }

    for (const item of rows) {
      const li = document.createElement('li');
      li.className = 'recent-row';

      const left = document.createElement('span');
      left.className = 'recent-left';
      const dot = document.createElement('span');
      dot.className = 'recent-dot';
      dot.dataset.tone = item.tone;
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'recent-text';
      text.textContent = item.text;
      left.append(dot, text);

      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      meta.textContent = item.meta;

      li.append(left, meta);
      list.appendChild(li);
    }
  }

  function renderState(state) {
    if (!state) return;
    latestState = state;
    if (!currentDefaultTier || state.configured) {
      currentDefaultTier = state.default_tier || 'sonnet';
    }
    const viewMode = resolveEffectiveViewMode(state);
    currentViewMode = viewMode;

    for (const radio of document.querySelectorAll('input[name="view_mode"]')) {
      radio.checked = radio.value === viewMode;
    }

    const status = $('magpie-status');
    const statusText = $('magpie-status-text');
    if (status && statusText) {
      if (!state.magpie?.reachable) {
        status.dataset.state = 'offline';
        statusText.textContent = '未连接';
        status.title = state.magpie?.error || 'Magpie 暂不可达';
      } else if (!state.subscription?.connected && !state.native_groups?.complete) {
        status.dataset.state = 'warn';
        statusText.textContent = '待登录 Codex 订阅';
        status.title = state.magpie?.url || '';
      } else {
        status.dataset.state = 'online';
        statusText.textContent = '已连接';
        status.title = state.magpie?.url || '';
      }
    }

    renderSetupBanner(state, viewMode);
    renderControls(state, viewMode);
    renderReadiness(state);

    const tiersMeta = $('tiers-section-meta');
    if (tiersMeta) {
      tiersMeta.textContent = viewMode === 'native'
        ? '点击切换预览 · 外部客户端模型栏直选 group/gempt-*'
        : '所有 MCP 客户端与 CLI 共享 · 点击切换默认档位';
    }

    const tiersById = new Map((state.tiers || []).map((t) => [t.id, t]));
    const nativeById = new Map((state.native_groups?.tiers || []).map((t) => [t.id, t]));
    const allowRowSelect = Boolean(state.configured) || viewMode === 'native';

    for (const row of document.querySelectorAll('.tier-row')) {
      const tierId = row.dataset.tier;
      const radio = row.querySelector('.tier-radio');
      if (radio) {
        radio.checked = tierId === currentDefaultTier;
        radio.disabled = !allowRowSelect;
      }
      const info = tiersById.get(tierId);
      const nativeInfo = nativeById.get(tierId);

      const nameEl = row.querySelector('[data-field="short_name"]');
      const pillEl = row.querySelector('[data-field="target_pill"]');
      const subEl = row.querySelector('[data-field="chain_summary"]');
      const roleEl = row.querySelector('[data-field="role_desc"]');
      const effortEl = row.querySelector('[data-field="effort_tag"]');

      if (nameEl) nameEl.textContent = titleCaseTier(tierId);
      if (roleEl) roleEl.textContent = ROLE_TEXT[tierId] || '';

      if (viewMode === 'native') {
        if (pillEl) pillEl.textContent = nativeInfo?.group_id || `group/gempt-${tierId}`;
        if (subEl) subEl.textContent = formatNativeSummary(nativeInfo);
        if (effortEl) effortEl.textContent = nativeInfo?.installed ? '已就绪' : '未创建';
      } else if (info) {
        if (pillEl) pillEl.textContent = info.consult_model;
        if (subEl) subEl.textContent = formatMcpSummary(info);
        if (effortEl) {
          effortEl.textContent = formatEffortLabel(info.reasoning_effort, {
            detailed: false,
            escalated: Boolean(info.escalate_model),
            threshold: info.escalate_effort_threshold || 'high',
          });
        }
      }
    }

    renderActiveRoute(
      state,
      tiersById.get(currentDefaultTier) || state.tiers?.[0],
      nativeById.get(currentDefaultTier) || state.native_groups?.tiers?.[0],
      viewMode,
    );

    const choreModel = $('chore-model');
    const choreSub = $('chore-sub');
    if (state.utility) {
      if (choreModel) choreModel.textContent = state.utility.model;
      if (choreSub) {
        const parts = ['仅咨询'];
        if (state.utility.use_for_magpie_compact) parts.push('自动压缩上下文');
        if (state.utility.fallback_models?.length) parts.push(`+${state.utility.fallback_models.length} 备用`);
        choreSub.textContent = parts.join(' · ');
      }
    }

    const stripNative = $('strip-native-ids');
    const stripAgy = $('strip-agy-slash');
    const hasAgy = Boolean(state.clients?.antigravity_installed);
    if (stripNative) stripNative.hidden = !(viewMode === 'native' || !hasAgy);
    if (stripAgy) stripAgy.hidden = !hasAgy;

    renderActivity(state);
    syncHasFallbackClasses();
    markUiReady();
  }

  function markUiReady() {
    if (document.documentElement.classList.contains('gp-ready')) return;
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('gp-ready')));
  }

  async function refreshState({ manual = false, live = false } = {}) {
    if (live && stateFetch) return;
    stateFetch?.abort();
    const abort = stateFetch = new AbortController();
    const refreshBtn = $('refresh-btn');
    if (manual && refreshBtn) refreshBtn.classList.add('is-spinning');
    try {
      const res = await apiFetch('/api/state', { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (abort.signal.aborted) return;
      if (live) {
        latestState = { ...latestState, app_server: data.app_server, active_runs: data.active_runs };
      } else {
        renderState(data);
      }
      renderLiveOverview(data);
      // The slow state refresh also discovers runs when an activity list is idle.
      const view = activityViews[activeTab];
      if (view && !view.open && !view.listFetch && !view.items.some(isActiveRun)
          && data.active_runs?.length) {
        void refreshActivityView(view);
      }
      if (manual) showToast('状态已更新');
    } catch (err) {
      if (manual && !abort.signal.aborted) showToast(`刷新失败: ${err.message}`, 'error');
    } finally {
      if (stateFetch === abort) {
        stateFetch = null;
        markUiReady();
        refreshBtn?.classList.remove('is-spinning');
        syncLivePoll();
      }
    }
  }

  async function activateSubscriptionConfig() {
    const btn = $('init-sub-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/api/init', { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      showToast('已启用全客户端共享配置');
    } catch (err) {
      showToast(`启用失败: ${err.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
      await refreshState();
    }
  }

  async function createNativeGroupsAction() {
    const btn = $('create-native-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/api/native-groups', { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      const createdCount = Array.isArray(payload.created) ? payload.created.length : 0;
      const skippedCount = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
      if (createdCount > 0 && skippedCount > 0) {
        showToast(`已补齐 ${createdCount} 个路由组（保留已有 ${skippedCount} 个）`);
      } else if (createdCount > 0) {
        showToast(`已创建 ${createdCount} 个直连路由组`);
      } else {
        showToast('直连路由组已就绪');
      }
    } catch (err) {
      showToast(`创建失败: ${err.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
      await refreshState();
    }
  }

  async function switchDefaultTier(nextTier) {
    const previous = currentDefaultTier;
    if (!latestState?.configured) {
      currentDefaultTier = nextTier;
      renderState(latestState);
      return;
    }

    const radios = [...document.querySelectorAll('input[name="default_tier"]')];
    for (const r of radios) r.disabled = true;
    syncHasFallbackClasses();

    try {
      const res = await apiFetch('/api/tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: nextTier }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      currentDefaultTier = payload.default_tier || nextTier;
      showToast(`默认档位已切换为 ${titleCaseTier(currentDefaultTier)}`);
    } catch (err) {
      for (const r of radios) {
        r.checked = r.value === previous;
      }
      syncHasFallbackClasses();
      showToast(`切换失败: ${err.message}`, 'error');
    } finally {
      await refreshState();
    }
  }

  async function updateSetting(groupName, payloadBody, previousValue, successText) {
    const radios = [...document.querySelectorAll(`[name="${groupName}"]`)];
    for (const r of radios) r.disabled = true;
    syncHasFallbackClasses();

    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      showToast(successText);
    } catch (err) {
      for (const r of radios) {
        if (r.tagName === 'SELECT') r.value = previousValue;
        else r.checked = r.value === previousValue;
      }
      syncHasFallbackClasses();
      showToast(`设置失败: ${err.message}`, 'error');
    } finally {
      await refreshState();
    }
  }

  async function copyText(text, customMessage = '') {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast(customMessage || `已复制 ${text.trim()}`);
        return;
      }
    } catch {
      // Fall through to legacy textarea copy fallback.
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(customMessage || `已复制 ${text.trim()}`);
    } catch {
      showToast('复制失败，请手动输入或复制', 'error');
    } finally {
      ta.remove();
    }
  }

  function copyMcpConfig() {
    const jsonText = latestState?.mcp_snippet?.json;
    if (!jsonText) {
      showToast('MCP 配置尚未就绪，请先刷新状态', 'error');
      return;
    }
    copyText(jsonText, '已复制独立 MCP JSON 配置（仅非 Magpie 托管客户端需要）');
  }

  function copyRulesConfig() {
    const rulesText = latestState?.rules_snippet;
    if (!rulesText) {
      showToast('协作规则尚未就绪，请先刷新状态', 'error');
      return;
    }
    copyText(rulesText, '已复制协作规则（贴入 CLAUDE.md / AGENTS.md 等全局规则）');
  }

  // Ledger and session presentation adapted from Magpie's usage-page.js (MIT).
  const activityTabs = ['overview', 'requests', 'sessions'];
  const activityPageSize = 25;
  const activityViews = Object.fromEntries(['requests', 'sessions'].map((kind) => {
    const list = $(`${kind}-list`);
    return [kind, {
      kind, list, detail: $(`${kind}-detail`), results: list.querySelector('.activity-results'),
      summary: list.querySelector('.activity-summary-line'), stats: list.querySelector('.activity-stats'),
      offset: 0, items: [], status: '', total: 0, loaded: false, listFetch: null, open: null,
    }];
  }));
  const modes = { consult: '咨询', exec: '执行' };
  const statuses = {
    succeeded: '成功', finished: '成功', failed: '失败', retried: '重试', running: '运行中', queued: '排队中',
    waiting_gemini: '等待 Gemini', interrupted: '已中止', outcome_unknown: '状态未知', canceled: '已取消',
  };
  const phases = { ...statuses, connecting: '连接 Codex', completed: '已完成' };
  const activeRunStates = new Set(['queued', 'running', 'waiting_gemini']);
  const interrupts = new Set();
  const overviewRunTimes = new Map();
  const checks = { passed: '已通过', failed: '失败', unverified: '未验证', not_requested: '未要求' };
  const exactNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
  const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
  const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
  let activeTab = 'overview';
  let liveTimer = null;

  function node(tag, cls = '', value = '') {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = value;
    return el;
  }

  function number(value, compact = false) {
    return value == null ? '—' : (compact ? compactNumber : exactNumber).format(value);
  }

  function duration(sec) {
    if (sec == null) return '—';
    if (sec < 1) return `${number(Math.round(sec * 1000))} ms`;
    if (sec < 60) return `${number(Math.round(sec * 10) / 10)} s`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.floor(sec % 60)} 秒`;
    return `${Math.floor(sec / 3600)} 小时 ${Math.floor(sec / 60) % 60} 分`;
  }

  function when(value) {
    return value ? dateTime.format(new Date(value)) : '—';
  }

  function button(label, cls = 'activity-link') {
    const el = node('button', cls, label);
    el.type = 'button';
    return el;
  }

  function filterLabel(key, value) {
    if (key === 'mode') return modes[value] || value;
    if (key === 'status') return statuses[value] || value;
    if (key === 'tier') return value && titleCaseTier(value);
    return value;
  }

  function setActivityFacets(view, facets) {
    for (const select of view.list.querySelectorAll('[data-filter]')) {
      const key = select.dataset.filter;
      const picked = select.value;
      const options = new Map((facets[key] || [])
        .filter(({ value }) => key !== 'status' || !['failed', 'retried'].includes(value))
        .map(({ value, count }) => [value, count]));
      if (picked && !options.has(picked)) options.set(picked, 0);
      select.replaceChildren(select.options[0], ...Array.from(options, ([value, count]) => {
        const option = new Option(`${filterLabel(key, value)} · ${number(count)}`, value);
        option.title = value;
        return option;
      }));
      select.value = picked;
      select.classList.toggle('is-set', Boolean(picked));
    }
  }

  function activityTile(label, value, exact = '') {
    const tile = node('div', 'activity-kpi');
    const figure = node('b', '', value);
    figure.title = exact || value;
    tile.append(figure, node('span', '', label));
    return tile;
  }

  function renderActivitySummary(view, data) {
    const s = data.summary;
    const tile = (label, value) => activityTile(label, number(value, true), number(value));
    if (view.kind === 'requests') {
      const labels = [
        `${number(data.total)} 个请求`, `输入 ${number(s.input_tokens, true)}`, `输出 ${number(s.output_tokens, true)}`,
        `缓存写入 ${number(s.cache_write_tokens, true)}`, `缓存读取 ${number(s.cache_read_tokens, true)}`,
      ];
      if (s.failed) labels.push(`失败 ${number(s.failed)}`);
      if (s.retried) labels.push(`重试 ${number(s.retried)}`);
      view.summary.textContent = labels.join(' · ');
      view.stats.replaceChildren(tile('请求', data.total), tile('Token', s.total_tokens),
        tile('缓存读取', s.cache_read_tokens), activityTile('耗时', duration(s.elapsed_sec)),
        tile('失败', s.failed));
    } else {
      view.summary.textContent = view.items.length < data.total
        ? `显示 ${number(data.total)} 个中的 ${number(view.items.length)} 个` : `${number(data.total)} 个会话`;
      view.stats.replaceChildren(tile('会话', data.total), tile('Token', s.total_tokens), tile('轮次', s.requests),
        tile('缓存读取', s.cache_read_tokens), activityTile('耗时', duration(s.elapsed_sec)), tile('项目', s.workspaces));
    }
  }

  function runState(record) {
    return record?.state || record?.status;
  }

  function isActiveRun(record) {
    return activeRunStates.has(runState(record));
  }

  function statusBadge(record) {
    const status = runState(record);
    const badge = node('span', 'activity-status', statuses[status] || status);
    badge.dataset.status = status;
    if (record.retried) badge.append(' · 重试');
    return badge;
  }

  function pendingQuestion(run) {
    return runState(run) === 'waiting_gemini' ? run.pending_tool_call?.arguments : null;
  }

  async function findRunRequest(runId, signal) {
    const res = await apiFetch(`/api/requests?${new URLSearchParams({ q: runId })}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { items } = await res.json();
    return items.find((request) => request.run_id === runId);
  }

  function interruptButton(run, label) {
    const control = button(label, 'activity-link run-interrupt');
    control.dataset.runAction = 'interrupt';
    if (runState(run) === 'queued') {
      control.disabled = true;
      control.title = '等待 Codex 启动当前轮';
      return control;
    }
    const id = run.run_id;
    control.disabled = interrupts.has(id);
    control.onclick = async () => {
      if (interrupts.has(id)) return;
      interrupts.add(id);
      control.disabled = true;
      try {
        const res = await apiFetch(`/api/runs/${encodeURIComponent(id)}/interrupt`, { method: 'POST' });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
        showToast('已发送中止请求');
      } catch (err) {
        showToast(`中止失败 · ${err.message}`, 'error');
      } finally {
        interrupts.delete(id);
        control.disabled = false;
        await Promise.all([refreshState(), refreshActivityView(activityViews[activeTab])]);
      }
    };
    return control;
  }

  function runElapsed(run, time) {
    const start = Date.parse(time);
    if (Number.isFinite(start)) return duration(Math.max(0, (Date.now() - start) / 1000));
    if (!overviewRunTimes.has(run.run_id) && activeTab === 'overview') {
      overviewRunTimes.set(run.run_id, null);
      // The live state identifies the run. The request ledger supplies its timestamp.
      void findRunRequest(run.run_id).then((request) => {
        if (!overviewRunTimes.has(run.run_id) || !request?.timestamp) return;
        overviewRunTimes.set(run.run_id, request.timestamp);
        const row = $('active-run-list').querySelector(`[data-run-id="${run.run_id}"]`);
        const elapsed = row?.querySelector('.run-elapsed');
        if (elapsed) elapsed.textContent = runElapsed(run, request.timestamp);
      }).finally(() => {
        if (overviewRunTimes.get(run.run_id) === null) overviewRunTimes.delete(run.run_id);
      }).catch(() => {});
    }
    return '—';
  }

  function preview(className, value) {
    const line = node('p', className, value.replace(/\s+/g, ' ').trim());
    line.title = line.textContent;
    return line;
  }

  function renderLiveOverview(state) {
    const server = state.app_server;
    $('chip-app-server').dataset.tone = server?.error ? 'warn' : server?.running ? 'ok' : 'neutral';
    $('chip-app-server-val').textContent = server?.error ? '异常' : server?.running ? '运行中' : '未运行';
    const error = $('app-server-error');
    error.textContent = server?.error || '';
    error.hidden = !server?.error;

    const runs = state.active_runs || [];
    const list = $('active-run-list');
    $('active-runs').hidden = !runs.length;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedRunId = focused?.closest('[data-run-id]')?.dataset.runId;
    let restoreFocus;
    for (const id of overviewRunTimes.keys()) {
      if (!runs.some((run) => run.run_id === id)) overviewRunTimes.delete(id);
    }
    list.replaceChildren(...runs.map((run) => {
      const row = node('li', 'active-run');
      row.dataset.runId = run.run_id;
      const info = node('div', 'active-run-info');
      const head = node('div', 'active-run-meta');
      const title = node('strong', '', run.title || 'GPT 任务');
      title.title = run.cwd || '';
      const phase = run.progress?.phase || run.state;
      head.append(statusBadge(run.state === 'queued' ? { state: 'running' } : run), title,
        node('span', 'run-phase', phases[phase] || phase),
        node('span', 'run-elapsed', runElapsed(run, overviewRunTimes.get(run.run_id))));
      info.append(head);
      const command = run.progress?.recent_commands?.at(-1);
      const snippet = (typeof command === 'string' ? command : command?.command) || run.progress?.last_message;
      if (snippet) info.append(preview('run-preview', snippet));
      const question = pendingQuestion(run)?.question;
      if (question) info.append(preview('run-question', question));
      const actions = node('div', 'active-run-actions');
      const detail = button('查看详情');
      detail.dataset.runAction = 'detail';
      detail.onclick = () => {
        navigateActivityTab('requests');
        openActivityDetail(activityViews.requests, `run-${run.run_id}`, { runId: run.run_id });
      };
      const interrupt = interruptButton(run, '中止');
      actions.append(detail, interrupt);
      row.append(info, actions);
      if (run.run_id === focusedRunId) restoreFocus = focused.dataset.runAction === 'detail' ? detail : interrupt;
      return row;
    }));
    restoreFocus?.focus({ preventScroll: true });
  }

  const ledgerColumns = [
    ['时间', 'when'], ['Agent', 'agent'], ['请求模型', 'model mobile-extra'], ['供应商 · 账号', 'provider mobile-extra'],
    ['发送模型', 'model optional'], ['响应模型', 'model'], ['推理强度', 'optional'], ['输入', 'num'],
    ['输出', 'num'], ['缓存写入', 'num optional'], ['缓存读取', 'num optional'], ['缓存命中率', 'num wide'],
    ['费用', 'num'], ['TTFT', 'num wide'], ['耗时', 'num'], ['速度', 'num'], ['状态', ''],
  ];

  function renderLedger(view) {
    const table = node('table', 'activity-ledger');
    const head = table.createTHead().insertRow();
    for (const [label, cls] of ledgerColumns) {
      const th = node('th', cls, label);
      th.scope = 'col';
      head.append(th);
    }
    const body = table.createTBody();
    for (const r of view.items) {
      const row = body.insertRow();
      row.tabIndex = 0;
      row.dataset.activityId = r.id;
      row.title = r.title;
      const open = () => openActivityDetail(view, r.id, { runId: r.run_id });
      row.onclick = () => { if (!String(window.getSelection())) open(); };
      row.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      };
      const add = (value, title) => {
        const td = row.insertCell();
        td.className = ledgerColumns[row.cells.length - 1][1];
        if (value instanceof Node) td.append(value);
        else {
          td.textContent = value || '—';
          if (!value || value === '—') td.classList.add('faint');
        }
        if (title) td.title = title;
        return td;
      };
      const token = (value) => add(number(value, true), number(value));
      add(when(r.timestamp), r.timestamp);
      const agent = node('span', 'ledger-agent', r.agent || 'GemPT');
      agent.append(node('span', 'activity-badge', modes[r.mode]));
      add(agent, r.title);
      add(r.requested_model, r.requested_model);
      add([r.provider, r.account].filter(Boolean).join(' · '));
      add(r.sent_model, r.sent_model);
      const served = node('span', 'ledger-agent', r.model || '—');
      if (r.tier) served.append(node('span', 'activity-badge', titleCaseTier(r.tier)));
      add(served, r.model);
      add(r.reasoning_effort);
      token(r.usage.input_tokens);
      token(r.usage.output_tokens);
      token(r.usage.cache_write_tokens);
      token(r.usage.cache_read_tokens);
      add(r.usage.cache_hit_rate == null ? '—' : `${number(Math.round(r.usage.cache_hit_rate * 1000) / 10)}%`);
      add(r.cost == null ? '—' : `$${number(r.cost)}`);
      add(r.ttft_ms == null ? '—' : duration(r.ttft_ms / 1000));
      const elapsed = add(duration(r.elapsed_sec), r.elapsed_sec == null ? '' : `${number(r.elapsed_sec)} s`);
      if (r.elapsed_sec != null) {
        elapsed.dataset.latency = r.elapsed_sec <= 10 ? 'fast' : r.elapsed_sec <= 30 ? 'slow' : 'long';
      }
      add(r.output_tokens_per_sec == null ? '—' : `${number(r.output_tokens_per_sec)} tok/s`);
      add(statusBadge(r));
    }
    view.results.replaceChildren(table);
  }

  function sessionRow(view, session) {
    const row = button('', 'activity-session-row');
    row.dataset.activityId = session.id;
    const icon = node('span', 'activity-session-icon', session.mode === 'exec' ? '>_' : '≡');
    icon.setAttribute('aria-hidden', 'true');
    const who = node('span', 'activity-session-who');
    const title = node('strong', '', session.title || 'GPT 任务');
    title.title = session.title;
    const meta = node('small', '', [session.model, filterLabel('tier', session.tier), when(session.updated_at)].filter(Boolean).join(' · '));
    const folder = node('span', 'session-folder', session.cwd);
    folder.title = session.cwd;
    meta.title = meta.textContent;
    if (session.cwd) meta.append(folder);
    who.append(title, meta);
    const tokens = node('span', 'activity-session-num');
    tokens.append(node('b', '', number(session.usage.total_tokens, true)));
    if (session.usage.total_tokens != null) {
      tokens.title = `${number(session.usage.total_tokens)} token`;
      tokens.append(node('small', '', `输入 ${number(session.usage.input_tokens, true)} · 输出 ${number(session.usage.output_tokens, true)}`));
    }
    const arrow = node('span', 'activity-session-go', '›');
    arrow.setAttribute('aria-hidden', 'true');
    row.append(icon, who, node('span', 'activity-badge', modes[session.mode]));
    if (isActiveRun(session) || session.state === 'interrupted') row.append(statusBadge(session));
    row.append(tokens,
      node('span', 'activity-session-turns', `${number(session.turn_count)} 轮`), arrow);
    row.onclick = () => openActivityDetail(view, session.id);
    return row;
  }

  function copyButton(value, label) {
    const copy = button('复制');
    copy.setAttribute('aria-label', `复制${label}`);
    copy.onclick = () => copyText(value, `已复制${label}`);
    return copy;
  }

  function detailLine(list, label, value, copy = false) {
    if (value == null || value === '') return;
    const body = node('dd');
    if (value instanceof Node) body.append(value);
    else body.textContent = value;
    if (copy) body.append(' ', copyButton(value, label));
    list.append(node('dt', '', label), body);
  }

  function detailText(parent, label, value) {
    if (!value) return;
    const section = node('section', 'activity-detail-text');
    const head = node('header');
    head.append(node('h4', '', label), copyButton(value, label));
    section.append(head, node('pre', '', value));
    parent.append(section);
  }

  function renderRunProgress(run) {
    const progress = run.progress;
    const question = pendingQuestion(run);
    if (!progress && !question) return [];
    const box = node('section', 'activity-detail-box');
    const info = node('dl', 'activity-detail-info');
    detailLine(info, '当前阶段', phases[progress?.phase] || progress?.phase);
    box.append(info);
    const commands = progress?.recent_commands?.map((entry) => typeof entry === 'string' ? entry : [
      entry.command, entry.exit_code == null ? '' : `退出码 ${entry.exit_code}`,
    ].filter(Boolean).join('\n'));
    detailText(box, '最近命令', commands?.join('\n\n'));
    detailText(box, '已触及文件', progress?.touched_files?.join('\n'));
    detailText(box, '实时输出摘要', progress?.last_message);
    if (question) {
      detailText(box, '等待 Gemini 回复', [question.question, question.reason && `原因　${question.reason}`,
        ...(question.media_paths || [])].filter(Boolean).join('\n'));
    }
    return box.querySelector('dt, pre') ? [box] : [];
  }

  function usageText(usage) {
    return usage.total_tokens == null ? '—' : [
      `${number(usage.total_tokens)} token`, `输入 ${number(usage.input_tokens)}`, `输出 ${number(usage.output_tokens)}`,
      `缓存读取 ${number(usage.cache_read_tokens)}`, `缓存写入 ${number(usage.cache_write_tokens)}`,
      ...(usage.reasoning_tokens == null ? [] : [`推理 ${number(usage.reasoning_tokens)}`]),
    ].join(' · ');
  }

  function renderTurn(r, heading) {
    const box = node('article', 'activity-detail-box');
    if (heading) box.append(node('h3', '', heading));
    const info = node('dl', 'activity-detail-info');
    const add = (label, value, copy = false) => detailLine(info, label, value, copy);
    add('时间', when(r.timestamp));
    add('模式', modes[r.mode]);
    add('状态', statusBadge(r));
    add('Agent', r.agent);
    add('请求模型', r.requested_model);
    add('发送模型', r.sent_model);
    add('响应模型', r.model);
    add('供应商 · 账号', [r.provider, r.account].filter(Boolean).join(' · '));
    add('档位', r.tier && titleCaseTier(r.tier));
    add('推理强度', r.reasoning_effort);
    add('耗时', duration(r.elapsed_sec));
    add('TTFT', r.ttft_ms == null ? '' : duration(r.ttft_ms / 1000));
    add('速度', r.output_tokens_per_sec == null ? '' : `${number(r.output_tokens_per_sec)} tok/s`);
    add('费用', r.cost == null ? '' : `$${number(r.cost)}`);
    add('Token', usageText(r.usage));
    add('文件夹', r.cwd, true);
    add('会话 ID', r.session_id, true);
    add('运行 ID', r.run_id, true);
    add('Codex 线程 ID', r.codex_thread_id, true);
    add('验证', checks[r.verification.status] || r.verification.status);
    box.append(info);
    detailText(box, '目标', r.goal);
    if (r.prompt !== r.goal) detailText(box, '提示词', r.prompt);
    detailText(box, r.reply_is_preview ? '回复预览' : '回复', r.reply);
    detailText(box, '错误', r.error);
    detailText(box, '要求验证', r.verification.requested);
    const commandText = (entries) => entries.map((entry) => typeof entry === 'string' ? entry : [
      entry?.command, entry?.exit_code == null ? '' : `退出码 ${entry.exit_code}`, entry?.output,
    ].filter(Boolean).join('\n')).join('\n\n');
    detailText(box, '验证检查', commandText(r.verification.checks));
    detailText(box, '执行的命令', commandText(r.commands));
    return box;
  }

  function renderSessionDetail(session) {
    const box = node('section', 'activity-detail-box');
    const info = node('dl', 'activity-detail-info');
    detailLine(info, '会话 ID', session.session_id, true);
    detailLine(info, '文件夹', session.cwd, true);
    detailLine(info, '模式', modes[session.mode]);
    detailLine(info, '时间', session.created_at && session.created_at !== session.updated_at
      ? `${when(session.created_at)} – ${when(session.updated_at)}` : when(session.updated_at));
    detailLine(info, '轮次', number(session.turn_count));
    detailLine(info, 'Token', usageText(session.usage));
    detailLine(info, '耗时', duration(session.elapsed_sec));
    box.append(info);
    return [box, ...session.turns.map((turn) => renderTurn(turn, turn.turn == null
      ? '执行记录' : `第 ${number(turn.turn)} 轮`))];
  }

  function closeActivityDetail(view) {
    const open = view.open;
    if (!open) return;
    open.abort?.abort();
    view.open = null;
    view.detail.hidden = true;
    view.detail.replaceChildren();
    view.list.hidden = false;
    const row = [...view.results.querySelectorAll('[data-activity-id]')]
      .find((row) => row.dataset.activityId === open.id);
    (row || $(`tab-${view.kind}`)).focus({ preventScroll: true });
    window.scrollTo(0, open.scroll);
    void refreshActivityView(view);
    syncLivePoll();
  }

  async function loadActivityDetail(view, refresh = false) {
    const open = view.open;
    open.abort?.abort();
    const abort = open.abort = new AbortController();
    const body = view.detail.querySelector('.activity-detail-body');
    body.setAttribute('aria-busy', 'true');
    try {
      const fetchDetail = (id) => apiFetch(`/api/${view.kind}/${encodeURIComponent(id)}`, { signal: abort.signal });
      let res = await fetchDetail(open.id);
      if (res.status === 404 && open.runId) {
        // A run can move into its session's numbered turn when it finishes.
        const request = await findRunRequest(open.runId, abort.signal);
        if (request && request.id !== open.id) {
          open.id = request.id;
          res = await fetchDetail(open.id);
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (abort.signal.aborted) return;
      const session = view.kind === 'sessions';
      const run = session ? data.turns.findLast(isActiveRun) || data : data;
      open.active = isActiveRun(run);
      if (!session && data.run_id) open.runId = data.run_id;
      const rendered = JSON.stringify(data);
      if (open.rendered === rendered && !body.querySelector('button:disabled')) return;
      open.rendered = rendered;
      const head = node('header', 'activity-detail-head');
      head.append(node('h2', '', data.title || (session ? 'GPT 会话' : '请求详情')));
      if (runState(run)) head.append(statusBadge(run));
      const focusedInterrupt = body.contains(document.activeElement)
        && document.activeElement.dataset.runAction === 'interrupt';
      const interrupt = run.run_id && ['running', 'waiting_gemini'].includes(runState(run))
        ? interruptButton(run, '中止当前轮') : null;
      if (interrupt) head.append(interrupt);
      body.replaceChildren(head, ...renderRunProgress(run), ...(session ? renderSessionDetail(data) : [renderTurn(data)]));
      if (focusedInterrupt) (interrupt || view.detail.querySelector('.activity-back')).focus({ preventScroll: true });
    } catch (err) {
      if (abort.signal.aborted || (refresh && open.rendered)) return;
      open.rendered = null;
      const retry = button('重试');
      retry.onclick = () => loadActivityDetail(view);
      body.replaceChildren(node('p', 'activity-empty', `读取详情失败（${err.message}）`), retry);
    } finally {
      if (!abort.signal.aborted) {
        open.abort = null;
        body.removeAttribute('aria-busy');
        syncLivePoll();
      }
    }
  }

  function openActivityDetail(view, id, { runId } = {}) {
    view.open?.abort?.abort();
    view.open = { id, runId, scroll: window.scrollY };
    const back = button(view.kind === 'requests' ? '‹ 请求' : '‹ 会话', 'activity-link activity-back');
    back.onclick = () => closeActivityDetail(view);
    const body = node('div', 'activity-detail-body');
    body.append(node('p', 'activity-empty', view.kind === 'sessions' ? '正在读取会话…' : '正在读取请求…'));
    view.detail.replaceChildren(back, body);
    view.list.hidden = true;
    view.detail.hidden = false;
    window.scrollTo(0, 0);
    back.focus({ preventScroll: true });
    void loadActivityDetail(view);
  }

  async function loadActivityList(view, offset = 0, append = false, refresh = false) {
    view.listFetch?.abort();
    const abort = view.listFetch = new AbortController();
    const search = view.list.querySelector('.activity-search').value.trim();
    const limit = refresh && view.kind === 'sessions' ? Math.max(activityPageSize, view.items.length) : activityPageSize;
    const query = new URLSearchParams({ q: search, offset, limit: Math.min(100, limit) });
    for (const select of view.list.querySelectorAll('[data-filter]')) {
      if (select.value) query.set(select.dataset.filter, select.value);
    }
    if (view.status) query.set('status', view.status);
    const pagers = view.list.querySelectorAll('[data-page]');
    for (const control of pagers) control.disabled = true;
    view.results.setAttribute('aria-busy', 'true');
    if (!view.loaded) view.results.replaceChildren(node('div', 'activity-empty', '正在读取记录…'));
    try {
      const fetchPage = async () => {
        const res = await apiFetch(`/api/${view.kind}?${query}`, { signal: abort.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      const data = await fetchPage();
      // Preserve the expanded session list when refreshing live rows.
      while (data.items.length < Math.min(limit, data.total - offset) && !abort.signal.aborted) {
        query.set('offset', offset + data.items.length);
        query.set('limit', Math.min(100, limit - data.items.length));
        const next = await fetchPage();
        if (!next.items.length) break;
        data.items.push(...next.items);
      }
      if (abort.signal.aborted) return;
      if (offset > 0 && data.total <= offset && !append) {
        return loadActivityList(view, Math.max(0, Math.ceil(data.total / activityPageSize) - 1) * activityPageSize, false, refresh);
      }
      const focusedId = view.results.contains(document.activeElement) && document.activeElement.dataset.activityId;
      view.loaded = true;
      view.offset = data.offset;
      view.total = data.total;
      if (append) {
        const drawn = new Set(view.items.map((row) => row.id));
        const next = data.items.filter((row) => !drawn.has(row.id));
        view.items.push(...next);
        view.results.append(...next.map((session) => sessionRow(view, session)));
      } else {
        view.items = data.items;
        if (!data.items.length) {
          const filtered = search || [...query.keys()].some((key) => !['q', 'offset', 'limit'].includes(key));
          const message = view.kind === 'requests' ? (filtered ? '没有符合这些筛选条件的请求。' : '暂无请求。')
            : (filtered ? '没有匹配的会话。' : '暂无会话。');
          view.results.replaceChildren(node('div', 'activity-empty', message));
        } else if (view.kind === 'requests') {
          renderLedger(view);
        } else {
          view.results.replaceChildren(...view.items.map((session) => sessionRow(view, session)));
        }
      }
      if (focusedId) {
        const row = [...view.results.querySelectorAll('[data-activity-id]')]
          .find((row) => row.dataset.activityId === focusedId);
        row?.focus({ preventScroll: true });
      }
      setActivityFacets(view, data.facets);
      renderActivitySummary(view, data);
      const end = view.offset + data.items.length;
      if (view.kind === 'requests') {
        const pager = view.list.querySelector('.activity-pager');
        pager.hidden = data.total <= activityPageSize;
        pager.querySelector('span').textContent = `第 ${number(view.offset + 1)}–${number(end)} 条，共 ${number(data.total)} 条`;
        pagers[0].disabled = view.offset <= 0;
        pagers[1].disabled = end >= data.total;
      } else {
        pagers[0].hidden = end >= data.total;
        pagers[0].textContent = `显示另外 ${number(Math.min(data.total - end, activityPageSize))} 个`;
        pagers[0].disabled = false;
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      if (refresh && view.loaded) {
        for (const control of pagers) control.disabled = control.dataset.page === 'newer' ? view.offset <= 0
          : view.kind === 'requests' && view.offset + view.items.length >= view.total;
        return;
      }
      const retry = button('重试');
      // Rebuild the first page if a failed load replaced its rows.
      retry.onclick = () => loadActivityList(view);
      const error = node('div', 'activity-empty', `读取记录失败（${err.message}） `);
      error.append(retry);
      view.results.replaceChildren(error);
      view.loaded = false;
    } finally {
      if (!abort.signal.aborted) {
        view.listFetch = null;
        view.results.removeAttribute('aria-busy');
        syncLivePoll();
      }
    }
  }

  function refreshActivityView(view) {
    if (!view) return;
    return view.open ? loadActivityDetail(view, true)
      : loadActivityList(view, view.kind === 'requests' ? view.offset : 0, false, true);
  }

  function syncLivePoll() {
    const view = activityViews[activeTab];
    const active = view?.open ? view.open.active : view ? view.items.some(isActiveRun) : latestState?.active_runs?.length;
    if (!active || document.visibilityState !== 'visible') {
      clearTimeout(liveTimer);
      liveTimer = null;
    } else if (liveTimer === null) {
      liveTimer = setTimeout(async () => {
        liveTimer = null;
        if (document.visibilityState !== 'visible') return;
        const current = activityViews[activeTab];
        if (!current) await refreshState({ live: true });
        else if (!current.listFetch && !current.open?.abort) await refreshActivityView(current);
        syncLivePoll();
      }, LIVE_POLL_MS);
    }
  }

  function selectActivityTab(tab, focus = false) {
    if (!activityTabs.includes(tab)) tab = 'overview';
    if (tab !== activeTab) window.scrollTo(0, 0);
    activeTab = tab;
    for (const name of activityTabs) {
      const selected = name === tab;
      $(name).hidden = !selected;
      $(`tab-${name}`).tabIndex = selected ? 0 : -1;
      $(`tab-${name}`).setAttribute('aria-selected', String(selected));
    }
    if (focus) $(`tab-${tab}`).focus();
    const view = activityViews[tab];
    if (view) void refreshActivityView(view);
    else if (latestState) renderLiveOverview(latestState);
    syncLivePoll();
  }

  function navigateActivityTab(tab, focus = false) {
    if (location.hash !== `#${tab}`) history.pushState(null, '', `#${tab}`);
    selectActivityTab(tab, focus);
  }

  for (const tab of activityTabs) {
    const control = $(`tab-${tab}`);
    control.onclick = () => navigateActivityTab(tab);
    control.onkeydown = (event) => {
      const index = activityTabs.indexOf(tab);
      const direction = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      const next = direction ? activityTabs[(index + direction + activityTabs.length) % activityTabs.length]
        : event.key === 'Home' ? activityTabs[0] : event.key === 'End' ? activityTabs.at(-1) : '';
      if (!next) return;
      event.preventDefault();
      navigateActivityTab(next, true);
    };
  }
  for (const link of document.querySelectorAll('[data-activity-tab]')) {
    link.onclick = (event) => {
      event.preventDefault();
      navigateActivityTab(link.dataset.activityTab, true);
    };
  }
  window.addEventListener('hashchange', () => selectActivityTab(location.hash.slice(1)));
  document.addEventListener('keydown', (event) => {
    const view = activityViews[activeTab];
    if (event.key === 'Escape' && view?.open) closeActivityDetail(view);
  });
  for (const view of Object.values(activityViews)) {
    const search = view.list.querySelector('.activity-search');
    let debounce;
    search.oninput = () => {
      clearTimeout(debounce);
      view.listFetch?.abort();
      for (const control of view.list.querySelectorAll('[data-page]')) control.disabled = true;
      debounce = setTimeout(() => loadActivityList(view), 180);
    };
    for (const select of view.list.querySelectorAll('[data-filter]')) {
      select.onchange = () => {
        clearTimeout(debounce);
        if (select.dataset.filter === 'status') setStatus('');
        void loadActivityList(view);
      };
    }
    const statusControls = view.list.querySelectorAll('[data-status]');
    const statusSelect = view.list.querySelector('[data-filter="status"]');
    const setStatus = (status) => {
      view.status = status;
      for (const control of statusControls) {
        control.setAttribute('aria-pressed', String(!statusSelect.value && control.dataset.status === status));
      }
    };
    for (const control of statusControls) {
      control.onclick = () => {
        clearTimeout(debounce);
        statusSelect.value = '';
        setStatus(control.dataset.status);
        void loadActivityList(view);
      };
    }
    for (const control of view.list.querySelectorAll('[data-page]')) {
      control.onclick = () => {
        clearTimeout(debounce);
        const page = control.dataset.page;
        const offset = page === 'more' ? view.items.length
          : Math.max(0, view.offset + (page === 'newer' ? -1 : 1) * activityPageSize);
        void loadActivityList(view, offset, page === 'more');
      };
    }
  }
  selectActivityTab(location.hash.slice(1));

  document.addEventListener('change', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.name === 'view_mode') {
      currentViewMode = target.value === 'native' ? 'native' : 'mcp';
      writeStoredMode(currentViewMode);
      renderState(latestState);
    } else if (target.name === 'default_tier') {
      switchDefaultTier(target.value);
    } else if (target.name === 'work_split' || target.name === 'swarm_split') {
      updateSetting(target.name, { [target.name]: target.value }, latestState[target.name], '工作分工已保存，下次派单生效');
    } else if (target.dataset.family) {
      const family = target.dataset.family;
      updateSetting(target.name, { pairing: { family, model: target.value } }, latestState.pairings[family], '配对已保存，下个新任务生效');
    } else if (target.name === 'default_sandbox') {
      const label = SANDBOX_NAMES[target.value] || target.value;
      updateSetting('default_sandbox', { default_sandbox: target.value }, currentDefaultSandbox, `Codex 执行权限已切为${label}`);
    } else if (target.name === 'active_effort') {
      const payload = target.value === 'auto'
        ? { auto_effort: true }
        : { auto_effort: false, tier_effort: target.value, tier: currentDefaultTier };
      const label = EFFORT_NAMES[target.value] || target.value;
      const toastMsg = target.value === 'auto'
        ? '已开启智能定档（low..xhigh，续跑锁档）'
        : `${titleCaseTier(currentDefaultTier)} 思考强度已切为${label}`;
      updateSetting('active_effort', payload, currentEffortChoice, toastMsg);
    } else if (target.name === 'failover_mode') {
      const label = target.value === 'api_fallback' ? 'API 兜底' : '仅订阅';
      updateSetting('failover_mode', { failover_mode: target.value }, currentFailoverMode, `容灾模式已切为${label}`);
    }
  });

  document.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('button') : null;
    if (!btn) return;
    if (btn.id === 'refresh-btn') {
      refreshState({ manual: true });
      void refreshActivityView(activityViews[activeTab]);
      return;
    }
    if (btn.id === 'init-sub-btn') {
      activateSubscriptionConfig();
      return;
    }
    if (btn.id === 'create-native-btn') {
      createNativeGroupsAction();
      return;
    }
    if (btn.id === 'copy-mcp-btn' || btn.id === 'chip-mcp') {
      copyMcpConfig();
      return;
    }
    if (btn.id === 'copy-rules-btn') {
      copyRulesConfig();
      return;
    }
    if (btn.id === 'chip-native') {
      currentViewMode = 'native';
      writeStoredMode('native');
      renderState(latestState);
      return;
    }
    const copyVal = btn.getAttribute('data-copy');
    if (copyVal) {
      copyText(copyVal);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshState();
      void refreshActivityView(activityViews[activeTab]);
    }
    syncLivePoll();
  });

  refreshState();
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshState();
  }, POLL_MS);
})();

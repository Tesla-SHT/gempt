/*
 * GemPT Magpie Page Plugin UI controller.
 * Applies Magpie theme/tokens from boot query parameters, authenticates API
 * calls with the injected <meta name="gempt-key"> secret, renders plain-Chinese
 * routing status, provides one-click subscription activation, and persists
 * default_tier, default_sandbox, and optional failover_mode settings.
 */
(() => {
  const POLL_MS = 15000;
  const SUPPORTS_HAS = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:has(*))');
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const apiKey = document.querySelector('meta[name="gempt-key"]')?.getAttribute('content') || '';

  const ROLE_TEXT = {
    sonnet: '日常高频',
    opus: '复杂工程',
    fable: '顶配攻坚',
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
  };

  const SANDBOX_HINTS = {
    'read-only': '仅分析代码，禁止写入文件',
    'workspace-write': '仅允许修改当前工作区内的文件',
    'danger-full-access': '无沙箱限制，允许完整本地权限（请谨慎）',
  };

  const FAILOVER_HINTS = {
    subscription_only: '仅用 ChatGPT/Codex 订阅额度，不走按量付费 API',
    api_fallback: '优先用 Codex 订阅额度，限流或失败时自动切按量 API 兜底',
  };

  const SANDBOX_NAMES = {
    'read-only': '只读',
    'workspace-write': '工作区',
    'danger-full-access': '全权限',
  };

  let currentDefaultTier = 'sonnet';
  let currentDefaultSandbox = 'workspace-write';
  let currentFailoverMode = 'subscription_only';
  let toastTimer = null;

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

  function formatEffortLabel(effort, { detailed = true, escalated = false } = {}) {
    const raw = String(effort || 'medium').trim().toLowerCase();
    const shortWord = (EFFORT_LABELS[raw] || `思考：${raw}`).replace(/^思考：/, '');
    if (escalated) {
      return detailed ? `思考深度：${shortWord} → 高` : `思考：${shortWord} → 高`;
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
      .replace(/\bsol\b/gi, 'Sol')
      .replace(/\bastra\b/gi, 'Astra')
      .replace(/\bterra\b/gi, 'Terra')
      .replace(/\bdeepseek\b/gi, 'DeepSeek')
      .replace(/-?flash\b/gi, ' Flash')
      .replace(/-v(\d)/gi, ' V$1');
  }

  function buildRouteChain(tier) {
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
        else if (m === tier.escalate_model || m.includes('astra')) pushNode(m, 'escalate');
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

  function formatTierSummary(tier) {
    const chain = buildRouteChain(tier);
    if (!chain.length) return formatEffortLabel(tier.reasoning_effort, { detailed: false });
    const primary = chain[0].human;
    const escNode = chain.slice(1).find((n) => n.role === 'escalate');
    const fbCount = chain.slice(1).filter((n) => n.role !== 'escalate').length;
    const parts = [primary];
    if (escNode) parts.push(`↗ 升级 ${escNode.human}`);
    else if (fbCount === 1) parts.push(`→ 备用 ${chain[1].human}`);
    if (escNode && fbCount > 0) parts.push(`+${fbCount} 备用`);
    else if (!escNode && fbCount > 1) parts.push(`+${fbCount} 备用`);
    return parts.join(' · ');
  }

  function renderSetupBanner(state) {
    const banner = $('setup-banner');
    const textEl = $('setup-banner-text');
    const btn = $('init-sub-btn');
    if (!banner || !textEl || !btn) return;

    const reachable = Boolean(state.magpie?.reachable);
    const subReady = Boolean(state.subscription?.connected);
    const configured = Boolean(state.configured);

    if (configured && (!reachable || subReady)) {
      banner.hidden = true;
      btn.hidden = true;
      return;
    }

    banner.hidden = false;
    if (!reachable) {
      banner.dataset.tone = 'warn';
      textEl.textContent = '尚未连上本地 Magpie — 请先启动 Magpie，再点右上角刷新。';
      btn.hidden = true;
    } else if (!subReady) {
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
      textEl.textContent = `已检测到 Codex 订阅（${modelNote}），点击按钮即可自动生成并启用配置：`;
      btn.hidden = false;
      btn.disabled = false;
    }
  }

  function renderControls(state) {
    const configured = Boolean(state.configured);
    currentDefaultSandbox = state.default_sandbox || 'workspace-write';
    for (const radio of document.querySelectorAll('input[name="default_sandbox"]')) {
      radio.checked = radio.value === currentDefaultSandbox;
      radio.disabled = !configured;
    }
    const sbxHint = $('sandbox-hint');
    if (sbxHint) {
      sbxHint.textContent = SANDBOX_HINTS[currentDefaultSandbox] || currentDefaultSandbox;
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
          if (!apiAvailable) {
            fmHint.textContent = '未检测到按量 openai/* 渠道，当前仅可用订阅直连';
          } else {
            fmHint.textContent = FAILOVER_HINTS[currentFailoverMode] || FAILOVER_HINTS.subscription_only;
          }
        }
      }
    }
  }

  function renderActiveRoute(state, activeTier) {
    const nameEl = $('active-tier-name');
    const targetEl = $('active-tier-target');
    const effortEl = $('active-tier-effort');
    const slashBtn = $('active-slash-btn');
    const hubBox = $('flow-hub-box');
    const hubModeText = $('hub-mode-text');
    const chainEl = $('route-chain');

    const tierId = activeTier?.id || state.default_tier || 'sonnet';
    const consultModel = String(activeTier?.consult_model || 'codex/gpt-6.2-sol');
    const isGroup = consultModel.startsWith('group/');

    if (nameEl) nameEl.textContent = titleCaseTier(tierId);
    if (targetEl) {
      targetEl.textContent = consultModel;
      targetEl.hidden = !isGroup;
    }
    if (effortEl) {
      effortEl.textContent = formatEffortLabel(activeTier?.reasoning_effort, {
        detailed: true,
        escalated: Boolean(activeTier?.escalate_model),
      });
    }
    if (slashBtn) {
      const cmd = `/gempt-${tierId}`;
      slashBtn.textContent = cmd;
      slashBtn.setAttribute('data-copy', `${cmd} `);
    }
    if (hubBox) {
      hubBox.title = state.magpie?.url || 'http://127.0.0.1:3425';
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

    const chain = activeTier ? buildRouteChain(activeTier) : [];
    if (chainEl && chain.length) {
      chainEl.replaceChildren();
      for (const node of chain.slice(0, 4)) {
        const li = document.createElement('li');
        li.className = `route-node is-${node.role}`;

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
  }

  function formatRunMeta(run) {
    if (run.verification === 'passed') return '已通过';
    if (run.verification === 'failed' || run.state === 'failed') return '失败';
    if (run.state === 'running' || run.state === 'queued') return '进行中';
    if (run.state === 'finished') return '已完成';
    if (run.state === 'outcome_unknown') return '状态未知';
    return run.state || '已记录';
  }

  function renderActivity(state) {
    const list = $('activity-list');
    const count = $('activity-count');
    if (!list || !count) return;

    const runs = (state.recent_runs || []).map((run) => ({
      tone: run.verification === 'passed' ? 'ok' : (run.state === 'failed' || run.verification === 'failed' ? 'err' : 'neutral'),
      text: `执行 · ${titleCaseTier(run.tier || 'exec')} · ${run.cwd_name || run.run_id.slice(0, 8)}`,
      meta: formatRunMeta(run),
    }));
    const sessions = (state.recent_sessions || []).map((sess) => ({
      tone: 'ok',
      text: `${sess.mode === 'exec' ? '执行' : '咨询'} · ${titleCaseTier(sess.tier || 'sonnet')} (${humanizeModel(sess.model || sess.cwd_name)})`,
      meta: `${Math.max(1, Math.floor((sess.turns || 0) / 2))} 轮`,
    }));

    const rows = [...runs, ...sessions].slice(0, 5);
    count.textContent = `${rows.length} 条记录`;
    list.replaceChildren();

    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'recent-empty';
      li.textContent = '暂无最近委派记录。';
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
    currentDefaultTier = state.default_tier || 'sonnet';

    const status = $('magpie-status');
    const statusText = $('magpie-status-text');
    if (status && statusText) {
      if (!state.magpie?.reachable) {
        status.dataset.state = 'offline';
        statusText.textContent = '未连接';
        status.title = state.magpie?.error || 'Magpie 暂不可达';
      } else if (!state.subscription?.connected) {
        status.dataset.state = 'warn';
        statusText.textContent = '待登录 Codex 订阅';
        status.title = state.magpie?.url || '';
      } else {
        status.dataset.state = 'online';
        statusText.textContent = '已连接';
        status.title = state.magpie?.url || '';
      }
    }

    renderSetupBanner(state);
    renderControls(state);

    const tiersById = new Map((state.tiers || []).map((t) => [t.id, t]));
    for (const row of document.querySelectorAll('.tier-row')) {
      const tierId = row.dataset.tier;
      const radio = row.querySelector('.tier-radio');
      if (radio) {
        radio.checked = tierId === currentDefaultTier;
        radio.disabled = !state.configured;
      }
      const info = tiersById.get(tierId);
      if (!info) continue;

      const nameEl = row.querySelector('[data-field="short_name"]');
      const pillEl = row.querySelector('[data-field="target_pill"]');
      const subEl = row.querySelector('[data-field="chain_summary"]');
      const roleEl = row.querySelector('[data-field="role_desc"]');
      const effortEl = row.querySelector('[data-field="effort_tag"]');

      if (nameEl) nameEl.textContent = titleCaseTier(tierId);
      if (pillEl) pillEl.textContent = info.consult_model;
      if (subEl) subEl.textContent = formatTierSummary(info);
      if (roleEl) roleEl.textContent = ROLE_TEXT[tierId] || '';
      if (effortEl) {
        effortEl.textContent = formatEffortLabel(info.reasoning_effort, {
          detailed: false,
          escalated: Boolean(info.escalate_model),
        });
      }
    }

    renderActiveRoute(state, tiersById.get(currentDefaultTier) || state.tiers?.[0]);

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

    renderActivity(state);
    syncHasFallbackClasses();
  }

  async function refreshState({ manual = false } = {}) {
    const refreshBtn = $('refresh-btn');
    if (manual && refreshBtn) refreshBtn.classList.add('is-spinning');
    try {
      const res = await apiFetch('/api/state', { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderState(data);
      if (manual) showToast('状态已更新');
    } catch (err) {
      if (manual) showToast(`刷新失败: ${err.message}`, 'error');
    } finally {
      if (refreshBtn) refreshBtn.classList.remove('is-spinning');
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
      showToast('已启用 Codex 订阅配置');
    } catch (err) {
      showToast(`启用失败: ${err.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
      await refreshState();
    }
  }

  async function switchDefaultTier(nextTier) {
    const previous = currentDefaultTier;
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
    const radios = [...document.querySelectorAll(`input[name="${groupName}"]`)];
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
        r.checked = r.value === previousValue;
      }
      syncHasFallbackClasses();
      showToast(`设置失败: ${err.message}`, 'error');
    } finally {
      await refreshState();
    }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast(`已复制 ${text.trim()}`);
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
      showToast(`已复制 ${text.trim()}`);
    } catch {
      showToast('复制失败，请手动输入命令', 'error');
    } finally {
      ta.remove();
    }
  }

  document.addEventListener('change', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name === 'default_tier') {
      switchDefaultTier(target.value);
    } else if (target.name === 'default_sandbox') {
      const label = SANDBOX_NAMES[target.value] || target.value;
      updateSetting('default_sandbox', { default_sandbox: target.value }, currentDefaultSandbox, `Codex 执行权限已切为${label}`);
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
      return;
    }
    if (btn.id === 'init-sub-btn') {
      activateSubscriptionConfig();
      return;
    }
    const copyVal = btn.getAttribute('data-copy');
    if (copyVal) {
      copyText(copyVal);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshState();
  });

  refreshState();
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshState();
  }, POLL_MS);
})();

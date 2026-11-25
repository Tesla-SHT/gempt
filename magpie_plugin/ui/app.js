import { mountAdvancedSettings } from './advanced-settings.js';
import { tr, locale, localizedFormat, errorText } from './i18n.js';

// Shared Console controller. Host adapters provide transport and host integration.
export function mountConsole(root, transport, {
  onState, navigate, showToast, copyText, onLanguage, refreshGateway,
} = {}) {
  const POLL_MS = 15000;
  const LIVE_POLL_MS = 2800;
  const RATIO_RANGE_STORAGE_KEY = 'gempt-ratio-range';
  const RATIO_RANGE_TITLES = {
    '1h': '1 小时内实际 Token 占比',
    '6h': '6 小时内实际 Token 占比',
    today: '今天实际 Token 占比',
    '24h': '近 24h 实际 Token 占比',
    '7d': '近 7 天实际 Token 占比',
  };
  const SUPPORTS_HAS = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('selector(:has(*))');
  const $ = (id) => root.querySelector(`#${id}`);
  const embedded = transport.isEmbeddedInAgy;
  const scrollTarget = root;
  let visible = false;
  const pendingSettings = new Set();
  let installingAgy = false;
  let retryAgy = false;
  const advanced = mountAdvancedSettings($, { transport, showToast, onLanguage, refreshGateway,
    refresh: () => refreshState({ replace: true }), init: activateSubscriptionConfig });

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

  const SANDBOX_HINTS = {
    'read-only': '仅分析代码，禁止写入文件',
    'workspace-write': '仅允许修改当前工作区内的文件',
    'danger-full-access': '无沙箱限制，允许完整本地权限（请谨慎）',
  };

  const EFFORT_HINTS = {
    medium: '中等思考，适合日常开发与常规修改',
    high: '高强度思考，适合跨文件排查与复杂工程',
    xhigh: '极高强度思考，适合复杂算法与核心攻坚',
    auto: '按任务复杂度调整强度。Astra 至少为高，续跑沿用原强度。',
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
  let stateSyncedAt = null;
  let stateRefreshError = '';
  let currentDefaultSandbox = 'workspace-write';
  let currentEffortChoice = 'high';
  let ratioRange = readStoredRatioRange();
  let ratioFetch;
  let latestRatio;
  let runStateFetch;
  let locateWork = false;

  function readStoredRatioRange() {
    const saved = consolePreference(RATIO_RANGE_STORAGE_KEY);
    return Object.hasOwn(RATIO_RANGE_TITLES, saved) ? saved : '24h';
  }

  function selectRatioRange(range) {
    if (!Object.hasOwn(RATIO_RANGE_TITLES, range) || range === ratioRange) return;
    ratioRange = range;
    consolePreference(RATIO_RANGE_STORAGE_KEY, range);
    updateRatioRangeControls();
    void refreshRatio();
  }

  function updateRatioRangeControls() {
    for (const button of $('token-ratio-ranges')?.querySelectorAll('button') || []) {
      button.setAttribute('aria-pressed', String(button.dataset.ratioRange === ratioRange));
    }
  }

  function syncHasFallbackClasses() {
    if (SUPPORTS_HAS) return;
    for (const opt of root.querySelectorAll('.seg-option')) {
      const radio = opt.querySelector('.seg-radio');
      opt.classList.toggle('is-checked', Boolean(radio?.checked));
      opt.classList.toggle('is-disabled', Boolean(radio?.disabled));
    }
  }

  function titleCaseTier(id) {
    if (!id) return 'Sonnet';
    if (id === 'mcp') return 'MCP';
    if (id === 'paired') return tr('Gemini 配对');
    if (id.startsWith('paired:')) return tr("{0} 配对", titleCaseTier(id.slice(7)));
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  function formatEffortLabel(effort, auto) {
    if (auto) return tr('智能思考');
    const raw = String(effort || 'medium').trim().toLowerCase();
    return tr(EFFORT_LABELS[raw]) || tr("思考：{0}", raw);
  }

  function humanizeModel(rawId) {
    const id = String(rawId || '').trim();
    if (!id) return tr('未知模型');
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

  function renderSetupBanner(state) {
    const banner = $('setup-banner');
    const textEl = $('setup-banner-text');
    const btn = $('init-sub-btn');
    if (!banner || !textEl || !btn) return;

    const reachable = Boolean(state.magpie?.reachable);
    const configured = Boolean(state.configured);

    if (!reachable) {
      banner.hidden = true;
      btn.hidden = true;
      return;
    }

    if (configured && state.magpie.models?.length) {
      banner.hidden = true;
      btn.hidden = true;
      return;
    }

    banner.hidden = false;
    if (!state.mcp_default_model) {
      banner.dataset.tone = 'warn';
      textEl.textContent = state.magpie.models?.length ? tr('请选择下属模型。') : tr('请在 Magpie 接入模型后刷新。');
      btn.hidden = true;
    } else {
      banner.dataset.tone = 'ready';
      textEl.textContent = tr('默认下属模型：{0}', state.mcp_default_model);
      btn.hidden = false;
      btn.disabled = false;
    }
  }

  function renderWorkSplit(state) {
    const profiles = state.work_profiles;
    if (!profiles) return;
    const list = $('work-options');
    const swarm = $('swarm-split');
    if (!list.children.length) {
      swarm.replaceChildren();
      swarm.add(new Option(tr('跟随普通对话'), 'inherit'));
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
        title.textContent = tr(profile.label);
        const weight = document.createElement('small');
        weight.textContent = isOff ? tr('纯 Gemini · 不派单') : tr('GPT 约 {0}%', profile.gpt_share);
        label.append(radio, title, weight);
        list.append(label);
        swarm.add(new Option(isOff ? tr(profile.label) + tr(' · 纯 Gemini') : tr(profile.label) + ' · ' + weight.textContent, id));
      }
    }
    for (const radio of list.querySelectorAll('input')) {
      radio.checked = radio.value === state.work_split;
      radio.disabled = !state.configured;
    }
    swarm.disabled = !state.configured;
    const validSwarm = state.swarm_split === 'inherit' || Object.hasOwn(profiles, state.swarm_split);
    swarm.value = validSwarm ? state.swarm_split : 'inherit';
    renderExecutionSettings(state);
    renderPairings(state);
    const ordinary = profiles[state.work_split];
    const team = profiles[swarm.value] || ordinary;
    const workDetail = $('work-detail');
    workDetail.textContent = tr(ordinary?.detail || '');
    if (ordinary?.gpt_share !== 0 && state.tools?.exec_enabled === false) {
      workDetail.textContent += tr(' Magpie 的 gempt_run 当前允许只读调查。要允许写入，请在 GemPT 插件选项开启 exec。');
    }
    $('swarm-detail').textContent = team?.gpt_share === 0
      ? tr(team.detail)
      : tr(team?.label || '') + tr(' · 协调者拆单和解说，成员按各自职责派单，核验者独立检查。');
  }

  function formatCompactTokens(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num) || num <= 0) return '0';
    if (locale() === 'en') return number(num, true);
    if (num >= 1e8) return tr("{0} 亿", (num / 1e8).toFixed(2));
    if (num >= 1e4) {
      const w = num / 1e4;
      return w >= 100 ? tr("{0} 万", Math.round(w)) : tr("{0} 万", w.toFixed(1));
    }
    return num.toLocaleString('en-US');
  }

  const RATIO_STATUS = {
    off: '已关闭',
    no_data: '暂无数据',
    warming_up: '样本积累中',
    observing: '实时观测',
  };

  function renderTokenRatio(ratio) {
    const card = $('token-ratio-card');
    if (!card) return;
    latestRatio = ratio;
    card.hidden = !ratio;
    if (!ratio) return;
    const rangeTitle = tr(RATIO_RANGE_TITLES[ratio.range]) || tr(RATIO_RANGE_TITLES['24h']);
    const title = $('token-ratio-title');
    if (title) title.textContent = rangeTitle;
    const badge = $('token-ratio-badge');
    const gptBar = $('token-ratio-gpt-bar');
    const gemBar = $('token-ratio-gem-bar');
    const tick = $('token-ratio-target-tick');
    const track = $('token-ratio-track');
    const gptText = $('token-ratio-gpt-text');
    const gemText = $('token-ratio-gem-text');
    const metaEl = $('token-ratio-meta');

    if (badge) {
      badge.textContent = tr(RATIO_STATUS[ratio.status]) || tr(RATIO_STATUS.no_data);
      badge.dataset.tone = ratio.status === 'observing' ? 'ok' : 'neutral';
    }
    const target = Number(ratio.target_gpt_share || 0);
    const hasData = typeof ratio.actual_gpt_share === 'number' && Number(ratio.combined_total || 0) > 0;
    const gptPct = hasData ? Math.max(0, Math.min(100, ratio.actual_gpt_share)) : 0;
    const gemPct = hasData ? Math.max(0, Math.min(100, 100 - gptPct)) : 0;

    if (gptBar) gptBar.style.width = `${gptPct}%`;
    if (gemBar) gemBar.style.width = `${gemPct}%`;
    if (tick) {
      tick.hidden = !(target > 0 && target < 100);
      tick.style.left = `${target}%`;
      tick.title = tr("GPT 参考目标 {0}%", target);
    }
    if (track) {
      track.setAttribute('aria-label', hasData
        ? tr("{0}，GPT 占 {1}%，Gemini 占 {2}%，GPT 参考目标 {3}%", rangeTitle, gptPct.toFixed(1), gemPct.toFixed(1), target)
        : tr("{0}，暂无可计算的工作量占比，GPT 参考目标 {1}%", rangeTitle, target));
    }

    if (gptText) {
      gptText.textContent = hasData
        ? `GPT ${gptPct.toFixed(1)}% · ${formatCompactTokens(ratio.gpt_tokens)}`
        : tr('GPT 暂无数据');
      gptText.title = hasData ? tr("GPT 总 Token {0}（含缓存）", formatCompactTokens(ratio.gpt_tokens)) : '';
    }
    if (gemText) {
      gemText.textContent = hasData
        ? `Gemini ${gemPct.toFixed(1)}% · ${formatCompactTokens(ratio.gemini_tokens)}`
        : tr('Gemini 暂无数据');
    }
    if (metaEl) {
      const total = ratio.actual_gpt_total_share;
      metaEl.textContent = tr("参考目标 {0}%{1}", target, typeof total === 'number' ? tr(" · 含缓存 {0}%", total.toFixed(1)) : '');
      metaEl.title = tr('主占比按工作量 in + 5×out 计算，「含缓存」为 GPT 占总 Token 的比例；仅观测，不自动催单或改档');
    }
  }

  function renderPairings(state) {
    const list = $('pairing-options');
    const models = state.magpie?.models || [];
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
      const defaultModel = state.mcp_default_model;
      const defaultLabel = defaultModel ? tr("默认模型 · {0}", humanizeModel(defaultModel)) : tr('默认模型');
      const choices = [new Option(defaultLabel, 'default')];
      for (const id of models) choices.push(new Option(id, id));
      if (current !== 'default' && !models.includes(current)) {
        choices.push(new Option(current + tr('（未检测到）'), current));
      }
      select.replaceChildren(...choices);
      select.value = current;
      select.disabled = !models.length || pendingSettings.has(select.name);
    }
  }

  function renderExecutionCli(state) {
    const select = $('execution-cli');
    const hint = $('execution-cli-hint');
    if (!select) return;
    const runners = Array.isArray(state.runners) ? state.runners : [];
    const current = state.execution?.default_cli || 'auto';
    const installedCount = runners.filter((r) => r.available).length;
    const autoLabel = installedCount > 0
      ? tr('自动匹配（按模型亲和 · {0}/{1} 可用）', installedCount, runners.length)
      : tr('自动匹配（尚未安装执行 CLI）');
    const options = [new Option(autoLabel, 'auto')];
    for (const r of runners) {
      const badge = r.available ? tr('已安装') : tr('未安装');
      options.push(new Option(`${r.label} (${r.id}) · ${badge}`, r.id));
    }
    const key = JSON.stringify([locale(), current, runners.map((r) => [r.id, r.available, r.path])]);
    if (select.dataset.key !== key) {
      select.dataset.key = key;
      select.replaceChildren(...options);
    }
    select.value = current;
    select.disabled = !state.configured || pendingSettings.has(select.name);
    if (hint) {
      if (current === 'auto') {
        if (installedCount === 0) {
          hint.textContent = tr('未检测到执行 CLI — 咨询（gpt_ask）仍可正常使用。安装任一受支持的 CLI 后即可自主执行。');
        } else {
          const names = runners.filter((r) => r.available).map((r) => r.id).join(', ');
          hint.textContent = tr('按模型自动选择已安装 CLI（可用：{0}）', names);
        }
      } else {
        const picked = runners.find((r) => r.id === current);
        if (picked?.available) {
          hint.textContent = tr('{0} 已就绪 · {1}', picked.label, picked.path);
        } else if (picked) {
          hint.textContent = tr('{0} 尚未安装 · 安装命令：{1}', picked.label, picked.install_hint);
        } else {
          hint.textContent = '';
        }
      }
    }
  }

  function renderExecutionSettings(state) {
    renderExecutionCli(state);
    for (const radio of root.querySelectorAll('[name="native_swarm"]')) {
      radio.checked = radio.value === String(state.native_swarm === true);
      radio.disabled = !state.configured || pendingSettings.has(radio.name);
    }
    const model = $('swarm-shell-model');
    const models = state.swarm_shell_models || [];
    const presets = $('swarm-shell-presets');
    if (Array.from(presets.options, (option) => option.value).join() !== models.join()) {
      presets.replaceChildren(...models.map((name) => new Option(name, name)));
    }
    if (document.activeElement !== model || pendingSettings.has(model.name)) model.value = state.swarm_shell_model;
    model.disabled = !state.configured || pendingSettings.has(model.name);
    const timeout = $('codex-timeout');
    if (document.activeElement !== timeout) timeout.value = state.codex_timeout_sec ?? 3600;
    const disabled = !state.configured || pendingSettings.has(timeout.name);
    timeout.disabled = disabled;
    for (const control of root.querySelectorAll('[data-timeout], [data-timeout-save]')) {
      control.disabled = disabled;
      if (control.dataset.timeout) {
        control.setAttribute('aria-pressed', String(Number(control.dataset.timeout) === state.codex_timeout_sec));
      }
    }
  }

  function renderControls(state) {
    renderWorkSplit(state);

    const configured = Boolean(state.configured);
    currentDefaultSandbox = state.default_sandbox || 'workspace-write';
    for (const radio of root.querySelectorAll('input[name="default_sandbox"]')) {
      radio.checked = radio.value === currentDefaultSandbox;
      radio.disabled = !configured;
    }
    const sbxHint = $('sandbox-hint');
    if (sbxHint) {
      const baseHint = tr(SANDBOX_HINTS[currentDefaultSandbox]) || currentDefaultSandbox;
      sbxHint.textContent = state.tools?.exec_enabled === false
        ? tr("{0} · gempt_run 仅限只读（插件选项设 exec: true 后可写）", baseHint)
        : baseHint;
    }

    currentEffortChoice = state.auto_effort ? 'auto' : state.mcp_effort || 'medium';
    for (const radio of root.querySelectorAll('input[name="active_effort"]')) {
      radio.checked = radio.value === currentEffortChoice;
      radio.disabled = !configured;
    }
    const effHint = $('effort-hint');
    if (effHint) {
      effHint.textContent = tr(EFFORT_HINTS[currentEffortChoice]) || formatEffortLabel(currentEffortChoice);
    }
  }

  function renderActiveRoute(state) {
    $('active-tier-effort').textContent = formatEffortLabel(state.mcp_effort, state.auto_effort);
    $('active-slash-btn').hidden = !state.clients?.antigravity_installed;
  }

  function renderReadiness(state) {
    const clients = state.clients || {};

    const chipMcp = $('chip-mcp');
    const chipMcpVal = $('chip-mcp-val');
    if (chipMcp && chipMcpVal) {
      if (clients.native_tools_registered) {
        chipMcp.dataset.tone = 'ok';
        const agentCount = Array.isArray(clients.native_tools_agents) ? clients.native_tools_agents.length : 0;
        chipMcpVal.textContent = agentCount > 0 ? tr("已自动同步 {0} 端", agentCount) : tr('Magpie 自动托管');
      } else if (clients.magpie_mcp_registered) {
        chipMcp.dataset.tone = 'ok';
        chipMcpVal.textContent = tr('Magpie MCP 已接入');
      } else {
        chipMcp.dataset.tone = 'neutral';
        chipMcpVal.textContent = tr('复制独立配置');
      }
    }

    const chipAgy = $('chip-agy');
    const chipAgyVal = $('chip-agy-val');
    if (chipAgy && chipAgyVal) {
      chipAgy.dataset.tone = clients.antigravity_installed ? 'ok' : 'neutral';
      chipAgyVal.textContent = clients.antigravity_installed ? tr('插件已安装') : tr('未安装');
    }
    const paths = clients.agy_install;
    const setup = $('agy-setup');
    setup.hidden = !paths || !(transport.installAgy || transport.installPage)
      || (!retryAgy && clients.antigravity_installed && paths.installed_version === paths.bundled_version);
    if (!setup.hidden) {
      $('agy-setup-title').textContent = clients.antigravity_installed
        ? tr('安装随包版本 {0}（当前 {1}）', paths.bundled_version, paths.installed_version || '—')
        : tr('启用 Antigravity 集成');
      $('agy-target').textContent = paths.target;
      $('agy-bin').textContent = paths.bin_dir;
      $('agy-install').hidden = !transport.installAgy;
      $('agy-install').disabled = installingAgy;
      $('agy-install-link').hidden = $('agy-copy-link').hidden = !transport.installPage;
      if (transport.installPage) $('agy-install-link').href = transport.installPage;
    }
  }

  async function installAgyAction() {
    if (!transport.installAgy || installingAgy) return;
    installingAgy = true;
    $('agy-install').disabled = true;
    const result = $('agy-install-result');
    result.hidden = false;
    result.textContent = tr('正在安装…');
    try {
      const installed = await transport.installAgy();
      retryAgy = !installed.installed;
      const message = retryAgy ? tr('安装未全部完成，可重试。') : tr('已安装。请在 Antigravity 中打开新会话；若未出现，请重启客户端。');
      result.textContent = [message, ...(installed.warnings || [])].join(' ');
      await refreshState({ replace: true });
    } catch (error) {
      retryAgy = true;
      result.textContent = errorText(error.message);
    } finally {
      installingAgy = false;
      $('agy-install').disabled = false;
    }
  }

  function formatRunMeta(run) {
    if (run.remote_turn_unconfirmed) return tr('远端终态未确认');
    if (run.verification === 'passed') return tr('已通过');
    if (run.verification === 'failed' || run.state === 'failed') return tr('失败');
    if (run.state === 'waiting_gemini') return tr('等待 Gemini');
    if (run.state === 'interrupted') return tr('已中止');
    if (run.state === 'running' || run.state === 'queued') return tr('进行中');
    if (run.state === 'finished') return tr('已完成');
    if (run.state === 'outcome_unknown') return tr('状态未知');
    return run.state || tr('已记录');
  }

  function renderActivity(state) {
    const list = $('activity-list');
    const count = $('activity-count');
    if (!list || !count) return;

    const runs = (state.recent_runs || []).map((run) => ({
      tone: run.remote_turn_unconfirmed ? 'err'
        : run.verification === 'passed' ? 'ok'
        : (run.state === 'failed' || run.verification === 'failed' ? 'err' : 'neutral'),
      text: tr("执行 · {0} · {1}", titleCaseTier(run.tier || 'exec'), run.title || run.cwd_name || run.run_id.slice(0, 8)),
      meta: formatRunMeta(run),
      runId: run.run_id, sessionId: run.session_id,
    }));
    const sessions = (state.recent_sessions || []).map((sess) => {
      const agentTag = sess.agent ? ` · ${sess.agent}` : '';
      return {
        tone: 'ok',
        text: `${sess.mode === 'exec' ? tr('执行') : tr('咨询')} · ${titleCaseTier(sess.tier || 'sonnet')}${agentTag} · ${sess.title || sess.cwd_name || tr('GPT 任务')}`,
        meta: tr("{0} 轮", Math.max(1, Math.floor((sess.turns || 0) / 2))),
        sessionId: sess.session_id, hasLive: sess.has_live_run,
      };
    });
    const rows = [...runs, ...sessions].slice(0, 5);
    const totals = state.activity_totals;
    count.textContent = totals ? tr("{0} 个请求 · {1} 个会话 · {2} 次运行", number(totals.requests), number(totals.sessions), number(totals.runs)) : '—';
    list.replaceChildren();

    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'recent-empty';
      li.textContent = tr('暂无最近委派记录。');
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
      const linked = item.runId || item.hasLive;
      const text = node(linked ? 'button' : 'span', 'recent-text', item.text);
      if (linked) {
        text.type = 'button';
        text.onclick = () => navigate('live', { id: item.runId, sessionId: item.sessionId, focus: true });
      }
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
    onState?.(state);
    renderSetupBanner(state);
    renderControls(state);
    advanced.render(state);
    renderReadiness(state);

    renderActiveRoute(state);

    const choreModel = $('chore-model');
    const choreSub = $('chore-sub');
    if (state.utility) {
      if (choreModel) choreModel.textContent = state.utility.model;
      if (choreSub) {
        const parts = [tr('仅咨询')];
        if (state.utility.fallback_models?.length) parts.push(tr("+{0} 备用", state.utility.fallback_models.length));
        choreSub.textContent = parts.join(' · ');
      }
    }

    $('strip-agy-slash').hidden = !state.clients?.antigravity_installed;

    renderActivity(state);
    if (locateWork && visible && activeTab === 'overview') {
      locateWork = false;
      const work = $('work-controls');
      work.scrollIntoView({ block: 'start' });
      work.focus({ preventScroll: true });
    }
    for (const field of root.querySelectorAll('[name]')) {
      if (pendingSettings.has(field.name)) field.disabled = true;
    }
    syncHasFallbackClasses();
    markUiReady();
  }

  let gatewayStatus;

  function patchGatewayStatus({ overview, ui, ...magpie }) {
    gatewayStatus = { ...overview, magpie };
    if (!latestState || latestState.magpie.url !== magpie.url) return;
    latestState = { ...latestState, ...gatewayStatus };
    if (!visible || activeTab !== 'overview') return;
    renderSetupBanner(latestState);
    renderPairings(latestState);
    advanced.render(latestState);
    renderReadiness(latestState);
    renderActiveRoute(latestState);
    for (const field of root.querySelectorAll('[name]')) {
      if (pendingSettings.has(field.name)) field.disabled = true;
    }
    syncHasFallbackClasses();
    renderSyncStatus();
  }

  function markUiReady() {
    if (root.classList.contains('gp-ready')) return;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('gp-ready')));
  }

  function renderSyncStatus() {
    const view = activityViews[activeTab];
    const activity = view?.open || view;
    const magpie = latestState?.magpie;
    const offline = magpie?.reachable === false;
    let message = '';
    if (!view && stateRefreshError) {
      message = stateSyncedAt
        ? tr("概览数据已过期 · 上次同步 {0} · {1}", dateTime.format(stateSyncedAt), errorText(stateRefreshError))
        : tr("加载概览失败 · {0}", errorText(stateRefreshError));
    } else if (!view && offline) {
      message = tr('Magpie 离线 · 请检查本地 Magpie 是否已启动');
      if (stateSyncedAt) message += tr(" · 上次同步 {0}", dateTime.format(stateSyncedAt));
    } else if (activity?.refreshError) {
      const label = view.kind === 'requests' ? tr('请求') : tr('会话');
      message = tr("{0}数据已过期 · 上次同步 {1} · {2}", label, dateTime.format(activity.syncedAt), errorText(activity.refreshError));
    }

    $('overview').toggleAttribute('data-state-unavailable', Boolean(stateRefreshError && !latestState));
    const banner = $('sync-banner');
    const announcement = $('sync-announcement');
    if (announcement.textContent !== message) {
      announcement.textContent = message;
      $('sync-message').textContent = message;
    }
    if (!message && document.activeElement === $('sync-retry')) document.getElementById('refresh-btn').focus();
    banner.hidden = !message;
  }

  function createTimeoutSignal(ms, parentSignal) {
    if (typeof AbortSignal?.timeout === 'function' && (!parentSignal || typeof AbortSignal?.any === 'function')) {
      const t = AbortSignal.timeout(ms);
      return { signal: parentSignal ? AbortSignal.any([parentSignal, t]) : t, cleanup() {} };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
        return { signal: controller.signal, cleanup() {} };
      }
      parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
    }, ms);
    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onAbort);
      },
    };
  }

  async function refreshState({ replace = false } = {}) {
    if (!visible || activeTab !== 'overview' || (stateFetch && !replace)) return;
    stateFetch?.abort();
    const abort = stateFetch = new AbortController();
    const previousGatewayStatus = gatewayStatus;
    const { signal, cleanup } = createTimeoutSignal(POLL_MS, abort.signal);
    try {
      let data = await transport.getState({ signal });
      if (abort.signal.aborted) return;
      if (!data?.magpie) throw new Error(tr('状态响应格式无效'));
      if (gatewayStatus?.magpie.url === data.magpie.url
          && (gatewayStatus !== previousGatewayStatus || data.magpie.reachable === null)) {
        data = { ...data, ...gatewayStatus };
      }
      renderState(data);
      renderLiveOverview(data);
      if (data.magpie.reachable) stateSyncedAt = Date.now();
      stateRefreshError = '';
      renderSyncStatus();
    } catch (err) {
      if (!abort.signal.aborted) {
        stateRefreshError = err.name === 'TimeoutError' ? '连接超时' : err.message;
        renderSyncStatus();
      }
    } finally {
      cleanup();
      if (stateFetch === abort) {
        stateFetch = null;
        markUiReady();
        syncLivePoll();
      }
    }
  }

  async function refreshRatio() {
    if (!visible || activeTab !== 'overview') return;
    ratioFetch?.abort();
    const abort = ratioFetch = new AbortController();
    try {
      const ratio = await transport.getRatio(ratioRange, { signal: abort.signal });
      if (!abort.signal.aborted) renderTokenRatio(ratio);
    } catch {
      if (!abort.signal.aborted) {
        $('token-ratio-card').hidden = false;
        $('token-ratio-title').textContent = tr(RATIO_RANGE_TITLES[ratioRange]);
        $('token-ratio-badge').textContent = tr('读取失败');
      }
    } finally {
      if (ratioFetch === abort) ratioFetch = null;
    }
  }

  async function refreshRunState() {
    if (!visible || activeTab !== 'overview' || runStateFetch) return;
    const abort = runStateFetch = new AbortController();
    try {
      const data = await transport.getRunState({ signal: abort.signal });
      if (abort.signal.aborted) return;
      if (latestState) latestState = { ...latestState, ...data };
      renderLiveOverview(data);
    } catch (error) {
      if (!abort.signal.aborted) $('active-run-list').title = errorText(error.message);
    } finally {
      if (runStateFetch === abort) runStateFetch = null;
    }
  }

  async function activateSubscriptionConfig() {
    const btn = $('init-sub-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await transport.runAction('init');
      showToast(tr('已启用全客户端共享配置'));
    } catch (err) {
      showToast(tr("启用失败: {0}", errorText(err.message)), 'error');
    } finally {
      if (btn) btn.disabled = false;
      await refreshState();
    }
  }

  async function updateSetting(groupName, payload, previousValue, successText) {
    if (pendingSettings.has(groupName)) return;
    const controls = [...root.querySelectorAll(`[name="${groupName}"]`)];
    pendingSettings.add(groupName);
    for (const control of controls) control.disabled = true;
    if (groupName === 'codex_timeout_sec') renderExecutionSettings(latestState);
    syncHasFallbackClasses();
    try {
      const state = await transport.saveSettings(payload);
      if (state?.magpie && visible && activeTab === 'overview') {
        renderState(state);
        renderLiveOverview(state);
      } else {
        await refreshState({ replace: true });
      }
      if (groupName === 'work_split') void refreshRatio();
      showToast(successText);
    } catch (err) {
      for (const control of controls) {
        if (control.type === 'radio') control.checked = control.value === String(previousValue);
        else control.value = previousValue;
      }
      showToast(tr("设置失败: {0}", errorText(err.message)), 'error');
    } finally {
      pendingSettings.delete(groupName);
      for (const control of controls) control.disabled = !latestState?.configured;
      syncHasFallbackClasses();
      await refreshState();
      if (groupName === 'codex_timeout_sec') renderExecutionSettings(latestState);
    }
  }

  function saveTimeout(seconds) {
    if (!latestState?.configured || typeof seconds !== 'number' || seconds < 30 || seconds > 7200 || !Number.isFinite(seconds)) return;
    $('codex-timeout').value = seconds;
    void updateSetting('codex_timeout_sec', { codex_timeout_sec: seconds }, latestState.codex_timeout_sec, tr('Codex 执行超时预算已保存'));
  }

  function copyMcpConfig() {
    const jsonText = latestState?.mcp_snippet?.json;
    if (!jsonText) {
      showToast(tr('MCP 配置尚未就绪，请先刷新状态'), 'error');
      return;
    }
    copyText(jsonText, tr('已复制独立 MCP JSON 配置（仅非 Magpie 托管客户端需要）'));
  }

  function copyRulesConfig() {
    const rulesText = latestState?.rules_snippet;
    if (!rulesText) {
      showToast(tr('协作规则尚未就绪，请先刷新状态'), 'error');
      return;
    }
    copyText(rulesText, tr('已复制协作规则（贴入 CLAUDE.md / AGENTS.md 等全局规则）'));
  }

  // Ledger and session presentation adapted from Magpie's usage-page.js (MIT).
  const activityTabs = ['overview', 'requests', 'sessions'];
  const activityPageSize = 25;
  const activityViews = Object.fromEntries(['requests', 'sessions'].map((kind) => {
    const list = $(`${kind}-list`);
    return [kind, {
      kind, list, detail: $(`${kind}-detail`), results: list.querySelector('.activity-results'),
      summary: list.querySelector('.activity-summary-line'), stats: list.querySelector('.activity-stats'),
      offset: 0, items: [], status: '', range: 'all', total: 0, loaded: false, listFetch: null, open: null,
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
  const checks = { passed: '已通过', failed: '失败', unverified: '未验证', not_requested: '未要求' };
  const exactNumber = localizedFormat(Intl.NumberFormat, { maximumFractionDigits: 3 });
  const compactNumber = localizedFormat(Intl.NumberFormat, { notation: 'compact', maximumFractionDigits: 1 });
  const dollar = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 8 });
  const percent = localizedFormat(Intl.NumberFormat, { style: 'percent', maximumFractionDigits: 1 });
  const dateTime = localizedFormat(Intl.DateTimeFormat, { dateStyle: 'short', timeStyle: 'medium', hour12: false });
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

  const compactDollar = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const microDollar = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const percent2 = localizedFormat(Intl.NumberFormat, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const CHART_PALETTE = ['#a5b4fc', '#67e8f9', '#6ee7b7', '#fde047', '#f9a8d4', '#c4b5fd', '#fdba74', '#5eead4'];
  const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const reqUi = { metric: 'tokens', chartType: 'bar', dim: 'model', speedDim: 'model', heatmapMetric: 'tokens' };
  const sessUi = { topMetric: 'tokens', shapeMetric: 'turns' };
  let activityRefreshMs = 0;
  let activityRefreshTimer = null;

  const shortCost = (value, plus = false) => {
    if (value == null) return '—';
    const text = Math.abs(value) >= 0.01 || value === 0 ? compactDollar.format(value) : microDollar.format(value);
    return plus ? `${text}+` : text;
  };
  const costText = (value) => value == null ? '—' : dollar.format(value);
  const cacheRateText = (value) => value == null ? '—' : percent.format(value);
  const speedText = (value) => value == null ? '—' : `${number(Math.round(value))} tok/s`;
  const msText = (value) => value == null ? '—' : duration(value / 1000);
  const providerText = (row) => row.provider_accounts || [row.provider, row.account].filter(Boolean).join(' · ');

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function relativeTime(value) {
    const ms = Date.parse(value || '');
    if (!Number.isFinite(ms)) return '';
    const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 60) return tr('刚刚');
    if (diff < 3600) return tr("{0} 分钟前", Math.floor(diff / 60));
    if (diff < 86400) return tr("{0} 小时前", Math.floor(diff / 3600));
    return tr("{0} 天前", Math.floor(diff / 86400));
  }

  function level4(value, max) {
    if (!value || value <= 0 || !max || max <= 0) return 0;
    const ratio = value / max;
    if (ratio >= 0.72) return 4;
    if (ratio >= 0.44) return 3;
    if (ratio >= 0.18) return 2;
    return 1;
  }

  function makeSegGroup(options, activeVal, onPick, label) {
    const seg = node('div', 'activity-segment');
    seg.setAttribute('role', 'group');
    if (label) seg.setAttribute('aria-label', label);
    for (const [val, text] of options) {
      const btn = button(text, '');
      btn.setAttribute('aria-pressed', String(val === activeVal));
      btn.onclick = () => onPick(val);
      seg.append(btn);
    }
    return seg;
  }

  function duration(sec) {
    if (sec == null) return '—';
    if (sec < 1) return `${number(Math.round(sec * 1000))} ms`;
    if (sec < 60) return `${number(Math.round(sec * 10) / 10)} s`;
    if (sec < 3600) return tr("{0} 分 {1} 秒", Math.floor(sec / 60), Math.floor(sec % 60));
    return tr("{0} 小时 {1} 分", Math.floor(sec / 3600), Math.floor(sec / 60) % 60);
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
    if (key === 'mode') return tr(modes[value]) || value;
    if (key === 'status') return tr(statuses[value]) || value;
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

  function renderHeadCost(view, costUsd, unpricedText) {
    const host = view.list.querySelector('[data-head-cost]');
    if (!host) return;
    host.replaceChildren();
    if (costUsd != null) {
      host.append(node('b', '', shortCost(costUsd, Boolean(unpricedText))));
    }
    if (unpricedText) {
      host.append(node('span', '', unpricedText));
    }
  }

  function makeRichKpi({ label, value, unit = '', sub = null, valueClass = '', topFirst = false, title = '', barRatio = null }) {
    const tile = node('div', 'activity-kpi');
    const lbl = node('span', 'kpi-label', label);
    const val = node('div', valueClass ? `kpi-val ${valueClass}` : 'kpi-val');
    val.title = title || value;
    val.append(node('span', '', value));
    if (unit) val.append(node('span', 'kpi-unit', unit));
    if (topFirst) tile.append(val, lbl);
    else tile.append(lbl, val);
    if (barRatio != null) {
      const track = node('div', 'kpi-bar-track');
      const fill = node('div', 'kpi-bar-fill');
      fill.style.width = `${Math.max(0, Math.min(100, Math.round(barRatio * 100)))}%`;
      track.append(fill);
      tile.append(track);
    }
    if (sub) {
      if (sub instanceof Node) tile.append(sub);
      else tile.append(node('div', 'kpi-sub', sub));
    }
    return tile;
  }

  function renderRequestAnalytics(data) {
    const analytics = data.analytics;
    const chartCard = $('requests-chart-card');
    const speedCard = $('requests-speed-card');
    const heatCard = $('requests-heatmap-card');
    if (!analytics) {
      chartCard.hidden = speedCard.hidden = heatCard.hidden = true;
      return;
    }

    // 1. Trend Chart + Right Breakdown Panel
    const buckets = analytics.buckets || [];
    const dimItemsRaw = analytics.breakdowns?.[reqUi.dim] || [];
    const metricVal = (item) => {
      if (reqUi.metric === 'cost') return item.cost_usd || 0;
      if (reqUi.metric === 'requests') return item.requests || 0;
      if (reqUi.metric === 'speed') return item.avg_speed || 0;
      return item.total_tokens ?? item.tokens ?? 0;
    };
    const formatMetric = (v) => {
      if (reqUi.metric === 'cost') return shortCost(v);
      if (reqUi.metric === 'requests') return `${number(Math.round(v))}`;
      if (reqUi.metric === 'speed') return `${number(Math.round(v))} tok/s`;
      return number(v, true);
    };
    const dimItems = [...dimItemsRaw].sort((a, b) => metricVal(b) - metricVal(a) || b.requests - a.requests);
    const colorOf = new Map(dimItems.map((item, idx) => [item.name, CHART_PALETTE[idx % CHART_PALETTE.length]]));

    chartCard.hidden = false;
    chartCard.replaceChildren();
    const chartHead = node('div', 'analytics-head');
    const headLeft = node('div', 'analytics-head-left');
    headLeft.append(
      makeSegGroup([['tokens', 'Token'], ['cost', tr('费用')], ['requests', tr('请求')], ['speed', tr('速度')]], reqUi.metric, (v) => {
        reqUi.metric = v;
        renderRequestAnalytics(data);
      }, tr('指标')),
      makeSegGroup([['bar', tr('柱状')], ['line', tr('折线')]], reqUi.chartType, (v) => {
        reqUi.chartType = v;
        renderRequestAnalytics(data);
      }, tr('图表类型')),
    );
    const headRight = node('div', 'analytics-head-right');
    headRight.append(
      node('span', 'analytics-sub', tr('拆分维度')),
      makeSegGroup([['model', tr('模型')], ['model_provider', tr('模型 · 供应商')], ['provider', tr('供应商')], ['tier', tr('档位')]], reqUi.dim, (v) => {
        reqUi.dim = v;
        renderRequestAnalytics(data);
      }, tr('拆分维度')),
    );
    chartHead.append(headLeft, headRight);
    chartCard.append(chartHead);

    const split = node('div', 'trend-split');
    const chartWrap = node('div', 'trend-chart-wrap');
    const bucketTotal = (b) => {
      if (reqUi.metric === 'cost') return b.cost_usd || 0;
      if (reqUi.metric === 'requests') return b.requests || 0;
      if (reqUi.metric === 'speed') return b.avg_speed || 0;
      return b.tokens || 0;
    };
    const maxY = Math.max(0, ...buckets.map(bucketTotal));
    if (!buckets.length || maxY <= 0) {
      chartWrap.append(node('div', 'trend-empty', tr('当前时段暂无趋势数据')));
    } else {
      const W = 680;
      const H = 220;
      const padL = 54;
      const padR = 12;
      const padT = 14;
      const padB = 26;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const svg = svgEl('svg', { class: 'trend-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
      const niceMax = maxY * 1.12;
      for (let i = 0; i <= 4; i += 1) {
        const y = padT + (plotH * i) / 4;
        const val = niceMax * (1 - i / 4);
        svg.append(svgEl('line', { class: 'trend-grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
        const txt = svgEl('text', { class: 'trend-axis-text', x: padL - 6, y: y + 3, 'text-anchor': 'end' });
        txt.textContent = formatMetric(val);
        svg.append(txt);
      }

      const n = buckets.length;
      const stepX = plotW / Math.max(1, n);
      const barW = Math.max(4, Math.min(28, stepX * 0.62));
      const labelEvery = Math.max(1, Math.ceil(n / 10));

      if (reqUi.chartType === 'line' || reqUi.metric === 'speed') {
        const pts = [];
        buckets.forEach((b, idx) => {
          const v = bucketTotal(b);
          const x = padL + stepX * idx + stepX / 2;
          const y = padT + plotH - (v / niceMax) * plotH;
          if (v > 0 || reqUi.metric !== 'speed') pts.push([x, y, b, v]);
        });
        if (pts.length) {
          const d = pts.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
          svg.append(svgEl('path', { d, fill: 'none', stroke: '#818cf8', 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
          for (const [x, y, b, v] of pts) {
            const c = svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 3.5, fill: '#a5b4fc', class: 'trend-bar-seg' });
            const title = svgEl('title');
            title.textContent = `${b.label} · ${formatMetric(v)}`;
            c.append(title);
            svg.append(c);
          }
        }
      } else {
        const orderedNames = dimItems.map((d) => d.name);
        buckets.forEach((b, idx) => {
          const dimMap = b.by_dim?.[reqUi.dim] || {};
          const x = padL + stepX * idx + (stepX - barW) / 2;
          let accY = 0;
          for (const name of orderedNames) {
            const entry = dimMap[name];
            if (!entry) continue;
            const v = reqUi.metric === 'cost' ? entry.cost_usd : reqUi.metric === 'requests' ? entry.requests : entry.tokens;
            if (!v || v <= 0) continue;
            const h = (v / niceMax) * plotH;
            const y = padT + plotH - accY - h;
            accY += h;
            const rect = svgEl('rect', {
              class: 'trend-bar-seg',
              x: x.toFixed(1),
              y: y.toFixed(1),
              width: barW.toFixed(1),
              height: Math.max(1.5, h).toFixed(1),
              rx: 2,
              fill: colorOf.get(name) || CHART_PALETTE[0],
            });
            const tip = svgEl('title');
            tip.textContent = `${b.label} · ${name} · ${formatMetric(v)}`;
            rect.append(tip);
            svg.append(rect);
          }
        });
      }

      buckets.forEach((b, idx) => {
        if (idx % labelEvery !== 0 && idx !== n - 1) return;
        const x = padL + stepX * idx + stepX / 2;
        const txt = svgEl('text', { class: 'trend-axis-text', x: x.toFixed(1), y: H - 6, 'text-anchor': 'middle' });
        txt.textContent = b.label;
        svg.append(txt);
      });
      chartWrap.append(svg);
    }

    const legend = node('div', 'trend-legend');
    const totalMetricSum = dimItems.reduce((acc, item) => acc + metricVal(item), 0);
    const maxLegendVal = Math.max(0, ...dimItems.map(metricVal));
    if (!dimItems.length) {
      legend.append(node('div', 'analytics-sub', tr('暂无拆分维度数据')));
    } else {
      for (const item of dimItems) {
        const val = metricVal(item);
        const color = colorOf.get(item.name) || CHART_PALETTE[0];
        const share = totalMetricSum > 0 && reqUi.metric !== 'speed' ? val / totalMetricSum : null;
        const row = node('div', 'legend-item');
        const top = node('div', 'legend-top');
        const nameWrap = node('div', 'legend-name-wrap');
        const dot = node('span', 'legend-dot');
        dot.style.background = color;
        const nameEl = node('span', 'legend-name', item.name);
        nameEl.title = item.name;
        nameWrap.append(dot, nameEl);
        top.append(nameWrap, node('span', 'legend-val', formatMetric(val)));

        const barTrack = node('div', 'legend-bar-track');
        const barFill = node('div', 'legend-bar-fill');
        barFill.style.background = color;
        barFill.style.width = `${maxLegendVal > 0 ? Math.max(2, Math.round((val / maxLegendVal) * 100)) : 0}%`;
        barTrack.append(barFill);

        const meta = node('div', 'legend-meta');
        const parts = [tr("{0} 个请求", number(item.requests)), `${number(item.total_tokens, true)} token`];
        if (item.avg_speed != null) parts.push(tr("{0} token/秒 · {1} 次计时", number(Math.round(item.avg_speed)), number(item.timed_speed_count)));
        if (item.avg_ttft_ms != null) parts.push(tr("首字 {0}", msText(item.avg_ttft_ms)));
        if (item.cache_hit_rate != null) parts.push(tr("命中率 {0}", percent2.format(item.cache_hit_rate)));
        if (share != null) parts.push(`${Math.round(share * 100)}%`);
        meta.textContent = parts.join(' · ');
        if (item.failed > 0) {
          meta.append(' · ', node('span', 'is-err', tr("{0} 次失败", number(item.failed))));
        }
        row.append(top, barTrack, meta);
        legend.append(row);
      }
    }
    split.append(chartWrap, legend);
    chartCard.append(split);

    // 2. Model Speed Leaderboard
    const speedRows = analytics.speed_board?.[reqUi.speedDim] || [];
    speedCard.hidden = !speedRows.length && !(analytics.speed_board?.model?.length || analytics.speed_board?.provider?.length);
    if (!speedCard.hidden) {
      speedCard.replaceChildren();
      const sHead = node('div', 'analytics-head');
      const sLeft = node('div', 'analytics-head-left');
      sLeft.append(node('h3', 'analytics-title', tr('模型速度')));
      const sRight = node('div', 'analytics-head-right');
      sRight.append(makeSegGroup([['model', tr('模型')], ['provider', tr('供应商')]], reqUi.speedDim, (v) => {
        reqUi.speedDim = v;
        renderRequestAnalytics(data);
      }, tr('速度维度')));
      sHead.append(sLeft, sRight);
      speedCard.append(sHead);

      const list = node('div', 'speed-list');
      const maxSpd = Math.max(1, ...speedRows.map((r) => r.avg_speed || 0));
      for (const r of speedRows) {
        const row = node('div', 'speed-row');
        const nm = node('span', 'speed-name', r.name);
        nm.title = r.name;
        const track = node('div', 'speed-track');
        const fill = node('div', 'speed-fill');
        fill.style.width = `${Math.max(4, Math.round(((r.avg_speed || 0) / maxSpd) * 100))}%`;
        track.append(fill);
        row.append(
          nm,
          track,
          node('span', 'speed-num', tr("{0} token/秒", number(Math.round(r.avg_speed)))),
          node('span', 'speed-muted', r.avg_ttft_ms != null ? msText(r.avg_ttft_ms) : '—'),
          node('span', 'speed-muted', number(r.timed_count)),
        );
        list.append(row);
      }
      speedCard.append(list);
    }

    // 3. 53-Week Usage Heatmap
    const hm = analytics.heatmap_53w;
    heatCard.hidden = !hm?.days?.length;
    if (!heatCard.hidden) {
      heatCard.replaceChildren();
      const hHead = node('div', 'analytics-head');
      const hLeft = node('div', 'analytics-head-left');
      const hTitleWrap = node('div');
      hTitleWrap.append(node('h3', 'analytics-title', tr('用量热力图')), node('span', 'analytics-sub', tr('最近 53 周的每日用量')));
      hLeft.append(hTitleWrap);
      const hRight = node('div', 'analytics-head-right');
      hRight.append(makeSegGroup([['tokens', 'Token'], ['requests', tr('请求')], ['cost', tr('费用')]], reqUi.heatmapMetric, (v) => {
        reqUi.heatmapMetric = v;
        renderRequestAnalytics(data);
      }, tr('热力图指标')));
      hHead.append(hLeft, hRight);
      heatCard.append(hHead);

      const hmVal = (d) => reqUi.heatmapMetric === 'requests' ? d.requests : reqUi.heatmapMetric === 'cost' ? d.cost_usd : d.tokens;
      const hmFmt = (d) => reqUi.heatmapMetric === 'requests' ? tr("{0} 个请求", number(d.requests))
        : reqUi.heatmapMetric === 'cost' ? shortCost(d.cost_usd) : `${number(d.tokens, true)} token`;
      const maxHm = Math.max(0, ...hm.days.map(hmVal));
      if (maxHm <= 0) {
        heatCard.append(node('div', 'activity-empty', tr('当前指标暂无用量')));
        return;
      }
      const weeks = Math.ceil(hm.days.length / 7);

      const scroll = node('div', 'heatmap-scroll');
      const inner = node('div', 'heatmap-inner');
      const months = node('div', 'heatmap-months');
      months.style.gridTemplateColumns = `repeat(${weeks}, 15px)`;
      let lastMonth = '';
      for (let w = 0; w < weeks; w += 1) {
        const d = hm.days[w * 7];
        const nextD = hm.days[(w + 1) * 7];
        const m = d ? Number(d.date.slice(5, 7)) : 0;
        const nextM = nextD ? Number(nextD.date.slice(5, 7)) : 0;
        const skipEdge = w === 0 && nextM && nextM !== m;
        const label = !skipEdge && m && String(m) !== lastMonth ? tr("{0}月", m) : '';
        if (m) lastMonth = String(m);
        months.append(node('span', '', label));
      }
      const weekdays = node('div', 'heatmap-weekdays');
      for (let i = 0; i < 7; i += 1) {
        weekdays.append(node('span', '', [0, 2, 4, 6].includes(i) ? tr(WEEKDAYS[i]) : ''));
      }
      const grid = node('div', 'heatmap-grid');
      for (const d of hm.days) {
        const cell = node('span', 'hm-cell');
        cell.dataset.lv = String(level4(hmVal(d), maxHm));
        cell.title = tr("{0} · {1} · {2} 次", d.date, hmFmt(d), number(d.requests));
        grid.append(cell);
      }
      inner.append(months, weekdays, grid);
      scroll.append(inner);
      heatCard.append(scroll);
      requestAnimationFrame(() => { scroll.scrollLeft = scroll.scrollWidth; });

      const foot = node('div', 'heatmap-foot');
      const scale = node('div', 'heatmap-scale');
      scale.append(node('span', '', tr('少')));
      for (let lv = 0; lv <= 4; lv += 1) {
        const c = node('span', 'hm-cell');
        c.dataset.lv = String(lv);
        scale.append(c);
      }
      scale.append(node('span', '', tr('多')));
      foot.append(scale);
      heatCard.append(foot);
    }
  }

  function renderRankCard(title, rows) {
    const card = node('section', 'analytics-card');
    const head = node('div', 'analytics-head');
    head.append(node('h3', 'analytics-title', title));
    card.append(head);
    const list = node('div', 'rank-list');
    const visible = rows.slice(0, 6);
    const maxTok = Math.max(1, ...visible.map((r) => r.total_tokens || 0));
    if (!visible.length) {
      list.append(node('div', 'analytics-sub', tr('暂无数据')));
    } else {
      for (const r of visible) {
        const row = node('div', 'rank-row');
        const nm = node('span', 'rank-name', r.name);
        nm.title = r.cwd || r.name;
        const track = node('div', 'rank-track');
        const fill = node('div', 'rank-fill');
        fill.style.width = `${Math.max(4, Math.round(((r.total_tokens || 0) / maxTok) * 100))}%`;
        track.append(fill);
        row.append(
          nm,
          track,
          node('span', 'rank-tok', number(r.total_tokens, true)),
          node('span', 'rank-cost', shortCost(r.cost_usd)),
        );
        list.append(row);
      }
    }
    card.append(list);
    if (rows.length > 6) {
      card.append(node('div', 'rank-more', tr("还有 {0} 个", number(rows.length - 6))));
    }
    return card;
  }

  function renderSessionAnalytics(view, data) {
    const analytics = data.analytics;
    const gridTop = $('sessions-grid');
    const gridBottom = $('sessions-grid-bottom');
    if (!analytics || !data.total) {
      gridTop.hidden = gridBottom.hidden = true;
      return;
    }
    gridTop.hidden = gridBottom.hidden = false;

    // Card 1 & 2: Projects + Models
    const projCard = renderRankCard(tr('项目'), analytics.projects || []);
    const modCard = renderRankCard(tr('模型'), analytics.models || []);

    // Card 3: Hour Matrix (7x24)
    const hourCard = node('section', 'analytics-card');
    const hHead = node('div', 'analytics-head');
    hHead.append(node('h3', 'analytics-title', tr('按时段')), node('span', 'analytics-sub', analytics.hour_matrix?.tz || tr('本地时区')));
    hourCard.append(hHead);
    const hmWrap = node('div', 'hour-matrix-wrap');
    const matrix = analytics.hour_matrix?.matrix || [];
    const counts = analytics.hour_matrix?.counts || [];
    const maxH = analytics.hour_matrix?.max || 0;
    for (let d = 0; d < 7; d += 1) {
      const row = node('div', 'hour-matrix-row');
      row.append(node('span', 'hour-day-label', tr(WEEKDAYS[d])));
      const cells = node('div', 'hour-cells');
      for (let h = 0; h < 24; h += 1) {
        const v = matrix[d]?.[h] || 0;
        const c = counts[d]?.[h] || 0;
        const cell = node('span', 'hour-cell');
        cell.dataset.lv = String(level4(v, maxH));
        cell.title = tr("{0} {1}:00 · {2} 次 · {3} token", tr(WEEKDAYS[d]), String(h).padStart(2, '0'), number(c), number(v, true));
        cells.append(cell);
      }
      row.append(cells);
      hmWrap.append(row);
    }
    const ticks = node('div', 'hour-ticks');
    ticks.append(node('span', '', ''), node('span', '', '0'), node('span', '', '6'), node('span', '', '12'), node('span', '', '18'));
    hmWrap.append(ticks);
    hourCard.append(hmWrap);
    const hFoot = node('div', 'heatmap-foot');
    if (analytics.hour_matrix?.busiest_label) {
      hFoot.append(node('span', '', tr("最忙：{0}", analytics.hour_matrix.busiest_label)));
    }
    const hScale = node('div', 'heatmap-scale');
    hScale.append(node('span', '', tr('少')));
    for (let lv = 0; lv <= 4; lv += 1) {
      const c = node('span', 'hm-cell');
      c.dataset.lv = String(lv);
      hScale.append(c);
    }
    hScale.append(node('span', '', tr('多')));
    hFoot.append(hScale);
    hourCard.append(hFoot);

    // Card 4: Top Sessions
    const topCard = node('section', 'analytics-card');
    const tHead = node('div', 'analytics-head');
    tHead.append(
      node('h3', 'analytics-title', tr('最耗会话')),
      makeSegGroup([['tokens', 'Token'], ['cost', tr('费用')], ['active', tr('活跃')]], sessUi.topMetric, (v) => {
        sessUi.topMetric = v;
        renderSessionAnalytics(view, data);
      }, tr('排序指标')),
    );
    topCard.append(tHead);
    const topKey = sessUi.topMetric === 'cost' ? 'by_cost' : sessUi.topMetric === 'active' ? 'by_active' : 'by_tokens';
    const topRows = analytics.top_sessions?.[topKey] || [];
    const topList = node('div', 'top-sess-list');
    for (const s of topRows) {
      const row = button('', 'top-sess-row');
      const icon = node('span', 'activity-session-icon', s.mode === 'exec' ? '>_' : '≡');
      icon.setAttribute('aria-hidden', 'true');
      const body = node('span', 'top-sess-body');
      const title = node('span', 'top-sess-title', s.title);
      title.title = s.title;
      const meta = node('span', 'top-sess-meta', [s.project, tr(modes[s.mode]), s.model, relativeTime(s.updated_at)].filter(Boolean).join(' · '));
      body.append(title, meta);
      const valText = sessUi.topMetric === 'cost' ? shortCost(s.cost_usd)
        : sessUi.topMetric === 'active' ? duration(s.active_sec) : number(s.total_tokens, true);
      row.append(icon, body, node('span', 'top-sess-val', valText));
      row.onclick = () => navigateActivityTab('sessions', false, s.id);
      topList.append(row);
    }
    topCard.append(topList);

    gridTop.replaceChildren(projCard, modCard, hourCard, topCard);

    // Bottom Card 5: Session Shapes Histogram
    const shapeCard = node('section', 'analytics-card');
    const shHead = node('div', 'analytics-head');
    const shLeft = node('div', 'analytics-head-left');
    shLeft.append(
      node('h3', 'analytics-title', tr('会话形态')),
      makeSegGroup([['turns', tr('轮次')], ['duration', tr('时长')], ['commands', tr('命令')]], sessUi.shapeMetric, (v) => {
        sessUi.shapeMetric = v;
        renderSessionAnalytics(view, data);
      }, tr('形态维度')),
    );
    shHead.append(shLeft, node('span', 'analytics-sub', tr("{0} 个会话", number(analytics.shapes?.total_sessions || 0))));
    shapeCard.append(shHead);

    const bins = analytics.shapes?.[sessUi.shapeMetric] || [];
    const maxBin = Math.max(1, ...bins.map((b) => b.count || 0));
    const hist = node('div', 'hist-bars');
    for (const b of bins) {
      const col = node('div', 'hist-col');
      col.append(node('span', 'hist-count', b.count ? number(b.count) : '0'));
      const barWrap = node('div', 'hist-bar-wrap');
      const bar = node('div', 'hist-bar');
      bar.style.height = b.count ? `${Math.max(8, Math.round((b.count / maxBin) * 100))}%` : '3px';
      bar.style.opacity = b.count ? '1' : '0.25';
      barWrap.append(bar);
      col.append(barWrap, node('span', 'hist-label', b.label));
      hist.append(col);
    }
    shapeCard.append(hist);

    // Bottom Card 6: Top Commands / Tools
    const toolCard = node('section', 'analytics-card');
    const tlHead = node('div', 'analytics-head');
    const toolsData = analytics.top_tools || { total_calls: 0, unique_count: 0, items: [] };
    tlHead.append(
      node('h3', 'analytics-title', tr('常用命令 / 工具')),
      node('span', 'analytics-sub', tr("{0} 次调用 · {1} 种", number(toolsData.total_calls), number(toolsData.unique_count))),
    );
    toolCard.append(tlHead);
    const tlList = node('div', 'tool-list');
    if (!toolsData.items.length) {
      tlList.append(node('div', 'analytics-sub', tr('当前筛选范围内暂无命令调用记录')));
    } else {
      const maxCalls = Math.max(1, ...toolsData.items.map((t) => t.calls));
      for (const item of toolsData.items.slice(0, 6)) {
        const box = node('div', 'tool-item');
        const top = node('div', 'tool-top');
        const track = node('div', 'rank-track');
        const fill = node('div', 'rank-fill');
        fill.style.width = `${Math.max(4, Math.round((item.calls / maxCalls) * 100))}%`;
        track.append(fill);
        top.append(node('span', 'tool-name', item.name), track, node('span', 'tool-count', number(item.calls)));
        const metaParts = [tr("{0} 个会话", number(item.sessions)), `${Math.round(item.share * 100)}%`];
        if (item.projects?.length) metaParts.push(item.projects.join(', '));
        box.append(top, node('div', 'tool-meta', metaParts.join(' · ')));
        tlList.append(box);
      }
    }
    toolCard.append(tlList);

    gridBottom.replaceChildren(shapeCard, toolCard);
  }

  function renderActivitySummary(view, data) {
    const s = data.summary || {};
    if (view.kind === 'requests') {
      renderHeadCost(view, s.cost_usd, s.unpriced_count > 0 ? tr("{0} 次调用未计价", number(s.unpriced_count)) : '');
      const tokSub = tr("输入 {0} · 输出 {1} · 缓存 {2}", number(s.input_tokens, true), number(s.output_tokens, true), number(s.cache_read_tokens, true));

      const reqSub = node('div', 'kpi-sub');
      const reqLines = [];
      if (s.failed > 0) {
        const line = node('div');
        line.append(node('span', 'is-err', tr("{0} 次失败", number(s.failed))));
        if (s.success_rate != null) line.append(tr(" · 成功 {0}", percent.format(s.success_rate)));
        reqLines.push(line);
      } else if (s.success_rate != null) {
        reqLines.push(node('div', '', tr("成功率 {0}", percent.format(s.success_rate))));
      }
      if (s.retried > 0) reqLines.push(node('div', '', tr("{0} 次重试", number(s.retried))));
      if (s.interrupted > 0) reqLines.push(node('div', '', tr("{0} 次已中止", number(s.interrupted))));
      if (!reqLines.length && s.elapsed_sec != null) reqLines.push(node('div', '', tr("总耗时 {0}", duration(s.elapsed_sec))));
      reqSub.append(...reqLines);

      const costSub = s.unpriced_count > 0 ? tr("{0} 次调用未计价", number(s.unpriced_count)) : tr('按关联网关费率估算');
      const speedVal = s.avg_speed != null ? tr("{0} token/秒", number(Math.round(s.avg_speed))) : '—';
      const speedUnit = s.timed_speed_count > 0 ? tr("{0} 次计时", number(s.timed_speed_count)) : '';
      const ttftSub = s.avg_ttft_ms != null
        ? tr("首字平均 {0} · {1} 次计时", msText(s.avg_ttft_ms), number(s.timed_ttft_count))
        : (s.elapsed_sec != null ? tr("总耗时 {0}", duration(s.elapsed_sec)) : tr('暂无首字计时'));

      view.stats.replaceChildren(
        makeRichKpi({ label: 'Token', value: number(s.total_tokens, true), title: number(s.total_tokens), sub: tokSub }),
        makeRichKpi({ label: tr('请求'), value: number(data.total), sub: reqSub }),
        makeRichKpi({ label: tr('费用'), value: shortCost(s.cost_usd, s.unpriced_count > 0), valueClass: 'is-cost', title: costText(s.cost_usd), sub: costSub }),
        makeRichKpi({
          label: tr('缓存命中率'),
          value: s.cache_hit_rate != null ? percent2.format(s.cache_hit_rate) : '—',
          barRatio: s.cache_hit_rate ?? 0,
        }),
        makeRichKpi({ label: tr('输出速度'), value: speedVal, unit: speedUnit, sub: ttftSub }),
      );
      renderRequestAnalytics(data);
    } else {
      renderHeadCost(view, s.cost_usd, s.unpriced_models > 0 ? tr("{0} 个模型未计价", number(s.unpriced_models)) : '');
      if (view.summary) {
        view.summary.textContent = view.items.length < data.total
          ? tr("显示 {0} 个中的 {1} 个", number(data.total), number(view.items.length)) : tr("{0} 个会话", number(data.total));
      }
      const sessSub = s.median_tokens != null
        ? tr("中位 {0} · p90 {1}", number(s.median_tokens, true), number(s.p90_tokens, true))
        : tr("{0} 轮调用", number(s.requests));
      const tokSub = tr("输入 {0} · 输出 {1}", number(s.input_tokens, true), number(s.output_tokens, true));
      const costSub = s.unpriced_models > 0 ? tr("{0} 个模型未计价", number(s.unpriced_models)) : tr('按关联网关费率估算');
      const cacheSub = s.cache_hit_rate != null ? tr("命中率 {0}", percent2.format(s.cache_hit_rate)) : tr('暂无缓存统计');
      const activeSub = s.active_days > 0 ? tr("共 {0} 天", number(s.active_days)) : '—';
      const projSub = s.top_project ? tr("{0} 占 {1}%", s.top_project, Math.round((s.top_project_share || 0) * 100)) : '—';

      view.stats.replaceChildren(
        makeRichKpi({ topFirst: true, label: tr('会话数'), value: number(data.total), sub: sessSub }),
        makeRichKpi({ topFirst: true, label: 'TOKEN', value: number(s.total_tokens, true), title: number(s.total_tokens), sub: tokSub }),
        makeRichKpi({ topFirst: true, label: tr('费用'), value: shortCost(s.cost_usd, s.unpriced_models > 0), title: costText(s.cost_usd), sub: costSub }),
        makeRichKpi({ topFirst: true, label: tr('缓存读取'), value: number(s.cache_read_tokens, true), title: number(s.cache_read_tokens), sub: cacheSub }),
        makeRichKpi({ topFirst: true, label: tr('活跃时长'), value: duration(s.active_sec ?? s.elapsed_sec), sub: activeSub }),
        makeRichKpi({ topFirst: true, label: tr('项目'), value: number(s.projects ?? s.workspaces), sub: projSub }),
      );
      renderSessionAnalytics(view, data);
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
    const unconfirmed = Boolean(record?.remote_turn_unconfirmed);
    const badge = node('span', 'activity-status', unconfirmed ? tr('远端终态未确认') : (tr(statuses[status]) || status));
    badge.dataset.status = status;
    if (unconfirmed) {
      badge.dataset.unconfirmed = 'true';
      badge.title = tr('远端 Codex 回合可能仍在运行，请勿同会话盲目并发派发；可尝试中止以确认终态');
      badge.style.color = 'var(--activity-amber, var(--gp-warn))';
      badge.style.fontWeight = '600';
    }
    if (record.retried) badge.append(tr(' · 重试'));
    return badge;
  }

  function pendingQuestion(run) {
    return runState(run) === 'waiting_gemini' ? run.pending_tool_call?.arguments : null;
  }

  async function findRunRequest(runId, signal) {
    const { items } = await transport.listActivity('requests', { run_id: runId }, { signal });
    return items.find((request) => request.run_id === runId);
  }

  function interruptButton(run, label) {
    const control = button(label, 'activity-link run-interrupt');
    control.dataset.runAction = 'interrupt';
    if (runState(run) === 'queued') {
      control.disabled = true;
      control.title = tr('等待 Codex 启动当前轮');
      return control;
    }
    const id = run.run_id;
    control.disabled = interrupts.has(id);
    control.onclick = async () => {
      if (interrupts.has(id)) return;
      interrupts.add(id);
      control.disabled = true;
      try {
        await transport.runAction('interrupt_run', { run_id: id });
        showToast(run.remote_turn_unconfirmed ? tr('已发送中断确认请求') : tr('已发送中止请求'));
      } catch (err) {
        showToast(tr("中止失败 · {0}", errorText(err.message)), 'error');
      } finally {
        interrupts.delete(id);
        control.disabled = false;
        await Promise.all([refreshState(), refreshActivityView(activityViews[activeTab])]);
      }
    };
    return control;
  }

  function runElapsed(time) {
    const start = typeof time === 'number' ? time * 1000 : Date.parse(time);
    return Number.isFinite(start) ? duration(Math.max(0, (Date.now() - start) / 1000)) : '';
  }

  function preview(className, value) {
    const line = node('p', className, value.replace(/\s+/g, ' ').trim());
    line.title = line.textContent;
    return line;
  }

  let restartConfirmTimer = null;
  let restartConfirmPending = false;
  let restartInFlight = false;

  function clearRestartConfirm() {
    restartConfirmPending = false;
    if (restartConfirmTimer) {
      clearTimeout(restartConfirmTimer);
      restartConfirmTimer = null;
    }
  }

  async function restartAppServerAction() {
    if (restartInFlight) return;
    const chip = $('chip-app-server');
    const val = $('chip-app-server-val');
    const force = restartConfirmPending;
    clearRestartConfirm();
    restartInFlight = true;
    if (chip) chip.disabled = true;
    if (val) val.textContent = tr('重启中…');
    try {
      await transport.runAction('restart_app_server', { force });
      showToast(tr('共享 Codex app-server 已重启'));
      await refreshState({ manual: false });
    } catch (err) {
      if (err.status === 409 && err.data?.active_runs && !force) {
        restartConfirmPending = true;
        if (val) val.textContent = tr('再点强制重启');
        showToast(err.message || tr('当前有运行中任务，再点一次将强制重启 Codex 服务'), 'error');
        restartConfirmTimer = setTimeout(() => {
          clearRestartConfirm();
          if (latestState) renderLiveOverview(latestState);
        }, 5000);
        return;
      }
      showToast(tr("重启失败: {0}", errorText(err.message)), 'error');
      await refreshState({ manual: false });
    } finally {
      restartInFlight = false;
      if (chip) chip.disabled = embedded && !latestState?.app_server?.pid;
    }
  }

  function renderLiveOverview(state) {
    const server = state.app_server;
    const runners = Array.isArray(state.runners) ? state.runners : [];
    const hasAnyRunner = state.has_any_runner ?? runners.some((r) => r.available);
    const codexMissing = state.codex_cli_available === false;
    const isMissingCodexMsg = Boolean(server?.error && /未找到\s*Codex\s*CLI|Codex CLI not found/i.test(server.error));
    const unavailable = embedded && !server?.pid;
    $('chip-app-server').disabled = unavailable || restartInFlight || (codexMissing && !server?.running);
    $('chip-app-server').dataset.tone = (server?.error && !isMissingCodexMsg) ? 'warn' : server?.running ? 'ok' : 'neutral';
    if (!restartInFlight && !restartConfirmPending) {
      $('chip-app-server-val').textContent = codexMissing && !server?.running
        ? tr('未安装 Codex')
        : unavailable ? tr('未运行 · 在 Magpie 启动')
        : server?.error ? tr('异常 · 点此重启')
        : server?.running ? tr('运行中 · 重启')
        : tr('未运行 · 启动');
    }
    const error = $('app-server-error');
    const showRealError = Boolean(server?.error && !isMissingCodexMsg);
    error.textContent = showRealError ? errorText(server.error) : '';
    error.hidden = !showRealError;

    const zeroGuide = $('zero-cli-guide');
    if (zeroGuide) {
      const showZeroGuide = runners.length > 0 && !hasAnyRunner;
      zeroGuide.hidden = !showZeroGuide;
      if (showZeroGuide) {
        zeroGuide.textContent = tr('尚未检测到执行 CLI — 咨询（gpt_ask）仍可正常使用。安装任一受支持 CLI（如 npm install -g @openai/codex 或 npm install -g opencode-ai）即可启用自主执行与 Swarm。');
      }
    }

    const runs = state.active_runs || [];
    const list = $('active-run-list');
    $('active-runs').hidden = !runs.length;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedRunId = focused?.closest('[data-run-id]')?.dataset.runId;
    let restoreFocus;
    list.replaceChildren(...runs.map((run) => {
      const row = node('li', 'active-run');
      row.dataset.runId = run.run_id;
      const info = node('div', 'active-run-info');
      const head = node('div', 'active-run-meta');
      const title = node('strong', '', run.title || tr('GPT 任务'));
      title.title = run.cwd || '';
      const status = runState(run);
      const phase = run.progress?.phase;
      const phaseLabel = tr(phases[phase]) || phase;
      head.append(statusBadge(run), title);
      if (phaseLabel && phaseLabel !== (tr(statuses[status]) || status)) {
        head.append(node('span', 'run-phase', phaseLabel));
      }
      const elapsed = node('span', 'run-elapsed', runElapsed(run.started_at || run.created_at));
      elapsed.hidden = !elapsed.textContent;
      head.append(elapsed);
      info.append(head);
      const command = run.progress?.recent_commands?.at(-1);
      const snippet = (typeof command === 'string' ? command : command?.command) || run.progress?.last_message;
      if (snippet) info.append(preview('run-preview', snippet));
      const question = pendingQuestion(run)?.question;
      if (question) info.append(preview('run-question', question));
      if (run.remote_turn_unconfirmed) {
        info.append(preview('run-question', tr('远端回合终态未确认：请勿同会话盲目并发派发，可点击「中止确认」向远端补发中断。')));
      }
      const actions = node('div', 'active-run-actions');
      const detail = button(tr('查看详情'));
      detail.dataset.runAction = 'detail';
      detail.onclick = () => navigate('live', { id: run.run_id, sessionId: run.session_id, focus: true });
      const interrupt = interruptButton(run, run.remote_turn_unconfirmed ? tr('中止确认') : tr('中止'));
      actions.append(detail, interrupt);
      row.append(info, actions);
      if (run.run_id === focusedRunId) restoreFocus = focused.dataset.runAction === 'detail' ? detail : interrupt;
      return row;
    }));
    restoreFocus?.focus({ preventScroll: true });
  }

  const ledgerColumns = [
    [tr('时间'), 'when'], ['Agent', 'agent'], [tr('请求模型'), 'model mobile-extra'], [tr('供应商 · 账号'), 'provider mobile-extra'],
    [tr('发送模型'), 'model optional'], [tr('响应模型'), 'model'], [tr('推理强度'), 'optional'], [tr('输入'), 'num'],
    [tr('输出'), 'num'], [tr('缓存写入'), 'num optional'], [tr('缓存读取'), 'num optional'], [tr('缓存命中率'), 'num wide'],
    [tr('费用'), 'num'], ['TTFT', 'num wide'], [tr('耗时'), 'num'], [tr('速度'), 'num'], [tr('状态'), ''],
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
      const open = () => navigateActivityTab(view.kind, false, r.id);
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
      agent.append(node('span', 'activity-badge', tr(modes[r.mode])));
      add(agent, r.title);
      add(r.requested_model, r.requested_model);
      add(providerText(r), providerText(r));
      add(r.sent_model, r.sent_model);
      const served = node('span', 'ledger-agent', r.model || '—');
      if (r.tier) served.append(node('span', 'activity-badge', titleCaseTier(r.tier)));
      add(served, r.model);
      add(r.reasoning_effort);
      token(r.usage.input_tokens);
      token(r.usage.output_tokens);
      token(r.usage.cache_write_tokens);
      token(r.usage.cache_read_tokens);
      add(cacheRateText(r.usage.cache_hit_rate));
      add(costText(r.cost_usd));
      add(msText(r.ttft_ms));
      const elapsed = add(duration(r.elapsed_sec), r.elapsed_sec == null ? '' : `${number(r.elapsed_sec)} s`);
      if (r.elapsed_sec != null) {
        elapsed.dataset.latency = r.elapsed_sec <= 10 ? 'fast' : r.elapsed_sec <= 30 ? 'slow' : 'long';
      }
      add(speedText(r.tokens_per_sec));
      add(statusBadge(r));
    }
    view.results.replaceChildren(table);
  }

  function sessionRow(view, session) {
    const row = node('div', 'activity-session-entry');
    const summary = button('', 'activity-session-row');
    summary.dataset.activityId = session.id;
    const icon = node('span', 'activity-session-icon', session.mode === 'exec' ? '>_' : '≡');
    icon.setAttribute('aria-hidden', 'true');
    const who = node('span', 'activity-session-who');
    const title = node('strong', '', session.title || tr('GPT 任务'));
    title.title = session.title;
    const meta = node('small', '', [session.model, filterLabel('tier', session.tier), when(session.updated_at)].filter(Boolean).join(' · '));
    const folder = node('span', 'session-folder', session.cwd);
    folder.title = session.cwd;
    meta.title = [meta.textContent, session.cwd].filter(Boolean).join(' · ');
    if (session.cwd) meta.append(folder);
    who.append(title, meta);
    const tokens = node('span', 'activity-session-num');
    tokens.append(node('b', '', number(session.usage.total_tokens, true)));
    if (session.usage.total_tokens != null) {
      tokens.title = `${number(session.usage.total_tokens)} token`;
      tokens.append(node('small', '', tr("输入 {0} · 输出 {1}", number(session.usage.input_tokens, true), number(session.usage.output_tokens, true))));
    }
    const arrow = node('span', 'activity-session-go', '›');
    arrow.setAttribute('aria-hidden', 'true');
    summary.append(icon, who, node('span', 'activity-badge', tr(modes[session.mode])));
    if (isActiveRun(session) || session.state === 'interrupted') summary.append(statusBadge(session));
    summary.append(tokens,
      node('span', 'activity-session-turns', tr("{0} 轮", number(session.turn_count))), arrow);
    summary.onclick = () => navigateActivityTab(view.kind, false, session.id);
    row.append(summary);
    if (session.live_run_id) {
      const live = button(tr('实时流 ›'));
      live.onclick = () => navigate('live', { id: session.live_run_id, sessionId: session.session_id, focus: true });
      row.append(live);
    }
    return row;
  }

  function copyButton(value, label) {
    const copy = button(tr('复制'));
    copy.setAttribute('aria-label', tr("复制{0}", label));
    copy.onclick = () => copyText(value, tr("已复制{0}", label));
    return copy;
  }

  function detailLine(list, label, value, copy = false, action) {
    if (value == null || value === '') return;
    const body = node('dd');
    if (value instanceof Node) body.append(value);
    else body.textContent = value;
    if (copy) body.append(' ', copyButton(value, label));
    if (action) body.append(' ', action);
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
    detailLine(info, tr('当前阶段'), tr(phases[progress?.phase]) || progress?.phase);
    box.append(info);
    const commands = progress?.recent_commands?.map((entry) => typeof entry === 'string' ? entry : [
      entry.command, entry.exit_code == null ? '' : tr("退出码 {0}", entry.exit_code),
    ].filter(Boolean).join('\n'));
    detailText(box, tr('最近命令'), commands?.join('\n\n'));
    detailText(box, tr('已触及文件'), progress?.touched_files?.join('\n'));
    detailText(box, tr('实时输出摘要'), progress?.last_message);
    if (question) {
      detailText(box, tr('等待 Gemini 回复'), [question.question, question.reason && tr("原因　{0}", question.reason),
        ...(question.media_paths || [])].filter(Boolean).join('\n'));
    }
    return box.querySelector('dt, pre') ? [box] : [];
  }

  function usageText(usage) {
    return usage.total_tokens == null ? '—' : [
      `${number(usage.total_tokens)} token`, tr("输入 {0}", number(usage.input_tokens)), tr("输出 {0}", number(usage.output_tokens)),
      tr("缓存读取 {0}", number(usage.cache_read_tokens)), tr("缓存写入 {0}", number(usage.cache_write_tokens)),
      ...(usage.reasoning_tokens == null ? [] : [tr("推理 {0}", number(usage.reasoning_tokens))]),
    ].join(' · ');
  }

  function detailLink(tab, id, label) {
    const link = node('a', 'activity-link', label);
    link.href = `#${tab}/${encodeURIComponent(id)}`;
    link.onclick = (event) => {
      event.preventDefault();
      navigate(tab, { id, focus: true });
    };
    return link;
  }

  const commandText = (entries) => entries.map((entry) => typeof entry === 'string' ? entry : [
    entry?.command, entry?.exit_code == null ? '' : tr("退出码 {0}", entry.exit_code), entry?.output,
  ].filter(Boolean).join('\n')).join('\n\n');

  const eventTitle = (event) => ({
    reasoning: tr('思考过程摘要'),
    agent_message: event.phase === 'final_answer' ? tr('最终回复') : tr('中间消息'),
    command: event.exit_code == null ? tr('命令') : tr("命令 · 退出码 {0}", event.exit_code),
    files: tr("触及文件 · {0}", event.count ?? 0),
    ask_gemini: `ask_gemini · ${({ pending: tr('等待回复'), resolved: tr('已回复'), completed: tr('已完成'),
      inProgress: tr('进行中'), failed: tr('失败') })[event.status] || event.status || tr('已记录')}`,
  })[event.type];

  function eventText(event) {
    if (event.type === 'command') return [event.command, event.output].filter(Boolean).join('\n');
    if (event.type === 'files') return event.paths.join('\n');
    if (event.type === 'ask_gemini') {
      const args = event.arguments ?? {};
      return [args.question, args.reason, args.context, ...(args.media_paths || []), event.result].filter(Boolean).join('\n');
    }
    return event.text;
  }

  function renderTimeline(turn) {
    if (!turn.timeline.length && !turn.timeline_truncated) return null;
    const section = node('section', 'activity-detail-text activity-trace');
    section.append(node('h4', '', tr('执行轨迹')));
    const list = node('ol', 'activity-events');
    for (const event of turn.timeline) {
      const item = node('li', 'activity-event');
      const title = eventTitle(event);
      if (event.type === 'reasoning' || event.type === 'command' || event.type === 'ask_gemini') {
        const details = node('details');
        details.dataset.event = `${turn.id}/${event.type}/${event.id}`;
        details.append(node('summary', '', title), node('pre', '', eventText(event)));
        item.append(details);
      } else {
        item.append(node('strong', '', title), node('pre', '', eventText(event)));
      }
      list.append(item);
    }
    section.append(list);
    if (turn.timeline_truncated) section.append(node('p', 'activity-muted', tr('仅显示可载入的近期事件。')));
    return section;
  }

  function renderGatewayRequests(rows) {
    if (!rows.length) return null;
    const section = node('section', 'activity-detail-text');
    section.append(node('h4', '', tr("底层网关调用 · {0} 次", number(rows.length))));
    const wrap = node('div', 'ledger-wrap activity-gateway-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', tr('底层网关调用明细'));
    const table = node('table', 'activity-ledger activity-gateway');
    const columns = [
      [tr('时间'), (r) => when(r.timestamp)], [tr('请求模型'), (r) => r.requested_model], [tr('发送模型'), (r) => r.sent_model],
      [tr('响应模型'), (r) => r.model], [tr('供应商 · 账号'), providerText], [tr('状态码'), (r) => r.status_code],
      ['TTFT', (r) => msText(r.ttft_ms)], [tr('耗时'), (r) => msText(r.duration_ms)],
      [tr('速度'), (r) => speedText(r.tokens_per_sec)], [tr('输入'), (r) => number(r.input_tokens)],
      [tr('输出'), (r) => number(r.output_tokens)], [tr('缓存读取'), (r) => number(r.cache_read_tokens)],
      [tr('缓存写入'), (r) => number(r.cache_write_tokens)], [tr('费用'), (r) => costText(r.cost_usd)],
    ];
    const header = table.createTHead().insertRow();
    for (const [label] of columns) {
      const th = node('th', '', label);
      th.scope = 'col';
      header.append(th);
    }
    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const [, value] of columns) tr.insertCell().textContent = value(row) || '—';
    }
    wrap.append(table);
    section.append(wrap);
    return section;
  }

  function renderTurn(r, heading) {
    const box = node('article', 'activity-detail-box');
    if (heading) {
      const head = node('header', 'activity-turn-head');
      head.append(node('h3', '', heading), detailLink('requests', r.id, tr('查看该轮请求 ›')));
      box.append(head);
    }
    const info = node('dl', 'activity-detail-info');
    const add = (label, value, copy = false) => detailLine(info, label, value, copy);
    add(tr('时间'), when(r.timestamp));
    add(tr('模式'), tr(modes[r.mode]));
    add(tr('状态'), statusBadge(r));
    if (r.remote_turn_unconfirmed) {
      add(tr('远端状态'), tr('远端终态未确认（请勿同会话盲目并发派发，可尝试中止以确认终态）'));
    }
    add('Agent', r.agent);
    add(tr('请求模型'), r.requested_model);
    add(tr('发送模型'), r.sent_model);
    add(tr('响应模型'), r.model);
    add(tr('供应商 · 账号'), providerText(r));
    add(tr('档位'), r.tier && titleCaseTier(r.tier));
    add(tr('推理强度'), r.reasoning_effort);
    add(tr('耗时'), duration(r.elapsed_sec));
    add('TTFT', msText(r.ttft_ms));
    add(tr('速度'), speedText(r.tokens_per_sec));
    add(tr('费用'), costText(r.cost_usd));
    add('Token', usageText(r.usage));
    add(tr('文件夹'), r.cwd, true);
    detailLine(info, tr('会话 ID'), r.session_id, true, !heading && r.session_id
      ? detailLink('sessions', r.session_id, tr('查看所属会话 ›')) : null);
    detailLine(info, tr('运行 ID'), r.run_id, true, r.run_id
      ? detailLink('live', r.run_id, tr('查看实时流 ›')) : null);
    add(tr('Codex 线程 ID'), r.codex_thread_id, true);
    add(tr('验证'), tr(checks[r.verification.status]) || r.verification.status);
    box.append(info);
    detailText(box, tr('目标'), r.goal);
    if (r.prompt !== r.goal) detailText(box, tr('提示词'), r.prompt);
    if (!r.timeline.some((event) => event.type === 'agent_message' && event.phase === 'final_answer' && event.text === r.reply)) {
      detailText(box, r.reply_is_preview ? tr('回复预览') : tr('回复'), r.reply);
    }
    detailText(box, tr('错误'), r.error);
    detailText(box, tr('要求验证'), r.verification.requested);
    detailText(box, tr('验证检查'), commandText(r.verification.checks));
    if (!r.timeline.some((event) => event.type === 'command')) detailText(box, tr('执行的命令'), commandText(r.commands));
    const timeline = renderTimeline(r);
    if (timeline) box.append(timeline);
    const gateway = renderGatewayRequests(r.gateway_requests);
    if (gateway) box.append(gateway);
    return box;
  }

  function renderSessionDetail(session) {
    const box = node('section', 'activity-detail-box');
    const info = node('dl', 'activity-detail-info');
    const latestRun = session.turns.findLast((turn) => turn.run_id);
    detailLine(info, tr('会话 ID'), session.session_id, true, latestRun
      ? detailLink('live', latestRun.run_id, tr('查看实时流 ›')) : null);
    detailLine(info, tr('文件夹'), session.cwd, true);
    detailLine(info, tr('模式'), tr(modes[session.mode]));
    detailLine(info, tr('时间'), session.created_at && session.created_at !== session.updated_at
      ? `${when(session.created_at)} – ${when(session.updated_at)}` : when(session.updated_at));
    detailLine(info, tr('轮次'), number(session.turn_count));
    detailLine(info, 'Token', usageText(session.usage));
    detailLine(info, tr('耗时'), duration(session.elapsed_sec));
    detailLine(info, tr('总费用'), costText(session.cost_usd));
    box.append(info);
    return [box, ...session.turns.map((turn) => renderTurn(turn, turn.turn == null
      ? tr('执行记录') : tr("第 {0} 轮", number(turn.turn))))];
  }

  function downloadActivity(file, value) {
    const url = URL.createObjectURL(value);
    const link = document.createElement('a');
    link.href = url;
    link.download = file;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSession(session) {
    const inline = (value) => String(value ?? '—').replace(/\s*\r?\n\s*/g, ' ')
      .replace(/[\\`*_{}\[\]()#+.!<>|&~]/g, '\\$&');
    const textSection = (label, value) => {
      if (!value) return '';
      let fenceLength = 3;
      for (const [run] of value.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run.length + 1);
      const fence = '`'.repeat(fenceLength);
      return `### ${label}\n\n${fence}text\n${value}\n${fence}\n\n`;
    };
    const meta = (label, value) => `- ${label}　${inline(value)}\n`;
    let markdown = `# ${inline(session.title || tr('GPT 会话'))}\n\n`
      + meta(tr('会话 ID'), session.session_id) + meta(tr('文件夹'), session.cwd || '—')
      + meta(tr('模式'), tr(modes[session.mode])) + meta(tr('模型'), session.model || '—')
      + meta(tr('创建'), when(session.created_at)) + meta(tr('更新'), when(session.updated_at))
      + meta(tr('轮次'), session.turn_count) + meta(tr('总费用'), costText(session.cost_usd)) + '\n';
    for (const turn of session.turns) {
      const events = (kind) => turn.timeline.filter((event) => event.type === kind);
      const loggedCommands = events('command');
      const commands = [...turn.commands, ...loggedCommands.filter((event) =>
        !turn.commands.some((prior) => (typeof prior === 'string' ? prior : prior.command) === event.command))];
      markdown += `## ${turn.turn == null ? tr('执行记录') : tr("第 {0} 轮", turn.turn)}\n\n`
        + meta(tr('请求 ID'), turn.id) + meta(tr('时间'), when(turn.timestamp)) + meta(tr('模型'), turn.model || '—')
        + meta(tr('状态'), tr(statuses[runState(turn)]) || runState(turn))
        + meta(tr('验证'), tr(checks[turn.verification.status]) || turn.verification.status || '—') + '\n'
        + textSection(tr('目标'), turn.goal) + textSection(tr('思考过程摘要'), events('reasoning').map(eventText).join('\n\n'))
        + textSection(tr('回复'), turn.reply || events('agent_message').map(eventText).join('\n\n'))
        + textSection(tr('命令'), commandText(commands)) + textSection(tr('要求验证'), turn.verification.requested)
        + textSection(tr('验证结果'), commandText(turn.verification.checks));
      if (turn.timeline_truncated) markdown += tr('部分轨迹已截断。\n\n');
    }
    downloadActivity(`${session.session_id}.md`, new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  }

  function closeActivityDetail(view, restore = true) {
    const open = view.open;
    if (!open) return;
    open.abort?.abort();
    view.open = null;
    view.detail.hidden = true;
    view.detail.replaceChildren();
    view.list.hidden = false;
    if (!restore) return;
    const row = [...view.results.querySelectorAll('[data-activity-id]')]
      .find((row) => row.dataset.activityId === open.id);
    (row || $(`tab-${view.kind}`)).focus({ preventScroll: true });
    scrollTarget.scrollTo(0, open.scroll);
  }

  async function loadActivityDetail(view, refresh = false) {
    if (!visible || activeTab !== view.kind) return;
    const open = view.open;
    open.abort?.abort();
    const abort = open.abort = new AbortController();
    const body = view.detail.querySelector('.activity-detail-body');
    body.setAttribute('aria-busy', 'true');
    try {
      const fetchDetail = (id) => transport.getActivity(view.kind, id, { signal: abort.signal });
      let data;
      try {
        data = await fetchDetail(open.id);
      } catch (error) {
        if (error.status !== 404 || !open.runId || abort.signal.aborted) throw error;
        // A finished run can move into its session's numbered turn.
        const request = await findRunRequest(open.runId, abort.signal);
        if (!request || request.id === open.id) throw error;
        open.id = request.id;

        data = await fetchDetail(open.id);
      }
      if (abort.signal.aborted) return;
      open.syncedAt = Date.now();
      open.refreshError = '';
      if (view.kind === 'requests' && data.run_id) open.runId = data.run_id;
      const rendered = JSON.stringify(data);
      if (open.rendered === rendered && !body.querySelector('button:disabled')) return;
      open.rendered = rendered;
      open.data = data;
      renderActivityDetail(view, data);
    } catch (err) {
      if (abort.signal.aborted) return;
      if (refresh && open.rendered) {
        open.refreshError = err.message;
        return;
      }
      open.rendered = null;
      open.data = null;
      const retry = button(tr('重试'));
      retry.onclick = () => loadActivityDetail(view);
      body.replaceChildren(node('p', 'activity-empty', tr("读取详情失败（{0}）", errorText(err.message))), retry);
    } finally {
      if (!abort.signal.aborted) {
        open.abort = null;
        body.removeAttribute('aria-busy');
        renderSyncStatus();
        syncLivePoll();
      }
    }
  }

  function renderActivityDetail(view, data) {
    const body = view.detail.querySelector('.activity-detail-body');
    const session = view.kind === 'sessions';
    const run = session ? data.turns.findLast(isActiveRun) || data : data;
    const head = node('header', 'activity-detail-head');
    head.append(node('h2', '', data.title || (session ? tr('GPT 会话') : tr('请求详情'))));
    if (runState(run)) head.append(statusBadge(run));
    const focusedInterrupt = body.contains(document.activeElement)
      && document.activeElement.dataset.runAction === 'interrupt';
    const interrupt = run.run_id && (['running', 'waiting_gemini'].includes(runState(run)) || run.remote_turn_unconfirmed)
      ? interruptButton(run, run.remote_turn_unconfirmed ? tr('尝试中止确认') : tr('中止当前轮')) : null;
    if (interrupt) head.append(interrupt);
    if (session) {
      const exportButton = button(tr('导出 Markdown'));
      exportButton.onclick = () => exportSession(data);
      head.append(exportButton);
    }
    const expanded = new Set([...body.querySelectorAll('details[open]')].map((details) => details.dataset.event));
    body.replaceChildren(head, ...renderRunProgress(run), ...(session ? renderSessionDetail(data) : [renderTurn(data)]));
    for (const details of body.querySelectorAll('details[data-event]')) details.open = expanded.has(details.dataset.event);
    if (focusedInterrupt) (interrupt || view.detail.querySelector('.activity-back')).focus({ preventScroll: true });
  }

  function openActivityDetail(view, id) {
    view.open?.abort?.abort();
    const runId = /^run-([a-f0-9]{32})$/.exec(id)?.[1];
    view.open = { id, linkId: id, runId, scroll: root.scrollTop };
    const back = button(view.kind === 'requests' ? tr('‹ 请求') : tr('‹ 会话'), 'activity-link activity-back');
    back.onclick = () => navigateActivityTab(view.kind);
    const body = node('div', 'activity-detail-body');
    body.append(node('p', 'activity-empty', view.kind === 'sessions' ? tr('正在读取会话…') : tr('正在读取请求…')));
    view.detail.replaceChildren(back, body);
    view.list.hidden = true;
    view.detail.hidden = false;
    scrollTarget.scrollTo(0, 0);
    back.focus({ preventScroll: true });
    void loadActivityDetail(view);
  }

  function activityQuery(view) {
    const query = new URLSearchParams({ q: view.list.querySelector('.activity-search').value.trim() });
    if (view.range !== 'all') query.set('range', view.range);
    for (const select of view.list.querySelectorAll('[data-filter]')) {
      if (select.value && select.dataset.filter !== 'status') query.set(select.dataset.filter, select.value);
    }
    if (view.status) query.set('status', view.status);
    return query;
  }

  async function loadActivityList(view, offset = 0, append = false, refresh = false) {
    if (!visible || activeTab !== view.kind) return;
    view.listFetch?.abort();
    const abort = view.listFetch = new AbortController();
    const limit = refresh && view.kind === 'sessions' ? Math.max(activityPageSize, view.items.length) : activityPageSize;
    const query = activityQuery(view);
    query.set('offset', offset);
    query.set('limit', Math.min(100, limit));
    const pagers = view.list.querySelectorAll('[data-page]');
    for (const control of pagers) control.disabled = true;
    view.results.setAttribute('aria-busy', 'true');
    if (!view.loaded) view.results.replaceChildren(node('div', 'activity-empty', tr('正在读取记录…')));
    try {
      const fetchPage = () => transport.listActivity(view.kind, {
        ...Object.fromEntries(query),
        offset: Number(query.get('offset')), limit: Number(query.get('limit')),
      }, { signal: abort.signal });
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
      view.loaded = true;
      view.offset = data.offset;
      view.total = data.total;
      view.page = { data, query, end: view.offset + data.items.length };
      renderActivityList(view, append);
      view.syncedAt = Date.now();
      view.refreshError = '';
    } catch (err) {
      if (abort.signal.aborted) return;
      if (refresh && view.loaded) {
        view.refreshError = err.message;
        for (const control of pagers) control.disabled = control.dataset.page === 'newer' ? view.offset <= 0
          : view.kind === 'requests' && view.offset + view.items.length >= view.total;
        return;
      }
      const retry = button(tr('重试'));
      // Rebuild the first page if a failed load replaced its rows.
      retry.onclick = () => loadActivityList(view);
      const error = node('div', 'activity-empty', tr("读取记录失败（{0}） ", errorText(err.message)));
      error.append(retry);
      view.results.replaceChildren(error);
      view.loaded = false;
      view.page = null;
      view.refreshError = '';
    } finally {
      if (!abort.signal.aborted) {
        view.listFetch = null;
        view.results.removeAttribute('aria-busy');
        renderSyncStatus();
        syncLivePoll();
      }
    }
  }

  function renderActivityList(view, append = false, replaceItems = true) {
    const { data, query, end } = view.page;
    const pagers = view.list.querySelectorAll('[data-page]');
    const focusedId = view.results.contains(document.activeElement) && document.activeElement.dataset.activityId;
    if (append) {
      const drawn = new Set(view.items.map((row) => row.id));
      const next = data.items.filter((row) => !drawn.has(row.id));
      view.items.push(...next);
      view.results.append(...next.map((session) => sessionRow(view, session)));
    } else {
      if (replaceItems) view.items = data.items;
      if (!view.items.length) {
        const filtered = query.get('q') || [...query.keys()].some((key) => !['q', 'offset', 'limit'].includes(key));
        const message = view.kind === 'requests' ? (filtered ? tr('没有符合这些筛选条件的请求。') : tr('暂无请求。'))
          : (filtered ? tr('没有匹配的会话。') : tr('暂无会话。'));
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
    if (view.kind === 'requests') {
      const pager = view.list.querySelector('.activity-pager');
      pager.hidden = data.total <= activityPageSize;
      pager.querySelector('span').textContent = tr("第 {0}–{1} 条，共 {2} 条", number(view.offset + 1), number(end), number(data.total));
      pagers[0].disabled = view.offset <= 0;
      pagers[1].disabled = end >= data.total;
    } else {
      pagers[0].hidden = end >= data.total;
      pagers[0].textContent = tr("显示另外 {0} 个", number(Math.min(data.total - end, activityPageSize)));
      pagers[0].disabled = false;
    }
  }

  function refreshActivityView(view) {
    if (!visible || !view || activeTab !== view.kind) return;
    return view.open ? loadActivityDetail(view, true)
      : loadActivityList(view, view.kind === 'requests' ? view.offset : 0, false, true);
  }

  function syncLivePoll() {
    const active = visible && activeTab === 'overview' && latestState?.active_runs?.length;
    if (!active || document.visibilityState !== 'visible') {
      clearTimeout(liveTimer);
      liveTimer = null;
    } else if (liveTimer === null) {
      liveTimer = setTimeout(async () => {
        liveTimer = null;
        if (activeTab === 'overview' && document.visibilityState === 'visible') await refreshRunState();
        syncLivePoll();
      }, LIVE_POLL_MS);
    }
  }

  function setTab(tab, { id, work = false } = {}) {
    const previous = activeTab;
    const wasVisible = visible;
    visible = tab !== 'live';
    activeTab = tab;
    if (tab !== previous) {
      if (previous === 'overview') {
        stateFetch?.abort();
        stateFetch = null;
        ratioFetch?.abort();
        runStateFetch?.abort();
      }
      if (activityViews[previous]) {
        activityViews[previous].listFetch?.abort();
        closeActivityDetail(activityViews[previous], false);
      }
      scrollTarget.scrollTo(0, 0);
    }
    for (const name of activityTabs) $(name).hidden = name !== tab;
    if (!visible) {
      syncLivePoll();
      return;
    }
    const view = activityViews[tab];
    if (view && id) {
      if (view.open?.linkId !== id) openActivityDetail(view, id);
    } else if (view) {
      const hadDetail = Boolean(view.open);
      closeActivityDetail(view, tab === previous);
      if (!view.loaded || hadDetail) void refreshActivityView(view);
    } else {
      locateWork = work;
      if (work && latestState) renderState(latestState);
      if (!latestState || !wasVisible || previous !== tab) {
        void refreshState();
        void refreshRatio();
      }
    }
    markUiReady();
    renderSyncStatus();
    syncLivePoll();
  }

  function navigateActivityTab(tab, focus = false, id) {
    navigate(tab, { id, focus });
  }

  for (const link of root.querySelectorAll('[data-activity-tab]')) {
    link.onclick = (event) => {
      event.preventDefault();
      navigateActivityTab(link.dataset.activityTab, true);
    };
  }
  root.addEventListener('keydown', (event) => {
    const view = activityViews[activeTab];
    if (event.key === 'Escape' && view?.open) navigateActivityTab(view.kind);
  });
  function syncActivityAutoRefresh() {
    clearInterval(activityRefreshTimer);
    activityRefreshTimer = null;
    if (activityRefreshMs > 0) {
      activityRefreshTimer = setInterval(() => {
        if (!visible || document.visibilityState !== 'visible') return;
        const view = activityViews[activeTab];
        if (view && !view.listFetch && !view.open?.abort) void refreshActivityView(view);
      }, activityRefreshMs);
    }
  }

  for (const view of Object.values(activityViews)) {
    const search = view.list.querySelector('.activity-search');
    let debounce;
    search.oninput = () => {
      clearTimeout(debounce);
      view.listFetch?.abort();
      for (const control of view.list.querySelectorAll('[data-page]')) control.disabled = true;
      debounce = setTimeout(() => loadActivityList(view), 180);
    };
    const ranges = view.kind === 'requests'
      ? [['today', tr('今天')], ['24h', tr('24 小时')], ['7d', tr('7 天')], ['30d', tr('30 天')], ['all', tr('全部')]]
      : [['today', tr('今天')], ['7d', tr('7 天')], ['30d', tr('30 天')], ['90d', tr('90 天')], ['all', tr('全部')]];
    const rangeControls = ranges.map(([range, label]) => {
      const control = button(label);
      control.setAttribute('aria-pressed', String(range === view.range));
      control.onclick = () => {
        clearTimeout(debounce);
        view.range = range;
        for (const rangeButton of rangeControls) rangeButton.setAttribute('aria-pressed', String(rangeButton === control));
        void loadActivityList(view);
      };
      return control;
    });
    view.list.querySelector('[data-range-controls]').replaceChildren(...rangeControls);
    const autoSelect = view.list.querySelector('[data-auto-refresh]');
    if (autoSelect) {
      autoSelect.onchange = () => {
        activityRefreshMs = Math.max(0, Number(autoSelect.value) || 0);
        for (const other of root.querySelectorAll('[data-auto-refresh]')) other.value = String(activityRefreshMs);
        syncActivityAutoRefresh();
      };
    }
    const statusControls = view.list.querySelectorAll('button[data-status]');
    const statusSelect = view.list.querySelector('[data-filter="status"]');
    const setStatus = (status) => {
      view.status = status;
      for (const control of statusControls) {
        control.setAttribute('aria-pressed', String(control.dataset.status === status));
      }
    };
    for (const select of view.list.querySelectorAll('[data-filter]')) {
      select.onchange = () => {
        clearTimeout(debounce);
        select.classList.toggle('is-set', Boolean(select.value));
        if (select === statusSelect) setStatus(select.value);
        void loadActivityList(view);
      };
    }
    for (const control of statusControls) {
      control.onclick = () => {
        clearTimeout(debounce);
        if (statusSelect) {
          statusSelect.value = '';
          statusSelect.classList.remove('is-set');
        }
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
  const exportCsv = root.querySelector('[data-export-csv]');
  exportCsv.onclick = async () => {
    exportCsv.disabled = true;
    try {
      const query = Object.fromEntries(activityQuery(activityViews.requests));
      const { csv } = await transport.listActivity('requests', { ...query, format: 'csv' });
      downloadActivity('gempt-requests.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    } catch (error) {
      showToast(tr("导出失败（{0}）", errorText(error.message)), 'error');
    } finally {
      exportCsv.disabled = false;
    }
  };

  root.addEventListener('change', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.name === 'work_split' || target.name === 'swarm_split') {
      updateSetting(target.name, { [target.name]: target.value }, latestState[target.name], tr('工作分工已保存，下次派单生效'));
    } else if (target.name === 'default_cli') {
      void updateSetting('default_cli', { default_cli: target.value }, latestState?.execution?.default_cli || 'auto', tr('执行 CLI 已保存，下次派单生效'));
    } else if (target.name === 'native_swarm' || target.name === 'swarm_shell_model') {
      const value = target.name === 'native_swarm' ? target.value === 'true' : target.value;
      void updateSetting(target.name, { [target.name]: value }, latestState[target.name], tr('Swarm 派单设置已保存'));
    } else if (target.dataset.family) {
      const family = target.dataset.family;
      updateSetting(target.name, { pairing: { family, model: target.value } }, latestState.pairings[family], tr('配对已保存，下个新任务生效'));
    } else if (target.name === 'default_sandbox') {
      const label = tr(SANDBOX_NAMES[target.value]) || target.value;
      updateSetting('default_sandbox', { default_sandbox: target.value }, currentDefaultSandbox, tr("Codex 执行权限已切为{0}", label));
    } else if (target.name === 'active_effort') {
      const payload = target.value === 'auto'
        ? { auto_effort: true }
        : { auto_effort: false, mcp_effort: target.value };
      const label = tr(EFFORT_NAMES[target.value]) || target.value;
      const toastMsg = target.value === 'auto'
        ? tr('已开启智能定档（low..xhigh，续跑锁档）')
        : tr("思考强度已切为{0}", label);
      updateSetting('active_effort', payload, currentEffortChoice, toastMsg);
    }
  });

  const timeoutInput = $('codex-timeout');
  timeoutInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && timeoutInput.reportValidity()) {
      event.preventDefault();
      saveTimeout(timeoutInput.valueAsNumber);
    }
  });

  root.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('button') : null;
    if (!btn) return;
    if (btn.hasAttribute('data-timeout-save')) {
      if (timeoutInput.reportValidity()) saveTimeout(timeoutInput.valueAsNumber);
      return;
    }
    if (btn.dataset.timeout) {
      saveTimeout(Number(btn.dataset.timeout));
      return;
    }
    if (btn.dataset.ratioRange) {
      selectRatioRange(btn.dataset.ratioRange);
      return;
    }
    if (btn.id === 'sync-retry') {
      void refresh();
      return;
    }
    if (btn.id === 'init-sub-btn') {
      activateSubscriptionConfig();
      return;
    }
    if (btn.id === 'agy-install') {
      void installAgyAction();
      return;
    }
    if (btn.id === 'agy-copy-link' && transport.installPage) {
      copyText(transport.installPage);
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
    if (btn.id === 'chip-app-server') {
      restartAppServerAction();
      return;
    }
    const copyVal = btn.getAttribute('data-copy');
    if (copyVal) {
      copyText(copyVal);
    }
  });

  async function refresh() {
    if (!visible) return;
    if (activeTab === 'overview') await Promise.all([refreshState(), refreshRatio()]);
    else await refreshActivityView(activityViews[activeTab]);
  }

  document.addEventListener('visibilitychange', () => {
    if (visible && document.visibilityState === 'visible') void refresh();
    syncLivePoll();
  });
  updateRatioRangeControls();
  setInterval(() => {
    if (visible && activeTab === 'overview' && document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
  function renderLanguage() {
    if (latestState) {
      $('work-options').replaceChildren();
      renderState(latestState);
      renderLiveOverview(latestState);
    }
    if (activeTab === 'overview' && latestRatio) renderTokenRatio(latestRatio);
    for (const view of Object.values(activityViews)) {
      if (view.page) renderActivityList(view, false, false);
      if (view.open) {
        view.detail.querySelector('.activity-back').textContent = view.kind === 'requests' ? tr('‹ 请求') : tr('‹ 会话');
        if (view.open.data) renderActivityDetail(view, view.open.data);
      }
    }
    renderSyncStatus();
  }

  return { setTab, refresh, patchGatewayStatus, renderLanguage };
}

const preferences = new Map();

export function consolePreference(key, value) {
  if (value !== undefined) {
    preferences.set(key, value);
    try { globalThis.localStorage?.setItem(key, value); } catch { /* Opaque iframe. */ }
    return value;
  }
  if (preferences.has(key)) return preferences.get(key);
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

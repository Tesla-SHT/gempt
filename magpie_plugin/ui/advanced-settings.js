import { errorText, tr } from './i18n.js';

function extraArgs(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const words = line.split(/ +/);
    return words.every((word) => /^--[a-z-]+$/.test(word)) ? words : [line];
  });
}

export function mountAdvancedSettings($, { transport, showToast, refresh, refreshGateway, init, onLanguage }) {
  const form = $('advanced-form');
  const dirty = new Set();
  let clearing = false;
  let baseline;
  let probe;
  let busy = false;
  const status = $('gateway-result');
  const updateButtons = () => {
    $('advanced-save').disabled = busy || !baseline || !dirty.size;
    $('gateway-test').disabled = busy || !baseline;
    $('gateway-clear').disabled = busy || clearing || (!baseline?.magpie_api_key_stored && !$('gateway-key').value);
    $('reset-apply').disabled = busy;
    $('advanced-init').disabled = busy;
  };
  const renderKey = () => {
    $('gateway-key').placeholder = clearing ? tr('保存后清除') :
      baseline?.magpie_api_key_hint || tr('未配置');
  };
  const renderProbe = () => {
    status.textContent = probe === 'checking' ? tr('正在测试连接…')
      : !probe ? '' : probe.reachable
        ? tr('连接成功 · {0} ms · {1} 个模型', probe.latency_ms, probe.models.length)
        : tr('连接失败：{0}', errorText(probe.error || '网关离线'));
    status.dataset.state = probe && probe !== 'checking' ? (probe.reachable ? 'ok' : 'error') : '';
  };
  const renderModels = (models) => {
    const list = $('gateway-models');
    const ids = [...new Set(models)].filter((id) => /^\S{1,256}$/u.test(id));
    if (Array.from(list.options, (option) => option.value).join() !== ids.join()) {
      list.replaceChildren(...ids.map((id) => new Option(id, id)));
    }
  };
  const render = (state) => {
    baseline = state;
    const fields = {
      'gateway-url': state.magpie_base_url || state.magpie.url,
      'gateway-key-env': state.magpie_api_key_env,
      'utility-model': state.utility?.model,
      'utility-effort': state.utility?.reasoning_effort,
      'excluded-models': state.excluded_models?.join(', '),
      'codex-cli-path': state.codex_cli_path,
      'codex-timeout': state.codex_timeout_sec,
      'consult-timeout': state.consult_timeout_sec,
      'codex-extra-args': state.codex_extra_args?.join('\n'),
      'advanced-config-path': state.config_path,
    };
    for (const [id, value] of Object.entries(fields)) {
      if (!dirty.has(id)) $(id).value = value ?? '';
    }
    renderKey();
    $('codex-cli-path').placeholder = state.codex_auto_detected_path || tr('自动检测');
    $('codex-cli-status').textContent = state.codex_cli_available
      ? tr('Codex CLI 可用 · {0}', state.codex_cli_resolved_path)
      : tr('未找到 Codex CLI');
    const runnerList = $('runner-cli-list');
    if (runnerList && Array.isArray(state.runners)) {
      runnerList.replaceChildren(...state.runners.map((runner) => {
        const li = document.createElement('li');
        li.className = 'runner-cli-item';
        li.dataset.cli = runner.id;
        li.dataset.available = String(Boolean(runner.available));
        const head = document.createElement('div');
        head.className = 'runner-cli-head';
        const title = document.createElement('strong');
        title.textContent = `${runner.label}`;
        const idCode = document.createElement('code');
        idCode.className = 'pill-code';
        idCode.textContent = runner.id;
        const badge = document.createElement('span');
        badge.className = 'inline-state-badge';
        badge.dataset.tone = runner.available ? 'ok' : 'neutral';
        badge.textContent = runner.available ? tr('已安装') : tr('未安装');
        head.append(title, idCode, badge);
        const detail = document.createElement('span');
        detail.className = 'control-hint runner-cli-detail';
        detail.textContent = runner.available ? runner.path : runner.install_hint;
        detail.title = detail.textContent;
        li.append(head, detail);
        return li;
      }));
    }
    renderModels(probe?.reachable ? probe.models : state.magpie.models || []);
    renderProbe();
    updateButtons();
  };

  function gatewayDraft() {
    const patch = {};
    if (dirty.has('gateway-url')) patch.base_url = $('gateway-url').value.trim();
    if (dirty.has('gateway-key-env')) patch.api_key_env = $('gateway-key-env').value.trim();
    if (clearing) patch.clear_api_key = true;
    else if ($('gateway-key').value) patch.api_key = $('gateway-key').value;
    return patch;
  }

  function editedSettings() {
    const settings = {};
    const stage = (id, section, field, value) => {
      if (dirty.has(id)) (settings[section] ||= {})[field] = value;
    };
    const gateway = gatewayDraft();
    if (Object.keys(gateway).length) settings.magpie = gateway;
    stage('utility-model', 'utility', 'model', $('utility-model').value.trim());
    stage('utility-effort', 'utility', 'reasoning_effort', $('utility-effort').value);
    stage('excluded-models', 'routing_policy', 'excluded_models', $('excluded-models').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
    stage('codex-cli-path', 'codex', 'cli_path', $('codex-cli-path').value.trim());
    if (dirty.has('codex-timeout')) settings.codex_timeout_sec = $('codex-timeout').valueAsNumber || null;
    stage('consult-timeout', 'limits', 'consult_timeout_sec', $('consult-timeout').valueAsNumber || null);
    stage('codex-extra-args', 'codex', 'extra_args', extraArgs($('codex-extra-args').value));
    return settings;
  }

  function resetDraft() {
    dirty.clear();
    clearing = false;
    $('gateway-key').value = '';
    probe = undefined;
  }
  function closeConfirm() {
    $('reset-confirm').hidden = true;
    $('advanced-reset').setAttribute('aria-expanded', 'false');
  }
  async function perform(action, { lockFields = false } = {}) {
    if (busy) return;
    busy = true;
    const fields = lockFields ? [...form.querySelectorAll('.advanced-field input:enabled:not([readonly]), .advanced-field textarea:enabled, .advanced-field select:enabled')] : [];
    for (const field of fields) field.disabled = true;
    updateButtons();
    try { await action(); }
    catch (error) { showToast(tr('设置失败：{0}', errorText(error.message)), 'error'); }
    finally {
      for (const field of fields) field.disabled = false;
      busy = false;
      if (baseline) render(baseline);
      else updateButtons();
    }
  }

  form.addEventListener('input', ({ target }) => {
    if (!target.matches('.advanced-field input:not([readonly]), .advanced-field select, .advanced-field textarea')) return;
    dirty.add(target.id);
    if (target.id.startsWith('gateway-')) {
      if (target.id === 'gateway-key') {
        clearing = false;
        if (!target.value) dirty.delete(target.id);
      }
      probe = undefined;
      renderKey();
      renderProbe();
    }
    updateButtons();
  });
  $('gateway-clear').onclick = () => {
    clearing = true;
    $('gateway-key').value = '';
    dirty.add('gateway-key');
    probe = undefined;
    renderKey();
    renderProbe();
    updateButtons();
  };
  $('gateway-test').onclick = () => {
    if (!$('gateway-url').reportValidity()) return;
    void perform(async () => {
      const draft = gatewayDraft();
      probe = 'checking';
      renderProbe();
      try {
        const result = await transport.runAction('probe_gateway', draft);
        if (probe === 'checking') {
          probe = result;
          renderModels(result.models || []);
        }
      } catch (error) {
        if (probe === 'checking') probe = { reachable: false, error: error.message };
      }
      renderProbe();
    });
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const settings = editedSettings();
    if (!Object.keys(settings).length) return;
    void perform(async () => {
      await transport.saveSettings(settings);
      resetDraft();
      if (settings.magpie || settings.routing_policy) refreshGateway?.();
      await refresh();
      showToast(tr('设置已保存'));
    }, { lockFields: true });
  };
  $('language-auto').onclick = () => onLanguage?.('auto');
  $('advanced-init').onclick = () => void perform(init);
  $('advanced-reset').onclick = () => {
    $('reset-confirm').hidden = false;
    $('reset-keep-gateway').checked = true;
    $('advanced-reset').setAttribute('aria-expanded', 'true');
    $('reset-keep-gateway').focus();
  };
  $('reset-cancel').onclick = () => { closeConfirm(); $('advanced-reset').focus(); };
  $('reset-apply').onclick = () => void perform(async () => {
    await transport.runAction('reset_settings', { keep_gateway: $('reset-keep-gateway').checked });
    resetDraft();
    closeConfirm();
    $('advanced-reset').focus();
    refreshGateway?.();
    await refresh();
    showToast(tr('已恢复默认设置'));
  }, { lockFields: true });
  return { render };
}

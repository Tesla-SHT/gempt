/**
 * Magpie sandboxed launcher page for GemPT.
 * Reads host theme/language/options from _magpie/bridge.js and navigates the
 * frame to the plugin's local HTTP service (cannot probe directly under connect-src 'none').
 */
(async () => {
  const DEFAULT_PORT = 3498;
  const words = {
    en: {
      title: 'GemPT',
      connecting: 'Connecting to the local GemPT service...',
      stopped: (port) => `The local GemPT service is not running (127.0.0.1:${port}).`,
      remote: (port) => `The GemPT service listens on 127.0.0.1:${port} on the machine running Magpie. Open the page there or forward that port.`,
      retry: 'Retry',
    },
    zh: {
      title: 'GemPT',
      connecting: '正在连接本地 GemPT 服务…',
      stopped: (port) => `本地 GemPT 服务未运行（127.0.0.1:${port}）。`,
      remote: (port) => `服务只在运行 Magpie 的机器上监听 127.0.0.1:${port}，请在本机打开或做端口转发。`,
      retry: '重试',
    },
  };

  let port = DEFAULT_PORT;
  let theme = 'light';
  let lang = 'en';
  let tokens = null;
  let service = '';

  function applyLanguage(value) {
    lang = String(value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    const copy = words[lang];
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = copy.title;
    const titleEl = document.getElementById('title');
    const saidEl = document.getElementById('said');
    const retryEl = document.getElementById('retry');
    if (titleEl) titleEl.textContent = copy.title;
    if (saidEl) saidEl.textContent = copy.connecting;
    if (retryEl) retryEl.textContent = copy.retry;
  }

  const withTimeout = (promise, ms = 1500) => {
    if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise);
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('bridge timeout')), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  try {
    const current = await withTimeout(window.magpie?.ready);
    if (current) {
      theme = current.dark ? 'dark' : 'light';
      lang = String(current.lang || lang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      tokens = current.tokens || null;
    }
  } catch {
    // Runs standalone when bridge is absent.
  }

  try {
    const options = await withTimeout(window.magpie?.options?.get?.());
    const val = Number(options?.port);
    if (Number.isInteger(val) && val > 0 && val < 65536) port = val;
  } catch {
    // Keep default port.
  }

  try {
    const svc = window.magpie?.service;
    if (typeof svc === 'string' && /^https?:\/\//i.test(svc)) service = svc;
  } catch {
    // Desktop window navigates directly to loopback.
  }

  applyLanguage(lang);
  window.magpie?.onTheme?.((next) => {
    if (!next) return;
    if (typeof next.dark === 'boolean') theme = next.dark ? 'dark' : 'light';
    if (typeof next.lang === 'string') applyLanguage(next.lang);
  });

  const query = new URLSearchParams();
  query.set('theme', theme);
  query.set('lang', lang);
  query.set('_', String(Date.now()));
  if (tokens && typeof tokens === 'object') {
    try {
      const slim = {};
      for (const [k, v] of Object.entries(tokens)) {
        const text = String(v ?? '').trim();
        if (text) slim[k] = text;
      }
      if (Object.keys(slim).length) {
        query.set('tokens', btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));
      }
    } catch {
      // Fallback to page palette if token encoding fails.
    }
  }

  const retry = document.getElementById('retry');
  if (retry) {
    retry.hidden = false;
    retry.addEventListener('click', () => location.reload());
  }

  if (service) {
    const sep = service.includes('?') ? '&' : '?';
    location.replace(`${service}${sep}${query.toString()}`);
    return;
  }

  const host = String(location.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const isLocal = !host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  if (!isLocal) {
    const saidEl = document.getElementById('said');
    if (saidEl) saidEl.textContent = words[lang].remote(port);
    return;
  }

  const timer = setTimeout(() => {
    const saidEl = document.getElementById('said');
    if (saidEl) saidEl.textContent = words[lang].stopped(port);
  }, 5000);
  location.replace(`http://127.0.0.1:${port}/?${query.toString()}`);
  void timer;
})();

const actionPaths = {
  install_agy: 'install-agy',
  init: 'init',
  probe_gateway: 'probe-gateway',
  reset_settings: 'reset-settings',
  tier: 'tier',
  restart_app_server: 'app-server/restart',
  interrupt_run: ({ run_id }) => `runs/${encodeURIComponent(run_id)}/interrupt`,
};

export function createHttpTransport(apiKey, fetchPage = fetch) {
  let reloadingForAuth = false;

  async function request(path, { signal, body, csv = false } = {}) {
    const headers = apiKey ? { 'x-gempt-key': apiKey } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchPage(`./api/${path}`, {
      headers, signal,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    if (apiKey && response.status === 401 && !reloadingForAuth) {
      let shouldReload = true;
      try {
        shouldReload = Date.now() - Number(sessionStorage.getItem('gempt-auth-reload') || 0) > 3000;
        if (shouldReload) sessionStorage.setItem('gempt-auth-reload', String(Date.now()));
      } catch { /* A restricted host may disable storage. */ }
      if (shouldReload) {
        reloadingForAuth = true;
        location.reload();
      }
    }
    if (csv && response.ok) return { csv: await response.text() };
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
      throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { status: response.status, data });
    }
    return data;
  }

  return {
    isEmbeddedInAgy: false,
    getState: (options) => request('overview', options),
    getSummary: () => request('summary'),
    getMagpieStatus: (force) => request(`magpie-status${force ? '?force=1' : ''}`),
    getRunState: (options) => request('active-runs', options),
    getRatio: (range, options) => request(`token-ratio?${new URLSearchParams({ range })}`, options),
    live(operation, args, options) {
      if (operation === 'runs' || operation === 'stream') {
        return request(`live/${operation}?${new URLSearchParams(args)}`, options);
      }
      return request(`live/${operation}`, { ...options, body: args });
    },
    swarm(operation, args = {}, options) {
      if (operation === 'list' || operation === 'overview' || operation === 'board' || operation === 'raw') {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(args || {})) {
          if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
        }
        const qs = query.toString();
        return request(`swarm/${operation}${qs ? `?${qs}` : ''}`, options);
      }
      return request(`swarm/${operation}`, { ...options, body: args });
    },
    saveSettings(settings) {
      return request('settings', { body: settings });
    },
    runAction(action, args = {}) {
      const path = actionPaths[action];
      return request(typeof path === 'function' ? path(args) : path, { body: args });
    },
    listActivity(kind, query, options) {
      return request(`${kind}?${new URLSearchParams(query)}`, { ...options, csv: query.format === 'csv' });
    },
    getActivity(kind, id, options) {
      return request(`${kind}/${encodeURIComponent(id)}`, options);
    },
  };
}

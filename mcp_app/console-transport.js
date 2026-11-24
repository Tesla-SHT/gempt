// The same controller uses this transport inside the MCP Apps sandbox.
export function createConsoleTransport(call) {
  const prefix = 'gempt_app_console_';
  return {
    isEmbeddedInAgy: true,
    getState: (options) => call(prefix + 'state', {}, options),
    getSummary: () => call('gempt_app_summary', {}),
    getMagpieStatus: (force) => call('gempt_app_magpie_status', { force }),
    getRunState: (options) => call('gempt_app_active_runs', {}, options),
    getRatio: (range, options) => call('gempt_app_token_ratio', { range }, options),
    live: (operation, args, options) => call(`gempt_app_${operation}`, args, options),
    saveSettings: (settings) => call(prefix + 'settings', settings),
    runAction: (action, args) => call(prefix + 'action', { action, ...args }, { timeout: 30_000 }),
    listActivity: (kind, query, options) => call(prefix + 'activity', { kind, query }, options),
    getActivity: (kind, id, options) => call(prefix + 'activity', { kind, id }, options),
  };
}

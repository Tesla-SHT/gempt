function narratorBootstrap() {
  const listeners = new Set();
  const send = (type, payload = {}) => parent.postMessage({ type, ...payload }, "*");
  let { view, meta, theme } = JSON.parse(document.getElementById("narrator-data").textContent);
  function applyTheme(value) {
    for (const [key, color] of Object.entries(value?.tokens || {})) {
      if (/^--[a-z-]+$/.test(key)) document.documentElement.style.setProperty(key, color);
    }
    document.documentElement.style.colorScheme = value?.scheme === "dark" ? "dark" : "light";
  }
  applyTheme(theme);
  const rendered = () => send("RENDERED", { height: document.documentElement.scrollHeight });
  window.narrator = {
    get data() { return view; },
    get meta() { return meta; },
    onData(fn) { listeners.add(fn); fn(view, meta); return () => listeners.delete(fn); },
    navigate(action) { if (navigator.userActivation.isActive) send("NAVIGATE", { action }); },
    feedback(target_id) { if (navigator.userActivation.isActive) send("FEEDBACK_INTENT", { target_id }); },
  };
  addEventListener("message", ({ source, data }) => {
    if (source !== parent) return;
    if (data?.type === "THEME") { applyTheme(data.theme); return; }
    if (data?.type !== "DATA_UPDATE") return;
    ({ view, meta } = data);
    for (const fn of listeners) fn(view, meta);
    rendered();
  });
  addEventListener("error", () => send("ERROR"));
  addEventListener("unhandledrejection", () => send("ERROR"));
  addEventListener("DOMContentLoaded", () => {
    send("READY");
    rendered();
    new ResizeObserver(rendered).observe(document.body);
  }, { once: true });
}

const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

export function buildNarratorSrcdoc(template, view, meta, theme) {
  const payload = JSON.stringify({ view, meta, theme }).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script type="application/json" id="narrator-data">${payload}</script><script>(${narratorBootstrap.toString()})();</script>${template}`;
}

export function frameDataUrl(response) {
  const data = response?.data_url;
  const mime = response?.mime;
  if (!response?.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime)
    || !Number.isSafeInteger(response.size) || response.size < 1 || response.size > 8 * 1024 * 1024
    || typeof data !== "string" || !data.startsWith(`data:${mime};base64,`)) return null;
  const encoded = data.slice(data.indexOf(",") + 1);
  if (encoded.length !== Math.ceil(response.size / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const padding = (3 - response.size % 3) % 3;
  return (encoded.match(/=*$/)?.[0].length === padding) ? data : null;
}

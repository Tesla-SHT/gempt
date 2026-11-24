import { tr } from '../magpie_plugin/ui/i18n.js';
import { createHttpTransport } from "../magpie_plugin/ui/http.js";
import { mountLive } from "./live-ui.js";

function mountSidecar() {
  const bridge = window.sidecar;
  const params = new URLSearchParams(location.search);
  const conversationId = bridge?.conversationId || params.get("conversationId");
  const token = params.get("token");
  const opaque = self.origin === "null";
  const fetchPage = !opaque && bridge?.fetch ? bridge.fetch.bind(bridge) : fetch;
  let workspaceUris;
  const sidecar = {
    ui: bridge?.ui,
    onWorkspaceChange(listener) {
      bridge?.onWorkspaceChange?.((uris) => {
        workspaceUris = uris;
        listener(uris);
      });
    },
  };
  const transport = createHttpTransport(null, async (path, { signal, body }) => {
    const timeout = AbortSignal.timeout(15_000);
    if (opaque && !token) throw new Error(tr("侧栏缺少鉴权令牌，请重新打开侧栏。"));
    // The SDK accepts its query token and parses JSON from a plain-text body.
    // An opaque frame cannot send the token header through a CORS preflight.
    return fetchPage(opaque ? `./api?${new URLSearchParams({ token })}` : "./api", {
      method: "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: opaque ? { "Content-Type": "text/plain" } : {
        "Content-Type": "application/json", ...(!bridge?.fetch && token ? { "X-Sidecar-Token": token } : {}),
      },
      body: JSON.stringify({ path, body: body === undefined ? undefined : JSON.parse(body), conversationId,
        workspaceUris: path.startsWith("./api/live/") ? workspaceUris : undefined }),
    });
  });
  mountLive({ transport, sidecar });
}

if (document.documentElement.hasAttribute("data-sidecar")) {
  try {
    mountSidecar();
  } catch (error) {
    console.error(tr("GemPT 侧栏启动失败"), error);
    const notice = document.getElementById("list-error");
    notice.textContent = tr("GemPT 侧栏启动失败：{0}", error.message);
    notice.hidden = false;
    document.getElementById("list-loading").hidden = true;
    document.getElementById("list-wrap").setAttribute("aria-busy", "false");
  }
} else {
  const apiKey = document.querySelector('meta[name="gempt-key"]')?.content;
  const transport = createHttpTransport(apiKey);
  if (apiKey) {
    if (self.origin === 'null') transport.installPage = new URL('.', location.href).href;
    else transport.installAgy = () => transport.runAction('install_agy');
  }
  mountLive({ transport });
}

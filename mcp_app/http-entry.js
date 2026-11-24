import { createHttpTransport } from "../magpie_plugin/ui/http.js";
import { mountLive } from "./live-ui.js";

const sidecar = window.sidecar;
const apiKey = document.querySelector('meta[name="gempt-key"]')?.content;
let transport;
if (sidecar) {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const conversationId = sidecar.conversationId || params.get("conversationId");
  transport = createHttpTransport(null, async (path, { signal, body }) => {
    const workspaceUris = path.startsWith("./api/live/") ? await sidecar.getWorkspaceUris() : undefined;
    return sidecar.fetch("./api", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", ...(token ? { "x-sidecar-token": token } : {}) },
      body: JSON.stringify({ path, ...(body === undefined ? {} : { body: JSON.parse(body) }), conversationId, workspaceUris }),
    });
  });
} else {
  transport = createHttpTransport(apiKey);
}
mountLive({ transport, sidecar });

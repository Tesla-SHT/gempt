import { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { createConsoleTransport } from "./console-transport.js";
import { mountLive } from "./live-ui.js";

const app = new App({ name: "GemPT", version: "1.0.0" }, {});
const fileResult = z.object({ isError: z.boolean().optional() }).passthrough();

async function call(name, args, { signal, timeout = 15_000 } = {}) {
  const result = await app.callServerTool({ name, arguments: args }, { signal, timeout });
  const data = result.structuredContent;
  if (result.isError || !data) {
    throw Object.assign(new Error(data?.error || result.content?.find((item) => item.type === "text")?.text || "GemPT 暂无可用数据"),
      { status: data?.status, data });
  }
  return data;
}

mountLive({
  transport: createConsoleTransport(call),
  host: {
    onContext: (listener) => { app.onhostcontextchanged = listener; },
    onToolResult: (listener) => { app.ontoolresult = listener; },
    getContext: () => app.getHostContext(),
    getCapabilities: () => app.getHostCapabilities(),
    connect: () => app.connect(undefined, { timeout: 10_000 }),
    updateModelContext: (...args) => app.updateModelContext(...args),
    sendMessage: (...args) => app.sendMessage(...args),
    async openLink(target) {
      if (target.kind === "file") {
        const result = await app.request({
          method: "com.google.antigravity/toggle-aux-pane",
          params: { tabType: "fileView", uri: target.value },
        }, fileResult, { timeout: 3000 });
        if (result.isError) throw new Error("File preview rejected");
        return;
      }
      if (!app.getHostCapabilities()?.openLinks) throw new Error("Opening links is unavailable");
      const result = await app.openLink({ url: target.value }, { timeout: 3000 });
      if (result.isError) throw new Error("Link rejected");
    },
  },
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNarratorSrcdoc, frameDataUrl } from "../mcp_app/narrator-bootstrap.js";
import {
  BOARD_WINDOW, boardGroup, historyQuery, memberGroups, normalizeMessage, selectBoardRows,
  snapshotQuery, unreadBoundary,
} from "../mcp_app/swarm-view-state.js";
import { graphSnapshot, replayDelay } from "../mcp_app/swarm-visuals.js";
import { groupWorkersByThreads } from "../mcp_app/swarm-ui.js";

const readSource = (file) => readFileSync(new URL(`../mcp_app/${file}`, import.meta.url), "utf8");
const template = readSource("index.html");

function message(seq, props = {}) {
  return normalizeMessage({ seq, agent: "editor", channel: "main", time: "2026-11-26T18:00:00Z", text: "Status", ...props });
}

test("Swarm markup exposes five linked tabs without a compact branch", () => {
  const panel = template.slice(template.indexOf('<main id="swarm-panel"'), template.indexOf("<!-- CONSOLE MARKUP -->"));
  const tabs = [...panel.matchAll(/id="swarm-subtab-([^"]+)"[^>]*aria-controls="([^"]+)"/g)];
  assert.deepEqual(tabs.map(([, name]) => name), ["overview", "board", "members", "graph", "raw"]);
  for (const [, name, id] of tabs) {
    assert.match(panel, new RegExp(`id="${id}"[^>]*role="tabpanel"[^>]*aria-labelledby="swarm-subtab-${name}"`));
  }
  assert.doesNotMatch(panel, /swarm-single/);
  assert.match(panel, /swarm-reel[\s\S]*swarm-frame-preview/);
});

test("Board groups adjacent posts only through the ten-minute boundary", () => {
  const previous = message(1);
  assert.equal(boardGroup(previous, message(2, { time: "2026-11-26T18:10:00Z" })), true);
  assert.equal(boardGroup(previous, message(2, { time: "2026-11-26T18:10:01Z" })), false);
  assert.equal(boardGroup(previous, message(2, { agent: "reviewer" })), false);
  assert.equal(boardGroup(previous, message(2, { channel: "review" })), false);
  assert.equal(boardGroup(previous, message(2, { control: { type: "archive" } })), false);
});

test("unread divider skips own, control and historically unseen messages", () => {
  const messages = [message(15), message(18, { agent: "me" }),
    message(19, { control: {} }), message(24), message(30)];
  assert.equal(unreadBoundary(messages, { name: "me", last_read_seq: 15 }, [24]), 30);
  assert.equal(unreadBoundary(messages, { name: "me", last_read_seq: 30 }, []), null);
});

test("tail cursor carries absolute counts and citation paging works with sparse sequences", () => {
  const cursor = { etag: "6", head: 1200, known: 337, offset: 137, rosterKey: "r", viewKey: "view" };
  assert.deepEqual(snapshotQuery({ swarmId: "s", scope: "session", cursor }),
    { swarm_id: "s", scope: "session", etag: "6", omitRaw: 1, tail: 1, since: 1200, known: 337, rosterKey: "r", viewKey: "view" });
  assert.deepEqual(historyQuery("s", cursor, 601, 17),
    { swarm_id: "s", before: 137, beforeSeq: 601, limit: BOARD_WINDOW, rosterKey: "r", fromSeq: 17 });
  const posts = Array.from({ length: 400 }, (_, i) => message(i * 3 + 2));
  assert.equal(selectBoardRows(posts, BOARD_WINDOW, null).length, 200);
  assert.equal(selectBoardRows(posts, BOARD_WINDOW, null)[0].seq, 602);
  assert.ok(selectBoardRows(posts, BOARD_WINDOW, 17).some(({ seq }) => seq === 17));
});

test("Members group runtime states and plan tasks retain their owners", () => {
  const members = [{ state: "waiting_reply", name: "verifier" }, { state: "killed", name: "old" },
    { state: "working", name: "coordinator", role: "coordinator" }, { state: "stopped", name: "editor" }];
  const groups = memberGroups(members);
  assert.deepEqual(groups.active.map(m => m.name), ["coordinator", "verifier"]);
  assert.deepEqual(groups.waiting.map(m => m.name), ["editor"]);
  assert.deepEqual(groups.killed.map(m => m.name), ["old"]);
  const work = groupWorkersByThreads([{ id: "review", tasks: ["verifier"] }], members);
  assert.deepEqual(work[0].workers.map(m => m.name), ["verifier"]);
});

test("Graph retains direct mentions, broadcasts and replay timing", () => {
  const overview = { swarm: { id: "demo" }, channels: [], roster: [
    { name: "editor", state: "waiting", role: "worker" }, { name: "verifier", state: "working", role: "worker" },
  ] };
  const graph = graphSnapshot(overview, [
    message(1, { text: "@verifier please check" }),
    message(5, { text: "@all updated", time: "2026-11-26T18:00:02Z" }),
  ]);
  assert.deepEqual(graph.members.map(member => member.name), ["coordinator", "editor", "verifier"]);
  assert.deepEqual(graph.messages[0].mentions, ["verifier"]);
  assert.equal(graph.messages[1].all, true);
  assert.ok(replayDelay(graph.messages, 1, false, 1) > replayDelay(graph.messages, 1, false, 2));
});

test("Narrator srcdoc isolates network and escapes script-closing data", () => {
  const srcdoc = buildNarratorSrcdoc("<p>Custom view</p>", { headline: "</script><script>alert(1)</script>" }, { head: 9 });
  assert.match(srcdoc, /connect-src 'none'; frame-src 'none'/);
  assert.match(srcdoc, /DATA_UPDATE/);
  assert.match(srcdoc, /FEEDBACK_INTENT/);
  assert.doesNotMatch(srcdoc, /<script>alert\(1\)<\/script>/);
  assert.match(srcdoc, /<p>Custom view<\/p>/);
});

test("frame data URLs accept scoped raster formats with an exact decoded size", () => {
  const data = { ok: true, mime: "image/png", size: 1, data_url: "data:image/png;base64,AA==" };
  assert.equal(frameDataUrl(data), data.data_url);
  assert.equal(frameDataUrl({ ...data, size: 2 }), null);
  assert.equal(frameDataUrl({ ...data, data_url: "https://example.com/image.png" }), null);
  assert.equal(frameDataUrl({ ...data, mime: "image/svg+xml" }), null);
});

test("bundle inputs include scoped styles and the inline narrator bootstrap", () => {
  const build = readSource("build.mjs");
  assert.match(build, /\[styles, swarmCss, hiveCss, consoleCss\]\.join/);
  assert.match(readSource("swarm.css"), /#swarm-panel\s*\{/);
  assert.match(readSource("hive.css"), /^#swarm-panel\s*\{/);
  assert.match(readSource("swarm-ui.js"), /from "\.\/narrator-bootstrap\.js"/);
  const bundleDir = process.env.GEMPT_TEST_BUILT_UI
    ? pathToFileURL(resolve(process.env.GEMPT_TEST_BUILT_UI) + "/")
    : new URL("../core/assets/http-ui/", import.meta.url);
  const html = readFileSync(new URL("index.html", bundleDir), "utf8");
  const css = readFileSync(new URL("styles.css", bundleDir), "utf8");
  const js = readFileSync(new URL("app.js", bundleDir), "utf8");
  for (const [, name] of template.matchAll(/id="swarm-subtab-([^"]+)"/g)) {
    const button = html.match(new RegExp(`<button\\b[^>]* id="swarm-subtab-${name}"[^>]*>`))?.[0];
    assert.ok(button, name);
    assert.equal(/\shidden(?=[\s>])/.test(button), name === "raw", name);
  }
  assert.doesNotMatch(html, /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy/i);
  assert.match(css, /#swarm-panel\s*\{\s*#swarm-hive-view/);
  assert.match(js, /FEEDBACK_INTENT/);
});

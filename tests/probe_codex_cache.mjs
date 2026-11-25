// Run explicitly with an installed Codex CLI. All model traffic goes to the loopback fixture.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runAppServer } from '../magpie_plugin/lib/app-server-run.mjs';
import { startServer } from '../magpie_plugin/lib/server.mjs';

test('installed Codex streams solo, independent swarm workers and two native forks through the resident proxy', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gempt-codex-transport-'));
  const configPath = join(root, 'config.json');
  const sessionsDir = join(root, 'sessions');
  const env = { ...process.env, CODEX_HOME: join(root, 'codex'), GEMPT_APP_SERVER_STATE: join(root, 'state.json') };
  mkdirSync(env.CODEX_HOME);
  mkdirSync(sessionsDir);
  const calls = [];
  let upgrades = 0;
  const gateway = createServer(async (req, res) => {
    if (req.url !== '/v1/responses') return res.end('{"data":[]}');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    calls.push({ key: data.prompt_cache_key, session: req.headers['session-id'] ?? req.headers.session_id,
      method: req.method, stream: data.stream, auth: req.headers.authorization });
    const id = 'resp_' + calls.length;
    const item = { type: 'message', id: 'msg_' + calls.length, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'probe OK' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'probe OK' },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item] } },
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  gateway.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 426 Upgrade Required\r\n\r\n'); });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = 'http://127.0.0.1:' + gateway.address().port;
  writeFileSync(configPath, JSON.stringify({ magpie: { base_url: gatewayUrl, api_key: 'loopback-test' } }));
  let resident;
  t.after(async () => {
    await resident?.close();
    await new Promise((resolve) => gateway.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  resident = await startServer({ port: 0, configPath, sessionsDir, manageAppServer: true,
    appServerOptions: { env, port: 0, healthIntervalMs: 0 } });
  const status = await resident.appServer.ensureRunning();
  assert.ok(status.running, status.error);
  async function turn(name, swarmId, parentId) {
    const runFile = join(root, name, 'state.json');
    mkdirSync(dirname(runFile));
    writeFileSync(runFile, '{}');
    const result = await runAppServer({ configPath, env, sessionsDir, runFile, sessionId: 'exec-' + name,
      onIdentity() {}, prompt: 'Probe', cwd: root, model: 'codex/gpt-6.2-astra', effort: 'low',
      sandbox: 'read-only', approvalPolicy: 'never', gatewayUrl, timeoutSec: 25, swarmId, swarmAgent: name,
      nativeFork: parentId && { id: parentId, prompt: 'Fork probe' } });
    assert.equal(result.text, 'probe OK');
    if (parentId) assert.equal(result.forkMode, 'native');
    return result.threadId;
  }
  const solo = await turn('solo');
  const parent = await turn('alpha', 'sw');
  await turn('bravo', 'sw');
  const child = await turn('child', 'sw', parent);
  await turn('grandchild', 'sw', child);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].key, solo);
  assert.notEqual(calls[1].key, parent);
  assert.equal(new Set(calls.slice(1).map((c) => c.key)).size, 1);
  for (const c of calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.stream, true);
    assert.equal(c.session, c.key);
    assert.equal(c.auth, 'Bearer loopback-test');
  }
  assert.equal(upgrades, 0);
});

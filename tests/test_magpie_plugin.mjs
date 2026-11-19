import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, setDefaultSandbox, setDefaultTier } from '../magpie_plugin/lib/backend.mjs';
import { startServer } from '../magpie_plugin/lib/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function startMockMagpie(modelsData) {
  const payloadData = modelsData ?? [
    { id: 'codex/gpt-6.2-sol', owned_by: 'codex' },
    { id: 'codex/gpt-6.2-astra', owned_by: 'codex' },
    { id: 'auto/deepseek-v4.1-flash', owned_by: 'magpie', magpie_label: 'DeepSeek · routing group' },
    { id: 'group/gempt-harness-sonnet', owned_by: 'magpie' },
    { id: 'group/gempt-sonnet', owned_by: 'magpie' },
    { id: 'opencode-go/gemini-4-argon', owned_by: 'opencode-go' },
  ];

  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: payloadData }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

function rawHttpGet({ port, path, headers = {} }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolveReq({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', rejectReq);
    req.end();
  });
}

test('package.json Magpie manifest fields and plugin files exist', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, 'gempt-magpie-plugin');
  assert.equal(pkg.type, 'module');
  assert.ok(existsSync(join(REPO_ROOT, pkg.main)));
  assert.equal(pkg.magpie.name, 'GemPT');
  assert.equal(pkg.magpie.page.service.port, 3498);
  assert.ok(existsSync(join(REPO_ROOT, pkg.magpie.page.file)));
  assert.ok(existsSync(join(REPO_ROOT, pkg.magpie.page.icon)));
  assert.ok(Array.isArray(pkg.magpie.permissions));

  const launcherHtml = readFileSync(join(REPO_ROOT, pkg.magpie.page.file), 'utf-8');
  assert.match(launcherHtml, /_magpie\/bridge\.js/);
  assert.match(launcherHtml, /boot\.js/);
});

test('backend readState redacts secrets, reports subscription state, and persists tier & sandbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-magpie-backend-'));
  const magpie = await startMockMagpie();
  try {
    const cfgPath = join(dir, 'config.json');
    const sessDir = join(dir, 'sessions');
    mkdirSync(join(sessDir, 'runs', 'a'.repeat(32)), { recursive: true });

    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        magpie: { base_url: magpie.url, api_key: 'sk-super-secret-value' },
        codex: { default_sandbox: 'workspace-write' },
        routing_policy: {
          default_tier: 'opus',
          failover_mode: 'subscription_only',
          excluded_models: ['gemini-4-argon'],
        },
        tiers: {
          sonnet: { consult_model: 'codex/gpt-6.2-sol', reasoning_effort: 'medium' },
          opus: { consult_model: 'codex/gpt-6.2-sol', escalate_model: 'codex/gpt-6.2-astra', reasoning_effort: 'medium' },
          fable: { consult_model: 'codex/gpt-6.2-astra', reasoning_effort: 'high' },
        },
        utility: { model: 'auto/deepseek-v4.1-flash' },
      }),
      'utf-8',
    );

    writeFileSync(
      join(sessDir, 'consult-20261119-demo.json'),
      JSON.stringify({
        session_id: 'consult-20261119-demo',
        mode: 'consult',
        tier: 'opus',
        model: 'codex/gpt-6.2-sol',
        cwd: join(dir, 'repo'),
        turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
      }),
      'utf-8',
    );

    writeFileSync(
      join(sessDir, 'runs', 'a'.repeat(32), 'state.json'),
      JSON.stringify({
        run_id: 'a'.repeat(32),
        state: 'finished',
        cwd: join(dir, 'repo'),
        result: { tier: 'sonnet', model: 'codex/gpt-6.2-sol', verification: { status: 'passed' } },
      }),
      'utf-8',
    );

    const state = await readState({ configPath: cfgPath, sessionsDir: sessDir, probeTimeoutMs: 2000 });
    assert.equal(state.configured, true);
    assert.equal(state.features.api_fallback, false);
    assert.equal(state.subscription.connected, true);
    assert.equal(state.subscription.codex_count, 2);
    assert.equal(state.default_tier, 'opus');
    assert.equal(state.failover_mode, 'subscription_only');
    assert.equal(state.magpie.reachable, true);
    assert.equal(state.magpie.total_models, 5);
    assert.deepEqual(state.magpie.harness_groups, ['group/gempt-harness-sonnet']);
    assert.equal(state.recent_sessions.length, 1);
    assert.equal(state.recent_runs.length, 1);
    assert.equal(JSON.stringify(state).includes('sk-super-secret-value'), false);

    assert.equal(setDefaultTier('chore', { configPath: cfgPath }).status, 400);
    assert.equal(setDefaultTier('sonnet', { configPath: join(dir, 'missing.json') }).status, 404);
    assert.equal(setDefaultSandbox('invalid', { configPath: cfgPath }).status, 400);

    const tierOk = setDefaultTier('fable', { configPath: cfgPath });
    assert.equal(tierOk.ok, true);
    const sbxOk = setDefaultSandbox('danger-full-access', { configPath: cfgPath });
    assert.equal(sbxOk.ok, true);

    const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(saved.routing_policy.default_tier, 'fable');
    assert.equal(saved.codex.default_sandbox, 'danger-full-access');
    assert.equal(saved.magpie.api_key, 'sk-super-secret-value');
  } finally {
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('page server supports one-click subscription init, security checks, tier & sandbox updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-magpie-srv-'));
  const magpie = await startMockMagpie();
  const cfgPath = join(dir, 'config.json');

  const svc = await startServer({ port: 0, configPath: cfgPath, sessionsDir: join(dir, 'sessions') });
  const origin = `http://127.0.0.1:${svc.port}`;
  const prevMagpieAddr = process.env.MAGPIE_ADDR;
  process.env.MAGPIE_ADDR = magpie.url;

  try {
    const pingRes = await fetch(`${origin}/api/ping`);
    assert.equal(pingRes.status, 200);
    const pingJson = await pingRes.json();
    assert.equal(pingJson.ok, true);
    assert.equal(pingJson.service, 'gempt-magpie-plugin');

    const badHost = await rawHttpGet({ port: svc.port, path: '/api/ping', headers: { Host: 'evil.example:3498' } });
    assert.equal(badHost.status, 403);

    const badOrigin = await rawHttpGet({ port: svc.port, path: '/api/ping', headers: { Origin: 'http://evil.example' } });
    assert.equal(badOrigin.status, 403);

    const badFetchMode = await fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'cors' } });
    assert.equal(badFetchMode.status, 403);

    const unauthState = await fetch(`${origin}/api/state`);
    assert.equal(unauthState.status, 401);

    const pageRes = await rawHttpGet({ port: svc.port, path: '/', headers: { 'sec-fetch-mode': 'navigate' } });
    assert.equal(pageRes.status, 200);
    const html = pageRes.text;
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /id="init-sub-btn"/);
    const keyMatch = html.match(/<meta name="gempt-key" content="([^"]+)">/);
    assert.ok(keyMatch, 'expected injected gempt-key meta tag');
    const key = keyMatch[1];

    const stateUnconf = await (
      await fetch(`${origin}/api/state`, { headers: { Origin: 'null', 'x-gempt-key': key } })
    ).json();
    assert.equal(stateUnconf.configured, false);
    assert.equal(stateUnconf.features.api_fallback, false);
    assert.equal(stateUnconf.subscription.connected, true);

    const initRes = await fetch(`${origin}/api/init`, {
      method: 'POST',
      headers: { Origin: 'null', 'x-gempt-key': key },
    });
    assert.equal(initRes.status, 200);
    const initJson = await initRes.json();
    assert.equal(initJson.ok, true);
    assert.equal(existsSync(cfgPath), true);

    const createdCfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(createdCfg.routing_policy.failover_mode, 'subscription_only');
    assert.equal(createdCfg.tiers.sonnet.consult_model, 'codex/gpt-6.2-sol');
    assert.equal(createdCfg.tiers.fable.consult_model, 'codex/gpt-6.2-astra');

    const postTier = await fetch(`${origin}/api/tier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ tier: 'opus' }),
    });
    assert.equal(postTier.status, 200);

    const postSbxOk = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ default_sandbox: 'read-only' }),
    });
    assert.equal(postSbxOk.status, 200);
    assert.equal((await postSbxOk.json()).default_sandbox, 'read-only');

    const postSbxBad = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ default_sandbox: 'bogus' }),
    });
    assert.equal(postSbxBad.status, 400);

    const postFailoverRejected = await fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', 'x-gempt-key': key },
      body: JSON.stringify({ failover_mode: 'api_fallback' }),
    });
    assert.equal(postFailoverRejected.status, 400);

    const stateAfter = await (
      await fetch(`${origin}/api/state`, { headers: { 'x-gempt-key': key } })
    ).json();
    assert.equal(stateAfter.configured, true);
    assert.equal(stateAfter.default_tier, 'opus');
    assert.equal(stateAfter.default_sandbox, 'read-only');
  } finally {
    if (prevMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
    else process.env.MAGPIE_ADDR = prevMagpieAddr;
    await svc.close();
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/init rejects when Magpie has no Codex subscription models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gempt-magpie-nosub-'));
  const magpie = await startMockMagpie([{ id: 'openai/gpt-6.1-sol', owned_by: 'openai' }]);
  const cfgPath = join(dir, 'config.json');
  const prevMagpieAddr = process.env.MAGPIE_ADDR;
  process.env.MAGPIE_ADDR = magpie.url;

  const svc = await startServer({ port: 0, configPath: cfgPath, sessionsDir: join(dir, 'sessions') });
  const origin = `http://127.0.0.1:${svc.port}`;

  try {
    const pageRes = await rawHttpGet({ port: svc.port, path: '/', headers: { 'sec-fetch-mode': 'navigate' } });
    const key = pageRes.text.match(/<meta name="gempt-key" content="([^"]+)">/)[1];

    const initRes = await fetch(`${origin}/api/init`, {
      method: 'POST',
      headers: { Origin: 'null', 'x-gempt-key': key },
    });
    assert.equal(initRes.status, 400);
    assert.equal(existsSync(cfgPath), false);
  } finally {
    if (prevMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
    else process.env.MAGPIE_ADDR = prevMagpieAddr;
    await svc.close();
    await magpie.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

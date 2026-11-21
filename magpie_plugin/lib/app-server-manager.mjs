import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultGatewayFromEnv, expandUser, readJsonSafe, resolveConfigPath, resolveMagpieApiKey, resolveSessionsDir } from './backend.mjs';
import { appServerStatePath, connectAppServer, UNAVAILABLE } from './app-server-client.mjs';

const STRIPPED_ENV = ['CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'GEMPT_APP_SERVER_GATEWAY_TOKEN'];
const unavailable = (message, status) => Object.assign(new Error(message), { status });

function executable(candidates) {
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch { return false; }
  });
}

export function findCodexCli(configuredPath = '', env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const candidates = [configuredPath, env.CODEX_CLI_PATH, env.CODEX_BIN].filter(Boolean).flatMap((entry) => {
    const path = expandUser(entry);
    return [path, ...(basename(path) === path ? dirs.map((dir) => join(dir, path)) : [])];
  });
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1', 'codex'] : ['codex'];
  dirs.push(join(homedir(), '.local', 'bin'));
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
  const found = executable([...candidates, ...dirs.flatMap((dir) => names.map((name) => join(dir, name)))]);
  return found ? resolve(found) : '';
}

function invocation(cli, env) {
  if (process.platform !== 'win32' || !/\.(cmd|ps1|bat)$/i.test(cli)) return [cli];
  const directory = dirname(cli);
  const entry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const node = executable([join(directory, 'node.exe'), ...(env.PATH || env.Path || '').split(delimiter)
    .filter(Boolean).map((dir) => join(dir, 'node.exe'))]);
  if (!node || !existsSync(entry)) throw new Error('Cannot resolve the Codex npm wrapper to Node and @openai/codex/bin/codex.js.');
  return [node, entry];
}

function freePort(port) {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => {
      const picked = listener.address().port;
      listener.close(() => resolve(picked));
    });
  });
}

function atomicState(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function terminate(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.spawnfile) {
    // The npm Node shim has a Codex binary child. Windows SIGTERM alone kills only the shim.
    const systemDir = process.env.SystemRoot || 'C:/Windows';
    spawnSync(join(systemDir, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 3000 });
  } else child.kill();
}

export function createAppServerManager({
  configPath, env = process.env, port = Number(env.GEMPT_APP_SERVER_PORT || 0),
  spawnProcess = spawn, connect = connectAppServer, startupMs = 8000,
  backoffMs = [250, 500, 1000, 2000, 4000, 8000],
} = {}) {
  const config = resolveConfigPath(configPath);
  const stateFile = appServerStatePath(config, env);
  const lockFile = `${stateFile}.lock`;
  const tokenFile = `${stateFile}.${randomUUID()}.token`;
  const owner = `${process.pid} ${randomUUID()}`;
  let ownsLock = false;
  let child;
  let connection;
  let starting;
  let restart;
  let stopped = false;
  let failures = 0;
  let startedAt = 0;
  let error = null;
  let gatewayUrl = null;

  function claim() {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(lockFile, owner, { flag: 'wx', mode: 0o600 });
        ownsLock = true;
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let current;
        try { current = readFileSync(lockFile, 'utf8'); } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        if (!current || alive(Number(current.split(' ')[0]))) return false;
        // Multiple hosts may race during reload. A separate exclusive claim
        // elects one stale-lock cleaner and is released as soon as it exits.
        const recovery = `${lockFile}.recover`;
        try { writeFileSync(recovery, owner, { flag: 'wx', mode: 0o600 }); } catch (err) {
          if (err.code === 'EEXIST') return false;
          throw err;
        }
        try {
          if (readFileSync(lockFile, 'utf8') === current) unlinkSync(lockFile);
        } finally { unlinkSync(recovery); }
      }
    }
    return false;
  }

  function getStatus() {
    const shared = connection || (!ownsLock && readJsonSafe(stateFile));
    const running = shared?.status === 'running' && alive(shared.pid);
    return { running: Boolean(running), ws_url: running ? shared.ws_url : null,
      pid: running ? shared.pid : null, gateway_url: (running ? shared.gateway_url : gatewayUrl) || null,
      error: running ? null : error };
  }

  function retry() {
    if (stopped || restart) return;
    const delay = backoffMs[Math.min(failures++, backoffMs.length - 1)] ?? 8000;
    restart = setTimeout(() => {
      restart = undefined;
      void ensureRunning();
    }, delay);
    restart.unref?.();
  }

  function clearPublished(status) {
    if (!ownsLock) return;
    const current = connection || readJsonSafe(stateFile);
    atomicState(stateFile, { ws_url: null, auth_token: null, auth_header: 'Authorization', pid: null,
      port: current?.port ?? null, gateway_url: gatewayUrl, started_at: current?.started_at ?? null, status });
    connection = undefined;
  }

  async function start() {
    if (!ownsLock && !claim()) {
      // Another plugin host owns the app-server, including during its restart.
      retry();
      return;
    }
    const raw = readJsonSafe(config) || {};
    gatewayUrl = String(raw.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
    const stale = readJsonSafe(stateFile);
    if (stale?.status === 'running' && alive(stale.pid)) {
      // The plugin host can be terminated independently of its child.
      // Authenticate before adopting an existing listener.
      const probe = await connect(stale);
      probe.close();
      connection = stale;
      retry();
      return;
    }
    const cli = findCodexCli(raw.codex?.cli_path, env);
    if (!cli) throw new Error('未找到 Codex CLI，无法启动共享 app-server。');
    const picked = await freePort(port);
    if (stopped) return;
    const wsUrl = `ws://127.0.0.1:${picked}`;
    const token = randomBytes(32).toString('base64url');
    writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) if (STRIPPED_ENV.includes(key.toUpperCase())) delete childEnv[key];
    childEnv.NO_PROXY = childEnv.no_proxy = '127.0.0.1,localhost,::1';
    const [bin, ...prefix] = invocation(cli, env);
    const args = [...prefix, 'app-server', '--listen', wsUrl, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
      '-c', 'model_providers.gempt_gateway.name="Magpie"',
      '-c', 'model_providers.gempt_gateway.base_url=' + JSON.stringify(gatewayUrl + '/v1'),
      '-c', 'model_providers.gempt_gateway.wire_api="responses"', '-c', 'model_provider="gempt_gateway"'];
    const gatewayKey = resolveMagpieApiKey({ magpie: { ...raw.magpie, base_url: gatewayUrl } });
    if (gatewayKey) {
      childEnv.GEMPT_APP_SERVER_GATEWAY_TOKEN = gatewayKey;
      args.push('-c', 'model_providers.gempt_gateway.env_key="GEMPT_APP_SERVER_GATEWAY_TOKEN"');
    }
    const spawned = child = spawnProcess(bin, args, { cwd: homedir(), env: childEnv, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'] });
    startedAt = Date.now();
    let stderr = '';
    let startupError;
    spawned.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2048); });
    const exit = (message) => {
      if (child !== spawned) return;
      child = undefined;
      try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch { /* Retried on stop. */ }
      if (stopped) return;
      if (Date.now() - startedAt > 30000) failures = 0;
      startupError = error = message;
      try { clearPublished('stopped'); } catch { connection = undefined; }
      retry();
    };
    spawned.once('error', (err) => exit(err.message));
    spawned.once('exit', (code, signal) => exit(`Codex app-server exited (${signal || code}): ${stderr.trim().replaceAll(token, '[redacted]')}`));

    const next = { ws_url: wsUrl, auth_token: token, auth_header: 'Authorization', pid: spawned.pid,
      port: picked, gateway_url: gatewayUrl, started_at: new Date(startedAt).toISOString(), status: 'running' };
    while (!stopped && child === spawned && Date.now() - startedAt < startupMs) {
      let probe;
      try { probe = await connect(next, undefined, { timeoutMs: 450 }); } catch { /* Still starting. */ }
      if (probe) {
        probe.close();
        if (!stopped && child === spawned) {
          atomicState(stateFile, next);
          connection = next;
          error = null;
          unlinkSync(tokenFile);
        }
        return;
      }
      await sleep(60);
    }
    if (!stopped) throw new Error(startupError || 'Codex app-server startup timed out.');
  }

  function ensureRunning() {
    if (stopped) return Promise.resolve(getStatus());
    if (connection && alive(connection.pid)) {
      if (!child) retry();
      return Promise.resolve(getStatus());
    }
    if (restart) return Promise.resolve(getStatus());
    if (!starting) {
      starting = start().catch((err) => {
        error = err.message;
        terminate(child);
        if (!child && existsSync(tokenFile)) unlinkSync(tokenFile);
        retry();
      }).finally(() => { starting = undefined; });
    }
    return starting.then(getStatus);
  }

  async function interruptRun(runId, sessionsDir) {
    if (typeof runId !== 'string' || runId.length !== 32 || !/^[a-f0-9]+$/.test(runId)) {
      throw unavailable('invalid run_id', 400);
    }
    const run = readJsonSafe(join(resolveSessionsDir(sessionsDir), 'runs', runId, 'state.json'));
    if (!run) throw unavailable('run not found', 404);
    if (!['running', 'waiting_gemini'].includes(run.state) || !run.codex_thread_id || !run.turn_id
        || (run.deadline && Date.now() / 1000 > run.deadline)) throw unavailable('run has no active Codex turn', 409);
    const state = connection || readJsonSafe(stateFile);
    if (state?.status !== 'running') throw unavailable(UNAVAILABLE, 503);
    const rpc = await connect(state).catch((err) => { throw unavailable(err.message, 503); });
    try {
      await rpc.request('turn/interrupt', { threadId: run.codex_thread_id, turnId: run.turn_id });
      return { ok: true, run_id: runId, session_id: run.session_id, thread_id: run.codex_thread_id, turn_id: run.turn_id };
    } finally { rpc.close(); }
  }

  function cleanup() {
    if (!ownsLock) return;
    terminate(child);
    if (!child && connection?.status === 'running' && alive(connection.pid)) {
      // This was an authenticated orphan published by a former lock owner.
      const pid = connection.pid;
      if (process.platform === 'win32') {
        spawnSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', timeout: 3000 });
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch { /* Already exited. */ }
      }
    }
    clearPublished('stopped');
    if (existsSync(tokenFile)) unlinkSync(tokenFile);
    if (readFileSync(lockFile, 'utf8') === owner) unlinkSync(lockFile);
    ownsLock = false;
  }

  const atExit = () => { stopped = true; try { cleanup(); } catch { /* Process is exiting. */ } };
  process.once('exit', atExit);
  return { getStatus, ensureRunning, interruptRun, async stop() {
    stopped = true;
    clearTimeout(restart);
    await starting;
    process.off('exit', atExit);
    cleanup();
  } };
}

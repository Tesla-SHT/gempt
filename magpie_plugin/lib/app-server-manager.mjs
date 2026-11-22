import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultGatewayFromEnv, expandUser, readActiveRuns, readJsonSafe, resolveConfigPath, resolveMagpieApiKey } from './backend.mjs';
import { appServerStatePath, connectAppServer } from './app-server-client.mjs';
import { launchAppServer, matchesAppServerProcess, pidAlive, terminateAppServer } from './app-server-process.mjs';
import { interruptRun as interruptCoreRun } from '../../core/runs.mjs';

const STRIPPED_ENV = ['CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'GEMPT_APP_SERVER_GATEWAY_TOKEN'];

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

export function resolveCodexInvocation(cli, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|ps1|bat)$/i.test(cli)) return [cli];
  const directory = dirname(cli);
  const findNode = () => executable([join(directory, 'node.exe'), ...(env.PATH || env.Path || '').split(delimiter)
    .filter(Boolean).map((dir) => join(dir, 'node.exe'))]);
  const npmEntry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (existsSync(npmEntry)) {
    const node = findNode();
    if (node) return [node, npmEntry];
  }
  try {
    const shim = readFileSync(cli, 'utf8');
    const match = shim.match(/(?:%~dp0|%dp0%|\$basedir)[\\/]+([^\r\n"']+?\.(?:js|mjs|cjs|exe))/i);
    if (match?.[1]) {
      const target = resolve(directory, match[1].replaceAll('\\', '/'));
      if (existsSync(target)) {
        if (/\.exe$/i.test(target)) return [target];
        const node = findNode();
        if (node) return [node, target];
      }
    }
  } catch { /* Fall through to shell launcher. */ }
  if (/\.ps1$/i.test(cli)) {
    const ps = executable([join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
    if (ps) return [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cli];
  }
  const comspec = env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  if (/\.(cmd|bat)$/i.test(cli) && existsSync(comspec)) {
    return [comspec, '/d', '/s', '/c', cli];
  }
  throw new Error(`Cannot resolve the Windows Codex shim (${cli}) to Node, @openai/codex, or a shell launcher.`);
}

function invocation(cli, env) {
  return resolveCodexInvocation(cli, env, process.platform);
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
  return pidAlive(pid);
}

function terminate(child) {
  try { terminateAppServer(child); } catch { /* Best effort. */ }
}

function configFingerprint(url, key) {
  return createHash('sha256').update(`${url || ''}\0${key || ''}`).digest('hex').slice(0, 16);
}

export function createAppServerManager({
  configPath, sessionsDir, env = process.env, port = Number(env.GEMPT_APP_SERVER_PORT || 0),
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
        let claimedRecovery = false;
        for (let rAttempt = 0; rAttempt < 2; rAttempt++) {
          try {
            writeFileSync(recovery, owner, { flag: 'wx', mode: 0o600 });
            claimedRecovery = true;
            break;
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            let recInfo;
            try {
              const recContent = readFileSync(recovery, 'utf8');
              const recStat = statSync(recovery);
              const recPid = Number(recContent.split(' ')[0]);
              recInfo = { stale: !alive(recPid) || (Date.now() - recStat.mtimeMs > 5000) };
            } catch (readErr) {
              if (readErr.code === 'ENOENT') continue;
              return false;
            }
            if (!recInfo.stale) return false;
            try { unlinkSync(recovery); } catch (uErr) { if (uErr.code !== 'ENOENT') return false; }
          }
        }
        if (!claimedRecovery) return false;
        try {
          if (readFileSync(lockFile, 'utf8') === current) unlinkSync(lockFile);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        } finally {
          try { unlinkSync(recovery); } catch {}
        }
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

  let lastProbeAt = 0;

  function currentGatewayConfig() {
    const raw = readJsonSafe(config) || {};
    const url = String(raw.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
    const key = resolveMagpieApiKey({ magpie: { ...raw.magpie, base_url: url } });
    return { raw, url, key, hash: configFingerprint(url, key) };
  }

  async function probeConnection(target, timeoutMs = 800) {
    try {
      const probe = await connect(target, undefined, { timeoutMs });
      probe.close();
      lastProbeAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  async function start() {
    if (!ownsLock && !claim()) {
      // Another plugin host owns the app-server, including during its restart.
      retry();
      return;
    }
    const { raw, url, key: gatewayKey, hash: cfgHash } = currentGatewayConfig();
    gatewayUrl = url;
    const stale = readJsonSafe(stateFile);
    if (stale?.status === 'running' && alive(stale.pid)) {
      const hasActive = (() => { try { return readActiveRuns(sessionsDir).length > 0; } catch { return false; } })();
      const configMatches = !stale.config_hash || stale.config_hash === cfgHash;
      if ((configMatches || hasActive) && await probeConnection(stale, 1500)) {
        connection = stale;
        error = null;
        retry();
        return;
      }
      // Stale/wedged listener or outdated gateway config with no active runs: recycle cleanly.
      if (!hasActive) {
        const verified = !stale.process_marker || await matchesAppServerProcess(stale.pid, stale.process_marker);
        if (verified) terminate({ pid: stale.pid });
        clearPublished('stopped');
      }
    }
    const cli = findCodexCli(raw.codex?.cli_path, env);
    if (!cli) {
      error = '未找到 Codex CLI，共享 app-server 未启动。gempt_ask 与 Magpie 原生路由组仍可使用。';
      cleanup();
      return;
    }
    const maxBindAttempts = port === 0 ? 3 : 1;
    let lastStartupError;
    for (let bindAttempt = 0; bindAttempt < maxBindAttempts; bindAttempt++) {
      const picked = await freePort(port);
      if (stopped) return;
      const wsUrl = `ws://127.0.0.1:${picked}`;
      const token = randomBytes(32).toString('base64url');
      try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch {}
      writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
      const childEnv = { ...env };
      for (const key of Object.keys(childEnv)) if (STRIPPED_ENV.includes(key.toUpperCase())) delete childEnv[key];
      childEnv.NO_PROXY = childEnv.no_proxy = '127.0.0.1,localhost,::1';
      const [bin, ...prefix] = invocation(cli, env);
      const args = [...prefix, 'app-server', '--listen', wsUrl, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
        '-c', 'model_providers.gempt_gateway.name="Magpie"',
        '-c', 'model_providers.gempt_gateway.base_url=' + JSON.stringify(gatewayUrl + '/v1'),
        '-c', 'model_providers.gempt_gateway.wire_api="responses"', '-c', 'model_provider="gempt_gateway"'];
      if (gatewayKey) {
        childEnv.GEMPT_APP_SERVER_GATEWAY_TOKEN = gatewayKey;
        args.push('-c', 'model_providers.gempt_gateway.env_key="GEMPT_APP_SERVER_GATEWAY_TOKEN"');
      }
      const spawnOpts = { cwd: homedir(), env: childEnv, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'] };
      const spawned = child = spawnProcess === spawn
        ? await launchAppServer(bin, args, spawnOpts)
        : spawnProcess(bin, args, spawnOpts);
      spawned.unref?.();
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
      spawned.once?.('error', (err) => exit(err.message));
      spawned.once?.('exit', (code, signal) => exit(`Codex app-server exited (${signal || code}): ${stderr.trim().replaceAll(token, '[redacted]')}`));

      const next = { ws_url: wsUrl, auth_token: token, auth_header: 'Authorization', pid: spawned.pid,
        port: picked, gateway_url: gatewayUrl, config_hash: cfgHash, process_marker: basename(tokenFile),
        started_at: new Date(startedAt).toISOString(), status: 'running' };
      while (!stopped && child === spawned && Date.now() - startedAt < startupMs) {
        if (!spawned.once && !alive(spawned.pid)) {
          startupError = 'Codex app-server exited during startup.';
          break;
        }
        if (await probeConnection(next, 450)) {
          if (!stopped && child === spawned) {
            atomicState(stateFile, next);
            connection = next;
            error = null;
            try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch {}
            if (!spawned.once) retry();
          }
          return;
        }
        await sleep(60);
      }
      if (stopped) return;
      terminate(spawned);
      child = undefined;
      try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch {}
      lastStartupError = startupError || 'Codex app-server startup timed out.';
      const bindCollision = /EADDRINUSE|address already in use|10048/i.test(lastStartupError);
      if (bindAttempt + 1 < maxBindAttempts && bindCollision) {
        clearTimeout(restart);
        restart = undefined;
        continue;
      }
      throw new Error(lastStartupError);
    }
  }

  async function ensureRunning({ probe = false } = {}) {
    if (stopped) return getStatus();
    if (connection && alive(connection.pid)) {
      const { hash: wantHash } = currentGatewayConfig();
      const configChanged = Boolean(connection.config_hash && connection.config_hash !== wantHash);
      const shouldProbe = probe || (!child?.once && Date.now() - lastProbeAt > 30_000);
      let healthy = true;
      if (shouldProbe) healthy = await probeConnection(connection, 800);
      if (!healthy) {
        error = 'Codex app-server unresponsive; restarting automatically.';
        cleanup({ preserveActive: false });
        clearTimeout(restart);
        restart = undefined;
      } else if (configChanged) {
        let hasActive = false;
        try { hasActive = readActiveRuns(sessionsDir).length > 0; } catch {}
        if (!hasActive) {
          cleanup({ preserveActive: false });
          clearTimeout(restart);
          restart = undefined;
        } else {
          return getStatus();
        }
      } else {
        if (!child || !child.once) retry();
        return getStatus();
      }
    }
    if (restart && !probe) return getStatus();
    if (probe && restart) {
      clearTimeout(restart);
      restart = undefined;
    }
    if (!starting) {
      starting = start().catch((err) => {
        error = err.message;
        terminate(child);
        child = undefined;
        if (existsSync(tokenFile)) { try { unlinkSync(tokenFile); } catch {} }
        retry();
      }).finally(() => { starting = undefined; });
    }
    await starting;
    return getStatus();
  }

  async function restartService({ force = false } = {}) {
    if (stopped) return { ok: false, status: 503, error: 'Codex app-server manager is stopped.' };
    let active = [];
    try { active = readActiveRuns(sessionsDir); } catch { /* Best effort. */ }
    if (active.length > 0 && !force) {
      return {
        ok: false,
        status: 409,
        active_runs: active.length,
        error: `当前有 ${active.length} 个正在运行的 Codex 任务，请等待完成或确认强制重启。`,
      };
    }
    clearTimeout(restart);
    restart = undefined;
    failures = 0;
    if (starting) await starting;
    const prev = connection || readJsonSafe(stateFile);
    if (ownsLock) {
      cleanup({ preserveActive: false });
    } else if (prev?.status === 'running' && alive(prev.pid)) {
      const verified = !prev.process_marker || await matchesAppServerProcess(prev.pid, prev.process_marker);
      if (verified) terminate({ pid: prev.pid });
    }
    const status = await ensureRunning({ probe: true });
    if (!status.running) {
      return { ok: false, status: 500, error: status.error || 'Codex app-server 重启失败。', app_server: status };
    }
    return { ok: true, status: 200, app_server: status };
  }

  function interruptRun(runId, sessionsDir) {
    return interruptCoreRun(runId, { sessionsDir, connect, getState: () => connection || readJsonSafe(stateFile) });
  }

  function cleanup({ preserveActive = false } = {}) {
    if (!ownsLock) return;
    if (preserveActive && connection?.status === 'running' && alive(connection.pid)) {
      let hasActive = false;
      try { hasActive = readActiveRuns(sessionsDir).length > 0; } catch { /* Best effort. */ }
      if (hasActive || child?.detachedOutOfJob) {
        // Let the reloaded plugin host adopt the live app-server without dropping active turns.
        if (existsSync(tokenFile)) { try { unlinkSync(tokenFile); } catch {} }
        try { if (readFileSync(lockFile, 'utf8') === owner) unlinkSync(lockFile); } catch {}
        ownsLock = false;
        return;
      }
    }
    const prevChild = child;
    terminate(prevChild);
    child = undefined;
    if (!prevChild && connection?.status === 'running' && alive(connection.pid)) {
      terminate({ pid: connection.pid });
    }
    clearPublished('stopped');
    if (existsSync(tokenFile)) { try { unlinkSync(tokenFile); } catch {} }
    try { if (readFileSync(lockFile, 'utf8') === owner) unlinkSync(lockFile); } catch {}
    ownsLock = false;
  }

  const atExit = () => { stopped = true; try { cleanup({ preserveActive: true }); } catch { /* Process is exiting. */ } };
  process.once('exit', atExit);
  return { getStatus, ensureRunning, restart: restartService, interruptRun, async stop() {
    stopped = true;
    clearTimeout(restart);
    await starting;
    process.off('exit', atExit);
    cleanup();
  } };
}

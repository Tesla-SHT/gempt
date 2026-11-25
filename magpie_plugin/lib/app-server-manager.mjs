import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readActiveRuns } from './activity.mjs';
import { defaultGatewayFromEnv, resolveMagpieApiKey } from '../../core/magpie.mjs';
import { appServerStatePath, connectAppServer } from './app-server-client.mjs';
import { launchAppServer, matchesAppServerProcess, pidAlive, terminateAppServer, waitForProcessExit } from './app-server-process.mjs';
import { codexAppServerExtraArgs, readJsonSafe, resolveConfigPath } from '../../core/config.mjs';
import { findExecutable, resolveExecutableInvocation } from '../../core/runners/detect.mjs';
import { interruptRun as interruptCoreRun } from '../../core/runs.mjs';

const STRIPPED_ENV = ['CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'GEMPT_APP_SERVER_GATEWAY_TOKEN'];

export function findCodexCli(configuredPath = '', env = process.env, { platform = process.platform, home = homedir(), systemDirs } = {}) {
  return findExecutable({
    configuredPath,
    envVars: ['CODEX_CLI_PATH', 'CODEX_BIN'],
    binaryNames: ['codex'],
    env,
    platform,
    home,
    systemDirs,
  });
}

export function resolveCodexInvocation(cli, env = process.env, platform = process.platform) {
  return resolveExecutableInvocation(cli, {
    env,
    platform,
    npmEntryRelative: join('node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  });
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

function configFingerprint(url, key, cli, extraArgs) {
  return createHash('sha256').update(`${url || ''}\0${key || ''}`).update(cli || extraArgs.length ? JSON.stringify([cli, extraArgs]) : '').digest('hex').slice(0, 16);
}

export function resolveProxyTarget(raw) {
  const url = String(raw?.magpie?.base_url || defaultGatewayFromEnv()).replace(/\/+$/, '');
  const key = resolveMagpieApiKey({ magpie: { ...raw?.magpie, base_url: url } });
  return { url, key };
}

function instanceSignature(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.instance_id === 'string' && rec.instance_id) return rec.instance_id;
  if (!rec.pid && !rec.auth_token && !rec.started_at) return null;
  return `${rec.pid ?? ''}:${rec.auth_token ?? ''}:${rec.started_at ?? ''}`;
}

export function createAppServerManager({
  configPath, sessionsDir, env = process.env, port = Number(env.GEMPT_APP_SERVER_PORT || 0),
  observeOnly = false,
  proxyBaseUrl, proxyToken, onProxyTarget,
  spawnProcess = spawn, connect = connectAppServer, startupMs = 8000,
  backoffMs = [250, 500, 1000, 2000, 4000, 8000],
  healthIntervalMs = 30_000,
  restartTimeoutMs = Math.max(startupMs, 5000),
  verifyProcess = matchesAppServerProcess,
  terminateProcess = terminateAppServer,
  waitForExit = waitForProcessExit,
  isPidAlive = pidAlive,
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
  let healthTimer;
  let stopped = false;
  let failures = 0;
  let startedAt = 0;
  let error = null;
  let gatewayUrl = null;
  let lastProbeAt = 0;
  let probeHealthy = null;
  let probeTargetSig = null;
  let degradedReason = null;

  const alive = (pid) => isPidAlive(pid);
  const terminate = (target) => {
    try { terminateProcess(target); } catch { /* Best effort. */ }
  };

  function clearHealthTimer() {
    if (healthTimer) {
      clearTimeout(healthTimer);
      healthTimer = undefined;
    }
  }

  function scheduleHealthCheck() {
    if (stopped || healthTimer || !ownsLock || !connection || !(healthIntervalMs > 0)) return;
    healthTimer = setTimeout(() => {
      healthTimer = undefined;
      if (!stopped) void ensureRunning({ probe: true });
    }, healthIntervalMs);
    healthTimer.unref?.();
  }

  function publishHealth(healthy, reason = null) {
    probeHealthy = healthy;
    probeTargetSig = instanceSignature(connection);
    degradedReason = healthy ? null : (reason || 'Codex app-server unresponsive.');
    error = healthy ? null : degradedReason;
    if (ownsLock && connection) {
      const nextErr = healthy ? null : degradedReason;
      if (connection.healthy !== healthy || (connection.error ?? null) !== nextErr) {
        connection = { ...connection, healthy, error: nextErr };
        try { atomicState(stateFile, connection); } catch { /* Best effort. */ }
      }
    }
  }

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
    const processAlive = Boolean(shared?.status === 'running' && alive(shared.pid));
    const sig = instanceSignature(shared);
    const localUnhealthy = probeHealthy === false && (!probeTargetSig || probeTargetSig === sig);
    const degraded = processAlive && (localUnhealthy || shared?.healthy === false);
    const healthy = processAlive && !degraded;
    const running = healthy;
    const statusError = degraded
      ? ((localUnhealthy ? degradedReason : null) || shared?.error || error || 'Codex app-server unresponsive.')
      : (running ? null : error);
    return {
      running,
      healthy,
      degraded,
      ws_url: processAlive ? shared.ws_url : null,
      pid: processAlive ? shared.pid : null,
      gateway_url: (processAlive ? shared.gateway_url : gatewayUrl) || null,
      error: statusError,
    };
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
      port: current?.port ?? null, gateway_url: gatewayUrl, started_at: current?.started_at ?? null,
      instance_id: null, healthy: false, error, status });
    connection = undefined;
    probeHealthy = null;
    probeTargetSig = null;
    degradedReason = null;
  }

  function currentGatewayConfig() {
    const raw = readJsonSafe(config) || {};
    const { url, key } = resolveProxyTarget(raw);
    const cliPath = raw.execution?.cli_paths?.codex || raw.codex?.cli_path;
    const extraArgs = codexAppServerExtraArgs(raw.codex?.extra_args);
    const hash = configFingerprint(proxyBaseUrl ? JSON.stringify([url, proxyBaseUrl, proxyToken]) : url,
      key, cliPath, extraArgs);
    onProxyTarget?.({ url, key });
    return { cliPath, url, key, extraArgs, hash };
  }

  async function probeConnection(target, timeoutMs = 800) {
    try {
      const probe = await connect(target, undefined, { timeoutMs });
      probe.close();
      lastProbeAt = Date.now();
      return true;
    } catch {
      lastProbeAt = Date.now();
      return false;
    }
  }

  async function start() {
    const { cliPath, url, key: gatewayKey, extraArgs, hash: cfgHash } = currentGatewayConfig();
    gatewayUrl = url;
    if (!ownsLock && !claim()) {
      // Another plugin host owns the app-server, including during its restart.
      retry();
      return;
    }
    const stale = readJsonSafe(stateFile);
    if (stale?.status === 'running' && alive(stale.pid)) {
      const configMatches = (!proxyBaseUrl && !stale.config_hash) || stale.config_hash === cfgHash;
      const staleHealthy = await probeConnection(stale, 1500);
      if (configMatches && staleHealthy) {
        connection = { ...stale, healthy: true, error: null };
        publishHealth(true, null);
        scheduleHealthCheck();
        return;
      }
      if (readActiveRuns(sessionsDir).length) {
        connection = stale;
        if (!staleHealthy) {
          publishHealth(false, 'Codex app-server unresponsive; waiting for active runs to finish before restarting.');
        } else {
          publishHealth(true, null);
        }
        scheduleHealthCheck();
        return;
      }
      const verified = !stale.process_marker || await verifyProcess(stale.pid, stale.process_marker);
      if (verified) {
        terminate({ pid: stale.pid });
        if (stale.pid !== process.pid && alive(stale.pid)) {
          await waitForExit(stale.pid, { timeoutMs: 2000, forceKillAfterMs: 1200 });
        }
      }
      clearPublished('stopped');
    }
    const cli = findCodexCli(cliPath, env);
    if (!cli) {
      error = '未找到 Codex CLI，共享 app-server 未启动。gempt_ask 仍可使用。';
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
      const args = [...prefix, 'app-server', ...extraArgs, '--listen', wsUrl, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
        '-c', 'model_providers.gempt_gateway.name="Magpie"',
        '-c', 'model_providers.gempt_gateway.base_url=' + JSON.stringify(proxyBaseUrl || gatewayUrl + '/v1'),
        '-c', 'model_providers.gempt_gateway.wire_api="responses"', '-c', 'model_provider="gempt_gateway"'];
      if (proxyBaseUrl) {
        args.push('-c', 'model_providers.gempt_gateway.supports_websockets=false');
      }
      if (proxyToken || gatewayKey) {
        childEnv.GEMPT_APP_SERVER_GATEWAY_TOKEN = proxyToken || gatewayKey;
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
        clearHealthTimer();
        try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch { /* Retried on stop. */ }
        if (stopped) return;
        if (Date.now() - startedAt > 30000) failures = 0;
        for (const secret of [token, proxyToken, gatewayKey]) {
          if (secret) message = message.replaceAll(secret, '[redacted]');
        }
        startupError = error = message;
        try { clearPublished('stopped'); } catch { connection = undefined; }
        retry();
      };
      spawned.once?.('error', (err) => exit(err.message));
      spawned.once?.('exit', (code, signal) => exit(`Codex app-server exited (${signal || code}): ${stderr.trim()}`));

      const next = {
        ws_url: wsUrl,
        auth_token: token,
        auth_header: 'Authorization',
        pid: spawned.pid,
        port: picked,
        gateway_url: gatewayUrl,
        ...(proxyBaseUrl ? { proxy_port: Number(new URL(proxyBaseUrl).port) } : {}),
        config_hash: cfgHash,
        process_marker: basename(tokenFile),
        instance_id: randomUUID(),
        started_at: new Date(startedAt).toISOString(),
        healthy: true,
        error: null,
        status: 'running',
      };
      while (!stopped && child === spawned && Date.now() - startedAt < startupMs) {
        if (!spawned.once && !alive(spawned.pid)) {
          startupError = 'Codex app-server exited during startup.';
          break;
        }
        if (await probeConnection(next, 450)) {
          if (!stopped && child === spawned) {
            atomicState(stateFile, next);
            connection = next;
            probeHealthy = true;
            probeTargetSig = instanceSignature(next);
            degradedReason = null;
            error = null;
            try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch {}
            scheduleHealthCheck();
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
    if (ownsLock && connection && alive(connection.pid)) {
      const { hash: wantHash } = currentGatewayConfig();
      const configChanged = (proxyBaseUrl || connection.config_hash) && connection.config_hash !== wantHash;
      const shouldProbe = probe || (healthIntervalMs > 0 && Date.now() - lastProbeAt > healthIntervalMs);
      let healthy = probeHealthy !== false;
      if (shouldProbe) {
        const target = connection;
        healthy = await probeConnection(target, 800);
        if (connection !== target || stopped) return getStatus();
      }
      if (!healthy || configChanged) {
        if (readActiveRuns(sessionsDir).length) {
          if (!healthy) {
            publishHealth(false, 'Codex app-server unresponsive; waiting for active runs to finish before restarting.');
          } else {
            publishHealth(true, null);
          }
          scheduleHealthCheck();
          return getStatus();
        }
        if (!healthy) error = 'Codex app-server unresponsive; restarting automatically.';
        const prevPid = connection?.pid;
        cleanup({ preserveActive: false });
        if (prevPid && prevPid !== process.pid && alive(prevPid)) {
          await waitForExit(prevPid, { timeoutMs: 2000, forceKillAfterMs: 1200 });
        }
        clearTimeout(restart);
        restart = undefined;
      } else {
        if (shouldProbe) publishHealth(true, null);
        scheduleHealthCheck();
        return getStatus();
      }
    }
    if (restart && !probe) return getStatus();
    if (probe && restart) {
      clearTimeout(restart);
      restart = undefined;
    }
    if (!observeOnly && !starting) {
      starting = start().catch((err) => {
        error = err.message;
        terminate(child);
        child = undefined;
        if (existsSync(tokenFile)) { try { unlinkSync(tokenFile); } catch {} }
        retry();
      }).finally(() => { starting = undefined; });
    }
    await starting;
    if (!ownsLock && probe) {
      const shared = readJsonSafe(stateFile);
      if (shared?.status === 'running' && alive(shared.pid)) {
        const ok = await probeConnection(shared, 800);
        probeHealthy = ok;
        probeTargetSig = instanceSignature(shared);
        degradedReason = ok ? null : 'Codex app-server health probe failed.';
        error = ok ? null : degradedReason;
      }
    }
    return getStatus();
  }

  async function restartService({ force = false } = {}) {
    if (stopped) return { ok: false, status: 503, error: 'Codex app-server manager is stopped.' };
    if (starting) await starting;
    const prev = connection || readJsonSafe(stateFile);
    const prevSig = instanceSignature(prev);
    const prevPid = prev?.status === 'running' ? prev.pid : null;
    const external = !ownsLock && prev?.status === 'running' && alive(prev.pid);
    const lockOwner = () => {
      try { return readFileSync(lockFile, 'utf8'); } catch { return ''; }
    };
    const ownerBefore = observeOnly ? lockOwner() : '';
    const marker = prev?.process_marker;
    const verified = external && (marker ? await verifyProcess(prev.pid, marker) : !observeOnly);
    if (observeOnly && (!verified || !alive(Number(ownerBefore.split(' ')[0])) || ownerBefore !== lockOwner()
      || prevSig !== instanceSignature(readJsonSafe(stateFile)))) {
      return { ok: false, status: 409, error: 'No verified Codex app-server with a live manager to restart.' };
    }
    const active = force === true ? [] : readActiveRuns(sessionsDir);
    if (active.length) {
      return {
        ok: false,
        status: 409,
        active_runs: active.length,
        error: `当前有 ${active.length} 个正在运行的 Codex 任务，请等待完成或确认强制重启。`,
      };
    }
    clearHealthTimer();
    clearTimeout(restart);
    restart = undefined;
    failures = 0;

    if (ownsLock) {
      cleanup({ preserveActive: false });
      if (prevPid && prevPid !== process.pid && alive(prevPid)) {
        await waitForExit(prevPid, { timeoutMs: 2500, forceKillAfterMs: 1500 });
      }
      const status = await ensureRunning({ probe: true });
      if (!status.running) {
        return { ok: false, status: 500, error: status.error || 'Codex app-server 重启失败。', app_server: status };
      }
      return { ok: true, status: 200, app_server: status };
    }

    if (external) {
      if (!verified) {
        return {
          ok: false,
          status: 409,
          error: '无法验证运行中的 Codex app-server 进程归属，拒绝终止未知进程。',
          app_server: getStatus(),
        };
      }
      terminate({ pid: prevPid });
    }

    const deadline = Date.now() + restartTimeoutMs;
    let oldExited = !prevPid || !alive(prevPid);
    let forcedKillSent = false;
    const forceKillAt = Date.now() + Math.min(1500, Math.floor(restartTimeoutMs / 2));

    while (!stopped && Date.now() < deadline) {
      if (!oldExited && prevPid) {
        if (!alive(prevPid)) {
          oldExited = true;
        } else if (!observeOnly && external && !forcedKillSent && prevPid !== process.pid
            && Date.now() >= forceKillAt && process.platform !== 'win32') {
          forcedKillSent = true;
          try { process.kill(prevPid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }

      const current = readJsonSafe(stateFile);
      const currentSig = instanceSignature(current);
      const isNewInstance = Boolean(
        current?.status === 'running'
        && alive(current.pid)
        && (!prevSig || currentSig !== prevSig || (prevPid && current.pid !== prevPid)),
      );
      if (isNewInstance && await probeConnection(current, 800)) {
        probeHealthy = true;
        probeTargetSig = currentSig;
        degradedReason = null;
        error = null;
        const status = getStatus();
        if (status.running) return { ok: true, status: 200, app_server: status };
      }

      if (oldExited && !isNewInstance) {
        const status = await ensureRunning({ probe: true });
        if (ownsLock && status.running) {
          return { ok: true, status: 200, app_server: status };
        }
      }

      await sleep(60);
    }

    const finalStatus = await ensureRunning({ probe: true });
    const finalCurrent = connection || readJsonSafe(stateFile);
    const finalSig = instanceSignature(finalCurrent);
    const replaced = Boolean(
      finalStatus.running
      && (!prevSig || finalSig !== prevSig || (prevPid && finalCurrent?.pid !== prevPid)),
    );
    if (!replaced) {
      return {
        ok: false,
        status: 500,
        error: finalStatus.error || 'Codex app-server 重启超时，未检测到旧进程退出或新实例生效。',
        app_server: finalStatus,
      };
    }
    return { ok: true, status: 200, app_server: finalStatus };
  }

  function interruptRun(runId, sessionsDir) {
    return interruptCoreRun(runId, { sessionsDir, connect, getState: () => connection || readJsonSafe(stateFile) });
  }

  function cleanup({ preserveActive = false } = {}) {
    clearHealthTimer();
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
    clearHealthTimer();
    clearTimeout(restart);
    await starting;
    process.off('exit', atExit);
    cleanup();
  } };
}

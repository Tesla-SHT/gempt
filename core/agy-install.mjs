import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { agyInstallPaths, RUNTIME_ROOT, resolvePluginRoot } from './bundle-paths.mjs';
import { LAUNCHER_META, LAUNCHER_PATH, LAUNCHER_TOOLS, LAUNCHER_TYPE, LAUNCHER_URI } from './mcp-app.mjs';
import { resolveNodeExecutable } from './node-executable.mjs';
import { atomicJson, resolvePath, withLock, withinPath } from './state.mjs';

export { resolveNodeExecutable };
const WINDOWS = process.platform === 'win32';
const quotePosix = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const quoteWindows = (value) => `"${value}"`;
const quote = WINDOWS ? quoteWindows : quotePosix;
const copyTree = (src, dst) => cpSync(src, dst, { recursive: true, dereference: true,
  filter: (path) => !/^(?:\.|node_modules$|__pycache__$)/.test(basename(path)) });

export function buildMcpConfig(runtime, nodeBin = resolveNodeExecutable()) {
  return { mcpServers: { gempt: { command: nodeBin, args: [join(runtime, 'core', 'mcp-server.mjs')] } } };
}

export function buildPortableMcpConfig() {
  return { mcpServers: { gempt: { command: 'node', args: ['${PLUGIN_ROOT}/runtime/core/mcp-server.mjs'] } } };
}

export function stagePluginBundle(staged, { target, source, nodeBin, portable = false } = {}) {
  let projectSource = RUNTIME_ROOT;
  if (source && existsSync(join(source, 'plugin', 'plugin.json'))) projectSource = source;
  else if (source && existsSync(join(source, 'runtime', 'core', 'mcp-server.mjs'))) projectSource = join(source, 'runtime');
  const plugin = source && source !== projectSource ? source : resolvePluginRoot(projectSource);
  const runtime = join(staged, 'runtime');
  mkdirSync(staged, { recursive: true });
  for (const name of ['plugin.json', 'mcp_config.json', 'hooks.json', 'work_split_hook.mjs']) {
    copyFileSync(join(plugin, name), join(staged, name));
  }
  for (const name of ['rules', 'skills', 'assets', 'sidecars']) {
    if (existsSync(join(plugin, name))) copyTree(join(plugin, name), join(staged, name));
  }
  copyTree(existsSync(join(plugin, 'templates')) ? join(plugin, 'templates') : join(projectSource, 'templates'),
    join(staged, 'templates'));
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    const src = existsSync(join(plugin, name)) ? join(plugin, name) : join(projectSource, name);
    if (existsSync(src)) copyFileSync(src, join(staged, name));
  }
  copyTree(join(projectSource, 'core'), join(runtime, 'core'));
  copyTree(join(projectSource, 'magpie_plugin', 'lib'), join(runtime, 'magpie_plugin', 'lib'));
  const runtimeUI = join(runtime, 'magpie_plugin', 'ui');
  mkdirSync(runtimeUI, { recursive: true });
  copyFileSync(join(projectSource, 'magpie_plugin', 'ui', 'http.js'), join(runtimeUI, 'http.js'));
  const sidecarFile = join(staged, 'sidecars', 'gempt_live', 'sidecar.json');
  if (existsSync(sidecarFile)) {
    const sidecar = JSON.parse(readFileSync(sidecarFile, 'utf8'));
    atomicJson(sidecarFile, { ...sidecar, command: portable ? 'node' : nodeBin });
  }
  if (existsSync(join(projectSource, 'bin'))) copyTree(join(projectSource, 'bin'), join(runtime, 'bin'));
  let pkgVersion;
  try { pkgVersion = JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8')).version; } catch {}
  atomicJson(join(runtime, 'package.json'), { type: 'module', ...(pkgVersion ? { version: pkgVersion } : {}) });
  const config = portable ? buildPortableMcpConfig() : buildMcpConfig(join(target, 'runtime'), nodeBin);
  atomicJson(join(staged, 'mcp_config.json'), config);
  const hookFile = join(staged, 'hooks.json');
  const hooks = JSON.parse(readFileSync(hookFile, 'utf8'));
  const command = portable ? 'node ./work_split_hook.mjs' : [nodeBin, join(target, 'work_split_hook.mjs')].map(quote).join(' ');
  for (const entries of Object.values(hooks['gempt-work-split'])) {
    for (const entry of entries) {
      for (const handler of entry.hooks || [entry]) {
        if (handler.type === 'command') handler.command = command;
      }
    }
  }
  atomicJson(hookFile, hooks);
  return config;
}

function stage(staged, target, source, nodeBin) {
  return stagePluginBundle(staged, { target, source, nodeBin, portable: false });
}

function stageLegacyHook(staged, target, nodeBin) {
  const entry = join(target, 'work_split_hook.mjs');
  const args = Buffer.from(JSON.stringify([nodeBin, entry])).toString('base64');
  writeFileSync(join(staged, 'work_split_hook.py'), [
    'import base64, json, os, subprocess, sys',
    '',
    `args = json.loads(base64.b64decode("${args}"))`,
    'if os.name == "nt":',
    '    sys.exit(subprocess.run(args).returncode)',
    'else:',
    '    os.execv(args[0], args)',
    '',
    '',
  ].join('\n'));
}

function nodeRequest(nodeBin, entry, cwd, env, requests) {
  return new Promise((resolve, reject) => {
    const child = execFile(nodeBin, [entry], { cwd, env, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`Staged ${basename(entry)} failed: ${stderr.trim() || error.message}`, { cause: error }));
        try { resolve(stdout.trim().split('\n').map((line) => JSON.parse(line))); } catch (parseError) { reject(parseError); }
      });
    child.stdin.on('error', reject);
    child.stdin.end(requests.map((request) => `${JSON.stringify(request)}\n`).join(''));
  });
}

export async function validatePluginBundle(staged, nodeBin, env = process.env, { portable = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(staged, 'plugin.json'), 'utf8'));
  if (manifest.name !== 'gempt') throw new Error("Expected Antigravity plugin manifest name 'gempt'.");
  for (const file of readdirSync(join(staged, 'templates')).filter((name) => name.endsWith('.json'))) {
    JSON.parse(readFileSync(join(staged, 'templates', file), 'utf8'));
  }
  for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.txt', 'assets/logo.svg',
    'hooks.json', 'mcp_config.json', 'rules/AGENTS.md',
    'skills/gempt/SKILL.md', 'runtime/bin/gempt.mjs', 'runtime/core/assets/workload.json',
    `runtime/core/${LAUNCHER_PATH}`,
    'sidecars/gempt_live/sidecar.json', 'sidecars/gempt_live/main.mjs',
    ...['index.html', 'styles.css', 'app.js'].map((file) => `runtime/core/assets/http-ui/${file}`)]) {
    if (!statSync(join(staged, file), { throwIfNoEntry: false })?.isFile() || !statSync(join(staged, file)).size) {
      throw new Error(`Missing or empty Antigravity plugin asset: ${file}`);
    }
  }
  if (!readFileSync(join(staged, 'rules', 'AGENTS.md'), 'utf8').trim()) {
    throw new Error('Empty Antigravity plugin rules text: rules/AGENTS.md');
  }
  const sidecar = JSON.parse(readFileSync(join(staged, 'sidecars', 'gempt_live', 'sidecar.json'), 'utf8'));
  if (!sidecar.has_web_ui || sidecar.command !== (portable ? 'node' : nodeBin) || sidecar.args?.[0] !== 'main.mjs'
      || !sidecar.ui_config?.views?.some(({ path, entrypoint }) => path === '/' && entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE')) {
    throw new Error('Invalid GemPT sidecar manifest.');
  }
  if (portable) {
    const mcp = JSON.parse(readFileSync(join(staged, 'mcp_config.json'), 'utf8'));
    if (!String(mcp?.mcpServers?.gempt?.args?.[0] || '').startsWith('${PLUGIN_ROOT}/')) {
      throw new Error('Portable Antigravity plugin mcp_config.json must use ${PLUGIN_ROOT}.');
    }
    const hookText = readFileSync(join(staged, 'hooks.json'), 'utf8');
    if (!hookText.includes('node ./work_split_hook.mjs')) {
      throw new Error('Portable Antigravity plugin hooks.json must use relative ./work_split_hook.mjs.');
    }
  }
  const validationWorkspace = mkdtempSync(join(dirname(staged), '.gempt-validate-'));
  const childEnv = {
    ...env,
    GEMPT_CONFIG: join(validationWorkspace, 'validation-config.json'),
    GEMPT_SESSIONS_DIR: join(validationWorkspace, 'sessions'),
    GEMPT_AGY_BRAIN_DIR: join(validationWorkspace, 'brain'),
    GEMPT_APP_SERVER_STATE: join(validationWorkspace, 'app-server.json'),
    MAGPIE_CONFIG_DIR: join(validationWorkspace, 'magpie'),
    MAGPIE_ADDR: 'http://127.0.0.1:0',
  };
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'resources/list' },
    { id: 4, method: 'tools/call', params: { name: 'gpt_ctl', arguments: { action: 'status' } } },
    { id: 5, method: 'resources/read', params: { uri: LAUNCHER_URI } },
    { id: 6, method: 'resources/read', params: { uri: 'ui://gempt/live.html' } },
  ].map((request) => ({ jsonrpc: '2.0', ...request }));
  try {
    const [packets, [hook]] = await Promise.all([
      nodeRequest(nodeBin, join(staged, 'runtime', 'core', 'mcp-server.mjs'), staged, childEnv, requests),
      nodeRequest(nodeBin, join(staged, 'work_split_hook.mjs'), staged, childEnv,
        [{ hookEventName: 'SessionStart', modelName: 'gemini-4-neon-high' }]),
    ]);
    const results = new Map(packets.map(({ id, result }) => [id, result]));
    if (results.get(1)?.serverInfo?.name !== 'gempt') throw new Error('Staged MCP server did not identify itself as gempt.');
    if (!isDeepStrictEqual(results.get(1)?.capabilities?.resources, {})) {
      throw new Error('Staged MCP server must declare launcher resource capabilities.');
    }
    const tools = results.get(2)?.tools;
    const expected = ['gpt_ask', 'gpt_board', 'gpt_ctl', 'gpt_run', 'gpt_swarm'];
    if (JSON.stringify(tools?.map(({ name }) => name).sort()) !== JSON.stringify(expected)) {
      throw new Error(`Staged MCP server did not advertise the expected set of ${expected.length} GemPT tools.`);
    }
    if (tools.some(({ name, _meta, meta }) => meta !== undefined || !isDeepStrictEqual(_meta,
      LAUNCHER_TOOLS.includes(name) ? { ui: { resourceUri: LAUNCHER_URI } } : undefined))) {
      throw new Error('Staged MCP server must attach only inline launcher metadata to gpt_run and gpt_swarm.');
    }
    const resources = results.get(3)?.resources;
    if (!isDeepStrictEqual(resources, [{
      uri: LAUNCHER_URI, name: 'GemPT launcher', mimeType: LAUNCHER_TYPE, _meta: LAUNCHER_META,
    }])) {
      throw new Error('Staged MCP server must advertise only the inline launcher resource.');
    }
    const launcherText = readFileSync(join(staged, 'runtime', 'core', LAUNCHER_PATH), 'utf8');
    if (!isDeepStrictEqual(results.get(5)?.contents, [{
      uri: LAUNCHER_URI, mimeType: LAUNCHER_TYPE, _meta: LAUNCHER_META, text: launcherText,
    }]) || packets.find(({ id }) => id === 6)?.error?.code !== -32002) {
      throw new Error('Staged MCP server must serve the inline launcher and reject the legacy MCP App URI.');
    }
    const statusResponse = packets.find(({ id }) => id === 4);
    const statusResult = statusResponse?.result;
    if (statusResponse?.error || !statusResult || statusResult.isError) {
      const detail = statusResponse?.error?.message || statusResult?.content?.[0]?.text || 'missing tool result';
      throw new Error(`Staged MCP server gpt_ctl status failed: ${detail}`);
    }
    const statusPayload = JSON.parse(statusResult.content?.[0]?.text || '');
    if (!statusPayload || typeof statusPayload !== 'object' || Array.isArray(statusPayload)) {
      throw new Error('Staged MCP server gpt_ctl status returned invalid payload.');
    }
    if (!hook?.injectSteps?.[0]?.systemMessage?.systemMessage) throw new Error('Staged SessionStart hook did not inject a system message.');
  } finally {
    try { rmSync(validationWorkspace, { recursive: true, force: true }); } catch {}
  }
}

async function validate(staged, nodeBin, env) {
  return validatePluginBundle(staged, nodeBin, env, { portable: false });
}

function restoreFile(backupPath, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = join(dirname(dst), `.gempt-restore-${randomUUID()}.tmp`);
  try {
    copyFileSync(backupPath, tmp);
    renameSync(tmp, dst);
  } catch {
    copyFileSync(backupPath, dst);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function rollbackInPlace(actions) {
  const errors = [];
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i];
    try {
      if (action.type === 'created-file') {
        rmSync(action.dst, { force: true });
      } else if (action.type === 'created-dir') {
        rmSync(action.dst, { recursive: true, force: true });
      } else if (action.type === 'restore-file') {
        restoreFile(action.backupPath, action.dst);
      } else if (action.type === 'restore-moved') {
        if (lstatSync(action.dst, { throwIfNoEntry: false })) {
          rmSync(action.dst, { recursive: true, force: true });
        }
        try {
          renameSync(action.backupPath, action.dst);
        } catch {
          cpSync(action.backupPath, action.dst, { recursive: true, verbatimSymlinks: true });
        }
      } else if (action.type === 'restore-entry') {
        if (lstatSync(action.dst, { throwIfNoEntry: false })) {
          rmSync(action.dst, { recursive: true, force: true });
        }
        if (action.isSymbolicLink && action.linkTarget !== undefined) {
          symlinkSync(action.linkTarget, action.dst);
        } else if (action.isDirectory) {
          cpSync(action.backupPath, action.dst, { recursive: true, verbatimSymlinks: true });
        } else {
          restoreFile(action.backupPath, action.dst);
        }
      }
    } catch (rollbackError) {
      errors.push(`${action.dst}: ${rollbackError.message}`);
    }
  }
  return errors;
}

export async function syncInPlace(staged, target, { backupDir, verify } = {}) {
  const ownBackup = !backupDir;
  const backupRoot = backupDir || mkdtempSync(join(dirname(target), `.${basename(target)}-inplace-backup-`));
  mkdirSync(backupRoot, { recursive: true });
  const actions = [];
  let seq = 0;
  let keepBackup = false;

  const nextBackupPath = (name) => join(backupRoot, `${seq++}-${name}`);

  const backupAndRemoveEntry = (dst, existing) => {
    const backupPath = nextBackupPath(basename(dst));
    try {
      renameSync(dst, backupPath);
      actions.push({ type: 'restore-moved', dst, backupPath });
      return;
    } catch {
      if (existing.isSymbolicLink()) {
        const linkTarget = readlinkSync(dst);
        rmSync(dst, { force: true });
        actions.push({ type: 'restore-entry', dst, isSymbolicLink: true, linkTarget });
        return;
      }
      if (existing.isDirectory()) {
        cpSync(dst, backupPath, { recursive: true, verbatimSymlinks: true });
        actions.push({ type: 'restore-entry', dst, backupPath, isDirectory: true });
        rmSync(dst, { recursive: true, force: true });
        return;
      }
      copyFileSync(dst, backupPath);
      rmSync(dst, { force: true });
      actions.push({ type: 'restore-entry', dst, backupPath, isDirectory: false });
    }
  };

  const syncDir = (srcDir, dstDir) => {
    if (!lstatSync(dstDir, { throwIfNoEntry: false })) {
      mkdirSync(dstDir, { recursive: true });
      actions.push({ type: 'created-dir', dst: dstDir });
    }
    const expected = new Set(readdirSync(srcDir));
    for (const name of expected) {
      const src = join(srcDir, name);
      const dst = join(dstDir, name);
      const directory = statSync(src).isDirectory();
      const existing = lstatSync(dst, { throwIfNoEntry: false });
      if (existing && (existing.isSymbolicLink() || directory !== existing.isDirectory())) {
        backupAndRemoveEntry(dst, existing);
      }
      if (directory) {
        syncDir(src, dst);
      } else {
        const current = lstatSync(dst, { throwIfNoEntry: false });
        let backupPath;
        if (current) {
          backupPath = nextBackupPath(name);
          copyFileSync(dst, backupPath);
        }
        const tmp = join(dstDir, `.gempt-${randomUUID()}.tmp`);
        try {
          copyFileSync(src, tmp);
          renameSync(tmp, dst);
        } finally {
          rmSync(tmp, { force: true });
        }
        if (backupPath) {
          actions.push({ type: 'restore-file', dst, backupPath });
        } else {
          actions.push({ type: 'created-file', dst });
        }
      }
    }
    for (const name of readdirSync(dstDir)) {
      if (!expected.has(name)) {
        const obsolete = join(dstDir, name);
        const backupPath = nextBackupPath(name);
        try {
          renameSync(obsolete, backupPath);
          actions.push({ type: 'restore-moved', dst: obsolete, backupPath });
        } catch {}
      }
    }
  };

  try {
    syncDir(staged, target);
    if (verify) await verify(target);
  } catch (error) {
    const rollbackErrors = rollbackInPlace(actions);
    if (rollbackErrors.length > 0) {
      keepBackup = true;
      const rollbackError = new Error(
        `In-place update of ${target} failed and rollback encountered errors (${rollbackErrors.join('; ')}). Backup saved at ${backupRoot}.`,
        { cause: error },
      );
      rollbackError.backupPath = backupRoot;
      throw rollbackError;
    }
    throw error;
  } finally {
    if (ownBackup && !keepBackup) {
      try { rmSync(backupRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

function resetWindowsAcls(paths) {
  if (!WINDOWS) return;
  const icacls = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  for (const path of paths) {
    try {
      const recursive = statSync(path).isDirectory() ? ['/T'] : [];
      spawnSync(icacls, [path, '/reset', ...recursive, '/C', '/Q'], { stdio: 'ignore', windowsHide: true });
    } catch {}
  }
}

function writeShimFile(path, contents, mode) {
  const tmp = join(dirname(path), `.gempt-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, contents);
    if (mode) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function installShim(shim, nodeBin, entry) {
  const command = [nodeBin, entry].map(quotePosix).join(' ');
  writeShimFile(shim, `#!/usr/bin/env sh\nexec ${command} "$@"\n`, 0o755);
  const written = [shim];
  if (WINDOWS) {
    const cmd = `${shim}.cmd`;
    writeShimFile(cmd, `@echo off\r\n${[nodeBin, entry].map((value) => quoteWindows(value.replaceAll('%', '%%'))).join(' ')} %*\r\n`);
    written.push(cmd);
  }
  return written;
}

function installWaitShim(target, nodeBin, binDir) {
  mkdirSync(binDir, { recursive: true });
  const helper = join(binDir, 'gempt-wait.mjs');
  const entry = pathToFileURL(join(target, 'runtime', 'core', 'wait.mjs')).href;
  writeShimFile(helper, `import { runWait } from ${JSON.stringify(entry)};\nprocess.exitCode = await runWait(process.argv.slice(2));\n`);
  const written = installShim(join(binDir, 'gempt-wait'), nodeBin, helper);
  try { rmSync(join(binDir, 'gempt-wait.py'), { force: true }); } catch {}
  return [helper, ...written];
}

async function refresh(env) {
  const csrf = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!csrf) return { refreshed: false, reason: 'ANTIGRAVITY_CSRF_TOKEN not present in environment' };
  const address = env.ANTIGRAVITY_LS_ADDRESS?.trim();
  if (!address) return { refreshed: false, reason: 'Antigravity did not supply a language server address' };
  const url = `http://${address}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`;
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': csrf },
      body: JSON.stringify({ serverName: 'gempt_gempt' }) });
    await response.body?.cancel();
    return { refreshed: response.ok, status: response.status, url };
  } catch (error) {
    return { refreshed: false, reason: error.message, url };
  }
}

export async function installAgy({ target, source, force = false, binDir, env = process.env } = {}) {
  ({ target, binDir } = agyInstallPaths(target, binDir, env));
  source = source && resolvePath(source);
  const nodeBin = resolveNodeExecutable({ env });
  if (!/^node(?:\.exe)?$/i.test(basename(nodeBin))) throw new Error('Node.js 20.11+ is required. Add Node.js to the PATH of the Magpie process and reopen Magpie.');
  if ([RUNTIME_ROOT, resolvePath(nodeBin), source].filter(Boolean).some((path) => withinPath(path, target))) {
    throw new Error(`Target ${target} contains the running GemPT package, source, or Node executable.`);
  }
  const parent = dirname(target);
  return withLock(join(parent, `.${basename(target)}-install.lock`), async () => {
    if (existsSync(target) && !force) {
      let name;
      try { ({ name } = JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8'))); } catch {}
      if (name !== 'gempt') throw new Error(`Target ${target} is not an existing GemPT plugin. Use --force or another --target.`);
    }
    const workspace = mkdtempSync(join(parent, `.${basename(target)}-install-`));
    const staged = join(workspace, 'plugin');
    const backup = join(workspace, 'previous');
    let keepBackup = false;
    try {
      const config = stage(staged, target, source, nodeBin);
      await validate(staged, nodeBin, env);
      if (existsSync(join(target, 'work_split_hook.py'))) stageLegacyHook(staged, target, nodeBin);
      try {
        if (existsSync(target)) renameSync(target, backup);
        renameSync(staged, target);
      } catch (error) {
        if (existsSync(backup)) {
          try { renameSync(backup, target); } catch (restoreError) {
            keepBackup = true;
            throw new Error(`Could not restore ${target}. Previous installation saved at ${backup}.`, { cause: restoreError });
          }
          throw error;
        }
        if (!WINDOWS || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || !existsSync(target)) throw error;
        try {
          await syncInPlace(staged, target, {
            backupDir: join(workspace, 'inplace-backup'),
            verify: (dir) => validate(dir, nodeBin, env),
          });
        } catch (syncError) {
          if (syncError?.backupPath) keepBackup = true;
          throw syncError;
        }
      }
      resetWindowsAcls([target]);
      const resolvedBinDir = resolvePath(binDir);
      let shims = [];
      let cliShims = [];
      let waitShimError;
      let cliShimError;
      try { shims = installWaitShim(target, nodeBin, resolvedBinDir); } catch (error) { waitShimError = error.message; }
      try {
        mkdirSync(resolvedBinDir, { recursive: true });
        cliShims = installShim(join(resolvedBinDir, 'gempt'), nodeBin, join(target, 'runtime', 'bin', 'gempt.mjs'));
      } catch (error) { cliShimError = error.message; }
      resetWindowsAcls([...shims, ...cliShims]);
      const pathEntries = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((dir) => {
        try { return resolvePath(dir); } catch { return dir; }
      });
      const fold = (p) => (WINDOWS ? p.toLowerCase() : p);
      const binOnPath = pathEntries.some((dir) => fold(dir) === fold(resolvedBinDir));
      const warnings = [];
      if (waitShimError) {
        warnings.push(`Could not install gempt-wait shim in ${resolvedBinDir}: ${waitShimError}. gpt_run will return an explicit fallback wait_command.`);
      } else if (!binOnPath) {
        warnings.push(`${resolvedBinDir} is not on PATH; add it to PATH to run \`gempt-wait\` directly, or execute the exact \`wait_command\` returned by gpt_run.`);
      }
      if (cliShimError) {
        warnings.push(`Could not install gempt shim in ${resolvedBinDir}: ${cliShimError}.`);
      } else if (!binOnPath) {
        warnings.push(`Add ${resolvedBinDir} to PATH to run \`gempt\` from Swarm workers.`);
      }
      const shimError = waitShimError || cliShimError;
      return {
        installed: !shimError,
        plugin_installed: true,
        shim_installed: !waitShimError,
        plugin_dir: target,
        mcp_config: config,
        shims,
        cli_shims: cliShims,
        wait_shim: {
          installed: !waitShimError,
          on_path: binOnPath,
          bin_dir: resolvedBinDir,
          ...(waitShimError ? { error: waitShimError } : {}),
        },
        ...(cliShimError ? { cli_shim_error: cliShimError } : {}),
        ...(shimError ? { shim_error: shimError } : {}),
        ...(warnings.length ? { warnings } : {}),
        refresh: await refresh(env),
      };
    } finally {
      if (!keepBackup) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch {}
      }
    }
  });
}

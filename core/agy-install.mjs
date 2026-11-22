import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_RESOURCE, APP_TOOLS, APP_URI } from './mcp-app.mjs';
import { resolveNodeExecutable } from './node-executable.mjs';
import { atomicJson, resolvePath, withLock, withinPath } from './state.mjs';

export { resolveNodeExecutable };
export const DEFAULT_AGY_TARGET = join(homedir(), '.gemini', 'config', 'plugins', 'gempt');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
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
  const projectSource = source && existsSync(join(source, 'plugin', 'plugin.json')) ? source : ROOT;
  const plugin = source === projectSource || !source ? join(projectSource, 'plugin') : source;
  const runtime = join(staged, 'runtime');
  mkdirSync(staged, { recursive: true });
  for (const name of ['plugin.json', 'mcp_config.json', 'hooks.json', 'work_split_hook.mjs']) {
    copyFileSync(join(plugin, name), join(staged, name));
  }
  for (const name of ['rules', 'agents', 'skills', 'assets']) {
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
    'hooks.json', 'mcp_config.json', 'rules/AGENTS.md', 'agents/gempt-worker.md',
    'skills/gempt/SKILL.md', 'runtime/core/assets/workload.json', 'runtime/core/assets/mcp_app_live.html']) {
    if (!statSync(join(staged, file), { throwIfNoEntry: false })?.isFile() || !statSync(join(staged, file)).size) {
      throw new Error(`Missing or empty Antigravity plugin asset: ${file}`);
    }
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
  const childEnv = { ...env, GEMPT_CONFIG: join(validationWorkspace, 'validation-config.json') };
  delete childEnv.GEMPT_APP_HTML;
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'resources/read', params: { uri: APP_URI } },
  ].map((request) => ({ jsonrpc: '2.0', ...request }));
  try {
    const [packets, [hook]] = await Promise.all([
      nodeRequest(nodeBin, join(staged, 'runtime', 'core', 'mcp-server.mjs'), staged, childEnv, requests),
      nodeRequest(nodeBin, join(staged, 'work_split_hook.mjs'), staged, childEnv,
        [{ hookEventName: 'SessionStart', modelName: 'gemini-4-neon-high' }]),
    ]);
    const results = new Map(packets.map(({ id, result }) => [id, result]));
    if (results.get(1)?.serverInfo?.name !== 'gempt') throw new Error('Staged MCP server did not identify itself as gempt.');
    const tools = results.get(2)?.tools;
    const expected = ['gpt_run', 'gpt_ask', 'gpt_ctl', ...Object.keys(APP_TOOLS)].sort();
    if (JSON.stringify(tools?.map(({ name }) => name).sort()) !== JSON.stringify(expected)) {
      throw new Error('Staged MCP server did not advertise the seven GemPT tools.');
    }
    const resource = results.get(3)?.contents?.[0];
    if (resource?.mimeType !== APP_RESOURCE.mimeType || !resource.text) throw new Error('Staged MCP server could not read GemPT Live.');
    if (!hook?.injectSteps?.[0]?.systemMessage?.systemMessage) throw new Error('Staged SessionStart hook did not inject a system message.');
  } finally {
    try { rmSync(validationWorkspace, { recursive: true, force: true }); } catch {}
  }
}

async function validate(staged, nodeBin, env) {
  return validatePluginBundle(staged, nodeBin, env, { portable: false });
}

function syncInPlace(staged, target) {
  mkdirSync(target, { recursive: true });
  const expected = new Set(readdirSync(staged));
  for (const name of expected) {
    const src = join(staged, name);
    const dst = join(target, name);
    const directory = statSync(src).isDirectory();
    const existing = lstatSync(dst, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || directory !== existing.isDirectory())) {
      rmSync(dst, { recursive: true, force: true });
    }
    if (directory) {
      syncInPlace(src, dst);
    } else {
      const tmp = join(target, `.gempt-${randomUUID()}.tmp`);
      try {
        copyFileSync(src, tmp);
        renameSync(tmp, dst);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }
  for (const name of readdirSync(target)) {
    if (!expected.has(name)) {
      try { rmSync(join(target, name), { recursive: true, force: true }); } catch {}
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

function installWaitShim(target, nodeBin, binDir) {
  mkdirSync(binDir, { recursive: true });
  const helper = join(binDir, 'gempt-wait.mjs');
  const shim = join(binDir, 'gempt-wait');
  const command = [nodeBin, helper].map(quotePosix).join(' ');
  const entry = pathToFileURL(join(target, 'runtime', 'core', 'wait.mjs')).href;
  writeFileSync(helper, `import { runWait } from ${JSON.stringify(entry)};\nprocess.exitCode = await runWait(process.argv.slice(2));\n`);
  writeFileSync(shim, `#!/usr/bin/env sh\nexec ${command} "$@"\n`);
  chmodSync(shim, 0o755);
  const written = [helper, shim];
  if (WINDOWS) {
    const cmd = `${shim}.cmd`;
    writeFileSync(cmd, `@echo off\r\n${[nodeBin, helper].map((value) => quoteWindows(value.replaceAll('%', '%%'))).join(' ')} %*\r\n`);
    written.push(cmd);
  }
  try { rmSync(join(binDir, 'gempt-wait.py'), { force: true }); } catch {}
  return written;
}

async function refresh(env) {
  const csrf = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!csrf) return { refreshed: false, reason: 'ANTIGRAVITY_CSRF_TOKEN not present in environment' };
  const address = env.ANTIGRAVITY_LS_ADDRESS?.trim() || 'localhost:5387';
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

export async function installAgy({ target = DEFAULT_AGY_TARGET, source, force = false,
  binDir = join(homedir(), 'bin'), env = process.env } = {}) {
  target = resolvePath(target);
  source = source && resolvePath(source);
  const nodeBin = resolveNodeExecutable({ env });
  if ([ROOT, resolvePath(nodeBin), source].filter(Boolean).some((path) => withinPath(path, target))) {
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
        syncInPlace(staged, target);
      }
      resetWindowsAcls([target]);
      const resolvedBinDir = resolvePath(binDir);
      let shims = [];
      let shimError;
      try { shims = installWaitShim(target, nodeBin, resolvedBinDir); } catch (error) { shimError = error.message; }
      resetWindowsAcls(shims);
      const pathEntries = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((dir) => {
        try { return resolvePath(dir); } catch { return dir; }
      });
      const fold = (p) => (WINDOWS ? p.toLowerCase() : p);
      const binOnPath = pathEntries.some((dir) => fold(dir) === fold(resolvedBinDir));
      const warnings = [];
      if (shimError) {
        warnings.push(`Could not install gempt-wait shim in ${resolvedBinDir}: ${shimError}. gpt_run will return an explicit fallback wait_command.`);
      } else if (!binOnPath) {
        warnings.push(`${resolvedBinDir} is not on PATH; add it to PATH to run \`gempt-wait\` directly, or execute the exact \`wait_command\` returned by gpt_run.`);
      }
      return {
        installed: !shimError,
        plugin_installed: true,
        shim_installed: !shimError,
        plugin_dir: target,
        mcp_config: config,
        shims,
        wait_shim: {
          installed: !shimError,
          on_path: binOnPath,
          bin_dir: resolvedBinDir,
          ...(shimError ? { error: shimError } : {}),
        },
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

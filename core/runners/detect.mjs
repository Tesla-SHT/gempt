import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { resolveNodeExecutable } from '../node-executable.mjs';

const WINDOWS_EXTS = ['.exe', '.cmd', '.ps1', '.bat'];
const STRIPPED_INHERITED_ENV = [
  'CODEX_WINDOWS_REGISTERED_CORE',
  'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_TOOL_CALL_ID',
  'GEMPT_APP_SERVER_GATEWAY_TOKEN',
];

export function expandUserPath(rawPath, home = homedir()) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

export function isExecutableFile(candidate, platform = process.platform) {
  if (!candidate) return false;
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function nvmNodeBinDirs(home = homedir()) {
  const root = join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .map((name) => join(root, name, 'bin'));
  } catch {
    return [];
  }
}

export function getExecutableSearchDirs(env = process.env, { platform = process.platform, home = homedir() } = {}) {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    const clean = String(dir || '').trim();
    if (!clean) return;
    const key = platform === 'win32' ? clean.toLowerCase() : clean;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(clean);
  };

  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) add(dir);

  if (platform !== 'win32') {
    add('/opt/homebrew/bin');
    add('/usr/local/bin');
    add(join(home, '.local', 'bin'));
    add(join(home, '.volta', 'bin'));
    add(join(home, '.npm-global', 'bin'));
    add(join(home, '.cargo', 'bin'));
    add(join(home, '.bun', 'bin'));
    add(join(home, '.fnm', 'current', 'bin'));
    for (const nvmDir of nvmNodeBinDirs(home)) add(nvmDir);
  } else {
    if (env.APPDATA) add(join(env.APPDATA, 'npm'));
    add(join(home, '.local', 'bin'));
    add(join(home, '.volta', 'bin'));
    add(join(home, '.cargo', 'bin'));
    add(join(home, '.bun', 'bin'));
  }

  return dirs;
}

function expandPlatformNames(name, platform = process.platform) {
  const clean = String(name || '').trim();
  if (!clean) return [];
  if (platform !== 'win32') return [clean];
  if (extname(clean)) return [clean];
  return WINDOWS_EXTS.map((ext) => `${clean}${ext}`);
}

export function findExecutable({
  configuredPath = '',
  envVars = [],
  binaryNames = [],
  env = process.env,
  platform = process.platform,
  home = homedir(),
  includeFallbackDirs = true,
} = {}) {
  const dirs = includeFallbackDirs
    ? getExecutableSearchDirs(env, { platform, home })
    : String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);

  const explicitEntries = [configuredPath, ...envVars.map((key) => env[key])].filter(Boolean);
  for (const entry of explicitEntries) {
    const expanded = expandUserPath(entry, home);
    if (!expanded) continue;
    const bare = basename(expanded) === expanded;
    const directCandidates = expandPlatformNames(expanded, platform);
    for (const candidate of directCandidates) {
      if (isExecutableFile(candidate, platform)) return resolve(candidate);
    }
    if (bare) {
      for (const dir of dirs) {
        for (const name of expandPlatformNames(expanded, platform)) {
          const candidate = join(dir, name);
          if (isExecutableFile(candidate, platform)) return resolve(candidate);
        }
      }
    }
  }

  for (const dir of dirs) {
    for (const rawName of binaryNames) {
      for (const name of expandPlatformNames(rawName, platform)) {
        const candidate = join(dir, name);
        if (isExecutableFile(candidate, platform)) return resolve(candidate);
      }
    }
  }
  return '';
}

export function resolveExecutableInvocation(cli, {
  env = process.env,
  platform = process.platform,
  npmEntryRelative = '',
} = {}) {
  if (!cli) throw new Error('Executable path is required.');
  if (/\.(?:mjs|cjs|js)$/i.test(cli)) {
    return [resolveNodeExecutable({ env }), cli];
  }
  if (platform !== 'win32' || !/\.(cmd|ps1|bat)$/i.test(cli)) return [cli];

  const directory = dirname(cli);
  const findNode = () => {
    const candidates = [
      join(directory, 'node.exe'),
      ...String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'node.exe')),
    ];
    return candidates.find((c) => isExecutableFile(c, platform)) || resolveNodeExecutable({ env });
  };

  if (npmEntryRelative) {
    const npmEntry = join(directory, npmEntryRelative);
    if (existsSync(npmEntry)) {
      const node = findNode();
      if (node) return [node, npmEntry];
    }
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
    const ps = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (isExecutableFile(ps, platform)) {
      return [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cli];
    }
  }
  const comspec = env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  if (/\.(cmd|bat)$/i.test(cli) && existsSync(comspec)) {
    return [comspec, '/d', '/s', '/c', cli];
  }
  throw new Error(`Cannot resolve Windows CLI shim (${cli}).`);
}

export function buildRunnerBaseEnv({
  env = process.env,
  gatewayUrl = '',
  apiKey = '',
  swarmId = '',
  swarmAgent = '',
  sessionsDir = '',
  configPath = '',
  extra = {},
} = {}) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (STRIPPED_INHERITED_ENV.includes(key.toUpperCase())) delete childEnv[key];
  }
  const cleanGateway = String(gatewayUrl || '').replace(/\/+$/, '');
  const token = String(apiKey || '').trim() || 'gempt-local';
  childEnv.NO_PROXY = childEnv.no_proxy = '127.0.0.1,localhost,::1';
  if (cleanGateway) {
    childEnv.GEMPT_GATEWAY_URL = cleanGateway;
    childEnv.OPENAI_BASE_URL = `${cleanGateway}/v1`;
    childEnv.OPENAI_API_KEY = token;
    childEnv.ANTHROPIC_BASE_URL = cleanGateway;
    childEnv.ANTHROPIC_AUTH_TOKEN = token;
    childEnv.ANTHROPIC_API_KEY = token;
  }
  if (swarmId) childEnv.GEMPT_SWARM_ID = String(swarmId);
  if (swarmAgent) childEnv.GEMPT_AGENT_NAME = String(swarmAgent);
  if (sessionsDir) childEnv.GEMPT_SESSIONS_DIR = String(sessionsDir);
  if (configPath) childEnv.GEMPT_CONFIG = String(configPath);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    childEnv[key] = String(value);
  }
  return childEnv;
}

export function terminateProcessTree(pidOrChild, platform = process.platform) {
  const pid = typeof pidOrChild === 'number' ? pidOrChild : pidOrChild?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return false;
  if (platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const res = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 4000,
    });
    if (res.status === 0) return true;
  }
  try {
    if (typeof pidOrChild === 'object' && typeof pidOrChild?.kill === 'function') {
      pidOrChild.kill('SIGTERM');
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

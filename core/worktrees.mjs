import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { listActiveRoster } from './runs.mjs';
import { resolveSessionsDir } from './config.mjs';
import { atomicJson, resolvePath, validateSessionId, withLockSync, withinPath } from './state.mjs';

const sameOrWithin = (candidate, root) => {
  const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  return withinPath(fold(candidate), fold(root));
};

export const samePath = (a, b) => relative(a, b) === '';

export function resolveExternalWorktreeSourceCwd(cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd.trim()) return null;
    const resolvedCwd = resolvePath(cwd);
    if (!statSync(resolvedCwd).isDirectory()) return null;
    for (let root = resolvedCwd; ; root = dirname(root)) {
      const marker = join(root, '.git');
      const entry = lstatSync(marker, { throwIfNoEntry: false });
      if (entry) {
        if (!entry.isFile()) return null;
        const match = /^gitdir: ([^\r\n]+)$/.exec(readFileSync(marker, 'utf8').trimEnd());
        if (!match) return null;
        const gitDir = resolvePath(resolve(root, match[1]));
        const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trimEnd();
        if (!common) return null;
        const commonDir = resolvePath(resolve(gitDir, common));
        const adminRoot = join(commonDir, 'worktrees');
        if (!sameOrWithin(gitDir, adminRoot) || !relative(adminRoot, gitDir)
            || relative(join(dirname(commonDir), '.git'), commonDir) || !statSync(commonDir).isDirectory()) return null;
        // A copied .git file must not grant its directory access to someone else's workspace.
        const backlink = readFileSync(join(gitDir, 'gitdir'), 'utf8').trimEnd();
        if (!backlink || relative(resolvePath(resolve(gitDir, backlink)), marker)) return null;
        const mainRoot = dirname(commonDir);
        if (!statSync(mainRoot).isDirectory()) return null;
        // Keep the logical subdirectory even when it only exists on the linked branch.
        const mapped = resolvePath(join(mainRoot, relative(root, resolvedCwd)));
        return sameOrWithin(mapped, mainRoot) && relative(mapped, resolvedCwd) ? mapped : null;
      }
      if (dirname(root) === root) return null;
    }
  } catch {
    return null;
  }
}

const externalSources = new Map();

export function recordSourceCwd({ cwd, source_cwd }) {
  if (typeof source_cwd === 'string' && source_cwd.trim()) return source_cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  const now = performance.now();
  const hit = externalSources.get(key);
  if (hit && now < hit.expires) return hit.source;
  const source = resolveExternalWorktreeSourceCwd(cwd);
  externalSources.delete(key);
  if (externalSources.size >= 512) externalSources.delete(externalSources.keys().next().value);
  externalSources.set(key, { source, expires: now + 5000 });
  return source;
}

function inWorkspace(cwd, roots) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  if (!roots) return true;
  const path = resolvePath(cwd);
  return roots.some((root) => sameOrWithin(path, root));
}

export function recordInWorkspace(record, roots) {
  return inWorkspace(record.cwd, roots) || inWorkspace(recordSourceCwd(record), roots);
}

export function workspaceFileRoots(record, roots) {
  const cwd = inWorkspace(record.cwd, null) ? resolvePath(record.cwd) : null;
  if (!roots) {
    if (!cwd) return [];
    const source = recordSourceCwd(record);
    return inWorkspace(source, null) ? [cwd, resolvePath(source)] : [cwd];
  }
  const allowed = [...roots];
  // Visibility may use persisted or cached metadata. External file links need current Git ownership.
  if (record.worktree_path) {
    if (!inWorkspace(record.worktree_path, null) || !inWorkspace(record.source_cwd, roots)) return allowed;
    const tree = resolvePath(record.worktree_path);
    const managed = worktreesRoot();
    if ((sameOrWithin(tree, managed) && !samePath(tree, managed))
        || inWorkspace(resolveExternalWorktreeSourceCwd(tree), roots)) allowed.push(tree);
    // The tree already covers its cwd and must never grant access to a sibling cwd.
  } else if (cwd && !inWorkspace(cwd, roots) && inWorkspace(resolveExternalWorktreeSourceCwd(cwd), roots)) {
    allowed.push(cwd);
  }
  return allowed;
}

export function worktreesRoot(env = process.env) {
  const override = env.GEMPT_WORKTREES_DIR?.trim();
  const base = process.platform === 'win32' ? env.LOCALAPPDATA || tmpdir() : join(homedir(), '.cache');
  return resolvePath(override || join(base, 'gempt-worktrees'));
}

function git(cwd, args, env, timeout = 30_000) {
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync('git', ['-C', cwd, '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args], {
    encoding: 'utf8', env: gitEnv, timeout, windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function gitPath(cwd, flag, env) {
  const result = git(cwd, ['rev-parse', '--path-format=absolute', flag], env);
  return result.status === 0 && result.stdout.trim() ? resolvePath(result.stdout.trim()) : null;
}

export function assertShareWorktree(sourceCwd, path, env = process.env) {
  const root = worktreesRoot(env);
  const target = resolvePath(path);
  const sourceCommon = gitPath(sourceCwd, '--git-common-dir', env);
  const gitDir = gitPath(target, '--git-dir', env);
  if (target === root || !withinPath(target, root) || !sourceCommon || !gitDir
      || gitDir === join(sourceCommon, 'worktrees') || !withinPath(gitDir, join(sourceCommon, 'worktrees'))
      || gitPath(target, '--git-common-dir', env) !== sourceCommon
      || gitPath(target, '--show-toplevel', env) !== target) {
    throw new Error(`Worktree does not belong to the requested Git repository: ${path}`);
  }
  return target;
}

export function ensureShareWorktree(cwd, sessionId, env = process.env) {
  const sid = validateSessionId(sessionId);
  const sourceCwd = resolvePath(cwd);
  if (!statSync(sourceCwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`\`cwd\` does not exist or is not a directory: ${sourceCwd}`);
  }
  const repoRoot = gitPath(sourceCwd, '--show-toplevel', env);
  if (!repoRoot) throw new Error(`workspace='share' requires a Git repository: ${sourceCwd}`);
  const root = worktreesRoot(env);
  mkdirSync(root, { recursive: true });
  const worktreeRoot = join(root, sid);
  const existing = lstatSync(worktreeRoot, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Invalid worktree target path.');
  if (!existing) {
    const add = git(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD'], env, 60_000);
    if (add.status !== 0) throw new Error(`Failed to create isolated git worktree: ${(add.stderr || add.stdout).trim()}`);
  }
  assertShareWorktree(repoRoot, worktreeRoot, env);
  const subdir = withinPath(sourceCwd, repoRoot) ? relative(repoRoot, sourceCwd) : '';
  const worktreeCwd = resolvePath(join(worktreeRoot, subdir));
  return {
    worktree_root: worktreeRoot,
    cwd: withinPath(worktreeCwd, worktreeRoot) && statSync(worktreeCwd, { throwIfNoEntry: false })?.isDirectory() ? worktreeCwd : worktreeRoot,
    source_repo: repoRoot,
    source_cwd: sourceCwd,
  };
}

export function syncPrunedWorktreeSessions(sourceRepo, worktreeRoot, sessionsDir) {
  const updated = [];
  if (!sessionsDir) return updated;
  const repoRoot = resolvePath(sourceRepo);
  const target = resolvePath(worktreeRoot);
  let entries;
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return updated;
    throw error;
  }
  const nowIso = new Date().toISOString();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(sessionsDir, entry.name);
    let session;
    try {
      session = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
    const wtPath = typeof session.worktree_path === 'string' && session.worktree_path.trim()
      ? resolvePath(session.worktree_path) : '';
    const cwdPath = typeof session.cwd === 'string' && session.cwd.trim()
      ? resolvePath(session.cwd) : '';
    const refsWorktree = (wtPath && sameOrWithin(wtPath, target)) || (cwdPath && sameOrWithin(cwdPath, target));
    if (!refsWorktree) continue;
    let fallbackCwd = repoRoot;
    if (typeof session.source_cwd === 'string' && session.source_cwd.trim()) {
      const src = resolvePath(session.source_cwd);
      if (sameOrWithin(src, repoRoot) && statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
        fallbackCwd = src;
      }
    } else if (cwdPath && sameOrWithin(cwdPath, target)) {
      const subdir = relative(target, cwdPath);
      const mapped = resolvePath(join(repoRoot, subdir));
      if (sameOrWithin(mapped, repoRoot) && statSync(mapped, { throwIfNoEntry: false })?.isDirectory()) {
        fallbackCwd = mapped;
      }
    }
    atomicJson(file, {
      ...session,
      cwd: fallbackCwd,
      worktree_path: null,
      worktree_pruned_at: nowIso,
      pruned_worktree_path: session.worktree_path || target,
      updated_at: nowIso,
    });
    updated.push(session.session_id || entry.name.slice(0, -5));
  }
  return updated;
}

export function removeShareWorktree(sourceRepo, worktreeRoot, env = process.env, { sessionsDir } = {}) {
  const root = worktreesRoot(env);
  if (!lstatSync(worktreeRoot, { throwIfNoEntry: false })?.isDirectory()) return false;
  const target = resolvePath(worktreeRoot);
  if (target === root || !withinPath(target, root)) return false;
  assertShareWorktree(sourceRepo, target, env);
  const source = resolvePath(sourceRepo);
  const status = git(target, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], env);
  const head = git(target, ['rev-parse', 'HEAD'], env);
  if (status.status !== 0 || status.stdout || head.status !== 0
      || git(source, ['merge-base', '--is-ancestor', head.stdout.trim(), 'HEAD'], env).status !== 0) return false;
  const removed = git(source, ['worktree', 'remove', target], env).status === 0;
  if (removed) {
    const repoRoot = gitPath(source, '--show-toplevel', env) || source;
    syncPrunedWorktreeSessions(repoRoot, target, sessionsDir ?? resolveSessionsDir(env.GEMPT_SESSIONS_DIR));
  }
  return removed;
}

export function pruneShareWorktrees(sourceRepo, { activePaths = new Set(), maxAgeMs = 7 * 24 * 3600 * 1000, env = process.env,
  sessionsDir = resolveSessionsDir(env.GEMPT_SESSIONS_DIR) } = {}) {
  const root = worktreesRoot(env);
  const repoRoot = gitPath(resolvePath(sourceRepo), '--show-toplevel', env);
  if (!repoRoot) return { removed: [], kept: [] };
  const active = new Set([...activePaths].filter(Boolean).map((p) => resolvePath(p)));
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return { removed: [], kept: [] };
    throw error;
  }
  const removed = [];
  const kept = [];
  const nowMs = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = resolvePath(join(root, entry.name));
    try {
      assertShareWorktree(repoRoot, candidate, env);
    } catch {
      continue;
    }
    const stat = statSync(candidate, { throwIfNoEntry: false });
    if (active.has(candidate) || (maxAgeMs > 0 && stat && nowMs - stat.mtimeMs < maxAgeMs)) {
      kept.push(candidate);
      continue;
    }
    const pruned = withLockSync(join(sessionsDir, `${entry.name}.dispatch.lock`), () => {
      const busy = listActiveRoster({ limit: Infinity, sessionsDir, includeUnconfirmed: true }).some(({ worktree_path: path, cwd: runCwd }) =>
        (path && sameOrWithin(resolvePath(path), candidate)) || (runCwd && sameOrWithin(resolvePath(runCwd), candidate)));
      return !busy && removeShareWorktree(repoRoot, candidate, env, { sessionsDir });
    }, { staleMs: 120_000 });
    if (pruned) removed.push(candidate);
    else kept.push(candidate);
  }
  git(repoRoot, ['worktree', 'prune'], env);
  return { removed, kept };
}

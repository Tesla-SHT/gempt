import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolvePath, validateSessionId, withinPath } from './state.mjs';

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

export function removeShareWorktree(sourceRepo, worktreeRoot, env = process.env) {
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
  return git(source, ['worktree', 'remove', target], env).status === 0;
}

export function pruneShareWorktrees(sourceRepo, { activePaths = new Set(), maxAgeMs = 7 * 24 * 3600 * 1000, env = process.env } = {}) {
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
    if (removeShareWorktree(repoRoot, candidate, env)) removed.push(candidate);
    else kept.push(candidate);
  }
  git(repoRoot, ['worktree', 'prune'], env);
  return { removed, kept };
}

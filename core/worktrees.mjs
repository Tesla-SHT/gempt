import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolvePath, validateSessionId, withinPath } from './state.mjs';

export function worktreesRoot(env = process.env) {
  const override = env.GEMPT_WORKTREES_DIR?.trim();
  const base = process.platform === 'win32' ? env.LOCALAPPDATA || tmpdir() : join(homedir(), '.cache');
  return resolvePath(override || join(base, 'gempt-worktrees'));
}

function git(cwd, args, env, timeout = 30_000) {
  const result = spawnSync('git', ['-C', cwd, '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', env, timeout, windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

export function ensureShareWorktree(cwd, sessionId, env = process.env) {
  const sid = validateSessionId(sessionId);
  const sourceCwd = resolvePath(cwd);
  if (!statSync(sourceCwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`\`cwd\` does not exist or is not a directory: ${sourceCwd}`);
  }
  const top = git(sourceCwd, ['rev-parse', '--show-toplevel'], env);
  if (top.status !== 0 || !top.stdout.trim()) throw new Error(`workspace='share' requires a Git repository: ${sourceCwd}`);
  const repoRoot = resolvePath(top.stdout.trim());
  const root = worktreesRoot(env);
  mkdirSync(root, { recursive: true });
  const worktreeRoot = resolvePath(join(root, sid));
  if (!withinPath(worktreeRoot, root) || worktreeRoot === root) throw new Error('Invalid worktree target path.');
  if (!statSync(worktreeRoot, { throwIfNoEntry: false })?.isDirectory()) {
    const add = git(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD'], env, 60_000);
    if (add.status !== 0) throw new Error(`Failed to create isolated git worktree: ${(add.stderr || add.stdout).trim()}`);
  }
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
  const path = resolvePath(worktreeRoot);
  const root = worktreesRoot(env);
  if (path === root || !withinPath(path, root) || !existsSync(path)) return false;
  return git(resolvePath(sourceRepo), ['worktree', 'remove', '--force', path], env).status === 0;
}

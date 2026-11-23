#!/usr/bin/env node
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePluginBundle, validatePluginBundle } from '../core/agy-install.mjs';
import { resolveNodeExecutable } from '../core/node-executable.mjs';
import { resolvePath, withinPath } from '../core/state.mjs';

const ROOT = resolvePath(fileURLToPath(new URL('../', import.meta.url)));
const PROTECTED_REPO_SUBDIRS = [
  '.git',
  'bin',
  'core',
  'magpie_plugin',
  'mcp_app',
  'plugin',
  'scripts',
  'templates',
  'tests',
];

export function parseOutArg(argv) {
  let outArg = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing output directory after ${arg}.`);
      }
      outArg = next;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) throw new Error('Missing output directory after --out=.');
      outArg = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!outArg) {
      outArg = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }
  return outArg;
}

export function assertSafeOutDir(outDir, {
  root = ROOT,
  nodeBin = resolveNodeExecutable(),
  home = homedir(),
  tmp = tmpdir(),
  cwd = process.cwd(),
} = {}) {
  const resolvedOut = resolvePath(outDir);
  if (dirname(resolvedOut) === resolvedOut) {
    throw new Error(`Refusing dangerous output directory (filesystem root): ${resolvedOut}`);
  }
  const resolvedRoot = resolvePath(root);
  const protectedAncestors = [
    resolvedRoot,
    nodeBin ? resolvePath(nodeBin) : null,
    home ? resolvePath(home) : null,
    tmp ? resolvePath(tmp) : null,
    cwd ? resolvePath(cwd) : null,
    process.platform === 'win32' && process.env.SystemRoot ? resolvePath(process.env.SystemRoot) : null,
  ].filter(Boolean);
  for (const target of protectedAncestors) {
    if (withinPath(target, resolvedOut)) {
      throw new Error(`Refusing dangerous output directory ${resolvedOut} (contains or equals protected path ${target}).`);
    }
  }
  for (const subdir of PROTECTED_REPO_SUBDIRS) {
    const protectedSub = join(resolvedRoot, subdir);
    if (withinPath(resolvedOut, protectedSub) || withinPath(protectedSub, resolvedOut)) {
      throw new Error(`Refusing dangerous output directory ${resolvedOut} (overlaps repository directory ${protectedSub}).`);
    }
  }
  return resolvedOut;
}

export async function buildAgyPlugin({
  outDir = join(ROOT, 'dist', 'agy-plugin'),
  root = ROOT,
  env = process.env,
  nodeBin = resolveNodeExecutable({ env }),
} = {}) {
  const resolvedOut = assertSafeOutDir(outDir, { root, nodeBin });
  const parent = dirname(resolvedOut);
  mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, `.${basename(resolvedOut)}-build-`));
  const staged = join(workspace, 'bundle');
  const backup = join(workspace, 'previous');
  let keepBackup = false;
  try {
    stagePluginBundle(staged, { source: root, portable: true });
    await validatePluginBundle(staged, nodeBin, env, { portable: true });
    try {
      if (lstatSync(resolvedOut, { throwIfNoEntry: false })) {
        renameSync(resolvedOut, backup);
      }
      renameSync(staged, resolvedOut);
    } catch (error) {
      if (lstatSync(backup, { throwIfNoEntry: false })) {
        try {
          renameSync(backup, resolvedOut);
        } catch (restoreError) {
          keepBackup = true;
          throw new Error(
            `Could not restore ${resolvedOut}. Previous bundle saved at ${backup}.`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
    return resolvedOut;
  } finally {
    if (!keepBackup) {
      try { rmSync(workspace, { recursive: true, force: true }); } catch {}
    }
  }
}

const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (isMain) {
  const outArg = parseOutArg(process.argv.slice(2));
  const outDir = await buildAgyPlugin({ outDir: outArg || join(ROOT, 'dist', 'agy-plugin') });
  console.log(`Built portable Antigravity plugin bundle at ${outDir}`);
}

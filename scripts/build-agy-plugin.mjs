#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePluginBundle, validatePluginBundle } from '../core/agy-install.mjs';
import { resolveNodeExecutable } from '../core/node-executable.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const outArg = process.argv[2];
const outDir = resolve(outArg || join(ROOT, 'dist', 'agy-plugin'));

rmSync(outDir, { recursive: true, force: true });
stagePluginBundle(outDir, { source: ROOT, portable: true });
await validatePluginBundle(outDir, resolveNodeExecutable(), process.env, { portable: true });
console.log(`Built portable Antigravity plugin bundle at ${outDir}`);

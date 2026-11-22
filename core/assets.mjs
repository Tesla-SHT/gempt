import { readFileSync } from 'node:fs';

function readWorkload() {
  try {
    return readFileSync(new URL('./assets/workload.json', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return readFileSync(new URL('../src/gempt/workload.json', import.meta.url), 'utf8');
  }
}

export const WORKLOAD = JSON.parse(readWorkload());

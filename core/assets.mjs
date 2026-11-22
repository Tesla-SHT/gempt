import { readFileSync } from 'node:fs';

export const WORKLOAD = JSON.parse(readFileSync(new URL('./assets/workload.json', import.meta.url), 'utf8'));

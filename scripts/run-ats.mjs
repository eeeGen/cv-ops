#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAtsGate } from '../src/ats/gate.mjs';

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const workspacePath = value('--workspace');
const runId = value('--run-id');
const inputPath = value('--input');
const keywordText = value('--keywords') ?? '';
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!workspacePath || !runId || !inputPath) {
  console.error('Usage: node scripts/run-ats.mjs --workspace <path> --run-id <id> --input <private/path.html> [--keywords a,b]');
  process.exitCode = 1;
} else {
  const result = await runAtsGate({ workspacePath: resolve(workspacePath), pluginRoot, runId, inputPath, keywords: keywordText ? keywordText.split(',') : [] });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'ready' ? 0 : 1;
}

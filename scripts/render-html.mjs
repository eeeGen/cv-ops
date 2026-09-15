#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtmlForAts } from '../src/ats/render.mjs';
import { assertSafeDirectoryPath, validateWorkspaceTarget } from '../src/workspace/validate.mjs';

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const workspacePath = value('--workspace');
const inputPath = value('--input');
const outputPath = value('--output');
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRelative = (value) => typeof value === 'string' && !value.includes('\0') && value.replaceAll('\\', '/').split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':')) && value.replaceAll('\\', '/').startsWith('private/');
if (!workspacePath || !privateRelative(inputPath) || !privateRelative(outputPath)) {
  console.error('Usage: node scripts/render-html.mjs --workspace <path> --input <private/input.html> --output <private/output.png>');
  process.exitCode = 1;
} else {
  const workspace = await validateWorkspaceTarget({ workspacePath: resolve(workspacePath), pluginRoot });
  const input = join(workspace.workspacePath ?? '', ...inputPath.split('/'));
  const output = join(workspace.workspacePath ?? '', ...outputPath.split('/'));
  try {
    if (workspace.status === 'blocked') throw new Error(workspace.reason);
    await assertSafeDirectoryPath(workspace.workspacePath, inputPath.split('/').slice(0, -1).join('/'));
    await assertSafeDirectoryPath(workspace.workspacePath, outputPath.split('/').slice(0, -1).join('/'));
    const metadata = await lstat(input);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('ATS_INPUT_PATH_UNSAFE');
    const handle = await open(input, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let htmlBytes;
    try { htmlBytes = await handle.readFile(); } finally { await handle.close(); }
    const result = await renderHtmlForAts({ htmlBytes });
    if (result.status !== 'ready') throw new Error(result.reason);
    const outputHandle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
    try { await outputHandle.writeFile(result.screenshot); } finally { await outputHandle.close(); }
    console.log(JSON.stringify({ status: 'ready', renderedTextCharacters: result.inspection.text.length }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', reason: error?.message ?? 'ATS_RENDER_BLOCKED' }));
    process.exitCode = 1;
  }
}

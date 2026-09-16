#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeWorkspace } from '../src/workspace/initialize.mjs';

const args = process.argv.slice(2);

function usageResult(message) {
  return {
    status: 'blocked',
    reason: 'WORKSPACE_ARGUMENT_REQUIRED',
    nextAction: '使用 npm run init-workspace -- --workspace <已有空目录>。',
    issues: [{ code: 'WORKSPACE_ARGUMENT_REQUIRED', message }],
  };
}

function workspaceArgument(argumentsList) {
  const index = argumentsList.indexOf('--workspace');
  if (index === -1 || !argumentsList[index + 1] || argumentsList[index + 1].startsWith('--')) {
    return null;
  }
  return argumentsList.length === 2 && index === 0 ? argumentsList[index + 1] : undefined;
}

const workspacePath = workspaceArgument(args);
if (workspacePath === undefined) {
  const result = usageResult('只支持一个 --workspace <path> 参数。');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 2;
} else if (!workspacePath) {
  const result = usageResult('必须显式提供已有的空 --workspace 目录；初始化器不使用默认路径。');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 2;
} else {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await initializeWorkspace({ workspacePath, pluginRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'ready' ? 0 : 1;
}

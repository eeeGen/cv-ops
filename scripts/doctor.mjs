import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateDoctor, isPathWithin } from '../src/contracts/doctor.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

function usageResult(message) {
  return {
    status: 'blocked',
    checks: [],
    nextAction: '使用 npm run doctor -- --workspace <已有候选人工作区目录>。',
    issues: [{ code: 'WORKSPACE_ARGUMENT_REQUIRED', message }],
  };
}

function readWorkspaceArgument(argumentsList) {
  const index = argumentsList.indexOf('--workspace');
  if (index === -1 || !argumentsList[index + 1] || argumentsList[index + 1].startsWith('--')) {
    return null;
  }
  if (argumentsList.length !== 2 || index !== 0) {
    throw new Error('只支持一个 --workspace <path> 参数。');
  }
  return argumentsList[index + 1];
}

function probePython() {
  for (const command of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const argumentsList = command === 'py' ? ['-3', '--version'] : ['--version'];
    const result = spawnSync(command, argumentsList, { encoding: 'utf8', windowsHide: true });
    const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (!result.error && result.status === 0 && /^Python 3\./.test(version)) {
      return { available: true, command, version };
    }
  }
  return { available: false };
}

function probePlaywright() {
  try {
    return { available: true, path: require.resolve('playwright') };
  } catch {
    return { available: false };
  }
}

async function probeChromium(playwright) {
  if (!playwright.available) {
    return { available: false };
  }

  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    return { available: Boolean(path && existsSync(path)), path: path || null };
  } catch {
    return { available: false };
  }
}

function probeWorkspace(workspace) {
  try {
    const resolvedWorkspace = realpathSync(workspace);
    if (!statSync(resolvedWorkspace).isDirectory()) {
      return { available: false, path: workspace };
    }
    accessSync(resolvedWorkspace, constants.R_OK | constants.W_OK);
    return {
      available: true,
      path: resolvedWorkspace,
      readable: true,
      writable: true,
      insidePluginRoot: isPathWithin(pluginRoot, resolvedWorkspace),
    };
  } catch {
    return { available: false, path: workspace };
  }
}

async function main() {
  let workspace;
  try {
    workspace = readWorkspaceArgument(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify(usageResult(error.message), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  if (!workspace) {
    process.stdout.write(`${JSON.stringify(usageResult('必须显式提供已有的 --workspace 路径；doctor 不使用默认私有路径。'), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const playwright = probePlaywright();
  const report = evaluateDoctor({
    node: { available: true, version: process.version, path: process.execPath },
    python: probePython(),
    playwright,
    chromium: await probeChromium(playwright),
    workspace: probeWorkspace(workspace),
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'ready' ? 0 : 1;
}

await main();

/**
 * @typedef {'ready' | 'blocked'} DoctorStatus
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

const missingCheck = (name, code, impact, nextAction) => ({
  name,
  status: 'blocked',
  code,
  detected: null,
  impact,
  nextAction,
});

const readyCheck = (name, detected) => ({
  name,
  status: 'ready',
  code: null,
  detected,
  impact: null,
  nextAction: null,
});

const versionMajor = (version) => Number.parseInt(String(version).replace(/^v/, '').split('.')[0], 10);

/**
 * Checks a canonical candidate path against a canonical plugin repository root.
 * Callers must resolve symbolic links before invoking this helper.
 *
 * @param {string} pluginRoot
 * @param {string} candidatePath
 * @returns {boolean}
 */
export function isPathWithin(pluginRoot, candidatePath) {
  const pathFromRoot = relative(resolve(pluginRoot), resolve(candidatePath));
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

/**
 * Converts environment probes into the public, machine-readable doctor result.
 * Probes intentionally contain no candidate content and this function has no I/O.
 *
 * @param {object} probes
 * @returns {{status: DoctorStatus, checks: object[], nextAction: string | null}}
 */
export function evaluateDoctor(probes) {
  const checks = [];
  const nodeMajor = versionMajor(probes.node?.version);

  if (!probes.node?.available) {
    checks.push(missingCheck(
      'node',
      'NODE_MISSING',
      '无法运行 CV-ops 的本地脚本。',
      '安装受支持的 Node.js（22 或更高版本）后重新运行 doctor。',
    ));
  } else if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    checks.push(missingCheck(
      'node',
      'NODE_UNSUPPORTED',
      '当前 Node.js 版本不受支持，脚本不会被视为可运行。',
      '升级到 Node.js 22 或更高版本后重新运行 doctor。',
    ));
  } else {
    checks.push(readyCheck('node', { version: probes.node.version, path: probes.node.path }));
  }

  if (!probes.python?.available) {
    checks.push(missingCheck(
      'python',
      'PYTHON_MISSING',
      '无法执行必须原样调用的 Python 上游校验路径。',
      '安装可从 PATH 调用的 Python 3 后重新运行 doctor。',
    ));
  } else {
    checks.push(readyCheck('python', {
      version: probes.python.version,
      command: probes.python.command,
    }));
  }

  if (!probes.playwright?.available) {
    checks.push(missingCheck(
      'playwright',
      'PLAYWRIGHT_MISSING',
      '无法启动真实浏览器渲染，因此不能执行渲染后的 ATS 门禁。',
      '在插件目录安装 Playwright 后重新运行 doctor。',
    ));
  } else {
    checks.push(readyCheck('playwright', { path: probes.playwright.path }));
  }

  if (!probes.chromium?.available) {
    checks.push(missingCheck(
      'chromium',
      'CHROMIUM_MISSING',
      '无法实际渲染 HTML；任何 ATS 结果都必须保持未执行或 blocked。',
      '运行 npx playwright install chromium 后重新运行 doctor。',
    ));
  } else {
    checks.push(readyCheck('chromium', { path: probes.chromium.path }));
  }

  if (!probes.workspace?.available) {
    checks.push(missingCheck(
      'workspace',
      'WORKSPACE_MISSING',
      '没有可检查的候选人工作区，诊断不会创建任何候选人文件。',
      '传入一个已存在的候选人工作区目录：--workspace <path>。',
    ));
  } else if (probes.workspace.insidePluginRoot) {
    checks.push(missingCheck(
      'workspace',
      'WORKSPACE_INSIDE_PLUGIN_REPOSITORY',
      '候选人工作区位于公开插件仓库内，继续使用可能使私有材料进入公开仓库。',
      '选择插件仓库外的已有、可读写候选人工作区后重新运行 doctor。',
    ));
  } else if (!probes.workspace.readable || !probes.workspace.writable) {
    checks.push(missingCheck(
      'workspace',
      'WORKSPACE_NOT_READ_WRITE',
      '候选人工作区无法同时读取和写入，后续流程不能安全运行。',
      '调整该目录权限或选择另一个已有且可读写的工作区。',
    ));
  } else {
    checks.push(readyCheck('workspace', {
      path: probes.workspace.path,
      readable: true,
      writable: true,
    }));
  }

  const blocked = checks.filter((check) => check.status === 'blocked');
  return {
    status: blocked.length === 0 ? 'ready' : 'blocked',
    checks,
    nextAction: blocked.length === 0
      ? null
      : '完成所有 blocked 检查中的 nextAction 后，使用相同的 --workspace 路径重新运行 doctor。',
  };
}

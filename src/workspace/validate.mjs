import { access, constants, lstat, realpath, readdir, stat } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

import { isPathWithin } from '../contracts/doctor.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

export class UnsafeWorkspacePathError extends Error {}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function assertSafeDirectoryPath(root, relativePath = '') {
  const parts = relativePath === '' ? [] : relativePath.split('/');
  let expectedPath = root;
  const checkedPaths = [expectedPath];
  for (const part of parts) {
    expectedPath = join(expectedPath, part);
    checkedPaths.push(expectedPath);
  }

  for (const path of checkedPaths) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(path, await realpath(path))) {
      throw new UnsafeWorkspacePathError(`Unsafe workspace directory: ${path}`);
    }
  }
}

export async function validateWorkspaceTarget({ workspacePath, pluginRoot }, { realpath: resolvePath = realpath } = {}) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    return blocked('WORKSPACE_PATH_REQUIRED', '提供一个已存在的、位于插件仓库外的空目录。');
  }
  if (typeof pluginRoot !== 'string' || pluginRoot.trim() === '') {
    return blocked('PLUGIN_ROOT_INVALID', '从已安装的 CV-ops 插件目录重新运行初始化。');
  }

  let plugin;
  try {
    plugin = await resolvePath(pluginRoot);
  } catch {
    return blocked('PLUGIN_ROOT_INVALID', '从已安装的 CV-ops 插件目录重新运行初始化。');
  }

  let workspace;
  try {
    workspace = await resolvePath(workspacePath);
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return blocked('WORKSPACE_NOT_READ_WRITE', '调整目录权限，或选择另一个可读写的空目录。');
    }
    return blocked('WORKSPACE_PATH_INVALID', '提供一个已存在的、位于插件仓库外的空目录。');
  }

  if (parse(workspace).root === workspace) {
    return blocked('WORKSPACE_ROOT_FORBIDDEN', '选择一个专用的候选人工作区目录，而不是文件系统根目录。');
  }
  if (isPathWithin(plugin, workspace)) {
    return blocked('WORKSPACE_INSIDE_PLUGIN_REPOSITORY', '选择插件仓库外的空目录作为候选人工作区。');
  }

  try {
    const metadata = await stat(workspace);
    if (!metadata.isDirectory()) {
      return blocked('WORKSPACE_NOT_DIRECTORY', '提供一个已存在的、位于插件仓库外的空目录。');
    }
    await access(workspace, constants.R_OK | constants.W_OK);
  } catch {
    return blocked('WORKSPACE_NOT_READ_WRITE', '调整目录权限，或选择另一个可读写的空目录。');
  }

  return { status: 'ready', workspacePath: workspace, pluginRoot: plugin };
}

export async function validateEmptyWorkspace(target) {
  try {
    const entries = await readdir(target.workspacePath);
    if (entries.length > 0) {
      return blocked('WORKSPACE_NOT_EMPTY', '选择一个空目录，避免覆盖现有文件。');
    }
  } catch {
    return blocked('WORKSPACE_NOT_READ_WRITE', '调整目录权限，或选择另一个可读写的空目录。');
  }
  return target;
}

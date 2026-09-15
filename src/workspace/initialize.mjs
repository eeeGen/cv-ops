import { lstat, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PRIVATE_DIRECTORIES, PRIVATE_FILES, WORKSPACE_GITIGNORE } from '../contracts/workspace.mjs';
import { acquireDirectoryLocks } from './directory-lock.mjs';
import { assertSafeDirectoryPath, UnsafeWorkspacePathError, validateEmptyWorkspace, validateWorkspaceTarget } from './validate.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

async function rollbackCreatedPaths(root, files, directories) {
  for (const relativeFile of [...files].reverse()) {
    try {
      await assertSafeDirectoryPath(root, dirname(relativeFile).replaceAll('\\', '/'));
      const metadata = await lstat(join(root, relativeFile));
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        await rm(join(root, relativeFile));
      }
    } catch {}
  }
  for (const relativeDirectory of [...directories].reverse()) {
    try {
      const parent = dirname(relativeDirectory).replaceAll('\\', '/');
      await assertSafeDirectoryPath(root, parent === '.' ? '' : parent);
      const metadata = await lstat(join(root, relativeDirectory));
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        await rmdir(join(root, relativeDirectory));
      }
    } catch {}
  }
}

export async function initializeWorkspace({ workspacePath, pluginRoot }, { beforeCreate = async () => {} } = {}) {
  const validated = await validateWorkspaceTarget({ workspacePath, pluginRoot });
  if (validated.status === 'blocked') {
    return validated;
  }
  const empty = await validateEmptyWorkspace(validated);
  if (empty.status === 'blocked') {
    return empty;
  }
  if (process.platform !== 'win32') {
    return blocked('WORKSPACE_ATOMIC_WRITE_UNAVAILABLE', '当前平台无法安全锁定工作区目录；请在受支持的 Windows 环境中初始化。');
  }

  const createdFiles = [];
  const createdDirectories = [];
  let lockSession;
  const lockDirectory = async (relativePath = '') => {
    await assertSafeDirectoryPath(empty.workspacePath, relativePath);
    if (!lockSession) {
      lockSession = await acquireDirectoryLocks([join(empty.workspacePath, relativePath)]);
    } else {
      await lockSession.lock(join(empty.workspacePath, relativePath));
    }
    await assertSafeDirectoryPath(empty.workspacePath, relativePath);
  };
  try {
    await beforeCreate({ workspacePath: empty.workspacePath });
    await lockDirectory();
    for (const relativeDirectory of PRIVATE_DIRECTORIES) {
      const parent = dirname(relativeDirectory).replaceAll('\\', '/');
      await assertSafeDirectoryPath(empty.workspacePath, parent === '.' ? '' : parent);
      await mkdir(join(empty.workspacePath, relativeDirectory));
      createdDirectories.push(relativeDirectory);
      await lockDirectory(relativeDirectory);
    }
    for (const relativeFile of PRIVATE_FILES) {
      const parent = dirname(relativeFile).replaceAll('\\', '/');
      await assertSafeDirectoryPath(empty.workspacePath, parent === '.' ? '' : parent);
      await writeFile(join(empty.workspacePath, relativeFile), '', { encoding: 'utf8', flag: 'wx' });
      createdFiles.push(relativeFile);
    }
    await assertSafeDirectoryPath(empty.workspacePath);
    await writeFile(join(empty.workspacePath, '.gitignore'), WORKSPACE_GITIGNORE, { encoding: 'utf8', flag: 'wx' });
    createdFiles.push('.gitignore');
  } catch (error) {
    await lockSession?.release();
    await rollbackCreatedPaths(empty.workspacePath, createdFiles, createdDirectories);
    if (error instanceof UnsafeWorkspacePathError) {
      return blocked('WORKSPACE_PATH_UNSAFE', '使用未被符号链接或联接重定向的空候选人工作区。');
    }
    if (error?.code === 'EBUSY') {
      return blocked('WORKSPACE_PATH_UNSAFE', '工作区目录在初始化期间发生变化；请选择未被其他进程修改的空目录。');
    }
    if (error?.message?.includes('Directory lock')) {
      return blocked('WORKSPACE_ATOMIC_WRITE_UNAVAILABLE', '无法安全锁定工作区目录；请选择可删除且未被占用的目录后重试。');
    }
    return blocked('WORKSPACE_INITIALIZATION_FAILED', '确认目录未被其他进程修改且可写，然后使用新的空目录重试。');
  }

  await lockSession.release();
  return { status: 'ready', workspacePath: empty.workspacePath };
}

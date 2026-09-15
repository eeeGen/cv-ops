import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { acquireDirectoryLocks } from './directory-lock.mjs';
import { assertSafeDirectoryPath, UnsafeWorkspacePathError, validateWorkspaceTarget } from './validate.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

/**
 * Writes a new, private resume artifact. Names are generated from a validated
 * resume id by the caller; no source filename or candidate text participates in
 * the destination path. O_EXCL makes the archived original immutable.
 */
export async function storeResumeArtifact({ workspacePath, pluginRoot, relativePath, bytes }) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('private/resumes/')
    || relativePath.includes('..') || relativePath.includes('\\') || !Buffer.isBuffer(bytes)) {
    return blocked('RESUME_ARTIFACT_INVALID', '使用由简历契约生成的私有相对路径和字节内容。');
  }
  const workspace = await validateWorkspaceTarget({ workspacePath, pluginRoot });
  if (workspace.status === 'blocked') {
    return workspace;
  }

  const parent = dirname(relativePath).replaceAll('\\', '/');
  let locks;
  try {
    await assertSafeDirectoryPath(workspace.workspacePath, 'private');
    await assertSafeDirectoryPath(workspace.workspacePath, 'private/resumes');
    await assertSafeDirectoryPath(workspace.workspacePath, parent);
    locks = await acquireDirectoryLocks([
      workspace.workspacePath,
      join(workspace.workspacePath, 'private'),
      join(workspace.workspacePath, 'private/resumes'),
      join(workspace.workspacePath, parent),
    ]);
    await assertSafeDirectoryPath(workspace.workspacePath, 'private');
    await assertSafeDirectoryPath(workspace.workspacePath, 'private/resumes');
    await assertSafeDirectoryPath(workspace.workspacePath, parent);

    const artifactPath = join(workspace.workspacePath, relativePath);
    const handle = await open(artifactPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    const metadata = await lstat(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return blocked('RESUME_ARTIFACT_PATH_UNSAFE', '使用未被符号链接或联接重定向的候选人工作区。');
    }
    return { status: 'ready', path: artifactPath, relativePath };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return blocked('RESUME_ARTIFACT_ALREADY_EXISTS', '使用新的 resumeId；归档原件和规范化输出不会被覆盖。');
    }
    if (error instanceof UnsafeWorkspacePathError || error?.code === 'ELOOP' || error?.code === 'EBUSY') {
      return blocked('RESUME_ARTIFACT_PATH_UNSAFE', '使用未被符号链接或联接重定向的候选人工作区。');
    }
    return blocked('RESUME_ARTIFACT_WRITE_FAILED', '确认候选人工作区 private/resumes 目录可写后重试。');
  } finally {
    await locks?.release();
  }
}

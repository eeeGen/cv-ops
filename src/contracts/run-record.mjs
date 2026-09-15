import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireDirectoryLocks } from '../workspace/directory-lock.mjs';
import { assertSafeDirectoryPath, UnsafeWorkspacePathError, validateWorkspaceTarget } from '../workspace/validate.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[A-Fa-f0-9]{64}$/;
const VERSION = /^[A-Fa-f0-9]{7,64}$/;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9_-]{0,63}$/;
const BLOCK_REASONS = new Set([
  'ATS_FAILED',
  'ATS_NOT_EXECUTED',
  'DEPENDENCY_MISSING',
  'FACT_CONFLICT',
  'INPUT_UNAVAILABLE',
  'PARSE_FAILED',
  'RENDER_FAILED',
  'SOURCE_UNAVAILABLE',
  'UNSAFE_PATH',
]);

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

function isPrivateRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return false;
  }
  const parts = value.replaceAll('\\', '/').split('/');
  return parts[0] === 'private'
    && parts.length > 1
    && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':'));
}

function hasSafeSource(source) {
  return source
    && (isPrivateRelativePath(source.source) || SOURCE_ID.test(source.source))
    && SHA256.test(source.sha256);
}

function validateRun(run, now) {
  if (!run || !RUN_ID.test(run.runId ?? '')) {
    return blocked('RUN_RECORD_INVALID_RUN_ID', '使用仅含字母、数字、连字符或下划线的 runId。');
  }
  if (!Array.isArray(run.inputSources) || run.inputSources.length === 0 || !run.inputSources.every(hasSafeSource)) {
    return blocked('RUN_RECORD_INVALID_INPUT_SOURCE', '为每个输入提供不含换行的来源标识和 SHA-256 哈希。');
  }
  if (!run.upstreamVersions || typeof run.upstreamVersions !== 'object'
    || Array.isArray(run.upstreamVersions) || Object.keys(run.upstreamVersions).length === 0
    || !Object.entries(run.upstreamVersions).every(([name, version]) => name.length > 0 && VERSION.test(version))) {
    return blocked('RUN_RECORD_INVALID_UPSTREAM_VERSION', '记录每个已用上游的名称和固定提交 SHA。');
  }
  if (!Array.isArray(run.artifactPaths) || !run.artifactPaths.every(isPrivateRelativePath)) {
    return blocked('RUN_RECORD_INVALID_ARTIFACT_PATH', '仅记录位于 private/ 下的相对产物路径。');
  }
  if (run.status !== 'complete' && run.status !== 'blocked') {
    return blocked('RUN_RECORD_INVALID_STATUS', '将运行状态设为 complete 或 blocked。');
  }
  if (run.status === 'blocked' && !BLOCK_REASONS.has(run.reason)) {
    return blocked('RUN_RECORD_BLOCK_REASON_REQUIRED', '为 blocked 运行记录一个简短的结构化原因。');
  }

  const timestamp = now();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
    return blocked('RUN_RECORD_INVALID_TIMESTAMP', '使用有效的系统时间创建运行记录。');
  }

  return {
    status: 'ready',
    record: {
      runId: run.runId,
      timestamp: timestamp.toISOString(),
      inputSources: run.inputSources,
      upstreamVersions: run.upstreamVersions,
      artifactPaths: run.artifactPaths,
      status: run.status,
      ...(run.status === 'blocked' ? { reason: run.reason } : {}),
    },
  };
}

export async function createRunRecord({ workspacePath, pluginRoot, run, now = () => new Date() }, { beforeRecordWrite = async () => {} } = {}) {
  const workspace = await validateWorkspaceTarget({ workspacePath, pluginRoot });
  if (workspace.status === 'blocked') {
    return workspace;
  }
  const validated = validateRun(run, now);
  if (validated.status === 'blocked') {
    return validated;
  }
  if (process.platform !== 'win32') {
    return blocked('WORKSPACE_ATOMIC_WRITE_UNAVAILABLE', '当前平台无法安全锁定工作区目录；请在受支持的 Windows 环境中创建运行记录。');
  }
  try {
    await assertSafeDirectoryPath(workspace.workspacePath, 'private');
    await assertSafeDirectoryPath(workspace.workspacePath, 'private/runs');
  } catch {
    return blocked('WORKSPACE_PRIVATE_LAYOUT_INVALID', '先在一个空的外部目录初始化候选人工作区。');
  }

  const runRelativePath = `private/runs/${validated.record.runId}`;
  const runDirectory = join(workspace.workspacePath, runRelativePath);
  let lockSession;
  const lockDirectory = async (relativePath = '') => {
    await assertSafeDirectoryPath(workspace.workspacePath, relativePath);
    if (!lockSession) {
      lockSession = await acquireDirectoryLocks([join(workspace.workspacePath, relativePath)]);
    } else {
      await lockSession.lock(join(workspace.workspacePath, relativePath));
    }
    await assertSafeDirectoryPath(workspace.workspacePath, relativePath);
  };
  try {
    await lockDirectory();
    await lockDirectory('private');
    await lockDirectory('private/runs');
    await mkdir(runDirectory);
    await lockDirectory(runRelativePath);
    await beforeRecordWrite({ runDirectory });
    await assertSafeDirectoryPath(workspace.workspacePath, 'private');
    await assertSafeDirectoryPath(workspace.workspacePath, 'private/runs');
    await assertSafeDirectoryPath(workspace.workspacePath, runRelativePath);
    const recordPath = join(runDirectory, 'run-record.json');
    const handle = await open(recordPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.writeFile(`${JSON.stringify(validated.record, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return { status: 'ready', recordPath, record: validated.record };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        await assertSafeDirectoryPath(workspace.workspacePath, runRelativePath);
      } catch {
        return blocked('RUN_RECORD_PATH_UNSAFE', '使用未被符号链接或联接重定向的候选人工作区。');
      }
      return blocked('RUN_RECORD_ALREADY_EXISTS', '使用新的 runId；既有运行记录不会被覆盖。');
    }
    if (error instanceof UnsafeWorkspacePathError || error?.code === 'ELOOP') {
      return blocked('RUN_RECORD_PATH_UNSAFE', '使用未被符号链接或联接重定向的候选人工作区。');
    }
    if (error?.code === 'EBUSY') {
      return blocked('RUN_RECORD_PATH_UNSAFE', '运行记录目录在写入期间发生变化；请在未被其他进程修改的工作区重试。');
    }
    if (error?.message?.includes('Directory lock')) {
      return blocked('WORKSPACE_ATOMIC_WRITE_UNAVAILABLE', '无法安全锁定工作区目录；请选择可删除且未被占用的目录后重试。');
    }
    return blocked('RUN_RECORD_WRITE_FAILED', '确认工作区 private/runs 目录可写后重试。');
  } finally {
    await lockSession?.release();
  }
}

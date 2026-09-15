import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunRecord } from '../contracts/run-record.mjs';
import { renderChangesMarkdown } from '../contracts/changes.mjs';
import { validateTailoringRequest } from '../contracts/tailoring.mjs';
import { tailorHtml } from '../tailoring/tailor-html.mjs';
import { assertSafeDirectoryPath, UnsafeWorkspacePathError, validateWorkspaceTarget } from './validate.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

async function writeExclusive(path, contents) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

/**
 * The store is reachable only after all gates and confirmations have passed.
 * It writes a new output in its own run directory; source paths are never
 * opened for writing and existing run IDs are never reused.
 */
export async function storeTailoredHtml({ workspacePath, pluginRoot, request, tailored, now = () => new Date() } = {}) {
  const valid = validateTailoringRequest(request);
  if (valid.status === 'blocked' || !tailored || tailored.status !== 'ready' || !Buffer.isBuffer(tailored.htmlBytes)
    || !Array.isArray(tailored.changes)) {
    return blocked('TAILORING_STORE_INPUT_INVALID', '先完成用户选择、事实 Gate、确认检查和 HTML 定制，再写入私有输出。');
  }
  const workspace = await validateWorkspaceTarget({ workspacePath, pluginRoot });
  if (workspace.status === 'blocked') return workspace;
  const { runId, selection, receipt } = valid.request;
  let source;
  try {
    await assertSafeDirectoryPath(workspace.workspacePath, 'private');
    await assertSafeDirectoryPath(workspace.workspacePath, 'private/resumes');
    await assertSafeDirectoryPath(workspace.workspacePath, 'private/resumes/normalized');
    const sourcePath = join(workspace.workspacePath, ...receipt.normalized.path.split('/'));
    const sourceMetadata = await lstat(sourcePath);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new UnsafeWorkspacePathError();
    const sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { source = await sourceHandle.readFile(); } finally { await sourceHandle.close(); }
    const afterRead = await lstat(sourcePath);
    if (!afterRead.isFile() || afterRead.isSymbolicLink()) throw new UnsafeWorkspacePathError();
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError || error?.code === 'ELOOP') {
      return blocked('TAILORING_SOURCE_PATH_UNSAFE', '使用未被符号链接或联接重定向的已归档 HTML。');
    }
    return blocked('TAILORING_SOURCE_UNAVAILABLE', '确认规范化 HTML 可读且其哈希未改变后重试。');
  }
  const regenerated = tailorHtml({
    htmlBytes: source,
    expectedSha256: receipt.normalized.sha256,
    changes: valid.request.changes,
    jdBody: selection.job.normalizedBody,
  });
  if (regenerated.status === 'blocked' || !regenerated.htmlBytes.equals(tailored.htmlBytes)) {
    return blocked('TAILORING_STORE_INPUT_INVALID', '输出必须由已归档 HTML 与已确认修改重新生成；不要写入外部构造的内容。');
  }
  const base = `private/runs/${runId}`;
  const htmlRelativePath = `${base}/tailored.html`;
  const changesRelativePath = `${base}/changes.md`;
  const inputSources = [
    { source: receipt.original.path, sha256: receipt.original.sha256 },
    { source: `jd:${selection.report.jobId}`, sha256: selection.report.inputHash },
  ];
  const changesMarkdown = renderChangesMarkdown({ runId, jobId: selection.report.jobId, changes: regenerated.changes });
  try {
    return await createRunRecord({
      workspacePath: workspace.workspacePath,
      pluginRoot: workspace.pluginRoot,
      run: {
        runId,
        inputSources,
        upstreamVersions: { aiJobSearchCodex: selection.report.upstream.revision },
        artifactPaths: [htmlRelativePath, changesRelativePath],
        status: 'complete',
      },
      now,
    }, {
      beforeRecordWrite: async ({ runDirectory }) => {
        await assertSafeDirectoryPath(workspace.workspacePath, 'private');
        await assertSafeDirectoryPath(workspace.workspacePath, 'private/runs');
        await assertSafeDirectoryPath(workspace.workspacePath, base);
        await writeExclusive(join(runDirectory, 'tailored.html'), regenerated.htmlBytes);
        await assertSafeDirectoryPath(workspace.workspacePath, base);
        await writeExclusive(join(runDirectory, 'changes.md'), changesMarkdown);
        await assertSafeDirectoryPath(workspace.workspacePath, base);
      },
    });
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError || error?.code === 'ELOOP' || error?.code === 'EBUSY') {
      return blocked('TAILORING_STORE_PATH_UNSAFE', '使用未被符号链接或联接重定向的候选人工作区后重试。');
    }
    if (error?.code === 'EEXIST') return blocked('TAILORING_STORE_ALREADY_EXISTS', '使用新的 runId；既有私有输出不会被覆盖。');
    return blocked('TAILORING_STORE_WRITE_FAILED', '确认候选人工作区可写后重试。');
  }
}

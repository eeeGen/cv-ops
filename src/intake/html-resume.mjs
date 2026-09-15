import { createHash } from 'node:crypto';

import { resumePaths, validateResumeId } from '../contracts/resume.mjs';
import { storeResumeArtifact } from '../workspace/resume-store.mjs';

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function htmlAnchors(bytes) {
  const documentText = bytes.toString('utf8');
  const anchors = new Set();
  for (const match of documentText.matchAll(/\bid\s*=\s*(["'])([^"'\r\n]{1,200})\1/gi)) {
    anchors.add(`#${match[2]}`);
    if (anchors.size === 100) break;
  }
  return [...anchors];
}

export async function importHtmlResume({ workspacePath, pluginRoot, resumeId, htmlBytes }) {
  if (!validateResumeId(resumeId)) {
    return blocked('RESUME_ID_INVALID', '使用小写字母开头、仅含字母数字连字符或下划线的 resumeId。');
  }
  if (!Buffer.isBuffer(htmlBytes) || htmlBytes.length === 0) {
    return blocked('HTML_RESUME_BYTES_REQUIRED', '提供非空 HTML 文件的原始字节；不要先转换或重写该文件。');
  }
  const paths = resumePaths(resumeId, 'html');
  const original = await storeResumeArtifact({ workspacePath, pluginRoot, relativePath: paths.original, bytes: htmlBytes });
  if (original.status === 'blocked') return original;

  // The normalized copy is deliberately a distinct immutable file. Its bytes are
  // identical to the archive, so later tailoring can never overwrite the source.
  const normalized = await storeResumeArtifact({ workspacePath, pluginRoot, relativePath: paths.normalized, bytes: htmlBytes });
  const originalHash = sha256(htmlBytes);
  const anchors = [`sha256:${originalHash}`, ...htmlAnchors(htmlBytes)];
  if (normalized.status === 'blocked') {
    return blocked('HTML_NORMALIZED_OUTPUT_UNAVAILABLE', '原件已安全归档；使用新的 resumeId 重试以创建独立可编辑 HTML。', {
      resumeId,
      inputFormat: 'html',
      original: { path: paths.original, sha256: originalHash },
      anchors,
    });
  }
  return {
    status: 'ready',
    resumeId,
    inputFormat: 'html',
    original: { path: paths.original, sha256: originalHash },
    normalized: { path: paths.normalized, sha256: originalHash },
    anchors,
  };
}

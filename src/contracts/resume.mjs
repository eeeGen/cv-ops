const RESUME_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });

export function validateResumeId(resumeId) {
  return typeof resumeId === 'string' && RESUME_ID.test(resumeId);
}

export function resumePaths(resumeId, extension) {
  if (!validateResumeId(resumeId) || !['html', 'pdf'].includes(extension)) {
    return null;
  }
  return {
    original: `private/resumes/original/${resumeId}.${extension}`,
    normalized: `private/resumes/normalized/${resumeId}.html`,
  };
}

export function validateResumeReceipt(receipt) {
  const paths = resumePaths(receipt?.resumeId, receipt?.inputFormat);
  if (!receipt || typeof receipt !== 'object' || !validateResumeId(receipt.resumeId)
    || !['html', 'pdf'].includes(receipt.inputFormat)
    || !paths || !receipt.original || receipt.original.path !== paths.original || !SHA256.test(receipt.original.sha256 ?? '')
    || !Array.isArray(receipt.anchors) || !receipt.anchors.every((anchor) => typeof anchor === 'string' && anchor.length > 0 && anchor.length <= 256)) {
    return blocked('RESUME_RECEIPT_INVALID', '使用由 CV-ops 简历导入器返回的收据。');
  }
  if (receipt.status === 'ready') {
    if (!receipt.normalized || receipt.normalized.path !== paths.normalized || !SHA256.test(receipt.normalized.sha256 ?? '')) {
      return blocked('RESUME_RECEIPT_INVALID', '成功导入必须包含独立的可编辑 HTML 文件。');
    }
    return { status: 'ready', receipt };
  }
  if (receipt.status === 'blocked' && typeof receipt.reason === 'string' && receipt.reason.length > 0) {
    return { status: 'ready', receipt };
  }
  return blocked('RESUME_RECEIPT_INVALID', '使用明确的 ready 或 blocked 简历导入状态。');
}

import { createHash } from 'node:crypto';

import { resumePaths, validateResumeId } from '../contracts/resume.mjs';
import { storeResumeArtifact } from '../workspace/resume-store.mjs';

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/**
 * PDF object and stream boundaries cannot be safely established with a small
 * regular-expression parser. This dependency-free adapter therefore fails
 * closed; callers must provide a local, audited PDF/OCR extractor explicitly.
 */
export function extractTextPdf() {
  return null;
}

export function semanticHtmlFromPdfText(text, { title = 'Imported resume' } = {}) {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n<main data-cv-ops-source="pdf-text">\n${paragraphs.map((paragraph, index) => `  <p id="pdf-text-${index + 1}">${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('\n')}\n</main>\n</body>\n</html>\n`;
}

export async function importPdfResume({ workspacePath, pluginRoot, resumeId, pdfBytes, extractText = extractTextPdf }) {
  if (!validateResumeId(resumeId)) {
    return blocked('RESUME_ID_INVALID', '使用小写字母开头、仅含字母数字连字符或下划线的 resumeId。');
  }
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length === 0 || !pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return blocked('PDF_RESUME_BYTES_REQUIRED', '提供非空且具有 PDF 文件头的原始 PDF 字节。');
  }
  const paths = resumePaths(resumeId, 'pdf');
  const originalHash = sha256(pdfBytes);
  const original = await storeResumeArtifact({ workspacePath, pluginRoot, relativePath: paths.original, bytes: pdfBytes });
  if (original.status === 'blocked') return original;

  let text;
  try {
    text = await extractText(pdfBytes);
  } catch {
    return blocked('PDF_TEXT_EXTRACTION_FAILED', '原 PDF 已保留；安装或配置本地文本提取/OCR 后使用新的 resumeId 重试。', {
      resumeId, inputFormat: 'pdf', original: { path: paths.original, sha256: originalHash }, anchors: [`sha256:${originalHash}`],
    });
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return blocked('PDF_TEXT_EXTRACTION_UNAVAILABLE', '原 PDF 已保留；该文件可能为扫描件。配置本地 OCR 后使用新的 resumeId 重试。', {
      resumeId, inputFormat: 'pdf', original: { path: paths.original, sha256: originalHash }, anchors: [`sha256:${originalHash}`],
    });
  }
  const normalizedBytes = Buffer.from(semanticHtmlFromPdfText(text), 'utf8');
  const normalized = await storeResumeArtifact({ workspacePath, pluginRoot, relativePath: paths.normalized, bytes: normalizedBytes });
  if (normalized.status === 'blocked') {
    return blocked('PDF_NORMALIZED_OUTPUT_UNAVAILABLE', '原 PDF 已保留；使用新的 resumeId 重试以创建独立可编辑 HTML。', {
      resumeId, inputFormat: 'pdf', original: { path: paths.original, sha256: originalHash }, anchors: [`sha256:${originalHash}`],
    });
  }
  return {
    status: 'ready', resumeId, inputFormat: 'pdf',
    original: { path: paths.original, sha256: originalHash },
    normalized: { path: paths.normalized, sha256: sha256(normalizedBytes) },
    anchors: [`sha256:${originalHash}`, ...text.split(/\n+/).filter(Boolean).slice(0, 100).map((_, index) => `#pdf-text-${index + 1}`)],
  };
}

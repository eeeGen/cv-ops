import { blockedJob, createJobRecord, isPrivateJobSource, MAX_JD_INPUT_BYTES } from '../contracts/jd.mjs';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.html', '.htm']);
const MAX_FILE_BYTES = MAX_JD_INPUT_BYTES;

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function normalizeTextInput({ text, source = 'inline:text' } = {}) {
  return createJobRecord({ inputType: 'text', source, rawInput: text, body: text });
}

/**
 * File bytes are supplied by the caller after it has archived them in private/jobs/inbox.
 * This function never opens a caller-provided path, so a JD filename cannot escape the workspace.
 */
export function normalizeFileInput({ source, filename, bytes } = {}) {
  if (!isPrivateJobSource(source) || typeof filename !== 'string' || filename.length === 0 || !(bytes instanceof Uint8Array)) {
    return blockedJob({ inputType: 'file', source, rawInput: '', reason: 'JD_FILE_INPUT_INVALID', nextAction: '归档 JD 文件到 private/jobs/inbox 后，提供其名称和字节内容。' });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    return blockedJob({ inputType: 'file', source, rawInput: bytes, reason: 'JD_FILE_SIZE_INVALID', nextAction: '提供非空且不超过 2 MB 的文本 JD 文件。' });
  }
  const extension = extensionOf(filename);
  if (!TEXT_EXTENSIONS.has(extension)) {
    return blockedJob({ inputType: 'file', source, rawInput: bytes, reason: 'JD_FILE_TYPE_UNSUPPORTED', nextAction: '使用 .txt、.md 或 .html 文件，或选择对应的 JSON、CSV 或 XLSX intake。' });
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    return blockedJob({ inputType: 'file', source, rawInput: bytes, reason: 'JD_FILE_DECODE_FAILED', nextAction: '将 JD 文件保存为 UTF-8 文本后重试。' });
  }
  return createJobRecord({ inputType: 'file', source, rawInput: bytes, body: text, markup: extension === '.html' || extension === '.htm' });
}

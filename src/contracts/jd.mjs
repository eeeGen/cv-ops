import { createHash } from 'node:crypto';

export const JD_INPUT_TYPES = Object.freeze(['text', 'file', 'url', 'json', 'csv', 'xlsx']);

const PRIVATE_PATH = /^private\/(?!.*(?:^|\/)\.?(?:\/|$))(?:[A-Za-z0-9][A-Za-z0-9._ -]*\/)*[A-Za-z0-9][A-Za-z0-9._ -]*(?:#[A-Za-z0-9_.\[\]-]+)?$/;
const INLINE_SOURCE = /^inline:(?:text|json)$/;
const JOB_ID = /^jd-[a-f0-9]{16}$/;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_LENGTH = 200_000;
export const MAX_JD_INPUT_BYTES = 2_000_000;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashInput(value) {
  return sha256(value instanceof Uint8Array ? value : stableValue(value));
}

export function inputByteLength(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : null;
}

export function isPrivateJobSource(source) {
  return typeof source === 'string' && source.length <= 512 && PRIVATE_PATH.test(source.replaceAll('\\', '/'));
}

export function isUrlSource(source) {
  try {
    const url = new URL(source);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.username === '' && url.password === '' && url.hostname !== '';
  } catch {
    return false;
  }
}

export function isJobSource(source) {
  return typeof source === 'string'
    && source.length <= 2_048
    && !/[\0\r\n]/.test(source)
    && (isPrivateJobSource(source) || INLINE_SOURCE.test(source) || isUrlSource(source));
}

function canonicalSource(source) {
  if (isUrlSource(source)) {
    const url = new URL(source);
    url.hash = '';
    return url.toString();
  }
  return source.replaceAll('\\', '/');
}

export function normalizeBody(body, { markup = false } = {}) {
  if (typeof body !== 'string' || inputByteLength(body) > MAX_JD_INPUT_BYTES) {
    return null;
  }
  const withoutControls = body.replace(/^\uFEFF/, '').replace(/[\0-\b\v\f\u000e-\u001f\u007f]/g, '');
  const text = (markup ? withoutControls
    .replace(/<\/(?:p|div|li|h[1-6]|br|tr|section|article)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ') : withoutControls)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (text.length === 0 || text.length > MAX_BODY_LENGTH) {
    return null;
  }
  return text;
}

function stableValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function blockedJob({ inputType, source, rawInput, reason, nextAction }) {
  const inputHash = hashInput(rawInput ?? '');
  const canonical = isJobSource(source) ? canonicalSource(source) : null;
  return {
    status: 'blocked',
    job: {
      jobId: `jd-${inputHash.slice(0, 16)}`,
      inputType: JD_INPUT_TYPES.includes(inputType) ? inputType : 'text',
      source: canonical,
      inputHash,
      status: 'blocked',
      reason,
      nextAction,
    },
  };
}

/** Creates the single allowlisted record used by every JD intake channel. */
export function createJobRecord({ inputType, source, rawInput, body, markup = false, sourceId } = {}) {
  if (!JD_INPUT_TYPES.includes(inputType)) {
    return blockedJob({ inputType, source, rawInput, reason: 'JD_INPUT_TYPE_INVALID', nextAction: '使用受支持的 JD 输入类型后重试。' });
  }
  if (!isJobSource(source)) {
    return blockedJob({ inputType, source, rawInput, reason: 'JD_SOURCE_INVALID', nextAction: '为 JD 提供私有工作区来源、inline 来源或不含凭据的 HTTP(S) URL。' });
  }
  if (inputByteLength(rawInput) > MAX_JD_INPUT_BYTES || inputByteLength(body) > MAX_JD_INPUT_BYTES) {
    return blockedJob({ inputType, source, rawInput, reason: 'JD_INPUT_TOO_LARGE', nextAction: '将单份 JD 原始输入拆分或缩小到 2 MB 以内后重试。' });
  }
  const normalizedBody = normalizeBody(body, { markup });
  if (!normalizedBody) {
    return blockedJob({ inputType, source, rawInput, reason: 'JD_BODY_INVALID', nextAction: '提供非空、可解析且不超过限制的 JD 正文后重试。' });
  }
  if (sourceId !== undefined && !SOURCE_ID.test(sourceId)) {
    return blockedJob({ inputType, source, rawInput, reason: 'JD_SOURCE_ID_INVALID', nextAction: '使用仅含字母、数字、连字符或下划线的来源 ID，或留空自动生成。' });
  }
  const inputHash = hashInput(rawInput);
  const canonical = canonicalSource(source);
  return {
    status: 'ready',
    job: {
      jobId: `jd-${sha256(`${inputType}\n${canonical}\n${inputHash}`).slice(0, 16)}`,
      inputType,
      source: canonical,
      ...(sourceId ? { sourceId } : {}),
      normalizedBody,
      inputHash,
      status: 'ready',
    },
  };
}

export function validateJobRecord(record) {
  if (!record || typeof record !== 'object' || !JOB_ID.test(record.jobId ?? '') || !JD_INPUT_TYPES.includes(record.inputType)
    || !/^[a-f0-9]{64}$/.test(record.inputHash ?? '') || !['ready', 'blocked'].includes(record.status)
    || (record.status === 'ready' && !isJobSource(record.source))
    || (record.status === 'blocked' && record.source !== null && !isJobSource(record.source))
    || (record.sourceId !== undefined && !SOURCE_ID.test(record.sourceId))) {
    return { status: 'blocked', reason: 'JD_RECORD_INVALID', nextAction: '使用规范化 intake 返回的 JD record。' };
  }
  if (record.status === 'ready' && !normalizeBody(record.normalizedBody)) {
    return { status: 'blocked', reason: 'JD_RECORD_BODY_INVALID', nextAction: '提供有效的规范正文。' };
  }
  if (record.status === 'blocked' && (typeof record.reason !== 'string' || typeof record.nextAction !== 'string')) {
    return { status: 'blocked', reason: 'JD_RECORD_BLOCK_REASON_REQUIRED', nextAction: '为 blocked JD 保留结构化原因和下一步。' };
  }
  return { status: 'ready', record };
}

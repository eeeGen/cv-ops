import { inflateRawSync } from 'node:zlib';

import { blockedJob, createJobRecord, isPrivateJobSource, MAX_JD_INPUT_BYTES } from '../contracts/jd.mjs';
import { normalizeFileInput } from './normalize.mjs';

const MAX_BATCH_ROWS = 250;
const MAX_BATCH_COLUMNS = 32;
const MAX_BATCH_INPUTS = 50;
const DESCRIPTION_COLUMNS = ['description', 'job_description', 'body', 'text'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function sourceAt(source, marker) {
  return `${source}#${marker}`;
}

function decodeXml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([\da-f]+);/gi, (entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] ?? entity;
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; } else if (char === '"') quoted = false; else value += char;
    } else if (char === '"') {
      if (value !== '') throw new Error('CSV_QUOTE_INVALID');
      quoted = true;
    } else if (char === ',') { row.push(value); if (row.length > MAX_BATCH_COLUMNS) throw new Error('BATCH_TOO_LARGE'); value = ''; } else if (char === '\n') { row.push(value); rows.push(row); if (rows.length > MAX_BATCH_ROWS + 1 || row.length > MAX_BATCH_COLUMNS) throw new Error('BATCH_TOO_LARGE'); row = []; value = ''; } else if (char !== '\r') value += char;
  }
  if (quoted) throw new Error('CSV_QUOTE_INVALID');
  row.push(value);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  if (rows.length > MAX_BATCH_ROWS + 1 || row.length > MAX_BATCH_COLUMNS) throw new Error('BATCH_TOO_LARGE');
  return rows;
}

function rowsToJobs(rows, source, inputType, rawInput) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return [blockedJob({ inputType, source, rawInput, reason: 'JD_BATCH_ROWS_REQUIRED', nextAction: '提供含标题行和至少一条 JD 的批量输入。' })];
  }
  if (rows.length > MAX_BATCH_ROWS + 1 || rows[0].length > MAX_BATCH_COLUMNS) {
    return [blockedJob({ inputType, source, rawInput, reason: 'JD_BATCH_TOO_LARGE', nextAction: '将该批量来源拆分为最多 250 条 JD、每行最多 32 列后重试。' })];
  }
  const headers = rows[0].map((header) => String(header).trim().toLowerCase());
  const bodyColumn = DESCRIPTION_COLUMNS.find((name) => headers.includes(name));
  if (!bodyColumn) {
    return [blockedJob({ inputType, source, rawInput, reason: 'JD_BATCH_DESCRIPTION_COLUMN_REQUIRED', nextAction: '添加 description、job_description、body 或 text 标题列。' })];
  }
  const bodyIndex = headers.indexOf(bodyColumn);
  const idIndex = headers.indexOf('id');
  return rows.slice(1).map((row, index) => {
    const rowSource = sourceAt(source, `row-${index + 2}`);
    const body = String(row[bodyIndex] ?? '');
    const suppliedId = String(row[idIndex] ?? '');
    if (suppliedId && !ID.test(suppliedId)) {
      return blockedJob({ inputType, source: rowSource, rawInput: row, reason: 'JD_BATCH_ID_INVALID', nextAction: '使用不含空格的字母、数字、连字符或下划线 ID，或留空以自动生成。' });
    }
    return createJobRecord({ inputType, source: rowSource, rawInput: row, body, sourceId: suppliedId || undefined });
  });
}

function parsedJsonToRows(value) {
  const jobs = Array.isArray(value) ? value : Array.isArray(value?.jobs) ? value.jobs : [value];
  if (jobs.length > MAX_BATCH_ROWS) throw new Error('BATCH_TOO_LARGE');
  const rows = [['id', 'description']];
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) rows.push(['', '']);
    else rows.push([job.id ?? '', job.description ?? job.job_description ?? job.body ?? job.text ?? '']);
  }
  return rows;
}

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(bytes) {
  const buffer = Buffer.from(bytes);
  const eocd = findEocd(buffer);
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0
    || buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)) throw new Error('XLSX_ZIP_INVALID');
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0 || count > 64 || directoryOffset >= buffer.length) throw new Error('XLSX_ZIP_INVALID');
  const entries = new Map();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX_ZIP_INVALID');
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\') || ![0, 8].includes(compression) || uncompressedSize > MAX_JD_INPUT_BYTES || total + uncompressedSize > MAX_JD_INPUT_BYTES) throw new Error('XLSX_ZIP_UNSAFE');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('XLSX_ZIP_INVALID');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw new Error('XLSX_ZIP_INVALID');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = compression === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_JD_INPUT_BYTES });
    if (data.length !== uncompressedSize) throw new Error('XLSX_ZIP_INVALID');
    total += data.length;
    entries.set(name, data.toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractTag(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((match) => decodeXml(match[1].replace(/<[^>]*>/g, '')));
}

function columnIndex(cellReference) {
  const letters = /^([A-Z]+)/.exec(cellReference)?.[1];
  if (!letters) return -1;
  return [...letters].reduce((sum, character) => sum * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function parseXlsxRows(bytes) {
  const entries = readZipEntries(bytes);
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('XLSX_SHEET_MISSING');
  const strings = entries.has('xl/sharedStrings.xml') ? extractTag(entries.get('xl/sharedStrings.xml'), 'si') : [];
  const rows = [];
  for (const match of sheet.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cell of match[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = /\br="([A-Z]+\d+)"/.exec(cell[1])?.[1] ?? '';
      const target = columnIndex(reference);
      if (target < 0) continue;
      if (target >= MAX_BATCH_COLUMNS) throw new Error('BATCH_TOO_LARGE');
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? '';
      const inline = /<is>([\s\S]*?)<\/is>/.exec(cell[2])?.[1] ?? '';
      row[target] = type === 's' ? strings[Number(raw)] ?? '' : decodeXml((inline || raw).replace(/<[^>]*>/g, ''));
    }
    rows.push(row);
    if (rows.length > MAX_BATCH_ROWS + 1) throw new Error('BATCH_TOO_LARGE');
  }
  return rows;
}

export function normalizeJsonInput({ source, content } = {}) {
  if (!isPrivateJobSource(source)) return { status: 'complete', jobs: [blockedJob({ inputType: 'json', source, rawInput: content, reason: 'JD_SOURCE_INVALID', nextAction: '先将 JSON 归档到 private/jobs/inbox。' })] };
  if (typeof content !== 'string') return { status: 'complete', jobs: [blockedJob({ inputType: 'json', source, rawInput: '', reason: 'JD_JSON_INPUT_INVALID', nextAction: '将归档 JSON 作为 UTF-8 原始文本提供后重试。' })] };
  if (Buffer.byteLength(content, 'utf8') > MAX_JD_INPUT_BYTES) return { status: 'complete', jobs: [blockedJob({ inputType: 'json', source, rawInput: content, reason: 'JD_INPUT_TOO_LARGE', nextAction: '将单份 JSON 输入拆分或缩小到 2 MB 以内后重试。' })] };
  try {
    const value = JSON.parse(content);
    return { status: 'complete', jobs: rowsToJobs(parsedJsonToRows(value), source, 'json', content) };
  } catch (error) {
    const reason = error?.message === 'BATCH_TOO_LARGE' ? 'JD_BATCH_TOO_LARGE' : 'JD_JSON_PARSE_FAILED';
    return { status: 'complete', jobs: [blockedJob({ inputType: 'json', source, rawInput: content, reason, nextAction: reason === 'JD_BATCH_TOO_LARGE' ? '将该批量来源拆分为最多 250 条 JD、每行最多 32 列后重试。' : '修正 JSON 格式后重试。' })] };
  }
}

export function normalizeCsvInput({ source, content } = {}) {
  if (!isPrivateJobSource(source) || typeof content !== 'string') return { status: 'complete', jobs: [blockedJob({ inputType: 'csv', source, rawInput: content, reason: 'JD_CSV_INPUT_INVALID', nextAction: '提供已归档在 private/jobs/inbox 的 UTF-8 CSV。' })] };
  if (Buffer.byteLength(content, 'utf8') > MAX_JD_INPUT_BYTES) return { status: 'complete', jobs: [blockedJob({ inputType: 'csv', source, rawInput: content, reason: 'JD_INPUT_TOO_LARGE', nextAction: '将单份 CSV 输入拆分或缩小到 2 MB 以内后重试。' })] };
  try {
    return { status: 'complete', jobs: rowsToJobs(parseCsv(content), source, 'csv', content) };
  } catch (error) {
    const reason = error?.message === 'BATCH_TOO_LARGE' ? 'JD_BATCH_TOO_LARGE' : 'JD_CSV_PARSE_FAILED';
    return { status: 'complete', jobs: [blockedJob({ inputType: 'csv', source, rawInput: content, reason, nextAction: reason === 'JD_BATCH_TOO_LARGE' ? '将该批量来源拆分为最多 250 条 JD、每行最多 32 列后重试。' : '修正 CSV 引号和行格式后重试。' })] };
  }
}

export function normalizeXlsxInput({ source, bytes } = {}) {
  if (!isPrivateJobSource(source) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { status: 'complete', jobs: [blockedJob({ inputType: 'xlsx', source, rawInput: bytes ?? '', reason: 'JD_XLSX_INPUT_INVALID', nextAction: '提供已归档在 private/jobs/inbox 的 XLSX 文件。' })] };
  if (bytes.byteLength > MAX_JD_INPUT_BYTES) return { status: 'complete', jobs: [blockedJob({ inputType: 'xlsx', source, rawInput: bytes, reason: 'JD_INPUT_TOO_LARGE', nextAction: '将单份 XLSX 输入拆分或缩小到 2 MB 以内后重试。' })] };
  try {
    return { status: 'complete', jobs: rowsToJobs(parseXlsxRows(bytes), source, 'xlsx', bytes) };
  } catch (error) {
    const reason = error?.message === 'BATCH_TOO_LARGE' ? 'JD_BATCH_TOO_LARGE' : 'JD_XLSX_PARSE_FAILED';
    return { status: 'complete', jobs: [blockedJob({ inputType: 'xlsx', source, rawInput: bytes, reason, nextAction: reason === 'JD_BATCH_TOO_LARGE' ? '将该批量来源拆分为最多 250 条 JD、每行最多 32 列后重试。' : '使用包含 sheet1、标题行和文本 JD 列的标准 XLSX 后重试。' })] };
  }
}

/** Normalizes independent input tasks without allowing a single failure to stop the batch. */
export async function normalizeJobBatch(inputs, { normalizeUrl } = {}) {
  if (!Array.isArray(inputs)) return { status: 'blocked', reason: 'JD_BATCH_INPUTS_REQUIRED', nextAction: '提供 JD 输入数组。' };
  if (inputs.length > MAX_BATCH_INPUTS) return { status: 'blocked', reason: 'JD_BATCH_TOO_LARGE', nextAction: '将直接批次拆分为最多 50 个输入来源后重试。' };
  const jobs = [];
  for (const input of inputs) {
    try {
      let result;
      switch (input?.type) {
        case 'json': result = normalizeJsonInput(input); jobs.push(...result.jobs); break;
        case 'csv': result = normalizeCsvInput(input); jobs.push(...result.jobs); break;
        case 'xlsx': result = normalizeXlsxInput(input); jobs.push(...result.jobs); break;
        case 'url': result = await (normalizeUrl ? normalizeUrl(input) : Promise.resolve(blockedJob({ inputType: 'url', source: input.url, rawInput: '', reason: 'JD_URL_TRANSPORT_REQUIRED', nextAction: '通过报告最终对端地址的受控 URL transport 导入 JD。' }))); jobs.push(result); break;
        case 'text': result = createJobRecord({ inputType: 'text', source: input.source ?? 'inline:text', rawInput: input.text, body: input.text }); jobs.push(result); break;
        case 'file': result = normalizeFileInput(input); jobs.push(result); break;
        default: jobs.push(blockedJob({ inputType: 'text', source: 'inline:text', rawInput: '', reason: 'JD_INPUT_TYPE_INVALID', nextAction: '使用受支持的 JD 输入类型后重试。' }));
      }
    } catch {
      jobs.push(blockedJob({ inputType: 'text', source: 'inline:text', rawInput: '', reason: 'JD_BATCH_ITEM_FAILED', nextAction: '修正该 JD 输入后重试；其他项可继续处理。' }));
    }
  }
  return { status: 'complete', jobs };
}

export const JD_BATCH_LIMITS = Object.freeze({ inputs: MAX_BATCH_INPUTS, rows: MAX_BATCH_ROWS, columns: MAX_BATCH_COLUMNS });

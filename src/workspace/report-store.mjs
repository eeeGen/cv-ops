import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createRunRecord } from '../contracts/run-record.mjs';
import { AI_JOB_SEARCH_FIT_PROVENANCE, validateMatchReport } from '../contracts/match-report.mjs';
import { validateJobRecord } from '../contracts/jd.mjs';
import { rankReadyMatchReports, requireQualifiedJobSelection } from '../jd/rank.mjs';
import { assertSafeDirectoryPath, UnsafeWorkspacePathError, validateWorkspaceTarget } from './validate.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const JOB_ID = /^jd-[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const FACT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,159}$/;
const FACT_GATE_REASONS = new Set(['FACT_CONFLICT', 'FACT_STAR_EVIDENCE_INVALID', 'FACT_UNCONFIRMED', 'FACT_MISSING']);
const FACT_SOURCES = new Set(['profile', 'evidence', 'star', 'archived_html']);
const CONFIRMATIONS = new Set(['confirmed', 'unconfirmed']);
const GATE_VERDICTS = new Set(['PASS', 'FAIL', 'FLAG']);
const ELIGIBILITY_VERDICTS = new Set(['PASS', 'FAIL', 'PROCEED']);
const DIMENSION_NAMES = ['technical', 'experience', 'behavioral', 'location', 'career'];

const metadataKeys = ['status', 'jobId', 'inputHash', 'upstream', 'source', 'inputType'];
const blockedKeys = [...metadataKeys, 'reason', 'nextAction'];

function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeNextAction(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500
    && !/[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

function hasBlockedBase(report, keys, optional = []) {
  return hasExactKeys(report, keys, optional) && report.status === 'blocked' && isSafeNextAction(report.nextAction);
}

function isPrivatePath(value) {
  if (typeof value !== 'string' || value.length < 9 || value.length > 512 || value.includes('\0')) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return parts[0] === 'private' && parts.length > 1
    && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':'));
}

function isAnchor(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function isEvidenceAnchor(value, { requirePendingPriority = false } = {}) {
  if (!hasExactKeys(value, ['factId', 'source', 'path', 'anchor', 'confirmation', 'priority'], ['evidence'])
    || !FACT_ID.test(value.factId) || !FACT_SOURCES.has(value.source) || !isPrivatePath(value.path)
    || !isAnchor(value.anchor) || !CONFIRMATIONS.has(value.confirmation)
    || !Number.isInteger(value.priority)
    || (requirePendingPriority ? value.priority !== 0 : (value.priority < 1 || value.priority > 3))) return false;
  if (value.evidence === undefined) return value.source !== 'star';
  return value.source === 'star' && hasExactKeys(value.evidence, ['path', 'anchor'])
    && isPrivatePath(value.evidence.path) && isAnchor(value.evidence.anchor);
}

function isJdAnchor(value) {
  return hasExactKeys(value, ['start', 'end', 'line', 'column'])
    && Number.isInteger(value.start) && value.start >= 0 && Number.isInteger(value.end) && value.end > value.start
    && Number.isInteger(value.line) && value.line >= 1 && Number.isInteger(value.column) && value.column >= 1;
}

function hasExactGate(value, allowedVerdicts, { requireNoteForFlag = false } = {}) {
  if (!hasExactKeys(value, ['verdict', 'jdAnchors', 'evidence'], ['note']) || !allowedVerdicts.has(value.verdict)
    || !Array.isArray(value.jdAnchors) || value.jdAnchors.length === 0 || !value.jdAnchors.every(isJdAnchor)
    || !Array.isArray(value.evidence) || value.evidence.length === 0 || !value.evidence.every(isEvidenceAnchor)) return false;
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.trim().length === 0 || value.note.length > 500)) return false;
  return !requireNoteForFlag || value.verdict !== 'FLAG' || typeof value.note === 'string';
}

function hasExactGates(value, { language = false } = {}) {
  const keys = language ? ['eligibility', 'language'] : ['eligibility'];
  return hasExactKeys(value, keys)
    && hasExactGate(value.eligibility, ELIGIBILITY_VERDICTS)
    && (!language || hasExactGate(value.language, GATE_VERDICTS, { requireNoteForFlag: true }));
}

function hasExactDimensions(value) {
  if (!hasExactKeys(value, DIMENSION_NAMES)) return false;
  return DIMENSION_NAMES.every((name) => {
    const dimension = value[name];
    const location = name === 'location';
    const fields = location ? ['verdict', 'jdAnchors', 'evidence'] : ['score', 'jdAnchors', 'evidence'];
    if (!hasExactKeys(dimension, fields, ['note']) || !Array.isArray(dimension.jdAnchors) || dimension.jdAnchors.length === 0
      || !dimension.jdAnchors.every(isJdAnchor) || !Array.isArray(dimension.evidence) || dimension.evidence.length === 0
      || !dimension.evidence.every(isEvidenceAnchor)) return false;
    if (dimension.note !== undefined && (typeof dimension.note !== 'string' || dimension.note.length > 500)) return false;
    return location
      ? GATE_VERDICTS.has(dimension.verdict) && (dimension.verdict !== 'FLAG' || (typeof dimension.note === 'string' && dimension.note.trim().length > 0))
      : Number.isInteger(dimension.score) && dimension.score >= 0 && dimension.score <= 100;
  });
}

function hasExactFindings(value) {
  return Array.isArray(value) && value.length <= 3 && value.every((finding) => hasExactKeys(finding, ['summary', 'jdAnchors', 'evidence'])
    && typeof finding.summary === 'string' && finding.summary.trim().length > 0 && finding.summary.length <= 500
    && Array.isArray(finding.jdAnchors) && finding.jdAnchors.length > 0 && finding.jdAnchors.every(isJdAnchor)
    && Array.isArray(finding.evidence) && finding.evidence.length > 0 && finding.evidence.every(isEvidenceAnchor));
}

function hasFactGateShape(value) {
  if (!value || !FACT_GATE_REASONS.has(value.reason)) return false;
  const schemas = {
    FACT_CONFLICT: { required: ['reason', 'evidence', 'conflicts'], optional: ['pending', 'missingFields'] },
    FACT_STAR_EVIDENCE_INVALID: { required: ['reason', 'evidence', 'pending'], optional: ['missingFields'] },
    FACT_UNCONFIRMED: { required: ['reason', 'evidence', 'pending'], optional: ['missingFields'] },
    FACT_MISSING: { required: ['reason', 'missingFields'], optional: [] },
  };
  const schema = schemas[value.reason];
  if (!hasExactKeys(value, schema.required, schema.optional)) return false;
  const requirePendingPriority = ['FACT_STAR_EVIDENCE_INVALID', 'FACT_UNCONFIRMED'].includes(value.reason);
  return (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.length > 0
    && value.evidence.every((anchor) => isEvidenceAnchor(anchor, { requirePendingPriority }))))
    && (value.conflicts === undefined || (Array.isArray(value.conflicts) && value.conflicts.length > 0
      && value.conflicts.every((entry) => hasExactKeys(entry, ['field']) && FIELD.test(entry.field))))
    && (value.pending === undefined || (Array.isArray(value.pending) && value.pending.length > 0
      && value.pending.every((entry) => hasExactKeys(entry, ['field', 'reason']) && FIELD.test(entry.field)
        && ['FACT_STAR_EVIDENCE_INVALID', 'FACT_UNCONFIRMED'].includes(entry.reason))))
    && (value.missingFields === undefined || (Array.isArray(value.missingFields) && value.missingFields.length > 0
      && value.missingFields.every((field) => FIELD.test(field))));
}

function hasExactProvenance(value) {
  return hasExactKeys(value, ['source', 'revision', 'rule', 'frameworkVersion'])
    && isDeepStrictEqual(value, AI_JOB_SEARCH_FIT_PROVENANCE);
}

function hasExactBlockedShape(report, job) {
  if (!hasExactProvenance(report.upstream) || report.status !== 'blocked') return false;
  if (job.status === 'blocked') {
    return report.reason === 'FIT_JD_CONTRACT_INVALID' && hasBlockedBase(report, blockedKeys);
  }
  switch (report.reason) {
    case 'FIT_FACT_CONTRACT_INVALID':
      return hasBlockedBase(report, blockedKeys, ['invalidFactId'])
        && (report.invalidFactId === undefined || report.invalidFactId === null || FACT_ID.test(report.invalidFactId));
    case 'FIT_FACT_GATE_BLOCKED':
      return hasBlockedBase(report, [...blockedKeys, 'factGate']) && hasFactGateShape(report.factGate);
    case 'FIT_ASSESSMENT_INVALID':
      return hasBlockedBase(report, blockedKeys);
    case 'FIT_ELIGIBILITY_GATE_FAIL':
    case 'FIT_ELIGIBILITY_UNVERIFIED':
      return hasBlockedBase(report, [...blockedKeys, 'gates']) && hasExactGates(report.gates);
    case 'FIT_LANGUAGE_GATE_FAIL':
      return hasBlockedBase(report, [...blockedKeys, 'gates']) && hasExactGates(report.gates, { language: true });
    case 'FIT_LOCATION_GATE_FAIL':
      return hasBlockedBase(report, [...blockedKeys, 'gates', 'dimensions', 'overallScore', 'verdict', 'strengths', 'gaps'])
        && hasExactGates(report.gates, { language: true }) && hasExactDimensions(report.dimensions)
        && hasExactFindings(report.strengths) && hasExactFindings(report.gaps);
    default:
      return false;
  }
}

function hasExactReadyShape(report) {
  return hasExactProvenance(report.upstream)
    && hasExactKeys(report, [...metadataKeys, 'gates', 'dimensions', 'overallScore', 'verdict', 'strengths', 'gaps'])
    && hasExactGates(report.gates, { language: true }) && hasExactDimensions(report.dimensions)
    && hasExactFindings(report.strengths) && hasExactFindings(report.gaps);
}

function safeJson(value) {
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return null;
  }
}

function validateBatch(batch) {
  if (!batch || batch.status !== 'complete' || !Array.isArray(batch.reports) || !Array.isArray(batch.ranking)
    || !batch.upstreamVersions || typeof batch.upstreamVersions !== 'object') {
    return null;
  }
  const seen = new Set();
  for (const [index, entry] of batch.reports.entries()) {
    const report = entry?.report;
    const job = validateJobRecord(entry?.job);
    if (entry?.inputIndex !== index || job.status !== 'ready' || !report || !JOB_ID.test(report.jobId ?? '')
      || !HASH.test(report.inputHash ?? '') || seen.has(report.jobId)
      || report.jobId !== job.record.jobId || report.inputHash !== job.record.inputHash
      || report.source !== job.record.source || report.inputType !== job.record.inputType) return null;
    if (job.record.status === 'ready') {
      const checked = validateMatchReport(report, job.record);
      if (checked.status !== 'ready' || (report.status === 'ready' ? !hasExactReadyShape(report) : !hasExactBlockedShape(report, job.record))) return null;
    } else if (!hasExactBlockedShape(report, job.record)) return null;
    seen.add(report.jobId);
  }
  if (!isDeepStrictEqual(batch.upstreamVersions, { aiJobSearchCodex: AI_JOB_SEARCH_FIT_PROVENANCE.revision })) {
    return null;
  }
  const ranking = rankReadyMatchReports(batch.reports);
  const selection = requireQualifiedJobSelection({ reports: batch.reports });
  if (ranking.status !== 'ready' || !isDeepStrictEqual(batch.ranking, ranking.ranked)
    || !isDeepStrictEqual(batch.selection, selection)) return null;
  return { ...batch, ranking: ranking.ranked, selection };
}

async function writeExclusive(path, contents) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Persists only validated, private artifacts.  Names come from generated IDs,
 * never from a JD URL, filename, title, or candidate text.  The run record is
 * written only after the report callback has created every declared artifact.
 */
export async function storeBatchMatchReports({ workspacePath, pluginRoot, runId, batch, now } = {}) {
  const validBatch = validateBatch(batch);
  if (!RUN_ID.test(runId ?? '') || !validBatch) {
    return blocked('MATCH_REPORT_STORE_INPUT_INVALID', '使用完整批量匹配结果和安全 runId 后重试。');
  }
  const workspace = await validateWorkspaceTarget({ workspacePath, pluginRoot });
  if (workspace.status === 'blocked') return workspace;
  const artifactRoot = `private/runs/${runId}/match`;
  const reportPaths = validBatch.reports.map(({ report }) => `${artifactRoot}/${report.jobId}.json`);
  const rankingPath = `${artifactRoot}/ranking.json`;
  const selectionPath = `${artifactRoot}/selection-gate.json`;
  const inputSources = validBatch.reports.map(({ report }) => ({ source: `jd:${report.jobId}`, sha256: report.inputHash }));
  const artifacts = [...reportPaths, rankingPath, selectionPath];

  return createRunRecord({
    workspacePath: workspace.workspacePath,
    pluginRoot: workspace.pluginRoot,
    run: {
      runId,
      inputSources,
      upstreamVersions: validBatch.upstreamVersions,
      artifactPaths: artifacts,
      status: 'complete',
    },
    now,
  }, {
    beforeRecordWrite: async ({ runDirectory }) => {
      const relativeRun = `private/runs/${runId}`;
      await assertSafeDirectoryPath(workspace.workspacePath, 'private');
      await assertSafeDirectoryPath(workspace.workspacePath, 'private/runs');
      await assertSafeDirectoryPath(workspace.workspacePath, relativeRun);
      const matchDirectory = join(runDirectory, 'match');
      await mkdir(matchDirectory);
      await assertSafeDirectoryPath(workspace.workspacePath, `${relativeRun}/match`);

      for (const [index, entry] of validBatch.reports.entries()) {
        const contents = safeJson(entry.report);
        if (!contents) throw new Error('MATCH_REPORT_SERIALIZATION_FAILED');
        await writeExclusive(join(runDirectory, 'match', `${entry.report.jobId}.json`), contents);
        await assertSafeDirectoryPath(workspace.workspacePath, `${relativeRun}/match`);
      }
      const ranking = safeJson(validBatch.ranking);
      const selection = safeJson(validBatch.selection);
      if (!ranking || !selection) throw new Error('MATCH_REPORT_SERIALIZATION_FAILED');
      await writeExclusive(join(runDirectory, 'match', 'ranking.json'), ranking);
      await writeExclusive(join(runDirectory, 'match', 'selection-gate.json'), selection);
    },
  }).catch((error) => {
    if (error instanceof UnsafeWorkspacePathError || error?.code === 'ELOOP' || error?.code === 'EBUSY') {
      return blocked('MATCH_REPORT_PATH_UNSAFE', '使用未被符号链接或联接重定向的候选人工作区后重试。');
    }
    if (error?.code === 'EEXIST') {
      return blocked('MATCH_REPORT_ALREADY_EXISTS', '使用新的 runId；既有批量报告不会被覆盖。');
    }
    return blocked('MATCH_REPORT_WRITE_FAILED', '确认候选人工作区 private/runs 可写后重试。');
  });
}

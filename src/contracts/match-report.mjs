import { validateJobRecord } from './jd.mjs';

export const AI_JOB_SEARCH_FIT_PROVENANCE = Object.freeze({
  source: 'ai-job-search-codex',
  revision: '1a116b3c6492347e040d0546135c9b4c70540fbb',
  rule: '.claude/skills/job-application-assistant/04-job-evaluation.md',
  frameworkVersion: '1.2.6',
});

// The imported framework names five dimensions. Location is intentionally a
// veto, not a numeric input to the weighted average.
export const FIT_DIMENSIONS = Object.freeze(['technical', 'experience', 'behavioral', 'location', 'career']);
export const FIT_WEIGHTS = Object.freeze({ technical: 0.30, experience: 0.25, behavioral: 0.15, career: 0.30 });
const WEIGHT_HUNDREDTHS = Object.freeze({ technical: 30, experience: 25, behavioral: 15, career: 30 });
export const FIT_BANDS = Object.freeze([
  Object.freeze({ minimum: 75, verdict: 'Strong Fit' }),
  Object.freeze({ minimum: 60, verdict: 'Good Fit' }),
  Object.freeze({ minimum: 45, verdict: 'Moderate Fit' }),
  Object.freeze({ minimum: 30, verdict: 'Weak Fit' }),
  Object.freeze({ minimum: 0, verdict: 'Poor Fit' }),
]);

const HASH = /^[a-f0-9]{64}$/;
const GATE = new Set(['PASS', 'FAIL', 'FLAG']);
const ELIGIBILITY_GATE = new Set(['PASS', 'FAIL', 'PROCEED']);
const REPORT_STATUS = new Set(['ready', 'blocked']);
const BLOCK_REASONS = new Set([
  'FIT_JD_CONTRACT_INVALID',
  'FIT_FACT_CONTRACT_INVALID',
  'FIT_FACT_GATE_BLOCKED',
  'FIT_ASSESSMENT_INVALID',
  'FIT_ELIGIBILITY_GATE_FAIL',
  'FIT_ELIGIBILITY_UNVERIFIED',
  'FIT_LANGUAGE_GATE_FAIL',
  'FIT_LOCATION_GATE_FAIL',
]);

function sameProvenance(value) {
  return value && typeof value === 'object'
    && value.source === AI_JOB_SEARCH_FIT_PROVENANCE.source
    && value.revision === AI_JOB_SEARCH_FIT_PROVENANCE.revision
    && value.rule === AI_JOB_SEARCH_FIT_PROVENANCE.rule
    && value.frameworkVersion === AI_JOB_SEARCH_FIT_PROVENANCE.frameworkVersion;
}

export function isJdAnchor(anchor, body) {
  return anchor && typeof anchor === 'object'
    && Number.isInteger(anchor.start) && Number.isInteger(anchor.end)
    && anchor.start >= 0 && anchor.end > anchor.start
    && typeof body === 'string' && anchor.end <= body.length
    && Number.isInteger(anchor.line) && anchor.line >= 1
    && Number.isInteger(anchor.column) && anchor.column >= 1;
}

function isEvidenceAnchor(anchor) {
  return anchor && typeof anchor === 'object'
    && typeof anchor.factId === 'string' && typeof anchor.source === 'string'
    && typeof anchor.path === 'string' && typeof anchor.anchor === 'string'
    && typeof anchor.confirmation === 'string' && Number.isInteger(anchor.priority)
    && anchor.priority > 0;
}

function hasAnchoredFinding(finding, body) {
  return finding && typeof finding === 'object'
    && typeof finding.summary === 'string' && finding.summary.trim().length > 0 && finding.summary.length <= 500
    && Array.isArray(finding.jdAnchors) && finding.jdAnchors.length > 0
    && finding.jdAnchors.every((anchor) => isJdAnchor(anchor, body))
    && Array.isArray(finding.evidence) && finding.evidence.length > 0
    && finding.evidence.every(isEvidenceAnchor);
}

function hasGate(gate, body, allowed, { requireNoteForFlag = false } = {}) {
  return gate && typeof gate === 'object' && allowed.has(gate.verdict)
    && Array.isArray(gate.jdAnchors) && gate.jdAnchors.length > 0
    && gate.jdAnchors.every((anchor) => isJdAnchor(anchor, body))
    && Array.isArray(gate.evidence) && gate.evidence.length > 0
    && gate.evidence.every(isEvidenceAnchor)
    && (gate.note === undefined || (typeof gate.note === 'string' && gate.note.trim().length > 0 && gate.note.length <= 500))
    && (!requireNoteForFlag || gate.verdict !== 'FLAG' || (typeof gate.note === 'string' && gate.note.trim().length > 0));
}

function hasDimensions(dimensions, body) {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)
    || Object.keys(dimensions).length !== FIT_DIMENSIONS.length) return false;
  for (const dimension of FIT_DIMENSIONS) {
    const value = dimensions[dimension];
    const isLocation = dimension === 'location';
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.jdAnchors) || value.jdAnchors.length === 0
      || !value.jdAnchors.every((anchor) => isJdAnchor(anchor, body))
      || !Array.isArray(value.evidence) || value.evidence.length === 0
      || !value.evidence.every(isEvidenceAnchor)
      || (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 500))) return false;
    if (isLocation ? !GATE.has(value.verdict) || Object.hasOwn(value, 'score')
      : !Number.isInteger(value.score) || value.score < 0 || value.score > 100 || Object.hasOwn(value, 'verdict')) return false;
    if (isLocation && value.verdict === 'FLAG' && (typeof value.note !== 'string' || value.note.trim().length === 0)) return false;
  }
  return true;
}

export function bandForScore(score) {
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  return FIT_BANDS.find((band) => score >= band.minimum)?.verdict ?? null;
}

/**
 * Uses the upstream's non-negative, half-up integer result exactly. Integer
 * hundredths preserve the published decimal weights while preventing a binary
 * floating-point value just below an x.5 boundary from changing the band.
 */
export function overallFitScore(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return null;
  let hundredths = 0;
  for (const [dimension, weight] of Object.entries(WEIGHT_HUNDREDTHS)) {
    const score = dimensions[dimension]?.score;
    if (!Number.isInteger(score) || score < 0 || score > 100) return null;
    hundredths += score * weight;
  }
  return Math.floor((hundredths + 50) / 100);
}

export function blockedMatchReport(job, reason, nextAction, details = {}) {
  const record = validateJobRecord(job);
  const safeJobId = typeof job?.jobId === 'string' ? job.jobId : null;
  const safeInputHash = typeof job?.inputHash === 'string' && HASH.test(job.inputHash) ? job.inputHash : null;
  if (record.status === 'blocked' && reason !== 'FIT_JD_CONTRACT_INVALID') {
    return {
      status: 'blocked', jobId: safeJobId, inputHash: safeInputHash,
      reason: 'FIT_JD_CONTRACT_INVALID', nextAction: '先使用 JD intake 返回的规范 JD record。',
    };
  }
  return { status: 'blocked', jobId: safeJobId, inputHash: safeInputHash, reason, nextAction, ...details };
}

/**
 * Validates the public report shape without accepting a prose-only decision.
 * It deliberately permits a location-veto report to retain its four computed
 * scores, matching the fixed upstream ranking semantics.
 */
export function validateMatchReport(report, job) {
  const record = validateJobRecord(job);
  if (record.status === 'blocked' || !report || typeof report !== 'object' || Array.isArray(report)
    || !REPORT_STATUS.has(report.status) || report.jobId !== record.record.jobId
    || report.inputHash !== record.record.inputHash || !sameProvenance(report.upstream)) {
    return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '使用 Fit 评分适配层返回的结构化报告。' };
  }
  const body = record.record.normalizedBody;
  if (report.status === 'blocked' && ['FIT_FACT_CONTRACT_INVALID', 'FIT_FACT_GATE_BLOCKED', 'FIT_ASSESSMENT_INVALID'].includes(report.reason)
    && !Object.hasOwn(report, 'gates') && !Object.hasOwn(report, 'dimensions')
    && !Object.hasOwn(report, 'overallScore') && !Object.hasOwn(report, 'verdict')
    && typeof report.nextAction === 'string' && report.nextAction.length > 0) {
    return { status: 'ready', report };
  }
  if (!hasGate(report.gates?.eligibility, body, ELIGIBILITY_GATE)) {
    return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '为资格和语言 Gate 保留 JD 与候选证据锚点。' };
  }
  // Eligibility is the first upstream gate. A FAIL or PROCEED therefore has
  // no language decision or score below it to validate.
  if (report.status === 'blocked' && ['FIT_ELIGIBILITY_GATE_FAIL', 'FIT_ELIGIBILITY_UNVERIFIED'].includes(report.reason)) {
    if (Object.hasOwn(report.gates, 'language') || Object.hasOwn(report, 'dimensions')
      || Object.hasOwn(report, 'overallScore') || Object.hasOwn(report, 'verdict')
      || typeof report.nextAction !== 'string' || report.nextAction.length === 0) {
      return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '资格 Gate 的硬阻止不得包含后续 Gate 或评分。' };
    }
    return { status: 'ready', report };
  }
  if (!hasGate(report.gates?.language, body, GATE, { requireNoteForFlag: true })) {
    return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '为资格和语言 Gate 保留 JD 与候选证据锚点。' };
  }
  if (report.status === 'blocked' && report.reason === 'FIT_LANGUAGE_GATE_FAIL') {
    if (Object.hasOwn(report, 'dimensions') || Object.hasOwn(report, 'overallScore') || Object.hasOwn(report, 'verdict')
      || typeof report.nextAction !== 'string' || report.nextAction.length === 0) {
      return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '语言 Gate 的硬阻止不得包含评分。' };
    }
    return { status: 'ready', report };
  }
  const scored = Object.hasOwn(report, 'dimensions') || Object.hasOwn(report, 'overallScore') || Object.hasOwn(report, 'verdict');
  if (scored) {
    if (!hasDimensions(report.dimensions, body) || overallFitScore(report.dimensions) !== report.overallScore
      || bandForScore(report.overallScore) !== report.verdict
      || !Array.isArray(report.strengths) || !Array.isArray(report.gaps)
      || !report.strengths.every((finding) => hasAnchoredFinding(finding, body))
      || !report.gaps.every((finding) => hasAnchoredFinding(finding, body))) {
      return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '保留五维评分、固定加权结果及每项 JD/候选证据锚点。' };
    }
  }
  if (report.status === 'ready') {
    if (!scored || report.gates.eligibility.verdict !== 'PASS' || report.gates.language.verdict === 'FAIL'
      || report.dimensions.location.verdict === 'FAIL' || Object.hasOwn(report, 'reason')) {
      return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '只有通过资格与语言 Gate 且未被 Location veto 的报告可为 ready。' };
    }
    return { status: 'ready', report };
  }
  if (!BLOCK_REASONS.has(report.reason) || typeof report.nextAction !== 'string' || report.nextAction.length === 0) {
    return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: 'blocked 报告必须提供受控原因代码和下一步。' };
  }
  if (report.reason === 'FIT_LOCATION_GATE_FAIL' ? !scored : scored) {
    return { status: 'blocked', reason: 'MATCH_REPORT_INVALID', nextAction: '仅 Location veto 保留已计算评分；评分前 Gate 或事实阻止不得带分数。' };
  }
  return { status: 'ready', report };
}

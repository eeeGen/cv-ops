import { validateJobRecord } from './jd.mjs';

export const CAREER_OPS_KEYWORD_PROVENANCE = Object.freeze({
  source: 'career-ops',
  revision: 'da8c6f9193ac3d7a48a583f815b7d0feab742b81',
  rule: 'jd-skill-gap.extractJdSkills',
});

export const KEYWORD_LIMITS = Object.freeze({ minimum: 15, maximum: 20 });

const KEYWORD = /^\S(?:[\s\S]{0,118}\S)?$/;
const HASH = /^[a-f0-9]{64}$/;

const blocked = (jobId, inputHash, reason, nextAction, details = {}) => ({
  status: 'blocked',
  jobId,
  inputHash,
  reason,
  nextAction,
  ...details,
});

function sameProvenance(value) {
  return value && typeof value === 'object'
    && value.source === CAREER_OPS_KEYWORD_PROVENANCE.source
    && value.revision === CAREER_OPS_KEYWORD_PROVENANCE.revision
    && value.rule === CAREER_OPS_KEYWORD_PROVENANCE.rule;
}

/**
 * A JD anchor uses zero-based UTF-16 offsets with an exclusive end, plus a
 * one-based line and column for a human review. Its confidence describes an
 * exact occurrence of the unmodified upstream token, not candidate fit.
 */
export function isKeywordAnchor(anchor) {
  return anchor && typeof anchor === 'object'
    && Number.isInteger(anchor.start) && anchor.start >= 0
    && Number.isInteger(anchor.end) && anchor.end > anchor.start
    && Number.isInteger(anchor.line) && anchor.line >= 1
    && Number.isInteger(anchor.column) && anchor.column >= 1;
}

export function validateKeywordReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || typeof report.jobId !== 'string' || !HASH.test(report.inputHash ?? '')) {
    return blocked(null, null, 'KEYWORD_REPORT_INVALID', '使用关键词提取器返回的结构化结果。');
  }

  if (report.status === 'blocked') {
    if (typeof report.reason !== 'string' || report.reason.length === 0
      || typeof report.nextAction !== 'string' || report.nextAction.length === 0
      || Object.hasOwn(report, 'keywords')) {
      return blocked(report.jobId, report.inputHash, 'KEYWORD_REPORT_INVALID', '保留 blocked 原因和下一步，且不要附带关键词。');
    }
    return { status: 'ready', report };
  }

  if (report.status !== 'ready' || !sameProvenance(report.upstream)
    || !Array.isArray(report.keywords)
    || report.keywords.length < KEYWORD_LIMITS.minimum
    || report.keywords.length > KEYWORD_LIMITS.maximum
    || !Number.isInteger(report.upstreamKeywordCount)
    || report.upstreamKeywordCount < report.keywords.length) {
    return blocked(report.jobId, report.inputHash, 'KEYWORD_REPORT_INVALID', '提供 15–20 个带固定上游来源的关键词。');
  }

  const unique = new Set();
  for (const keyword of report.keywords) {
    if (!keyword || typeof keyword !== 'object' || !KEYWORD.test(keyword.keyword ?? '')
      || unique.has(keyword.keyword) || !isKeywordAnchor(keyword.anchor)
      || keyword.confidence !== 1 || keyword.confidenceBasis !== 'upstream-exact-token') {
      return blocked(report.jobId, report.inputHash, 'KEYWORD_REPORT_INVALID', '每个关键词必须是唯一的上游原样 token，并含精确 JD 锚点。');
    }
    unique.add(keyword.keyword);
  }
  return { status: 'ready', report };
}

export function blockedKeywordReport(job, reason, nextAction, details = {}) {
  const valid = validateJobRecord(job);
  const jobId = typeof job?.jobId === 'string' ? job.jobId : null;
  const inputHash = typeof job?.inputHash === 'string' && HASH.test(job.inputHash) ? job.inputHash : null;
  if (valid.status === 'blocked' && reason !== 'KEYWORD_JD_CONTRACT_INVALID') {
    return blocked(jobId, inputHash, 'KEYWORD_JD_CONTRACT_INVALID', '先使用 JD intake 返回的规范 JD record。');
  }
  return blocked(jobId, inputHash, reason, nextAction, details);
}

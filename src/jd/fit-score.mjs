import { evidenceAnchorFor, factPriority, validateFacts } from '../contracts/facts.mjs';
import { validateJobRecord } from '../contracts/jd.mjs';
import { AI_JOB_SEARCH_FIT_PROVENANCE, bandForScore, blockedMatchReport, overallFitScore } from '../contracts/match-report.mjs';
import { evaluateFactGate } from '../intake/fact-gate.mjs';

const GATE = new Set(['PASS', 'FAIL', 'FLAG']);
const ELIGIBILITY_GATE = new Set(['PASS', 'FAIL', 'PROCEED']);
const DIMENSIONS = ['technical', 'experience', 'behavioral', 'location', 'career'];
const NUMERIC_DIMENSIONS = new Set(['technical', 'experience', 'behavioral', 'career']);
const FACT_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function blocked(job, reason, nextAction, details = {}) {
  return { ...blockedMatchReport(job, reason, nextAction, details), upstream: AI_JOB_SEARCH_FIT_PROVENANCE };
}

function safeFactGate(factGate) {
  return {
    reason: factGate.reason,
    ...(Array.isArray(factGate.evidence) ? { evidence: factGate.evidence } : {}),
    ...(Array.isArray(factGate.conflicts) ? { conflicts: factGate.conflicts.map(({ field }) => ({ field })) } : {}),
    ...(Array.isArray(factGate.pending) ? { pending: factGate.pending.map(({ field, reason }) => ({ field, reason })) } : {}),
    ...(Array.isArray(factGate.missingFields) ? { missingFields: factGate.missingFields } : {}),
  };
}

function lineColumnFor(body, start) {
  const before = body.slice(0, start);
  return { line: before.split('\n').length, column: start - before.lastIndexOf('\n') };
}

function normalizeJdAnchor(body, anchor) {
  if (!anchor || typeof anchor !== 'object' || !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end)
    || anchor.start < 0 || anchor.end <= anchor.start || anchor.end > body.length) return null;
  const position = lineColumnFor(body, anchor.start);
  if ((anchor.line !== undefined && anchor.line !== position.line)
    || (anchor.column !== undefined && anchor.column !== position.column)) return null;
  return { start: anchor.start, end: anchor.end, ...position };
}

function normalizeJdAnchors(body, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  const normalized = anchors.map((anchor) => normalizeJdAnchor(body, anchor));
  if (normalized.some((anchor) => anchor === null)) return null;
  const seen = new Set();
  return normalized.filter((anchor) => {
    const key = `${anchor.start}:${anchor.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFactIds(factIds, factMap) {
  if (!Array.isArray(factIds) || factIds.length === 0 || !factIds.every((id) => FACT_ID.test(id))) return null;
  const unique = [...new Set(factIds)];
  const facts = unique.map((id) => factMap.get(id));
  if (facts.some((fact) => !fact || factPriority(fact, [...factMap.values()]) === 0)) return null;
  return facts;
}

function normalizeGate(value, body, factMap, allowedVerdicts, { requireNoteForFlag = false } = {}) {
  if (!value || typeof value !== 'object' || !allowedVerdicts.has(value.verdict)) return null;
  const jdAnchors = normalizeJdAnchors(body, value.jdAnchors);
  const facts = normalizeFactIds(value.evidenceFactIds, factMap);
  if (!jdAnchors || !facts || (value.note !== undefined && (typeof value.note !== 'string' || value.note.trim().length === 0 || value.note.length > 500))
    || (requireNoteForFlag && value.verdict === 'FLAG' && (typeof value.note !== 'string' || value.note.trim().length === 0))) return null;
  return {
    verdict: value.verdict,
    jdAnchors,
    evidence: facts.map((fact) => evidenceAnchorFor(fact, [...factMap.values()])),
    ...(value.note ? { note: value.note } : {}),
  };
}

function normalizeDimension(name, value, body, factMap) {
  if (!value || typeof value !== 'object') return null;
  const jdAnchors = normalizeJdAnchors(body, value.jdAnchors);
  const facts = normalizeFactIds(value.evidenceFactIds, factMap);
  if (!jdAnchors || !facts || (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 500))) return null;
  if (name === 'location') {
    if (!GATE.has(value.verdict) || (value.verdict === 'FLAG' && (typeof value.note !== 'string' || value.note.trim().length === 0))) return null;
    return { verdict: value.verdict, jdAnchors, evidence: facts.map((fact) => evidenceAnchorFor(fact, [...factMap.values()])), ...(value.note ? { note: value.note } : {}) };
  }
  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 100) return null;
  return { score: value.score, jdAnchors, evidence: facts.map((fact) => evidenceAnchorFor(fact, [...factMap.values()])), ...(value.note ? { note: value.note } : {}) };
}

function normalizeFindings(values, body, factMap) {
  if (!Array.isArray(values) || values.length > 3) return null;
  const result = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || typeof value.summary !== 'string'
      || value.summary.trim().length === 0 || value.summary.length > 500) return null;
    const jdAnchors = normalizeJdAnchors(body, value.jdAnchors);
    const facts = normalizeFactIds(value.evidenceFactIds, factMap);
    if (!jdAnchors || !facts) return null;
    result.push({ summary: value.summary, jdAnchors, evidence: facts.map((fact) => evidenceAnchorFor(fact, [...factMap.values()])) });
  }
  return result;
}

function referencedFactIds(assessment, { eligibilityOnly = false } = {}) {
  const ids = [
    ...(assessment?.eligibilityGate?.evidenceFactIds ?? []),
    ...(eligibilityOnly ? [] : [
    ...(assessment?.languageGate?.evidenceFactIds ?? []),
    ...DIMENSIONS.flatMap((name) => assessment?.dimensions?.[name]?.evidenceFactIds ?? []),
    ...(assessment?.strengths ?? []).flatMap((value) => value?.evidenceFactIds ?? []),
    ...(assessment?.gaps ?? []).flatMap((value) => value?.evidenceFactIds ?? []),
    ]),
  ];
  return ids.every((id) => FACT_ID.test(id)) ? [...new Set(ids)] : null;
}

/**
 * Records a review made against the fixed upstream framework. Deliberately no
 * NLP heuristic lives here: the caller supplies a structured assessment, while
 * this adapter deterministically validates anchors, evidence, gates, weights,
 * bands, and every blocked state.
 */
export function scoreJobFit({ job, facts, assessment } = {}) {
  const validatedJob = validateJobRecord(job);
  if (validatedJob.status === 'blocked') return blocked(job, 'FIT_JD_CONTRACT_INVALID', '先使用 JD intake 返回的规范 JD record。');
  if (validatedJob.record.status !== 'ready') return blocked(validatedJob.record, 'FIT_JD_CONTRACT_INVALID', '先解决该 JD intake 的 blocked 原因。');
  const validatedFacts = validateFacts(facts);
  if (validatedFacts.status === 'blocked') return blocked(validatedJob.record, 'FIT_FACT_CONTRACT_INVALID', '修正候选事实来源、确认状态和 ID 后重试。', { invalidFactId: validatedFacts.factId ?? null });
  const eligibilityIds = referencedFactIds(assessment, { eligibilityOnly: true });
  if (!assessment || typeof assessment !== 'object' || !eligibilityIds) return blocked(validatedJob.record, 'FIT_ASSESSMENT_INVALID', '提供带 JD 锚点和候选事实 ID 的结构化上游评分判断。');
  const factMap = new Map(validatedFacts.facts.map((fact) => [fact.factId, fact]));
  if (eligibilityIds.some((id) => !factMap.has(id))) return blocked(validatedJob.record, 'FIT_FACT_CONTRACT_INVALID', '评分判断只能引用当前导入集内的候选事实 ID。');
  const eligibilityFields = [...new Set(eligibilityIds.map((id) => factMap.get(id).field))];
  const eligibilityFactGate = evaluateFactGate({ jobId: validatedJob.record.jobId, facts: validatedFacts.facts, requiredFields: eligibilityFields });
  if (eligibilityFactGate.status === 'blocked') return blocked(validatedJob.record, 'FIT_FACT_GATE_BLOCKED', '先解决资格 Gate 所引用候选事实的冲突、缺失或确认问题。', { factGate: safeFactGate(eligibilityFactGate) });
  const body = validatedJob.record.normalizedBody;
  const eligibility = normalizeGate(assessment.eligibilityGate, body, factMap, ELIGIBILITY_GATE);
  if (!eligibility) return blocked(validatedJob.record, 'FIT_ASSESSMENT_INVALID', '资格 Gate 必须使用固定上游 verdict，并引用 JD 与已确认候选证据。');
  const eligibilityBase = { jobId: validatedJob.record.jobId, inputHash: validatedJob.record.inputHash, upstream: AI_JOB_SEARCH_FIT_PROVENANCE, gates: { eligibility } };
  if (eligibility.verdict === 'FAIL') return { status: 'blocked', ...eligibilityBase, reason: 'FIT_ELIGIBILITY_GATE_FAIL', nextAction: '向用户展示资格要求的 JD 原文与候选证据；不得评分或定制。' };
  if (eligibility.verdict === 'PROCEED') return { status: 'blocked', ...eligibilityBase, reason: 'FIT_ELIGIBILITY_UNVERIFIED', nextAction: '在评分或定制前核实该职位的角色级资格要求；沉默不等于许可。' };

  const ids = referencedFactIds(assessment);
  if (!ids || ids.some((id) => !factMap.has(id))) return blocked(validatedJob.record, 'FIT_FACT_CONTRACT_INVALID', '评分判断只能引用当前导入集内的候选事实 ID。');
  const requiredFields = [...new Set(ids.map((id) => factMap.get(id).field))];
  const factGate = evaluateFactGate({ jobId: validatedJob.record.jobId, facts: validatedFacts.facts, requiredFields });
  if (factGate.status === 'blocked') return blocked(validatedJob.record, 'FIT_FACT_GATE_BLOCKED', '先解决评分所引用候选事实的冲突、缺失或确认问题。', { factGate: safeFactGate(factGate) });
  const language = normalizeGate(assessment.languageGate, body, factMap, GATE, { requireNoteForFlag: true });
  if (!language) return blocked(validatedJob.record, 'FIT_ASSESSMENT_INVALID', '语言 Gate 必须使用固定上游 verdict，并引用 JD 与已确认候选证据。');
  const base = { ...eligibilityBase, gates: { eligibility, language } };
  if (language.verdict === 'FAIL') return { status: 'blocked', ...base, reason: 'FIT_LANGUAGE_GATE_FAIL', nextAction: '向用户展示语言要求 JD 原文与候选语言证据；不得评分或定制。' };

  if (!assessment.dimensions || typeof assessment.dimensions !== 'object' || Array.isArray(assessment.dimensions)
    || Object.keys(assessment.dimensions).length !== DIMENSIONS.length) return blocked(validatedJob.record, 'FIT_ASSESSMENT_INVALID', '提供固定上游的全部五个评分维度。');
  const dimensions = {};
  for (const name of DIMENSIONS) {
    dimensions[name] = normalizeDimension(name, assessment.dimensions[name], body, factMap);
    if (!dimensions[name]) return blocked(validatedJob.record, 'FIT_ASSESSMENT_INVALID', '每个维度必须有合法分数或 Location verdict，以及 JD/候选证据锚点。');
  }
  const strengths = normalizeFindings(assessment.strengths, body, factMap);
  const gaps = normalizeFindings(assessment.gaps, body, factMap);
  if (!strengths || !gaps) return blocked(validatedJob.record, 'FIT_ASSESSMENT_INVALID', 'strengths 与 gaps 最多三项，并且每项都必须有 JD 和候选证据锚点。');
  const overallScore = overallFitScore(dimensions);
  const report = { ...base, dimensions, overallScore, verdict: bandForScore(overallScore), strengths, gaps };
  if (dimensions.location.verdict === 'FAIL') return { status: 'blocked', ...report, reason: 'FIT_LOCATION_GATE_FAIL', nextAction: 'Location 是固定上游的 deal-breaker；保留评分供审阅，但不得提供定制入口。' };
  return { status: 'ready', ...report };
}

export const evaluateJobFit = scoreJobFit;

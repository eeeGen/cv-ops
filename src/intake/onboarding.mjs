import { validateEvidenceFacts } from '../contracts/evidence.mjs';
import { validateProfileFacts } from '../contracts/profile.mjs';
import { evaluateFactGate } from './fact-gate.mjs';

const onboardingBlocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });

function questionsFor(result) {
  const questions = [];
  if (result.conflicts) {
    questions.push(...result.conflicts.map((conflict) => ({
      field: conflict.field,
      reason: 'AMBIGUOUS',
      evidence: conflict.claims.flatMap((claim) => claim.evidence),
      prompt: '请确认该字段应采用哪个已有证据值。',
    })));
  }
  if (result.pending) {
    questions.push(...result.pending.map((pending) => ({
      field: pending.field,
      reason: pending.reason === 'FACT_STAR_EVIDENCE_INVALID' ? 'EVIDENCE_REFERENCE_INVALID' : 'CONFIRMATION_REQUIRED',
      evidence: pending.evidence,
      prompt: pending.reason === 'FACT_STAR_EVIDENCE_INVALID'
        ? '请将 STAR 主张关联到同一导入集内已确认的 profile 或经历证据。'
        : '请确认该导入主张，或提供更可靠的证据。',
    })));
  }
  if (result.missingFields) {
    questions.push(...result.missingFields.map((field) => ({
      field,
      reason: 'MISSING',
      evidence: [],
      prompt: '请只提供该缺失字段及其来源。',
    })));
  }
  return questions;
}

function resolvedFieldsFor(result) {
  return result.facts.map((fact) => ({ field: fact.field, evidence: fact.source }));
}

function conflictsFor(result) {
  return result.conflicts.map((conflict) => ({
    field: conflict.field,
    evidence: conflict.claims.flatMap((claim) => claim.evidence),
  }));
}

/**
 * This intake boundary accepts already-parsed, private import records. It does no
 * filesystem I/O and deliberately returns only follow-up questions or evidence
 * anchors, never values from a candidate's material.
 */
export function createOnboardingPlan({ jobId, profileFacts = [], evidenceFacts = [], requiredFields } = {}) {
  const profile = validateProfileFacts(profileFacts);
  if (profile.status === 'blocked') {
    return onboardingBlocked('PROFILE_IMPORT_INVALID', '修正 profile 导入记录的来源、锚点和确认状态后重试。', {
      invalidFactId: profile.factId ?? null,
    });
  }
  const evidence = validateEvidenceFacts(evidenceFacts);
  if (evidence.status === 'blocked') {
    return onboardingBlocked('EVIDENCE_IMPORT_INVALID', '修正 evidence 或 STAR 导入记录的来源、锚点和确认状态后重试。', {
      invalidFactId: evidence.factId ?? null,
    });
  }

  const gate = evaluateFactGate({
    jobId,
    facts: [...profile.facts, ...evidence.facts],
    requiredFields,
  });
  if (gate.status === 'ready') {
    return { status: 'ready', jobId: gate.jobId, resolvedFields: resolvedFieldsFor(gate), questions: [] };
  }
  return {
    status: 'blocked',
    jobId: gate.jobId,
    reason: gate.reason,
    nextAction: gate.nextAction,
    questions: questionsFor(gate),
    ...(gate.conflicts ? { conflicts: conflictsFor(gate) } : {}),
    ...(gate.evidence ? { evidence: gate.evidence } : {}),
  };
}

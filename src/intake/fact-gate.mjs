import { evidenceAnchorFor, factPriority, validateFacts } from '../contracts/facts.mjs';

const JOB_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,159}$/;

const blocked = (jobId, reason, nextAction, details = {}) => ({
  status: 'blocked', jobId, reason, nextAction, ...details,
});

function valueKey(value) {
  return `${typeof value}:${String(value)}`;
}

function compareFacts(facts) {
  return (left, right) => factPriority(right, facts) - factPriority(left, facts)
    || left.source.kind.localeCompare(right.source.kind)
    || left.factId.localeCompare(right.factId);
}

function normalizeRequiredFields(requiredFields, facts) {
  if (requiredFields === undefined) {
    return [...new Set(facts.map((fact) => fact.field))].sort();
  }
  if (!Array.isArray(requiredFields) || !requiredFields.every((field) => FIELD.test(field))) {
    return null;
  }
  return [...new Set(requiredFields)].sort();
}

function conflictFor(field, eligible, facts) {
  const byValue = new Map();
  for (const fact of eligible) {
    const key = valueKey(fact.value);
    const entry = byValue.get(key) ?? { value: fact.value, evidence: [] };
    entry.evidence.push(evidenceAnchorFor(fact, facts));
    byValue.set(key, entry);
  }
  return byValue.size > 1 ? { field, claims: [...byValue.values()] } : null;
}

/**
 * Resolves facts for one JD. It never writes HTML: a caller must receive ready
 * from this function before it may offer a tailoring action for that job.
 */
export function evaluateFactGate({ jobId, facts, requiredFields } = {}) {
  if (!JOB_ID.test(jobId ?? '')) {
    return blocked(null, 'JOB_ID_INVALID', '为受影响的 JD 提供一个稳定的 jobId。');
  }
  const validated = validateFacts(facts);
  if (validated.status === 'blocked') {
    return blocked(jobId, 'FACT_CONTRACT_INVALID', '修正导入事实的来源、锚点和确认状态后重试。', {
      invalidFactId: validated.factId ?? null,
    });
  }
  const fields = normalizeRequiredFields(requiredFields, validated.facts);
  if (!fields) {
    return blocked(jobId, 'FACT_FIELDS_INVALID', '仅提供需要用于该 JD 的有效事实字段名。');
  }

  const pending = [];
  const missing = [];
  const conflicts = [];
  const resolved = [];

  for (const field of fields) {
    const candidates = validated.facts.filter((fact) => fact.field === field);
    const eligible = candidates.filter((fact) => factPriority(fact, validated.facts) > 0).sort(compareFacts(validated.facts));
    const invalidStarEvidence = candidates.filter((fact) => fact.source.kind === 'star'
      && factPriority(fact, validated.facts) === 0);
    const unconfirmed = candidates.filter((fact) => factPriority(fact, validated.facts) === 0
      && fact.source.kind !== 'star');
    if (eligible.length === 0) {
      if (invalidStarEvidence.length > 0) {
        pending.push({ field, reason: 'FACT_STAR_EVIDENCE_INVALID', evidence: invalidStarEvidence.map((fact) => evidenceAnchorFor(fact, validated.facts)) });
      } else if (unconfirmed.length > 0) {
        pending.push({ field, reason: 'FACT_UNCONFIRMED', evidence: unconfirmed.map((fact) => evidenceAnchorFor(fact, validated.facts)) });
      } else {
        missing.push(field);
      }
      continue;
    }
    const conflict = conflictFor(field, eligible, validated.facts);
    if (conflict) {
      conflicts.push(conflict);
      continue;
    }
    const selected = eligible[0];
    resolved.push({
      field,
      value: selected.value,
      source: evidenceAnchorFor(selected, validated.facts),
    });
  }

  if (conflicts.length > 0) {
    return blocked(jobId, 'FACT_CONFLICT', '请求用户决定每个冲突字段；决定前不得为该 JD 生成定制 HTML。', {
      conflicts,
      evidence: conflicts.flatMap((conflict) => conflict.claims.flatMap((claim) => claim.evidence)),
      ...(pending.length > 0 ? { pending } : {}),
      ...(missing.length > 0 ? { missingFields: missing } : {}),
    });
  }
  if (pending.length > 0) {
    const invalidStarEvidence = pending.filter((entry) => entry.reason === 'FACT_STAR_EVIDENCE_INVALID');
    const reason = invalidStarEvidence.length > 0 ? 'FACT_STAR_EVIDENCE_INVALID' : 'FACT_UNCONFIRMED';
    const nextAction = invalidStarEvidence.length > 0
      ? '将 STAR 证据引用指向同一导入集内已确认的 profile 或经历证据；无效引用不能用于定制 HTML。'
      : '请求用户确认这些导入主张；未经确认的主张不能晋升为事实或用于定制 HTML。';
    return blocked(jobId, reason, nextAction, {
      pending,
      evidence: pending.flatMap((entry) => entry.evidence),
      ...(missing.length > 0 ? { missingFields: missing } : {}),
    });
  }
  if (missing.length > 0) {
    return blocked(jobId, 'FACT_MISSING', '仅向用户询问该 JD 所需的缺失字段后重试。', { missingFields: missing });
  }
  return { status: 'ready', jobId, facts: resolved };
}

export function tailoringPermission({ jobId, factGate } = {}) {
  if (!factGate || factGate.status !== 'ready' || factGate.jobId !== jobId) {
    return blocked(jobId ?? null, 'FACT_GATE_BLOCKED', '在为该 JD 写入任何定制 HTML 前，先解决事实门禁。');
  }
  return { status: 'ready', jobId };
}

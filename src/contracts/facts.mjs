const FACT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,159}$/;
const SOURCE_KINDS = new Set(['profile', 'evidence', 'star', 'archived_html']);
const CONFIRMATION_STATES = new Set(['confirmed', 'unconfirmed']);

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });

export function isPrivateRelativePath(value) {
  if (typeof value !== 'string' || value.length < 9 || value.length > 512 || value.includes('\0')) {
    return false;
  }
  const parts = value.replaceAll('\\', '/').split('/');
  return parts[0] === 'private'
    && parts.length > 1
    && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':'));
}

function isAnchor(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 256
    && !/[\0\r\n]/.test(value);
}

function isEvidenceReference(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && isPrivateRelativePath(value.path)
    && isAnchor(value.anchor);
}

function isFactValue(value) {
  return typeof value === 'string'
    ? value.length <= 2_000 && !value.includes('\0')
    : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function invalidFact(fact, reason) {
  return blocked(reason, '修正该导入记录的结构后重试；不要把未经确认的材料当作事实。', {
    factId: typeof fact?.factId === 'string' && FACT_ID.test(fact.factId) ? fact.factId : null,
  });
}

/**
 * Validates one imported claim without serializing, logging, or altering its value.
 * The returned record is deliberately allowlisted so callers cannot persist arbitrary
 * metadata from a private source.
 */
export function validateFact(fact, { allowedSourceKinds = SOURCE_KINDS } = {}) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    return invalidFact(fact, 'FACT_INVALID');
  }
  if (!FACT_ID.test(fact.factId ?? '')) {
    return invalidFact(fact, 'FACT_ID_INVALID');
  }
  if (!FIELD.test(fact.field ?? '')) {
    return invalidFact(fact, 'FACT_FIELD_INVALID');
  }
  if (!isFactValue(fact.value)) {
    return invalidFact(fact, 'FACT_VALUE_INVALID');
  }
  if (!CONFIRMATION_STATES.has(fact.confirmation)) {
    return invalidFact(fact, 'FACT_CONFIRMATION_INVALID');
  }

  const source = fact.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || !SOURCE_KINDS.has(source.kind) || !allowedSourceKinds.has(source.kind)
    || !isPrivateRelativePath(source.path) || !isAnchor(source.anchor)) {
    return invalidFact(fact, 'FACT_SOURCE_INVALID');
  }
  if (source.kind === 'star' && !isEvidenceReference(source.evidence)) {
    return invalidFact(fact, 'FACT_STAR_EVIDENCE_REQUIRED');
  }

  return {
    status: 'ready',
    fact: {
      factId: fact.factId,
      field: fact.field,
      value: fact.value,
      confirmation: fact.confirmation,
      source: {
        kind: source.kind,
        path: source.path.replaceAll('\\', '/'),
        anchor: source.anchor,
        ...(source.kind === 'star' ? {
          evidence: {
            path: source.evidence.path.replaceAll('\\', '/'),
            anchor: source.evidence.anchor,
          },
        } : {}),
      },
    },
  };
}

export function validateFacts(facts, options = {}) {
  if (!Array.isArray(facts)) {
    return blocked('FACTS_ARRAY_REQUIRED', '提供一个仅含导入事实记录的数组。');
  }
  const factIds = new Set();
  const normalized = [];
  for (const fact of facts) {
    const result = validateFact(fact, options);
    if (result.status === 'blocked') {
      return result;
    }
    if (factIds.has(result.fact.factId)) {
      return blocked('FACT_ID_DUPLICATE', '为每条导入事实使用唯一的 factId。', { factId: result.fact.factId });
    }
    factIds.add(result.fact.factId);
    normalized.push(result.fact);
  }
  return { status: 'ready', facts: normalized };
}

/**
 * Returns the fixed evidence hierarchy. A zero means the claim is not eligible
 * to become a verified fact and must remain pending confirmation.
 */
export function hasVerifiedStarEvidence(fact, facts = []) {
  if (fact.source.kind !== 'star' || !isEvidenceReference(fact.source.evidence) || !Array.isArray(facts)) {
    return false;
  }
  return facts.some((candidate) => (candidate.source.kind === 'profile' || candidate.source.kind === 'evidence')
    && candidate.confirmation === 'confirmed'
    && candidate.source.path === fact.source.evidence.path
    && candidate.source.anchor === fact.source.evidence.anchor);
}

export function factPriority(fact, facts = []) {
  if ((fact.source.kind === 'profile' || fact.source.kind === 'evidence')
    && fact.confirmation === 'confirmed') {
    return 3;
  }
  if (fact.source.kind === 'star' && hasVerifiedStarEvidence(fact, facts)) {
    return 2;
  }
  if (fact.source.kind === 'archived_html') {
    return 1;
  }
  return 0;
}

export function evidenceAnchorFor(fact, facts = []) {
  return {
    factId: fact.factId,
    source: fact.source.kind,
    path: fact.source.path,
    anchor: fact.source.anchor,
    ...(fact.source.kind === 'star' ? { evidence: fact.source.evidence } : {}),
    confirmation: fact.confirmation,
    priority: factPriority(fact, facts),
  };
}

export const FACT_SOURCE_KINDS = Object.freeze([...SOURCE_KINDS]);
export const FACT_CONFIRMATION_STATES = Object.freeze([...CONFIRMATION_STATES]);

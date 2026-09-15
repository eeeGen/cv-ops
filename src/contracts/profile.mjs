import { validateFacts } from './facts.mjs';

/** Profile claims are imported first and remain unusable until user confirmed. */
export function validateProfileFacts(facts) {
  return validateFacts(facts, { allowedSourceKinds: new Set(['profile']) });
}

import { validateFacts } from './facts.mjs';

/** Experience evidence, STAR stories, and archived resume claims retain their source kind. */
export function validateEvidenceFacts(facts) {
  return validateFacts(facts, { allowedSourceKinds: new Set(['evidence', 'star', 'archived_html']) });
}

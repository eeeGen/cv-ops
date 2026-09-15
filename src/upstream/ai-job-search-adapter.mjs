import { AI_JOB_SEARCH_FIT_PROVENANCE, FIT_BANDS, FIT_DIMENSIONS, FIT_WEIGHTS, bandForScore, overallFitScore } from '../contracts/match-report.mjs';

// This module is the sole executable representation of the imported
// evaluation framework. Constants are copied only from the fixed, recorded
// upstream document; it never reads a local checkout or a floating branch.
export const AI_JOB_SEARCH_FIT_RULES = Object.freeze({
  provenance: AI_JOB_SEARCH_FIT_PROVENANCE,
  dimensions: FIT_DIMENSIONS,
  weights: FIT_WEIGHTS,
  bands: FIT_BANDS,
  eligibilityVerdicts: Object.freeze(['PASS', 'FAIL', 'PROCEED']),
  languageVerdicts: Object.freeze(['PASS', 'FAIL', 'FLAG']),
  locationVerdicts: Object.freeze(['PASS', 'FAIL', 'FLAG']),
});

export function calculateFixedFitScore(dimensions) {
  const score = overallFitScore(dimensions);
  return score === null ? null : { score, verdict: bandForScore(score) };
}

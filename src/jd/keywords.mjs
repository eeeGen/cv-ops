import { blockedKeywordReport, CAREER_OPS_KEYWORD_PROVENANCE, KEYWORD_LIMITS } from '../contracts/keywords.mjs';
import { validateJobRecord } from '../contracts/jd.mjs';
import { extractCareerOpsKeywords, locateCareerOpsKeywordAnchors } from '../upstream/career-ops-adapter.mjs';

/**
 * Converts only exact tokens returned by the fixed upstream rule into the
 * CV-ops report shape. Under-counts and anchor failures fail closed rather than
 * padding the list with inferred terms.
 */
export function extractJobKeywords(job) {
  const validated = validateJobRecord(job);
  if (validated.status === 'blocked') {
    return blockedKeywordReport(job, 'KEYWORD_JD_CONTRACT_INVALID', '先使用 JD intake 返回的规范 JD record。');
  }
  if (validated.record.status !== 'ready') {
    return blockedKeywordReport(validated.record, 'KEYWORD_JD_BLOCKED', '先解决该 JD intake 的 blocked 原因；不可为 blocked JD 编造关键词。');
  }

  const upstream = extractCareerOpsKeywords(validated.record.normalizedBody);
  if (upstream.status === 'blocked') {
    return blockedKeywordReport(validated.record, upstream.reason, upstream.nextAction, {
      ...(upstream.upstreamDiagnosis ? { upstreamDiagnosis: upstream.upstreamDiagnosis } : {}),
    });
  }
  if (upstream.keywords.length < KEYWORD_LIMITS.minimum) {
    return blockedKeywordReport(validated.record, 'KEYWORD_COUNT_INSUFFICIENT', 'JD 的固定上游抽取结果不足 15 个；补充明确的要求后重试，不要填充推测关键词。', {
      upstreamKeywordCount: upstream.keywords.length,
    });
  }

  const selected = upstream.keywords.slice(0, KEYWORD_LIMITS.maximum);
  const anchored = locateCareerOpsKeywordAnchors(validated.record.normalizedBody, selected);
  if (anchored.status === 'blocked') {
    return blockedKeywordReport(validated.record, anchored.reason, anchored.nextAction);
  }
  const keywords = anchored.keywords.map(({ keyword, anchor }) => ({
    keyword, anchor, confidence: 1, confidenceBasis: 'upstream-exact-token',
  }));

  return {
    status: 'ready',
    jobId: validated.record.jobId,
    inputHash: validated.record.inputHash,
    upstream: CAREER_OPS_KEYWORD_PROVENANCE,
    upstreamKeywordCount: upstream.keywords.length,
    keywords,
  };
}

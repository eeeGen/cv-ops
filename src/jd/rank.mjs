import { validateMatchReport } from '../contracts/match-report.mjs';
import { validateJobRecord } from '../contracts/jd.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

/**
 * Sorts only reports that are eligible for a human selection.  The original
 * batch position is an explicit final tie-breaker instead of relying on a
 * runtime's implementation of Array#sort stability.
 */
export function rankReadyMatchReports(entries) {
  if (!Array.isArray(entries)) {
    return blocked('MATCH_RANK_ENTRIES_REQUIRED', '提供每份 JD 的批量匹配报告。');
  }

  const ranked = [];
  for (const [inputIndex, entry] of entries.entries()) {
    const job = validateJobRecord(entry?.job);
    const report = job.status === 'ready' ? validateMatchReport(entry?.report, job.record) : null;
    if (job.status !== 'ready' || report?.status !== 'ready' || report.report.status !== 'ready') {
      continue;
    }
    ranked.push({
      jobId: report.report.jobId,
      inputHash: report.report.inputHash,
      overallScore: report.report.overallScore,
      verdict: report.report.verdict,
      inputIndex,
    });
  }

  ranked.sort((left, right) => right.overallScore - left.overallScore
    || left.inputIndex - right.inputIndex
    || left.jobId.localeCompare(right.jobId));
  return { status: 'ready', ranked };
}

/**
 * There is intentionally no tailoring operation here.  T11 may proceed only
 * with the ready report returned by this selection gate.
 */
export function requireQualifiedJobSelection({ reports, jobId } = {}) {
  if (!Array.isArray(reports)) {
    return blocked('MATCH_SELECTION_REPORTS_REQUIRED', '先完成批量匹配并生成每份 JD 报告。');
  }
  const eligibleEntries = reports.filter((entry) => {
    const job = validateJobRecord(entry?.job);
    const report = job.status === 'ready' ? validateMatchReport(entry?.report, job.record) : null;
    return report?.status === 'ready' && report.report.status === 'ready';
  });
  const eligible = eligibleEntries.map((entry) => entry.report.jobId);
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return blocked('QUALIFIED_JOB_SELECTION_REQUIRED', '请从合格 JD 报告中明确选择一个职位；选择前不得生成定制 HTML。');
  }
  const selected = eligibleEntries.find((entry) => entry.report.jobId === jobId);
  if (!selected) {
    return blocked('QUALIFIED_JOB_SELECTION_INVALID', '只能选择状态为 ready 的合格 JD；blocked 或 Gate 未通过的 JD 不可定制。');
  }
  return { status: 'ready', selected: selected.report, eligibleJobIds: eligible };
}

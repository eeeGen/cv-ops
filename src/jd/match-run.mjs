import { validateJobRecord } from '../contracts/jd.mjs';
import { AI_JOB_SEARCH_FIT_PROVENANCE, blockedMatchReport, validateMatchReport } from '../contracts/match-report.mjs';
import { scoreJobFit } from './fit-score.mjs';
import { rankReadyMatchReports, requireQualifiedJobSelection } from './rank.mjs';

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

function reportForUnavailableJob(job) {
  const jobId = typeof job?.jobId === 'string' ? job.jobId : null;
  const inputHash = typeof job?.inputHash === 'string' ? job.inputHash : null;
  return {
    ...blockedMatchReport(job, 'FIT_JD_CONTRACT_INVALID', '先修正该 JD intake；其他批量项可继续处理。'),
    jobId,
    inputHash,
    upstream: AI_JOB_SEARCH_FIT_PROVENANCE,
  };
}

function assessmentFor(assessments, jobId) {
  return assessments && typeof assessments === 'object' && !Array.isArray(assessments)
    ? assessments[jobId]
    : undefined;
}

function withJobMetadata(report, job) {
  return {
    ...report,
    source: typeof job?.source === 'string' ? job.source : null,
    inputType: typeof job?.inputType === 'string' ? job.inputType : null,
  };
}

/**
 * Produces an independent, validated report for every received JD.  A bad
 * URL/intake record, missing assessment, or Fit/Fact Gate only blocks that
 * report; it cannot terminate the rest of the batch.
 */
export function createBatchMatchRun({ jobs, facts, assessments } = {}) {
  if (!Array.isArray(jobs)) {
    return blocked('MATCH_BATCH_JOBS_REQUIRED', '提供由 JD intake 返回的 JD record 数组。');
  }
  if (!assessments || typeof assessments !== 'object' || Array.isArray(assessments)) {
    return blocked('MATCH_BATCH_ASSESSMENTS_REQUIRED', '为每份可处理 JD 提供结构化 Fit assessment。');
  }

  const reports = jobs.map((job, inputIndex) => {
    const validated = validateJobRecord(job);
    const scored = validated.status === 'ready'
      ? scoreJobFit({ job: validated.record, facts, assessment: assessmentFor(assessments, validated.record.jobId) })
      : reportForUnavailableJob(job);
    const report = withJobMetadata(scored, validated.status === 'ready' ? validated.record : job);
    const checked = validated.status === 'ready' ? validateMatchReport(report, validated.record) : null;
    const safeReport = checked?.status === 'ready' ? checked.report : withJobMetadata(reportForUnavailableJob(job), job);
    return {
      inputIndex,
      job: validated.status === 'ready' ? validated.record : {
        jobId: safeReport.jobId,
        inputHash: safeReport.inputHash,
        status: 'blocked',
        source: typeof job?.source === 'string' ? job.source : null,
      },
      report: safeReport,
    };
  });
  const ranking = rankReadyMatchReports(reports);
  if (ranking.status === 'blocked') return ranking;
  const selection = requireQualifiedJobSelection({ reports });

  return {
    status: 'complete',
    upstreamVersions: { aiJobSearchCodex: AI_JOB_SEARCH_FIT_PROVENANCE.revision },
    reports,
    ranking: ranking.ranked,
    selection,
  };
}

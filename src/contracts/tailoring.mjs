import { validateMatchReport } from './match-report.mjs';
import { validateResumeReceipt } from './resume.mjs';
import { validateJobRecord } from './jd.mjs';
import { validateTailoringChanges } from './changes.mjs';
import { requireQualifiedJobSelection } from '../jd/rank.mjs';

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * A selection has to be an intentional, UI-level confirmation rather than a
 * convenient default to the first ranked result.  Callers retain the returned
 * report only after both checks agree on the same ready JD.
 */
export function selectQualifiedJob({ reports, selection } = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || selection.confirmed !== true || typeof selection.jobId !== 'string') {
    return blocked('TAILORING_SELECTION_REQUIRED', '请明确确认一个状态为 ready 的 JD；确认前不得生成定制 HTML。');
  }
  const qualified = requireQualifiedJobSelection({ reports, jobId: selection.jobId });
  if (qualified.status === 'blocked') return qualified;
  const entry = reports.find((candidate) => candidate?.report?.jobId === selection.jobId);
  const job = validateJobRecord(entry?.job);
  const report = qualified.selected;
  const checked = job.status === 'ready' ? validateMatchReport(report, job.record) : null;
  if (checked.status !== 'ready' || checked.report.status !== 'ready') {
    return blocked('TAILORING_MATCH_NOT_QUALIFIED', '仅可为通过 Gate 且事实已验证的 JD 创建定制 HTML。');
  }
  return { status: 'ready', jobId: selection.jobId, report: checked.report, job: job.record };
}

export function validateTailoringRequest({ runId, selection, factGate, receipt, changes } = {}) {
  if (!RUN_ID.test(runId ?? '')) return blocked('TAILORING_RUN_ID_INVALID', '使用仅含字母、数字、连字符或下划线的新的 runId。');
  const selectedJob = validateJobRecord(selection?.job);
  const selectedReport = selectedJob.status === 'ready' ? validateMatchReport(selection?.report, selectedJob.record) : null;
  if (!selection || selection.status !== 'ready' || selectedJob.status !== 'ready' || selectedReport?.status !== 'ready'
    || selectedReport.report.status !== 'ready' || selection.jobId !== selectedJob.record.jobId) {
    return blocked('TAILORING_SELECTION_REQUIRED', '先取得用户明确选择的合格 JD。');
  }
  if (!factGate || factGate.status !== 'ready' || factGate.jobId !== selection.jobId) {
    return blocked('TAILORING_FACT_GATE_BLOCKED', '先解决该 JD 的事实冲突、缺失或未确认主张。');
  }
  const resume = validateResumeReceipt(receipt);
  if (resume.status !== 'ready' || resume.receipt.status !== 'ready' || receipt.inputFormat !== 'html') {
    return blocked('TAILORING_RESUME_UNAVAILABLE', '使用已归档且可编辑的 HTML 简历；PDF 或 blocked 输入不得生成 HTML。');
  }
  if (!SHA256.test(receipt.normalized?.sha256 ?? '') || !SHA256.test(receipt.original?.sha256 ?? '')) {
    return blocked('TAILORING_RESUME_HASH_INVALID', '使用带有可复核原件和规范化副本哈希的简历收据。');
  }
  const checkedChanges = validateTailoringChanges(changes, selectedJob.record.normalizedBody);
  if (checkedChanges.status === 'blocked') return checkedChanges;
  if (!Array.isArray(factGate.facts)) {
    return blocked('TAILORING_FACT_GATE_BLOCKED', '使用该 JD 的事实门禁返回的已解析证据；不得手工伪造通过状态。');
  }
  const allowedEvidence = new Set(factGate.facts.map((fact) => {
    const source = fact?.source;
    return source ? `${source.factId}\u0000${source.path}\u0000${source.anchor}\u0000${source.confirmation}\u0000${source.priority}` : '';
  }));
  if (checkedChanges.changes.some((change) => change.evidence.some((source) => !allowedEvidence.has(`${source.factId}\u0000${source.path}\u0000${source.anchor}\u0000${source.confirmation}\u0000${source.priority}`)))) {
    return blocked('TAILORING_CHANGE_EVIDENCE_UNAVAILABLE', '每项修改只能引用该 JD 已通过事实门禁的已确认事实证据。');
  }
  return { status: 'ready', request: { runId, selection, factGate, receipt, changes } };
}

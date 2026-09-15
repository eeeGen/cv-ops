const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const blocked = (reason, nextAction) => ({ status: 'blocked', reason, nextAction });

function privatePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return parts[0] === 'private' && parts.length > 1
    && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':'));
}

function dependency(value) {
  return value && typeof value === 'object'
    && (value.status === 'ready' || value.status === 'blocked')
    && (value.status === 'ready' || (typeof value.reason === 'string' && value.reason.length > 0));
}

function checks(value) {
  const names = ['imageText', 'nestedTables', 'hiddenKeywords', 'keywordEmbedding', 'readableText'];
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length
    && names.every((name) => value[name] && typeof value[name] === 'object'
      && typeof value[name].status === 'string' && typeof value[name].detail === 'string');
}

/**
 * Validates untrusted ATS report input.  A public JSON report can never prove
 * that this process launched Chromium, so passed reports are gate-only values
 * and are rejected here.  `runAtsGate` is the sole path permitted to return a
 * passed result after its private browser + verifier execution has completed.
 */
export function validateAtsReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || !RUN_ID.test(report.runId ?? '') || !privatePath(report.input?.path) || !HASH.test(report.input?.sha256 ?? '')
    || !dependency(report.dependencies?.node) || !dependency(report.dependencies?.playwright)
    || !dependency(report.dependencies?.chromium) || !Array.isArray(report.rounds) || report.rounds.length === 0
    || !checks(report.checks) || !report.final || typeof report.final !== 'object') {
    return blocked('ATS_REPORT_INVALID', '使用 ATS 门禁生成的完整结构化报告。');
  }
  const executed = report.rounds.every((round, index) => Number.isInteger(round.round) && round.round === index + 1
    && HASH.test(round.inputSha256 ?? '') && ['executed', 'blocked', 'failed'].includes(round.render?.status)
    && ['executed', 'not_executed', 'failed'].includes(round.verify?.status));
  if (!executed || !['passed', 'blocked', 'failed'].includes(report.final.status)) {
    return blocked('ATS_REPORT_INVALID', 'ATS 报告必须逐轮保存渲染与原样校验执行状态。');
  }
  if (report.status === 'ready') {
    return blocked('ATS_REPORT_GATE_ONLY', 'ATS 通过只能由本进程的 runAtsGate 真实渲染与登记校验流程返回。');
  }
  if (report.status === 'blocked' && report.final.status !== 'passed' && typeof report.reason === 'string'
    && typeof report.nextAction === 'string' && report.nextAction.length > 0) return { status: 'ready', report };
  return blocked('ATS_REPORT_INVALID', '未执行、失败或缺失依赖的 ATS 结果必须为 blocked，且不得显示通过。');
}

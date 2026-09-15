import { runAtsGate } from './gate.mjs';

/**
 * A rerun accepts a new immutable output only. It never edits HTML itself, so
 * repairs remain attributable to the registered tailoring chain.
 */
export async function rerunAtsGate(options = {}) {
  if (!options.previousReport || options.previousReport.status !== 'blocked') {
    return { status: 'blocked', reason: 'ATS_RERUN_PREVIOUS_REPORT_REQUIRED', nextAction: '仅在已记录的 blocked ATS 结果后，以新的定制 HTML 和 runId 重跑。' };
  }
  if (options.inputPath === options.previousReport.input?.path) {
    return { status: 'blocked', reason: 'ATS_RERUN_NEW_OUTPUT_REQUIRED', nextAction: '按登记的定制链路生成新的独立 HTML 后再重跑；ATS 门禁不得原地改写简历。' };
  }
  const { render: _ignoredRenderer, ...request } = options;
  return runAtsGate(request);
}

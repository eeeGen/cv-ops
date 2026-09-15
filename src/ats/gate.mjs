import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { validateAtsReport } from '../contracts/ats-report.mjs';
import { createRunRecord } from '../contracts/run-record.mjs';
import { assertSafeDirectoryPath, UnsafeWorkspacePathError, validateWorkspaceTarget } from '../workspace/validate.mjs';
import { renderHtmlForAts } from './render.mjs';

export const CAREER_OPS_ATS_REVISION = 'da8c6f9193ac3d7a48a583f815b7d0feab742b81';
export const VERIFY_ATS_SHA256 = '11c12ee06f50b78831402079fe0d2a33bdbeede32c294a8653a3a1e4549be674';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
// Intentionally private to this module: no consumer can ask the ATS boundary
// to sign arbitrary bytes. It dies with the running gate session.
const executionKey = randomBytes(32);

function attestCompletedExecution({ runId, inputSha256, screenshot, renderedText, verifierOutput, security }) {
  if (security?.javaScriptEnabled !== false || security?.network !== 'blocked') return null;
  const execution = {
    runId,
    inputSha256,
    screenshotSha256: sha256(screenshot),
    renderedTextSha256: sha256(Buffer.from(renderedText, 'utf8')),
    verifierOutputSha256: sha256(Buffer.from(verifierOutput, 'utf8')),
    security: { javaScriptEnabled: false, network: 'blocked' },
  };
  const message = [execution.runId, execution.inputSha256, execution.screenshotSha256,
    execution.renderedTextSha256, execution.verifierOutputSha256, JSON.stringify(execution.security)].join('\0');
  return { ...execution, proof: createHmac('sha256', executionKey).update(message).digest('hex') };
}

function privateRelative(value) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return parts[0] === 'private' && parts.length > 1
    && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':'));
}

function reportedDependency(value, fallback) {
  if (value && typeof value === 'object' && (value.status === 'ready' || value.status === 'blocked')) return value;
  return { status: 'blocked', reason: fallback, stage: 'dependency-evidence', command: 'renderHtmlForAts' };
}

async function readPrivateFile(workspacePath, inputPath) {
  if (!privateRelative(inputPath)) throw new UnsafeWorkspacePathError();
  const path = join(workspacePath, ...inputPath.split('/'));
  if (relative(resolve(workspacePath), resolve(path)).startsWith('..')) throw new UnsafeWorkspacePathError();
  const parent = inputPath.split('/').slice(0, -1).join('/');
  await assertSafeDirectoryPath(workspacePath, parent);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new UnsafeWorkspacePathError();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink()) throw new UnsafeWorkspacePathError();
  return { path, bytes };
}

function execute(command, args) {
  return new Promise((resolveExecution) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolveExecution({ code: null, stdout, stderr, error: error.code ?? 'SPAWN_FAILED' }));
    child.once('close', (code) => resolveExecution({ code, stdout, stderr }));
  });
}

/** Runs the registered verifier as its original CLI, without importing or rewriting its scoring rules. */
export async function runRegisteredAtsVerifier({ pluginRoot, inputAbsolutePath, keywords = [] } = {}) {
  const verifier = join(pluginRoot ?? '', 'upstream', 'career-ops', 'verify-ats.mjs');
  let verifierBytes;
  try { verifierBytes = await readFile(verifier); } catch { return blocked('ATS_VERIFIER_UNAVAILABLE', '恢复登记的 career-ops verify-ats.mjs 后重试。'); }
  // Git may materialize the registered LF blob as CRLF on Windows.  Verify the
  // canonical bytes so that line-ending conversion does not create a false
  // integrity failure, while any content modification still fails closed.
  if (sha256(Buffer.from(verifierBytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8')) !== VERIFY_ATS_SHA256) {
    return blocked('ATS_VERIFIER_INTEGRITY_FAILED', '恢复登记的原样 verify-ats.mjs；不得修改 ATS 规则。');
  }
  const checkedKeywords = Array.isArray(keywords) && keywords.length <= 20
    && keywords.every((keyword) => typeof keyword === 'string' && keyword.length >= 2 && keyword.length <= 100 && !/[\u0000-\u001F\u007F-\u009F]/u.test(keyword));
  if (!checkedKeywords) return blocked('ATS_KEYWORDS_INVALID', '使用不超过 20 个、可显示的 JD 关键词。');
  const args = [verifier, inputAbsolutePath, '--json'];
  if (keywords.length) args.push('--keywords', keywords.join(','));
  const result = await execute(process.execPath, args);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch {
    return blocked('ATS_VERIFIER_FAILED', '登记的 ATS 校验没有产生有效结果；修复环境后重试。', { execution: result.code ?? result.error ?? 'FAILED' });
  }
  return {
    status: 'ready',
    pass: result.code === 0 && parsed.pass === true,
    execution: { code: result.code, stderr: result.stderr.slice(0, 500) },
    result: parsed,
  };
}

function inspectionChecks(inspection, keywords, verifier) {
  const visible = inspection.text.replace(/\s+/g, ' ').trim();
  const lower = visible.toLowerCase();
  const normalizedKeywords = [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()))];
  const found = normalizedKeywords.filter((keyword) => lower.includes(keyword));
  return {
    imageText: { status: verifier.result.issues.some((issue) => /image/i.test(issue.message)) ? 'flagged' : 'checked', detail: `rendered images: ${inspection.imageCount}` },
    nestedTables: { status: inspection.nestedTables > 0 ? 'flagged' : 'checked', detail: `nested tables: ${inspection.nestedTables}` },
    hiddenKeywords: { status: inspection.hiddenText ? 'flagged' : 'checked', detail: inspection.hiddenText ? 'rendered hidden text detected' : 'no rendered hidden text' },
    keywordEmbedding: { status: found.length === normalizedKeywords.length ? 'checked' : 'flagged', detail: `visible keyword phrases: ${found.length}/${normalizedKeywords.length}` },
    readableText: { status: visible.length >= 300 ? 'checked' : 'flagged', detail: `rendered readable characters: ${visible.length}` },
  };
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

/**
 * Executes the real browser/render/verifier sequence and persists only a private,
 * immutable report. A dependency or execution failure is always `blocked`.
 */
export async function runAtsGate({ workspacePath, pluginRoot, runId, inputPath, keywords = [], now = () => new Date() } = {}) {
  if (!RUN_ID.test(runId ?? '') || !privateRelative(inputPath)) {
    return blocked('ATS_REQUEST_INVALID', '使用新的安全 runId 与 private/ 下的定制 HTML 路径。');
  }
  const workspace = await validateWorkspaceTarget({ workspacePath, pluginRoot });
  if (workspace.status === 'blocked') return workspace;
  let input;
  try { input = await readPrivateFile(workspace.workspacePath, inputPath); } catch {
    return blocked('ATS_INPUT_PATH_UNSAFE', '使用未被符号链接或联接重定向的私有定制 HTML。');
  }
  const inputSha256 = sha256(input.bytes);
  // Do not accept a caller-supplied renderer: a fake `{ status: 'ready' }`
  // object is not evidence that this process actually launched Chromium.
  const rendered = await renderHtmlForAts({ htmlBytes: input.bytes });
  const dependencies = {
    node: { status: 'ready', stage: 'runtime', command: process.execPath, version: process.version },
    playwright: reportedDependency(rendered.dependencies?.playwright, 'PLAYWRIGHT_DEPENDENCY_EVIDENCE_MISSING'),
    chromium: reportedDependency(rendered.dependencies?.chromium, 'CHROMIUM_DEPENDENCY_EVIDENCE_MISSING'),
  };
  const round = { round: 1, inputSha256, render: { status: rendered.status === 'ready' ? 'executed' : rendered.reason === 'RENDER_FAILED' ? 'failed' : 'blocked' }, verify: { status: 'not_executed' } };
  let verifier = null;
  let checks = {
    imageText: { status: 'not_executed', detail: 'render not completed' }, nestedTables: { status: 'not_executed', detail: 'render not completed' }, hiddenKeywords: { status: 'not_executed', detail: 'render not completed' }, keywordEmbedding: { status: 'not_executed', detail: 'render not completed' }, readableText: { status: 'not_executed', detail: 'render not completed' },
  };
  if (rendered.status === 'ready') {
    verifier = await runRegisteredAtsVerifier({ pluginRoot: workspace.pluginRoot, inputAbsolutePath: input.path, keywords });
    if (verifier.status === 'ready') {
      round.verify = { status: 'executed', pass: verifier.pass, code: verifier.execution.code };
      checks = inspectionChecks(rendered.inspection, keywords, verifier);
    } else {
      round.verify = { status: 'failed', reason: verifier.reason };
      checks = {
        imageText: { status: 'not_executed', detail: 'registered verifier failed' }, nestedTables: { status: 'not_executed', detail: 'registered verifier failed' }, hiddenKeywords: { status: 'not_executed', detail: 'registered verifier failed' }, keywordEmbedding: { status: 'not_executed', detail: 'registered verifier failed' }, readableText: { status: 'not_executed', detail: 'registered verifier failed' },
      };
    }
  }
  const successful = rendered.status === 'ready' && verifier?.status === 'ready' && verifier.pass === true;
  const finalReason = successful ? null : (rendered.reason ?? verifier?.reason ?? 'ATS_VERIFIER_FAILED');
  const report = {
    status: successful ? 'ready' : 'blocked', runId,
    input: { path: inputPath, sha256: inputSha256 }, dependencies, rounds: [round], checks,
    final: { status: successful ? 'passed' : rendered.status === 'ready' ? 'failed' : 'blocked' },
    ...(successful ? {} : { reason: finalReason, nextAction: '修复依赖或按登记的定制链路修复 HTML 后，以新的 runId 重新渲染和校验。' }),
  };
  if (successful) {
    const execution = attestCompletedExecution({
      runId,
      inputSha256,
      screenshot: rendered.screenshot,
      renderedText: rendered.inspection.text,
      verifierOutput: JSON.stringify(verifier.result),
      security: rendered.security,
    });
    if (!execution) return blocked('ATS_EXECUTION_PROOF_INVALID', '重新执行真实 Chromium 渲染与登记 ATS 校验。');
    report.execution = execution;
  }
  // Public report validation is intentionally fail-closed for ready/passed
  // JSON.  Only validate blocked payloads here; a successful object is created
  // exclusively by the private execution sequence above.
  if (!successful && validateAtsReport(report).status === 'blocked') return blocked('ATS_REPORT_INVALID', 'ATS 门禁未能生成可审计的报告。');
  const base = `private/runs/${runId}`;
  const reportPath = `${base}/ats-report.json`;
  const screenshotPath = `${base}/render.png`;
  const artifacts = rendered.status === 'ready' ? [reportPath, screenshotPath] : [reportPath];
  const persisted = await createRunRecord({
    workspacePath: workspace.workspacePath, pluginRoot: workspace.pluginRoot,
    run: { runId, inputSources: [{ source: inputPath, sha256: inputSha256 }], upstreamVersions: { careerOps: CAREER_OPS_ATS_REVISION }, artifactPaths: artifacts, status: successful ? 'complete' : 'blocked', ...(successful ? {} : { reason: rendered.status === 'ready' ? 'ATS_FAILED' : rendered.reason === 'RENDER_FAILED' ? 'RENDER_FAILED' : 'ATS_NOT_EXECUTED' }) }, now,
  }, {
    beforeRecordWrite: async ({ runDirectory }) => {
      await assertSafeDirectoryPath(workspace.workspacePath, 'private');
      await assertSafeDirectoryPath(workspace.workspacePath, 'private/runs');
      await assertSafeDirectoryPath(workspace.workspacePath, base);
      await writeExclusive(join(runDirectory, 'ats-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      if (rendered.status === 'ready') await writeExclusive(join(runDirectory, 'render.png'), rendered.screenshot);
    },
  });
  return persisted.status === 'ready' ? { ...report, reportPath, recordPath: persisted.recordPath } : persisted;
}

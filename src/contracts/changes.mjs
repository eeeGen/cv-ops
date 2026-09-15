const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
const ANCHOR = (value) => value && typeof value === 'object'
  && Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start
  && Number.isInteger(value.line) && value.line >= 1 && Number.isInteger(value.column) && value.column >= 1;
const EVIDENCE = (value) => value && typeof value === 'object'
  && typeof value.factId === 'string' && typeof value.path === 'string' && value.path.startsWith('private/')
  && typeof value.anchor === 'string' && value.anchor.length > 0 && value.confirmation === 'confirmed'
  && Number.isInteger(value.priority) && value.priority > 0;

// The tailoring surface is deliberately plain text. Invisible directional
// controls, tags, event-handler syntax, and character references are rejected
// rather than normalized into an ambiguous statement or rendered as markup.
export function isSafeTailoringText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4000
    && !/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]/u.test(value)
    && !/[<>]/.test(value)
    && !/&(?:#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/iu.test(value)
    && !/\bon[a-z][a-z0-9_-]*\s*=/iu.test(value)
    && !/\b(?:javascript|vbscript|data)\s*:/iu.test(value);
}

function markdownText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Changes are deliberately literal text substitutions. This preserves the DOM,
 * CSS, and layout; anything more structural belongs in a separately reviewed flow. */
export function validateTailoringChanges(changes, jdBody) {
  if (!Array.isArray(changes) || changes.length > 50) {
    return blocked('TAILORING_CHANGES_INVALID', '使用不超过 50 条、带完整锚点的文本修改。');
  }
  const ids = new Set();
  const normalized = [];
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)
      || typeof change.changeId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(change.changeId)
      || ids.has(change.changeId) || !isSafeTailoringText(change.oldText) || !isSafeTailoringText(change.newText)
      || typeof change.reason !== 'string' || change.reason.trim().length === 0 || change.reason.length > 500
      || !Array.isArray(change.jdAnchors) || change.jdAnchors.length === 0 || !change.jdAnchors.every((anchor) => ANCHOR(anchor) && anchor.end <= jdBody.length)
      || !Array.isArray(change.evidence) || change.evidence.length === 0 || !change.evidence.every(EVIDENCE)
      || change.confirmation !== 'confirmed') {
      return blocked('TAILORING_CHANGE_UNCONFIRMED', '任何合理强化、数字、经历或技术主张均须有已确认事实证据；未确认项不得写入 HTML。', { changeId: change?.changeId ?? null });
    }
    ids.add(change.changeId);
    normalized.push({
      changeId: change.changeId, oldText: change.oldText, newText: change.newText, reason: change.reason,
      jdAnchors: change.jdAnchors.map(({ start, end, line, column }) => ({ start, end, line, column })),
      evidence: change.evidence.map(({ factId, source, path, anchor, confirmation, priority, evidence }) => ({
        factId, source, path, anchor, confirmation, priority, ...(evidence ? { evidence } : {}),
      })),
      confirmation: 'confirmed',
    });
  }
  return { status: 'ready', changes: normalized };
}

export function renderChangesMarkdown({ runId, jobId, changes }) {
  const entries = changes.map((change) => [
    `## ${change.changeId}`,
    `- 旧内容：${JSON.stringify(markdownText(change.oldText))}`,
    `- 新内容：${JSON.stringify(markdownText(change.newText))}`,
    `- 理由：${markdownText(change.reason)}`,
    `- JD 锚点：${change.jdAnchors.map((anchor) => `${anchor.line}:${anchor.column}-${anchor.end}`).join(', ')}`,
    `- 事实/证据锚点：${change.evidence.map((anchor) => `${anchor.factId}@${anchor.path}#${anchor.anchor}`).join(', ')}`,
    `- 确认状态：已确认`,
    '',
  ].join('\n'));
  return [`# 定制修改记录`, '', `- runId：${runId}`, `- JD：${jobId}`, `- 修改数：${changes.length}`, '', ...entries].join('\n').replace(/\n*$/, '\n');
}

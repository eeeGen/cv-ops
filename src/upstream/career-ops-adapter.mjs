import { diagnoseExtraction, extractJdSkills } from '../../upstream/career-ops/jd-skill-gap.mjs';

import { CAREER_OPS_KEYWORD_PROVENANCE } from '../contracts/keywords.mjs';

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });

function isWordCharacter(character) {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function exactTokenIndex(line, keyword) {
  let start = line.indexOf(keyword);
  while (start >= 0) {
    const end = start + keyword.length;
    if (!isWordCharacter(line[start - 1]) && !isWordCharacter(line[end])) return start;
    start = line.indexOf(keyword, start + 1);
  }
  return -1;
}

/**
 * Maps a returned upstream token back to the first line prefix for which the
 * unmodified upstream extractor emits it. This differential lookup deliberately
 * reuses the rule instead of duplicating its requirements-section state machine.
 */
function locateUpstreamToken(body, keyword, lines, lineStarts, cache) {
  const extractedAt = (lineIndex) => {
    if (!cache.has(lineIndex)) cache.set(lineIndex, extractJdSkills(lines.slice(0, lineIndex + 1).join('\n')));
    return cache.get(lineIndex);
  };
  if (!extractedAt(lines.length - 1).includes(keyword)) return null;

  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (extractedAt(middle).includes(keyword)) high = middle;
    else low = middle + 1;
  }
  const columnOffset = exactTokenIndex(lines[low], keyword);
  if (columnOffset < 0) return null;
  const start = lineStarts[low] + columnOffset;
  return {
    start,
    end: start + keyword.length,
    line: low + 1,
    column: columnOffset + 1,
  };
}

/**
 * Calls the registered, byte-for-byte imported career-ops rule. This adapter
 * deliberately neither tokenizes nor canonicalizes the returned keywords.
 */
export function extractCareerOpsKeywords(normalizedBody) {
  if (typeof normalizedBody !== 'string' || normalizedBody.length === 0) {
    return blocked('CAREER_OPS_INPUT_INVALID', '提供由 JD intake 生成的非空规范正文。');
  }
  try {
    const keywords = extractJdSkills(normalizedBody);
    if (!Array.isArray(keywords) || !keywords.every((keyword) => typeof keyword === 'string' && keyword.length > 0)) {
      return blocked('CAREER_OPS_EXTRACTION_INVALID', '检查固定 career-ops 抽取器输出；不要生成替代关键词。');
    }
    if (keywords.length === 0) {
      const diagnosis = diagnoseExtraction(normalizedBody, keywords);
      const reason = diagnosis?.reason === 'no-requirements-section'
        ? 'CAREER_OPS_NO_REQUIREMENTS_SECTION' : 'CAREER_OPS_NO_SKILL_CANDIDATES';
      return blocked(reason, '补充可识别的岗位要求段落和明确技能后重试；不要手工编造关键词。', {
        ...(diagnosis?.message ? { upstreamDiagnosis: diagnosis.reason } : {}),
      });
    }
    return { status: 'ready', keywords, upstream: CAREER_OPS_KEYWORD_PROVENANCE };
  } catch {
    return blocked('CAREER_OPS_EXTRACTION_FAILED', '检查固定 career-ops 抽取器或 JD 正文后重试；不要生成替代关键词。');
  }
}

/**
 * Produces anchors only by differential calls to the fixed extractor. A token
 * found outside the source requirement line is never substituted as its anchor.
 */
export function locateCareerOpsKeywordAnchors(normalizedBody, keywords) {
  if (typeof normalizedBody !== 'string' || normalizedBody.length === 0
    || !Array.isArray(keywords) || !keywords.every((keyword) => typeof keyword === 'string' && keyword.length > 0)) {
    return blocked('CAREER_OPS_ANCHOR_INPUT_INVALID', '提供固定上游抽取器返回的关键词和非空规范 JD 正文。');
  }
  try {
    const lines = normalizedBody.split('\n');
    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    const cache = new Map();
    const anchored = [];
    for (const keyword of keywords) {
      const anchor = locateUpstreamToken(normalizedBody, keyword, lines, lineStarts, cache);
      if (!anchor) {
        return blocked('CAREER_OPS_ANCHOR_UNRESOLVED', '无法将固定上游 token 追溯到其要求段来源；停止处理并检查上游版本。');
      }
      anchored.push({ keyword, anchor });
    }
    return { status: 'ready', keywords: anchored };
  } catch {
    return blocked('CAREER_OPS_ANCHOR_FAILED', '固定上游关键词来源定位失败；停止处理并检查 JD 或上游版本。');
  }
}

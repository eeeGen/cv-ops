import { createHash } from 'node:crypto';

import { validateTailoringChanges } from '../contracts/changes.mjs';

const blocked = (reason, nextAction, details = {}) => ({ status: 'blocked', reason, nextAction, ...details });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function escapeTextNode(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function closingTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

/** Returns only ordinary text-node ranges, never tags, attributes, comments, or CSS/script raw text. */
const VISIBLE_TEXT_CONTAINERS = new Set([
  'a', 'abbr', 'address', 'article', 'b', 'blockquote', 'body', 'button', 'caption', 'cite', 'code', 'dd', 'del',
  'details', 'div', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'label', 'legend', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strong',
  'summary', 'td', 'th', 'time', 'u', 'ul',
]);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_OR_NONVISIBLE_ELEMENTS = new Set([
  'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'template', 'textarea', 'title', 'xmp',
]);

function tagName(token) {
  const match = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b/);
  return match ? { closing: match[1] === '/', name: match[2].toLowerCase() } : null;
}

function parseAttributes(token) {
  const match = token.match(/^<\s*[A-Za-z][A-Za-z0-9:-]*\b/);
  if (!match) return null;
  const source = token.slice(match[0].length, -1);
  const attributes = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (cursor >= source.length || source[cursor] === '/') {
      if (source.slice(cursor).trim().replace(/\/$/u, '') !== '') return null;
      break;
    }
    const name = source.slice(cursor).match(/^[A-Za-z_:][A-Za-z0-9_:.-]*/u)?.[0];
    if (!name) return null;
    cursor += name.length;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    let value = null;
    if (source[cursor] === '=') {
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const end = source.indexOf(quote, cursor);
        if (end < 0) return null;
        value = source.slice(cursor, end);
        cursor = end + 1;
      } else {
        const start = cursor;
        while (cursor < source.length && !/\s/u.test(source[cursor])) cursor += 1;
        value = source.slice(start, cursor);
        // Empty and syntactically structural unquoted values cannot be given a
        // dependable visibility meaning without an HTML parser.
        if (value.length === 0 || /["'<=`]/u.test(value)) return null;
      }
    }
    attributes.push({ name: name.toLowerCase(), value });
  }
  return attributes;
}

function hasHiddenStyle(value) {
  if (typeof value !== 'string') return true;
  // CSS comments, escapes, control characters, and unmatched structural input
  // make visibility interpretation ambiguous, so this boundary fails closed.
  // In particular, browsers decode named, decimal, and hexadecimal character
  // references (with or without a semicolon) before applying an attribute.
  // Rather than broaden the allowlist with a partial entity decoder, any `&`
  // in CSS is conservatively non-visible.
  if (/\/\*|\*\/|\\|&|[\u0000-\u001F\u007F-\u009F]/u.test(value)) return true;
  // Custom properties and functions can affect display/visibility through
  // inheritance, fallback values, or later substitution. Without a complete
  // CSS cascade implementation, no such value is safe to call visible.
  if (/--[A-Za-z0-9_-]+|\b[a-z-]+\s*\(/iu.test(value)) return true;
  return /\bdisplay\s*:\s*none\b/iu.test(value)
    || /\bvisibility\s*:\s*hidden\b/iu.test(value);
}

function isHiddenContainer(token) {
  const attributes = parseAttributes(token);
  if (!attributes) return true;
  for (const attribute of attributes) {
    if (attribute.name === 'hidden') return true;
    if (attribute.name === 'aria-hidden' && attribute.value?.trim().toLowerCase() !== 'false') return true;
    if (attribute.name === 'style' && hasHiddenStyle(attribute.value)) return true;
  }
  return false;
}

/**
 * Produces ranges only for a conservative allowlist of ordinary visible text
 * containers. Everything else, including every raw-text/embedded element, is
 * fail-closed. This is deliberately not a blacklist of payload names.
 */
function textNodeRanges(html) {
  const ranges = [];
  const stack = [];
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) {
      if (cursor < html.length && stack.at(-1)?.visible) ranges.push([cursor, html.length]);
      break;
    }
    if (cursor < tagStart && stack.at(-1)?.visible) ranges.push([cursor, tagStart]);
    // A comment can contain any number of `>` characters. It is neither a
    // visible text node nor a tag, so it must be consumed to its real terminator
    // before ordinary tag scanning resumes.
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      if (commentEnd < 0) return null;
      cursor = commentEnd + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', tagStart)) {
      const cdataEnd = html.indexOf(']]>', tagStart + 9);
      if (cdataEnd < 0) return null;
      cursor = cdataEnd + 3;
      continue;
    }
    const tagEnd = closingTagEnd(html, tagStart + 1);
    if (tagEnd < 0) return null;
    const token = html.slice(tagStart, tagEnd + 1);
    const parsed = tagName(token);
    cursor = tagEnd + 1;
    if (!parsed) continue;
    if (!parsed.closing && RAW_OR_NONVISIBLE_ELEMENTS.has(parsed.name)) {
      if (parsed.name === 'plaintext') return ranges;
      const close = new RegExp(`<\\s*/\\s*${parsed.name}\\s*>`, 'ig');
      close.lastIndex = cursor;
      const found = close.exec(html);
      if (!found) return null;
      cursor = found.index + found[0].length;
      continue;
    }
    if (parsed.closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name === parsed.name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (!VOID_ELEMENTS.has(parsed.name)) {
      // Structural/unknown ancestors do not themselves make text eligible, but
      // must not disable a later allowlisted body/p/span descendant. Only an
      // explicit hidden ancestor propagates non-visibility.
      const hiddenByAncestor = stack.some((entry) => entry.hidden);
      const hidden = hiddenByAncestor || isHiddenContainer(token);
      stack.push({
        name: parsed.name,
        hidden,
        visible: !hidden && VISIBLE_TEXT_CONTAINERS.has(parsed.name),
      });
    }
  }
  return ranges;
}

function replaceExactlyOneTextNode(html, oldText, newText) {
  const matches = [];
  for (const [start, end] of textNodeRanges(html) ?? []) {
    const range = html.slice(start, end);
    let offset = range.indexOf(oldText);
    while (offset >= 0) {
      matches.push(start + offset);
      offset = range.indexOf(oldText, offset + oldText.length);
    }
  }
  if (matches.length !== 1) return null;
  const start = matches[0];
  return `${html.slice(0, start)}${escapeTextNode(newText)}${html.slice(start + oldText.length)}`;
}

/** Performs literal, once-only substitutions so style and DOM structure remain intact. */
export function tailorHtml({ htmlBytes, expectedSha256, changes, jdBody } = {}) {
  if (!Buffer.isBuffer(htmlBytes) || htmlBytes.length === 0 || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')
    || sha256(htmlBytes) !== expectedSha256) {
    return blocked('TAILORING_SOURCE_HASH_MISMATCH', '原件或规范化 HTML 已变化；重新导入并复核哈希后再定制。');
  }
  if (typeof jdBody !== 'string') return blocked('TAILORING_JD_BODY_INVALID', '使用规范化 JD 正文和其来源锚点。');
  const validated = validateTailoringChanges(changes, jdBody);
  if (validated.status === 'blocked') return validated;
  let html = htmlBytes.toString('utf8');
  for (const change of validated.changes) {
    const updated = replaceExactlyOneTextNode(html, change.oldText, change.newText);
    if (updated === null) {
      return blocked('TAILORING_SOURCE_TEXT_AMBIGUOUS', '每项旧内容必须在已归档的 HTML 中恰好出现一次；不要猜测修改位置。', { changeId: change.changeId });
    }
    html = updated;
  }
  const output = Buffer.from(html, 'utf8');
  return { status: 'ready', htmlBytes: output, outputSha256: sha256(output), changes: validated.changes };
}

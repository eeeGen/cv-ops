import { blockedJob, createJobRecord, isUrlSource, MAX_JD_INPUT_BYTES } from '../contracts/jd.mjs';

function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every((value) => value <= 255) ? values : null;
}

function privateIpv4(parts) {
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168))
    || (parts[0] === 192 && parts[1] === 2)
    || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51))
    || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    || parts[0] >= 224;
}

function ipv6Parts(host) {
  const raw = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!/^[\da-f:.]+$/.test(raw) || raw.includes('.')) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (![...left, ...right].every((part) => /^[\da-f]{1,4}$/.test(part)) || left.length + right.length > 8
    || (halves.length === 1 && left.length !== 8)) return null;
  const values = [...left.map((part) => parseInt(part, 16)), ...Array(8 - left.length - right.length).fill(0), ...right.map((part) => parseInt(part, 16))];
  return values.length === 8 ? values : null;
}

/** Accepts only a public literal address reported by the controlled transport. */
export function isPublicPeerAddress(address) {
  if (typeof address !== 'string') return false;
  const v4 = ipv4Parts(address);
  if (v4) return !privateIpv4(v4);
  const v6 = ipv6Parts(address);
  if (!v6) return false;
  const unspecified = v6.every((part) => part === 0);
  const loopback = v6.slice(0, 7).every((part) => part === 0) && v6[7] === 1;
  const linkLocal = (v6[0] & 0xffc0) === 0xfe80;
  const uniqueLocal = (v6[0] & 0xfe00) === 0xfc00;
  const mappedV4 = v6.slice(0, 5).every((part) => part === 0) && v6[5] === 0xffff;
  const compatibleV4 = v6.slice(0, 6).every((part) => part === 0);
  const embeddedV4 = [(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff];
  return !unspecified && !loopback && !linkLocal && !uniqueLocal && !(mappedV4 || compatibleV4) && !privateIpv4(embeddedV4);
}

function publicHttpUrl(value) {
  if (!isUrlSource(value)) return null;
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalV4 = ipv4Parts(host);
  const literalV6 = ipv6Parts(host);
  if (host === 'localhost' || host.endsWith('.localhost') || (literalV4 && privateIpv4(literalV4)) || (literalV6 && !isPublicPeerAddress(host))) {
    return null;
  }
  url.hash = '';
  return url;
}

/**
 * URL content is passed directly to the normalizer as inert text. It never parses
 * instructions from the body, follows body links, or permits redirects. A caller
 * must inject a transport that reports the final peer address and refuses redirects.
 * No default network transport exists here because an unpinned DNS lookup could
 * otherwise reach a private address.
 */
export async function normalizeUrlInput({ url, transport } = {}) {
  const target = publicHttpUrl(url);
  if (!target) {
    return blockedJob({ inputType: 'url', source: url, rawInput: '', reason: 'JD_URL_UNSAFE', nextAction: '使用不含凭据、非本机或私有网络地址的 HTTP(S) JD URL。' });
  }
  if (!transport || typeof transport.fetchText !== 'function') {
    return blockedJob({ inputType: 'url', source: target.toString(), rawInput: '', reason: 'JD_URL_TRANSPORT_REQUIRED', nextAction: '配置报告最终对端地址并拒绝私有地址、重定向和非文本响应的受控 URL transport 后重试。' });
  }
  try {
    const response = await transport.fetchText(target.toString());
    if (!response || typeof response !== 'object' || response.finalUrl !== target.toString() || response.redirected !== false) {
      return blockedJob({ inputType: 'url', source: target.toString(), rawInput: '', reason: 'JD_URL_REDIRECT_OR_TRACE_INVALID', nextAction: '使用拒绝重定向并报告最终 URL 的受控 URL transport 后重试。' });
    }
    if (!isPublicPeerAddress(response.peerAddress)) {
      return blockedJob({ inputType: 'url', source: target.toString(), rawInput: '', reason: 'JD_URL_PEER_UNSAFE', nextAction: '确认 transport 只连接到公开、非本机且非私有的最终对端地址后重试。' });
    }
    if (typeof response.contentType !== 'string' || !/^text\/(?:html|plain)(?:;|$)/i.test(response.contentType)) {
      return blockedJob({ inputType: 'url', source: target.toString(), rawInput: '', reason: 'JD_URL_CONTENT_TYPE_UNSUPPORTED', nextAction: '使用返回 text/plain 或 text/html 的受控 URL transport 后重试。' });
    }
    if (!(response.bodyBytes instanceof Uint8Array)) {
      return blockedJob({ inputType: 'url', source: target.toString(), rawInput: '', reason: 'JD_URL_PARSE_FAILED', nextAction: '使用返回受限 UTF-8 字节的受控 URL transport 后重试。' });
    }
    if (response.bodyBytes.byteLength > MAX_JD_INPUT_BYTES) {
      return blockedJob({ inputType: 'url', source: target.toString(), rawInput: response.bodyBytes, reason: 'JD_INPUT_TOO_LARGE', nextAction: '让受控 URL transport 在读取时拒绝超过 2 MB 的响应后重试。' });
    }
    let body;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(response.bodyBytes);
    } catch {
      return blockedJob({ inputType: 'url', source: target.toString(), rawInput: response.bodyBytes, reason: 'JD_URL_PARSE_FAILED', nextAction: '使用返回 UTF-8 文本或 HTML 的 JD URL 后重试。' });
    }
    return createJobRecord({ inputType: 'url', source: target.toString(), rawInput: response.bodyBytes, body, markup: /<[^>]+>/.test(body) });
  } catch (error) {
    const reason = error?.code === 'URL_CONTENT_TYPE_UNSUPPORTED' ? 'JD_URL_CONTENT_TYPE_UNSUPPORTED' : 'JD_URL_FETCH_FAILED';
    return blockedJob({ inputType: 'url', source: target.toString(), rawInput: '', reason, nextAction: '确认 URL 可访问、未重定向且返回文本或 HTML 后重试。' });
  }
}

'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const { Agent } = require('undici');

const MAX_PAGE_CHARS = 12000;
const MAX_DOWNLOAD_BYTES = 1024 * 1024;
const WEB_TOOL_NAME = /(?:web[_-]?search|search[_-]?web|get[_-]?single[_-]?web[_-]?page[_-]?content|fetch[_-]?(?:web[_-]?)?page|scrap(?:e|ing))/i;
const PAGE_TOOL_NAME = /(?:get[_-]?single[_-]?web[_-]?page[_-]?content|fetch[_-]?(?:web[_-]?)?page|scrap(?:e|ing))/i;

function publicWebUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Provide a valid web URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      /^(?:localhost|.*\.localhost|.*\.local|\[.*\])$/i.test(url.hostname) ||
      net.isIP(url.hostname) && !isPublicAddress(url.hostname)) {
    throw new Error('Only public HTTP or HTTPS pages are supported.');
  }
  return url;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) ||
      a === 198 && [18, 19].includes(b));
  }
  if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  return false;
}

async function publicDispatcher(url) {
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Web page host does not resolve to a public address.');
  }
  const { address, family } = addresses[0];
  // Pin the validated address so DNS cannot change between validation and connect.
  const lookup = (_hostname, _options, callback) => callback(null, address, family);
  const dispatcher = new Agent({ connect: { lookup } });
  // The Node HTTP fetch replacement uses the same validated address.
  dispatcher.nodeLookup = lookup;
  return dispatcher;
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const point = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '';
  });
}

function sanitizeWebPageContent(input) {
  if (typeof input !== 'string') return '';
  let html = input.replace(/<!--[^]*?-->/g, '');
  html = html.replace(/<(script|style|svg|nav|footer|header|noscript)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ');
  html = html.replace(/data:image\/[a-z0-9.+-]+(?:;base64)?,[^\s"'<>)]*/gi, '[inline image omitted]');
  const core = /<(?:main|article)\b[^>]*>([^]*?)<\/(?:main|article)\s*>/i.exec(html);
  if (core) html = core[1];
  else html = /<body\b[^>]*>([^]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  html = html.replace(/<\s*br\b[^>]*\/?\s*>|<\/(?:p|div|section|article|main|h[1-6]|li|tr|blockquote)\s*>/gi, '\n');
  html = html.replace(/<[^>]+>/g, ' ');
  return decodeEntities(html).replace(/\r/g, '').replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_PAGE_CHARS);
}

function sanitizeWebToolResult(output, toolName = '') {
  if (!WEB_TOOL_NAME.test(toolName)) return output;
  if (PAGE_TOOL_NAME.test(toolName) && output && typeof output === 'object' && !output.isError && output.success !== false) {
    const texts = [];
    const collect = value => {
      if (typeof value === 'string') texts.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) if (/^(?:text|content|structuredContent|result|body|html|title|description)$/i.test(key)) collect(item);
      }
    };
    collect(output);
    return sanitizeWebPageContent(texts.join('\n'));
  }
  const clean = value => {
    if (typeof value === 'string') return /<\s*(?:html|body|main|article|script|nav|div|p)\b/i.test(value)
      ? sanitizeWebPageContent(value) : value.replace(/data:image\/[a-z0-9.+-]+(?:;base64)?,[^\s"'<>)]*/gi, '[inline image omitted]').slice(0, MAX_PAGE_CHARS);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return clean(output);
}

// Textual JSON media types: application/json, text/json and structured-syntax
// suffix types such as application/problem+json, application/ld+json or
// application/vnd.api+json. Parameters (e.g. "; charset=utf-8") are ignored.
const JSON_MEDIA_TYPE = /^(?:application|text)\/(?:[\w!#$&^_.+-]+\+)?json$/i;

function isJsonMediaType(contentType) {
  return JSON_MEDIA_TYPE.test(String(contentType || '').split(';')[0].trim());
}

// Strip anything that is not printable ASCII and bound the length, so an
// untrusted header value is safe to embed in errors and output metadata.
function safeContentType(value) {
  return String(value || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 200);
}

// A response mislabelled as HTML or plain text can still carry a JSON body;
// the body itself decides, but only when it both looks like JSON and parses —
// real HTML/JavaScript never satisfies both, so normal pages keep their path.
function looksLikeJsonBody(text) {
  const body = text.trimStart();
  if (!body.startsWith('{') && !body.startsWith('[')) return false;
  try { JSON.parse(body); return true; } catch { return false; }
}

// Present a JSON body the model can read directly: valid JSON is
// pretty-printed under a content-type header so the original type stays
// visible in the output; a malformed body (or a JSON content type on non-JSON
// text) degrades to a diagnostic note plus the raw text instead of failing
// the fetch. HTML extraction never runs on a JSON body. Capped like every
// other page read so oversized JSON cannot flood the context.
function formatJsonBody(text, contentType) {
  const body = text.trim();
  if (!body) return '';
  const declared = safeContentType(contentType) || 'application/json';
  let header = `[Content-Type: ${declared}]`;
  let formatted = body;
  try {
    formatted = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    header = `[Content-Type: ${declared}] body was not valid JSON; raw response text follows:`;
  }
  return `${header}\n\n${formatted}`.slice(0, MAX_PAGE_CHARS);
}

// Stream a response body to text under the download cap. The size check runs
// before decoding, so an oversized body is rejected the same way for HTML,
// plain text and JSON alike.
async function readBoundedText(reader) {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_DOWNLOAD_BYTES) { await reader.cancel(); throw new Error('Web page exceeds the download limit.'); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function getSingleWebPageContent({ url, signal, fetchImpl = fetch }) {
  let target = publicWebUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal?.throwIfAborted();
    let dispatcher;
    try {
      let response;
      try {
        dispatcher = fetchImpl === fetch ? await publicDispatcher(target) : null;
        response = await fetchImpl(target, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          // Validate and pin each redirect destination before connecting to it.
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
          ...(dispatcher ? { dispatcher } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const cause = err.cause?.code ? ` (${err.cause.code})` : '';
        throw new Error(`SUBAGENT_FETCH_ERROR: ${err.name} - ${err.message}${cause} (Target: ${target.href})`, { cause: err });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 5) throw new Error('Too many web page redirects.');
        target = publicWebUrl(new URL(response.headers.get('location') || '', target).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Web page request failed (HTTP ${response.status}).`); }
      const type = response.headers.get('content-type') || '';
      const json = isJsonMediaType(type);
      if (type && !json && !/(?:text\/html|text\/plain|application\/xhtml\+xml)/i.test(type)) {
        await response.body?.cancel();
        throw new Error(`Web page did not return HTML, plain text or JSON (content-type: ${safeContentType(type) || 'unknown'}).`);
      }
      const reader = response.body?.getReader();
      const text = reader ? await readBoundedText(reader) : await response.text();
      return json || looksLikeJsonBody(text) ? formatJsonBody(text, type) : sanitizeWebPageContent(text);
    } finally { await dispatcher?.close(); }
  }
}

module.exports = { MAX_PAGE_CHARS, sanitizeWebPageContent, sanitizeWebToolResult, getSingleWebPageContent };

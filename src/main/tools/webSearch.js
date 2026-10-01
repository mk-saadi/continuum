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
  return new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, address, family) } });
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

async function getSingleWebPageContent({ url, signal, fetchImpl = fetch }) {
  let target = publicWebUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal?.throwIfAborted();
    const dispatcher = fetchImpl === fetch ? await publicDispatcher(target) : null;
    try {
      const response = await fetchImpl(target, { signal, redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}), headers: { Accept: 'text/html, text/plain;q=0.8' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 5) throw new Error('Too many web page redirects.');
        target = publicWebUrl(new URL(response.headers.get('location') || '', target).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Web page request failed (HTTP ${response.status}).`); }
      const type = response.headers.get('content-type') || '';
      if (type && !/(?:text\/html|text\/plain|application\/xhtml\+xml)/i.test(type)) {
        await response.body?.cancel();
        throw new Error('Web page did not return HTML or plain text.');
      }
      const reader = response.body?.getReader();
      if (!reader) return sanitizeWebPageContent(await response.text());
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
      text += decoder.decode();
      return sanitizeWebPageContent(text);
    } finally { await dispatcher?.close(); }
  }
}

module.exports = { MAX_PAGE_CHARS, sanitizeWebPageContent, sanitizeWebToolResult, getSingleWebPageContent };

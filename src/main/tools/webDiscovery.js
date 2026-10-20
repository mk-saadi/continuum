'use strict';

// ---------------------------------------------------------------------------
// Native, zero-configuration web discovery (Phase 2.0G)
//
// This module is deliberately discovery-only: it turns one query into a small,
// ordered list of { title, url, snippet } entries and never fetches a result
// page. Reading a chosen page remains the job of the existing first-party
// get_single_web_page_content tool (./webSearch.js), which owns the SSRF/DNS
// validation, download cap and HTML sanitisation.
//
// Backend: DuckDuckGo's public HTML result page (no API key, no account, no
// external MCP server, no second process). That page is a public web page, not
// a documented API: if DuckDuckGo blocks or changes it, this module reports a
// truthful failure (blocked / unsupported_format) and never invents results.
// There is no CAPTCHA bypass, no proxy rotation, no fingerprint spoofing, no
// retry storm, and no cookie persistence. One request per search.
//
// Why not the bundled Chromium? The Playwright integration in this app is an
// MCP server that exposes general browser automation; children must not get
// that surface, and spawning a browser process for a text query would add
// hundreds of milliseconds of startup per search plus another lifecycle to
// leak. This path reuses the same Node HTTP transport and public-address
// validation as the existing page fetcher instead.
//
// Search is independent of MCP and of any saved search-provider key. The only
// data sent is the query itself (plus DuckDuckGo's safe-search flag).
// ---------------------------------------------------------------------------

const net = require('node:net');
const { decodeEntities, isPublicAddress } = require('./webSearch');

const SEARCH_BACKEND = 'duckduckgo-html';
const SEARCH_BACKEND_LABEL = 'DuckDuckGo (public HTML results)';
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

const DEFAULT_MAX_RESULTS = 5;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 10;
const MAX_QUERY_CHARS = 500;
const MAX_URL_CHARS = 1000;
const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 300;
const MAX_TOTAL_RESULT_CHARS = 6000;
const MAX_ERROR_CHARS = 240;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// Bounded fan-out: multiple children may search at once, but a burst cannot
// open an unbounded number of sockets. No queue survives the process idle.
const MAX_CONCURRENT_SEARCHES = 4;

const SEARCH_OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  NO_RESULTS: 'no_results',
  INVALID_QUERY: 'invalid_query',
  BACKEND_UNAVAILABLE: 'backend_unavailable',
  NETWORK_ERROR: 'network_error',
  RATE_LIMITED: 'rate_limited',
  BLOCKED: 'blocked',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  RESPONSE_TOO_LARGE: 'response_too_large',
  PERMISSION_DENIED: 'permission_denied',
});

function safeError(error) {
  return String(error?.message ?? error ?? '')
    .replace(/[\r\n\0\t]+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Reject empty, control-character and excessively large queries instead of
 * silently truncating or issuing a partial search. Collapsing whitespace is
 * the only normalisation applied.
 */
function normalizeQuery(value) {
  if (typeof value !== 'string') throw new TypeError('A search query string is required.');
  const query = value.replace(/\s+/g, ' ').trim();
  if (!query) throw new TypeError('A non-empty search query is required.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(query)) {
    throw new TypeError('The search query contains unsupported control characters.');
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new TypeError(`The search query is too long (maximum ${MAX_QUERY_CHARS} characters).`);
  }
  return query;
}

/** Default 5, clamped to 1..10; invalid values fall back to the default. */
function normalizeMaxResults(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_RESULTS;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.trunc(numeric)));
}

// ---------------------------------------------------------------------------
// Result URL handling
// ---------------------------------------------------------------------------

function publicResultUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  // http(s) only: no file:, data:, javascript:, ftp:, ws: or custom schemes.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname) return null;
  if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(hostname)) return null;
  // Literal private/loopback/link-local addresses never become results. Named
  // result hosts are not resolved here (discovery must stay cheap); reading a
  // chosen URL revalidates through getSingleWebPageContent's pinned DNS.
  if (net.isIP(hostname) && !isPublicAddress(hostname)) return null;
  url.hash = '';
  return url;
}

function canonicalResultUrl(url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

function plainText(value, limit) {
  if (typeof value !== 'string') return '';
  // Decode first so escaped markup (`&lt;b&gt;`) is stripped as markup too;
  // the second decode handles entities exposed by the first pass. Nothing here
  // is ever re-inserted as HTML — the output is inert text.
  const text = decodeEntities(decodeEntities(value).replace(/<[^>]*>/g, ' '))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * DuckDuckGo's HTML page wraps outbound links as
 * https://duckduckgo.com/l/?uddg=<encoded target>&rut=...
 * Unwrap only that documented-in-markup redirect shape; every other link is
 * used as-is. Ad links (y.js / aclick) are never results.
 */
function unwrapResultHref(href, base) {
  if (typeof href !== 'string' || !href) return null;
  let url;
  try { url = new URL(decodeEntities(href), base); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (/(?:^|\.)duckduckgo\.com$/.test(host) && /^\/l\/?$/.test(url.pathname)) {
    const target = url.searchParams.get('uddg');
    if (!target) return null;
    try { url = new URL(target); } catch { return null; }
  }
  const resolvedHost = url.hostname.toLowerCase();
  if (/(?:^|\.)duckduckgo\.com$/.test(resolvedHost) && /^\/(?:y\.js|aclick)/.test(url.pathname)) return null;
  if (/(?:^|\.)(?:bing\.com|googleadservices\.com)$/.test(resolvedHost) && /^\/(?:aclick|pagead)/.test(url.pathname)) return null;
  return publicResultUrl(url.href);
}

function firstAnchor(block) {
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchors.exec(block))) {
    if (/\bclass\s*=\s*["'][^"']*\bresult__a\b/i.test(match[1])) {
      return { attributes: match[1], inner: match[2] };
    }
  }
  return null;
}

function attribute(attributes, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
  return match ? (match[1] ?? match[2] ?? '') : '';
}

function firstSnippet(block) {
  const match = /<[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block);
  return match ? plainText(match[1], MAX_SNIPPET_CHARS) : '';
}

/**
 * Parse the public result page. Returns every structurally valid result in
 * page order; invalid entries are dropped rather than guessed at.
 */
function extractResults(html, maxResults = DEFAULT_MAX_RESULTS) {
  const limit = normalizeMaxResults(maxResults);
  if (typeof html !== 'string' || !html) return { results: [], sawBlocks: false, sawAdBlocks: false };
  const blocks = html.split(/<div\s+class\s*=\s*["']result(?=[\s"'])/i).slice(1);
  const seen = new Set();
  const results = [];
  let totalChars = 0;
  let sawAdBlocks = false;
  let droppedForSize = false;
  for (const block of blocks) {
    if (/\bresult--ad\b|class\s*=\s*["'][^"']*\bresult--ad\b/i.test(block)) { sawAdBlocks = true; continue; }
    const anchor = firstAnchor(block);
    if (!anchor) continue;
    const url = unwrapResultHref(attribute(anchor.attributes, 'href'), SEARCH_ENDPOINT);
    if (!url) continue;
    const key = canonicalResultUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = plainText(anchor.inner, MAX_TITLE_CHARS) || url.hostname;
    const snippet = firstSnippet(block);
    const size = title.length + url.href.length + snippet.length + 48;
    if (totalChars + size > MAX_TOTAL_RESULT_CHARS) { droppedForSize = true; continue; }
    totalChars += size;
    results.push({ position: results.length + 1, title, url: url.href, source: url.hostname, snippet });
    if (results.length >= limit) break;
  }
  return { results, sawBlocks: blocks.length > 0, sawAdBlocks, truncated: droppedForSize };
}

// ---------------------------------------------------------------------------
// Bounded concurrency (no browser, no daemon, no retained queue)
// ---------------------------------------------------------------------------

let activeSearches = 0;
const searchWaiters = [];

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = searchWaiters.shift();
    if (next) {
      next.cleanup();
      next.resolve(makeRelease()); // hand this slot directly to the next caller
    } else {
      activeSearches -= 1;
    }
  };
}

function acquireSearchSlot(signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (activeSearches < MAX_CONCURRENT_SEARCHES) {
    activeSearches += 1;
    return Promise.resolve(makeRelease());
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    const onAbort = () => {
      const index = searchWaiters.indexOf(waiter);
      if (index >= 0) searchWaiters.splice(index, 1);
      reject(abortError(signal));
    };
    waiter.cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    searchWaiters.push(waiter);
  });
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function defaultFetch(url, options) {
  // Lazy: tests replace this module member, and the deployed app shares the
  // exact same Node HTTP transport as page fetches and cloud providers.
  return require('../nodeHttpFetch').nodeHttpFetch(url, options);
}

function defaultDispatcher(target) {
  // Lazy/dynamic so the public-address validation stays in one place
  // (./webSearch.js) and focused tests can substitute it.
  return require('./webSearch').publicDispatcher(target);
}

async function readBoundedBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Search response exceeds the size limit.');
    return text;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('Search response exceeds the size limit.');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function resultBase(query) {
  return { backend: SEARCH_BACKEND, backendLabel: SEARCH_BACKEND_LABEL, query };
}

function failure(query, outcome, error, extra = {}) {
  return { success: false, ...resultBase(query), outcome, results: [], error, ...extra };
}

function classifyStatus(response) {
  const status = response?.status;
  const retryAfter = String(response?.headers?.get?.('retry-after') ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 100) || null;
  if (status === 429) {
    return {
      outcome: SEARCH_OUTCOMES.RATE_LIMITED,
      error: `The search backend rate limit was reached (HTTP 429)${retryAfter ? `; retry after ${retryAfter}` : ''}.`,
      retryAfter,
    };
  }
  if (status === 403 || status === 401 || status === 202) {
    return {
      outcome: SEARCH_OUTCOMES.BLOCKED,
      error: `The search backend refused automated access (HTTP ${status}). No CAPTCHA or bot protection was bypassed.`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      outcome: SEARCH_OUTCOMES.BACKEND_UNAVAILABLE,
      error: `The search backend returned an unexpected redirect (HTTP ${status}).`,
    };
  }
  if (status >= 500) {
    return {
      outcome: SEARCH_OUTCOMES.BACKEND_UNAVAILABLE,
      error: `The search backend reported a server error (HTTP ${status}).`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      outcome: SEARCH_OUTCOMES.BACKEND_UNAVAILABLE,
      error: `The search request failed (HTTP ${status}).`,
    };
  }
  return null;
}

function looksBlocked(html) {
  return /\bcaptcha\b|unusual traffic|anomal(?:y|ies)|automated (?:queries|requests)|bots use duckduckgo|challenge-form|If this persists/i.test(html);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Discover public web results for one query.
 *
 * Every backend-side end state is returned as a structured result:
 * success | no_results | backend_unavailable | network_error | rate_limited |
 * blocked | timed_out | unsupported_format | response_too_large.
 * Caller cancellation is rethrown as an AbortError so the enclosing agent run
 * stops, and malformed tool input throws a TypeError.
 */
async function searchWeb({
  query,
  max_results,
  signal,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  endpoint = SEARCH_ENDPOINT,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const maxResults = normalizeMaxResults(max_results);
  signal?.throwIfAborted();

  const release = await acquireSearchSlot(signal);
  let dispatcher = null;
  const effectiveTimeout = Math.max(1, Number(timeoutMs) || REQUEST_TIMEOUT_MS);
  // A plain timer (cleared in finally) instead of AbortSignal.timeout: it keeps
  // the timeout observable even when no other handle is active, and it never
  // outlives the search.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(
    Object.assign(new Error(`The search request timed out after ${effectiveTimeout} ms.`), { name: 'TimeoutError' }),
  ), effectiveTimeout);
  const timeoutSignal = timeoutController.signal;
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    let target;
    try {
      target = new URL(endpoint);
    } catch {
      return failure(normalizedQuery, SEARCH_OUTCOMES.BACKEND_UNAVAILABLE,
        'The search backend endpoint is invalid.');
    }
    let doFetch = fetchImpl;
    if (typeof doFetch !== 'function') {
      try {
        dispatcher = await defaultDispatcher(target);
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        return failure(normalizedQuery, SEARCH_OUTCOMES.NETWORK_ERROR,
          `Could not resolve the search backend: ${safeError(error)}.`);
      }
      doFetch = defaultFetch;
    }
    const body = new URLSearchParams({ q: normalizedQuery, kp: '1' }).toString();
    let response;
    try {
      response = await doFetch(target, {
        method: 'POST',
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        body,
        // The endpoint is fixed. A redirect must not move the request or the
        // query to an unexpected host.
        redirect: 'manual',
        signal: combined,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (timeoutSignal.aborted) {
        return failure(normalizedQuery, SEARCH_OUTCOMES.TIMED_OUT,
          `The search request timed out after ${effectiveTimeout} ms.`);
      }
      const code = error?.cause?.code ? ` (${error.cause.code})` : '';
      return failure(normalizedQuery, SEARCH_OUTCOMES.NETWORK_ERROR,
        `Could not reach the search backend: ${safeError(error)}${code}.`);
    }

    const statusFailure = classifyStatus(response);
    if (statusFailure) {
      try { await response.body?.cancel?.(); } catch { /* best-effort cancellation */ }
      return failure(normalizedQuery, statusFailure.outcome, statusFailure.error,
        statusFailure.retryAfter ? { retryAfter: statusFailure.retryAfter } : {});
    }

    let html;
    try {
      html = await readBoundedBody(response);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (timeoutSignal.aborted) {
        return failure(normalizedQuery, SEARCH_OUTCOMES.TIMED_OUT,
          `The search request timed out after ${effectiveTimeout} ms.`);
      }
      if (/size limit/i.test(String(error?.message))) {
        return failure(normalizedQuery, SEARCH_OUTCOMES.RESPONSE_TOO_LARGE,
          'The search response exceeded the 1 MB size limit.');
      }
      return failure(normalizedQuery, SEARCH_OUTCOMES.UNSUPPORTED_FORMAT,
        'The search response could not be read.');
    }

    const parsed = extractResults(html, maxResults);
    if (!parsed.results.length) {
      if (parsed.sawBlocks && parsed.sawAdBlocks) {
        return { success: true, ...resultBase(normalizedQuery), outcome: SEARCH_OUTCOMES.NO_RESULTS,
          resultCount: 0, results: [], message: 'No results found.' };
      }
      if (looksBlocked(html)) {
        return failure(normalizedQuery, SEARCH_OUTCOMES.BLOCKED,
          'The search backend presented a bot/CAPTCHA challenge. No bypass was attempted.');
      }
      if (!parsed.sawBlocks && /no results|did not match any documents/i.test(html)) {
        return { success: true, ...resultBase(normalizedQuery), outcome: SEARCH_OUTCOMES.NO_RESULTS,
          resultCount: 0, results: [], message: 'No results found.' };
      }
      return failure(normalizedQuery, SEARCH_OUTCOMES.UNSUPPORTED_FORMAT,
        'The search backend returned a page that did not contain recognizable result entries.');
    }
    return {
      success: true,
      ...resultBase(normalizedQuery),
      outcome: SEARCH_OUTCOMES.SUCCESS,
      resultCount: parsed.results.length,
      results: parsed.results,
      ...(parsed.truncated ? { truncated: true } : {}),
    };
  } finally {
    clearTimeout(timeoutId);
    release();
    if (dispatcher?.close) await dispatcher.close().catch(() => {});
  }
}

module.exports = {
  SEARCH_BACKEND,
  SEARCH_BACKEND_LABEL,
  SEARCH_ENDPOINT,
  SEARCH_OUTCOMES,
  DEFAULT_MAX_RESULTS,
  MAX_MAX_RESULTS,
  MAX_QUERY_CHARS,
  MAX_TOTAL_RESULT_CHARS,
  MAX_CONCURRENT_SEARCHES,
  REQUEST_TIMEOUT_MS,
  normalizeQuery,
  normalizeMaxResults,
  publicResultUrl,
  canonicalResultUrl,
  unwrapResultHref,
  extractResults,
  searchWeb,
};

'use strict';

// ---------------------------------------------------------------------------
// Native web-search provider boundary (Phase 1.7)
//
// One initial provider (Brave Search) sits behind a deliberately small
// interface so a second provider can be added later without touching the tool,
// permission or transcript layers:
//
//   searchWeb({ query, max_results, signal, fetchImpl, settings, maxRetries })
//     -> { success, outcome, provider, providerLabel, query, results, ... }
//
// Search is DISCOVERY ONLY. This module returns bounded, structured results
// ({ position, title, validated url, source host, snippet, published }) and
// never fetches a result page — reading a chosen page stays the job of the
// existing get_single_web_page_content tool. Nothing from the chat, workspace
// or memory is ever transmitted: the outbound request carries only the query
// and the provider's own parameters.
//
// The API key is the only secret involved. It is read from the existing
// app_settings store (configManager.readSearchSettings) and injected into the
// request header; it is never placed in a returned object, an error message,
// or a log line.
// ---------------------------------------------------------------------------

const net = require('node:net');

const SEARCH_PROVIDER_LABELS = Object.freeze({ brave: 'Brave Search' });
const SEARCH_ENDPOINTS = Object.freeze({
  brave: 'https://api.search.brave.com/res/v1/web/search',
});

// The complete, truthful set of terminal states a search call can report.
// `success` and `no_results` are the only non-failure outcomes (so an empty
// result set is never mistaken for a broken tool by failedToolReason).
const SEARCH_OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  NO_RESULTS: 'no_results',
  NOT_CONFIGURED: 'not_configured',
  RATE_LIMITED: 'rate_limited',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  PROVIDER_ERROR: 'provider_error',
  INVALID_RESPONSE: 'invalid_response',
  PERMISSION_DENIED: 'permission_denied',
});

const DEFAULT_MAX_RESULTS = 5;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 20;
const MAX_QUERY_CHARS = 2000;
const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 1200;
const MAX_ERROR_CHARS = 240;
const REQUEST_TIMEOUT_MS = 15000;
// A single bounded retry for genuinely transient failures (network errors and
// 5xx). Authentication, configuration, validation, rate-limit and cancellation
// outcomes are never retried.
const DEFAULT_MAX_RETRIES = 1;
const HARD_MAX_RETRIES = 2;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function providerLabel(provider) {
  return SEARCH_PROVIDER_LABELS[provider] ?? 'Web Search';
}

function normalizeMaxResults(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_RESULTS;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.trunc(numeric)));
}

function normalizeQuery(value) {
  if (typeof value !== 'string') throw new TypeError('A search query string is required.');
  const query = value.replace(/\s+/g, ' ').trim();
  if (!query) throw new TypeError('A non-empty search query is required.');
  return query.slice(0, MAX_QUERY_CHARS);
}

function safeError(error) {
  return String(error?.message ?? error ?? '')
    .replace(/[\r\n\0\t]+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

function safeHeader(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 100);
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  const single = value.replace(/\s+/g, ' ').trim();
  if (single.length <= limit) return single;
  return `${single.slice(0, limit - 1).trimEnd()}…`;
}

// A published date is kept ONLY when it is a real, absolute ISO date. Relative
// strings ("3 days ago") and anything unparseable are dropped rather than
// guessed at, so the model is never handed a fabricated date.
function reliableDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1990 || year > 2100) return null;
  const time = Date.parse(value.trim());
  if (Number.isNaN(time)) return null;
  return value.trim().slice(0, 10);
}

// Same public-address predicate the page fetcher uses: results that point at
// loopback / private / link-local space are discarded, so a hostile or buggy
// provider response can never steer the model toward an internal address.
function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19].includes(b)));
  }
  if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  return false;
}

/**
 * Validate and canonicalize one result URL. Returns a URL object or null.
 * Only public http(s) targets with no embedded credentials are accepted; the
 * fragment is dropped (it is irrelevant to a search result and reduces noise).
 */
function validateResultUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return null;
  if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal|\[.*\])$/i.test(hostname)) return null;
  if (net.isIP(hostname) && !isPublicAddress(hostname)) return null;
  url.hash = '';
  return url;
}

function canonicalResultUrl(url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

/**
 * Normalize a provider's raw result list into the small, bounded shape the
 * model sees. Invalid URLs are dropped, duplicates are removed by canonical
 * URL (query strings preserved), and the list is capped at `maxResults`.
 */
function normalizeResults(rawResults, maxResults = DEFAULT_MAX_RESULTS) {
  if (!Array.isArray(rawResults)) return [];
  const limit = normalizeMaxResults(maxResults);
  const seen = new Set();
  const results = [];
  for (const item of rawResults) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const url = validateResultUrl(item.url ?? item.link ?? item.href);
    if (!url) continue;
    const key = canonicalResultUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = cleanText(item.title ?? item.name, MAX_TITLE_CHARS) || url.href;
    const snippet = cleanText(item.description ?? item.snippet ?? item.content ?? item.text, MAX_SNIPPET_CHARS);
    const published = reliableDate(item.page_age ?? item.published ?? item.published_date);
    results.push({ position: results.length + 1, title, url: url.href, source: url.host, snippet, published });
    if (results.length >= limit) break;
  }
  return results;
}

function buildProviderRequest(provider, { query, maxResults }) {
  if (provider !== 'brave') return null;
  const url = new URL(SEARCH_ENDPOINTS.brave);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  url.searchParams.set('safesearch', 'moderate');
  // Plain descriptions: no **bold** decoration markers embedded in snippets.
  url.searchParams.set('text_decorations', 'false');
  url.searchParams.set('extra_snippets', 'false');
  return url;
}

function parseProviderPayload(provider, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  if (provider === 'brave') {
    const web = payload.web;
    const hasWeb = web && typeof web === 'object' && !Array.isArray(web);
    // Brave always echoes `type: "search"`. A body that is neither a Brave
    // search envelope nor a recognized `web` object is malformed, not empty.
    if (!hasWeb && payload.type !== 'search') return { ok: false };
    return { ok: true, results: hasWeb && Array.isArray(web.results) ? web.results : [] };
  }
  return { ok: false };
}

function classifyHttpFailure(response) {
  const status = response?.status;
  const retryAfter = safeHeader(response?.headers?.get?.('retry-after')) || null;
  if (status === 429) {
    return {
      outcome: SEARCH_OUTCOMES.RATE_LIMITED,
      retryable: false,
      retryAfter,
      error: `The search provider rate limit was reached (HTTP 429)${retryAfter ? `; retry after ${retryAfter}` : ''}.`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      outcome: SEARCH_OUTCOMES.PROVIDER_ERROR,
      retryable: false,
      error: `The search provider rejected the API key (HTTP ${status}). Check the key in Settings → Agents & Skills.`,
    };
  }
  if (status === 400 || status === 422) {
    return {
      outcome: SEARCH_OUTCOMES.PROVIDER_ERROR,
      retryable: false,
      error: `The search provider rejected the request (HTTP ${status}).`,
    };
  }
  if (status >= 500) {
    return {
      outcome: SEARCH_OUTCOMES.PROVIDER_ERROR,
      retryable: true,
      error: `The search provider reported a server error (HTTP ${status}).`,
    };
  }
  return {
    outcome: SEARCH_OUTCOMES.PROVIDER_ERROR,
    retryable: false,
    error: `The search request failed (HTTP ${status}).`,
  };
}

function isAbortOrTimeout(error) {
  // The caller's own abort is rethrown before this is consulted, so any abort
  // observed here came from this module's request deadline.
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
    error?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(String(error?.message ?? ''));
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
  while (true) {
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

// One network attempt. Caller cancellation is rethrown (so the whole agent run
// stops); every other end state is classified into a structured result.
async function executeSearchAttempt({ provider, apiKey, query, maxResults, fetchImpl, signal }) {
  const target = buildProviderRequest(provider, { query, maxResults });
  if (!target) {
    return { outcome: SEARCH_OUTCOMES.PROVIDER_ERROR, retryable: false, error: 'Unsupported search provider.' };
  }
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        'X-Subscription-Token': apiKey,
        'User-Agent': 'Continuum/1.0 (+web_search)',
      },
      // Never follow redirects: the provider endpoint is fixed, so a redirect
      // is unexpected and must not silently move a credentialed request.
      redirect: 'manual',
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isAbortOrTimeout(error)) {
      return { outcome: SEARCH_OUTCOMES.TIMED_OUT, retryable: false, error: `The search request timed out after ${REQUEST_TIMEOUT_MS} ms.` };
    }
    return { outcome: SEARCH_OUTCOMES.PROVIDER_ERROR, retryable: true, error: `Could not reach the search provider${error?.message ? `: ${safeError(error)}` : ''}.` };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel?.();
    return { outcome: SEARCH_OUTCOMES.PROVIDER_ERROR, retryable: false, error: 'The search provider returned an unexpected redirect.' };
  }
  if (!response.ok) {
    await response.body?.cancel?.();
    return classifyHttpFailure(response);
  }
  let text;
  try {
    text = await readBoundedBody(response);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isAbortOrTimeout(error)) {
      return { outcome: SEARCH_OUTCOMES.TIMED_OUT, retryable: false, error: `The search request timed out after ${REQUEST_TIMEOUT_MS} ms.` };
    }
    return { outcome: SEARCH_OUTCOMES.INVALID_RESPONSE, retryable: false, error: 'The search provider response could not be read.' };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { outcome: SEARCH_OUTCOMES.INVALID_RESPONSE, retryable: false, error: 'The search provider returned a response that was not valid JSON.' };
  }
  const parsed = parseProviderPayload(provider, payload);
  if (!parsed.ok) {
    return { outcome: SEARCH_OUTCOMES.INVALID_RESPONSE, retryable: false, error: 'The search provider returned an unexpected response shape.' };
  }
  const results = normalizeResults(parsed.results, maxResults);
  return { outcome: results.length ? SEARCH_OUTCOMES.SUCCESS : SEARCH_OUTCOMES.NO_RESULTS, results };
}

function readSettingsSafely() {
  try {
    return require('../configManager').readSearchSettings();
  } catch {
    return { provider: 'brave', apiKey: '' };
  }
}

function resolveDefaultFetch() {
  // Required lazily so tests can monkeypatch the shared transport, and never
  // captured at module load (which would freeze a stale reference).
  return require('../nodeHttpFetch').nodeHttpFetch;
}

/**
 * Search the public web through the configured provider.
 *
 * Returns a structured result for every provider-side end state (success,
 * no_results, not_configured, rate_limited, timed_out, provider_error,
 * invalid_response). Caller cancellation is rethrown as an AbortError so the
 * enclosing agent run stops; malformed tool input throws a TypeError (which the
 * tool layer reports as a plain validation failure).
 */
async function searchWeb(options = {}) {
  const { query, max_results, signal, fetchImpl, settings, maxRetries = DEFAULT_MAX_RETRIES } = options;
  const normalizedQuery = normalizeQuery(query);
  const maxResults = normalizeMaxResults(max_results);
  const resolved = settings ?? readSettingsSafely();
  const provider = typeof resolved?.provider === 'string' && resolved.provider ? resolved.provider : 'brave';
  const apiKey = typeof resolved?.apiKey === 'string' ? resolved.apiKey.trim() : '';
  const label = providerLabel(provider);
  signal?.throwIfAborted();

  if (!apiKey) {
    return {
      success: false,
      outcome: SEARCH_OUTCOMES.NOT_CONFIGURED,
      provider,
      providerLabel: label,
      query: normalizedQuery,
      results: [],
      error: 'Web search is not configured. Add a search provider API key in Settings → Agents & Skills.',
    };
  }

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : resolveDefaultFetch();
  const retries = Math.max(0, Math.min(HARD_MAX_RETRIES, Number.isInteger(maxRetries) ? maxRetries : DEFAULT_MAX_RETRIES));

  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    // executeSearchAttempt rethrows caller cancellation; that propagates here
    // unchanged so the run stops instead of being reported as a tool result.
    const attemptResult = await executeSearchAttempt({
      provider, apiKey, query: normalizedQuery, maxResults, fetchImpl: doFetch, signal,
    });
    if (attemptResult.outcome === SEARCH_OUTCOMES.SUCCESS || attemptResult.outcome === SEARCH_OUTCOMES.NO_RESULTS) {
      return {
        success: true,
        outcome: attemptResult.outcome,
        provider,
        providerLabel: label,
        query: normalizedQuery,
        resultCount: attemptResult.results.length,
        results: attemptResult.results,
        ...(attemptResult.outcome === SEARCH_OUTCOMES.NO_RESULTS ? { message: 'No results found.' } : {}),
      };
    }
    if (attemptResult.retryable && attempt < retries) continue;
    return {
      success: false,
      outcome: attemptResult.outcome,
      provider,
      providerLabel: label,
      query: normalizedQuery,
      results: [],
      error: attemptResult.error,
      ...(attemptResult.retryAfter ? { retryAfter: attemptResult.retryAfter } : {}),
    };
  }
}

module.exports = {
  SEARCH_OUTCOMES,
  SEARCH_PROVIDER_LABELS,
  SEARCH_ENDPOINTS,
  DEFAULT_MAX_RESULTS,
  MAX_MAX_RESULTS,
  REQUEST_TIMEOUT_MS,
  providerLabel,
  normalizeMaxResults,
  normalizeResults,
  validateResultUrl,
  classifyHttpFailure,
  searchWeb,
};

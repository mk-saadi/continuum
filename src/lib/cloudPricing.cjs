'use strict';

// Phase 2.0C-3: cloud API cost estimation.
//
// This module is pure and offline. It never performs inference, never calls a
// paid endpoint, and never fetches anything. Given a provider route and a model
// ID it resolves a price descriptor from one of four explicit evidence sources:
//
//   1. the verified direct-provider catalog (exact model IDs only),
//   2. OpenRouter's own model metadata (live prices the provider returned),
//   3. rates the user typed for their provider,
//   4. a provider-reported per-request charge (OpenRouter `usage.cost`).
//
// A model or route without explicit evidence resolves to `unavailable`. Prices
// are never inferred from a similar-looking model name: `claude-sonnet-5` and
// `claude-sonnet-5.5` are different keys, and only the first is catalogued.
// A local model resolves to `not_applicable` — its cloud charge is not zero,
// it simply does not exist.
//
// All rates are canonical **USD per million tokens**. Money math is done in
// floating point on per-token rates and rounded once, at the edge, to avoid
// compounding representation error across components.

const CURRENCY = 'USD';
const PER_MILLION = 1_000_000;

// Route families. `custom` is any other OpenAI-compatible endpoint; `unknown`
// is a route we cannot classify at all.
const ROUTES = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  OPENROUTER: 'openrouter',
  CUSTOM: 'custom',
  LOCAL: 'local',
  UNKNOWN: 'unknown',
});

// Pricing status.
const AVAILABLE = 'available';
const UNAVAILABLE = 'unavailable';
const NOT_APPLICABLE = 'not_applicable';

// Cost completeness labels persisted with each turn.
const COMPLETE = 'complete';
const PARTIAL = 'partial';
const COMPLETENESS_UNAVAILABLE = 'unavailable';
const COMPLETENESS_NOT_APPLICABLE = 'not_applicable';

// Evidence sources recorded verbatim so historical rows can be explained later
// without re-deriving them from currently-cached rates.
const SOURCES = Object.freeze({
  ANTHROPIC_CATALOG: 'anthropic-catalog',
  OPENAI_CATALOG: 'openai-catalog',
  OPENROUTER_METADATA: 'openrouter-metadata',
  USER_CONFIGURED: 'user-configured',
  PROVIDER_REPORTED: 'provider-reported',
  UNAVAILABLE: 'unavailable',
  NOT_APPLICABLE: 'not-applicable',
});

const CATALOG_VERSION = '2026-04-01';

// ---------------------------------------------------------------------------
// Verified direct-provider catalog.
//
// Only exact model IDs with independently verified rates belong here. The
// values are USD per million tokens. `cacheWrite` is the 5-minute ephemeral
// write premium; `cacheWrite1h` is the 1-hour write premium where the provider
// distinguishes it. `null` means the provider has no separate charge for that
// counter (the request is billed at the ordinary input rate).
//
// `longContext` models bill a higher rate once the input exceeds `threshold`
// input tokens; that threshold and the escalated rates are recorded per model.
// ---------------------------------------------------------------------------
const ANTHROPIC_CATALOG = Object.freeze({
  'claude-sonnet-5': Object.freeze({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 }),
});

const OPENAI_CATALOG = Object.freeze({
  'gpt-5': Object.freeze({
    input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: null,
    longContext: Object.freeze({ threshold: 272000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: null }),
  }),
});

// ---------------------------------------------------------------------------
// Small numeric helpers. Every price field is a non-negative finite number or
// null; anything else (negative, NaN, Infinity, a string) is treated as absent
// so a malformed metadata payload can never poison a cost total.
// ---------------------------------------------------------------------------
function rate(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hostOf(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return '';
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Route detection. The transport already knows `apiType`; the host refines it
// so OpenRouter (which speaks an OpenAI-compatible dialect but bills
// differently) is never mistaken for a direct OpenAI account.
// ---------------------------------------------------------------------------
function detectRoute({ apiType, baseUrl, isLocal } = {}) {
  if (isLocal) return ROUTES.LOCAL;
  const host = hostOf(baseUrl);
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return ROUTES.OPENROUTER;
  if (apiType === 'anthropic') return ROUTES.ANTHROPIC;
  if (host === 'api.anthropic.com') return ROUTES.ANTHROPIC;
  if (host === 'api.openai.com') return ROUTES.OPENAI;
  if (apiType === 'openai' && !host) return ROUTES.UNKNOWN;
  if (apiType === 'openai') return ROUTES.CUSTOM;
  return ROUTES.UNKNOWN;
}

// ---------------------------------------------------------------------------
// OpenRouter pricing metadata.
//
// OpenRouter reports prices as decimal strings in USD *per token*. We upscale
// to the canonical per-million unit once, here, so nothing downstream has to
// remember the difference. Overrides carry conditional rates keyed by
// `min_prompt_tokens` (strictly greater-than) and an optional UTC time window
// that may wrap midnight. Later applicable entries win per price key.
// ---------------------------------------------------------------------------
function minutesOfDay(utc) {
  if (typeof utc !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(utc.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function withinWindow(minutes, start, end) {
  if (start === null || end === null) return true;
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function normalizeOpenRouterPricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null;
  const base = {
    input: rate(pricing.prompt),
    output: rate(pricing.completion),
    cacheRead: rate(pricing.input_cache_read),
    cacheWrite: rate(pricing.input_cache_write),
    cacheWrite1h: rate(pricing.input_cache_write_1h),
  };
  const overrides = Array.isArray(pricing.overrides) ? pricing.overrides.filter(entry => entry && typeof entry === 'object') : [];
  // OpenRouter reports decimal strings per token; scaling to per-million can
  // introduce representation noise (0.000002 * 1e6 = 2.0000000000000004), so
  // each rate is snapped to nine decimals — far finer than any real price.
  const perMillion = value => value === null ? null : Math.round(value * PER_MILLION * 1e9) / 1e9;
  return {
    base: {
      input: perMillion(base.input), output: perMillion(base.output),
      cacheRead: perMillion(base.cacheRead), cacheWrite: perMillion(base.cacheWrite),
      cacheWrite1h: perMillion(base.cacheWrite1h),
    },
    overrides: overrides.map(entry => ({
      minInputTokens: positiveInt(entry.min_prompt_tokens),
      startMinutes: minutesOfDay(entry.utc_start),
      endMinutes: minutesOfDay(entry.utc_end),
      input: perMillion(rate(entry.prompt)), output: perMillion(rate(entry.completion)),
      cacheRead: perMillion(rate(entry.input_cache_read)), cacheWrite: perMillion(rate(entry.input_cache_write)),
      cacheWrite1h: perMillion(rate(entry.input_cache_write_1h)),
    })),
  };
}

// Pick the effective per-token rates for one request. Overrides apply in array
// order; a later applicable entry overwrites only the keys it defines, so a
// partial override composes with the base and earlier overrides.
function effectiveOpenRouterRates(normalized, { grossInputTokens = 0, at = null } = {}) {
  if (!normalized) return null;
  const rates = { ...normalized.base };
  const gross = Number.isFinite(grossInputTokens) && grossInputTokens > 0 ? grossInputTokens : 0;
  const minutes = at instanceof Date && !Number.isNaN(at.getTime())
    ? at.getUTCHours() * 60 + at.getUTCMinutes() : null;
  for (const override of normalized.overrides) {
    if (override.minInputTokens !== null && !(gross > override.minInputTokens)) continue;
    if (minutes !== null && (override.startMinutes !== null || override.endMinutes !== null)
      && !withinWindow(minutes, override.startMinutes, override.endMinutes)) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) {
      if (override[key] !== null) rates[key] = override[key];
    }
  }
  return rates;
}

// ---------------------------------------------------------------------------
// User-configured rates. The UI stores a small object; validate defensively so
// a typo cannot silently become a $0 rate. A user rate is per million tokens,
// the same unit the catalog uses.
// ---------------------------------------------------------------------------
function normalizeUserRates(userRates) {
  if (!userRates || typeof userRates !== 'object' || Array.isArray(userRates)) return null;
  const normalized = {
    input: rate(userRates.input), output: rate(userRates.output),
    cacheRead: rate(userRates.cacheRead), cacheWrite: rate(userRates.cacheWrite),
    cacheWrite1h: rate(userRates.cacheWrite1h),
  };
  // Require the two rates every cloud turn is billed on. Without input and
  // output the override is not a usable price and we decline to apply it.
  if (normalized.input === null || normalized.output === null) return null;
  return normalized;
}

// ---------------------------------------------------------------------------
// Pricing resolution.
// ---------------------------------------------------------------------------
function fromCatalog(catalog, modelId, source) {
  const entry = catalog[modelId];
  if (!entry) return null;
  return {
    status: AVAILABLE, source, currency: CURRENCY, unit: 'per_million_tokens',
    version: `${source}:${CATALOG_VERSION}`, modelId,
    input: entry.input, output: entry.output, cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite, cacheWrite1h: entry.cacheWrite1h ?? null,
    longContext: entry.longContext ?? null,
  };
}

function resolvePricing(context = {}, deps = {}) {
  const { route, modelId = null, providerMeta = null, userRates = null } = context;
  if (route === ROUTES.LOCAL) {
    return { status: NOT_APPLICABLE, source: SOURCES.NOT_APPLICABLE, currency: CURRENCY,
      unit: 'per_million_tokens', modelId, reason: 'local-model-no-cloud-charge' };
  }
  const user = normalizeUserRates(userRates);
  if (user) {
    return { status: AVAILABLE, source: SOURCES.USER_CONFIGURED, currency: CURRENCY,
      unit: 'per_million_tokens', version: 'user-configured', modelId,
      input: user.input, output: user.output, cacheRead: user.cacheRead,
      cacheWrite: user.cacheWrite, cacheWrite1h: user.cacheWrite1h, longContext: null };
  }
  if (route === ROUTES.ANTHROPIC) {
    const entry = fromCatalog(ANTHROPIC_CATALOG, modelId, SOURCES.ANTHROPIC_CATALOG);
    if (entry) return entry;
  }
  if (route === ROUTES.OPENAI) {
    const entry = fromCatalog(OPENAI_CATALOG, modelId, SOURCES.OPENAI_CATALOG);
    if (entry) return entry;
  }
  if (route === ROUTES.OPENROUTER) {
    const normalized = normalizeOpenRouterPricing(deps.openRouterPricing ?? providerMeta?.pricing);
    const reference = effectiveOpenRouterRates(normalized, {});
    if (reference && reference.input !== null && reference.output !== null) {
      return { status: AVAILABLE, source: SOURCES.OPENROUTER_METADATA, currency: CURRENCY,
        unit: 'per_million_tokens', version: 'openrouter-metadata', modelId,
        input: reference.input, output: reference.output, cacheRead: reference.cacheRead,
        cacheWrite: reference.cacheWrite, cacheWrite1h: reference.cacheWrite1h, longContext: null,
        openRouter: normalized };
    }
  }
  // No explicit evidence: unknown, never a fabricated zero.
  return { status: UNAVAILABLE, source: SOURCES.UNAVAILABLE, currency: CURRENCY,
    unit: 'per_million_tokens', modelId, reason: 'no-price-evidence' };
}

// Resolve the effective rates for a concrete request against a pricing
// descriptor. Handles catalog long-context tiers and OpenRouter conditional
// overrides. Returns null when pricing is not available.
function effectiveRates(pricing, { grossInputTokens = 0, at = null } = {}) {
  if (!pricing || pricing.status !== AVAILABLE) return null;
  if (pricing.openRouter) return effectiveOpenRouterRates(pricing.openRouter, { grossInputTokens, at });
  const long = pricing.longContext;
  const gross = positiveInt(grossInputTokens) ?? 0;
  if (long && long.threshold && gross > long.threshold) {
    return { input: long.input, output: long.output,
      cacheRead: long.cacheRead ?? pricing.cacheRead, cacheWrite: long.cacheWrite ?? pricing.cacheWrite,
      cacheWrite1h: long.cacheWrite1h ?? pricing.cacheWrite1h ?? null };
  }
  return { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead,
    cacheWrite: pricing.cacheWrite, cacheWrite1h: pricing.cacheWrite1h ?? null };
}

// ---------------------------------------------------------------------------
// Usage normalization. Counters and pricing are distinct concerns: a missing
// counter stays null (unknown), while a measured zero stays zero.
// ---------------------------------------------------------------------------
function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(usage = {}) {
  return {
    uncachedInputTokens: counter(usage.uncachedInputTokens ?? usage.uncached_input_tokens),
    cacheReadTokens: counter(usage.cacheReadTokens ?? usage.cache_read_tokens),
    cacheWriteTokens: counter(usage.cacheWriteTokens ?? usage.cache_write_tokens),
    cacheWrite1hTokens: counter(usage.cacheWrite1hTokens ?? usage.cache_write_1h_tokens),
    outputTokens: counter(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens),
    reasoningTokens: counter(usage.reasoningTokens ?? usage.reasoning_tokens),
    grossInputTokens: counter(usage.grossInputTokens ?? usage.gross_input_tokens ?? usage.promptTokens ?? usage.prompt_tokens),
    providerReportedCost: typeof usage.providerReportedCost === 'number' && Number.isFinite(usage.providerReportedCost) && usage.providerReportedCost >= 0
      ? usage.providerReportedCost : null,
  };
}

function round6(value) {
  // Six decimals is half a micro-dollar: enough to keep a single tiny turn
  // non-zero without pretending to a precision the rates do not have.
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Cost estimation.
//
// Cache savings compares what the actual input cost against what the same
// prompt would have cost with no cache at all:
//
//   baseline = grossInput * inputRate
//   actual   = uncached*input + cacheRead*cacheRead + cacheWrite*cacheWrite
//   savings  = baseline - actual
//
// The result may be negative (a cache write that is never read back costs
// more than not caching), zero, or positive. It is reported honestly.
//
// Reasoning tokens are a measured *subset* of output. `components.reasoning`
// is an informational split of the output charge, never added to the total.
// ---------------------------------------------------------------------------
function estimateUsageCost({ pricing, usage = {}, at = null } = {}) {
  const normalized = normalizeUsage(usage);
  if (!pricing || pricing.status === NOT_APPLICABLE) {
    return { status: NOT_APPLICABLE, completeness: COMPLETENESS_NOT_APPLICABLE,
      currency: CURRENCY, source: pricing?.source ?? SOURCES.NOT_APPLICABLE,
      totalCost: null, providerReportedCost: normalized.providerReportedCost,
      components: null, cacheSavings: null, missing: [], version: pricing?.version ?? null };
  }
  if (pricing.status !== AVAILABLE) {
    // Without a resolvable price a provider-reported charge is still a real,
    // authoritative bill: report it rather than pretending the turn is unknown.
    if (normalized.providerReportedCost !== null) {
      return { status: AVAILABLE, completeness: COMPLETE, currency: CURRENCY,
        source: SOURCES.PROVIDER_REPORTED, totalCost: round6(normalized.providerReportedCost),
        estimatedTotal: null, providerReportedCost: normalized.providerReportedCost,
        components: null, cacheSavings: null, missing: [], version: 'provider-reported' };
    }
    return { status: UNAVAILABLE, completeness: COMPLETENESS_UNAVAILABLE,
      currency: CURRENCY, source: pricing.source ?? SOURCES.UNAVAILABLE,
      totalCost: null, providerReportedCost: null,
      components: null, cacheSavings: null, missing: ['price'], version: pricing.version ?? null };
  }
  // OpenRouter reports an authoritative per-request charge. When present it is
  // the billed amount; the estimate is retained alongside for audit but the
  // provider's number wins for the total.
  const rates = effectiveRates(pricing, { grossInputTokens: normalized.grossInputTokens, at });
  if (!rates) {
    return { status: UNAVAILABLE, completeness: COMPLETENESS_UNAVAILABLE, currency: CURRENCY,
      source: pricing.source, totalCost: null, providerReportedCost: normalized.providerReportedCost,
      components: null, cacheSavings: null, missing: ['rate'], version: pricing.version };
  }
  const perToken = value => value === null || value === undefined ? null : value / PER_MILLION;
  const input = perToken(rates.input);
  const output = perToken(rates.output);
  const cacheRead = perToken(rates.cacheRead);
  const cacheWrite = perToken(rates.cacheWrite);
  const cacheWrite1h = perToken(rates.cacheWrite1h);

  const missing = [];
  const priceOf = (tokens, unitRate, label) => {
    if (tokens === null) { missing.push(label); return null; }
    if (unitRate === null || unitRate === undefined) return 0; // provider charges the default rate
    return tokens * unitRate;
  };

  const uncached = normalized.uncachedInputTokens;
  const cacheReadTokens = normalized.cacheReadTokens;
  const cacheWriteTokens = normalized.cacheWriteTokens;
  const cacheWrite1hTokens = normalized.cacheWrite1hTokens;
  const outputTokens = normalized.outputTokens;
  const reasoningTokens = normalized.reasoningTokens;
  const gross = normalized.grossInputTokens;

  const uncachedCost = priceOf(uncached, input, 'uncached_input');
  // A cache read only makes sense when the provider reports it. When it is not
  // reported we charge it as zero *unless* the gross prompt proves part of the
  // input was cached but unaccounted for — then the bill is genuinely partial
  // and is never silently understated.
  let cacheReadCost = 0;
  if (cacheReadTokens !== null) {
    cacheReadCost = cacheReadTokens * (cacheRead ?? input ?? 0);
  } else {
    const cachedPortion = gross !== null && uncached !== null && gross > uncached
      ? gross - uncached - (cacheWriteTokens ?? 0) - (cacheWrite1hTokens ?? 0) : 0;
    if (cachedPortion > 0) { missing.push('cache_read'); cacheReadCost = null; }
  }
  let cacheWriteCost = 0;
  if (cacheWriteTokens !== null) cacheWriteCost = cacheWriteTokens * (cacheWrite ?? input ?? 0);
  let cacheWrite1hCost = 0;
  if (cacheWrite1hTokens !== null) cacheWrite1hCost = cacheWrite1hTokens * (cacheWrite1h ?? cacheWrite ?? input ?? 0);
  const outputCost = priceOf(outputTokens, output, 'output');

  const components = {
    uncachedInput: uncachedCost, cacheRead: cacheReadCost, cacheWrite: cacheWriteCost,
    cacheWrite1h: cacheWrite1hCost, output: outputCost,
    // Subset of output, for display only. Never part of the total.
    reasoning: reasoningTokens !== null && output !== null ? reasoningTokens * output : null,
  };

  const inputCharges = [uncachedCost, cacheReadCost, cacheWriteCost, cacheWrite1hCost];
  const inputKnown = inputCharges.every(value => value !== null);
  const outputKnown = outputCost !== null;
  let estimatedTotal = null;
  if (inputKnown && outputKnown) {
    estimatedTotal = round6(inputCharges.reduce((sum, value) => sum + value, 0) + outputCost);
  }

  // Cache savings needs the gross prompt and the uncached portion. When either
  // is unknown we cannot honestly compute a comparison.
  let cacheSavings = null;
  if (uncached !== null && gross !== null && input !== null && cacheReadCost !== null) {
    const baseline = gross * input;
    const actualInput = (uncachedCost ?? 0) + cacheReadCost + (cacheWriteCost ?? 0) + (cacheWrite1hCost ?? 0);
    cacheSavings = round6(baseline - actualInput);
  }

  // A provider-reported charge is the authoritative billed amount; the
  // rate-based estimate is kept alongside it for audit but never replaces it.
  const providerReported = normalized.providerReportedCost !== null ? round6(normalized.providerReportedCost) : null;
  const totalCost = providerReported ?? estimatedTotal;
  const source = providerReported !== null ? SOURCES.PROVIDER_REPORTED : pricing.source;
  // Partial means at least one real component or the total was measured but the
  // whole picture is not: never upgrades missing data to complete, and never
  // downgrades a real subtotal to "unavailable".
  const anyKnown = inputCharges.some(value => value !== null) || outputCost !== null || cacheSavings !== null;
  const completeness = totalCost !== null && missing.length === 0 ? COMPLETE
    : totalCost !== null || anyKnown ? PARTIAL : COMPLETENESS_UNAVAILABLE;

  return {
    status: AVAILABLE, completeness, currency: CURRENCY, source,
    totalCost, estimatedTotal, providerReportedCost: providerReported,
    components, cacheSavings, missing,
    effectiveUnit: 'per_million_tokens',
    version: pricing.version ?? null,
    rates: { input: rates.input, output: rates.output, cacheRead: rates.cacheRead,
      cacheWrite: rates.cacheWrite, cacheWrite1h: rates.cacheWrite1h },
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by the renderer. Kept here so the formatter and
// the estimator's rounding never drift apart.
// ---------------------------------------------------------------------------
function formatUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '$0.00';
  if (magnitude < 0.0001) return `< $0.0001`;
  if (magnitude < 0.01) return `$${value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (magnitude < 1) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = formatUsd(Math.abs(value));
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

module.exports = {
  CURRENCY, PER_MILLION, ROUTES, SOURCES, CATALOG_VERSION,
  AVAILABLE, UNAVAILABLE, NOT_APPLICABLE,
  COMPLETE, PARTIAL, COMPLETENESS_UNAVAILABLE, COMPLETENESS_NOT_APPLICABLE,
  ANTHROPIC_CATALOG, OPENAI_CATALOG,
  rate, hostOf, detectRoute,
  normalizeOpenRouterPricing, effectiveOpenRouterRates, normalizeUserRates,
  resolvePricing, effectiveRates, normalizeUsage, estimateUsageCost,
  formatUsd, formatSignedUsd,
};

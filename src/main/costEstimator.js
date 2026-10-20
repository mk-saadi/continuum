'use strict';

// Phase 2.0C-3 cost orchestration. This module owns the *policy* of where a
// price comes from — saved provider rates, live OpenRouter metadata, the
// verified catalog, or a provider-reported charge — and delegates all money
// math to the pure ../lib/cloudPricing.cjs resolver.
//
// Everything here is read-only and never performs inference. The synchronous
// paths read only already-materialized state (settings + the last metadata
// snapshot); the asynchronous path shares the same 5-minute metadata cache the
// settings screen already uses. No cost path can add a network call to a turn.
const pricing = require('../lib/cloudPricing.cjs');

// The saved provider identity is required for cloud turns; a local turn needs
// nothing. A missing settings store (headless/tests) degrades to no evidence.
function providerRow(providerId) {
  if (typeof providerId !== 'string' || !providerId) return null;
  try {
    return require('./cloudProviders').getStoredProvider(providerId);
  } catch {
    return null;
  }
}

function knownMetadata(providerId, modelId) {
  try {
    return require('./cloudProviders').getKnownModelMetadata(providerId, modelId);
  } catch {
    return null;
  }
}

function routeContext({ isLocal, providerId }) {
  if (isLocal) return { route: pricing.ROUTES.LOCAL, provider: null };
  const provider = providerRow(providerId);
  return {
    route: pricing.detectRoute({ apiType: provider?.apiType, baseUrl: provider?.baseUrl }),
    provider,
  };
}

function pricingFrom(route, provider, modelId, providerMeta) {
  return pricing.resolvePricing(
    { route, modelId, providerMeta, userRates: provider?.pricing ?? null },
    { openRouterPricing: providerMeta?.pricingRaw ?? null },
  );
}

// Synchronous resolution used when a turn settles. OpenRouter pricing comes
// from the last metadata snapshot; if it is not cached yet, the provider's own
// per-request charge (when present) still produces an authoritative cost, and
// otherwise the turn is honestly unavailable.
function resolveTurnPricingSync({ isLocal = false, providerId = null, modelId = null } = {}) {
  const { route, provider } = routeContext({ isLocal, providerId });
  const providerMeta = route === pricing.ROUTES.OPENROUTER ? knownMetadata(providerId, modelId) : null;
  return pricingFrom(route, provider, modelId, providerMeta);
}

// Asynchronous resolution for a chat run start: refreshes the metadata cache so
// a later synchronous settlement has OpenRouter rates available. Bounded and
// best-effort — any failure leaves the turn to the provider-reported path.
async function resolveTurnPricingAsync({ isLocal = false, providerId = null, modelId = null } = {}) {
  if (isLocal) return pricingFrom(pricing.ROUTES.LOCAL, null, modelId, null);
  const { route, provider } = routeContext({ isLocal, providerId });
  if (route !== pricing.ROUTES.OPENROUTER) return pricingFrom(route, provider, modelId, null);
  try {
    await require('./cloudProviders').getCloudModelMetadata();
  } catch {
    /* fall through to whatever is already cached */
  }
  return resolveTurnPricingSync({ isLocal, providerId, modelId });
}

function unavailablePricing(modelId = null) {
  return { status: pricing.UNAVAILABLE, source: pricing.SOURCES.UNAVAILABLE, currency: pricing.CURRENCY,
    unit: 'per_million_tokens', modelId, reason: 'no-price-evidence' };
}

// Build the canonical counters the estimator expects from a normalized chat
// stats object (see ../lib/completionStats.mjs) or a persisted turn row.
function usageFromStats(stats = {}) {
  return {
    uncachedInputTokens: stats.uncachedInputTokens,
    cacheReadTokens: stats.cacheReadTokens ?? stats.cachedTokens,
    cacheWriteTokens: stats.cacheWriteTokens ?? stats.cacheCreationTokens,
    cacheWrite1hTokens: stats.cacheWrite1hTokens,
    outputTokens: stats.outputTokens ?? stats.completionTokens,
    reasoningTokens: stats.reasoningTokens,
    grossInputTokens: stats.grossInputTokens ?? stats.promptTokens,
    providerReportedCost: stats.providerCost ?? stats.providerReportedCost,
  };
}

// Build the canonical counters from a sub-agent session.usage. Budgets already
// accumulate the diagnostic subsets (uncached, cache read/write) and the
// provider-reported charge, so this is a shape mapping, not a re-derivation.
function usageFromChildUsage(usage) {
  usage = usage && typeof usage === 'object' ? usage : {};
  return {
    uncachedInputTokens: usage.uncached_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
    outputTokens: usage.completion_tokens,
    reasoningTokens: usage.reasoning_tokens,
    grossInputTokens: usage.prompt_tokens,
    providerReportedCost: usage.provider_reported_cost,
  };
}

function estimateFromStats({ stats, resolvedPricing = null, isLocal = false, providerId = null, modelId = null, at = null } = {}) {
  const descriptor = resolvedPricing ?? resolveTurnPricingSync({ isLocal, providerId, modelId });
  return pricing.estimateUsageCost({ pricing: descriptor ?? unavailablePricing(modelId), usage: usageFromStats(stats), at });
}

function estimateFromChild({ usage, isLocal = false, providerId = null, modelId = null, at = null } = {}) {
  const descriptor = resolveTurnPricingSync({ isLocal, providerId, modelId });
  return pricing.estimateUsageCost({ pricing: descriptor ?? unavailablePricing(modelId), usage: usageFromChildUsage(usage), at });
}

// Compact persistence shape shared by the token_usage and subagent_runs writers.
function costColumns(estimate, providerReportedCost = null) {
  if (!estimate) return {
    costTotal: null, costCurrency: pricing.CURRENCY, costStatus: pricing.UNAVAILABLE,
    costCompleteness: pricing.COMPLETENESS_UNAVAILABLE, costSource: pricing.SOURCES.UNAVAILABLE,
    costVersion: null, costTimestamp: null, costUncachedInput: null, costCacheRead: null,
    costCacheWrite: null, costCacheWrite1h: null, costOutput: null, costReasoning: null,
    costCacheSavings: null, costProviderReported: providerReportedCost, costBreakdown: null,
  };
  const components = estimate.components ?? {};
  return {
    costTotal: estimate.totalCost ?? null,
    costCurrency: estimate.currency ?? pricing.CURRENCY,
    costStatus: estimate.status ?? null,
    costCompleteness: estimate.completeness ?? pricing.COMPLETENESS_UNAVAILABLE,
    costSource: estimate.source ?? pricing.SOURCES.UNAVAILABLE,
    costVersion: estimate.version ?? null,
    costTimestamp: new Date().toISOString(),
    costUncachedInput: components.uncachedInput ?? null,
    costCacheRead: components.cacheRead ?? null,
    costCacheWrite: components.cacheWrite ?? null,
    costCacheWrite1h: components.cacheWrite1h ?? null,
    costOutput: components.output ?? null,
    costReasoning: components.reasoning ?? null,
    costCacheSavings: estimate.cacheSavings ?? null,
    costProviderReported: estimate.providerReportedCost ?? providerReportedCost ?? null,
    costBreakdown: JSON.stringify({
      version: estimate.version ?? null, source: estimate.source ?? null,
      completeness: estimate.completeness ?? null, missing: estimate.missing ?? [],
      rates: estimate.rates ?? null,
    }),
  };
}

module.exports = {
  resolveTurnPricingSync, resolveTurnPricingAsync, unavailablePricing,
  usageFromStats, usageFromChildUsage, estimateFromStats, estimateFromChild, costColumns,
};

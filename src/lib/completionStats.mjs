const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Measurement vocabulary shared with token history and the analytics UI.
// A missing provider field is `unavailable`; it is never silently promoted to
// a measured zero. `partially_measured` means at least one phase reported the
// field but not every phase did, so an aggregate is a known subtotal only.
export const MEASURED = 'measured';
export const ESTIMATED = 'estimated';
export const UNAVAILABLE = 'unavailable';
export const PARTIALLY_MEASURED = 'partially_measured';

const PROVIDER = 'provider';
const SERVER_TIMINGS = 'server-timings';
const DERIVED = 'derived';

// A stream may split statistics across its stop and usage-only chunks. Nulls
// and empty trailers must not erase counters already reported in this phase.
// Nested provider cache details (e.g. prompt_tokens_details) are merged one
// level deep so cache read/write survives split usage chunks.
export function mergeMetrics(previous, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return previous;
  const merged = { ...(previous ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (number(value) !== null) {
      merged[key] = value;
      changed = true;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedPrev = merged[key] && typeof merged[key] === 'object' ? merged[key] : {};
      const nested = { ...nestedPrev };
      let nestedChanged = false;
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (number(nestedValue) !== null) {
          nested[nestedKey] = nestedValue;
          nestedChanged = true;
        }
      }
      if (nestedChanged) {
        merged[key] = nested;
        changed = true;
      }
    }
  }
  return changed ? merged : previous;
}

// Provider cache fields are not interchangeable, but once normalized every
// supported shape exposes the *cache-read* and *cache-write* portions of the
// gross prompt. Missing fields stay null so callers can distinguish
// "not reported" from a measured zero.
//
//   OpenAI-style       usage.prompt_tokens_details.cached_tokens
//   OpenAI alias       usage.cached_tokens
//   DeepSeek           usage.prompt_cache_hit_tokens
//   Anthropic          usage.cache_read_input_tokens / cache_creation_input_tokens
//   Gemini             usageMetadata.cachedContentTokenCount
//   llama.cpp          timings.cache_n (processed prompt stays timings.prompt_n)
function cacheCandidates(usage, timings) {
  const details = usage?.prompt_tokens_details;
  const metadata = usage?.usageMetadata;
  return {
    cached: [
      [count(details?.cached_tokens), PROVIDER],
      [count(usage?.cached_tokens), PROVIDER],
      [count(usage?.prompt_cache_hit_tokens), PROVIDER],
      [count(usage?.cache_read_input_tokens), PROVIDER],
      [count(metadata?.cachedContentTokenCount), PROVIDER],
      [count(usage?.cachedContentTokenCount), PROVIDER],
      [count(timings?.cache_n), SERVER_TIMINGS],
    ],
    created: [
      [count(usage?.cache_creation_input_tokens), PROVIDER],
      [count(details?.cache_creation_tokens), PROVIDER],
      [count(usage?.cache_creation_tokens), PROVIDER],
      [count(usage?.cache_write_tokens), PROVIDER],
      [count(details?.cache_write_tokens), PROVIDER],
    ],
  };
}

function firstMeasured(candidates) {
  for (const [value, source] of candidates) {
    if (value !== null) return { value, source };
  }
  return { value: null, source: UNAVAILABLE };
}

export function extractCacheTokens(usage, timings) {
  const candidates = cacheCandidates(usage, timings);
  return { cached: firstMeasured(candidates.cached).value, created: firstMeasured(candidates.created).value };
}

// Source-aware form used by phaseStats. It keeps the provider field that
// produced a number so persisted history can label timings-derived local cache
// separately from a cloud provider's explicit cache report.
export function extractCacheTokenSources(usage, timings) {
  const candidates = cacheCandidates(usage, timings);
  const cached = firstMeasured(candidates.cached);
  const created = firstMeasured(candidates.created);
  return { cachedTokens: cached.value, cacheCreationTokens: created.value,
    cachedSource: cached.source, createdSource: created.source };
}

// Reasoning tokens are a *subset* of the provider's output/completion tokens.
// Every supported contract reports them separately when it reports them at all;
// never infer a value from the configured budget.
export function extractReasoningTokens(usage, timings) {
  return count(usage?.completion_tokens_details?.reasoning_tokens) ??
    count(usage?.output_tokens_details?.reasoning_tokens) ??
    count(usage?.reasoning_tokens) ??
    count(usage?.thoughts_token_count) ??
    count(usage?.usageMetadata?.thoughtsTokenCount) ??
    count(usage?.thoughtsTokenCount) ??
    count(timings?.reasoning_n) ??
    null;
}

function deriveUncachedInput({ gross, cached, created, processed }) {
  // llama.cpp timings report the processed (uncached) prompt directly.
  if (processed !== null) return processed;
  if (gross === null || cached === null) return null;
  // Writes are a separate portion of the gross prompt when the provider has a
  // cache-write counter. Providers without that concept report no field and
  // the cache-read portion is the only cached part to subtract.
  return count(gross - cached - (created ?? 0));
}

export function phaseStats({ usage, timings, startTime, endTime }) {
  const processed = count(timings?.prompt_n);
  const timingCached = count(timings?.cache_n);
  const usagePrompt = count(usage?.prompt_tokens) ?? count(usage?.promptTokenCount);
  const anthropicInput = count(usage?.input_tokens);
  const { cachedTokens, cacheCreationTokens, cachedSource, createdSource } =
    extractCacheTokenSources(usage, timings);
  // llama.cpp exposes prompt_n (processed/uncached) plus cache_n (prefix cache).
  const timingGross = processed === null ? null : count(processed + (timingCached ?? 0));
  // Anthropic's raw shape keeps input_tokens separate from cache reads/writes;
  // its cloud transport normally folds those into prompt_tokens before this
  // function sees them. If the raw shape arrives here, add the pieces once.
  const rawAnthropic = usagePrompt === null && anthropicInput !== null;
  const promptTokens = usagePrompt ?? (rawAnthropic
    ? (cachedTokens === null ? null : count(anthropicInput + cachedTokens + (cacheCreationTokens ?? 0)))
    : timingGross);
  const completionTokens = count(usage?.completion_tokens) ?? count(usage?.output_tokens)
    ?? count(usage?.candidatesTokenCount) ?? count(timings?.predicted_n);
  const totalTokens = count(usage?.total_tokens) ?? count(usage?.totalTokenCount) ??
    (promptTokens !== null && completionTokens !== null ? count(promptTokens + completionTokens) : null);
  const reasoningTokens = extractReasoningTokens(usage, timings);
  // Visible output is derived only when the provider separated reasoning from
  // the same completion counter. Otherwise it stays unknown rather than
  // mislabelling all output as visible.
  const visibleCompletionTokens = completionTokens !== null && reasoningTokens !== null
    ? count(completionTokens - reasoningTokens) : null;
  // Some gateways (notably OpenRouter) return the authoritative billed charge
  // on every usage payload, including streaming final chunks. It is currency
  // evidence, not a token counter, and is neither a subset nor a sum of the
  // token fields. It is never derived from cost_details.upstream_inference_cost,
  // which can describe a different party's charge.
  const providerCost = number(usage?.cost);
  const uncachedInputTokens = rawAnthropic ? anthropicInput : deriveUncachedInput({ gross: promptTokens,
    cached: cachedTokens, created: cacheCreationTokens,
    processed: usagePrompt === null && anthropicInput === null ? processed : null });
  const time = Math.max(0, (endTime - startTime) / 1000);
  const milliseconds = number(timings?.predicted_ms);
  const reportedRate = number(timings?.predicted_per_second);
  const generationTime = milliseconds !== null ? milliseconds / 1000 :
    completionTokens !== null && reportedRate > 0 ? completionTokens / reportedRate : null;
  const tokensPerSecond = generationTime > 0 && completionTokens !== null ? completionTokens / generationTime :
    reportedRate ?? (time > 0 && completionTokens !== null ? completionTokens / time : null);
  const inputSource = usagePrompt !== null || anthropicInput !== null ? PROVIDER :
    processed !== null ? SERVER_TIMINGS : UNAVAILABLE;
  const outputSource = count(usage?.completion_tokens) !== null || count(usage?.output_tokens) !== null
    ? PROVIDER : count(timings?.predicted_n) !== null ? SERVER_TIMINGS : UNAVAILABLE;
  return { startTime, endTime, time, promptTokens, completionTokens, totalTokens, tokensPerSecond,
    cachedTokens, cacheCreationTokens, reasoningTokens, visibleCompletionTokens, providerCost,
    // Explicit aliases make the gross/uncached distinction unambiguous for
    // persistence and analytics without changing the legacy field names.
    grossInputTokens: promptTokens, uncachedInputTokens,
    cacheReadTokens: cachedTokens, cacheWriteTokens: cacheCreationTokens,
    outputTokens: completionTokens,
    inputSource, outputSource, cacheReadSource: cachedSource, cacheWriteSource: createdSource,
    inputCoverage: promptTokens === null ? UNAVAILABLE : MEASURED,
    outputCoverage: completionTokens === null ? UNAVAILABLE : MEASURED,
    totalCoverage: totalTokens === null ? UNAVAILABLE : MEASURED,
    cacheReadCoverage: cachedTokens === null ? UNAVAILABLE : MEASURED,
    cacheWriteCoverage: cacheCreationTokens === null ? UNAVAILABLE : MEASURED,
    reasoningCoverage: reasoningTokens === null ? 'unreported' : MEASURED,
    usageSemantics: 'per-request',
    ...(generationTime !== null ? { generationTime } : {}) };
}

// Accepts a finite non-negative number, so both integer token counts and
// fractional currency amounts (a per-request provider charge) aggregate.
function sumKnown(phases, key) {
  const values = phases.map(phase => number(phase?.[key])).filter(value => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function coverageOf(phases, key) {
  if (!Array.isArray(phases) || phases.length === 0) return UNAVAILABLE;
  const known = phases.filter(phase => number(phase?.[key]) !== null).length;
  return known === 0 ? UNAVAILABLE : known === phases.length ? MEASURED : PARTIALLY_MEASURED;
}

function sourceOf(phases, key) {
  const sources = new Set(phases.map(phase => phase?.[key]).filter(source => source && source !== UNAVAILABLE));
  if (sources.size === 0) return UNAVAILABLE;
  return sources.size === 1 ? [...sources][0] : DERIVED;
}

export function turnPromptTelemetry(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    return { lastPromptTokens: null, peakPromptTokens: null, peakRequestIndex: null,
      promptRequests: 0, promptCoverage: 'none', lastCachedTokens: null, lastCacheCreationTokens: null,
      cacheReadCoverage: UNAVAILABLE, cacheWriteCoverage: UNAVAILABLE };
  }
  const prompts = phases.map(phase => count(phase?.promptTokens));
  const present = prompts.filter(value => value !== null);
  let peak = null, peakIndex = null;
  for (let index = 0; index < prompts.length; index++) {
    if (prompts[index] !== null && (peak === null || prompts[index] > peak)) {
      peak = prompts[index];
      peakIndex = index + 1;
    }
  }
  const last = phases[phases.length - 1] ?? {};
  return {
    lastPromptTokens: prompts[prompts.length - 1],
    peakPromptTokens: peak,
    peakRequestIndex: peakIndex,
    promptRequests: phases.length,
    promptCoverage: present.length === prompts.length ? 'complete' : present.length > 0 ? 'partial' : 'none',
    lastCachedTokens: count(last.cachedTokens),
    lastCacheCreationTokens: count(last.cacheCreationTokens),
    lastProviderCost: number(last.providerCost),
    // Per-request last-value telemetry remains separate from the turn total.
    cacheReadCoverage: count(last.cachedTokens) === null ? UNAVAILABLE : MEASURED,
    cacheWriteCoverage: count(last.cacheCreationTokens) === null ? UNAVAILABLE : MEASURED,
  };
}

export function mergePhaseStats(phases, startTime) {
  const final = phases.at(-1);
  const telemetry = turnPromptTelemetry(phases);
  // Do not let an unreported tool phase erase the final answer's valid stats,
  // or label incomplete counts as totals for the entire turn. In this mode the
  // cached/cache-write values describe the final request only, never a sum.
  // Cumulative provider snapshots describe a running request, not independent
  // phases; summing them would double count. Treat the last snapshot as the
  // final value and never mix it with incremental per-request phases.
  const cumulative = phases.some(phase => phase.usageSemantics === 'cumulative');
  if (phases.length > 1 && (cumulative || phases.some(phase => phase.promptTokens === null || phase.completionTokens === null || phase.totalTokens === null))) {
    return { ...final, ...telemetry, scope: 'final', usageSemantics: cumulative ? 'cumulative' : 'final-request',
      cacheReadCoverage: final.cacheReadCoverage ?? telemetry.cacheReadCoverage,
      cacheWriteCoverage: final.cacheWriteCoverage ?? telemetry.cacheWriteCoverage };
  }
  const sum = key => phases.every(phase => phase[key] !== null) ? count(phases.reduce((total, phase) => total + phase[key], 0)) : null;
  const promptTokens = sum('promptTokens'), completionTokens = sum('completionTokens'), totalTokens = sum('totalTokens');
  // Cache counters are optional per provider. Every known phase value is
  // summed; failing to report on one phase never makes the last phase stand in
  // for the whole turn. Missing portions are represented by coverage labels.
  const cachedTokens = sumKnown(phases, 'cachedTokens');
  const cacheCreationTokens = sumKnown(phases, 'cacheCreationTokens');
  const cacheReadCoverage = coverageOf(phases, 'cachedTokens');
  const cacheWriteCoverage = coverageOf(phases, 'cacheCreationTokens');
  // Reasoning/visible counters remain all-or-nothing totals: a partial sum
  // could be mistaken for the turn's reasoning total. Coverage still says the
  // underlying phase data was incomplete.
  const reasoningTokens = sum('reasoningTokens');
  const visibleCompletionTokens = sum('visibleCompletionTokens');
  const uncachedInputTokens = sum('uncachedInputTokens');
  const uncachedInputCoverage = coverageOf(phases, 'uncachedInputTokens');
  // A provider-reported charge appears per request; sum every known phase so a
  // multi-request turn reports the whole bill. Coverage says whether all
  // requests reported one.
  const providerCost = sumKnown(phases, 'providerCost');
  const providerCostCoverage = coverageOf(phases, 'providerCost');
  const endTime = final.endTime;
  const time = Math.max(0, (endTime - startTime) / 1000);
  const generationTime = phases.every(phase => phase.generationTime != null)
    ? phases.reduce((total, phase) => total + phase.generationTime, 0) : null;
  const tokensPerSecond = generationTime > 0 && completionTokens !== null ? completionTokens / generationTime :
    phases.length === 1 ? final.tokensPerSecond : time > 0 && completionTokens !== null ? completionTokens / time : null;
  return { startTime, endTime, time, promptTokens, completionTokens, totalTokens, tokensPerSecond, ...telemetry, scope: 'all',
    cachedTokens, cacheCreationTokens, reasoningTokens, visibleCompletionTokens,
    grossInputTokens: promptTokens, uncachedInputTokens,
    cacheReadTokens: cachedTokens, cacheWriteTokens: cacheCreationTokens,
    outputTokens: completionTokens,
    inputSource: sourceOf(phases, 'inputSource'), outputSource: sourceOf(phases, 'outputSource'),
    cacheReadSource: sourceOf(phases, 'cacheReadSource'), cacheWriteSource: sourceOf(phases, 'cacheWriteSource'),
    inputCoverage: promptTokens === null ? UNAVAILABLE : MEASURED,
    outputCoverage: completionTokens === null ? UNAVAILABLE : MEASURED,
    totalCoverage: totalTokens === null ? UNAVAILABLE : MEASURED,
    uncachedInputCoverage,
    providerCost, providerCostCoverage,
    cacheReadCoverage, cacheWriteCoverage,
    reasoningCoverage: reasoningTokens === null ? 'unreported' : MEASURED,
    usageSemantics: 'per-request',
    ...(generationTime !== null ? { generationTime } : {}) };
}

// Percent cache reads of gross prompt tokens, but only when both sides are
// actually measured for the whole turn. Otherwise null: a ratio built from a
// partial subtotal would overstate or understate re-use.
export function cacheHitRatio({ grossInputTokens, cachedTokens, cacheReadCoverage } = {}) {
  const gross = count(grossInputTokens);
  const cached = count(cachedTokens);
  if (gross === null || cached === null || gross <= 0) return null;
  if (cacheReadCoverage && cacheReadCoverage !== MEASURED) return null;
  return cached / gross * 100;
}

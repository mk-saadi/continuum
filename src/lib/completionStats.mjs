const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

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

// Provider shapes differ: OpenAI/OpenRouter use usage.prompt_tokens_details
// .cached_tokens, Anthropic uses cache_read/cache_creation_input_tokens,
// DeepSeek uses prompt_cache_hit_tokens, local llama.cpp reports
// timings.cache_n. Returns { cached, created } with null when unreported.
export function extractCacheTokens(usage, timings) {
  const details = usage?.prompt_tokens_details;
  const cached =
    count(details?.cached_tokens) ??
    count(usage?.cached_tokens) ??
    count(usage?.prompt_cache_hit_tokens) ??
    count(usage?.cache_read_input_tokens) ??
    count(timings?.cache_n);
  const created =
    count(usage?.cache_creation_input_tokens) ??
    count(details?.cache_creation_tokens) ??
    null;
  return { cached, created };
}

// Reasoning tokens are a *subset* of the provider's output/completion tokens.
// Every supported contract reports them separately when it reports them at all;
// never infer a value from the configured budget.
export function extractReasoningTokens(usage, timings) {
  return count(usage?.completion_tokens_details?.reasoning_tokens) ??
    count(usage?.output_tokens_details?.reasoning_tokens) ??
    count(usage?.reasoning_tokens) ??
    count(usage?.thoughts_token_count) ??
    count(timings?.reasoning_n) ??
    null;
}

export function phaseStats({ usage, timings, startTime, endTime }) {
  const processed = count(timings?.prompt_n);
  const cached = count(timings?.cache_n) ?? 0;
  const promptTokens = count(usage?.prompt_tokens) ?? (processed === null ? null : count(processed + cached));
  const completionTokens = count(usage?.completion_tokens) ?? count(timings?.predicted_n);
  const totalTokens = count(usage?.total_tokens) ?? (promptTokens !== null && completionTokens !== null ? count(promptTokens + completionTokens) : null);
  const { cached: cachedTokens, created: cacheCreationTokens } = extractCacheTokens(usage, timings);
  const reasoningTokens = extractReasoningTokens(usage, timings);
  // Visible output is derived only when the provider separated reasoning from
  // the same completion counter. Otherwise it stays unknown rather than
  // mislabelling all output as visible.
  const visibleCompletionTokens = completionTokens !== null && reasoningTokens !== null
    ? count(completionTokens - reasoningTokens) : null;
  const time = Math.max(0, (endTime - startTime) / 1000);
  const milliseconds = number(timings?.predicted_ms);
  const reportedRate = number(timings?.predicted_per_second);
  const generationTime = milliseconds !== null ? milliseconds / 1000 :
    completionTokens !== null && reportedRate > 0 ? completionTokens / reportedRate : null;
  const tokensPerSecond = generationTime > 0 && completionTokens !== null ? completionTokens / generationTime :
    reportedRate ?? (time > 0 && completionTokens !== null ? completionTokens / time : null);
  return { startTime, endTime, time, promptTokens, completionTokens, totalTokens, tokensPerSecond,
    cachedTokens, cacheCreationTokens, reasoningTokens, visibleCompletionTokens,
    reasoningCoverage: reasoningTokens === null ? 'unreported' : 'measured',
    ...(generationTime !== null ? { generationTime } : {}) };
}

export function turnPromptTelemetry(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    return { lastPromptTokens: null, peakPromptTokens: null, peakRequestIndex: null,
      promptRequests: 0, promptCoverage: 'none', lastCachedTokens: null, lastCacheCreationTokens: null };
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
  };
}

export function mergePhaseStats(phases, startTime) {
  const final = phases.at(-1);
  const telemetry = turnPromptTelemetry(phases);
  // Do not let an unreported tool phase erase the final answer's valid stats,
  // or label incomplete counts as totals for the entire turn.
  if (phases.length > 1 && phases.some(phase => phase.promptTokens === null || phase.completionTokens === null || phase.totalTokens === null)) {
    return { ...final, ...telemetry, scope: 'final' };
  }
  const sum = key => phases.every(phase => phase[key] !== null) ? count(phases.reduce((total, phase) => total + phase[key], 0)) : null;
  const promptTokens = sum('promptTokens'), completionTokens = sum('completionTokens'), totalTokens = sum('totalTokens');
  // Cache counters are optional per provider: sum only when every phase
  // reported them, otherwise keep the last observed value for display.
  const cachedTokens = sum('cachedTokens') ?? count(final.cachedTokens);
  const cacheCreationTokens = sum('cacheCreationTokens') ?? count(final.cacheCreationTokens);
  // Reasoning/visible counters follow the cache rule: sum only when every
  // phase reported them, otherwise keep the last observed measured value.
  const reasoningTokens = sum('reasoningTokens') ?? count(final.reasoningTokens);
  const visibleCompletionTokens = sum('visibleCompletionTokens') ?? count(final.visibleCompletionTokens);
  const endTime = final.endTime;
  const time = Math.max(0, (endTime - startTime) / 1000);
  const generationTime = phases.every(phase => phase.generationTime != null)
    ? phases.reduce((total, phase) => total + phase.generationTime, 0) : null;
  const tokensPerSecond = generationTime > 0 && completionTokens !== null ? completionTokens / generationTime :
    phases.length === 1 ? final.tokensPerSecond : time > 0 && completionTokens !== null ? completionTokens / time : null;
  return { startTime, endTime, time, promptTokens, completionTokens, totalTokens, tokensPerSecond, ...telemetry, scope: 'all',
    cachedTokens, cacheCreationTokens, reasoningTokens, visibleCompletionTokens,
    reasoningCoverage: reasoningTokens === null ? 'unreported' : 'measured',
    ...(generationTime !== null ? { generationTime } : {}) };
}

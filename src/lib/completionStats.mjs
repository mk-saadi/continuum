const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// A stream may split statistics across its stop and usage-only chunks. Nulls
// and empty trailers must not erase counters already reported in this phase.
export function mergeMetrics(previous, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return previous;
  const valid = Object.entries(incoming).filter(([, value]) => number(value) !== null);
  return valid.length ? { ...previous, ...Object.fromEntries(valid) } : previous;
}

export function phaseStats({ usage, timings, startTime, endTime }) {
  const processed = count(timings?.prompt_n);
  const cached = count(timings?.cache_n) ?? 0;
  const promptTokens = count(usage?.prompt_tokens) ?? (processed === null ? null : count(processed + cached));
  const completionTokens = count(usage?.completion_tokens) ?? count(timings?.predicted_n);
  const totalTokens = count(usage?.total_tokens) ?? (promptTokens !== null && completionTokens !== null ? count(promptTokens + completionTokens) : null);
  const time = Math.max(0, (endTime - startTime) / 1000);
  const milliseconds = number(timings?.predicted_ms);
  const reportedRate = number(timings?.predicted_per_second);
  const generationTime = milliseconds !== null ? milliseconds / 1000 :
    completionTokens !== null && reportedRate > 0 ? completionTokens / reportedRate : null;
  const tokensPerSecond = generationTime > 0 && completionTokens !== null ? completionTokens / generationTime :
    reportedRate ?? (time > 0 && completionTokens !== null ? completionTokens / time : null);
  return { startTime, endTime, time, promptTokens, completionTokens, totalTokens, tokensPerSecond,
    ...(generationTime !== null ? { generationTime } : {}) };
}

export function mergePhaseStats(phases, startTime) {
  const final = phases.at(-1);
  // Do not let an unreported tool phase erase the final answer's valid stats,
  // or label incomplete counts as totals for the entire turn.
  if (phases.length > 1 && phases.some(phase => phase.promptTokens === null || phase.completionTokens === null || phase.totalTokens === null)) {
    return { ...final, scope: 'final' };
  }
  const sum = key => phases.every(phase => phase[key] !== null) ? count(phases.reduce((total, phase) => total + phase[key], 0)) : null;
  const promptTokens = sum('promptTokens'), completionTokens = sum('completionTokens'), totalTokens = sum('totalTokens');
  const endTime = final.endTime;
  const time = Math.max(0, (endTime - startTime) / 1000);
  const generationTime = phases.every(phase => phase.generationTime != null)
    ? phases.reduce((total, phase) => total + phase.generationTime, 0) : null;
  const tokensPerSecond = generationTime > 0 && completionTokens !== null ? completionTokens / generationTime :
    phases.length === 1 ? final.tokensPerSecond : time > 0 && completionTokens !== null ? completionTokens / time : null;
  return { startTime, endTime, time, promptTokens, completionTokens, totalTokens, tokensPerSecond, scope: 'all',
    ...(generationTime !== null ? { generationTime } : {}) };
}

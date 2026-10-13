// Display only runtime accounting; never infer measured zero from absent usage.
const count = value => Number.isFinite(value) ? value.toLocaleString('en-US') : 'unavailable';
export function subagentUsageLines(transcript) {
  const a = transcript.accounting;
  if (!a) return [
    `Reported input tokens: ${count(transcript.usage?.prompt_tokens)}`,
    `Reported output tokens: ${count(transcript.usage?.completion_tokens)}`,
    'Effective limits and usage coverage unavailable.',
  ];
  const e = a.effective ?? {};
  return [
    `Child tool calls: ${count(a.toolCalls)} / ${count(e.maxToolCalls)}; blocked attempts: ${count(a.blockedCalls)}`,
    `Child model requests: ${count(a.turns)} / ${count(e.maxTurns)}`,
    `Parent-run tool calls (shared snapshot): ${count(a.aggregateToolCalls)} / ${count(a.aggregateLimit)}`,
    `Child input tokens: ${count(a.inputTokens)} / ${count(e.inputBudget)} (${a.inputCoverage ?? 'unavailable'})`,
    `Child output tokens accounted: ${count(a.outputTokens)} / ${count(e.outputBudget)} (${a.outputCoverage ?? 'unavailable'}); measured: ${count(a.outputMeasured)}; reserved: ${count(a.outputReserved)}`,
    ...(a.finalizationAttempted ? [`Reporting attempted${a.finalizationStopReason ? `; stopped: ${a.finalizationStopReason}` : ''}.`] : []),
  ];
}
export function subagentResultTitle(status) {
  return status === 'completed' ? 'Final answer' : status === 'partial' ? 'Partial findings' : 'Returned output';
}

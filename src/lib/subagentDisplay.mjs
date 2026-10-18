// Display only runtime accounting; never infer measured zero from absent usage.
const count = value => Number.isFinite(value) ? value.toLocaleString('en-US') : 'unavailable';
// A resolved limit of null is the explicit "no numeric ceiling" budget; show
// it as unbounded rather than as missing data.
const limit = value => value === null ? 'unbounded' : count(value);
const LIMIT_REASONS = new Set(['tool_limit', 'turn_limit', 'aggregate_tool_limit']);
const TIMEOUT_REASONS = new Set(['timed_out', 'request_timeout']);
const SETTINGS_HINT = 'Settings → Agents & Skills → Sub-agent execution budgets → Custom hard limits';
export function subagentLimitNotice(transcript) {
  const stopReason = transcript?.stopReason;
  if (TIMEOUT_REASONS.has(stopReason)) {
    if (stopReason === 'request_timeout')
      return `Stopped because a model request exceeded its timeout. Raise or clear the model-request timeout in ${SETTINGS_HINT}.`;
    return `Stopped because the child execution deadline elapsed before the task finished. Raise or clear the execution deadline in ${SETTINGS_HINT}.`;
  }
  if (!LIMIT_REASONS.has(stopReason)) return null;
  const a = transcript.accounting ?? {};
  const e = a.effective ?? {};
  if (stopReason === 'tool_limit')
    return `Hit tool-call limit (${count(a.toolCalls)} / ${limit(e.maxToolCalls)}). Effective limit is ${limit(e.maxToolCalls)} per child; raise it in ${SETTINGS_HINT}.`;
  if (stopReason === 'turn_limit')
    return `Hit model-request limit (${count(a.turns)} / ${limit(e.maxTurns)}). Effective limit is ${limit(e.maxTurns)} per child; raise it in ${SETTINGS_HINT}.`;
  return `Hit parent-run limit (${count(a.aggregateToolCalls)} / ${limit(a.aggregateLimit)}). The parent run shares ${limit(a.aggregateLimit)} calls across children; raise it in ${SETTINGS_HINT}.`;
}
export function subagentUsageLines(transcript) {
  const a = transcript.accounting;
  if (!a) return [
    `Reported input tokens: ${count(transcript.usage?.prompt_tokens)}`,
    `Reported output tokens: ${count(transcript.usage?.completion_tokens)}`,
    'Effective limits and usage coverage unavailable.',
  ];
  const e = a.effective ?? {};
  return [
    `Child tool calls: ${count(a.toolCalls)} / ${limit(e.maxToolCalls)}; blocked attempts: ${count(a.blockedCalls)}`,
    `Child model requests: ${count(a.turns)} / ${limit(e.maxTurns)}`,
    `Parent-run tool calls (shared snapshot): ${count(a.aggregateToolCalls)} / ${limit(a.aggregateLimit)}`,
    `Child input tokens: ${count(a.inputTokens)} / ${limit(e.inputBudget)} (${a.inputCoverage ?? 'unavailable'})`,
    `Child output tokens accounted: ${count(a.outputTokens)} / ${limit(e.outputBudget)} (${a.outputCoverage ?? 'unavailable'}); measured: ${count(a.outputMeasured)}; reserved: ${count(a.outputReserved)}`,
    ...(a.finalizationAttempted ? [`Reporting attempted${a.finalizationStopReason ? `; stopped: ${a.finalizationStopReason}` : ''}.`] : []),
  ];
}
export function subagentResultTitle(status) {
  return status === 'completed' ? 'Final answer'
    : status === 'partial' ? 'Partial findings'
    : status === 'timed_out' ? 'Timed-out findings'
    : 'Returned output';
}

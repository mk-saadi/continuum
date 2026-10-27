// Pure formatting helpers for the context-usage header. Kept free of React
// so token-label behavior is directly testable in plain node.
export const compactTokenCount = (value) =>
	value === null || value === undefined
		? "—"
		: value >= 1000
			? `${(value / 1000).toFixed(1)}k`
			: `${value}`;

export const fullTokenCount = (value) =>
	value === null || value === undefined ? "—" : value.toLocaleString();

export function contextMethodLabel(method, confidence) {
	if (method === "server-template-tokenizer")
		return "measured with the model tokenizer";
	if (method === "provider-usage") return "provider-reported input";
  if (confidence === "measured") return "measured request input";
	if (method === "approximate-full-request") return "approximate (tokenizer unavailable)";
	if (method === "legacy-estimate") return "estimated (chars/4 fallback)";
	if (!method) return "unavailable";
	return method;
}

export function buildContextLabel({ total, limit, error, isCloud }) {
	const label =
		limit === null
			? isCloud
				? "Cloud context"
				: "Context: Not Loaded"
			: error
				? "Context unavailable"
				: `Context: ${compactTokenCount(total)} / ${compactTokenCount(limit)}`;
	const fullLabel =
		limit === null || error
			? label
			: `Context: ${fullTokenCount(total)} / ${fullTokenCount(limit)} tokens`;
	return { label, fullLabel };
}

export function buildContextTooltip({ total, limit, error, isCloud, method, confidence, live, persisted, budgetContract, prepared }) {
	const { fullLabel } = buildContextLabel({ total, limit, error, isCloud });
	const lines = [fullLabel];
  if (prepared !== undefined) lines.push(`Prepared next request: ${fullTokenCount(prepared)} tokens`);
	if (budgetContract) {
		for (const [label, value] of [
			['Configured total', budgetContract.configuredContextTokens],
			['Runtime per-request capacity', budgetContract.runtimeContextTokens],
            ['Runtime parallel slots', budgetContract.runtimeSlots],
            ['Provider advertised context', budgetContract.advertisedContextTokens],
			['Reserved output', budgetContract.reservedOutputTokens],
			['Safety margin', budgetContract.reservedSafetyTokens],
			['Usable input', budgetContract.usableInputTokens],
			['Compaction threshold (90%)', budgetContract.autoCompactionTriggerTokens],
		]) lines.push(`${label}: ${fullTokenCount(value)}`);
		if (budgetContract.provider === 'local') lines.push('Configured context is a total shared across concurrent predictions; runtime capacity is the verified per-request limit.');
		lines.push(`Capacity: ${budgetContract.capacityMethod} (${budgetContract.capacityConfidence})`);
        lines.push('Prepared request projection; dispatch may change tool rounds, media shape and provider fields. Final wire guard enforces fit.');
	}
	if (method !== undefined || confidence !== undefined) {
		lines.push(
			`Current prompt: ${fullTokenCount(total)} tokens (${contextMethodLabel(method, confidence)})`,
		);
	} else if (total !== undefined) {
		lines.push(`Current context: ${fullTokenCount(total)} tokens (estimated)`);
	}
	const active = live?.telemetry ?? persisted;
	if (live) {
		lines.push(
			`Live turn: request ${live.requestSequence ?? live.round ?? live.telemetry?.promptRequests ?? "?"} ${live.isEstimate ? "estimated" : "measured"} ${fullTokenCount(live.promptTokens)} prompt tokens, peak ${fullTokenCount(live.telemetry?.peakPromptTokens)}`,
		);
	} else if (persisted) {
		const coverageNote =
			active?.promptCoverage === "partial"
				? " (partial telemetry: some requests did not report usage)"
				: active?.promptCoverage === "none"
					? " (no server usage reported)"
					: "";
		lines.push(
			`Last turn: ${persisted.isEstimate ? "estimated" : "actual"} ${fullTokenCount(persisted.lastPromptTokens)} prompt tokens, peak ${fullTokenCount(persisted.peakPromptTokens)}${persisted.peakRequestIndex ? ` (request ${persisted.peakRequestIndex} of ${persisted.promptRequests ?? "?"})` : ""}${coverageNote}`,
		);
	} else {
		lines.push("No server request telemetry yet");
	}
	lines.push("Cumulative inference work across all requests is shown per message, not here");
	return lines.join("\n");
}

// Dispatch measurements and completion usage are per request, never cumulative.
export function updateRequestTelemetry(previous, event) {
  if (previous?.runId && event.runId === previous.runId && (event.requestSequence ?? event.round) < (previous.requestSequence ?? previous.round)) return previous;
  const sameRequest = previous?.runId === event.runId && (previous?.requestSequence ?? previous?.round) === (event.requestSequence ?? event.round);
  const promptTokens = event.promptTokens ?? (sameRequest ? previous?.promptTokens : null);
  const peak = Math.max(previous?.runId === event.runId ? previous?.telemetry?.peakPromptTokens ?? 0 : 0,
    event.telemetry?.peakPromptTokens ?? 0, promptTokens ?? 0);
  return { ...(sameRequest ? previous : {}), ...event, promptTokens,
    budgetContract: event.budgetContract ?? (sameRequest ? previous?.budgetContract : null),
    timestamp: event.timestamp ?? new Date().toISOString(),
    method: event.method ?? (event.promptTokens != null ? 'provider-usage' : sameRequest ? previous?.method : null) ?? 'unavailable',
    isEstimate: event.dispatched ? event.isEstimate : event.promptTokens == null ? previous?.isEstimate : false,
    telemetry: { ...event.telemetry, peakPromptTokens: peak || null } };
}
export function selectContextOccupancy({ prepared, live, sessionId, modelId, limit }) {
  const valid = live && live.sessionId === sessionId && (!live.modelId || live.modelId === modelId)
    && Number.isSafeInteger(live.promptTokens)
    && (!live.budgetContract || live.budgetContract.usableInputTokens === limit);
  return { tokens: valid ? live.promptTokens : prepared, live: !!valid };
}

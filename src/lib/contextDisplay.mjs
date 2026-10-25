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
	if (method === "server-template-tokenizer" || confidence === "measured")
		return "measured with the model tokenizer";
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

export function buildContextTooltip({ total, limit, error, isCloud, method, confidence, live, persisted, budgetContract }) {
	const { fullLabel } = buildContextLabel({ total, limit, error, isCloud });
	const lines = [fullLabel];
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
			`Live turn: request ${live.telemetry?.promptRequests ?? live.round ?? "?"} actual ${fullTokenCount(live.promptTokens)} prompt tokens, peak ${fullTokenCount(live.telemetry?.peakPromptTokens)}`,
		);
	} else if (persisted) {
		const coverageNote =
			active?.promptCoverage === "partial"
				? " (partial telemetry: some requests did not report usage)"
				: active?.promptCoverage === "none"
					? " (no server usage reported)"
					: "";
		lines.push(
			`Last turn: actual ${fullTokenCount(persisted.lastPromptTokens)} prompt tokens, peak ${fullTokenCount(persisted.peakPromptTokens)}${persisted.peakRequestIndex ? ` (request ${persisted.peakRequestIndex} of ${persisted.promptRequests ?? "?"})` : ""}${coverageNote}`,
		);
	} else {
		lines.push("No server request telemetry yet");
	}
	lines.push("Cumulative inference work across all requests is shown per message, not here");
	return lines.join("\n");
}

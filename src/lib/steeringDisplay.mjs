// Phase 2.1 steering status helpers shared by the chat interface and tests.
//
// Events deliberately omit the instruction text on later transitions, so a
// merge must never erase content already known from the submit response or the
// persisted history read. Once a run has ended, delivered/withdrawn rows are
// transient acknowledgements and are hidden; only undelivered rows remain so a
// failure is never silently discarded.

export const STEERING_STATE_LABELS = {
	queued: "Queued",
	claimed: "Delivering…",
	delivered: "Delivered",
	undelivered: "Not delivered",
	cancelled: "Withdrawn",
};

export const STEERING_STATE_RANK = {
	queued: 0,
	claimed: 1,
	delivered: 2,
	undelivered: 2,
	cancelled: 2,
};

export function mergeSteeringItem(items, update) {
	if (!update?.id) return items;
	const index = items.findIndex((item) => item.id === update.id);
	if (index === -1) return [...items, update];
	const next = [...items];
	next[index] = {
		...items[index],
		...update,
		content: update.content || items[index].content,
	};
	return next;
}

// A persisted history read can resolve after a live event for the same row.
// Never let an older snapshot move a terminal state back to queued/claimed.
export function mergeSteeringHistory(previous, incoming) {
	const byId = new Map(previous.map((item) => [item.id, item]));
	for (const item of incoming) {
		if (!item?.id) continue;
		const existing = byId.get(item.id);
		if (!existing) {
			byId.set(item.id, item);
			continue;
		}
		const existingRank = STEERING_STATE_RANK[existing.state] ?? 0;
		const incomingRank = STEERING_STATE_RANK[item.state] ?? 0;
		byId.set(
			item.id,
			incomingRank >= existingRank
				? { ...existing, ...item, content: item.content || existing.content }
				: { ...item, ...existing, content: existing.content || item.content },
		);
	}
	return [...byId.values()].sort((left, right) => {
		const order = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
		return order !== 0 ? order : String(left.id).localeCompare(String(right.id));
	});
}

// `activeRunId` is null once the run has finished. In that state a delivered
// instruction is no longer useful above the composer, but an undelivered one is
// a truthful failure report and must stay visible.
export function visibleSteeringForRun(items, activeRunId) {
	const runId = activeRunId ?? items.at(-1)?.runId ?? null;
	if (!runId) return [];
	const forRun = items.filter((item) => item.runId === runId);
	return activeRunId ? forRun : forRun.filter((item) => item.state === "undelivered");
}

// Delivered instructions are rendered underneath the reply they helped shape.
// Undelivered/withdrawn instructions are intentionally excluded: they were not
// part of the task, and the status panel already reports failures honestly.
export function steeringPromptsForRun(items, runId) {
	if (!runId) return [];
	return items
		.filter(
			(item) =>
				item?.runId === runId &&
				item.state === "delivered" &&
				typeof item.content === "string" &&
				item.content.trim(),
		)
		.sort((left, right) => {
			const order = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
			return order !== 0 ? order : String(left.id).localeCompare(String(right.id));
		});
}

// A reply can hold several regeneration variants, each produced by a different
// run. Prefer the active variant's run so switching variants never shows another
// run's additional prompts. Temporary live replies have no variants yet and use
// the message-level run id.
export function steeringRunIdForMessage(message) {
	if (!message || message.role !== "assistant") return null;
	const variants = Array.isArray(message.variants) ? message.variants : null;
	if (variants?.length) {
		const active = variants[message.active_variant_index ?? 0] ?? variants[0];
		return active?.run_id ?? null;
	}
	return message.run_id ?? null;
}

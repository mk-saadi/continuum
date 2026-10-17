// Canonical-history search for the in-chat find bar.
//
// Phase 2 paginates the transcript, so the DOM only ever contains the visible
// window; searching the rendered DOM would miss older messages. This module
// derives matches from the CANONICAL message collection instead — the same
// objects the transcript renders (and that inference/persistence use), never a
// copy. It only reads: rendering, history and inference stay untouched.

import { activeReplyVariant } from "./messageIdentity.mjs";
import { MAX_FIND_MARKS } from "./chatFind.mjs";

function append(parts, value) {
	if (typeof value === "string" && value) parts.push(value);
}

// Tool arguments/results are frequently stored as objects; search the same
// text a user can read (message, path, url, query). The serialized form is a
// fallback only, so a value that exposes named fields is not counted twice.
function appendArguments(parts, value) {
	if (value == null) return;
	if (typeof value === "string") {
		append(parts, value);
		return;
	}
	if (typeof value !== "object") return;
	const before = parts.length;
	append(parts, value.text);
	append(parts, value.path);
	append(parts, value.url);
	append(parts, value.query);
	append(parts, value.command);
	if (parts.length === before) {
		try {
			append(parts, JSON.stringify(value));
		} catch {
			/* Cyclic or exotic values simply contribute nothing. */
		}
	}
}

function appendToolCall(parts, call) {
	if (!call || typeof call !== "object") {
		append(parts, call);
		return;
	}
	append(parts, call.serverName);
	append(parts, call.toolName);
	append(parts, call.name);
	append(parts, call.function?.name);
	append(parts, call.status);
	append(parts, call.error);
	appendArguments(parts, call.arguments);
	appendArguments(parts, call.args);
	appendArguments(parts, call.result);
	appendArguments(parts, call.output);
}

function appendStep(parts, step) {
	if (!step || typeof step !== "object") return;
	append(parts, step.toolName);
	append(parts, step.name);
	append(parts, step.content);
	append(parts, step.text);
	append(parts, step.summary);
	append(parts, step.error);
	appendArguments(parts, step.args);
	appendArguments(parts, step.arguments);
	appendArguments(parts, step.result);
	appendArguments(parts, step.output);
}

// Searchable text for one message: user/assistant content plus the assistant
// extras the transcript can display (reply variants, tool calls, execution
// steps) and attachment names. Parts are newline-joined so a query cannot span
// two unrelated fields, mirroring the rendered-text-node behaviour.
export function messageSearchText(message) {
	if (!message || typeof message !== "object") return "";
	const variant = activeReplyVariant(message);
	const parts = [];
	append(parts, variant.content);
	append(parts, variant.thinking);
	append(parts, variant.thinkingText);
	const toolCalls = variant.tool_calls ?? variant.toolCalls;
	if (Array.isArray(toolCalls)) for (const call of toolCalls) appendToolCall(parts, call);
	const steps = variant.executionSteps;
	if (Array.isArray(steps)) for (const step of steps) appendStep(parts, step);
	if (Array.isArray(message.attachments)) {
		for (const attachment of message.attachments) {
			if (attachment && typeof attachment === "object") append(parts, attachment.name);
		}
	}
	return parts.join("\n");
}

// Index of the active result, resolved by stable identity so the current
// position survives recomputation. If the tracked result is gone (its message
// was edited, deleted or regenerated, or its content changed), fall back to the
// clamped index and never point at a stale position.
export function resolveActiveMatchIndex(matches, target, fallback = 0) {
	const total = Array.isArray(matches) ? matches.length : 0;
	if (total === 0) return 0;
	if (target) {
		const found = matches.findIndex(
			(match) => match.messageId === target.messageId && match.occurrence === target.occurrence,
		);
		if (found !== -1) return found;
	}
	return Math.min(Math.max(fallback, 0), total - 1);
}

// Ordered matches across the canonical collection: message order, then
// occurrence order within a message — the transcript's top-to-bottom reading
// order. Each match exposes the stable message id and the occurrence index so
// navigation never depends on a position in the rendered slice. Case-
// insensitive, capped at MAX_FIND_MARKS to bound work.
export function findMessageMatches(messages, query, limit = MAX_FIND_MARKS) {
	const needle = String(query ?? "").trim();
	if (!needle || !Array.isArray(messages)) return [];
	const lowerNeedle = needle.toLowerCase();
	const matches = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const text = messageSearchText(message);
		if (!text) continue;
		const lower = text.toLowerCase();
		let occurrence = 0;
		let position = lower.indexOf(lowerNeedle);
		while (position !== -1) {
			matches.push({
				messageId: message.id ?? null,
				occurrence,
				index: position,
				length: needle.length,
			});
			occurrence += 1;
			if (matches.length >= limit) return matches;
			position = lower.indexOf(lowerNeedle, position + needle.length);
		}
	}
	return matches;
}

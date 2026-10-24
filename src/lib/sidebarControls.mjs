import { toolDisplayName } from './executionEvents.mjs';

// Pure sidebar helpers shared by RightSidebar.jsx and its tests.
// No JSX here so tests can import this module directly.

export function getNextTabIndex(key, index, length) {
	if (key === "Home") return 0;
	if (key === "End") return length - 1;
	if (key === "ArrowRight") return (index + 1) % length;
	if (key === "ArrowLeft") return (index + length - 1) % length;
	return null;
}

export function isPromptDirty(prompt, savedPrompt) {
	return (prompt ?? "") !== (savedPrompt ?? "");
}

// Authoritative sidebar mode: a chat bound to a project (via its session
// row's project_id or its tab binding) is a workspace conversation,
// otherwise it is casual chat. Never derived from sidebar visibility or tab
// state.
export function getSidebarMode(chatProjectId) {
	return chatProjectId != null ? "workspace" : "casual";
}

const SUB_AGENT_TOOL_NAMES = new Set([
	"spawn_sub_agent",
	"delegate_task",
	"extract_web_page_data",
]);

function stepsOf(message) {
	if (!message || message.role !== "assistant") return [];
	return message.executionSteps ?? [];
}

export function extractToolCalls(messages) {
	const calls = [];
	for (const message of messages ?? []) {
		for (const step of stepsOf(message)) {
			if (step?.type !== "tool_call") continue;
			calls.push({
				id: step.id ?? `${message.id ?? "message"}:${calls.length}`,
				toolName: step.toolName ?? "tool",
				displayName: toolDisplayName(step),
				status: step.status ?? "unknown",
				messageId: message.id ?? null,
			});
		}
	}
	return calls;
}

export function extractSubagentRuns(messages) {
	return extractToolCalls(messages).filter((call) => SUB_AGENT_TOOL_NAMES.has(call.toolName));
}

export function summarizeActivity(input = {}) {
	const {
		streaming = false,
		loading = false,
		toolApprovals = [],
		pendingQuestions = {},
		toolLimit = null,
		pausedLoop = null,
		messages = [],
		indexing = null,
	} = input;
	const questionCount = Object.keys(pendingQuestions ?? {}).length;
	const calls = extractToolCalls(messages);
	const stats = { total: calls.length, running: 0, complete: 0, error: 0, cancelled: 0 };
	for (const call of calls) {
		if (["pending", "preparing", "running"].includes(call.status)) stats.running += 1;
		else if (call.status === "complete") stats.complete += 1;
		else if (call.status === "error") stats.error += 1;
		else if (call.status === "cancelled") stats.cancelled += 1;
	}
	let status = "idle";
	let statusLabel = "Idle";
	if (pausedLoop) {
		status = "paused";
		statusLabel = "Paused: turn limit reached";
	} else if (toolLimit) {
		status = "paused";
		statusLabel = "Paused: tool limit reached";
	} else if (toolApprovals.length || questionCount) {
		status = "awaiting_approval";
		statusLabel =
			questionCount && !toolApprovals.length ? "Question for you" : "Awaiting approval";
	} else if (indexing) {
		status = "working";
		statusLabel = "Indexing files";
	} else if (streaming || loading) {
		status = "generating";
		statusLabel = "Generating";
	} else if (stats.running) {
		status = "working";
		statusLabel = "Tools running";
	}
	return {
		status,
		statusLabel,
		approvalCount: toolApprovals.length,
		questionCount,
		hasLimitPause: toolLimit != null,
		hasLoopPause: pausedLoop != null,
		indexing: indexing ?? null,
		toolStats: stats,
		recentTools: calls.slice(-8).reverse(),
	};
}

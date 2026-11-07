import React from "react";
import { FiChevronDown, FiLoader, FiActivity } from "react-icons/fi";
import { useRowUiState } from "../../hooks/useRowUiState.js";
import { classifyStep, toolDisplayName } from "../../lib/executionEvents.mjs";
import ThoughtBlock from "../ThoughtBlock.jsx";
import ToolEventCard from "./ToolEventCard.jsx";

// Keep the transcript available without letting execution logs dominate a reply.
// Interactive questions and approvals remain outside this disclosure.
export default function CasualActivity({
	stateKey,
	steps,
	toolCalls,
	thinking,
	thinkingDuration,
	streaming,
	interrupted,
	renderStep,
	liveText,
}) {
	const [expanded, setExpanded] = useRowUiState(`casual-activity:${stateKey}`, false);
	const timeline = steps?.length
		? steps
		: [
				...(thinking
					? [
							{
								type: "thought",
								content: thinking,
								durationMs: thinkingDuration == null ? undefined : thinkingDuration * 1000,
							},
						]
					: []),
				...(toolCalls || []).map((call) => ({
					...call,
					type: "tool_call",
					toolName: call.toolName || call.function?.name,
				})),
			];
	const visible = (step) =>
		(step.type === "tool_call" &&
			(["ask_user", "propose_skill"].includes(step.toolName) || classifyStep(step).key === "blocked"));
	const activity = timeline.filter((step) => !visible(step));
	const tools = activity.filter((step) => step.type === "tool_call");
	const failed = tools.filter((step) => classifyStep(step).key === "failed").length;
	const latest = activity.at(-1);
	const label = streaming
		? latest?.type === "tool_call" && classifyStep(latest).key === "running"
			? `${toolDisplayName(latest)}…`
			: "Working…"
		: interrupted
			? "Activity interrupted"
			: "Activity";
	return (
		<>
			{(activity.length > 0 || liveText) && (
				<details
					open={expanded}
					onToggle={(event) => setExpanded(event.currentTarget.open)}
					className="group/casual-activity mb-3 min-w-0 text-xs text-[var(--text-muted)]"
					aria-label="Reply activity"
				>
					<summary className="flex w-fit max-w-full cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 ui-radius-control py-1.5 focus-visible:outline-2 focus-visible:outline-[var(--accent)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
						{streaming ? (
							<FiLoader
								aria-hidden="true"
								className="shrink-0 animate-spin motion-reduce:animate-none"
							/>
						) : (
							<FiActivity
								aria-hidden="true"
								className="shrink-0"
							/>
						)}
						<span role="status">{label}</span>
						{tools.length > 0 && (
							<span>
								· {tools.length} {tools.length === 1 ? "action" : "actions"}
							</span>
						)}
						{failed > 0 && <span>· {failed} unsuccessful</span>}
						<span className="text-[var(--text-secondary)]">
							{expanded ? "Hide details" : "View details"}
						</span>
						<FiChevronDown
							aria-hidden="true"
							className="shrink-0 -rotate-90 transition-transform group-open/casual-activity:rotate-0"
						/>
					</summary>
					{expanded && (
						<div
							className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto overscroll-contain border-l border-[var(--subtle-border)] pl-3 pr-1"
							aria-label="Activity details"
						>
							{failed > 0 && (
								<p className="py-1 leading-relaxed">
									Some actions didn’t complete. Expand an action to inspect its error and
									details.
								</p>
							)}
							{activity.map((step, index) =>
								step.type === "text" ? renderStep(step, index) : step.type === "thought" ? (
									<ThoughtBlock
										key={step.id ?? index}
										content={step.content}
										durationMs={step.durationMs}
										compact
									/>
								) : (
									<ToolEventCard
										key={step.id ?? index}
										step={step}
										compact
									/>
								),
							)}
							{liveText && <div aria-label="Live activity text">{liveText}</div>}
						</div>
					)}
				</details>
			)}
			{timeline.filter(visible).length > 0 && (
				<div className="mb-3 space-y-2">{timeline.filter(visible).map(renderStep)}</div>
			)}
		</>
	);
}

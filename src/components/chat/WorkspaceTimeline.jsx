import React, { useState } from "react";
import ChatMessage from "../ChatMessage.jsx";
import AssistantAvatar from "../AssistantAvatar.jsx";
import MessageActions from "../MessageActions.jsx";
import ToolEventCard from "./ToolEventCard.jsx";
import TurnOutcomes from "./TurnOutcomes.jsx";
import { splitStages, summarizeStage } from "../../lib/executionEvents.mjs";
import { assistantLabel, formatModelName } from "../../lib/messageIdentity.mjs";
import { readSkillDecision } from "./PendingInteractions.jsx";

// Chronological, terminal-inspired execution timeline for Workspace mode.
//
// Renders the SAME persisted messages/executionSteps as Casual Chat, grouped
// per assistant run: run header (authoritative agent/model attribution),
// execution stages split at recorded thought boundaries, compact event rows
// in original order, then the final assistant response. Stage summaries count
// only what the recorded events contain; missing runtime fields (durations,
// counts) are omitted, never synthesized.
export default function WorkspaceTimeline({
	messages,
	streamBuffer,
	activeStreamMessageId,
	onStreamFrame,
	projectId,
	pendingQuestions = {},
	disabled = false,
	onSelectReplyVariant,
	// Authoritative attribution fallbacks (current selector). Persisted per-reply
	// fields on each message always win; these are used only for very old or
	// still-streaming replies that lack them.
	activeModelName = "",
	selectedModel = "",
	sessionAgent = null,
	avatarSettings = null,
	// Restored assistant/user message actions (same handlers as Casual Chat).
	onDelete,
	onBranch,
	onRegenerate,
	onStartEdit,
	onError,
	editing = null,
	editText = "",
	onEditChange,
	onCancelEdit,
	onSubmitEdit,
	lastMessageId = null,
}) {
	const list = Array.isArray(messages) ? messages : [];
	// Modest trailing padding so the final response rests above the composer
	// with breathing room. The composer sits below the scroll area (not over
	// it), so a large spacer would only show as empty whitespace. Live
	// auto-scroll still follows ChatInterface semantics (onStreamFrame only
	// scrolls while the user follows the output).
	return (
		<div
			aria-label="Workspace execution timeline"
			className="mx-auto flex w-full max-w-[860px] min-w-0 flex-col gap-7 pb-10"
		>
			{list.map((message, index) => {
				if (!message || typeof message !== "object") return null;
				if (message.role === "user") {
					return (
						<UserBlock
							key={message.id ?? `user-${index}`}
							message={message}
							disabled={disabled}
							editing={editing}
							editText={editText}
							onEditChange={onEditChange}
							onCancelEdit={onCancelEdit}
							onSubmitEdit={onSubmitEdit}
							onStartEdit={onStartEdit}
							onDelete={onDelete}
							onBranch={onBranch}
							onError={onError}
						/>
					);
				}
				if (message.role !== "assistant") return null;
				const isLast =
					lastMessageId != null ? message.id === lastMessageId : index === list.length - 1;
				return (
					<RunSection
						key={message.id ?? `assistant-${index}`}
						message={message}
						streamBuffer={
							message.streaming && activeStreamMessageId === message.id
								? streamBuffer
								: undefined
						}
						onStreamFrame={onStreamFrame}
						projectId={projectId}
						pendingQuestions={pendingQuestions}
						disabled={disabled}
						onSelectReplyVariant={onSelectReplyVariant}
						activeModelName={activeModelName}
						selectedModel={selectedModel}
						sessionAgent={sessionAgent}
						avatarSettings={avatarSettings}
						onDelete={onDelete}
						onBranch={onBranch}
						onRegenerate={onRegenerate}
						onError={onError}
						isLast={isLast}
					/>
				);
			})}
		</div>
	);
}

function activeVariantOf(message) {
	if (!message || message.role !== "assistant") return null;
	const index = message.active_variant_index ?? 0;
	if (Array.isArray(message.variants)) return message.variants[index] ?? null;
	return message;
}

function assistantTextOf(message) {
	const variant = activeVariantOf(message);
	const content = variant?.content ?? message.content;
	return typeof content === "string" ? content.trim() : "";
}

function stepsOf(message) {
	const variant = activeVariantOf(message);
	const source = variant && typeof variant === "object" ? variant : message;
	return Array.isArray(source?.executionSteps) ? source.executionSteps : [];
}

function statsOf(message) {
	return activeVariantOf(message)?.stats ?? message.stats ?? null;
}

function modelFieldsOf(message) {
	const variant = activeVariantOf(message) ?? {};
	const pick = (snake, camel) => {
		if (Object.hasOwn(message, snake)) return message[snake];
		if (Object.hasOwn(variant, snake)) return variant[snake];
		if (Object.hasOwn(message, camel)) return message[camel];
		if (Object.hasOwn(variant, camel)) return variant[camel];
		return null;
	};
	return {
		modelName: pick("model_name", "modelName"),
		modelId: pick("model_id", "modelId"),
		agentName: pick("agent_name", "agentName"),
		displayName:
			message.display_name ??
			message.displayName ??
			variant.display_name ??
			variant.displayName ??
			null,
	};
}

function formatDuration(stats) {
	const seconds = stats?.duration ?? stats?.time;
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s`;
}

function formatTokens(stats) {
	const total = stats?.total_tokens ?? stats?.totalTokens;
	const completion = stats?.completion_tokens ?? stats?.completionTokens;
	const value = total ?? completion;
	if (typeof value !== "number") return "";
	return `${value.toLocaleString()} tokens`;
}

function formatStageElapsed(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function RunHeader({
	message,
	activeModelName,
	selectedModel,
	sessionAgent,
	avatarSettings,
	eventCount,
	responseId,
}) {
	const label = assistantLabel(message, activeModelName || selectedModel);
	const fields = modelFieldsOf(message);
	const readable = formatModelName(fields.modelName) || formatModelName(activeModelName || selectedModel);
	const technical =
		typeof fields.modelId === "string" && fields.modelId.trim()
			? fields.modelId.trim()
			: typeof selectedModel === "string" && selectedModel
				? selectedModel
				: "";
	const showTechnical = technical && formatModelName(technical) !== readable;
	const streaming = !!message.streaming;
	const interrupted = message.status === "interrupted";
	const statusLabel = streaming ? "Generating" : interrupted ? "Interrupted" : "Completed";
	const avatarModelId = fields.modelId || selectedModel;
	const avatarUrl = sessionAgent?.avatar_url ?? null;
	const agentName =
		typeof fields.agentName === "string" && fields.agentName.trim() ? fields.agentName.trim() : null;

	function jumpToResponse() {
		if (!responseId) return;
		document.getElementById(responseId)?.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	return (
		<div
			className="flex min-w-0 items-start gap-2.5"
			aria-label="Workspace run attribution"
		>
			<span className="mt-1.5 flex shrink-0 items-center">
				{avatarSettings?.showAvatars !== false && avatarSettings ? (
					<AssistantAvatar
						sessionAvatarUrl={avatarUrl}
						settings={avatarSettings}
						modelId={avatarModelId}
					/>
				) : null}
			</span>
			<div className="min-w-0 flex-1">
				<p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
					<strong className="truncate text-sm text-[var(--text-primary)]">{label}</strong>
					{readable && readable !== label && (
						<span className="truncate text-xs text-[var(--text-secondary)]">{readable}</span>
					)}
					<span
						aria-label={`Run status: ${statusLabel}`}
						className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
							streaming
								? "bg-amber-400/10 text-amber-500"
								: interrupted
									? "bg-[var(--error)]/10 text-[var(--error)]"
									: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
						}`}
					>
						{statusLabel}
					</span>
					{responseId && eventCount > 4 && (
						<button
							type="button"
							onClick={jumpToResponse}
							className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-primary)]"
							aria-label="Jump to final response"
							title="Jump to final response"
						>
							Response ↓
						</button>
					)}
				</p>
				{(agentName && agentName !== label) || showTechnical ? (
					<p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-muted)]">
						{agentName && agentName !== label && (
							<span className="truncate">Agent: {agentName}</span>
						)}
						{showTechnical && (
							<span
								className="min-w-0 truncate font-mono"
								title={technical}
							>
								{technical}
							</span>
						)}
					</p>
				) : null}
			</div>
		</div>
	);
}

function RunSection({
	message,
	streamBuffer,
	onStreamFrame,
	projectId,
	pendingQuestions,
	disabled,
	onSelectReplyVariant,
	activeModelName,
	selectedModel,
	sessionAgent,
	avatarSettings,
	onDelete,
	onBranch,
	onRegenerate,
	onError,
	isLast,
}) {
	const steps = stepsOf(message);
	const text = assistantTextOf(message);
	const stats = statsOf(message);
	const hasMeta = message.status === "interrupted" || (message.variants?.length ?? 0) > 1 || !!stats;
	const showFinal = !!text || hasMeta || !!message.streaming;
	const stages = splitStages(steps);
	const eventCount = stages.reduce((sum, stage) => sum + stage.events.length, 0);
	const responseId = `workspace-response-${message.id ?? "pending"}`;

	return (
		<section
			aria-label="Workspace run"
			className="flex min-w-0 flex-col gap-2"
		>
			<RunHeader
				message={message}
				activeModelName={activeModelName}
				selectedModel={selectedModel}
				sessionAgent={sessionAgent}
				avatarSettings={avatarSettings}
				eventCount={eventCount}
				responseId={showFinal ? responseId : null}
			/>
			{stages.length > 0 && (
				<div
					className="flex min-w-0 flex-col gap-4"
					role="list"
					aria-label="Run execution stages"
				>
					{stages.map((stage) => (
						<StageSection
							key={stage.key}
							stage={stage}
							messageId={message.id}
							pendingQuestions={pendingQuestions}
							isStreaming={!!message.streaming}
						/>
					))}
				</div>
			)}
			{showFinal ? (
				<div
					id={responseId}
					className="group mt-1 min-w-0 scroll-mt-24 border-t border-[var(--subtle-border)] pt-3 select-text"
				>
					<ChatMessage
						message={message}
						streamBuffer={streamBuffer}
						onStreamFrame={onStreamFrame}
						projectId={projectId}
						pendingQuestions={pendingQuestions}
						showHeader={false}
						disabled={disabled}
						onSelectReplyVariant={onSelectReplyVariant}
						mode="workspace"
						interactive={false}
						hideSteps
						showTurnOutcomes={false}
					/>
					{(onDelete || onBranch || onRegenerate) && (
						<MessageActions
							message={message}
							disabled={disabled}
							onDelete={onDelete ? (id) => onDelete(id) : () => {}}
							onBranch={onBranch ? (id) => onBranch(id) : () => {}}
							onRegenerate={onRegenerate ? () => onRegenerate(message) : undefined}
							isLast={isLast}
							onEdit={() => {}}
							onError={onError ?? (() => {})}
						/>
					)}
					{!message.streaming && (
						<TurnOutcomes
							steps={steps}
							pendingQuestions={pendingQuestions}
						/>
					)}
				</div>
			) : (
				stages.length === 0 && (
					<p className="text-xs text-[var(--text-muted)]">Run produced no displayable output.</p>
				)
			)}
		</section>
	);
}

// One execution stage: tool calls in original order, optionally preceded by
// the thought recorded just before them. The thought is rendered as a
// standalone chronological entry above the group — never nested inside it —
// because the recording does not establish which call (if any) a thought
// explains: a thought may react to an earlier result, plan a retry, or muse
// mid-sequence. The header summarizes only recorded facts; the toggle
// collapses the tool events without losing them.
function StageSection({ stage, messageId, pendingQuestions, isStreaming }) {
	const [collapsed, setCollapsed] = useState(false);
	const summary = summarizeStage(stage);
	const thought = stage.thought;
	const elapsed = formatStageElapsed(summary.elapsedMs);
	const metaParts = [...summary.status];
	if (elapsed) metaParts.push(elapsed);

	if (stage.events.length === 0) {
		if (!thought?.content && typeof thought?.durationMs !== "number") return null;
		return (
			<StageThought
				thought={thought}
				standalone
			/>
		);
	}

	return (
		<div
			role="listitem"
			aria-label={summary.title}
			className="min-w-0"
		>
			{thought?.content && (
				<StageThought
					thought={thought}
					standalone
				/>
			)}
			<button
				type="button"
				aria-expanded={!collapsed}
				onClick={() => setCollapsed(!collapsed)}
				className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
			>
				<span
					aria-hidden="true"
					className={`shrink-0 text-[10px] text-[var(--text-muted)] transition-transform ${collapsed ? "" : "rotate-90"}`}
				>
					›
				</span>
				<span className="truncate text-xs text-[var(--text-secondary)]">{summary.title}</span>
				{summary.failed > 0 && (
					<span className="shrink-0 rounded bg-[var(--error)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--error)]">
						{summary.failed} failed
					</span>
				)}
				{summary.blocked > 0 && (
					<span className="shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
						needs approval
					</span>
				)}
				{summary.running > 0 && (
					<span className="shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
						running
					</span>
				)}
				{metaParts.length > 0 && (
					<span className="min-w-0 flex-1 truncate text-right text-[10px] tabular-nums text-[var(--text-muted)]">
						{metaParts.join(" · ")}
					</span>
				)}
			</button>
			{!collapsed && (
				<div className="flex min-w-0 flex-col">
					{stage.events.map((step) => {
						if (!step || typeof step !== "object") return null;
						if (step.toolName === "ask_user") {
							return (
								<QuestionRecord
									key={step.id}
									step={step}
									request={pendingQuestions?.[step.id]}
									live={!!pendingQuestions?.[step.id] || isStreaming}
								/>
							);
						}
						if (step.toolName === "propose_skill") {
							return (
								<SkillRecord
									key={step.id}
									step={step}
								/>
							);
						}
						return (
							<ToolEventCard
								key={step.id ?? `${messageId}:${step.toolName}`}
								step={step}
								timeline
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

// Standalone chronological thought entry. Content renders at full height
// and never poses as a primary result.
function StageThought({ thought, standalone = false }) {
	const seconds = typeof thought.durationMs === "number" ? thought.durationMs / 1000 : null;
	const duration =
		seconds !== null && Number.isFinite(seconds)
			? seconds < 60
				? `${seconds.toFixed(1)}s`
				: `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
			: "";
	if (!thought.content) {
		return (
			<p
				className={`min-w-0 text-xs tabular-nums text-[var(--text-muted)] ${standalone ? "" : "pl-5"}`}
			>
				Thought{duration && ` · ${duration}`}
			</p>
		);
	}
	return (
		<details
			className={`group/thought min-w-0 text-xs text-[var(--text-muted)] ${standalone ? "" : "pl-5"}`}
		>
			<summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded py-0.5 hover:text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
				<span aria-hidden="true">Thought</span>
				{duration && <span className="tabular-nums">· {duration}</span>}
			</summary>
			<div className="whitespace-pre-wrap break-words border-l border-[var(--subtle-border)] py-1 pl-2.5 leading-relaxed">
				{thought.content}
			</div>
		</details>
	);
}

function UserBlock({
	message,
	disabled,
	editing,
	editText,
	onEditChange,
	onCancelEdit,
	onSubmitEdit,
	onStartEdit,
	onDelete,
	onBranch,
	onError,
}) {
	const isEditing = editing === message.id && message.id;
	if (isEditing) {
		return (
			<div
				key={message.id}
				className="flex min-w-0 flex-col gap-2"
			>
				<form
					className="flex w-full flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmitEdit?.(message);
					}}
				>
					<textarea
						className="max-h-[300px] min-h-[150px] w-full resize-y rounded-xl border border-[var(--accent)] bg-[var(--surface-raised)] p-3 text-sm leading-relaxed text-[var(--text-primary)] outline-none select-text"
						aria-label="Edit message"
						autoFocus
						value={editText}
						disabled={disabled}
						onChange={(event) => onEditChange?.(event.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") onCancelEdit?.();
						}}
					/>
					<div className="flex items-center justify-end gap-2">
						<button
							type="button"
							className="cursor-pointer rounded-lg px-3 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
							disabled={disabled}
							onClick={() => onCancelEdit?.()}
						>
							Cancel (Esc)
						</button>
						<button
							type="submit"
							className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[11px] font-medium text-[var(--on-accent)] disabled:opacity-40"
							disabled={disabled || !String(editText ?? "").trim()}
						>
							Save
						</button>
					</div>
				</form>
			</div>
		);
	}
	return (
		<div className="group flex min-w-0 flex-col">
			<p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
				You
			</p>
			<p className="whitespace-pre-wrap break-words text-sm leading-relaxed select-text">
				{message.content}
			</p>
			{message.attachments?.length > 0 && (
				<ul
					aria-label="Message attachments"
					className="mt-2 flex flex-wrap gap-1"
				>
					{message.attachments.map((attachment) => (
						<li
							key={attachment.id || attachment.file_path}
							className="max-w-full truncate rounded border border-[var(--attachment-border)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
						>
							{(attachment.mime_type ?? "").startsWith("image/") ? "Image: " : "File: "}
							{String(attachment.file_path ?? "")
								.split(/[\\/]/)
								.pop()}
						</li>
					))}
				</ul>
			)}
			{(onDelete || onBranch || onStartEdit) && (
				<MessageActions
					message={message}
					disabled={disabled}
					onDelete={onDelete ? (id) => onDelete(id) : () => {}}
					onBranch={onBranch ? (id) => onBranch(id) : () => {}}
					onRegenerate={undefined}
					isLast={false}
					onEdit={onStartEdit ? (msg) => onStartEdit(msg) : () => {}}
					onError={onError ?? (() => {})}
				/>
			)}
		</div>
	);
}

function QuestionRecord({ step, request, live }) {
	const question = request?.question || step.args?.question;
	const options = request?.options || step.args?.options || [];
	const answered = typeof step.result === "string" && step.result;
	const resolved = step.status === "complete" && answered;
	const pending = step.status !== "complete" && !!request;
	// A non-terminal step with no live request belongs to a dead run (restored
	// history, never-resumed interruption): report it cancelled, never pending.
	const cancelled = step.status === "error" || (!resolved && !pending && !live);
	return (
		<div
			aria-label="Agent question record"
			className="border-l-2 border-l-[var(--accent)] bg-white/[0.02] px-3 py-1.5 text-[13px]"
		>
			<p className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
				<span
					className={`rounded px-1.5 py-0.5 ${pending ? "bg-amber-400/15 text-amber-500" : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"}`}
				>
					{resolved
						? "Question answered"
						: cancelled
							? "Question cancelled"
							: pending
								? "Question pending"
								: `Question · ${step.status}`}
				</span>
				{pending && (
					<span className="font-normal normal-case text-[var(--text-muted)]">
						answer above the composer
					</span>
				)}
			</p>
			<p className="font-medium text-[var(--text-primary)]">{question || "Agent asked a question"}</p>
			{options.length > 0 && (
				<p className="mt-1 text-xs text-[var(--text-muted)]">Options: {options.join(" · ")}</p>
			)}
			{resolved && (
				<p className="mt-1 break-words text-xs text-[var(--text-secondary)]">Answered: {answered}</p>
			)}
		</div>
	);
}

function SkillRecord({ step }) {
	const proposal = step.args;
	const decision = readSkillDecision(step.id);
	const pending = !decision;
	// An errored proposal with no stored decision never reached review:
	// report the failure instead of pointing at the composer.
	const failed = step.status === "error" && !decision;
	return (
		<div
			aria-label="Skill proposal record"
			className="border-l-2 border-l-amber-400/70 bg-white/[0.02] px-3 py-1.5 text-[13px]"
		>
			<p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
				<span
					className={`rounded px-1.5 py-0.5 ${pending && !failed ? "bg-amber-400/15 text-amber-500" : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"}`}
				>
					{decision === "registered"
						? "Skill registered"
						: decision === "declined"
							? "Skill declined"
							: failed
								? "Proposal failed"
								: "Skill proposal pending"}
				</span>
				{pending && !failed && (
					<span className="font-normal normal-case text-[var(--text-muted)]">
						review above the composer
					</span>
				)}
			</p>
			<p className="text-[var(--text-primary)]">
				Proposed skill: <strong>{proposal?.name ?? "Unnamed"}</strong>
			</p>
			{proposal?.description && (
				<p className="mt-1 text-xs text-[var(--text-muted)]">{proposal.description}</p>
			)}
		</div>
	);
}

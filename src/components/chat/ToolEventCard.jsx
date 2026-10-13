import React, { useState } from "react";
import { FiCheck, FiChevronRight, FiClock, FiCopy, FiTool, FiX } from "react-icons/fi";
import { PiWarning } from "react-icons/pi";
import { RiRobot2Line } from "react-icons/ri";
import { TOOL_DISPLAY_LIMIT } from "../../lib/toolDisplay.mjs";
import {
	classifyStep,
	commandOutcome,
	fileEditStats,
	formatArgFields,
	isBlockedStep,
	isCancelledStep,
	isTestCommand,
	languageOfPath,
	parseTestSummary,
	requestedEditDiff,
	resultLineCount,
	summarizeStep,
	toolKind,
	toolVerb,
} from "../../lib/executionEvents.mjs";
import FileBrowserWidget from "../FileBrowserWidget";
import { isDirectoryTool, parseDirectoryListing } from "../../lib/directoryListing.mjs";
import SubagentTranscriptModal from "./SubagentTranscriptModal.jsx";

function subagentTaskText(step) {
	const args = step?.args;
	if (!args || typeof args !== "object") return "";
	return args.task ?? args.task_description ?? "";
}

const TONE_STYLES = {
	running: "border-[var(--subtle-border)]",
	success: "border-[var(--subtle-border)]",
	failed: "border-[var(--error)]",
	cancelled: "border-[var(--subtle-border)]",
	blocked: "border-amber-400/50",
	muted: "border-[var(--subtle-border)]",
};

const PILL_STYLES = {
	running: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
	success: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
	failed: "bg-[var(--error)]/10 text-[var(--error)]",
	cancelled: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
	blocked: "bg-amber-400/10 text-amber-500",
	muted: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
};

function StatusIcon({ tone }) {
	if (tone === "failed")
		return (
			<FiX
				aria-hidden="true"
				className="shrink-0 text-[var(--error)]"
			/>
		);
	if (tone === "blocked")
		return (
			<PiWarning
				aria-hidden="true"
				className="shrink-0 text-amber-500"
			/>
		);
	if (tone === "success")
		return (
			<FiCheck
				aria-hidden="true"
				className="shrink-0 text-emerald-500"
			/>
		);
	if (tone === "running")
		return (
			<FiClock
				aria-hidden="true"
				className="shrink-0 animate-pulse"
			/>
		);
	return (
		<FiTool
			aria-hidden="true"
			className="shrink-0 text-[var(--accent)]"
		/>
	);
}

function formatBody(value) {
	if (value === undefined) return "No result";
	if (typeof value === "string") {
		return value.length > TOOL_DISPLAY_LIMIT
			? `${value.slice(0, TOOL_DISPLAY_LIMIT)}\n… [truncated in chat]`
			: value || "(empty)";
	}
	try {
		const text = JSON.stringify(value, null, 2) ?? String(value);
		return text.length > TOOL_DISPLAY_LIMIT
			? `${text.slice(0, TOOL_DISPLAY_LIMIT)}\n… [truncated in chat]`
			: text;
	} catch {
		return String(value);
	}
}

function mediaUrls(value, acc = []) {
	if (typeof value === "string") {
		for (const match of value.matchAll(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g))
			acc.push(match[0].slice(0, 8_000_000));
		return acc;
	}
	if (Array.isArray(value)) {
		for (const item of value) mediaUrls(item, acc);
		return acc;
	}
	if (value && typeof value === "object") {
		if (value.type === "image_url" && typeof value.image_url?.url === "string")
			acc.push(value.image_url.url);
		for (const item of Object.values(value)) mediaUrls(item, acc);
	}
	return acc;
}

function SubagentSummary({ step }) {
	let args = step.args ?? {};
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			args = {};
		}
	}
	const files = Array.isArray(args?.target_files)
		? args.target_files.filter((file) => typeof file === "string")
		: [];
	const result = typeof step.result === "string" ? step.result : errorText(step) || step.result?.error;
	// The failed/blocked/cancelled alert row above already shows this exact
	// error text with a copy button; repeating it here as the "result" would
	// duplicate the label, so skip it in that case only.
	const errorShownAbove =
		["failed", "blocked", "cancelled"].includes(classifyStep(step).key) &&
		typeof errorText(step) === "string" &&
		!!errorText(step) &&
		result === errorText(step);
	return (
		<div className="space-y-2 text-xs">
			{typeof args?.task_description === "string" && (
				<p className="whitespace-pre-wrap break-words">{args.task_description}</p>
			)}
			{files.length > 0 && (
				<ul
					aria-label="Research files"
					className="list-disc pl-5"
				>
					{files.map((file, index) => (
						<li
							key={index}
							className="break-all"
						>
							{file}
						</li>
					))}
				</ul>
			)}
			{!errorShownAbove && (
				<p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
					{isRunning(step)
						? "The main agent is waiting for the research summary."
						: result || "No summary was saved."}
				</p>
			)}
		</div>
	);
}

function errorText(step) {
	if (typeof step?.error === "string" && step.error) return step.error;
	const result = step?.result;
	if (result && typeof result === "object" && typeof result.error === "string") return result.error;
	return "";
}

function isRunning(step) {
	return ["preparing", "pending", "running"].includes(step.status);
}

function CopyButton({ text, label = "Copy" }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label={`Copy ${label.toLowerCase()}`}
			onClick={async (event) => {
				event.stopPropagation();
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch {
					setCopied(false);
				}
			}}
			className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-primary)]"
		>
			{copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
			<span>{copied ? "Copied" : label}</span>
		</button>
	);
}

function Detail({ summary, children }) {
	return (
		<details className="text-xs">
			<summary className="w-fit cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
				{summary}
			</summary>
			<div className="mt-1">{children}</div>
		</details>
	);
}

// Image results render as previews, never as JSON dumps.
function resultImages(step) {
	return [...new Set(mediaUrls(step.result))].slice(0, 4);
}

function isImageOnlyResult(step) {
	const result = step?.result;
	return (
		!!result &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		(result.type === "image_url" || typeof result.image_url?.url === "string")
	);
}

// Text a collapsed row shows on the right. Grounded in recorded args/result.
function rowMeta(step, kind, classification, outcome, testSummary, editStats) {
	if (outcome && typeof outcome.exitCode === "number" && outcome.exitCode !== 0) {
		return { text: `exit ${outcome.exitCode}`, tone: "text-[var(--error)]" };
	}
	if (testSummary && (testSummary.passed != null || testSummary.failed != null)) {
		const parts = [];
		if (testSummary.passed != null) parts.push(`${testSummary.passed} passed`);
		if (testSummary.failed != null) parts.push(`${testSummary.failed} failed`);
		return {
			text: parts.join(" · "),
			tone: testSummary.failed ? "text-[var(--error)]" : "text-[var(--text-muted)]",
		};
	}
	if (kind === "edit" && editStats?.kind === "edit") {
		return { text: `+${editStats.added} −${editStats.removed}`, tone: "text-[var(--text-muted)]" };
	}
	if (kind === "write" && editStats?.kind === "write") {
		return { text: `${editStats.lines} lines`, tone: "text-[var(--text-muted)]" };
	}
	if (
		(kind === "read" || kind === "search") &&
		classification.key === "success" &&
		!isImageOnlyResult(step)
	) {
		const lines = resultLineCount(
			step.result && typeof step.result === "object" && typeof step.result.content === "string"
				? step.result.content
				: step.result,
		);
		if (typeof lines === "number")
			return { text: `${lines.toLocaleString()} lines`, tone: "text-[var(--text-muted)]" };
	}
	if (outcome && typeof outcome.exitCode === "number") {
		return { text: `exit ${outcome.exitCode}`, tone: "text-[var(--text-muted)]" };
	}
	return null;
}

// Rich execution card shared by both renderers. Casual passes `compact` to
// keep routine operations to one line; Workspace passes `timeline` for a
// lightweight terminal-style row (no generic bordered card per event) and
// lets failures stand out. No duration, diff, or test data is fabricated:
// each section renders only when the recorded step actually contains it.
export default function ToolEventCard({ step, compact = false, defaultExpanded = null, timeline = false }) {
	const [userExpanded, setUserExpanded] = useState(null);
	const [transcriptOpen, setTranscriptOpen] = useState(false);
	if (!step || step.type !== "tool_call") return null;
	const classification = classifyStep(step);
	const { summary, paths } = summarizeStep(step);
	const kind = toolKind(step);
	const verb = toolVerb(step);
	const fields = formatArgFields(step);
	const running = classification.key === "running";
	const failed = classification.key === "failed";
	const blocked = classification.key === "blocked";
	const cancelled = classification.key === "cancelled";
	// Routine successes stay compact; failures and approval blocks open by default.
	const expanded = userExpanded ?? defaultExpanded ?? (failed || blocked || running);
	const outcome = commandOutcome(step);
	const testSummary = outcome ? parseTestSummary(`${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`) : null;
	const showTest =
		isTestCommand(step) && testSummary && (testSummary.passed != null || testSummary.failed != null);
	const diff = requestedEditDiff(step.args);
	const editStats = fileEditStats(step);
	const directory = step.status === "complete" && !step.error && isDirectoryTool(step.toolName);
	const listing = expanded && directory ? parseDirectoryListing(step.result, step.args) : null;
	const images = expanded ? resultImages(step) : [];
	const imageOnly = isImageOnlyResult(step);
	const isSubagent = ["delegate_task", "spawn_sub_agent", "extract_web_page_data"].includes(step.toolName);
	const meta = rowMeta(step, kind, classification, outcome, showTest ? testSummary : null, editStats);
	const err = errorText(step);
	// The path is already the diff header (edits) or WriteSummary (writes);
	// repeating it in the fields table would duplicate the same heading.
	const writePathShown = kind === "write" && typeof step.args?.relative_path === "string";
	const isPathShownElsewhere = (field) =>
		field.label === "Path" && ((diff && kind === "edit") || writePathShown);
	const visibleFields = fields.filter((field) => !isPathShownElsewhere(field));

	const titleTone = failed
		? "text-[var(--error)]"
		: blocked || running
			? "text-amber-500"
			: cancelled
				? "text-[var(--text-muted)]"
				: "text-[var(--accent-bright)]";
	const showPill = timeline
		? // The stage header already summarizes blocked/running counts, so the
			// per-card "Needs approval" pill would repeat it inside the block.
			// Other statuses keep their inline pill; outside the timeline all show.
			classification.key !== "success" && classification.key !== "blocked"
		: true;
	const containerTone = timeline
		? classification.key === "failed"
			? "bg-[var(--error)]/[0.05]"
			: classification.key === "blocked"
				? "border-l-2 border-l-amber-400/70 bg-amber-400/[0.05]"
				: classification.key === "running"
					? "bg-amber-400/[0.04]"
					: "bg-transparent"
		: "";

	return (
		<div
			aria-label={isSubagent ? "Sub-agent execution" : "Tool execution"}
			data-tool={step.toolName}
			data-status={classification.key}
			className={
				timeline
					? `min-w-0 overflow-hidden rounded-md text-[13px] ${containerTone}`
					: `min-w-0 overflow-hidden rounded-lg border bg-[var(--surface)] text-xs ${TONE_STYLES[classification.tone] ?? TONE_STYLES.muted}`
			}
		>
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setUserExpanded(!expanded)}
				className={
					timeline
						? "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
						: "flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
				}
			>
				<FiChevronRight
					aria-hidden="true"
					className={`shrink-0 text-[11px] text-[var(--text-muted)] transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				{isSubagent ? (
					<RiRobot2Line
						aria-hidden="true"
						className="shrink-0 text-[var(--accent)]"
					/>
				) : (
					<StatusIcon tone={classification.tone} />
				)}
				<strong
					className={`min-w-0 shrink-0 font-medium ${titleTone}`}
					title={step.toolName}
				>
					{verb}
				</strong>
				{showPill && (
					<span
						className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${PILL_STYLES[classification.tone] ?? PILL_STYLES.muted}`}
					>
						{classification.label}
					</span>
				)}
				{typeof step.durationMs === "number" && (
					<span className="shrink-0 tabular-nums text-[10px] text-[var(--text-muted)]">
						{(step.durationMs / 1000).toFixed(1)}s
					</span>
				)}
				{summary && !expanded && (
					<span
						className="min-w-0 flex-1 truncate text-[var(--text-muted)]"
						title={summary}
					>
						{summary}
					</span>
				)}
				{meta && !expanded && (
					<span className={`shrink-0 font-mono text-[10px] tabular-nums ${meta.tone}`}>
						{meta.text}
					</span>
				)}
				{step.serverName && (
					<span
						title={step.serverName}
						className="ml-auto hidden max-w-[30%] truncate rounded border border-[var(--subtle-border)] bg-[var(--input)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)] sm:block"
					>
						{step.serverName}
					</span>
				)}
			</button>
			{expanded && (
				<div
					className={
						timeline
							? "space-y-2.5 px-2 py-2 pl-8"
							: "space-y-3 border-t border-[var(--subtle-border)] p-3"
					}
				>
					{(failed || blocked || cancelled) && err && (
						<div
							role={failed || blocked ? "alert" : "status"}
							className={`flex min-w-0 items-start justify-between gap-2 break-words text-xs ${failed || blocked ? "text-[var(--error)]" : "text-[var(--text-muted)]"}`}
						>
							<p className="min-w-0 flex-1 whitespace-pre-wrap">{err}</p>
							<CopyButton
								text={err}
								label="Copy error"
							/>
						</div>
					)}
					{blocked && (
						<p className="text-[11px] text-[var(--text-muted)]">
							Approval is requested in the approval dialog at the top of the chat. Allowing or
							denying it resumes this run.
						</p>
					)}
					{kind === "command" && outcome && (
						<CommandOutcome
							outcome={outcome}
							testSummary={showTest ? testSummary : null}
						/>
					)}
					{showTest && (
						<p className="text-[11px] text-[var(--text-muted)]">
							Counts parsed from recorded output — not a separate test report.
						</p>
					)}
					{(kind === "read" || kind === "search") &&
						!imageOnly &&
						classification.key === "success" && <ReadOutput step={step} />}
					{imageOnly && images.length > 0 && (
						<div
							className="flex flex-wrap gap-2"
							aria-label="Generated media"
						>
							{images.map((src, index) => (
								<img
									key={index}
									src={src}
									alt="Tool-generated media"
									loading="lazy"
									className="max-h-64 max-w-full rounded-lg object-contain"
								/>
							))}
						</div>
					)}
					{diff && (
						<section aria-label="Requested edit diff">
							<EditDiffHeader
								step={step}
								diff={diff}
								editStats={editStats}
							/>
							<div className="overflow-auto rounded-md border border-[var(--subtle-border)] bg-[var(--code-bg)] font-mono text-[11px] leading-relaxed">
								<div className="max-h-64 overflow-auto p-3">
									{diff.oldLines.map((line, index) => (
										<div
											key={`old-${index}`}
											className="whitespace-pre-wrap break-words text-red-300"
										>
											− {line}
										</div>
									))}
									{diff.newLines.map((line, index) => (
										<div
											key={`new-${index}`}
											className="whitespace-pre-wrap break-words text-emerald-300"
										>
											+ {line}
										</div>
									))}
								</div>
							</div>
							{diff.truncated && (
								<p className="mt-1 text-[11px] text-[var(--text-muted)]">
									Diff truncated for display.
								</p>
							)}
						</section>
					)}
					{kind === "write" && (
						<WriteSummary
							step={step}
							editStats={editStats}
						/>
					)}
					{isSubagent && <SubagentSummary step={step} />}

					{kind === "media" && !imageOnly && step.result != null && (
						<section aria-label="Tool result">
							<h4 className="mb-1 font-medium text-[var(--text-secondary)]">Result</h4>
							<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[var(--code-text)]">
								{formatBody(step.result?.file_path ?? step.result)}
							</pre>
						</section>
					)}
					{images.length > 0 && !imageOnly && kind !== "media" && (
						<div
							className="flex flex-wrap gap-2"
							aria-label="Generated media"
						>
							{images.map((src, index) => (
								<img
									key={index}
									src={src}
									alt="Tool-generated media"
									loading="lazy"
									className="max-h-64 max-w-full rounded-lg object-contain"
								/>
							))}
						</div>
					)}
					{listing ? (
						<FileBrowserWidget
							items={listing.items}
							notice={listing.notice}
						/>
					) : (
						kind !== "command" &&
						kind !== "read" &&
						kind !== "search" &&
						kind !== "media" &&
						!isSubagent &&
						step.toolName !== "ask_user" &&
						step.toolName !== "propose_skill" &&
						!diff &&
						!directory && <GenericResult step={step} />
					)}
					{visibleFields.length > 0 && (
						<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
							{visibleFields.map((field, index) => (
								<React.Fragment key={index}>
									<dt className="shrink-0 text-[var(--text-muted)]">{field.label}</dt>
									<dd
										className="min-w-0 break-words text-[var(--text-secondary)]"
										title={field.value}
									>
										{field.value}
									</dd>
								</React.Fragment>
							))}
						</dl>
					)}
					{kind === "write" && typeof step.args?.content === "string" && (
						<Detail summary="Written content">
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[11px] text-[var(--code-text)]">
								{formatBody(step.args.content)}
							</pre>
						</Detail>
					)}
					{step.args != null && (
						<Detail summary="Full arguments">
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[11px] text-[var(--code-text)] shadow-[0_2px_2px_var(--window-shadow)]">
								{formatBody(step.args)}
							</pre>
						</Detail>
					)}
				</div>
			)}
			{isSubagent && typeof step.childSessionId === "string" && step.childSessionId && (
				<div className="px-3 pb-2">
					<button
						type="button"
						onClick={() => setTranscriptOpen(true)}
						className="cursor-pointer rounded-md border border-[var(--subtle-border)] bg-[var(--surface-hover)]/50 px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
					>
						Show sub-agent activity
					</button>
				</div>
			)}
			{transcriptOpen && typeof step.childSessionId === "string" && step.childSessionId && (
				<SubagentTranscriptModal
					childSessionId={step.childSessionId}
					task={subagentTaskText(step)}
					onClose={() => setTranscriptOpen(false)}
				/>
			)}
		</div>
	);
}

function CommandOutcome({ outcome, testSummary }) {
	const copyText = [outcome.stdout, outcome.stderr].filter(Boolean).join("\n");
	return (
		<section
			aria-label="Command outcome"
			className="space-y-2"
		>
			<h4 className="flex items-center justify-between gap-2 font-medium text-[var(--text-secondary)]">
				<span>
					{testSummary ? "Test output" : "Output"}
					{typeof outcome.exitCode === "number" && ` · exit ${outcome.exitCode}`}
					{testSummary && (
						<span className="ml-2 font-normal text-[var(--text-muted)]">
							(parsed: {testSummary.passed ?? "?"} passed, {testSummary.failed ?? "?"} failed)
						</span>
					)}
				</span>
				{copyText && (
					<CopyButton
						text={copyText}
						label="Copy output"
					/>
				)}
			</h4>
			{outcome.stdout && (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[11px] text-[var(--code-text)]">
					{formatBody(outcome.stdout)}
				</pre>
			)}
			{outcome.stderr && (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[11px] text-[var(--error)]">
					{formatBody(outcome.stderr)}
				</pre>
			)}
			{!outcome.stdout && !outcome.stderr && (
				<p className="text-[11px] text-[var(--text-muted)]">(no output recorded)</p>
			)}
		</section>
	);
}

// Read/search results show the recorded content directly — never a JSON dump
// of the wrapper object. Line counts are labelled as lines, not matches.
function ReadOutput({ step }) {
	const result = step?.result;
	const content =
		result && typeof result === "object" && !Array.isArray(result) && typeof result.content === "string"
			? result.content
			: result;
	const lines = resultLineCount(content);
	return (
		<section
			aria-label="Tool output"
			className="space-y-1.5"
		>
			<h4 className="flex items-center justify-between gap-2 font-medium text-[var(--text-secondary)]">
				<span>Output{typeof lines === "number" && ` · ${lines.toLocaleString()} lines`}</span>
				{typeof content === "string" && content && (
					<CopyButton
						text={content.slice(0, TOOL_DISPLAY_LIMIT)}
						label="Copy output"
					/>
				)}
			</h4>
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[11px] text-[var(--code-text)] shadow-[0_2px_2px_var(--window-shadow)]">
				{formatBody(content ?? step.error)}
			</pre>
		</section>
	);
}

function EditDiffHeader({ step, diff, editStats }) {
	const lang = languageOfPath(diff.path);
	const counts = editStats?.kind === "edit" ? `+${editStats.added} −${editStats.removed}` : "";
	return (
		<h4 className="mb-1 font-medium text-[var(--text-secondary)]">
			Diff{diff.path ? <span className="font-mono text-[11px]"> · {diff.path}</span> : ""}
			{lang && <span className="ml-2 font-normal text-[var(--text-muted)]">{lang}</span>}
			{counts && (
				<span className="ml-2 font-mono text-[11px] font-normal text-[var(--text-muted)]">
					{counts}
				</span>
			)}
			<span className="ml-2 font-normal text-[var(--text-muted)]">
				{step.status === "complete" && !isFailed(step) ? "· applied" : "· not confirmed applied"}
			</span>
		</h4>
	);
}

// Write results are `{ success: true }`; the path and size (already shown in
// the row) are the useful facts. The path appears here exactly once.
function WriteSummary({ step, editStats }) {
	const path = typeof step.args?.relative_path === "string" ? step.args.relative_path : null;
	const ok = step?.result?.success === true && step.status === "complete" && !isFailed(step);
	return (
		<div className="text-xs text-[var(--text-secondary)]">
			{path && <p className="break-all font-mono text-[11px]">{path}</p>}
			<p className="mt-0.5 text-[var(--text-muted)]">
				{editStats?.kind === "write" ? `${editStats.lines} lines written` : "File written"}
				{ok ? " · saved" : " · not confirmed saved"}
			</p>
		</div>
	);
}

function GenericResult({ step }) {
	const result = Object.hasOwn(step, "result") ? step.result : step.error;
	if (
		result &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		result.success === true &&
		Object.keys(result).length === 1
	) {
		return <p className="text-xs text-[var(--text-muted)]">Completed successfully.</p>;
	}
	// A failed/blocked/cancelled result carrying nothing beyond status flags
	// would only repeat the alert row above (same error text, no copy button
	// needed twice), so omit it; richer results still render below.
	if (
		result &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		["failed", "blocked", "cancelled"].includes(classifyStep(step).key) &&
		Object.keys(result).every((key) => ["success", "isError", "error"].includes(key))
	) {
		return null;
	}
	return (
		<section aria-label="Tool result">
			<h4 className="mb-1 font-medium text-[var(--text-secondary)]">Result</h4>
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-3 font-mono text-[11px] text-[var(--code-text)] shadow-[0_2px_2px_var(--window-shadow)]">
				{formatBody(result)}
			</pre>
		</section>
	);
}

function isFailed(step) {
	return step.status === "error" || step.result?.isError === true || step.result?.success === false;
}

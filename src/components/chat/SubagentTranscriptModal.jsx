import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiArrowDown, FiChevronDown, FiX } from "react-icons/fi";
import { RiRobot2Line } from "react-icons/ri";

import { subagentLimitNotice, subagentUsageLines, subagentResultTitle } from "../../lib/subagentDisplay.mjs";

const STATUS_TONE = {
	partial: "bg-amber-400/15 text-amber-500",
	running: "bg-amber-400/15 text-amber-500",
	waiting: "bg-amber-400/15 text-amber-500",
	created: "bg-amber-400/15 text-amber-500",
	completed: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	failed: "bg-[var(--error)]/10 text-[var(--error)]",
	interrupted: "bg-[var(--surface-hover)] text-[var(--text-muted)]",
	cancelled: "bg-[var(--surface-hover)] text-[var(--text-muted)]",
};

const LIVE_STATUSES = new Set(["created", "waiting", "running"]);

// Each text pane follows independently and pauses when the reader scrolls up.
function StreamingText({ title, text, active = false, truncated = false }) {
	const viewport = useRef(null);
	const following = useRef(true);
	const [paused, setPaused] = useState(false);
	useLayoutEffect(() => {
		if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
	}, [text]);
	const jumpToLatest = () => {
		following.current = true;
		setPaused(false);
		if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
	};
	return (
		<section aria-label={title} className="overflow-hidden rounded-xl border border-[var(--subtle-border)] bg-[var(--surface)]">
			<div className="flex min-h-11 items-center gap-2 border-b border-[var(--subtle-border)] px-3">
				<h3 className="flex-1 text-xs font-semibold">{title}</h3>
				{active && <span className="text-[11px] text-[var(--accent-bright)]">Live</span>}
				{paused && <button type="button" onClick={jumpToLatest} className="flex min-h-11 cursor-pointer items-center gap-1 text-[11px] text-[var(--accent-bright)]"><FiArrowDown aria-hidden="true" />Jump to latest</button>}
			</div>
			<div ref={viewport} tabIndex={0} aria-label={`${title} text`} onScroll={(event) => {
				const element = event.currentTarget;
				following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
				setPaused(!following.current);
			}} className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-words p-3 text-[13px] leading-relaxed text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
				{text}
			</div>
			{truncated && <p className="border-t border-[var(--subtle-border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">Preview shortened for display.</p>}
		</section>
	);
}

function ActivityFeed({ events }) {
	if (!events?.length) return null;
	return (
		<details className="group rounded-xl border border-[var(--subtle-border)] p-3" aria-label="Live activity">
			<summary className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-medium"><FiChevronDown aria-hidden="true" />Activity history <span className="ml-auto text-[var(--text-muted)]">{events.length} events</span></summary>
			<ol className="space-y-1 rounded-lg border border-[var(--subtle-border)] bg-[var(--surface)] p-2">
				{events.map((event, index) => (
					<li
						key={index}
						className="flex min-w-0 items-baseline gap-2 text-[11px]"
					>
						<span className="shrink-0 tabular-nums text-[var(--text-muted)]">
							{new Date(event.t).toLocaleTimeString()}
						</span>
						<span
							className="min-w-0 flex-1 truncate text-[var(--text-secondary)]"
							title={activityText(event)}
						>
							{activityText(event)}
						</span>
						{(event.text || event.arguments) && (
							<details className="max-w-[60%] shrink-0">
								<summary className="cursor-pointer text-[var(--text-muted)]">Details</summary>
								<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
									{event.text || event.arguments}
								</pre>
							</details>
						)}
					</li>
				))}
			</ol>
		</details>
	);
}

function activityText(event) {
	switch (event?.type) {
		case "queued":
			return "Waiting for a model slot";
		case "generating":
			return "Generating a response";
		case "turn":
			return `Turn ${event.turn} started`;
		case "thought":
			return `Thinking: ${(event.text ?? "").slice(0, 140)}`;
		case "tool":
			return `Calling ${event.name}`;
		case "tool-result":
			return `${event.name} ${event.ok ? "finished" : "failed"}`;
		case "file":
			return `Reading ${event.path ?? "file"}${event.chars != null ? ` (${event.chars.toLocaleString()} chars)` : ""}`;
		case "fetch":
			return `Fetched ${event.url ?? "page"}${event.chars != null ? ` (${event.chars.toLocaleString()} chars)` : ""}`;
		default:
			return event?.type ?? "event";
	}
}

function TurnCard({ turn, index }) {
	const [expanded, setExpanded] = useState(false);
	const isTool = turn.role === "tool";
	const body = turn.text?.text ?? "";
	return (
		<div className="rounded-lg border border-[var(--subtle-border)] bg-[var(--surface)]">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
				className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
			>
				<span
					className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
						isTool
							? "bg-[var(--surface-hover)] text-[var(--text-secondary)]"
							: "bg-[var(--accent)]/15 text-[var(--accent-bright)]"
					}`}
				>
					{turn.role}
				</span>
				<span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">
					{turn.toolCalls?.length
						? turn.toolCalls.map((call) => call.name).join(", ")
						: body.slice(0, 120) || `Turn ${index + 1}`}
				</span>
				{turn.text?.truncated && (
					<span className="shrink-0 text-[10px] text-[var(--text-muted)]">truncated</span>
				)}
			</button>
			{expanded && (
				<div className="space-y-2 border-t border-[var(--subtle-border)] p-3 text-xs">
					{body && <p className="whitespace-pre-wrap break-words">{body}</p>}
					{(turn.toolCalls ?? []).map((call, callIndex) => (
						<div
							key={callIndex}
							className="rounded-md bg-[var(--surface-hover)]/50 p-2"
						>
							<p className="font-mono text-[11px] text-[var(--accent-bright)]">{call.name}</p>
							<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text-secondary)]">
								{call.arguments?.text}
							</pre>
							{call.arguments?.truncated && (
								<p className="mt-1 text-[10px] text-[var(--text-muted)]">
									Arguments truncated for display.
								</p>
							)}
						</div>
					))}
					{turn.text?.truncated && (
						<p className="text-[10px] text-[var(--text-muted)]">
							Output truncated for display; the child saw the full text.
						</p>
					)}
				</div>
			)}
		</div>
	);
}

// Minimal Phase 1.5 child controls. Interrupt stops the active turn at a safe
// boundary and keeps the child resumable; Continue re-drives an interrupted
// child through the existing Phase 1.3C control surface. A continuation that
// requires an authorized budget renewal is surfaced as a note here rather than
// performed as a one-click action. Everything is feature-detected so a host
// without the subagent control bridge simply renders nothing.
function ChildControls({ childSessionId, transcript }) {
	const api = typeof window !== "undefined" ? window.api : null;
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const status = transcript?.status;
	const parentSessionId = transcript?.parentSessionId;
	const canInterrupt = typeof api?.interruptChild === "function" && LIVE_STATUSES.has(status);
	const canContinue =
		status === "interrupted" &&
		typeof api?.getContinuationStatus === "function" &&
		typeof api?.continueChild === "function";
	if (!canInterrupt && !canContinue) return null;
	const run = async (action) => {
		setBusy(true);
		setNote("");
		try {
			const result = await action();
			if (result && result.continued === false) setNote(result.detail ?? result.reason ?? "Not continued.");
			else if (result && result.interrupted === false) setNote("There was no active work to interrupt.");
			else setNote("Requested.");
		} catch (cause) {
			setNote(cause?.message ?? String(cause));
		} finally {
			setBusy(false);
		}
	};
	const buttonClass =
		"cursor-pointer rounded-md border border-[var(--subtle-border)] bg-[var(--surface-hover)]/50 px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
	return (
		<section aria-label="Sub-agent controls" className="flex flex-wrap items-center gap-2 text-[11px]">
			{canInterrupt && (
				<button type="button" disabled={busy} className={buttonClass}
					onClick={() => run(() => api.interruptChild(childSessionId, { parentSessionId }))}>
					Interrupt
				</button>
			)}
			{canContinue && (
				<button type="button" disabled={busy} className={buttonClass} onClick={() => run(async () => {
					const status = await api.getContinuationStatus(childSessionId, parentSessionId);
					if (status?.eligibility?.requiresRenewal) {
						return { continued: false, detail: "This child stopped at a configured budget; an authorized renewal is required before it can continue." };
					}
					return api.continueChild(childSessionId, { parentSessionId });
				})}>
					Continue
				</button>
			)}
			{note && <span role="status" className="text-[var(--text-muted)]">{note}</span>}
		</section>
	);
}

// Read-only activity view for one spawned child: the prompt it was given,
// every committed turn (tool calls with short args, truncated outputs), and
// the final answer or error. Polls while open so running children update
// live; the runtime is in-memory, so unknown ids render as unavailable
// instead of throwing.
export default function SubagentTranscriptModal({ childSessionId, task, onClose }) {
	const dialogRef = useRef(null);
	const [transcript, setTranscript] = useState(null);
	const [error, setError] = useState("");
	const [previews, setPreviews] = useState({ thinking: "", output: "" });

	useEffect(() => {
		const element = dialogRef.current;
		if (element && !element.open) {
			try {
				element.showModal();
			} catch {
				/* Already open or unsupported; content still renders. */
			}
		}
		return () => {
			if (element?.open) element.close();
		};
	}, []);

	useEffect(() => {
		let active = true;
		let pending = false;
		setTranscript(null);
		setPreviews({ thinking: "", output: "" });
		setError("");
		const load = async () => {
			if (pending) return;
			pending = true;
			try {
				const result = await window.api.getChildTranscript(childSessionId);
				if (active) {
					setTranscript(result);
					const progress = result?.liveProgress;
					if (progress?.text && ["thinking", "responding"].includes(progress.type)) {
						setPreviews(previous => ({ ...previous, [progress.type === "thinking" ? "thinking" : "output"]: progress.text }));
					}
					setError("");
				}
			} catch (cause) {
				if (active) setError(cause?.message ?? String(cause));
			} finally {
				pending = false;
			}
		};
		load();
		const timer = setInterval(load, 500);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [childSessionId]);

	const live = transcript?.found && LIVE_STATUSES.has(transcript.status);

	const progress = transcript?.liveProgress;
	const latest = transcript?.activity?.at(-1);
	const phase =
		progress?.type === "thinking"
			? "Thinking"
			: progress?.type === "tool-planning"
				? `Preparing tools: ${progress.tools?.join(", ") || "tool call"}`
				: progress?.type === "responding"
					? "Writing response"
					: latest?.type === "tool"
						? `Using tool: ${latest.name}`
						: latest?.type === "generating"
							? "Generating a response"
							: latest?.type === "queued"
								? "Waiting for a model slot"
								: latest?.type === "fetch"
									? "Analyzing page"
									: latest?.type === "file"
										? "Analyzing files"
										: "Working";

	return (
		<dialog
			ref={dialogRef}
			aria-label="Sub-agent activity"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target === dialogRef.current) onClose();
			}}
			className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-24px)] max-w-[860px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60"
		>
			<div className="flex max-h-[85dvh] flex-col">
				<header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
					<RiRobot2Line
						aria-hidden="true"
						className="shrink-0 text-[var(--accent)]"
					/>
					<h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Sub-agent activity</h2>
					{transcript?.found && (
						<span
							className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[transcript.status] ?? STATUS_TONE.cancelled}`}
						>
							{transcript.status}{transcript.stopReason && transcript.stopReason !== "completed" ? ` · ${transcript.stopReason}` : ""}
							{live ? " · live" : ""}
						</span>
					)}
					<button
						type="button"
						aria-label="Close sub-agent activity"
						onClick={onClose}
						className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
					>
						<FiX aria-hidden="true" />
					</button>
				</header>
				<div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-xs">
					{(task || transcript?.task) && (
						<details className="rounded-xl border border-[var(--subtle-border)] px-3 py-2" aria-label="Task given to the sub-agent">
							<summary className="flex min-h-8 cursor-pointer items-center gap-2 font-medium"><FiChevronDown aria-hidden="true" />Task<span className="min-w-0 flex-1 truncate font-normal text-[var(--text-muted)]">{task || transcript?.task}</span></summary>
							<p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text-secondary)]">{task || transcript?.task}</p>
						</details>
					)}
					{error && (
						<p
							role="alert"
							className="text-[var(--error)]"
						>
							Could not load activity: {error}
						</p>
					)}
					{!transcript && !error && <p className="text-[var(--text-muted)]">Loading activity…</p>}
					{transcript && !transcript.found && (
						<p className="text-[var(--text-muted)]">
							No live or saved transcript was found for this sub-agent.
						</p>
					)}
					{transcript?.found && (
						<>
							<section
								aria-label="Child details"
								className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)] tabular-nums"
							>
								{transcript.model && (
									<span title={transcript.model}>Model: {transcript.model.split(/[\\/]/).at(-1)}</span>
								)}
								{transcript.kind && <span>Kind: {transcript.kind}</span>}
								<span>Executions: {transcript.turnCount}</span>
								{transcript.durationMs != null && (
									<span>Duration: {(transcript.durationMs / 1000).toFixed(1)}s</span>
								)}
							</section>
							<section aria-label="Execution budgets and usage" className="space-y-1 text-[11px] text-[var(--text-muted)] tabular-nums">
								{subagentLimitNotice(transcript) && (
									<p role="note" className="rounded-lg bg-amber-400/15 px-2 py-1.5 text-amber-500">
										{subagentLimitNotice(transcript)}
									</p>
								)}
								{subagentUsageLines(transcript).map(line => <p key={line}>{line}</p>)}
							</section>
							<ChildControls childSessionId={childSessionId} transcript={transcript} />
							{live && (
								<section
									aria-label="Current activity"
									className="rounded-lg border border-[var(--subtle-border)] bg-[var(--surface-hover)]/40 p-3"
								>
									<div
										role="status"
										className="flex items-center gap-2 text-[var(--accent-bright)]"
									>
										<span
											aria-hidden="true"
											className="size-2 rounded-full bg-current motion-safe:animate-pulse"
										/>
										<span>{phase}</span>
										{transcript.elapsedMs != null && (
											<span className="ml-auto tabular-nums text-[var(--text-muted)]">
												{Math.floor(transcript.elapsedMs / 1000)}s elapsed
											</span>
										)}
									</div>

								</section>
							)}
							{(previews.thinking || transcript.activity?.some(event => event.type === "thought")) && (
								<StreamingText title="Thinking" text={progress?.type === "thinking" ? progress.text : previews.thinking || transcript.activity.filter(event => event.type === "thought").map(event => event.text).join("\n\n")} active={live && progress?.type === "thinking"} />
							)}
							{(previews.output || transcript.result) && (
								<StreamingText title={live ? "Output" : subagentResultTitle(transcript.status)} text={transcript.result?.text || previews.output} active={live && progress?.type === "responding"} truncated={transcript.result?.truncated} />
							)}
							<ActivityFeed events={transcript.activity} />
                            {transcript.toolsUsed?.length > 0 && <section aria-label="Tools used" className="text-[var(--text-muted)]">
                                Tools used: {transcript.toolsUsed.map(tool => `${tool.name} (${tool.calls})`).join(", ")}
                            </section>}
                            {transcript.totalTokens != null && <p className="text-[var(--text-muted)]">Total tokens: {transcript.totalTokens.toLocaleString()}</p>}
							<details
								aria-label="Child turns"
								className="space-y-2"
							>
								<summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium"><FiChevronDown aria-hidden="true" />Conversation details <span className="ml-auto text-[var(--text-muted)]">{transcript.turns.length} entries</span></summary>
								{transcript.turns.length === 0 && !transcript.activity?.length && (
									<p className="text-[var(--text-muted)]">
										{live
											? "The child has started but committed no turns yet."
											: "No turns were recorded."}
									</p>
								)}
								{transcript.turns.map((turn, index) => (
									<TurnCard
										key={index}
										turn={turn}
										index={index}
									/>
								))}
							</details>
							{transcript.error && (
								<section aria-label="Child error">
									<h3 className="mb-1 text-[11px] font-medium text-[var(--text-muted)]">
										Error
									</h3>
									<p
										role="alert"
										className="whitespace-pre-wrap break-words text-[var(--error)]"
									>
										{transcript.error}
									</p>
								</section>
							)}

						</>
					)}
				</div>
			</div>
		</dialog>
	);
}

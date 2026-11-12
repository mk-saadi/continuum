import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiArrowDown, FiX } from "react-icons/fi";
import { RiRobot2Line } from "react-icons/ri";

import { subagentLimitNotice } from "../../lib/subagentDisplay.mjs";

import { WorkspaceMessage } from "./WorkspaceTimeline.jsx";
import { subagentMessages } from "../../lib/subagentTranscript.mjs";

const STATUS_TONE = {
	partial: "bg-[var(--warning)]/10 text-[var(--warning)]",
	running: "bg-[var(--warning)]/10 text-[var(--warning)]",
	waiting: "bg-[var(--warning)]/10 text-[var(--warning)]",
	created: "bg-[var(--warning)]/10 text-[var(--warning)]",
	completed: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	failed: "bg-[var(--error)]/10 text-[var(--error)]",
	interrupted: "bg-[var(--surface-hover)] text-[var(--text-muted)]",
	cancelled: "bg-[var(--surface-hover)] text-[var(--text-muted)]",
};

const LIVE_STATUSES = new Set(["created", "waiting", "running"]);

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
		"aero-control sk-button aero-fill sk-fill inline-flex min-h-9 cursor-pointer items-center justify-center px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
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
	const viewport = useRef(null);
	const following = useRef(true);
	const [paused, setPaused] = useState(false);

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
		setError("");
		const load = async () => {
			if (pending) return;
			pending = true;
			try {
				const result = await window.api.getChildTranscript(childSessionId);
				if (active) {
					setTranscript(result);
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

	const messages = subagentMessages(transcript, task, childSessionId);
	const jumpToLatest = () => {
		following.current = true;
		setPaused(false);
		if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
	};
	useLayoutEffect(() => {
		if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
	}, [transcript, childSessionId]);

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
			className="aero-dialog sk-window sk-dialog fixed inset-0 m-auto max-h-[88dvh] w-[calc(100%-24px)] max-w-[1040px] overflow-hidden p-0 text-[var(--text-primary)]"
		>
			<div className="flex max-h-[88dvh] flex-col">
				<header className="aero-header sk-window-header sk-texture-grain flex shrink-0 flex-wrap items-center gap-3 px-5 py-4">
					<RiRobot2Line
						aria-hidden="true"
						className="size-5 shrink-0 text-[var(--accent)]"
					/>
					<div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Sub-agent activity</h2><p className="mt-0.5 text-xs text-[var(--text-muted)]">Follow progress and review the result.</p></div>
					{transcript?.found && (
						<span
							className={`shrink-0 ui-radius-control px-2 py-1 text-[11px] font-medium capitalize ${STATUS_TONE[transcript.status] ?? STATUS_TONE.cancelled}`}
						>
							{transcript.status}
							{live ? " · live" : ""}
						</span>
					)}
					<button
						type="button"
						aria-label="Close sub-agent activity"
						onClick={onClose}
						className="aero-orb sk-icon-button aero-fill sk-fill flex size-9 shrink-0 cursor-pointer items-center justify-center focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
					>
						<FiX aria-hidden="true" />
					</button>
				</header>
				<div ref={viewport} aria-label="Sub-agent conversation" tabIndex={0}
					onScroll={event => {
						const element = event.currentTarget;
						following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
						setPaused(!following.current);
					}}
					className="min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-6 sm:px-8">
					<div className="mx-auto flex max-w-[860px] flex-col gap-6">
						{error && <p role="alert" className="text-sm text-[var(--error)]">Could not load activity: {error}</p>}
						{!transcript && !error && <p className="text-sm text-[var(--text-muted)]">Loading activity…</p>}
						{transcript && !transcript.found && <p className="text-sm text-[var(--text-muted)]">No live or saved transcript was found for this sub-agent.</p>}
						{(transcript?.found || task) && messages.map((message, index) => (
							<WorkspaceMessage key={message.id} message={message} index={index} disabled
								activeModelName={transcript?.model ?? ""} />
						))}
						{transcript?.found && subagentLimitNotice(transcript) && <p role="note" className="text-sm text-[var(--warning)]">{subagentLimitNotice(transcript)}</p>}
						{transcript?.error && transcript.error !== (typeof transcript.result === 'string' ? transcript.result : transcript.result?.text) && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-[var(--error)]">{transcript.error}</p>}
						{live && <p role="status" className="text-xs text-[var(--text-muted)]">{transcript.liveProgress?.type === "thinking" ? "Thinking…" : transcript.liveProgress?.type === "responding" ? "Writing response…" : "Working…"}</p>}
					</div>
				</div>
				{(paused || transcript?.found) && <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-[var(--subtle-border)] px-5 py-2">
					<ChildControls childSessionId={childSessionId} transcript={transcript} />
					{paused && <button type="button" onClick={jumpToLatest} className="flex min-h-9 cursor-pointer items-center gap-1 text-xs text-[var(--accent-bright)]"><FiArrowDown aria-hidden="true" />Jump to latest</button>}
				</footer>}
			</div>
		</dialog>
	);
}

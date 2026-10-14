import React, { useEffect, useRef, useState } from "react";
import { LuHistory } from "react-icons/lu";

// Compact Workspace Recovery overview for the Activity tab. Chat-scoped:
// everything shown belongs to `sessionId`'s workspace run. Viewing is always
// safe; restoration lives in the history modal (which disables itself while
// a run is active).
export default function RecoveryCard({ sessionId, disabled = false, running = false, onOpenHistory }) {
	const [overview, setOverview] = useState(null);
	const [error, setError] = useState("");
	const wasRunning = useRef(running);

	useEffect(() => {
		let active = true;
		setOverview(null);
		setError("");
		if (!sessionId || !window.api?.getRecoveryOverview) return undefined;
		let pending = false;
		const load = async () => {
			if (pending) return;
			pending = true;
			try {
				const value = await window.api.getRecoveryOverview(sessionId);
				if (active) {
					setOverview(value);
					setError("");
				}
			} catch (cause) {
				if (active) setError(cause?.message ?? String(cause));
			} finally {
				pending = false;
			}
		};
		load();
		return () => {
			active = false;
		};
	}, [sessionId]);

	// Refresh when a run finishes so the card reflects fresh checkpoints.
	useEffect(() => {
		if (wasRunning.current && !running && sessionId && window.api?.getRecoveryOverview) {
			window.api.getRecoveryOverview(sessionId).then(setOverview, (cause) => setError(cause?.message ?? String(cause)));
		}
		wasRunning.current = running;
	}, [running, sessionId]);

	const tone = !overview || overview.state === "empty"
		? "bg-[var(--text-muted)]"
		: overview.state === "protected"
			? "bg-[var(--accent)]"
			: "bg-amber-500";
	const latest = overview?.latest ?? null;
	const kinds = latest?.changedKinds;
	const changeBits = kinds
		? [
			kinds.modified ? `${kinds.modified} modified` : "",
			kinds.created ? `${kinds.created} created` : "",
			kinds.deleted ? `${kinds.deleted} deleted` : "",
			kinds.renamed ? `${kinds.renamed} renamed` : "",
		].filter(Boolean)
		: [];
	const skippedCount = latest?.skipped?.length ?? 0;

	return (
		<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_2px_var(--window-shadow)]">
			<div className="flex items-center gap-2">
				<span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${tone}`} />
				<h3 className="text-xs font-semibold">Workspace Recovery</h3>
				<LuHistory aria-hidden="true" className="ml-auto shrink-0 text-[var(--text-muted)]" />
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-[11px] text-[var(--error)]">
					Recovery status unavailable: {error}
				</p>
			) : !overview ? (
				<p className="mt-2 text-[11px] text-[var(--text-muted)]">Checking recovery status…</p>
			) : overview.state === "empty" ? (
				<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
					No recovery snapshots for this chat yet. Snapshots appear automatically once the agent changes files.
				</p>
			) : (
				<>
					<p className="mt-2 text-[11px] font-medium text-[var(--text-secondary)]">
						{overview.state === "protected" ? "Protected" : "Partial coverage"}
						{latest && (
							<span className="font-normal text-[var(--text-muted)]">
								{" "}· {latest.kind} · {latest.originChat}
							</span>
						)}
					</p>
					{changeBits.length > 0 && (
						<p className="mt-1 text-[11px] text-[var(--text-muted)] tabular-nums">
							Latest: {changeBits.join(" · ")}
						</p>
					)}
					{overview.runStart && (
						<p className="mt-1 text-[11px] text-[var(--text-muted)]">
							Run-start point available ({overview.runStart.kind}).
						</p>
					)}
					{skippedCount > 0 && (
						<p className="mt-1 text-[11px] font-medium text-amber-500">
							{skippedCount} path{skippedCount === 1 ? "" : "s"} could not be captured.
						</p>
					)}
					{overview.blobsMissing > 0 && (
						<p className="mt-1 text-[11px] font-medium text-amber-500">
							{overview.blobsMissing} captured file{overview.blobsMissing === 1 ? "" : "s"} missing from storage.
						</p>
					)}
					{overview.otherCheckpointCount > 0 && (
						<p className="mt-1 text-[11px] text-[var(--text-muted)]">
							+{overview.otherCheckpointCount} checkpoint{overview.otherCheckpointCount === 1 ? "" : "s"} from other chats in this workspace.
						</p>
					)}
				</>
			)}
			{running && (
				<p className="mt-2 text-[11px] text-[var(--text-muted)]">
					Run active — restoration unlocks when it stops.
				</p>
			)}
			<button
				type="button"
				onClick={onOpenHistory}
				disabled={disabled || !overview || overview.state === "empty"}
				className="mt-2 w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
			>
				View recovery history
			</button>
		</div>
	);
}

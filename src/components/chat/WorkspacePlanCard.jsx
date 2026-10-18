import React, { memo, useCallback, useEffect, useRef, useState } from "react";

// Read-only presentation of the durable Workspace task plan.
//
// The plan is owned by the main process (src/main/workspacePlan.js); this card
// never edits it. It loads on mount/session change and then stays current from
// the `session:plan-updated` push. Every event is filtered by sessionId before
// any state is touched, so an update for one task does not render unrelated
// tabs. A later load for a different session invalidates an in-flight earlier
// one, so a slow response can never show a stale plan after a tab/session
// switch.

const STATUS_META = {
	pending: {
		label: "Pending",
		dotClass: "bg-[var(--text-muted)]",
		textClass: "text-[var(--text-muted)]",
	},
	in_progress: {
		label: "In progress",
		dotClass: "bg-[var(--accent)] animate-pulse",
		textClass: "text-[var(--accent)]",
	},
	completed: {
		label: "Completed",
		dotClass: "bg-emerald-500",
		textClass: "text-[var(--text-muted)]",
	},
	blocked: {
		label: "Blocked",
		dotClass: "bg-amber-500",
		textClass: "text-amber-500",
	},
};

function statusMeta(status) {
	return STATUS_META[status] ?? STATUS_META.pending;
}

function PlanStep({ step }) {
	const meta = statusMeta(step.status);
	const completed = step.status === "completed";
	return (
		<li
			data-step-id={step.id}
			data-step-status={step.status}
			aria-current={step.status === "in_progress" ? "step" : undefined}
			className={completed ? "opacity-70" : undefined}
		>
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className={`mt-1 size-2 shrink-0 rounded-full ${meta.dotClass}`}
				/>
				<div className="min-w-0">
					<p
						className={`text-[11px] leading-snug ${completed ? "line-through" : ""}`}
					>
						{step.description}
					</p>
					<p className={`mt-0.5 text-[10px] ${meta.textClass}`}>
						{meta.label}
						{Number.isSafeInteger(step.position) ? ` · step ${step.position}` : ""}
					</p>
					{step.note ? (
						<p
							data-step-note=""
							className={`mt-0.5 whitespace-pre-wrap text-[10px] ${
								step.status === "blocked" ? "text-amber-500" : "text-[var(--text-muted)]"
							}`}
						>
							{step.note}
						</p>
					) : null}
				</div>
			</div>
		</li>
	);
}

export function WorkspacePlanCard({ sessionId }) {
	const api = typeof window !== "undefined" ? window.memoryPalace : null;
	const [loading, setLoading] = useState(true);
	const [plan, setPlan] = useState(null);
	const [error, setError] = useState("");
	const requestRef = useRef(0);

	const load = useCallback(async () => {
		if (!sessionId || typeof api?.getPlan !== "function") {
			setLoading(false);
			setPlan(null);
			setError("");
			return;
		}
		const request = ++requestRef.current;
		setLoading(true);
		setError("");
		try {
			const current = await api.getPlan(sessionId);
			if (requestRef.current !== request) return;
			setPlan(current ?? null);
			setLoading(false);
		} catch (failure) {
			if (requestRef.current !== request) return;
			setPlan(null);
			setError(failure?.message || "Could not load the task plan.");
			setLoading(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		// Reset immediately on session change so the previous task's plan is
		// never shown under the new tab while the fresh read is in flight.
		requestRef.current += 1;
		setPlan(null);
		setError("");
		setLoading(true);
		load();
	}, [load]);

	useEffect(() => {
		if (typeof api?.onPlanUpdated !== "function") return undefined;
		const unsubscribe = api.onPlanUpdated((payload) => {
			if (!payload || payload.sessionId !== sessionId) return;
			// A push is newer than any in-flight read for this session.
			requestRef.current += 1;
			setPlan(payload.plan ?? null);
			setError("");
			setLoading(false);
		});
		return typeof unsubscribe === "function" ? unsubscribe : undefined;
	}, [api, sessionId]);

	const steps = Array.isArray(plan?.steps) ? plan.steps : [];
	const total = steps.length;
	const completed = steps.filter((step) => step.status === "completed").length;
	const inProgress = steps.filter((step) => step.status === "in_progress").length;
	const blocked = steps.filter((step) => step.status === "blocked").length;
	const pending = steps.filter((step) => step.status === "pending").length;
	const allComplete = total > 0 && completed === total;
	const headingId = `workspace-plan-heading-${sessionId ?? "none"}`;

	return (
		<section
			aria-labelledby={headingId}
			data-plan-session={sessionId ?? ""}
			data-plan-revision={plan?.revision ?? ""}
			className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
		>
			<div className="flex items-center justify-between gap-2">
				<h3 id={headingId} className="text-xs font-semibold">
					Task plan
				</h3>
				<div className="flex items-center gap-2">
					{plan ? (
						<span
							data-plan-revision-badge=""
							className="text-[10px] text-[var(--text-muted)]"
						>
							Rev {plan.revision}
						</span>
					) : null}
					<button
						type="button"
						onClick={load}
						aria-label="Refresh task plan"
						title="Refresh task plan"
						className="rounded px-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
					>
						↻
					</button>
				</div>
			</div>

			{loading ? (
				<p role="status" className="mt-2 text-[11px] text-[var(--text-muted)]">
					Loading plan…
				</p>
			) : error ? (
				<div className="mt-2">
					<p role="alert" className="text-[11px] text-[var(--error)]">
						Could not load the plan: {error}
					</p>
					<button
						type="button"
						onClick={load}
						className="mt-1 rounded border border-[var(--border)] px-2 py-0.5 text-[10px] hover:bg-[var(--surface-raised)]"
					>
						Retry
					</button>
				</div>
			) : !plan ? (
				<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
					No plan yet. The agent creates one for a multi-step task; it
					stays available across turns and compaction.
				</p>
			) : (
				<>
					{plan.objective ? (
						<p
							data-plan-objective=""
							className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]"
						>
							{plan.objective}
						</p>
					) : null}
					<p data-plan-progress="" className="mt-2 text-[11px] text-[var(--text-muted)]">
						{completed} of {total} complete
						{inProgress ? ` · ${inProgress} in progress` : ""}
						{blocked ? ` · ${blocked} blocked` : ""}
						{pending ? ` · ${pending} pending` : ""}
					</p>
					{total > 0 ? (
						<div
							role="progressbar"
							aria-label="Plan progress"
							aria-valuemin={0}
							aria-valuemax={total}
							aria-valuenow={completed}
							className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--border)]"
						>
							<div
								className="h-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none"
								style={{ width: `${Math.round((completed / total) * 100)}%` }}
							/>
						</div>
					) : null}
					{allComplete ? (
						<p role="status" className="mt-2 text-[11px] font-medium text-[var(--accent)]">
							All steps completed.
						</p>
					) : null}
					{total === 0 ? (
						<p className="mt-2 text-[11px] text-[var(--text-muted)]">
							No steps recorded.
						</p>
					) : (
						<ul className="mt-2 space-y-2">
							{steps.map((step) => (
								<PlanStep key={step.id} step={step} />
							))}
						</ul>
					)}
				</>
			)}
		</section>
	);
}

export default memo(WorkspacePlanCard);

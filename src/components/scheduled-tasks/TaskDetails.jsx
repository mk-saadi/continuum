import React from "react";
import {
	FiAlertTriangle,
	FiChevronDown,
	FiClock,
	FiEdit2,
	FiPause,
	FiPlay,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import {
	describeMissedPolicy,
	describeSchedule,
	formatDateTime,
	formatDuration,
	formatTime,
	modelLabel,
	nextRunSummary,
	relativeTime,
	runExplanation,
	runStatusLabel,
	runStatusTone,
	taskState,
} from "../../lib/scheduledTasks.mjs";

export function StatusChip({ status, tone, label }) {
	return (
		<span
			className="tasks-chip"
			data-tone={tone ?? runStatusTone(status)}
			data-status={status ?? undefined}
		>
			<span
				className="tasks-chip-dot"
				aria-hidden="true"
			/>
			{label ?? runStatusLabel(status)}
		</span>
	);
}

function ConfigRow({ label, children }) {
	return (
		<>
			<dt>{label}</dt>
			<dd>{children}</dd>
		</>
	);
}

export default function TaskDetails({
	task,
	activeRun,
	models = [],
	projects = [],
	history,
	onClose,
	onEdit,
	onDelete,
	onRunNow,
	onCancelRun,
	onTogglePause,
	onLoadMore,
	onOpenRun,
	chatBusy = false,
	busy = null,
	now = Date.now(),
}) {
	const state = taskState(task, activeRun);
	const next = nextRunSummary(task, now);
	const project = task.projectId
		? projects.find((item) => item.id === task.projectId) ?? null
		: null;
	const fallback = task.fallback?.[0] ?? null;
	const rows = history?.runs ?? [];
	const total = history?.total ?? 0;

	return (
		<aside
			className="aero-panel sk-panel tasks-detail"
			aria-label={`Details for ${task.name}`}
		>
			<header className="tasks-detail-header">
				<div className="min-w-0">
					<h2 className="tasks-detail-title">{task.name}</h2>
					<div className="tasks-detail-meta">
						<StatusChip
							tone={state.tone}
							label={state.label}
						/>
						{task.nextRunAt != null && task.enabled && (
							<span className="tasks-muted">
								Next {next.text} · {next.detail}
							</span>
						)}
					</div>
				</div>
				<button
					type="button"
					className="aero-control sk-button grid size-8 shrink-0 place-items-center"
					onClick={onClose}
					aria-label="Close details"
				>
					<FiX aria-hidden="true" />
				</button>
			</header>

			<div className="tasks-detail-actions">
				<button
					type="button"
					className="aero-primary sk-button sk-primary tasks-button tasks-button--primary"
					onClick={onRunNow}
					disabled={busy === "run"}
				>
					<FiPlay aria-hidden="true" /> Run now
				</button>
				{activeRun && (
					<button
						type="button"
						className="aero-control sk-button tasks-button"
						onClick={onCancelRun}
						disabled={busy === "cancel"}
					>
						<FiX aria-hidden="true" /> Cancel run
					</button>
				)}
				<button
					type="button"
					className="aero-control sk-button tasks-button"
					onClick={onTogglePause}
					disabled={busy === "pause"}
				>
					{task.enabled ? <FiPause aria-hidden="true" /> : <FiPlay aria-hidden="true" />}
					{task.enabled ? "Pause" : "Resume"}
				</button>
				<button
					type="button"
					className="aero-control sk-button tasks-button"
					onClick={onEdit}
				>
					<FiEdit2 aria-hidden="true" /> Edit
				</button>
				<button
					type="button"
					className="aero-control sk-button tasks-button tasks-button--danger"
					onClick={onDelete}
				>
					<FiTrash2 aria-hidden="true" /> Delete
				</button>
			</div>

			{!task.enabled && (
				<p className="tasks-inline-note">
					<FiPause aria-hidden="true" /> This task is paused. Run now still starts a manual run.
				</p>
			)}
			{activeRun && (
				<p className="tasks-inline-note">
					{activeRun.status === "blocked" ? (
						<FiAlertTriangle aria-hidden="true" />
					) : (
						<FiClock aria-hidden="true" />
					)}
					{runExplanation(activeRun, models)}
				</p>
			)}

			<section
				className="tasks-detail-section"
				aria-label="Task configuration"
			>
				<h3 className="tasks-section-title">Configuration</h3>
				<dl className="tasks-config">
					<ConfigRow label="Schedule">{describeSchedule(task)}</ConfigRow>
					<ConfigRow label="Timezone">{task.timezone}</ConfigRow>
					<ConfigRow label="Model">{modelLabel(models, task.model)}</ConfigRow>
					<ConfigRow label="Fallback">
						{fallback ? modelLabel(models, fallback) : "None — a run is skipped if the model is unavailable"}
					</ConfigRow>
					<ConfigRow label="Permissions">{task.permissionMode}</ConfigRow>
					<ConfigRow label="Missed runs">{describeMissedPolicy(task.missedPolicy)}</ConfigRow>
					<ConfigRow label="Workspace">
						{project ? project.name : task.projectId ? "Saved workspace (unavailable)" : "None (casual context)"}
					</ConfigRow>
					<ConfigRow label="Max run time">
						{task.budget?.maxWallClockMs
							? `${Math.round(task.budget.maxWallClockMs / 60_000)} minutes`
							: "App default"}
					</ConfigRow>
					<ConfigRow label="Created">{formatDateTime(task.createdAt, { timezone: task.timezone })}</ConfigRow>
					<ConfigRow label="Updated">{formatDateTime(task.updatedAt, { timezone: task.timezone })}</ConfigRow>
				</dl>
			</section>

			<section
				className="tasks-detail-section"
				aria-label="Instructions"
			>
				<h3 className="tasks-section-title">Instructions</h3>
				<pre className="tasks-prompt">{task.prompt}</pre>
			</section>

			<section
				className="tasks-detail-section"
				aria-label="Execution history"
			>
				<div className="tasks-section-header">
					<h3 className="tasks-section-title">History</h3>
					<span className="tasks-muted">
						{total} run{total === 1 ? "" : "s"}
					</span>
				</div>
				{history?.error && (
					<p
						role="alert"
						className="tasks-form-error"
					>
						{history.error}
					</p>
				)}
				{!rows.length ? (
					<p className="tasks-muted tasks-history-empty">
						{history?.loading ? "Loading history…" : "No runs yet. Use Run now to try it immediately."}
					</p>
				) : (
					<div className="tasks-history-scroll">
						<table className="tasks-table tasks-history-table">
							<thead>
								<tr>
									<th scope="col">Scheduled</th>
									<th scope="col">Status</th>
									<th scope="col">Started</th>
									<th scope="col">Duration</th>
									<th scope="col">Details</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((run) => (
									<tr key={run.id}>
										<td>
											<span className="tasks-nowrap">
												{formatDateTime(run.scheduledFor, { timezone: task.timezone })}
											</span>
											<span className="tasks-muted tasks-block">
												{run.trigger === "manual" ? "Manual run" : "Scheduled run"}
											</span>
										</td>
										<td>
											<StatusChip status={run.status} />
										</td>
										<td>
											{run.startedAt
												? `${formatTime(run.startedAt, { timezone: task.timezone })}`
												: "—"}
											{run.finishedAt && run.startedAt && (
												<span className="tasks-muted tasks-block">
													ended {formatTime(run.finishedAt, { timezone: task.timezone })}
												</span>
											)}
										</td>
										<td>{formatDuration(run.startedAt, run.finishedAt)}</td>
										<td>
											<span className="tasks-history-reason">
												{runExplanation(run, models)}
											</span>
											{run.model && run.status === "completed" && (
												<span className="tasks-muted tasks-block">
													{modelLabel(models, run.model)}
												</span>
											)}
											{run.sessionId && onOpenRun && run.finishedAt && (
												<button
													type="button"
													className="aero-control sk-button tasks-button"
													disabled={chatBusy}
													onClick={() => onOpenRun(run.sessionId)}
												>
													Open chat
												</button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{rows.length < total && (
					<button
						type="button"
						className="aero-control sk-button tasks-button tasks-load-more"
						onClick={onLoadMore}
						disabled={history?.loading}
					>
						<FiChevronDown aria-hidden="true" />
						{history?.loading ? "Loading…" : `Load more (${total - rows.length} left)`}
					</button>
				)}
			</section>
		</aside>
	);
}

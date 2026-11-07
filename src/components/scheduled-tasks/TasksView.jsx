import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	FiAlertTriangle,
	FiCalendar,
	FiCheckCircle,
	FiClock,
	FiEdit2,
	FiPause,
	FiPlay,
	FiPlus,
	FiRefreshCw,
	FiSearch,
	FiTrash2,
} from "react-icons/fi";
import { TextField } from "../FormControls";
import TaskDetails, { StatusChip } from "./TaskDetails.jsx";
import TaskEditor from "./TaskEditor.jsx";
import {
	activeRunFor,
	applyScheduledEvent,
	describeRepeatShort,
	eventTouchesTask,
	filterTasks,
	formatDateTime,
	isActiveRun,
	modelLabel,
	nextRunSummary,
	relativeTime,
	runStatusLabel,
	summarize,
	taskState,
} from "../../lib/scheduledTasks.mjs";
import "./tasks.css";

const PAGE_SIZE = 25;
const FILTERS = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Scheduled" },
	{ value: "running", label: "Active runs" },
	{ value: "paused", label: "Paused" },
	{ value: "attention", label: "Needs attention" },
];

function useNow() {
	// Keeps relative labels fresh without re-rendering on every event burst.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}

function OverviewCard({ icon, title, value, children, tone }) {
	return (
		<article
			className="aero-panel sk-panel sk-card sk-texture-satin tasks-card"
			data-tone={tone}
		>
			<header>
				<span
					className="tasks-card-icon"
					aria-hidden="true"
				>
					{icon}
				</span>
				<h2>{title}</h2>
				<span className="tasks-card-value">{value}</span>
			</header>
			<div className="tasks-card-body">{children}</div>
		</article>
	);
}

function DeleteDialog({ task, runs, busy, error, onCancel, onConfirm }) {
	const ref = useRef(null);
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => dialog?.close();
	}, []);
	const active = runs.some((run) => isActiveRun(run));
	return (
		<dialog
			ref={ref}
			className="aero-dialog sk-window sk-dialog m-auto w-[min(460px,calc(100vw-32px))] p-0"
			aria-labelledby="delete-task-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onCancel();
			}}
		>
			<div className="tasks-delete">
				<header className="aero-header sk-window-header sk-texture-grain tasks-editor-header">
					<h2
						id="delete-task-title"
						className="text-lg font-semibold"
					>
						Delete “{task.name}”?
					</h2>
				</header>
				<div className="tasks-delete-body">
					<p>
						The task stops running and its schedule is removed. Its execution history is kept
						so past runs stay visible.
					</p>
					{active && (
						<p className="tasks-inline-note">
							<FiAlertTriangle aria-hidden="true" /> An active run will be cancelled.
						</p>
					)}
					{error && (
						<p
							role="alert"
							className="tasks-form-error"
						>
							{error}
						</p>
					)}
				</div>
				<footer className="tasks-editor-footer">
					<button
						type="button"
						className="aero-control sk-button tasks-button"
						onClick={onCancel}
						disabled={busy}
						autoFocus
					>
						Cancel
					</button>
					<button
						type="button"
						className="aero-primary sk-button sk-primary tasks-button tasks-button--danger"
						onClick={onConfirm}
						disabled={busy}
					>
						{busy ? "Deleting…" : "Delete task"}
					</button>
				</footer>
			</div>
		</dialog>
	);
}

export default function TasksView({ models = [], projects = [], onOpenRun, chatBusy = false }) {
	const api = typeof window !== "undefined" ? window.api?.scheduledTasks ?? null : null;
	const [data, setData] = useState({ tasks: [], runs: [] });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [actionError, setActionError] = useState("");
	const [notice, setNotice] = useState("");
	const [selectedId, setSelectedId] = useState(null);
	const [history, setHistory] = useState({ runs: [], total: 0, loading: false, error: "" });
	const [editor, setEditor] = useState(null);
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	const [busy, setBusy] = useState(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const [refreshKey, setRefreshKey] = useState(0);
	const now = useNow();

	const dataRef = useRef(data);
	dataRef.current = data;
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;
	const historyTimer = useRef(null);

	const load = useCallback(
		async ({ quiet = false } = {}) => {
			if (!api) {
				setError("Scheduled tasks are not available in this build.");
				setLoading(false);
				return;
			}
			if (!quiet) setLoading(true);
			setError("");
			try {
				const [list, recent] = await Promise.all([
					api.list({}),
					api.history({ limit: 50 }),
				]);
				setData({
					tasks: Array.isArray(list) ? list : [],
					runs: Array.isArray(recent?.runs) ? recent.runs : [],
				});
			} catch (err) {
				setError(err?.message || "Could not load scheduled tasks.");
			} finally {
				setLoading(false);
			}
		},
		[api],
	);

	useEffect(() => {
		load();
	}, [load, refreshKey]);

	const loadHistory = useCallback(
		async (taskId, offset = 0) => {
			if (!api || !taskId) return;
			setHistory((current) =>
				offset
					? { ...current, loading: true, error: "" }
					: { runs: [], total: 0, loading: true, error: "" },
			);
			try {
				const result = await api.history({ taskId, limit: PAGE_SIZE, offset });
				if (selectedRef.current !== taskId) return;
				setHistory((current) => {
					const rows = offset ? [...current.runs, ...(result?.runs ?? [])] : result?.runs ?? [];
					const seen = new Set();
					return {
						runs: rows.filter((run) => (seen.has(run.id) ? false : seen.add(run.id))),
						total: result?.total ?? rows.length,
						loading: false,
						error: "",
					};
				});
			} catch (err) {
				if (selectedRef.current !== taskId) return;
				setHistory((current) => ({
					...current,
					loading: false,
					error: err?.message || "Could not load run history.",
				}));
			}
		},
		[api],
	);

	useEffect(() => {
		if (!selectedId) {
			setHistory({ runs: [], total: 0, loading: false, error: "" });
			return;
		}
		loadHistory(selectedId, 0);
	}, [selectedId, loadHistory]);

	// Live scheduler events are the source of truth for status changes; the
	// page never fabricates a local task state. The subscription is torn down on
	// unmount so leaving the page cannot leak listeners.
	useEffect(() => {
		if (!api?.onEvent) return undefined;
		const off = api.onEvent((event) => {
			const previous = dataRef.current;
			const next = applyScheduledEvent(previous, event);
			if (next !== previous) {
				dataRef.current = next;
				setData(next);
			}
			const taskId = selectedRef.current;
			if (taskId && eventTouchesTask(event, taskId, previous.runs)) {
				clearTimeout(historyTimer.current);
				historyTimer.current = setTimeout(() => loadHistory(taskId, 0), 200);
			}
		});
		return () => {
			clearTimeout(historyTimer.current);
			off?.();
		};
	}, [api, loadHistory]);

	const refreshAll = useCallback(async () => {
		const taskId = selectedRef.current;
		await load({ quiet: true });
		if (taskId) await loadHistory(taskId, 0);
	}, [load, loadHistory]);

	const act = useCallback(
		async (key, run, message) => {
			setBusy(key);
			setActionError("");
			setNotice("");
			try {
				const result = await run();
				if (message) setNotice(message);
				await refreshAll();
				return result;
			} catch (err) {
				setActionError(err?.message || "The action failed.");
				return null;
			} finally {
				setBusy(null);
			}
		},
		[refreshAll],
	);

	const summary = useMemo(() => summarize(data.tasks, data.runs, now), [data, now]);
	const visible = useMemo(
		() => filterTasks(data.tasks, data.runs, { query, filter }),
		[data, query, filter],
	);
	const selectedTask = data.tasks.find((task) => task.id === selectedId) ?? null;
	const selectedActiveRun = selectedTask ? activeRunFor(data.runs, selectedTask.id) : null;
	const taskById = useMemo(
		() => new Map(data.tasks.map((task) => [task.id, task])),
		[data.tasks],
	);

	const saveTask = async (payload, task) => {
		if (!api) throw new Error("Scheduled tasks are not available in this build.");
		if (task) await api.update(task.id, payload);
		else await api.create(payload);
		setEditor(null);
		setNotice(task ? "Task updated." : "Task created.");
		setActionError("");
		await refreshAll();
	};

	const deleteSelected = async () => {
		if (!confirmDelete || !api) return;
		setDeleteBusy(true);
		setDeleteError("");
		try {
			await api.delete(confirmDelete.id);
			setConfirmDelete(null);
			if (selectedRef.current === confirmDelete.id) setSelectedId(null);
			setNotice("Task deleted. Its run history is preserved.");
			setActionError("");
			await refreshAll();
		} catch (err) {
			setDeleteError(err?.message || "The task could not be deleted.");
		} finally {
			setDeleteBusy(false);
		}
	};

	const empty = !loading && !error && !data.tasks.length;

	return (
		<main
			className="aero-stage sk-app tasks-page"
			aria-label="Scheduled tasks"
		>
			<div className="tasks-content">
				<header className="tasks-heading">
					<div className="flex min-w-0 items-center gap-3">
						<span
							className="tasks-heading-icon"
							aria-hidden="true"
						>
							<FiCalendar size={18} />
						</span>
						<div>
							<h1>Tasks</h1>
							<p className="tasks-muted">
								Scheduled, unattended runs of your assistant.
							</p>
						</div>
					</div>
					<div className="tasks-heading-actions">
						<button
							type="button"
							className="aero-control sk-button tasks-button"
							onClick={() => setRefreshKey((key) => key + 1)}
							disabled={loading}
						>
							<FiRefreshCw aria-hidden="true" /> Refresh
						</button>
						<button
							type="button"
							className="aero-primary sk-button sk-primary tasks-button tasks-button--primary"
							onClick={() => setEditor({ task: null })}
							disabled={!api}
						>
							<FiPlus aria-hidden="true" /> Create task
						</button>
					</div>
				</header>

				<p className="tasks-runtime-note">
					<FiClock aria-hidden="true" />
					<span>
						Tasks run inside Continuum while the app is open. If the app is closed or the
						computer is asleep at the scheduled time, the run happens after Continuum wakes
						or starts again — following each task’s missed-run policy.
					</span>
				</p>

				{error && (
					<p
						role="alert"
						className="tasks-banner tasks-banner--error"
					>
						<FiAlertTriangle aria-hidden="true" /> {error}
						<button
							type="button"
							className="aero-control sk-button tasks-button"
							onClick={() => setRefreshKey((key) => key + 1)}
						>
							Retry
						</button>
					</p>
				)}
				{actionError && (
					<p
						role="alert"
						className="tasks-banner tasks-banner--error"
					>
						<FiAlertTriangle aria-hidden="true" /> {actionError}
						<button
							type="button"
							className="aero-control sk-button tasks-button"
							onClick={() => setActionError("")}
						>
							Dismiss
						</button>
					</p>
				)}
				{notice && (
					<p
						className="tasks-banner tasks-banner--notice"
						role="status"
					>
						<FiCheckCircle aria-hidden="true" /> {notice}
					</p>
				)}

				<section
					className="tasks-overview"
					aria-label="Overview"
				>
					<OverviewCard
						icon={<FiCalendar />}
						title="Upcoming"
						value={summary.upcoming.length}
						tone="neutral"
					>
						{summary.upcoming.length ? (
							<ul className="tasks-mini-list">
								{summary.upcoming.slice(0, 3).map((task) => (
									<li key={task.id}>
										<button
											type="button"
											className="tasks-link"
											onClick={() => setSelectedId(task.id)}
										>
											{task.name}
										</button>
										<span className="tasks-muted">
											{relativeTime(task.nextRunAt, now)}
										</span>
									</li>
								))}
							</ul>
						) : (
							<p className="tasks-muted">Nothing scheduled.</p>
						)}
					</OverviewCard>
					<OverviewCard
						icon={<FiPlay />}
						title="Running now"
						value={summary.running.length}
						tone={summary.running.length ? "active" : "neutral"}
					>
						{summary.running.length ? (
							<ul className="tasks-mini-list">
								{summary.running.map((task) => {
									const run = activeRunFor(data.runs, task.id);
									return (
										<li key={task.id}>
											<button
												type="button"
												className="tasks-link"
												onClick={() => setSelectedId(task.id)}
											>
												{task.name}
											</button>
											<span className="tasks-muted">
												{run ? runStatusLabel(run.status) : "Active"}
											</span>
										</li>
									);
								})}
							</ul>
						) : (
							<p className="tasks-muted">Nothing is running.</p>
						)}
					</OverviewCard>
					<OverviewCard
						icon={<FiPause />}
						title="Paused"
						value={summary.paused.length}
						tone="neutral"
					>
						{summary.paused.length ? (
							<ul className="tasks-mini-list">
								{summary.paused.slice(0, 3).map((task) => (
									<li key={task.id}>
										<button
											type="button"
											className="tasks-link"
											onClick={() => setSelectedId(task.id)}
										>
											{task.name}
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="tasks-muted">No paused tasks.</p>
						)}
					</OverviewCard>
					<OverviewCard
						icon={<FiClock />}
						title="Recent results"
						value={summary.recent.length}
						tone="neutral"
					>
						{summary.recent.length ? (
							<ul className="tasks-mini-list">
								{summary.recent.slice(0, 4).map((run) => {
									const task = taskById.get(run.taskId);
									return (
										<li key={run.id}>
											<button
												type="button"
												className="tasks-link"
												onClick={() => task && setSelectedId(task.id)}
												disabled={!task}
											>
												{task?.name ?? "Deleted task"}
											</button>
											<StatusChip status={run.status} />
										</li>
									);
								})}
							</ul>
						) : (
							<p className="tasks-muted">No runs recorded yet.</p>
						)}
					</OverviewCard>
				</section>

				<div className={`tasks-layout${selectedTask ? " tasks-layout--detail" : ""}`}>
					<section
						className="tasks-list-panel"
						aria-label="Task list"
					>
						<div className="tasks-toolbar">
							<TextField
								frameClassName="aero-well sk-well flex min-h-8 flex-1 items-center text-[var(--text-primary)]"
								type="search"
								aria-label="Search tasks"
								placeholder="Search tasks…"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
							<div
								className="tasks-filters"
								role="group"
								aria-label="Filter tasks"
							>
								{FILTERS.map((option) => (
									<button
										key={option.value}
										type="button"
										className="aero-control sk-button tasks-filter"
										aria-pressed={filter === option.value}
										onClick={() => setFilter(option.value)}
									>
										{option.label}
									</button>
								))}
							</div>
						</div>

						{loading ? (
							<p
								role="status"
								className="tasks-placeholder"
							>
								Loading scheduled tasks…
							</p>
						) : error ? null : empty ? (
							<div className="aero-empty sk-empty tasks-empty">
								<FiCalendar
									className="mx-auto mb-3 size-8"
									aria-hidden="true"
								/>
								<p>No scheduled tasks yet.</p>
								<p className="tasks-muted">
									Create a task to have Continuum run a prompt on a schedule, even when
									you are not in that chat.
								</p>
								<button
									type="button"
									className="aero-primary sk-button sk-primary tasks-button tasks-button--primary"
									onClick={() => setEditor({ task: null })}
								>
									<FiPlus aria-hidden="true" /> Create your first task
								</button>
							</div>
						) : !visible.length ? (
							<p className="tasks-placeholder">
								No tasks match this search or filter.
							</p>
						) : (
							<>
								<div className="tasks-table-scroll">
									<table className="tasks-table tasks-list-table">
										<thead>
											<tr>
												<th scope="col">Task</th>
												<th scope="col">Next run</th>
												<th scope="col">Repeats</th>
												<th scope="col">Model</th>
												<th scope="col">Status</th>
												<th scope="col">Last result</th>
												<th scope="col">
													<span className="sr-only">Actions</span>
												</th>
											</tr>
										</thead>
										<tbody>
											{visible.map((task) => {
												const activeRun = activeRunFor(data.runs, task.id);
												const state = taskState(task, activeRun);
												const next = nextRunSummary(task, now);
												const lastRun = data.runs.find((run) => run.taskId === task.id);
												return (
													<tr
														key={task.id}
														data-selected={task.id === selectedId ? "true" : undefined}
													>
														<td>
															<button
																type="button"
																className="tasks-name"
																onClick={() => setSelectedId(task.id)}
																aria-current={task.id === selectedId ? "true" : undefined}
															>
																{task.name}
															</button>
															<span className="tasks-muted tasks-block tasks-clamp">
																{task.prompt}
															</span>
														</td>
														<td>
															<span className="tasks-nowrap">{next.text}</span>
															{next.detail && (
																<span
																	className={`tasks-block tasks-muted${next.overdue ? " tasks-overdue" : ""}`}
																>
																	{next.detail}
																</span>
															)}
														</td>
														<td className="tasks-nowrap">{describeRepeatShort(task)}</td>
														<td className="tasks-cell-model">{modelLabel(models, task.model)}</td>
														<td>
															<StatusChip
																tone={state.tone}
																label={state.label}
															/>
														</td>
														<td>
															{lastRun ? (
																<>
																	<StatusChip status={lastRun.status} />
																	<span className="tasks-muted tasks-block">
																		{formatDateTime(lastRun.scheduledFor, { timezone: task.timezone })}
																	</span>
																</>
															) : (
																<span className="tasks-muted">Never run</span>
															)}
														</td>
														<td>
															<div
																className="tasks-row-actions"
																onClick={(event) => event.stopPropagation()}
															>
																<button
																	type="button"
																	className="aero-orb sk-icon-button tasks-icon-button"
																	title="Run now"
																	aria-label={`Run ${task.name} now`}
																	disabled={busy === `run:${task.id}`}
																	onClick={() =>
																		act(
																			`run:${task.id}`,
																			() => api.runNow(task.id),
																			`“${task.name}” was queued and starts as soon as it is this task's turn.`,
																		)
																	}
																>
																	<FiPlay aria-hidden="true" />
																</button>
																<button
																	type="button"
																	className="aero-orb sk-icon-button tasks-icon-button"
																	title={task.enabled ? "Pause" : "Resume"}
																	aria-label={`${task.enabled ? "Pause" : "Resume"} ${task.name}`}
																	disabled={busy === `pause:${task.id}`}
																	onClick={() =>
																		act(
																			`pause:${task.id}`,
																			() =>
																				task.enabled
																					? api.pause(task.id)
																					: api.resume(task.id),
																			task.enabled ? "Task paused." : "Task resumed.",
																		)
																	}
																>
																	{task.enabled ? (
																		<FiPause aria-hidden="true" />
																	) : (
																		<FiPlay aria-hidden="true" />
																	)}
																</button>
																<button
																	type="button"
																	className="aero-orb sk-icon-button tasks-icon-button"
																	title="Edit"
																	aria-label={`Edit ${task.name}`}
																	onClick={() => setEditor({ task })}
																>
																	<FiEdit2 aria-hidden="true" />
																</button>
																<button
																	type="button"
																	className="aero-orb sk-icon-button tasks-icon-button tasks-icon-button--danger"
																	title="Delete"
																	aria-label={`Delete ${task.name}`}
																	onClick={() => {
																		setDeleteError("");
																		setConfirmDelete(task);
																	}}
																>
																	<FiTrash2 aria-hidden="true" />
																</button>
															</div>
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
								<p className="tasks-muted tasks-count">
									{visible.length} of {data.tasks.length} task
									{data.tasks.length === 1 ? "" : "s"}
								</p>
							</>
						)}
					</section>

					{selectedTask && (
						<TaskDetails
							task={selectedTask}
							activeRun={selectedActiveRun}
							models={models}
							projects={projects}
							history={history}
							onOpenRun={onOpenRun}
							chatBusy={chatBusy}
							now={now}
							busy={busy}
							onClose={() => setSelectedId(null)}
							onEdit={() => setEditor({ task: selectedTask })}
							onDelete={() => {
								setDeleteError("");
								setConfirmDelete(selectedTask);
							}}
							onRunNow={() =>
								act(
									"run",
									() => api.runNow(selectedTask.id),
									`“${selectedTask.name}” was queued and starts as soon as it is this task's turn.`,
								)
							}
							onCancelRun={() =>
								selectedActiveRun &&
								act(
									"cancel",
									() => api.cancel({ runId: selectedActiveRun.id }),
									"Run cancelled.",
								)
							}
							onTogglePause={() =>
								act(
									"pause",
									() =>
										selectedTask.enabled
											? api.pause(selectedTask.id)
											: api.resume(selectedTask.id),
									selectedTask.enabled ? "Task paused." : "Task resumed.",
								)
							}
							onLoadMore={() => loadHistory(selectedTask.id, history.runs.length)}
						/>
					)}
				</div>
			</div>

			{editor && (
				<TaskEditor
					key={editor.task?.id ?? "new"}
					task={editor.task}
					models={models}
					projects={projects}
					onClose={() => setEditor(null)}
					onSave={saveTask}
				/>
			)}
			{confirmDelete && (
				<DeleteDialog
					task={confirmDelete}
					runs={data.runs.filter((run) => run.taskId === confirmDelete.id)}
					busy={deleteBusy}
					error={deleteError}
					onCancel={() => setConfirmDelete(null)}
					onConfirm={deleteSelected}
				/>
			)}
		</main>
	);
}

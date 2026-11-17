import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	FiAlertTriangle,
	FiCalendar,
	FiClock,
	FiEdit2,
	FiPause,
	FiPlay,
	FiPlus,
	FiRefreshCw,
	FiX,
	FiTrash2,
} from "react-icons/fi";
import { TextField, SelectField } from "../FormControls";
import { StatusChip } from "./TaskDetails.jsx";
import TaskEditor from "./TaskEditor.jsx";
import TaskResults from "./TaskResults.jsx";
import {
	activeRunFor,
	applyScheduledEvent,
	describeRepeatShort,
	filterTasks,
	isActiveRun,
	modelLabel,
	nextRunSummary,
	summarize,
	taskState,
} from "../../lib/scheduledTasks.mjs";
import { useAppToast } from "../../hooks/useAppToast.jsx";
import "./tasks.css";

const PAGE_SIZE = 10;
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

function OverviewCard({ icon, title, value, tone }) {
	return (
		<article
			className="material-panel sk-panel sk-card sk-texture-satin tasks-card"
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
			className="material-dialog sk-window sk-dialog m-auto w-[min(460px,calc(100vw-32px))] p-0"
			aria-labelledby="delete-task-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onCancel();
			}}
		>
			<div className="tasks-delete">
				<header className="material-header sk-window-header sk-texture-grain tasks-editor-header">
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
						className="material-control sk-button tasks-button"
						onClick={onCancel}
						disabled={busy}
						autoFocus
					>
						Cancel
					</button>
					<button
						type="button"
						className="material-primary sk-button sk-primary tasks-button tasks-button--danger"
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
	const notify = useAppToast();
	const [selectedId, setSelectedId] = useState(null);
	const [resultStatus, setResultStatus] = useState("completed");
	const [mobileView, setMobileView] = useState("tasks");
	const [history, setHistory] = useState({ runs: [], total: 0, offset: 0, loading: false, error: "" });
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
	const historyRequest = useRef(0);
	const historyOffsetRef = useRef(0);
	historyOffsetRef.current = history.offset;
	const resultStatusRef = useRef(resultStatus);
	resultStatusRef.current = resultStatus;

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
		async (taskId, offset = historyOffsetRef.current) => {
			if (!api || taskId !== selectedRef.current || resultStatus !== resultStatusRef.current) return;
			const request = ++historyRequest.current;
			setHistory(current => ({ ...current, loading: true, error: "" }));
			try {
				const result = await api.history({ taskId, status: resultStatus === "all" ? null : resultStatus, limit: PAGE_SIZE, offset });
				if (request !== historyRequest.current) return;
				if (offset > 0 && offset >= (result?.total ?? 0)) {
					return loadHistory(taskId, Math.max(0, Math.ceil((result?.total ?? 0) / PAGE_SIZE) - 1) * PAGE_SIZE);
				}
				setHistory((current) => {
					const rows = result?.runs ?? [];
					const seen = new Set();
					return {
						runs: rows.filter((run) => (seen.has(run.id) ? false : seen.add(run.id))),
						total: result?.total ?? rows.length,
						offset,
						loading: false,
						error: "",
					};
				});
			} catch (err) {
				if (request !== historyRequest.current) return;
				setHistory((current) => ({
					...current,
					loading: false,
					error: err?.message || "Could not load run history.",
				}));
			}
		},
		[api, resultStatus],
	);

	useEffect(() => {
		setHistory({ runs: [], total: 0, offset: 0, loading: true, error: "" });
		loadHistory(selectedId, 0);
		return () => { ++historyRequest.current; };
	}, [selectedId, loadHistory, refreshKey]);

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
			if (event?.type?.startsWith("run-")) {
				clearTimeout(historyTimer.current);
				historyTimer.current = setTimeout(() => loadHistory(taskId), 200);
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
		await loadHistory(taskId);
	}, [load, loadHistory]);

	const act = useCallback(
		async (key, run, message) => {
			setBusy(key);
			try {
				const result = await run();
				if (message) notify(message, "success");
				await refreshAll();
				return result;
			} catch (err) {
				notify(err?.message || "The action failed.", "error");
				return null;
			} finally {
				setBusy(null);
			}
		},
		[refreshAll, notify],
	);

	const summary = useMemo(() => summarize(data.tasks, data.runs, now), [data, now]);
	const visible = useMemo(
		() => filterTasks(data.tasks, data.runs, { query, filter }),
		[data, query, filter],
	);


	const saveTask = async (payload, task) => {
		if (!api) throw new Error("Scheduled tasks are not available in this build.");
		if (task) await api.update(task.id, payload);
		else await api.create(payload);
		setEditor(null);
		notify(task ? "Task updated." : "Task created.", "success");
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
			notify("Task deleted. Its run history is preserved.", "success");
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
			className="material-stage sk-app tasks-page"
			aria-label="Scheduled tasks"
		>
			<div className="tasks-content">
				<header className="tasks-heading">
					<div className="flex min-w-0 items-center gap-3">
						<span
							className="material-orb sk-icon-button tasks-heading-icon"
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
							className="material-control sk-button tasks-button"
							onClick={() => setRefreshKey((key) => key + 1)}
							disabled={loading}
						>
							<FiRefreshCw aria-hidden="true" /> Refresh
						</button>
						<button
							type="button"
							className="material-primary sk-button sk-primary tasks-button tasks-button--primary"
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
							className="material-control sk-button tasks-button"
							onClick={() => setRefreshKey((key) => key + 1)}
						>
							Retry
						</button>
					</p>
				)}

				<section className="tasks-overview" aria-label="Overview">
					<OverviewCard icon={<FiCalendar />} title="Upcoming" value={summary.upcoming.length} tone="neutral" />
					<OverviewCard icon={<FiPlay />} title="Running now" value={summary.running.length} tone={summary.running.length ? "active" : "neutral"} />
					<OverviewCard icon={<FiPause />} title="Paused" value={summary.paused.length} tone="neutral" />
				</section>

				<div className="tasks-mobile-tabs" role="group" aria-label="Tasks page view">
					<button className="material-control sk-button tasks-filter" aria-pressed={mobileView === "tasks"} onClick={() => setMobileView("tasks")}>Scheduled tasks</button>
					<button className="material-control sk-button tasks-filter" aria-pressed={mobileView === "results"} onClick={() => setMobileView("results")}>Results</button>
				</div>
				<div className="tasks-layout tasks-layout--results" data-mobile-view={mobileView}>
					<section
						className="tasks-list-panel"
						aria-label="Task list"
					>
						<h2 className="tasks-panel-title">Scheduled tasks</h2>
						<div className="tasks-toolbar">
							<TextField
								frameClassName="material-well sk-well flex min-h-8 flex-1 items-center text-[var(--text-primary)]"
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
										className="material-control sk-button tasks-filter"
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
							<div className="material-empty sk-empty tasks-empty">
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
									className="material-primary sk-button sk-primary tasks-button tasks-button--primary"
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
												<th scope="col">Status</th>
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

												return (
													<tr
														key={task.id}
														data-selected={task.id === selectedId ? "true" : undefined}
													>
														<td>
															<button
																type="button"
																className="tasks-name"
																onClick={() => { setSelectedId(task.id); setMobileView("results"); }}
																aria-current={task.id === selectedId ? "true" : undefined}
															>
																{task.name}
															</button>
															<span className="tasks-muted tasks-block tasks-clamp">
																{describeRepeatShort(task)} · {modelLabel(models, task.model)}
															</span>
														</td>
														<td>
															<span>{next.detail || next.text}</span>

														</td>
														<td>
															<StatusChip
																tone={state.tone}
																label={state.label}
															/>
														</td>
														<td>
															<SelectField
																className="tasks-task-actions"
																aria-label={`Actions for ${task.name}`}
																value=""
																triggerLabel="•••"
																hideChevron
																items={[
																	{ value: "run", label: "Run now", icon: <FiPlay />, disabled: busy === `run:${task.id}` },
																	{ value: "pause", label: task.enabled ? "Pause" : "Resume", icon: task.enabled ? <FiPause /> : <FiPlay />, disabled: busy === `pause:${task.id}` },
																	...(activeRun ? [{ value: "cancel", label: "Cancel run", icon: <FiX />, disabled: busy === `cancel:${task.id}` }] : []),
																	{ value: "edit", label: "Edit", icon: <FiEdit2 /> },
																	{ value: "delete", label: "Delete", icon: <FiTrash2 /> },
																]}
																onChange={({ target: { value } }) => {
																	if (value === "run") act(`run:${task.id}`, () => api.runNow(task.id), `“${task.name}” was queued and starts as soon as it is this task's turn.`);
																	if (value === "pause") act(`pause:${task.id}`, () => task.enabled ? api.pause(task.id) : api.resume(task.id), task.enabled ? "Task paused." : "Task resumed.");
																	if (value === "cancel" && activeRun) act(`cancel:${task.id}`, () => api.cancel({ runId: activeRun.id }), "Run cancelled.");
																	if (value === "edit") setEditor({ task });
																	if (value === "delete") { setDeleteError(""); setConfirmDelete(task); }
																}}
															/>
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

					<TaskResults tasks={data.tasks} selectedId={selectedId} onSelectTask={setSelectedId}
						status={resultStatus} onStatusChange={setResultStatus} history={history}
						pageSize={PAGE_SIZE} onPageChange={page => loadHistory(selectedId, (page - 1) * PAGE_SIZE)}
						onRetry={() => loadHistory(selectedId)} onOpenRun={onOpenRun} chatBusy={chatBusy} now={now} />
				</div>
			</div>

			{editor && (
				<TaskEditor
					key={editor.task?.id ?? "new"}
					task={editor.task}
					tasks={data.tasks}
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

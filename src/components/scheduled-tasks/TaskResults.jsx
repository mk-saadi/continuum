import React, { useEffect, useRef } from "react";
import { SelectField } from "../FormControls";
import { FiExternalLink } from "react-icons/fi";
import { StatusChip } from "./TaskDetails.jsx";
import { formatDateTime, formatDuration, runExplanation } from "../../lib/scheduledTasks.mjs";

function dayLabel(timestamp, now) {
	const date = new Date(timestamp);
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (date.toDateString() === today.toDateString()) return "Today";
	if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
	return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function TaskResults({ tasks, selectedId, onSelectTask, status, onStatusChange,
	history, pageSize, onPageChange, onRetry, onOpenRun, chatBusy, now }) {
	const scrollRef = useRef(null);
	const page = Math.floor((history.offset ?? 0) / pageSize) + 1;
	const pageCount = Math.max(1, Math.ceil(history.total / pageSize));
	useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [history.offset, selectedId, status]);
	const taskById = new Map(tasks.map(task => [task.id, task]));
	const groups = new Map();
	for (const run of history.runs) {
		const day = dayLabel(run.scheduledFor, now);
		if (!groups.has(day)) groups.set(day, []);
		groups.get(day).push(run);
	}
	return (
		<aside className="material-panel sk-panel tasks-results" aria-label="Results">
			<header className="tasks-results-header">
				<div className="tasks-section-header">
					<h2 className="tasks-panel-title">Results</h2>
					<span className="tasks-muted">{history.total} run{history.total === 1 ? "" : "s"}</span>
				</div>
				<div className="tasks-result-filters">
					<SelectField aria-label="Results task" value={selectedId ?? ""} onChange={event => onSelectTask(event.target.value || null)}>
						<option value="">All tasks</option>
						{tasks.map(task => <option key={task.id} value={task.id}>{task.name}</option>)}
					</SelectField>
					<SelectField aria-label="Result status" value={status} onChange={event => onStatusChange(event.target.value)}>
						<option value="completed">Completed</option>
						<option value="failed">Failed</option>
						<option value="interrupted">Interrupted</option>
						<option value="all">All runs</option>
					</SelectField>
				</div>
				{selectedId && <button className="tasks-link" onClick={() => onSelectTask(null)}>Show all tasks</button>}
			</header>
			<div ref={scrollRef} className="tasks-results-scroll" aria-busy={history.loading}>
				{history.error && <div className="tasks-results-message" role="alert"><p className="tasks-form-error">{history.error}</p><button className="material-control sk-button tasks-button" onClick={onRetry}>Retry results</button></div>}
				{!history.runs.length && !history.error && <p className="tasks-placeholder" role="status">{history.loading ? "Loading results…" : "No runs match these filters."}</p>}
				{[...groups].map(([day, runs]) => <section className="tasks-result-group" key={day} aria-label={day}>
					<h3>{day}</h3>
					{runs.map(run => {
						const task = taskById.get(run.taskId);
						const canOpen = Boolean(run.sessionId && run.finishedAt && onOpenRun);
						const content = <>
							<div className="tasks-result-title"><strong>{task?.name ?? "Deleted task"}</strong>{canOpen && <FiExternalLink aria-hidden="true" />}</div>
							<div className="tasks-result-meta"><StatusChip status={run.status} /><span>{formatDateTime(run.scheduledFor)}</span><span>{formatDuration(run.startedAt, run.finishedAt)}</span></div>
							{run.status !== "completed" && <span className="tasks-muted tasks-block">{runExplanation(run)}</span>}
							{!canOpen && <span className="tasks-muted">No saved chat</span>}
						</>;
						return canOpen ? <button type="button" key={run.id} className="tasks-result-row" disabled={chatBusy} onClick={() => onOpenRun(run.sessionId)} aria-label={`Open chat for ${task?.name ?? "Deleted task"}, ${formatDateTime(run.scheduledFor)}`}>{content}</button>
							: <div key={run.id} className="tasks-result-row">{content}</div>;
					})}
				</section>)}
			</div>
			<nav className="project-pagination tasks-results-pagination" aria-label="Results pagination">
				<span className="tasks-muted" role="status">{history.total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, history.total)} of {history.total} runs</span>
				<button type="button" className="material-control sk-button material-fill sk-fill tasks-button" disabled={history.loading || page === 1} onClick={() => onPageChange(page - 1)}>Previous</button>
				<span className="tasks-muted">Page {page} of {pageCount}</span>
				<button type="button" className="material-control sk-button material-fill sk-fill tasks-button" disabled={history.loading || page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</button>
			</nav>
		</aside>
	);
}

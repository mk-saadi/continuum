import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { CheckboxField, NumberField, SelectField, TextAreaField, TextField } from "../FormControls";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from "../../lib/permissionModes.mjs";
import {
	MISSED_POLICY_LABELS,
	WEEKDAY_LONG,
	buildTaskPayload,
	draftFromTask,
	modelLabel,
	timezoneOptions,
} from "../../lib/scheduledTasks.mjs";
import "./tasks.css";

const SCHEDULE_TYPES = [
	{ value: "once", label: "One time" },
	{ value: "daily", label: "Every day" },
	{ value: "every_n_days", label: "Every N days" },
	{ value: "weekdays", label: "Selected weekdays" },
];

const MISSED_OPTIONS = ["grace", "skip", "catch_up"].map((value) => ({
	value,
	label: MISSED_POLICY_LABELS[value],
}));

// The stored model must always be selectable, even after it was uninstalled or
// its provider was removed, so editing can never silently rewrite it.
function modelOptions(models, currentId, placeholder) {
	const options = (Array.isArray(models) ? models : [])
		.filter((model) => model?.id)
		.map((model) => ({ value: model.id, label: model.name || model.id }));
	if (currentId && !options.some((option) => option.value === currentId)) {
		options.unshift({
			value: currentId,
			label: `${modelLabel([], currentId)} (currently saved)`,
		});
	}
	return [{ value: "", label: placeholder }, ...options];
}

export default function TaskEditor({ task = null, models = [], projects = [], onClose, onSave }) {
	const dialogRef = useRef(null);
	const timezoneId = useId();
	const zones = useMemo(timezoneOptions, []);
	const [draft, setDraft] = useState(() => draftFromTask(task));
	const [errors, setErrors] = useState({});
	const [formError, setFormError] = useState("");
	const [warnings, setWarnings] = useState([]);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const dialog = dialogRef.current;
		dialog?.showModal();
		return () => dialog?.close();
	}, []);

	// A validation error must never look like a muted hint, so errors are
	// rendered in the warning colour inside the field's hint slot.
	const withError = (field, hint) =>
		errors[field] ? (
			<span
				className="tasks-hint-error"
				role="alert"
			>
				{errors[field]}
			</span>
		) : (
			hint
		);
	const update = (patch) => {
		setDraft((current) => ({ ...current, ...patch }));
		setErrors((current) => {
			const next = { ...current };
			for (const key of Object.keys(patch)) delete next[key];
			return next;
		});
	};
	const updateSchedule = (patch) => update({ ...patch, scheduleTouched: true });

	const projectOptions = useMemo(() => {
		const options = (Array.isArray(projects) ? projects : []).map((project) => ({
			value: project.id,
			label: project.name || project.id,
		}));
		if (draft.projectId && !options.some((option) => option.value === draft.projectId))
			options.unshift({ value: draft.projectId, label: "Saved workspace (unavailable)" });
		return [{ value: "", label: "No workspace (casual context)" }, ...options];
	}, [projects, draft.projectId]);

	const permissionHint = useMemo(() => {
		if (draft.permissionMode === "read_only")
			return "Read-only is the safe default: the task can inspect and answer, but cannot change anything.";
		if (draft.permissionMode === "workspace_write")
			return "The task may edit files inside its workspace without asking.";
		if (draft.permissionMode === "ask_approval")
			return "Unattended tasks cannot answer approval prompts. If one is needed the run stops and is marked as needing attention.";
		return "Full access runs without prompts. Only choose this for tasks you fully trust.";
	}, [draft.permissionMode]);

	async function submit(event) {
		event.preventDefault();
		if (busy) return;
		const result = buildTaskPayload(draft, { existing: task });
		setWarnings(result.warnings ?? []);
		if (!result.ok) {
			setErrors(result.errors);
			setFormError("Check the highlighted fields.");
			return;
		}
		setErrors({});
		setFormError("");
		if (result.unchanged) {
			onClose();
			return;
		}
		setBusy(true);
		try {
			await onSave(result.payload, task);
		} catch (error) {
			setFormError(error?.message || "The task could not be saved.");
		} finally {
			setBusy(false);
		}
	}

	const isOnce = draft.scheduleType === "once";
	return createPortal(
		<dialog
			ref={dialogRef}
			className="aero-dialog sk-window sk-dialog m-auto w-[min(720px,calc(100vw-32px))] max-h-[calc(100dvh-48px)] overflow-auto p-0"
			aria-labelledby="task-editor-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<form
				className="tasks-editor"
				onSubmit={submit}
			>
				<header className="aero-header sk-window-header sk-texture-grain tasks-editor-header">
					<div>
						<h2
							id="task-editor-title"
							className="text-lg font-semibold"
						>
							{task ? "Edit task" : "Create a scheduled task"}
						</h2>
						<p className="tasks-muted">
							Continuum runs this task in the background while the app is open.
						</p>
					</div>
					<button
						type="button"
						className="aero-control sk-button grid size-8 shrink-0 place-items-center"
						onClick={onClose}
						aria-label="Close editor"
						disabled={busy}
					>
						<FiX aria-hidden="true" />
					</button>
				</header>

				<fieldset
					className="tasks-editor-body"
					disabled={busy}
				>
					<section
						className="tasks-editor-section"
						aria-label="Basics"
					>
						<h3 className="tasks-section-title">What should it do?</h3>
						<TextField
							label="Task name"
							required
							maxLength={200}
							autoFocus
							value={draft.name}
							placeholder="e.g. Morning briefing"
							hint={withError('name', undefined)}
							onChange={(event) => update({ name: event.target.value })}
						/>
						<TextAreaField
							label="Instructions"
							required
							rows={5}
							value={draft.prompt}
							placeholder="Summarize yesterday's changes and list anything that needs my attention."
							hint={withError('prompt', "This is sent as the first message of a fresh scheduled chat.")}
							onChange={(event) => update({ prompt: event.target.value })}
						/>
					</section>

					<section
						className="tasks-editor-section"
						aria-label="Schedule"
					>
						<h3 className="tasks-section-title">When should it run?</h3>
						<div className="tasks-grid-2">
							<SelectField
								label="Repeat"
								items={SCHEDULE_TYPES}
								value={draft.scheduleType}
								hint={withError('scheduleType', undefined)}
								onChange={(event) => updateSchedule({ scheduleType: event.target.value })}
							/>
							<TextField
								label="Timezone"
								id={timezoneId}
								list="scheduled-task-timezones"
								value={draft.timezone}
								required
								hint={withError('timezone', "Times are stored in UTC and shown in this timezone.")}
								onChange={(event) => updateSchedule({ timezone: event.target.value })}
							/>
						</div>
						<datalist id="scheduled-task-timezones">
							{zones.map((zone) => (
								<option
									key={zone}
									value={zone}
								/>
							))}
						</datalist>
						{isOnce ? (
							<div className="tasks-grid-2">
								<TextField
									label="Date"
									type="date"
									required
									value={draft.onceDate}
									hint={withError('onceDate', undefined)}
									onChange={(event) => updateSchedule({ onceDate: event.target.value })}
								/>
								<TextField
									label="Time"
									type="time"
									required
									value={draft.onceTime}
									hint={withError('onceTime', undefined)}
									onChange={(event) => updateSchedule({ onceTime: event.target.value })}
								/>
							</div>
						) : (
							<>
								<div className="tasks-grid-2">
									<TextField
										label="Start date"
										type="date"
										value={draft.startDate}
										hint={withError('startDate', "Leave empty to start from today.")}
										onChange={(event) => updateSchedule({ startDate: event.target.value })}
									/>
									<TextField
										label="Time of day"
										type="time"
										required
										value={draft.atTime}
										hint={withError('atTime', undefined)}
										onChange={(event) => updateSchedule({ atTime: event.target.value })}
									/>
								</div>
								{draft.scheduleType === "every_n_days" && (
									<NumberField
										label="Repeat every (days)"
										min={1}
										max={3650}
										value={draft.intervalDays}
										hint={withError('intervalDays', undefined)}
										onChange={(event) => updateSchedule({ intervalDays: event.target.value })}
									/>
								)}
								{draft.scheduleType === "weekdays" && (
									<div className="tasks-weekdays">
										<span className="tasks-field-label">Days</span>
										<div
											className="tasks-weekday-row"
											role="group"
											aria-label="Weekdays"
										>
											{WEEKDAY_LONG.map((label, day) => {
												const active = draft.weekdays.includes(day);
												return (
													<button
														key={label}
														type="button"
														className="aero-control sk-button tasks-weekday"
														aria-pressed={active}
														aria-label={label}
														onClick={() =>
															updateSchedule({
																weekdays: active
																	? draft.weekdays.filter((value) => value !== day)
																	: [...draft.weekdays, day].sort((left, right) => left - right),
															})
														}
													>
														{label.slice(0, 3)}
													</button>
												);
											})}
										</div>
										{errors.weekdays && <p className="tasks-field-error">{errors.weekdays}</p>}
									</div>
								)}
							</>
						)}
					</section>

					<section
						className="tasks-editor-section"
						aria-label="Model and permissions"
					>
						<h3 className="tasks-section-title">Which model, and how much may it do?</h3>
						<SelectField
							label="Model"
							items={modelOptions(models, draft.modelId, "Choose a model")}
							value={draft.modelId}
							hint={withError('modelId', "Continuum loads this model before the run starts. It is never swapped for whichever model happens to be loaded.")}
							onChange={(event) => update({ modelId: event.target.value })}
						/>
						<SelectField
							label="Fallback model (optional)"
							items={modelOptions(models, draft.fallbackId, "No fallback")}
							value={draft.fallbackId}
							hint={withError('fallbackId', "Used only when the chosen model cannot be loaded, for example because it does not fit in GPU memory.")}
							onChange={(event) => update({ fallbackId: event.target.value })}
						/>
						<SelectField
							label="Permission mode"
							items={PERMISSION_MODES.map((mode) => ({
								value: mode,
								label: PERMISSION_MODE_LABELS[mode] ?? mode,
							}))}
							value={draft.permissionMode}
							hint={permissionHint}
							onChange={(event) => update({ permissionMode: event.target.value })}
						/>
					</section>

					<details className="tasks-editor-advanced">
						<summary>Advanced options</summary>
						<div className="tasks-editor-advanced-body">
							<SelectField
								label="Workspace"
								items={projectOptions}
								value={draft.projectId}
								hint="The scheduled chat opens inside this workspace so it can use its instructions and files."
								onChange={(event) => update({ projectId: event.target.value })}
							/>
							<SelectField
								label="If a run is missed"
								items={MISSED_OPTIONS}
								value={draft.missedPolicy}
								hint="Applies when Continuum was closed or asleep at the scheduled time. It never catches up while the app is closed."
								onChange={(event) => update({ missedPolicy: event.target.value })}
							/>
							<div className="tasks-grid-2">
								<NumberField
									label="Grace period (hours)"
									min={0}
									max={8760}
									value={draft.graceHours}
									disabled={draft.missedPolicy !== "grace"}
									hint={withError('graceHours', undefined)}
									onChange={(event) => update({ graceHours: event.target.value })}
								/>
								<NumberField
									label="Maximum overdue (days)"
									min={1}
									max={365}
									value={draft.maxOverdueDays}
									hint={withError('maxOverdueDays', "Older runs expire instead of running very late.")}
									onChange={(event) => update({ maxOverdueDays: event.target.value })}
								/>
							</div>
							<NumberField
								label="Maximum run time (minutes)"
								min={1}
								max={360}
								placeholder="Use the app default"
								value={draft.maxRunMinutes}
								hint={withError('maxRunMinutes', "Optional. A run that exceeds this budget is stopped and marked as failed.")}
								onChange={(event) => update({ maxRunMinutes: event.target.value })}
							/>
							<CheckboxField
								label="Task is enabled"
								checked={draft.enabled}
								hint="Paused tasks keep their schedule and history but do not run automatically."
								onChange={(event) => update({ enabled: event.target.checked })}
							/>
						</div>
					</details>

					{formError && (
						<p
							role="alert"
							className="tasks-form-error"
						>
							{formError}
						</p>
					)}
					{warnings.map((warning) => (
						<p
							key={warning}
							className="tasks-form-warning"
						>
							{warning}
						</p>
					))}
				</fieldset>

				<footer className="tasks-editor-footer">
					<button
						type="button"
						className="aero-control sk-button tasks-button"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="submit"
						className="aero-primary sk-button sk-primary tasks-button tasks-button--primary"
						disabled={busy}
					>
						{busy ? "Saving…" : task ? "Save changes" : "Create task"}
					</button>
				</footer>
			</form>
		</dialog>,
		document.body,
	);
}

// Pure presentation/validation model for the scheduled-tasks page.
//
// The page must show exactly what the scheduler persisted, so everything here
// is a pure transformation of backend records and events: labels, relative
// times, form drafts, request payloads and live-event merging. No DOM, no IPC
// and no React, which keeps the behaviour unit-testable.
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from './permissionModes.mjs';

export const FALLBACK_MISSED_POLICY = Object.freeze({
	policy: 'grace',
	graceHours: 24,
	maxOverdueDays: 7,
});

export const ACTIVE_RUN_STATUSES = Object.freeze([
	'deferred',
	'queued',
	'waiting_for_model',
	'waiting_for_lease',
	'running',
]);

export const RUN_STATUS_LABELS = Object.freeze({
	deferred: 'Deferred',
	queued: 'Queued',
	waiting_for_model: 'Loading model',
	waiting_for_lease: 'Waiting for model',
	running: 'Running',
	completed: 'Completed',
	failed: 'Failed',
	skipped: 'Skipped',
	missed: 'Missed',
	interrupted: 'Interrupted',
	expired: 'Expired',
	blocked: 'Needs attention',
	cancelled: 'Cancelled',
});

// Tone drives colour only; the label always carries the meaning so blocked and
// failed stay distinguishable in every theme and to screen readers.
export const RUN_STATUS_TONES = Object.freeze({
	deferred: 'waiting',
	queued: 'waiting',
	waiting_for_model: 'waiting',
	waiting_for_lease: 'waiting',
	running: 'active',
	completed: 'success',
	failed: 'error',
	skipped: 'muted',
	missed: 'muted',
	interrupted: 'muted',
	expired: 'muted',
	blocked: 'attention',
	cancelled: 'muted',
});

export const MISSED_POLICY_LABELS = Object.freeze({
	grace: 'Run once if still within the grace period',
	skip: 'Skip missed runs',
	catch_up: 'Catch up on every missed run',
});

export const MISSED_POLICY_SHORT = Object.freeze({
	grace: 'Grace period',
	skip: 'Skip',
	catch_up: 'Catch up',
});

export const WEEKDAY_SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
export const WEEKDAY_LONG = Object.freeze([
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
]);

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NAME = 200;
const MAX_PROMPT = 100_000;

export function isActiveRun(run) {
	return Boolean(run) && ACTIVE_RUN_STATUSES.includes(run.status);
}

export function runStatusLabel(status) {
	return RUN_STATUS_LABELS[status] ?? String(status ?? 'Unknown');
}

export function runStatusTone(status) {
	return RUN_STATUS_TONES[status] ?? 'muted';
}

export function systemTimezone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

export function isValidTimezone(timezone) {
	if (typeof timezone !== 'string' || !timezone.trim()) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
		return true;
	} catch {
		return false;
	}
}

export function timezoneOptions() {
	const fallback = [
		'UTC',
		'Africa/Cairo',
		'Africa/Johannesburg',
		'America/Chicago',
		'America/Denver',
		'America/Los_Angeles',
		'America/New_York',
		'America/Sao_Paulo',
		'Asia/Dubai',
		'Asia/Kolkata',
		'Asia/Shanghai',
		'Asia/Singapore',
		'Asia/Tokyo',
		'Australia/Sydney',
		'Europe/Berlin',
		'Europe/London',
		'Europe/Paris',
		'Pacific/Auckland',
	];
	try {
		const supported = Intl.supportedValuesOf?.('timeZone');
		if (Array.isArray(supported) && supported.length) {
			return [...new Set([systemTimezone(), ...supported])].sort((left, right) =>
				left.localeCompare(right),
			);
		}
	} catch {
		/* Fall through to the curated list. */
	}
	return [...new Set([systemTimezone(), ...fallback])];
}

// ---------------------------------------------------------------------------
// Wall-clock helpers (shared DST rules with the scheduler)
// ---------------------------------------------------------------------------

function zonedParts(instant, timezone) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).formatToParts(new Date(instant));
	const values = {};
	for (const part of parts) if (part.type !== 'literal') values[part.type] = part.value;
	return { ...values, hour: values.hour === '24' ? '00' : values.hour };
}

export function dateInTimezone(instant, timezone) {
	const parts = zonedParts(instant, timezone);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

export function timeInTimezone(instant, timezone) {
	const parts = zonedParts(instant, timezone);
	return `${parts.hour}:${parts.minute}`;
}

/**
 * Convert a form date + time in a specific IANA timezone into epoch ms, using
 * the scheduler's own spring-forward/fall-back rules.
 *
 * This mirrors scheduleCalc.wallTimeToInstant. It is duplicated here because
 * the scheduler is CommonJS (main process) while this module is ESM (renderer);
 * Vite cannot serve a `.cjs` default export to the browser. The rules are kept
 * identical by tests/scheduledTasksModel.test.mjs, which asserts parity with
 * scheduleCalc for DST, half-hour and large-offset zones.
 */
export function wallTimeEpoch(date, time, timezone) {
	const dateMatch = DATE_PATTERN.exec(String(date ?? '').trim());
	const timeMatch = TIME_PATTERN.exec(String(time ?? '').trim());
	if (!dateMatch || !timeMatch) return null;
	const [year, month, day] = dateMatch.slice(1).map(Number);
	const [hour, minute] = timeMatch.slice(1).map(Number);
	try {
		return wallTimeToInstant({ year, month, day, hour, minute, second: 0 }, timezone);
	} catch {
		return null;
	}
}

const wallFormatterCache = new Map();

function wallFormatter(timeZone) {
	let formatter = wallFormatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		wallFormatterCache.set(timeZone, formatter);
	}
	return formatter;
}

function wallClockParts(instantMs, timeZone) {
	const values = {};
	for (const part of wallFormatter(timeZone).formatToParts(new Date(instantMs)))
		if (part.type !== 'literal') values[part.type] = Number(part.value);
	return {
		year: values.year,
		month: values.month,
		day: values.day,
		hour: values.hour === 24 ? 0 : values.hour,
		minute: values.minute,
		second: values.second,
	};
}

function zoneOffsetAt(instantMs, timeZone) {
	const wall = wallClockParts(instantMs, timeZone);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	const wholeSeconds = instantMs - (((instantMs % 1000) + 1000) % 1000);
	return asUtc - wholeSeconds;
}

function sameWallClock(left, right) {
	return (
		left.year === right.year &&
		left.month === right.month &&
		left.day === right.day &&
		left.hour === right.hour &&
		left.minute === right.minute &&
		left.second === (right.second ?? 0)
	);
}

function compareWallClock(left, right) {
	for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
		const difference = (left[key] ?? 0) - (right[key] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** First valid UTC instant at or after a local wall-clock time. */
export function wallTimeToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timezone) {
	if (!isValidTimezone(timezone)) throw new TypeError('Invalid IANA timezone.');
	const intended = { year, month, day, hour, minute, second };
	const intendedUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	if (!Number.isFinite(intendedUtc)) throw new TypeError('Invalid wall-clock time.');
	const offsets = new Set();
	for (const delta of [-30, -12, 0, 12, 30])
		offsets.add(zoneOffsetAt(intendedUtc + delta * 3_600_000, timezone));
	const matches = [];
	for (const offset of offsets) {
		const candidate = intendedUtc - offset;
		if (sameWallClock(wallClockParts(candidate, timezone), intended)) matches.push(candidate);
	}
	// Fall-back: an ambiguous wall time resolves once, at the first occurrence.
	if (matches.length) return Math.min(...matches);
	// Spring-forward: a nonexistent wall time resolves to the first instant whose
	// local clock is at or after it (e.g. 02:30 -> 03:00).
	const start = intendedUtc - 12 * 3_600_000;
	for (let step = 0; step <= 24 * 60; step++) {
		const candidate = start + step * 60_000;
		if (compareWallClock(wallClockParts(candidate, timezone), intended) >= 0) return candidate;
	}
	throw new Error('Could not resolve the local wall time in this timezone.');
}

function isValidDate(value) {
	const match = DATE_PATTERN.exec(String(value ?? '').trim());
	if (!match) return false;
	const [year, month, day] = match.slice(1).map(Number);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const probe = new Date(Date.UTC(year, month - 1, day));
	return (
		probe.getUTCFullYear() === year &&
		probe.getUTCMonth() === month - 1 &&
		probe.getUTCDate() === day
	);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDateTime(instant, { timezone = systemTimezone(), locale } = {}) {
	if (!Number.isFinite(instant)) return '—';
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone: timezone,
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(instant));
	} catch {
		return new Date(instant).toISOString();
	}
}

export function formatTime(instant, { timezone = systemTimezone(), locale } = {}) {
	if (!Number.isFinite(instant)) return '—';
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone: timezone,
			timeStyle: 'short',
		}).format(new Date(instant));
	} catch {
		return new Date(instant).toISOString().slice(11, 16);
	}
}

/**
 * Deterministic relative phrasing. `now` is injected so tests never depend on
 * the wall clock.
 */
export function relativeTime(instant, now = Date.now()) {
	if (!Number.isFinite(instant)) return '';
	const delta = instant - now;
	const future = delta >= 0;
	const seconds = Math.abs(delta) / 1000;
	if (seconds < 45) return 'now';
	const minutes = Math.round(seconds / 60);
	const hours = Math.round(seconds / 3600);
	const days = Math.round(seconds / 86_400);
	let value;
	let unit;
	if (minutes < 60) [value, unit] = [minutes, 'minute'];
	else if (hours < 24) [value, unit] = [hours, 'hour'];
	else if (days < 30) [value, unit] = [days, 'day'];
	else if (days < 365) [value, unit] = [Math.round(days / 30), 'month'];
	else [value, unit] = [Math.round(days / 365), 'year'];
	const label = `${value} ${unit}${value === 1 ? '' : 's'}`;
	return future ? `in ${label}` : `${label} ago`;
}

export function formatDuration(startedAt, finishedAt) {
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return '—';
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function describeSchedule(task) {
	const schedule = task?.schedule ?? null;
	if (!schedule) return 'No schedule';
	if (schedule.type === 'once')
		return `Once on ${formatDateTime(schedule.at, { timezone: task.timezone })}`;
	const time = schedule.atTime ?? '';
	if (schedule.type === 'daily') return `Every day at ${time}`;
	if (schedule.type === 'every_n_days')
		return `Every ${schedule.intervalDays} day${schedule.intervalDays === 1 ? '' : 's'} at ${time}`;
	if (schedule.type === 'weekdays') {
		const days = (schedule.weekdays ?? []).map((day) => WEEKDAY_SHORT[day] ?? day).join(', ');
		return `Every ${days} at ${time}`;
	}
	return 'Unknown schedule';
}

/**
 * Compact recurrence for the list: "Once", "Daily 09:00", "Every 3 days",
 * "Mon Wed Fri".
 */
export function describeRepeatShort(task) {
	const schedule = task?.schedule;
	if (!schedule) return '—';
	if (schedule.type === 'once') return 'Once';
	if (schedule.type === 'daily') return `Daily ${schedule.atTime ?? ''}`.trim();
	if (schedule.type === 'every_n_days')
		return `Every ${schedule.intervalDays} day${schedule.intervalDays === 1 ? '' : 's'}`;
	if (schedule.type === 'weekdays')
		return (schedule.weekdays ?? []).map((day) => WEEKDAY_SHORT[day] ?? day).join(' ');
	return '—';
}

export function describeMissedPolicy(policy) {
	const value = policy ?? FALLBACK_MISSED_POLICY;
	const hours = value.graceHours ?? FALLBACK_MISSED_POLICY.graceHours;
	const days = value.maxOverdueDays ?? FALLBACK_MISSED_POLICY.maxOverdueDays;
	const base = MISSED_POLICY_LABELS[value.policy] ?? MISSED_POLICY_LABELS.grace;
	if (value.policy === 'skip') return `${base} (older than ${days} day${days === 1 ? '' : 's'} expires)`;
	if (value.policy === 'grace') return `${base} (${hours}h window, ${days}-day limit)`;
	return `${base} (up to ${days} day${days === 1 ? '' : 's'} late)`;
}

export function modelRefToId(ref) {
	if (!ref || typeof ref !== 'object') return '';
	if (ref.kind === 'cloud') return `cloud:${ref.provider}:${ref.modelId ?? ref.model}`;
	if (ref.kind === 'local' || ref.modelPath) return ref.modelPath ?? '';
	return '';
}

export function modelIdToRef(id) {
	if (typeof id !== 'string' || !id) return null;
	if (id.startsWith('cloud:')) {
		const [, provider, ...rest] = id.split(':');
		const modelId = rest.join(':');
		if (!provider || !modelId) return null;
		return { kind: 'cloud', provider, modelId };
	}
	return { kind: 'local', modelPath: id };
}

function shortPath(path) {
	if (typeof path !== 'string') return '';
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : path;
}

/**
 * Human label for a model reference. `models` is the app's model catalog; a
 * configured model that is no longer listed still renders its own identity so
 * the page never hides or rewrites the stored selection.
 */
export function modelLabel(models, ref) {
	const id = typeof ref === 'string' ? ref : modelRefToId(ref);
	if (!id) return 'No model selected';
	const match = Array.isArray(models) ? models.find((model) => model?.id === id) : null;
	if (match?.name) return match.name;
	const parsed = modelIdToRef(id);
	if (parsed?.kind === 'cloud') return `${parsed.provider} · ${parsed.modelId}`;
	return shortPath(id);
}

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

export function sortTasks(tasks) {
	return [...tasks].sort((left, right) => {
		if (Boolean(left.enabled) !== Boolean(right.enabled)) return left.enabled ? -1 : 1;
		const leftNext = Number.isFinite(left.nextRunAt) ? left.nextRunAt : Infinity;
		const rightNext = Number.isFinite(right.nextRunAt) ? right.nextRunAt : Infinity;
		if (leftNext !== rightNext) return leftNext - rightNext;
		return String(left.name ?? '').localeCompare(String(right.name ?? ''));
	});
}

export function activeRunFor(runs, taskId) {
	return (runs ?? []).find((run) => run.taskId === taskId && isActiveRun(run)) ?? null;
}

/**
 * The row-level status. An active run always wins: the task is visibly busy
 * even if it was paused while the run was still cancelling.
 */
export function taskState(task, activeRun = null) {
	if (activeRun) {
		const waiting = activeRun.status !== 'running';
		return {
			key: waiting ? 'waiting' : 'running',
			label: runStatusLabel(activeRun.status),
			tone: waiting ? 'waiting' : 'active',
			runId: activeRun.id,
		};
	}
	if (!task?.enabled) return { key: 'paused', label: 'Paused', tone: 'muted' };
	if (task.nextRunAt == null) return { key: 'finished', label: 'Finished', tone: 'muted' };
	if (task.lastStatus === 'failed') return { key: 'error', label: 'Last run failed', tone: 'error' };
	if (task.lastStatus === 'blocked')
		return { key: 'attention', label: 'Needs attention', tone: 'attention' };
	return { key: 'scheduled', label: 'Scheduled', tone: 'neutral' };
}

export function nextRunSummary(task, now = Date.now()) {
	if (!task?.enabled) return { text: 'Paused', detail: '', overdue: false };
	if (task.nextRunAt == null) return { text: 'No further runs', detail: '', overdue: false };
	const overdue = task.nextRunAt < now;
	return {
		text: formatDateTime(task.nextRunAt, { timezone: task.timezone }),
		detail: relativeTime(task.nextRunAt, now),
		overdue,
	};
}

/**
 * A single sentence explaining why a run is not producing output yet. This is
 * what keeps "waiting for the model" and "blocked by permissions" from looking
 * like an unexplained hang.
 */
export function runExplanation(run, models = []) {
	if (!run) return '';
	const reason = run.failureReason ? ` ${run.failureReason}` : '';
	switch (run.status) {
		case 'deferred':
			return `Scheduled during a busy startup. It will start shortly${reason}`;
		case 'queued':
			return 'Waiting for the previous run to finish.';
		case 'waiting_for_lease':
			return `Waiting for the active chat turn to release the model.${reason}`;
		case 'waiting_for_model':
			return `Preparing ${modelLabel(models, run.model)} before the turn starts.${reason}`;
		case 'running':
			return run.startedAt ? `Started ${relativeTime(run.startedAt)}.` : 'Running.';
		case 'blocked':
			return `Stopped at an approval or input boundary and needs your attention.${reason}`;
		case 'skipped':
			return `Not executed.${reason || ' The configured model was unavailable.'}`;
		case 'failed':
			return `The run failed.${reason}`;
		case 'interrupted':
			return `The run was interrupted and was not replayed.${reason}`;
		case 'expired':
			return `The scheduled time was too far in the past to run safely.${reason}`;
		case 'missed':
			return `The scheduled time passed while Continuum was not running.${reason}`;
		case 'cancelled':
			return `Cancelled.${reason}`;
		case 'completed':
			return run.fallbackUsed
				? `Completed with the fallback model (${modelLabel(models, run.model)}).`
				: 'Completed.';
		default:
			return reason.trim();
	}
}

export function summarize(tasks, runs = [], now = Date.now()) {
	const activeTaskIds = new Set(runs.filter(isActiveRun).map((run) => run.taskId));
	const upcoming = sortTasks(tasks).filter(
		(task) => task.enabled && Number.isFinite(task.nextRunAt),
	);
	return {
		upcoming,
		running: tasks.filter((task) => activeTaskIds.has(task.id)),
		paused: tasks.filter((task) => !task.enabled),
		recent: runs.slice(0, 6),
		activeTaskIds,
	};
}

export function filterTasks(tasks, runs, { query = '', filter = 'all' } = {}) {
	const needle = query.trim().toLocaleLowerCase();
	const activeTaskIds = new Set((runs ?? []).filter(isActiveRun).map((run) => run.taskId));
	return sortTasks(tasks).filter((task) => {
		if (filter === 'active') {
			if (!task.enabled || activeTaskIds.has(task.id)) return false;
		} else if (filter === 'running') {
			if (!activeTaskIds.has(task.id)) return false;
		} else if (filter === 'paused') {
			if (task.enabled) return false;
		} else if (filter === 'attention') {
			if (task.lastStatus !== 'blocked' && task.lastStatus !== 'failed' && task.enabled) return false;
			if (!task.enabled) return false;
		}
		if (!needle) return true;
		return [task.name, task.prompt, describeSchedule(task)].some((value) =>
			String(value ?? '')
				.toLocaleLowerCase()
				.includes(needle),
		);
	});
}

// ---------------------------------------------------------------------------
// Editor draft <-> backend payload
// ---------------------------------------------------------------------------

export function draftFromTask(task, { now = Date.now() } = {}) {
	const timezone = task?.timezone ?? systemTimezone();
	const schedule = task?.schedule ?? null;
	const once = schedule?.type === 'once';
	return {
		name: task?.name ?? '',
		prompt: task?.prompt ?? '',
		projectId: task?.projectId ?? '',
		timezone,
		scheduleType: schedule?.type ?? 'daily',
		onceDate: once ? dateInTimezone(schedule.at, timezone) : dateInTimezone(now, timezone),
		onceTime: once ? timeInTimezone(schedule.at, timezone) : '09:00',
		startDate: schedule && schedule.type !== 'once' ? dateInTimezone(schedule.startAt, timezone) : '',
		atTime: schedule && schedule.type !== 'once' ? schedule.atTime : '09:00',
		intervalDays: String(schedule?.intervalDays ?? 1),
		weekdays: schedule?.weekdays?.length ? [...schedule.weekdays] : [1, 2, 3, 4, 5],
		modelId: modelRefToId(task?.model),
		fallbackId: task?.fallback?.length ? modelRefToId(task.fallback[0]) : '',
		missedPolicy: task?.missedPolicy?.policy ?? FALLBACK_MISSED_POLICY.policy,
		graceHours: String(task?.missedPolicy?.graceHours ?? FALLBACK_MISSED_POLICY.graceHours),
		maxOverdueDays: String(task?.missedPolicy?.maxOverdueDays ?? FALLBACK_MISSED_POLICY.maxOverdueDays),
		permissionMode: task?.permissionMode ?? 'read_only',
		maxRunMinutes: task?.budget?.maxWallClockMs
			? String(Math.round(task.budget.maxWallClockMs / 60_000))
			: '',
		enabled: task ? Boolean(task.enabled) : true,
		scheduleTouched: false,
	};
}

function integerField(value, { min, max }) {
	const text = String(value ?? '').trim();
	if (!text) return { error: 'Enter a number.' };
	if (!/^\d+$/.test(text)) return { error: 'Enter a whole number.' };
	const number = Number(text);
	if (number < min || number > max) return { error: `Use a value from ${min} to ${max}.` };
	return { value: number };
}

function buildSchedule(draft, timezone, errors) {
	if (draft.scheduleType === 'once') {
		if (!isValidDate(draft.onceDate)) errors.onceDate = 'Choose a valid date.';
		if (!TIME_PATTERN.test(String(draft.onceTime ?? ''))) errors.onceTime = 'Choose a valid time.';
		if (errors.onceDate || errors.onceTime) return null;
		const at = wallTimeEpoch(draft.onceDate, draft.onceTime, timezone);
		if (!Number.isFinite(at)) {
			errors.onceTime = 'That local time cannot be resolved in this timezone.';
			return null;
		}
		return { type: 'once', at };
	}
	if (!['daily', 'every_n_days', 'weekdays'].includes(draft.scheduleType)) {
		errors.scheduleType = 'Choose a recurrence.';
		return null;
	}
	const schedule = { type: draft.scheduleType };
	if (!TIME_PATTERN.test(String(draft.atTime ?? ''))) {
		errors.atTime = 'Choose a time of day (HH:MM).';
		return null;
	}
	schedule.atTime = draft.atTime;
	if (draft.startDate) {
		if (!isValidDate(draft.startDate)) {
			errors.startDate = 'Choose a valid start date, or leave it empty to start today.';
			return null;
		}
		schedule.startAt = draft.startDate;
	}
	if (draft.scheduleType === 'every_n_days') {
		const interval = integerField(draft.intervalDays, { min: 1, max: 3650 });
		if (interval.error) {
			errors.intervalDays = interval.error;
			return null;
		}
		schedule.intervalDays = interval.value;
	}
	if (draft.scheduleType === 'weekdays') {
		const days = [...new Set((draft.weekdays ?? []).map(Number))].filter(
			(day) => Number.isInteger(day) && day >= 0 && day <= 6,
		);
		if (!days.length) {
			errors.weekdays = 'Select at least one day.';
			return null;
		}
		schedule.weekdays = days.sort((left, right) => left - right);
	}
	return schedule;
}

/**
 * Validate the editor draft and produce the exact create/update payload.
 *
 * Only backend-supported keys are emitted. When `existing` is provided the
 * result is a minimal patch: unchanged fields are omitted so saving a rename
 * cannot rewrite the schedule, swap a model, or cancel queued automatic runs.
 */
export function buildTaskPayload(draft, { existing = null, now = Date.now() } = {}) {
	const errors = {};
	const warnings = [];
	const timezone = String(draft.timezone ?? '').trim();
	if (!isValidTimezone(timezone)) errors.timezone = 'Choose a valid IANA timezone.';
	const name = String(draft.name ?? '').trim();
	if (!name) errors.name = 'Give the task a name.';
	else if (name.length > MAX_NAME) errors.name = `Keep the name under ${MAX_NAME} characters.`;
	const prompt = String(draft.prompt ?? '');
	if (!prompt.trim()) errors.prompt = 'Describe what the task should do.';
	else if (prompt.length > MAX_PROMPT) errors.prompt = 'The instructions are too long.';

	const primary = modelIdToRef(draft.modelId);
	if (!primary) errors.modelId = 'Choose the model this task should use.';
	const fallback = draft.fallbackId ? modelIdToRef(draft.fallbackId) : null;
	if (draft.fallbackId && !fallback) errors.fallbackId = 'Choose a valid fallback model.';

	if (!PERMISSION_MODES.includes(draft.permissionMode))
		errors.permissionMode = 'Choose a permission mode.';

	const graceHours = integerField(draft.graceHours, { min: 0, max: 24 * 365 });
	if (graceHours.error) errors.graceHours = graceHours.error;
	const maxOverdueDays = integerField(draft.maxOverdueDays, { min: 1, max: 365 });
	if (maxOverdueDays.error) errors.maxOverdueDays = maxOverdueDays.error;
	const missedPolicy = MISSED_POLICY_LABELS[draft.missedPolicy] ? draft.missedPolicy : 'grace';

	let budget = null;
	if (String(draft.maxRunMinutes ?? '').trim()) {
		const minutes = integerField(draft.maxRunMinutes, { min: 1, max: 360 });
		if (minutes.error) errors.maxRunMinutes = minutes.error;
		else budget = { maxWallClockMs: minutes.value * 60_000 };
	}

	const previous = draftFromTask(existing ?? {}, { now: now - 1 });
	const scheduleTouched =
		Boolean(draft.scheduleTouched) ||
		draft.scheduleType !== previous.scheduleType ||
		draft.onceDate !== previous.onceDate ||
		draft.onceTime !== previous.onceTime ||
		draft.startDate !== previous.startDate ||
		draft.atTime !== previous.atTime ||
		String(draft.intervalDays) !== String(previous.intervalDays) ||
		JSON.stringify([...(draft.weekdays ?? [])].sort()) !==
			JSON.stringify([...(previous.weekdays ?? [])].sort()) ||
		draft.timezone !== (existing?.timezone ?? draft.timezone);
	const schedule = errors.timezone ? null : buildSchedule(draft, timezone, errors);
	if (schedule && schedule.type === 'once' && schedule.at <= now) {
		warnings.push('This time is in the past, so the run is subject to the missed-run policy.');
	}

	if (Object.keys(errors).length) return { ok: false, errors, warnings, payload: null };

	const payload = {
		name,
		prompt,
		projectId: draft.projectId ? String(draft.projectId) : null,
		schedule,
		timezone,
		model: primary,
		fallback: fallback ? [fallback] : [],
		missedPolicy: {
			policy: missedPolicy,
			graceHours: graceHours.value,
			maxOverdueDays: maxOverdueDays.value,
		},
		permissionMode: draft.permissionMode,
		budget,
		enabled: Boolean(draft.enabled),
	};
	if (!existing) return { ok: true, errors: {}, warnings, payload };

	const patch = {};
	for (const [key, value] of Object.entries(payload)) {
		if (key === 'schedule' || key === 'timezone') continue;
		if (key === 'enabled' && Boolean(existing.enabled) === value) continue;
		if (JSON.stringify(existing[key] ?? null) === JSON.stringify(value ?? null)) continue;
		patch[key] = value;
	}
	if (scheduleTouched) {
		patch.schedule = schedule;
		patch.timezone = timezone;
	}
	return { ok: true, errors: {}, warnings, payload: patch, unchanged: !Object.keys(patch).length };
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

export function applyScheduledEvent(state, event) {
	if (!event || typeof event !== 'object') return state;
	const tasks = state.tasks ?? [];
	const runs = state.runs ?? [];
	if (event.type === 'task-deleted') {
		const taskId = event.taskId ?? event.task?.id;
		if (!taskId || !tasks.some((task) => task.id === taskId)) return state;
		return { ...state, tasks: tasks.filter((task) => task.id !== taskId) };
	}
	let changed = false;
	let nextTasks = tasks;
	let nextRuns = runs;
	if (event.task && (event.type === 'task-created' || event.type === 'task-updated')) {
		const index = tasks.findIndex((task) => task.id === event.task.id);
		nextTasks = index >= 0
			? tasks.map((task) => (task.id === event.task.id ? event.task : task))
			: [...tasks, event.task];
		nextTasks = sortTasks(nextTasks);
		changed = true;
	}
	if (event.run && (event.type === 'run-created' || event.type === 'run-updated')) {
		const run = event.run;
		const index = runs.findIndex((existing) => existing.id === run.id);
		nextRuns =
			index >= 0
				? runs.map((existing) => (existing.id === run.id ? run : existing))
				: [run, ...runs];
		if (nextRuns.length > 100)
			nextRuns = [...nextRuns].sort((left, right) => right.scheduledFor - left.scheduledFor).slice(0, 100);
		changed = true;
	}
	if (!changed) return state;
	return { ...state, tasks: nextTasks, runs: nextRuns };
}

/** Whether an incoming event should refresh the selected task's history. */
export function eventTouchesTask(event, taskId, previousRuns = []) {
	if (!event || !taskId) return false;
	if (event.type === 'task-updated' || event.type === 'task-created')
		return event.task?.id === taskId;
	if (event.type === 'run-created') return event.run?.taskId === taskId;
	if (event.type === 'run-updated') {
		if (event.run?.taskId !== taskId) return false;
		const previous = previousRuns.find((run) => run.id === event.run.id);
		return !previous || previous.status !== event.run.status;
	}
	return false;
}

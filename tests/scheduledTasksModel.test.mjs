import test from 'node:test';
import assert from 'node:assert/strict';
import scheduleCalc from '../src/lib/scheduleCalc.cjs';
import {
	applyScheduledEvent,
	buildTaskPayload,
	describeMissedPolicy,
	describeRepeatShort,
	describeSchedule,
	draftFromTask,
	eventTouchesTask,
	filterTasks,
	formatDuration,
	isValidTimezone,
	modelIdToRef,
	modelLabel,
	modelRefToId,
	nextRunSummary,
	relativeTime,
	runExplanation,
	runStatusLabel,
	runStatusTone,
	summarize,
	taskState,
	wallTimeEpoch,
	wallTimeToInstant,
} from '../src/lib/scheduledTasks.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0); // Sat 2026-01-10 12:00 UTC

const localModel = { id: '/models/alpha.gguf', name: 'Local/alpha.gguf' };
const cloudModel = { id: 'cloud:openai:gpt-4o-mini', name: 'OpenAI / gpt-4o-mini' };
const MODELS = [localModel, cloudModel];

function makeTask(overrides = {}) {
	return {
		id: 'task-1',
		name: 'Morning briefing',
		prompt: 'Summarize yesterday.',
		projectId: null,
		schedule: { type: 'daily', atTime: '09:00', startAt: Date.UTC(2026, 0, 1, 9) },
		timezone: 'UTC',
		model: { kind: 'local', modelPath: localModel.id },
		fallback: [],
		missedPolicy: { policy: 'grace', graceHours: 24, maxOverdueDays: 7 },
		permissionMode: 'read_only',
		budget: null,
		enabled: true,
		nextRunAt: Date.UTC(2026, 0, 11, 9),
		lastRunAt: null,
		lastStatus: null,
		createdAt: Date.UTC(2026, 0, 1),
		updatedAt: Date.UTC(2026, 0, 1),
		...overrides,
	};
}

function makeRun(overrides = {}) {
	return {
		id: 'run-1',
		taskId: 'task-1',
		sessionId: null,
		scheduledFor: Date.UTC(2026, 0, 10, 9),
		trigger: 'schedule',
		status: 'completed',
		claimedAt: null,
		startedAt: null,
		finishedAt: null,
		failureReason: null,
		model: { kind: 'local', modelPath: localModel.id },
		fallbackUsed: false,
		usage: null,
		deferredUntil: null,
		createdAt: Date.UTC(2026, 0, 10, 9),
		updatedAt: Date.UTC(2026, 0, 10, 9),
		...overrides,
	};
}

test('blocked and failed runs are labelled and toned differently', () => {
	assert.equal(runStatusLabel('blocked'), 'Needs attention');
	assert.equal(runStatusLabel('failed'), 'Failed');
	assert.notEqual(runStatusTone('blocked'), runStatusTone('failed'));
	assert.equal(runStatusTone('failed'), 'error');
	assert.equal(runStatusTone('blocked'), 'attention');
	assert.equal(runStatusLabel('waiting_for_model'), 'Loading model');
	assert.equal(runStatusLabel('waiting_for_lease'), 'Waiting for model');
	assert.equal(runStatusLabel('expired'), 'Expired');
	assert.equal(runStatusLabel('interrupted'), 'Interrupted');
});

test('recurrence and missed-run descriptions are explicit', () => {
	assert.equal(
		describeSchedule({ timezone: 'UTC', schedule: { type: 'daily', atTime: '09:30' } }),
		'Every day at 09:30',
	);
	assert.equal(
		describeRepeatShort({ schedule: { type: 'every_n_days', intervalDays: 3, atTime: '08:00' } }),
		'Every 3 days',
	);
	assert.equal(
		describeRepeatShort({ schedule: { type: 'weekdays', weekdays: [1, 3, 5] } }),
		'Mon Wed Fri',
	);
	assert.equal(describeRepeatShort({ schedule: { type: 'once', at: NOW } }), 'Once');
	assert.match(describeMissedPolicy({ policy: 'grace', graceHours: 24, maxOverdueDays: 7 }), /24h window/);
	assert.match(describeMissedPolicy({ policy: 'catch_up', graceHours: 24, maxOverdueDays: 7 }), /up to 7 days/);
	assert.match(describeMissedPolicy({ policy: 'skip', maxOverdueDays: 3 }), /3 days/);
});

test('relative time and duration formatting are deterministic', () => {
	assert.equal(relativeTime(NOW + 30_000, NOW), 'now');
	assert.equal(relativeTime(NOW + 5 * 60_000, NOW), 'in 5 minutes');
	assert.equal(relativeTime(NOW + 3 * HOUR, NOW), 'in 3 hours');
	assert.equal(relativeTime(NOW + 2 * DAY, NOW), 'in 2 days');
	assert.equal(relativeTime(NOW - 2 * DAY, NOW), '2 days ago');
	assert.equal(formatDuration(NOW, NOW + 45_000), '45s');
	assert.equal(formatDuration(NOW, NOW + 95_000), '1m 35s');
	assert.equal(formatDuration(null, NOW), '—');
});

test('task state prefers an active run and keeps paused/attention distinct', () => {
	assert.deepEqual(
		{ key: 'running', label: 'Running', tone: 'active' },
		(() => {
			const state = taskState(makeTask(), makeRun({ status: 'running' }));
			return { key: state.key, label: state.label, tone: state.tone };
		})(),
	);
	const waiting = taskState(makeTask(), makeRun({ status: 'waiting_for_lease' }));
	assert.equal(waiting.key, 'waiting');
	assert.equal(waiting.label, 'Waiting for model');
	assert.equal(taskState(makeTask({ enabled: false })).key, 'paused');
	assert.equal(taskState(makeTask({ lastStatus: 'blocked' })).tone, 'attention');
	assert.equal(taskState(makeTask({ lastStatus: 'failed' })).tone, 'error');
	assert.equal(taskState(makeTask({ nextRunAt: null })).label, 'Finished');
});

test('next-run summary reports pauses, emptiness and overdue slots', () => {
	const paused = nextRunSummary(makeTask({ enabled: false }), NOW);
	assert.equal(paused.text, 'Paused');
	const finished = nextRunSummary(makeTask({ nextRunAt: null }), NOW);
	assert.equal(finished.text, 'No further runs');
	const overdue = nextRunSummary(makeTask({ nextRunAt: NOW - 2 * HOUR }), NOW);
	assert.equal(overdue.overdue, true);
	assert.equal(overdue.detail, '2 hours ago');
});

test('waiting and blocked reasons explain themselves in plain language', () => {
	assert.match(
		runExplanation(makeRun({ status: 'waiting_for_lease' }), MODELS),
		/release the model/i,
	);
	assert.match(
		runExplanation(makeRun({ status: 'waiting_for_model', model: null }), MODELS),
		/preparing/i,
	);
	assert.match(
		runExplanation(
			makeRun({ status: 'blocked', failureReason: 'approval_required: Tool approval required for write_file.' }),
			MODELS,
		),
		/approval_required/,
	);
	assert.match(
		runExplanation(makeRun({ status: 'skipped', failureReason: 'The model does not fit in available GPU memory.' })),
		/GPU memory/,
	);
	assert.match(runExplanation(makeRun({ status: 'completed' }), MODELS), /Completed/);
});

test('model identities round-trip and unknown models keep their own label', () => {
	assert.deepEqual(modelIdToRef('cloud:openai:gpt-4o-mini'), {
		kind: 'cloud',
		provider: 'openai',
		modelId: 'gpt-4o-mini',
	});
	assert.deepEqual(modelIdToRef('/models/alpha.gguf'), { kind: 'local', modelPath: '/models/alpha.gguf' });
	assert.equal(modelRefToId({ kind: 'cloud', provider: 'openai', modelId: 'gpt-4o-mini' }), 'cloud:openai:gpt-4o-mini');
	assert.equal(modelLabel(MODELS, { kind: 'local', modelPath: localModel.id }), 'Local/alpha.gguf');
	assert.equal(modelLabel(MODELS, { kind: 'cloud', provider: 'openai', modelId: 'gpt-4o-mini' }), 'OpenAI / gpt-4o-mini');
	assert.match(modelLabel([], { kind: 'local', modelPath: '/gone/model.gguf' }), /model\.gguf/);
});

test('a new task payload uses backend field names and safe defaults', () => {
	const draft = {
		...draftFromTask(null, { now: NOW }),
		name: 'Morning briefing',
		prompt: 'Summarize yesterday.',
		modelId: localModel.id,
	};
	assert.equal(draft.permissionMode, 'read_only');
	assert.equal(draft.enabled, true);
	const result = buildTaskPayload(draft, { now: NOW });
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	const payload = result.payload;
	assert.deepEqual(Object.keys(payload).sort(), [
		'budget',
		'enabled',
		'fallback',
		'missedPolicy',
		'model',
		'name',
		'permissionMode',
		'projectId',
		'prompt',
		'schedule',
		'timezone',
	]);
	assert.equal(payload.permissionMode, 'read_only');
	assert.equal(payload.projectId, null);
	assert.equal(payload.budget, null);
	assert.deepEqual(payload.model, { kind: 'local', modelPath: localModel.id });
	assert.deepEqual(payload.missedPolicy, { policy: 'grace', graceHours: 24, maxOverdueDays: 7 });
});

test('validation rejects missing or malformed fields instead of guessing', () => {
	const base = { ...draftFromTask(null, { now: NOW }), name: 'x', prompt: 'y', modelId: localModel.id };
	const invalid = buildTaskPayload({ ...base, name: '  ' }, { now: NOW });
	assert.equal(invalid.ok, false);
	assert.match(invalid.errors.name, /name/i);

	assert.match(buildTaskPayload({ ...base, prompt: '   ' }, { now: NOW }).errors.prompt, /what the task/i);
	assert.match(buildTaskPayload({ ...base, modelId: '' }, { now: NOW }).errors.modelId, /model/i);
	assert.match(buildTaskPayload({ ...base, timezone: 'Not/AZone' }, { now: NOW }).errors.timezone, /timezone/i);
	assert.match(
		buildTaskPayload({ ...base, scheduleType: 'weekdays', weekdays: [] }, { now: NOW }).errors.weekdays,
		/at least one day/i,
	);
	assert.match(
		buildTaskPayload({ ...base, scheduleType: 'every_n_days', intervalDays: '0' }, { now: NOW }).errors
			.intervalDays,
		/1 to 3650/,
	);
	assert.match(
		buildTaskPayload({ ...base, scheduleType: 'once', onceDate: '2026-02-30' }, { now: NOW }).errors.onceDate,
		/valid date/i,
	);
	assert.match(
		buildTaskPayload({ ...base, maxRunMinutes: '0' }, { now: NOW }).errors.maxRunMinutes,
		/1 to 360/,
	);
	assert.match(
		buildTaskPayload({ ...base, permissionMode: 'root' }, { now: NOW }).errors.permissionMode,
		/permission mode/i,
	);
});

test('one-time schedules convert the chosen wall time through the task timezone and DST rules', () => {
	assert.equal(wallTimeEpoch('2026-03-08', '02:30', 'America/New_York'), Date.UTC(2026, 2, 8, 7));
	assert.equal(wallTimeEpoch('2026-01-10', '09:00', 'UTC'), Date.UTC(2026, 0, 10, 9));
	assert.equal(wallTimeEpoch('2026-01-10', '09:00', 'Europe/London'), Date.UTC(2026, 0, 10, 9));
	assert.equal(wallTimeEpoch('2026-07-10', '09:00', 'Europe/London'), Date.UTC(2026, 6, 10, 8));
	assert.equal(wallTimeEpoch('nope', '09:00', 'UTC'), null);

	const draft = {
		...draftFromTask(null, { now: NOW }),
		name: 'One off',
		prompt: 'Run once.',
		modelId: localModel.id,
		scheduleType: 'once',
		timezone: 'America/New_York',
		onceDate: '2026-03-08',
		onceTime: '02:30',
	};
	const result = buildTaskPayload(draft, { now: NOW });
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.deepEqual(result.payload.schedule, { type: 'once', at: Date.UTC(2026, 2, 8, 7) });
});

test('editing sends only the fields that changed', () => {
	const task = makeTask({ fallback: [{ kind: 'cloud', provider: 'openai', modelId: 'gpt-4o-mini' }] });
	const draft = draftFromTask(task, { now: NOW });
	const untouched = buildTaskPayload(draft, { existing: task, now: NOW });
	assert.equal(untouched.ok, true, JSON.stringify(untouched.errors));
	assert.equal(untouched.unchanged, true);
	assert.deepEqual(untouched.payload, {});

	const renamed = buildTaskPayload({ ...draft, name: 'Renamed' }, { existing: task, now: NOW });
	assert.deepEqual(renamed.payload, { name: 'Renamed' });

	const modelChanged = buildTaskPayload({ ...draft, modelId: cloudModel.id }, { existing: task, now: NOW });
	assert.deepEqual(modelChanged.payload.model, {
		kind: 'cloud',
		provider: 'openai',
		modelId: 'gpt-4o-mini',
	});
	assert.equal(modelChanged.payload.schedule, undefined);
	assert.equal(modelChanged.payload.permissionMode, undefined);

	const retimed = buildTaskPayload(
		{ ...draft, atTime: '07:15', scheduleTouched: true },
		{ existing: task, now: NOW },
	);
	assert.equal(retimed.payload.schedule.atTime, '07:15');
	assert.equal(retimed.payload.timezone, 'UTC');
});

test('editing never rewrites a model or permission mode the user did not touch', () => {
	const task = makeTask({ permissionMode: 'workspace_write', enabled: false });
	const draft = draftFromTask(task, { now: NOW });
	assert.equal(draft.permissionMode, 'workspace_write');
	assert.equal(draft.modelId, localModel.id);
	const result = buildTaskPayload({ ...draft, name: 'Renamed while paused' }, { existing: task, now: NOW });
	assert.equal(result.payload.permissionMode, undefined);
	assert.equal(result.payload.model, undefined);
	assert.equal(result.payload.enabled, undefined);
});

test('drafts round-trip every supported recurrence', () => {
	const weekdays = makeTask({
		schedule: { type: 'weekdays', atTime: '17:45', startAt: Date.UTC(2026, 0, 5, 17, 45), weekdays: [1, 5] },
	});
	const weekdaysDraft = draftFromTask(weekdays, { now: NOW });
	assert.equal(weekdaysDraft.scheduleType, 'weekdays');
	assert.deepEqual(weekdaysDraft.weekdays, [1, 5]);
	assert.equal(weekdaysDraft.atTime, '17:45');
	assert.equal(weekdaysDraft.startDate, '2026-01-05');

	const once = makeTask({ schedule: { type: 'once', at: Date.UTC(2026, 1, 3, 14, 30) } });
	const onceDraft = draftFromTask(once, { now: NOW });
	assert.equal(onceDraft.onceDate, '2026-02-03');
	assert.equal(onceDraft.onceTime, '14:30');

	const every = makeTask({ schedule: { type: 'every_n_days', intervalDays: 4, atTime: '06:00', startAt: Date.UTC(2026, 0, 2, 6) } });
	const everyDraft = draftFromTask(every, { now: NOW });
	assert.equal(everyDraft.intervalDays, '4');
	assert.equal(buildTaskPayload(everyDraft, { existing: every, now: NOW }).unchanged, true);
});

test('summaries, filters and search read persisted state', () => {
	const tasks = [
		makeTask({ id: 'a', name: 'Alpha' }),
		makeTask({ id: 'b', name: 'Beta', enabled: false }),
		makeTask({ id: 'c', name: 'Gamma', lastStatus: 'blocked' }),
		makeTask({ id: 'd', name: 'Delta', nextRunAt: null }),
	];
	const runs = [makeRun({ id: 'run-a', taskId: 'a', status: 'running' })];
	const summary = summarize(tasks, runs, NOW);
	assert.deepEqual(summary.running.map((task) => task.id), ['a']);
	assert.deepEqual(summary.paused.map((task) => task.id), ['b']);
	assert.equal(summary.upcoming.length, 2); // a and c; d has no next run
	assert.deepEqual(filterTasks(tasks, runs, {}).map((task) => task.id), ['a', 'c', 'd', 'b']);
	assert.deepEqual(filterTasks(tasks, runs, { filter: 'running' }).map((task) => task.id), ['a']);
	assert.deepEqual(filterTasks(tasks, runs, { filter: 'paused' }).map((task) => task.id), ['b']);
	assert.deepEqual(filterTasks(tasks, runs, { filter: 'attention' }).map((task) => task.id), ['c']);
	assert.deepEqual(filterTasks(tasks, runs, { query: 'gam' }).map((task) => task.id), ['c']);
});

test('live events update the correct task and never invent task rows', () => {
	const initial = {
		tasks: [makeTask({ id: 'a', name: 'Alpha' }), makeTask({ id: 'b', name: 'Beta' })],
		runs: [makeRun({ id: 'run-a', taskId: 'a' })],
	};
	const renamed = { ...initial.tasks[0], name: 'Alpha renamed' };
	const afterTask = applyScheduledEvent(initial, { type: 'task-updated', task: renamed });
	assert.equal(afterTask.tasks.find((task) => task.id === 'a').name, 'Alpha renamed');
	assert.equal(afterTask.tasks.find((task) => task.id === 'b').name, 'Beta');

	const running = makeRun({ id: 'run-b', taskId: 'b', status: 'running' });
	const afterRun = applyScheduledEvent(afterTask, { type: 'run-updated', run: running });
	assert.equal(afterRun.runs.find((run) => run.id === 'run-b').status, 'running');
	assert.equal(afterRun.tasks.length, 2);

	const finished = applyScheduledEvent(afterRun, { type: 'run-updated', run: { ...running, status: 'failed' } });
	assert.equal(finished.runs.find((run) => run.id === 'run-b').status, 'failed');
	assert.equal(finished.runs.filter((run) => run.id === 'run-b').length, 1);

	const deleted = applyScheduledEvent(finished, { type: 'task-deleted', taskId: 'b' });
	assert.deepEqual(deleted.tasks.map((task) => task.id), ['a']);
	assert.ok(deleted.runs.some((run) => run.id === 'run-b'));

	assert.equal(applyScheduledEvent(initial, { type: 'tick' }), initial);
	assert.equal(applyScheduledEvent(initial, null), initial);
});

test('history refreshes only for the selected task and only on real status changes', () => {
	const previous = [makeRun({ id: 'run-1', taskId: 'a', status: 'queued' })];
	assert.equal(eventTouchesTask({ type: 'run-created', run: { id: 'run-2', taskId: 'a' } }, 'a'), true);
	assert.equal(eventTouchesTask({ type: 'run-created', run: { id: 'run-2', taskId: 'b' } }, 'a'), false);
	assert.equal(
		eventTouchesTask({ type: 'run-updated', run: makeRun({ id: 'run-1', taskId: 'a', status: 'running' }) }, 'a', previous),
		true,
	);
	assert.equal(
		eventTouchesTask({ type: 'run-updated', run: makeRun({ id: 'run-1', taskId: 'a', status: 'queued' }) }, 'a', previous),
		false,
	);
	assert.equal(eventTouchesTask({ type: 'tick' }, 'a'), false);
});

test('timezone validation matches what the scheduler accepts', () => {
	assert.equal(isValidTimezone('UTC'), true);
	assert.equal(isValidTimezone('Europe/London'), true);
	assert.equal(isValidTimezone('Not/AZone'), false);
	assert.equal(isValidTimezone(''), false);
});

// The renderer cannot import the scheduler's CommonJS module (Vite serves .cjs
// source without a default export), so the wall-clock math is mirrored here.
// This test is the contract that keeps both implementations identical.
test('renderer wall-clock math matches the scheduler for DST and offset edge cases', () => {
	const cases = [
		['2026-03-08', '02:30', 'America/New_York'], // spring forward gap
		['2026-11-01', '01:30', 'America/New_York'], // fall-back ambiguity
		['2026-03-29', '02:30', 'Europe/Berlin'],
		['2026-10-25', '02:15', 'Europe/London'],
		['2026-10-04', '02:15', 'Australia/Sydney'],
		['2026-04-05', '02:00', 'Australia/Lord_Howe'], // 30-minute DST shift
		['2026-01-15', '23:45', 'Asia/Kolkata'], // +05:30
		['2026-01-15', '00:05', 'Pacific/Kiritimati'], // +14:00
		['2026-06-01', '12:00', 'America/St_Johns'], // -02:30
		['2026-01-10', '09:00', 'UTC'],
	];
	for (const [date, time, timezone] of cases) {
		const [year, month, day] = date.split('-').map(Number);
		const [hour, minute] = time.split(':').map(Number);
		const expected = scheduleCalc.wallTimeToInstant(
			{ year, month, day, hour, minute, second: 0 },
			timezone,
		);
		assert.equal(wallTimeEpoch(date, time, timezone), expected, `${date} ${time} ${timezone}`);
		assert.equal(
			wallTimeToInstant({ year, month, day, hour, minute, second: 0 }, timezone),
			expected,
			`${date} ${time} ${timezone}`,
		);
	}
	assert.throws(() => wallTimeToInstant({ year: 2026, month: 1, day: 1 }, 'Not/AZone'), /Invalid IANA timezone/);
});

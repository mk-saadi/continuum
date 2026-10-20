import test from 'node:test';
import assert from 'node:assert/strict';
import {
	STEERING_STATE_LABELS,
	mergeSteeringHistory,
	mergeSteeringItem,
	steeringPromptsForRun,
	steeringRunIdForMessage,
	visibleSteeringForRun,
} from '../src/lib/steeringDisplay.mjs';

const item = (id, state, overrides = {}) => ({
	id,
	runId: 'run-1',
	state,
	content: `Instruction ${id}`,
	createdAt: `2026-10-20T10:00:0${id}.000Z`,
	...overrides,
});

test('active runs show every instruction for their own run', () => {
	const items = [
		item('1', 'delivered'),
		item('2', 'queued'),
		item('3', 'undelivered'),
		item('4', 'delivered', { runId: 'run-2' }),
	];
	assert.deepEqual(
		visibleSteeringForRun(items, 'run-1').map((row) => row.id),
		['1', '2', '3'],
	);
});

test('delivered instructions disappear when the run finishes', () => {
	const items = [
		item('1', 'delivered'),
		item('2', 'cancelled'),
		item('3', 'undelivered'),
	];
	assert.deepEqual(
		visibleSteeringForRun(items, null).map((row) => row.id),
		['3'],
		'only an undelivered failure remains after completion',
	);
});

test('a completed run with no failures hides the panel entirely', () => {
	const items = [item('1', 'delivered'), item('2', 'cancelled')];
	assert.deepEqual(visibleSteeringForRun(items, null), []);
	assert.deepEqual(visibleSteeringForRun([], null), []);
});

test('later state events never erase known instruction content', () => {
	const queued = item('1', 'delivered');
	const updated = mergeSteeringItem([queued], {
		id: '1',
		runId: 'run-1',
		state: 'undelivered',
		failureReason: 'The run ended.',
	});
	assert.equal(updated[0].state, 'undelivered');
	assert.equal(updated[0].content, 'Instruction 1');
	assert.equal(updated[0].failureReason, 'The run ended.');
});

test('a stale history read cannot regress a delivered row to queued', () => {
	const live = item('1', 'delivered');
	const persisted = item('1', 'queued');
	const merged = mergeSteeringHistory([live], [persisted]);
	assert.equal(merged[0].state, 'delivered');
	assert.equal(merged[0].content, 'Instruction 1');
});

test('history merge keeps new rows, sorts them, and preserves content', () => {
	const merged = mergeSteeringHistory(
		[item('2', 'queued')],
		[item('1', 'delivered'), item('2', 'delivered', { content: '' })],
	);
	assert.deepEqual(merged.map((row) => row.id), ['1', '2']);
	assert.equal(merged[1].state, 'delivered');
	assert.equal(merged[1].content, 'Instruction 2');
});

test('state labels cover every lifecycle state', () => {
	assert.deepEqual(Object.keys(STEERING_STATE_LABELS).sort(), [
		'cancelled',
		'claimed',
		'delivered',
		'queued',
		'undelivered',
	]);
});

test('additional prompts include only delivered instructions for the reply run', () => {
	const items = [
		item('2', 'delivered', { content: 'Second delivered' }),
		item('1', 'delivered', { content: 'First delivered' }),
		item('3', 'queued', { content: 'Still queued' }),
		item('4', 'undelivered', { content: 'Never delivered' }),
		item('5', 'cancelled', { content: 'Withdrawn' }),
		item('6', 'delivered', { runId: 'run-2', content: 'Other run' }),
		item('7', 'delivered', { content: '   ' }),
	];
	assert.deepEqual(
		steeringPromptsForRun(items, 'run-1').map((row) => row.content),
		['First delivered', 'Second delivered'],
	);
});

test('additional prompts disappear when the reply has no run id', () => {
	assert.deepEqual(steeringPromptsForRun([item('1', 'delivered')], null), []);
	assert.deepEqual(steeringPromptsForRun([item('1', 'delivered')], ''), []);
});

test('the footer follows the active reply variant run', () => {
	assert.equal(
		steeringRunIdForMessage({ role: 'assistant', run_id: 'run-current' }),
		'run-current',
	);
	assert.equal(
		steeringRunIdForMessage({
			role: 'assistant',
			run_id: 'run-message',
			active_variant_index: 1,
			variants: [{ run_id: 'run-first' }, { run_id: 'run-second' }],
		}),
		'run-second',
	);
	assert.equal(
		steeringRunIdForMessage({
			role: 'assistant',
			run_id: 'run-message',
			active_variant_index: 0,
			variants: [{ run_id: 'run-first' }, { run_id: 'run-second' }],
		}),
		'run-first',
	);
	assert.equal(
		steeringRunIdForMessage({
			role: 'assistant',
			run_id: 'run-message',
			active_variant_index: 0,
			variants: [{ content: 'Legacy variant without a run id' }],
		}),
		null,
		'legacy variants do not inherit a different run\'s prompts',
	);
	assert.equal(steeringRunIdForMessage({ role: 'user', run_id: 'run-user' }), null);
});

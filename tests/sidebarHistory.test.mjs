import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	getRecentSessions,
	mapSessionGroups,
	sessionsForProject,
	sessionsWithoutProject,
} from '../src/lib/sidebarHistory.mjs';

const session = (id, patch = {}) => ({ id, title: id, ...patch });

describe('sessionsWithoutProject / sessionsForProject', () => {
	it('splits one shared list with no loss and no mixing', () => {
		const sessions = [
			session('a'),
			session('b', { project_id: 'p1' }),
			session('c', { project_id: 'p2' }),
			session('d', { project_id: null }),
		];
		assert.deepEqual(
			sessionsWithoutProject(sessions).map((s) => s.id),
			['a', 'd'],
		);
		assert.deepEqual(
			sessionsForProject(sessions, 'p1').map((s) => s.id),
			['b'],
		);
		const combined = [
			...sessionsWithoutProject(sessions),
			...sessionsForProject(sessions, 'p1'),
			...sessionsForProject(sessions, 'p2'),
		].map((s) => s.id).sort();
		assert.deepEqual(combined, ['a', 'b', 'c', 'd']);
	});
	it('handles empty history and null project bindings', () => {
		assert.deepEqual(sessionsWithoutProject([]), []);
		assert.deepEqual(sessionsForProject([], 'p1'), []);
		assert.deepEqual(sessionsWithoutProject(null), []);
		assert.deepEqual(sessionsForProject(null, 'p1'), []);
		assert.deepEqual(sessionsForProject(sessionsWithoutProject([session('a')]), null), []);
		assert.deepEqual(
			sessionsForProject([session('a', { project_id: 'p1' })], null),
			[],
		);
	});
});

describe('mapSessionGroups', () => {
	it('preserves nested folder structure while filtering sessions', () => {
		const groups = [
			{ folder_name: 'Work', sessions: [session('a'), session('b', { project_id: 'p1' })] },
			{ folder_name: 'Uncategorized', sessions: [session('c', { project_id: 'p1' })] },
		];
		const casual = mapSessionGroups(groups, sessionsWithoutProject);
		assert.deepEqual(
			casual.map((g) => [g.folder_name, g.sessions.map((s) => s.id)]),
			[
				['Work', ['a']],
				['Uncategorized', []],
			],
		);
		const workspace = mapSessionGroups(groups, (list) => sessionsForProject(list, 'p1'));
		assert.deepEqual(
			workspace.map((g) => [g.folder_name, g.sessions.map((s) => s.id)]),
			[
				['Work', ['b']],
				['Uncategorized', ['c']],
			],
		);
	});
	it('handles empty groups', () => {
		assert.deepEqual(mapSessionGroups([], sessionsWithoutProject), []);
		assert.deepEqual(mapSessionGroups(null, sessionsWithoutProject), []);
	});
});

describe('getRecentSessions', () => {
	it('orders by recency, most recent first', () => {
		const sessions = [
			session('old', { last_active_at: '2024-01-01' }),
			session('new', { last_active_at: '2026-05-01' }),
			session('mid', { last_active_at: '2025-06-01' }),
		];
		assert.deepEqual(
			getRecentSessions(sessions).map((s) => s.id),
			['new', 'mid', 'old'],
		);
	});
	it('caps the list and pushes timestamp-less sessions last', () => {
		const sessions = Array.from({ length: 10 }, (_, i) =>
			session(`s${i}`, { last_active_at: `2026-01-${String(i + 1).padStart(2, '0')}` }),
		);
		sessions.push(session('nodate'));
		const recent = getRecentSessions(sessions, 6);
		assert.equal(recent.length, 6);
		assert.equal(recent[0].id, 's9');
		assert.ok(!recent.some((s) => s.id === 'nodate'));
		assert.equal(getRecentSessions(sessions, 20).at(-1).id, 'nodate');
	});
	it('handles empty history', () => {
		assert.deepEqual(getRecentSessions([]), []);
		assert.deepEqual(getRecentSessions(null), []);
	});
});

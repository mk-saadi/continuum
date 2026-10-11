import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	extractSubagentRuns,
	extractToolCalls,
	getNextTabIndex,
	getSidebarMode,
	isPromptDirty,
	summarizeActivity,
} from '../src/lib/sidebarControls.mjs';

describe('getSidebarMode', () => {
	it('treats unbound chats as casual', () => {
		assert.equal(getSidebarMode(null), 'casual');
		assert.equal(getSidebarMode(undefined), 'casual');
	});
	it('treats project-bound chats as workspace', () => {
		assert.equal(getSidebarMode('project-1'), 'workspace');
		assert.equal(getSidebarMode('session-project-id'), 'workspace');
	});
});

describe('getNextTabIndex', () => {
	it('wraps ArrowLeft/ArrowRight through every tab', () => {
		assert.equal(getNextTabIndex('ArrowRight', 2, 3), 0);
		assert.equal(getNextTabIndex('ArrowLeft', 0, 3), 2);
		assert.equal(getNextTabIndex('ArrowRight', 0, 3), 1);
		assert.equal(getNextTabIndex('ArrowLeft', 1, 3), 0);
	});
	it('maps Home/End to first/last regardless of tab count', () => {
		assert.equal(getNextTabIndex('Home', 2, 3), 0);
		assert.equal(getNextTabIndex('End', 0, 3), 2);
		assert.equal(getNextTabIndex('Home', 1, 5), 0);
		assert.equal(getNextTabIndex('End', 1, 5), 4);
	});
	it('ignores other keys', () => {
		assert.equal(getNextTabIndex('Enter', 0, 3), null);
		assert.equal(getNextTabIndex('Tab', 0, 3), null);
	});
});

describe('isPromptDirty', () => {
	it('detects unsaved edits and clean states', () => {
		assert.equal(isPromptDirty('a', 'a'), false);
		assert.equal(isPromptDirty('a ', 'a'), true);
		assert.equal(isPromptDirty('', ''), false);
		assert.equal(isPromptDirty(undefined, ''), false);
		assert.equal(isPromptDirty('x', undefined), true);
	});
});

const toolMessage = (id, steps) => ({ id, role: 'assistant', executionSteps: steps });
const toolStep = (id, toolName, status) => ({ id, type: 'tool_call', toolName, status });

describe('extractToolCalls / extractSubagentRuns', () => {
	it('collects tool calls across messages and skips thoughts', () => {
		const messages = [
			toolMessage(1, [
				{ id: 't1', type: 'thought', content: 'hmm' },
				toolStep('c1', 'read_project_file', 'complete'),
			]),
			{ id: 2, role: 'user', executionSteps: [toolStep('c2', 'read_project_file', 'complete')] },
			toolMessage(3, [toolStep('c3', 'spawn_sub_agent', 'running')]),
		];
		const calls = extractToolCalls(messages);
		assert.deepEqual(
			calls.map((call) => call.toolName),
			['read_project_file', 'spawn_sub_agent'],
		);
		const runs = extractSubagentRuns(messages);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].toolName, 'spawn_sub_agent');
		assert.equal(runs[0].status, 'running');
	});
	it('recognizes every known subagent tool', () => {
		const messages = [
			toolMessage(1, [
				toolStep('a', 'spawn_sub_agent', 'complete'),
				toolStep('b', 'delegate_task', 'error'),
				toolStep('c', 'extract_web_page_data', 'cancelled'),
				toolStep('d', 'execute_command', 'complete'),
			]),
		];
		assert.equal(extractSubagentRuns(messages).length, 3);
	});
	it('handles missing runtime data without throwing', () => {
		assert.deepEqual(extractToolCalls(null), []);
		assert.deepEqual(extractToolCalls(undefined), []);
		assert.deepEqual(extractSubagentRuns([]), []);
		assert.deepEqual(summarizeActivity().recentTools, []);
	});
});

describe('summarizeActivity', () => {
	const base = { messages: [] };
	it('reports idle with no activity', () => {
		const summary = summarizeActivity(base);
		assert.equal(summary.status, 'idle');
		assert.equal(summary.statusLabel, 'Idle');
		assert.equal(summary.toolStats.total, 0);
	});
	it('prioritizes pauses, then approvals, then generation', () => {
		assert.equal(summarizeActivity({ ...base, streaming: true }).status, 'generating');
		assert.equal(
			summarizeActivity({ ...base, streaming: true, toolApprovals: [{ approvalId: 'a' }] }).status,
			'awaiting_approval',
		);
		assert.equal(
			summarizeActivity({
				...base,
				streaming: true,
				toolApprovals: [{ approvalId: 'a' }],
				toolLimit: { requestId: 'r' },
			}).status,
			'paused',
		);
	});
	it('labels questions distinctly from approvals', () => {
		const summary = summarizeActivity({ ...base, pendingQuestions: { s1: { stepId: 's1' } } });
		assert.equal(summary.status, 'awaiting_approval');
		assert.equal(summary.statusLabel, 'Question for you');
		assert.equal(summary.questionCount, 1);
	});
	it('counts tool outcomes from real message steps', () => {
		const summary = summarizeActivity({
			messages: [
				toolMessage(1, [
					toolStep('a', 'execute_command', 'complete'),
					toolStep('b', 'spawn_sub_agent', 'running'),
					toolStep('c', 'read_project_file', 'error'),
				]),
			],
		});
		assert.equal(summary.toolStats.total, 3);
		assert.equal(summary.toolStats.running, 1);
		assert.equal(summary.toolStats.complete, 1);
		assert.equal(summary.toolStats.error, 1);
		assert.equal(summary.recentTools[0].toolName, 'read_project_file');
	});
	it('keeps only the eight most recent tools, newest first', () => {
		const steps = Array.from({ length: 10 }, (_, index) =>
			toolStep(`c${index}`, `tool_${index}`, 'complete'),
		);
		const summary = summarizeActivity({ messages: [toolMessage(1, steps)] });
		assert.equal(summary.recentTools.length, 8);
		assert.equal(summary.recentTools[0].toolName, 'tool_9');
	});
});

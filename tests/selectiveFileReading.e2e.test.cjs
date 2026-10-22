'use strict';
// Phase 2.5A mandatory end-to-end agent-loop exercise. The loop, tool schema,
// permission guard, dispatcher, result formatting, steering injection and
// context recovery are the real implementations. Only the model transport is a
// deterministic stub; no inference provider is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-read-e2e-db-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	if (name === 'electron') {
		return {
			app: { isReady: () => true, getPath: () => appDir },
			ipcMain: { handle: () => {}, removeHandler: () => {} },
		};
	}
	return originalLoad.call(this, name, ...args);
};
const db = require('../src/main/db');
db.initDatabase(appDir);
const { executeAgentTool } = require('../src/main/tools/agentTools');
const { getToolContext } = require('../src/main/promptBuilder');
const projects = require('../src/main/projectManager');
const sessions = require('../src/main/sessionManager');
const { buildTurnDigest } = require('../src/main/turnDigest');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const wireHash = (value) => `sha256:${sha256(value)}`;
const chunk = (delta, finishReason = null) => ({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
function stream(chunks) {
	const bytes = new TextEncoder().encode(
		`${chunks.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`,
	);
	return new Response(new ReadableStream({
		start(controller) {
			for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.slice(index, index + 17));
			controller.close();
		},
	}));
}
const toolResponse = (id, name, args) => [
	chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }),
	chunk({}, 'tool_calls'),
];
const finalResponse = (content) => [chunk({ content }), chunk({}, 'stop')];

test('Phase 2.5A end-to-end: search -> ranged read -> paginated continuation -> version mismatch -> refresh -> finish', async () => {
	const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-read-e2e-ws-'));
	const root = path.join(base, 'workspace');
	fs.mkdirSync(root);
	fs.mkdirSync(path.join(root, 'src'));
	const lines = Array.from({ length: 4000 }, (_, index) =>
		index === 819 ? 'export function targetFunction() {' : `const line${index + 1} = ${index + 1};`);
	const source = `${lines.join('\n')}\n`;
	fs.writeFileSync(path.join(root, 'src', 'target.js'), source);
	fs.writeFileSync(path.join(root, 'src', 'untouched.js'), 'export const untouched = true;\n');
	const sourceHash = wireHash(Buffer.from(source, 'utf8'));

	const project = projects.createProject({ name: 'selective-read-e2e', root_path: root });
	const sessionId = 'selective-read-e2e-chat';
	sessions.getOrCreateSession(sessionId, 'e2e-model', project.id);
	const toolContext = getToolContext([], true, sessionId, 'workspace_write');

	const calls = [];
	let lastSteps = [];
	let finalText = '';
	let firstHash = null;
	let currentHash = null;
	let modified = false;
	const delivered = [];
	let steeringReads = 0;
	const requests = [];

	const executeTool = async ({ name, arguments: rawArguments }) => {
		const args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
		const result = await executeAgentTool({
			name,
			arguments: args,
			sessionId,
			permissionMode: 'workspace_write',
		});
		calls.push({ name, args, result });
		if (name === 'read_project_file' && args.start_line === 800) firstHash = result.content_hash;
		if (name === 'read_project_file' && args.start_line === 901) {
			if (result.outcome === 'version_mismatch') currentHash = result.current_content_hash;
			else if (result.success && result.content) currentHash = result.content_hash;
		}
		// A controlled external modification after the second page succeeds,
		// before the next version-aware page request.
		if (name === 'read_project_file' && args.start_line === 901 && result.success && !modified) {
			modified = true;
			fs.appendFileSync(path.join(root, 'src', 'target.js'), 'export const externalChange = true;\n');
		}
		return result;
	};

	const responses = [
		() => toolResponse('call-search', 'search_project_content', { query: 'targetFunction' }),
		() => toolResponse('call-read-1', 'read_project_file', {
			relative_path: 'src/target.js', start_line: 800, end_line: 900,
		}),
		() => toolResponse('call-read-2', 'read_project_file', {
			relative_path: 'src/target.js', start_line: 901, end_line: 1000,
			expected_content_hash: firstHash,
		}),
		() => toolResponse('call-read-mismatch', 'read_project_file', {
			relative_path: 'src/target.js', start_line: 901, end_line: 1000,
			expected_content_hash: firstHash,
		}),
		() => toolResponse('call-read-refresh', 'read_project_file', {
			relative_path: 'src/target.js', start_line: 901, end_line: 1000,
			expected_content_hash: currentHash,
		}),
		() => finalResponse('Investigation complete.'),
	];

	let round = 0;
	const fetchImpl = async (_url, options) => {
		const body = JSON.parse(options.body);
		requests.push(body);
		const next = responses[Math.min(round, responses.length - 1)];
		round += 1;
		return stream(next());
	};

	finalText = await runMemoryChat({
		baseUrl: 'http://stub.invalid',
		modelId: 'e2e-model',
		messages: [
			{ role: 'system', content: 'You are a coding agent. Use tools precisely.' },
			{ role: 'user', content: 'Inspect targetFunction and continue the file from the returned hash.' },
		],
		chatTools: toolContext.tools,
		executeTool,
		projectId: project.id,
		fetchImpl,
		maxToolRounds: 20,
		maxAutoTurns: 20,
		onText: (text) => { finalText += text; },
		onExecutionSteps: (steps) => { lastSteps = steps; },
		takeSteeringInstructions: async () => {
			steeringReads += 1;
			return steeringReads === 2
				? [{ id: 'steer-1', content: 'Keep the investigation scoped to targetFunction.', deliveryRequestId: 'run-request-1' }]
				: [];
		},
		markSteeringDelivered: async (ids, requestId) => { delivered.push({ ids, requestId }); },
	});

	assert.equal(finalText.trim(), 'Investigation complete.');
	assert.equal(round, 6, 'the loop made exactly the six deterministic model requests');
	assert.deepEqual(calls.map((entry) => entry.name), [
		'search_project_content',
		'read_project_file',
		'read_project_file',
		'read_project_file',
		'read_project_file',
	]);
	assert.deepEqual(calls.map((entry) => entry.args.start_line).filter((value) => value !== undefined), [800, 901, 901, 901]);

	// Search result points at line 820, which the model used to pick 800-900.
	const search = calls[0].result;
	assert.equal(search.matches[0].line_number, 820);
	assert.match(search.matches[0].file_path, /src\/target\.js$/);

	const firstRead = calls[1].result;
	assert.equal(firstRead.success, true);
	assert.equal(firstRead.actual_start_line, 800);
	assert.equal(firstRead.actual_end_line, 900);
	assert.equal(firstRead.total_lines, 4000);
	assert.equal(firstRead.content_hash, sourceHash);
	assert.equal(firstRead.has_more, true);
	assert.equal(firstRead.next_start_line, 901);
	assert.doesNotMatch(firstRead.content, /const line1 = 1;/);
	assert.match(firstRead.content, /export function targetFunction\(\) \{/);

	const secondRead = calls[2].result;
	assert.equal(secondRead.success, true);
	assert.equal(secondRead.content_hash, firstRead.content_hash);
	assert.equal(secondRead.actual_start_line, 901);
	assert.equal(secondRead.actual_end_line, 1000);
	assert.equal(secondRead.content.split('\n').filter(Boolean).length, 100);

	const mismatch = calls[3].result;
	assert.equal(mismatch.success, false);
	assert.equal(mismatch.code, 'STALE_FILE');
	assert.equal(mismatch.outcome, 'version_mismatch');
	assert.equal(mismatch.expected_content_hash, firstRead.content_hash);
	assert.notEqual(mismatch.current_content_hash, firstRead.content_hash);
	assert.equal(Object.hasOwn(mismatch, 'content'), false);

	const refreshed = calls[4].result;
	assert.equal(refreshed.success, true);
	assert.equal(refreshed.content_hash, mismatch.current_content_hash);
	assert.equal(refreshed.actual_start_line, 901);
	assert.equal(refreshed.actual_end_line, 1000);
	assert.match(refreshed.content, /const line901 = 901;/);

	// Steering is delivered exactly once in a real request body and never lost.
	assert.deepEqual(delivered, [{ ids: ['steer-1'], requestId: 'run-request-1' }]);
	assert.ok(requests.some((request) => JSON.stringify(request.messages).includes('Keep the investigation scoped to targetFunction.')));

	// Tool-call/result ordering is preserved and no call ran twice.
	assert.deepEqual(lastSteps.filter((step) => step.type === 'tool_call').map((step) => step.toolName), [
		'search_project_content',
		'read_project_file',
		'read_project_file',
		'read_project_file',
		'read_project_file',
	]);
	assert.ok(lastSteps.filter((step) => step.type === 'tool_call').every((step) => step.status === 'complete' || step.status === 'error'));

	// The run never changed an unrelated file and never wrote to target.js.
	assert.equal(fs.readFileSync(path.join(root, 'src', 'untouched.js'), 'utf8'), 'export const untouched = true;\n');
	assert.match(fs.readFileSync(path.join(root, 'src', 'target.js'), 'utf8'), /externalChange/);

	// The work-log digest for the ranged call carries line coverage, not source.
	const digest = buildTurnDigest([{
		type: 'tool_call', id: 'call-read-1', toolName: 'read_project_file', status: 'complete',
		args: calls[1].args, result: firstRead,
	}], { turnSeq: 1 });
	assert.match(digest.text, /read src\/target\.js lines 800–900 of 4000/);
	assert.doesNotMatch(digest.text, /targetFunction\(\) \{/);

	db.closeDatabase();
	fs.rmSync(base, { recursive: true, force: true });
	fs.rmSync(appDir, { recursive: true, force: true });
});

'use strict';
// Phase 2.5A: selective line-range reads, bounded pagination, and file-version
// consistency. Exercises the real executeAgentTool dispatcher and the same
// permission/session plumbing the main agent uses. Every fixture is a
// disposable temporary directory; no live user data is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-read-db-'));
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
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const { getToolContext } = require('../src/main/promptBuilder');
const { buildTurnDigest } = require('../src/main/turnDigest');
const { trimToolResult } = require('../src/main/subagents/contextRecovery');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');
const projects = require('../src/main/projectManager');
const sessions = require('../src/main/sessionManager');

const roots = [];
function makeWorkspace(files = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-read-ws-'));
	const root = path.join(base, 'workspace');
	fs.mkdirSync(root);
	roots.push(base);
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		if (Buffer.isBuffer(content)) fs.writeFileSync(abs, content);
		else if (content && typeof content === 'object' && content.$symlink) fs.symlinkSync(content.$symlink, abs);
		else fs.writeFileSync(abs, content);
	}
	return root;
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const wireHash = (value) => `sha256:${sha256(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'))}`;

let seq = 0;
const projectByRoot = new Map();
const sessionByRoot = new Map();
function sessionFor(root) {
	if (sessionByRoot.has(root)) return sessionByRoot.get(root);
	let project = projectByRoot.get(root);
	if (!project) {
		project = projects.createProject({ name: `selective-read-${++seq}`, root_path: root });
		projectByRoot.set(root, project);
	}
	const id = `selective-read-chat-${++seq}`;
	sessions.getOrCreateSession(id, 'model', project.id);
	sessionByRoot.set(root, id);
	return id;
}
function call(root, name, args, mode = 'workspace_write') {
	return executeAgentTool({ name, arguments: args, sessionId: sessionFor(root), permissionMode: mode });
}
function childCall(root, name, args, mode = 'read_only') {
	return executeAgentTool({ name, arguments: args, sessionId: null, permissionMode: mode, rootPath: root });
}
const numbered = (count, prefix = 'line') =>
	Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

test.after(() => {
	try { db.closeDatabase(); } catch {}
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(appDir, { recursive: true, force: true });
});

test('1-7. schema, compatibility, defaults, page cap, and existing limits', async () => {
	const root = makeWorkspace({ 'full.txt': 'line one\nline two\n', 'large.txt': `${'x'.repeat(25000)}\n` });
	const definition = agentTools.find((tool) => tool.function.name === 'read_project_file').function;
	assert.deepEqual(definition.parameters.required, []);
	assert.ok(definition.parameters.properties.attachment_id);
	for (const key of ['start_line', 'end_line', 'if_content_hash', 'expected_content_hash']) {
		assert.ok(definition.parameters.properties[key], `missing ${key}`);
	}
	assert.equal(definition.parameters.properties.start_line.minimum, 1);
	assert.equal(definition.parameters.properties.end_line.minimum, 1);

	// Small default pages retain exact source bytes with R2 navigation metadata.
	const full = await call(root, 'read_project_file', { relative_path: 'full.txt' });
	assert.equal(full.success, true);
	assert.equal(full.content, 'line one\nline two\n');
	assert.equal(full.content_hash, wireHash('line one\nline two\n'));
	assert.equal(full.size_bytes, Buffer.byteLength('line one\nline two\n'));
	assert.equal(full.total_lines, 2);
	assert.equal(full.actual_start_line, 1);

	// Existing conditional unchanged read is unchanged.
	const unchanged = await call(root, 'read_project_file', {
		relative_path: 'full.txt',
		if_content_hash: full.content_hash,
	});
	assert.equal(unchanged.not_modified, true);
	assert.equal(Object.hasOwn(unchanged, 'content'), false);

	// R2 refuses to label a partial long line complete.
	const large = await call(root, 'read_project_file', { relative_path: 'large.txt' });
	assert.equal(large.code, 'LINE_TOO_LONG');
	assert.equal(large.content_truncated, true);
	assert.equal(large.next_char_start, 0);
	assert.equal(Object.hasOwn(large, 'content'), false);

	const pageRoot = makeWorkspace({ 'many.txt': numbered(1000) });
	const page = await call(pageRoot, 'read_project_file', { relative_path: 'many.txt', start_line: 1, end_line: 10 });
	assert.equal(page.success, true);
	assert.equal(page.start_line, 1);
	assert.equal(page.end_line, 10);
	assert.equal(page.actual_start_line, 1);
	assert.equal(page.actual_end_line, 10);
	assert.equal(page.total_lines, 1000);
	assert.equal(page.has_more, true);
	assert.equal(page.next_start_line, 11);
	assert.equal(page.content, numbered(10));
	assert.equal(page.content_hash, wireHash(numbered(1000)));

	const startOnly = await call(pageRoot, 'read_project_file', { relative_path: 'many.txt', start_line: 10 });
	assert.equal(startOnly.actual_start_line, 10);
	assert.equal(startOnly.actual_end_line, 209);
	assert.equal(startOnly.total_lines, 1000);
	assert.equal(startOnly.has_more, true);
	assert.equal(startOnly.next_start_line, 210);

	const capped = await call(pageRoot, 'read_project_file', { relative_path: 'many.txt', start_line: 1, end_line: 1000 });
	assert.equal(capped.actual_end_line, 400);
	assert.equal(capped.truncated, true);
	assert.equal(capped.truncation_reason, 'page_limit');
	assert.equal(capped.has_more, true);
	assert.equal(capped.next_start_line, 401);
	assert.equal(capped.content.split('\n').filter(Boolean).length, 400);
});

test('8-20. line accuracy, EOF, line endings, blank lines, Unicode, and invalid input', async () => {
	const noFinal = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
	const root = makeWorkspace({
		'plain.txt': `${noFinal}\n`,
		'no-final.txt': noFinal,
		'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
		'blank.txt': 'a\n\nc\n',
		'unicode.txt': 'α\n🌍 日本語\n',
		'empty.txt': '',
	});
	const first = await call(root, 'read_project_file', { relative_path: 'plain.txt', start_line: 1, end_line: 1 });
	assert.equal(first.content, 'alpha\n');
	assert.equal(first.total_lines, 4);
	const middle = await call(root, 'read_project_file', { relative_path: 'plain.txt', start_line: 2, end_line: 3 });
	assert.equal(middle.content, 'beta\ngamma\n');
	const last = await call(root, 'read_project_file', { relative_path: 'plain.txt', start_line: 4, end_line: 4 });
	assert.equal(last.content, 'delta\n');
	const noFinalLast = await call(root, 'read_project_file', { relative_path: 'no-final.txt', start_line: 4 });
	assert.equal(noFinalLast.content, 'delta');
	assert.equal(noFinalLast.total_lines, 4);
	assert.equal(noFinalLast.has_more, false);
	assert.equal(noFinalLast.next_start_line, null);
	const single = await call(root, 'read_project_file', { relative_path: 'no-final.txt', start_line: 2, end_line: 2 });
	assert.equal(single.content, 'beta\n');
	assert.equal(single.actual_start_line, 2);
	assert.equal(single.actual_end_line, 2);

	const crlf = await call(root, 'read_project_file', { relative_path: 'crlf.txt', start_line: 2, end_line: 2 });
	assert.equal(crlf.content, 'two\r\n');
	assert.equal(crlf.total_lines, 3);
	assert.equal(crlf.content_hash, wireHash('one\r\ntwo\r\nthree\r\n'));

	const blank = await call(root, 'read_project_file', { relative_path: 'blank.txt', start_line: 2, end_line: 2 });
	assert.equal(blank.content, '\n');
	assert.equal(blank.total_lines, 3);
	const blankLine = await call(root, 'read_project_file', { relative_path: 'blank.txt', start_line: 3, end_line: 3 });
	assert.equal(blankLine.content, 'c\n');

	const unicode = await call(root, 'read_project_file', { relative_path: 'unicode.txt', start_line: 2, end_line: 2 });
	assert.equal(unicode.content, '🌍 日本語\n');
	assert.equal(unicode.content_hash, wireHash('α\n🌍 日本語\n'));

	const beyond = await call(root, 'read_project_file', { relative_path: 'plain.txt', start_line: 3, end_line: 99 });
	assert.equal(beyond.actual_end_line, 4);
	assert.equal(beyond.total_lines, 4);
	assert.equal(beyond.has_more, false);
	assert.equal(beyond.next_start_line, null);
	assert.equal(Object.hasOwn(beyond, 'truncated'), false);

	const beyondStart = await call(root, 'read_project_file', { relative_path: 'plain.txt', start_line: 99 });
	assert.equal(beyondStart.success, false);
	assert.equal(beyondStart.code, 'LINE_RANGE_OUT_OF_BOUNDS');
	assert.equal(beyondStart.total_lines, 4);
	assert.equal(Object.hasOwn(beyondStart, 'content'), false);

	const emptyFull = await call(root, 'read_project_file', { relative_path: 'empty.txt' });
	assert.equal(emptyFull.success, true);
	assert.equal(emptyFull.content, '');
	const emptyRange = await call(root, 'read_project_file', { relative_path: 'empty.txt', start_line: 1 });
	assert.equal(emptyRange.success, false);
	assert.equal(emptyRange.code, 'LINE_RANGE_OUT_OF_BOUNDS');
	assert.equal(emptyRange.total_lines, 0);

	for (const [args, message] of [
		[{ start_line: 0 }, /start_line must be a positive integer/],
		[{ start_line: -2 }, /start_line must be a positive integer/],
		[{ start_line: 1.5 }, /start_line must be a positive integer/],
		[{ start_line: '2' }, /start_line must be a positive integer/],
		[{ end_line: 0 }, /end_line must be a positive integer/],
		[{ end_line: null }, /end_line must be a positive integer/],
		[{ start_line: 5, end_line: 2 }, /end_line must be >= start_line/],
		[{ start_line: 1000000001 }, /start_line must be a positive integer/],
	]) {
		const result = await call(root, 'read_project_file', { relative_path: 'plain.txt', ...args });
		assert.equal(result.success, false, JSON.stringify(args));
		assert.equal(result.code, 'INVALID_LINE_RANGE');
		assert.match(result.error, message);
	}
});

test('21-27. version-aware continuation, mismatch, conditional reads, concurrency, and mid-read changes', async () => {
	const root = makeWorkspace({ 'app.js': numbered(600, 'const x') });
	const first = await call(root, 'read_project_file', { relative_path: 'app.js', start_line: 1, end_line: 200 });
	assert.equal(first.actual_end_line, 200);
	assert.equal(first.has_more, true);
	const second = await call(root, 'read_project_file', {
		relative_path: 'app.js', start_line: 201, end_line: 400, expected_content_hash: first.content_hash,
	});
	assert.equal(second.success, true);
	assert.equal(second.content_hash, first.content_hash, 'stable files keep one version hash across pages');
	assert.equal(second.actual_start_line, 201);
	assert.equal(second.actual_end_line, 400);
	const expectedContent = numbered(600, 'const x').split('\n').slice(200, 400).join('\n') + '\n';
	assert.equal(second.content, expectedContent);

	// Unconditional continuation carries the same hash.
	const third = await call(root, 'read_project_file', { relative_path: 'app.js', start_line: 401, end_line: 600 });
	assert.equal(third.content_hash, first.content_hash);

	// Conditional unchanged range read stays compact.
	const unchanged = await call(root, 'read_project_file', {
		relative_path: 'app.js', start_line: 1, end_line: 200, if_content_hash: first.content_hash,
	});
	assert.equal(unchanged.not_modified, true);
	assert.equal(unchanged.content_hash, first.content_hash);
	assert.equal(Object.hasOwn(unchanged, 'content'), false);
	assert.equal(unchanged.has_more, true);
	assert.equal(unchanged.next_start_line, 201);

	// Concurrent readers never share mutable state.
	const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => call(root, 'read_project_file', {
		relative_path: 'app.js', start_line: index * 20 + 1, end_line: index * 20 + 20,
		expected_content_hash: first.content_hash,
	})));
	for (const result of concurrent) {
		assert.equal(result.success, true);
		assert.equal(result.content_hash, first.content_hash);
	}

	// External modification between pages is a structured mismatch, never
	// content from the changed version.
	fs.appendFileSync(path.join(root, 'app.js'), 'const appended = true;\n');
	const changedHash = wireHash(fs.readFileSync(path.join(root, 'app.js')));
	const mismatch = await call(root, 'read_project_file', {
		relative_path: 'app.js', start_line: 401, end_line: 600, expected_content_hash: first.content_hash,
	});
	assert.equal(mismatch.success, false);
	assert.equal(mismatch.code, 'STALE_FILE');
	assert.equal(mismatch.outcome, 'version_mismatch');
	assert.equal(mismatch.expected_content_hash, first.content_hash);
	assert.equal(mismatch.current_content_hash, changedHash);
	assert.equal(mismatch.total_lines, 601);
	assert.equal(Object.hasOwn(mismatch, 'content'), false);

	// A conditional read of the changed file returns fresh content, not stale.
	const refreshed = await call(root, 'read_project_file', {
		relative_path: 'app.js', start_line: 401, end_line: 600, if_content_hash: first.content_hash,
	});
	assert.equal(refreshed.not_modified, false);
	assert.equal(refreshed.content_hash, changedHash);
	assert.equal(refreshed.content, numbered(600, 'const x').split('\n').slice(400, 600).join('\n') + '\n');

	// The two version operations are deliberately separate arguments.
	const both = await call(root, 'read_project_file', {
		relative_path: 'app.js', start_line: 1, end_line: 10,
		if_content_hash: first.content_hash, expected_content_hash: first.content_hash,
	});
	assert.equal(both.success, false);
	assert.equal(both.code, 'INVALID_CONTENT_HASH_MODE');

	// Hash and content always describe the same bytes.
	const whole = fs.readFileSync(path.join(root, 'app.js'));
	const association = await call(root, 'read_project_file', { relative_path: 'app.js', start_line: 1, end_line: 3 });
	assert.equal(association.content_hash, `sha256:${sha256(whole)}`);
	assert.equal(association.size_bytes, whole.length);
	assert.equal(association.content, whole.toString('utf8').split('\n').slice(0, 3).join('\n') + '\n');

	// Deterministic mid-read modification: mutate after the first chunk on
	// every attempt. The reader must retry a bounded number of times and then
	// report an explicit unstable-file error, never a mixed snapshot.
	const unstable = path.join(root, 'unstable.txt');
	fs.writeFileSync(unstable, `${'stable line\n'.repeat(4000)}`);
	const realOpen = fsp.open;
	let opens = 0;
	fsp.open = async function patchedOpen(file, flags, ...rest) {
		const handle = await realOpen.call(this, file, flags, ...rest);
		if (path.resolve(file) !== path.resolve(unstable)) return handle;
		opens += 1;
		const originalRead = handle.read.bind(handle);
		let mutated = false;
		handle.read = async (...readArgs) => {
			const result = await originalRead(...readArgs);
			if (!mutated) {
				mutated = true;
				fs.appendFileSync(unstable, `changed during read ${opens}\n`);
			}
			return result;
		};
		return handle;
	};
	try {
		const unstableResult = await call(root, 'read_project_file', { relative_path: 'unstable.txt', start_line: 1, end_line: 10 });
		assert.equal(unstableResult.success, false);
		assert.equal(unstableResult.code, 'FILE_CHANGED_DURING_READ');
		assert.equal(Object.hasOwn(unstableResult, 'content'), false);
		assert.ok(opens >= 3, `expected bounded retries, saw ${opens} open(s)`);
	} finally {
		fsp.open = realOpen;
	}
});

test('28-34. path policy, permissions, child isolation, and no write side effects', async () => {
	const root = makeWorkspace({ 'inside.txt': numbered(50) });
	const base = path.dirname(root);
	fs.writeFileSync(path.join(base, 'outside.txt'), 'outside one\noutside two\n');
	fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'outside-link.txt'));

	// R2 enforces workspace containment on default and ranged reads.
	const inside = await call(root, 'read_project_file', { relative_path: 'inside.txt', start_line: 25, end_line: 26 });
	assert.equal(inside.success, true);
	assert.equal(inside.content, 'line 25\nline 26\n');

	const traversalFull = await call(root, 'read_project_file', { relative_path: '../outside.txt' });
	const traversalRange = await call(root, 'read_project_file', { relative_path: '../outside.txt', start_line: 2, end_line: 2 });
	assert.equal(traversalFull.success, false);
	assert.equal(traversalRange.success, false);
	assert.equal(Object.hasOwn(traversalRange, 'content_hash'), false);

	const linkFull = await call(root, 'read_project_file', { relative_path: 'outside-link.txt' });
	const linkRange = await call(root, 'read_project_file', { relative_path: 'outside-link.txt', start_line: 1, end_line: 1 });
	assert.equal(linkFull.success, false);
	assert.equal(linkRange.success, false);
	assert.equal(Object.hasOwn(linkRange, 'content_hash'), false);

	const absoluteRange = await call(root, 'read_project_file', { relative_path: path.join(root, 'inside.txt'), start_line: 1, end_line: 1 });
	assert.equal(absoluteRange.success, true);
	assert.equal(absoluteRange.content, 'line 1\n');

	// Read Only mode can range-read; it still cannot write.
	const readOnly = await call(root, 'read_project_file', { relative_path: 'inside.txt', start_line: 1, end_line: 2 }, 'read_only');
	assert.equal(readOnly.success, true);
	const deniedWrite = await call(root, 'write_project_file', {
		relative_path: 'inside.txt', content: 'overwritten', expected_content_hash: readOnly.content_hash,
	}, 'read_only');
	assert.equal(deniedWrite.success, false);
	assert.match(deniedWrite.error, /Read Only/);
	assert.equal(fs.readFileSync(path.join(root, 'inside.txt'), 'utf8'), numbered(50));

	// Authorized child dispatch uses the same implementation and stays read-only.
	assert.ok(CHILD_TOOL_NAMES.includes('read_project_file'));
	assert.ok(!CHILD_TOOL_NAMES.includes('write_project_file'));
	const childRange = await childCall(root, 'read_project_file', { relative_path: 'inside.txt', start_line: 10, end_line: 12 });
	assert.equal(childRange.success, true);
	assert.equal(childRange.content, 'line 10\nline 11\nline 12\n');
	assert.equal(childRange.total_lines, 50);
	const childWrite = await childCall(root, 'write_project_file', { relative_path: 'inside.txt', content: 'no' });
	assert.equal(childWrite.success, false);
	assert.equal(fs.readFileSync(path.join(root, 'inside.txt'), 'utf8'), numbered(50));

	// A read never mutates the file.
	const before = fs.statSync(path.join(root, 'inside.txt'));
	const read = await call(root, 'read_project_file', { relative_path: 'inside.txt', start_line: 1, end_line: 50 });
	const after = fs.statSync(path.join(root, 'inside.txt'));
	assert.equal(read.success, true);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test('35-41. main-agent schema, work log, activity fields, and compaction stay compatible', async () => {
	const root = makeWorkspace({ 'agent.js': numbered(900) });
	const sessionId = sessionFor(root);
	const context = getToolContext([], true, sessionId, 'workspace_write');
	const exposed = context.tools.find((tool) => tool.function.name === 'read_project_file');
	assert.ok(exposed);
	for (const key of ['start_line', 'end_line', 'expected_content_hash']) {
		assert.ok(exposed.function.parameters.properties[key], `model schema missing ${key}`);
	}

	const result = await call(root, 'read_project_file', { relative_path: 'agent.js', start_line: 820, end_line: 900 });
	assert.equal(result.success, true);
	assert.equal(result.actual_start_line, 820);
	assert.equal(result.actual_end_line, 900);
	assert.equal(result.total_lines, 900);
	assert.equal(result.has_more, false);

	const digest = buildTurnDigest([{
		type: 'tool_call', id: 'range-1', toolName: 'read_project_file', status: 'complete',
		args: { relative_path: 'agent.js', start_line: 820, end_line: 900 }, result,
	}], { turnSeq: 1 });
	assert.match(digest.text, /read agent\.js lines 820–900 of 900/);
	assert.doesNotMatch(digest.text, /line 820/);
	assert.ok(digest.text.length <= 2000);

	const { formatArgFields } = await import('../src/lib/executionEvents.mjs');
	const fields = formatArgFields({ toolName: 'read_project_file', args: { relative_path: 'agent.js', start_line: 820, end_line: 900 } });
	assert.ok(fields.some((field) => field.label === 'Lines' && field.value === '820–900'));

	// Child context recovery must still produce a bounded projection.
	const raw = JSON.stringify(result);
	const projected = trimToolResult(raw, { task: 'inspect agent.js', contextLength: 4096 });
	assert.equal(typeof projected, 'string');
	assert.ok(projected.length <= raw.length);
	assert.ok(projected.includes('agent.js'));

	// LSP positions are documented and implemented as 1-based in the tool
	// schema; the protocol conversion subtracts one in the adapter.
	const lspDefinition = agentTools.find((tool) => tool.function.name === 'lsp_definition').function;
	assert.equal(lspDefinition.parameters.properties.line.minimum, 1);
	const aroundLsp = await call(root, 'read_project_file', { relative_path: 'agent.js', start_line: 73, end_line: 74 });
	assert.equal(aroundLsp.content, 'line 73\nline 74\n');
});

test('42-45. large-file bounds, output reduction, latency, and descriptor cleanup', async () => {
	const root = makeWorkspace();
	const medium = numbered(4000, 'const value');
	const large = numbered(50000, 'const nested');
	fs.writeFileSync(path.join(root, 'medium.js'), medium);
	fs.writeFileSync(path.join(root, 'large.js'), large);

	const full = await call(root, 'read_project_file', { relative_path: 'medium.js' });
	const range = await call(root, 'read_project_file', { relative_path: 'medium.js', start_line: 2000, end_line: 2099 });
	assert.equal(range.success, true);
	assert.equal(range.total_lines, 4000);
	assert.equal(range.content.split('\n').filter(Boolean).length, 100);
	const fullChars = JSON.stringify(full).length;
	const rangeChars = JSON.stringify(range).length;
	assert.ok(rangeChars < fullChars, `range ${rangeChars} chars should be below full ${fullChars}`);
	assert.ok(rangeChars < 20000);

	const heapBefore = process.memoryUsage().heapUsed;
	const started = process.hrtime.bigint();
	const largeRange = await call(root, 'read_project_file', { relative_path: 'large.js', start_line: 25000, end_line: 25199 });
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	const heapAfter = process.memoryUsage().heapUsed;
	assert.equal(largeRange.success, true);
	assert.equal(largeRange.total_lines, 50000);
	assert.equal(largeRange.content.split('\n').filter(Boolean).length, 200);
	assert.ok(largeRange.content.length <= 20000);
	assert.ok(elapsedMs < 5000, `large range read took ${elapsedMs.toFixed(1)}ms`);
	assert.ok(heapAfter - heapBefore < 50 * 1024 * 1024, `heap grew by ${heapAfter - heapBefore} bytes`);

	const fdPath = '/proc/self/fd';
	if (fs.existsSync(fdPath)) {
		const before = fs.readdirSync(fdPath).length;
		for (let index = 0; index < 40; index += 1) {
			await call(root, 'read_project_file', { relative_path: 'medium.js', start_line: 1 + index, end_line: 20 + index });
		}
		const after = fs.readdirSync(fdPath).length;
		assert.ok(after - before <= 2, `descriptor count grew from ${before} to ${after}`);
	}
});

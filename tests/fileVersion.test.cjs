'use strict';
// Phase 2.0F: committed file metadata, conditional reads, and stale-write
// detection. Exercises the real executeAgentTool dispatch + permission guard
// over temporary workspaces. Run with: node --test tests/fileVersion.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-version-db-'));
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
const { executeAgentTool, agentTools, scopedPath } = require('../src/main/tools/agentTools');
const { guardTool } = require('../src/main/toolPermissions');
const recovery = require('../src/main/recoveryStore');
const { buildTurnDigest } = require('../src/main/turnDigest');
const { CHILD_TOOL_NAMES } = require('../src/main/subagents/agentLoop');

const roots = [];
function makeWorkspace(files = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'file-version-ws-'));
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
const projects = new Map();
const sessions = new Map();
function projectFor(root) {
	let project = projects.get(root);
	if (!project) {
		project = require('../src/main/projectManager').createProject({
			name: `file-version-${++seq}`,
			root_path: root,
		});
		projects.set(root, project);
	}
	return project;
}
function newSession(root) {
	const project = projectFor(root);
	const id = `file-version-chat-${++seq}`;
	require('../src/main/sessionManager').getOrCreateSession(id, 'model', project.id);
	return id;
}
function sessionFor(root) {
	let id = sessions.get(root);
	if (!id) {
		id = newSession(root);
		sessions.set(root, id);
	}
	return id;
}
function callWith(sessionId, name, args, mode = 'workspace_write') {
	return executeAgentTool({
		name,
		arguments: args,
		sessionId,
		permissionMode: mode,
	});
}
function call(root, name, args, mode = 'workspace_write') {
	return callWith(sessionFor(root), name, args, mode);
}
function childCall(root, name, args) {
	return executeAgentTool({
		name,
		arguments: args,
		sessionId: null,
		permissionMode: 'read_only',
		rootPath: root,
	});
}

test.after(() => {
	try { db.closeDatabase(); } catch {}
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(appDir, { recursive: true, force: true });
});

test('1-3. successful creation and replacement report committed SHA-256 and size', async () => {
	const root = makeWorkspace();
	const first = await call(root, 'write_project_file', {
		relative_path: 'src/new.txt',
		content: 'hello\nworld\n',
	});
	assert.equal(first.success, true);
	assert.equal(first.path, 'src/new.txt');
	assert.equal(first.created, true);
	assert.equal(first.verified, true);
	assert.equal(first.content_matches_input, true);
	assert.equal(first.content_hash, wireHash('hello\nworld\n'));
	assert.equal(first.size_bytes, Buffer.byteLength('hello\nworld\n'));
	assert.equal(typeof first.recoveryCheckpointId, 'number');
	assert.equal(fs.readFileSync(path.join(root, 'src/new.txt'), 'utf8'), 'hello\nworld\n');

	const replaced = await call(root, 'write_project_file', {
		relative_path: 'src/new.txt',
		content: 'replaced ✓\r\n',
	});
	assert.equal(replaced.success, true);
	assert.equal(replaced.created, false);
	assert.equal(replaced.content_hash, wireHash('replaced ✓\r\n'));
	assert.equal(replaced.size_bytes, Buffer.byteLength('replaced ✓\r\n'));
	assert.equal(fs.readFileSync(path.join(root, 'src/new.txt'), 'utf8'), 'replaced ✓\r\n');
});

test('4-5. hash is over actual bytes, not normalized text', async () => {
	const root = makeWorkspace();
	const content = 'a\r\nb ✓\n';
	const written = await call(root, 'write_project_file', { relative_path: 'bytes.txt', content });
	assert.equal(written.content_hash, wireHash(content));
	assert.notEqual(written.content_hash, wireHash(content.replace(/\r/g, '')));
	assert.equal(written.size_bytes, Buffer.byteLength(content, 'utf8'));

	const read = await call(root, 'read_project_file', { relative_path: 'bytes.txt' });
	assert.equal(read.content, content);
	assert.equal(read.content_hash, written.content_hash);
	assert.equal(read.size_bytes, written.size_bytes);
});

test('6. unconditional read stays a full read with version metadata', async () => {
	const root = makeWorkspace({ 'full.txt': 'line one\nline two\n' });
	const result = await call(root, 'read_project_file', { relative_path: 'full.txt' });
	assert.equal(result.success, true);
	assert.equal(result.content, 'line one\nline two\n');
	assert.equal(result.path, 'full.txt');
	assert.equal(result.content_hash, wireHash('line one\nline two\n'));
	assert.equal(result.size_bytes, Buffer.byteLength('line one\nline two\n'));
	assert.equal(Object.hasOwn(result, 'not_modified'), false);

	const definition = agentTools.find((tool) => tool.function.name === 'read_project_file').function;
	assert.deepEqual(definition.parameters.required, []);
	assert.ok(definition.parameters.properties.attachment_id);
	assert.equal((await call(root, 'read_project_file', {})).code, 'INVALID_READ_SOURCE');
	assert.equal((await call(root, 'read_project_file', { relative_path: 'full.txt', attachment_id: 'att_invalid' })).code, 'INVALID_READ_SOURCE');
	assert.ok(definition.parameters.properties.if_content_hash);
	assert.ok(definition.parameters.properties.start_line);
	assert.ok(definition.parameters.properties.end_line);
	assert.ok(definition.parameters.properties.expected_content_hash);
});

test('7. matching conditional read returns a compact unchanged response', async () => {
	const root = makeWorkspace({ 'same.txt': 'unchanged content\n' });
	const full = await call(root, 'read_project_file', { relative_path: 'same.txt' });
	const conditional = await call(root, 'read_project_file', {
		relative_path: 'same.txt',
		if_content_hash: full.content_hash,
	});
	assert.equal(conditional.success, true);
	assert.equal(conditional.not_modified, true);
	assert.equal(conditional.path, 'same.txt');
	assert.equal(conditional.content_hash, full.content_hash);
	assert.equal(conditional.size_bytes, full.size_bytes);
	assert.equal(Object.hasOwn(conditional, 'content'), false);
	assert.ok(JSON.stringify(conditional).length < JSON.stringify(full).length);

	// A bare lower/uppercase hex value is accepted and normalized.
	const bare = await call(root, 'read_project_file', {
		relative_path: 'same.txt',
		if_content_hash: full.content_hash.slice(7).toUpperCase(),
	});
	assert.equal(bare.not_modified, true);
	assert.equal(bare.content_hash, full.content_hash);
});

test('8. changed conditional read returns fresh content and the new hash', async () => {
	const root = makeWorkspace({ 'change.txt': 'version one\n' });
	const first = await call(root, 'read_project_file', { relative_path: 'change.txt' });
	fs.writeFileSync(path.join(root, 'change.txt'), 'version two\n');
	const changed = await call(root, 'read_project_file', {
		relative_path: 'change.txt',
		if_content_hash: first.content_hash,
	});
	assert.equal(changed.success, true);
	assert.equal(changed.not_modified, false);
	assert.equal(changed.content, 'version two\n');
	assert.equal(changed.content_hash, wireHash('version two\n'));
	assert.equal(changed.size_bytes, Buffer.byteLength('version two\n'));
	assert.notEqual(changed.content_hash, first.content_hash);

	const stable = await call(root, 'read_project_file', {
		relative_path: 'change.txt',
		if_content_hash: changed.content_hash,
	});
	assert.equal(stable.not_modified, true);
});

test('9. missing files keep the existing not-found error', async () => {
	const root = makeWorkspace();
	const read = await call(root, 'read_project_file', { relative_path: 'missing.txt' });
	assert.equal(read.success, false);
	assert.match(read.error, /FILE_NOT_FOUND/);

	const conditional = await call(root, 'read_project_file', {
		relative_path: 'missing.txt',
		if_content_hash: wireHash('anything'),
	});
	assert.equal(conditional.success, false);
	assert.match(conditional.error, /FILE_NOT_FOUND/);
});

test('10. malformed hash input is rejected before any read or write', async () => {
	const root = makeWorkspace({ 'safe.txt': 'safe\n' });
	for (const value of ['not-a-hash', 'sha256:xyz', 42, null]) {
		const read = await call(root, 'read_project_file', {
			relative_path: 'safe.txt',
			if_content_hash: value,
		});
		assert.equal(read.success, false, `read accepted ${JSON.stringify(value)}`);
		assert.match(read.error, /Invalid if_content_hash/);

		const write = await call(root, 'write_project_file', {
			relative_path: 'safe.txt',
			content: 'overwritten\n',
			expected_content_hash: value,
		});
		assert.equal(write.success, false, `write accepted ${JSON.stringify(value)}`);
		assert.match(write.error, /Invalid expected_content_hash/);
	}
	assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'safe\n');
});

test('11. empty files have the standard empty SHA-256 and zero size', async () => {
	const root = makeWorkspace();
	const written = await call(root, 'write_project_file', { relative_path: 'empty.txt', content: '' });
	assert.equal(written.success, true);
	assert.equal(written.size_bytes, 0);
	assert.equal(written.content_hash, `sha256:${sha256(Buffer.alloc(0))}`);
	assert.equal(
		written.content_hash,
		'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	);

	const conditional = await call(root, 'read_project_file', {
		relative_path: 'empty.txt',
		if_content_hash: written.content_hash,
	});
	assert.equal(conditional.not_modified, true);
	assert.equal(conditional.size_bytes, 0);
	const full = await call(root, 'read_project_file', { relative_path: 'empty.txt' });
	assert.equal(full.content, '');
});

test('12. Unicode content hashes and sizes are byte-accurate', async () => {
	const root = makeWorkspace();
	const content = 'héllo 🌍\n日本語\n';
	const written = await call(root, 'write_project_file', { relative_path: 'unicode.txt', content });
	assert.equal(written.content_hash, wireHash(content));
	assert.equal(written.size_bytes, Buffer.byteLength(content, 'utf8'));
	assert.notEqual(written.size_bytes, content.length);

	const read = await call(root, 'read_project_file', { relative_path: 'unicode.txt' });
	assert.equal(read.content, content);
	assert.equal(read.content_hash, written.content_hash);
	assert.equal(
		(await call(root, 'read_project_file', {
			relative_path: 'unicode.txt',
			if_content_hash: written.content_hash,
		})).not_modified,
		true,
	);
});

test('13. large files keep the bounded read while hashing the full bytes', async () => {
	const root = makeWorkspace();
	const content = `${'x'.repeat(25000)}\n`;
	const written = await call(root, 'write_project_file', { relative_path: 'large.txt', content });
	assert.equal(written.content_hash, wireHash(content));
	assert.equal(written.size_bytes, Buffer.byteLength(content));

	const read = await call(root, 'read_project_file', { relative_path: 'large.txt' });
	assert.equal(read.truncated, true);
	assert.equal(read.content.length, 20019);
	assert.ok(read.content.startsWith('x'.repeat(20000)));
	assert.ok(read.content.endsWith('\n[Output truncated]'));
	assert.equal(read.content_hash, written.content_hash);

	const unchanged = await call(root, 'read_project_file', {
		relative_path: 'large.txt',
		if_content_hash: written.content_hash,
	});
	assert.equal(unchanged.not_modified, true);
	assert.equal(Object.hasOwn(unchanged, 'content'), false);

	fs.appendFileSync(path.join(root, 'large.txt'), 'changed\n');
	const changed = await call(root, 'read_project_file', {
		relative_path: 'large.txt',
		if_content_hash: written.content_hash,
	});
	assert.equal(changed.not_modified, false);
	assert.equal(changed.truncated, true);
	assert.notEqual(changed.content_hash, written.content_hash);
});

test('14-15. binary files stay unreadable, including with a matching hash', async () => {
	const root = makeWorkspace();
	const binary = Buffer.from([0, 1, 2, 3, 255]);
	fs.writeFileSync(path.join(root, 'binary.bin'), binary);
	const read = await call(root, 'read_project_file', { relative_path: 'binary.bin' });
	assert.equal(read.success, false);
	assert.match(read.error, /Unsupported binary file/);

	const conditional = await call(root, 'read_project_file', {
		relative_path: 'binary.bin',
		if_content_hash: wireHash(binary),
	});
	assert.equal(conditional.success, false);
	assert.match(conditional.error, /Unsupported binary file/);

	const write = await call(root, 'write_project_file', {
		relative_path: 'nul.txt',
		content: 'before\0after',
	});
	assert.equal(write.success, false);
	assert.equal(fs.existsSync(path.join(root, 'nul.txt')), false);
});

test('16-17. traversal and symlink escapes stay rejected for writes', async () => {
	const root = makeWorkspace();
	const base = path.dirname(root);
	const traversal = await call(root, 'write_project_file', {
		relative_path: '../escape.txt',
		content: 'escape',
	});
	assert.equal(traversal.success, false);
	assert.equal(fs.existsSync(path.join(base, 'escape.txt')), false);

	const outside = path.join(base, 'outside');
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(root, 'link'));
	const throughLink = await call(root, 'write_project_file', {
		relative_path: 'link/evil.txt',
		content: 'escape',
	});
	assert.equal(throughLink.success, false);
	assert.match(throughLink.error, /Symlink escapes/);
	assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false);

	await assert.rejects(scopedPath(root, '../escape.txt'), /escapes the project root/);
	const absoluteOutside = await call(root, 'write_project_file', {
		relative_path: path.join(outside, 'absolute.txt'),
		content: 'escape',
	});
	assert.equal(absoluteOutside.success, false);
	assert.equal(fs.existsSync(path.join(outside, 'absolute.txt')), false);
});

test('18-20. reads stay available; writes keep permission and approval gates', async () => {
	const root = makeWorkspace({ 'readable.txt': 'read me\n' });
	const read = await call(root, 'read_project_file', { relative_path: 'readable.txt' }, 'read_only');
	assert.equal(read.success, true);
	assert.equal(read.content, 'read me\n');

	const directoryRead = await call(root, 'read_project_file', { relative_path: '.' }, 'read_only');
	assert.equal(directoryRead.success, false);
	assert.match(directoryRead.error, /regular file/);
	const emptyPath = await call(root, 'read_project_file', { relative_path: '' }, 'read_only');
	assert.equal(emptyPath.success, false);
	assert.match(emptyPath.error, /Invalid relative_path/);

	const denied = await call(root, 'write_project_file', {
		relative_path: 'denied.txt',
		content: 'no',
		expected_content_hash: wireHash('anything'),
	}, 'read_only');
	assert.equal(denied.success, false);
	assert.match(denied.error, /Read Only/);
	assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);

	// An outside-workspace write needs the existing approval path. Without an
	// approval channel the guard denies it; hash matching never substitutes
	// for authorization.
	const outsideArgs = { relative_path: '../approved.txt', content: 'approved' };
	const noApproval = await call(root, 'write_project_file', outsideArgs, 'ask_approval');
	assert.equal(noApproval.success, false);
	assert.match(noApproval.error, /approval denied/i);
	assert.equal(fs.existsSync(path.join(path.dirname(root), 'approved.txt')), false);

	const approval = await guardTool({
		name: 'write_project_file',
		args: outsideArgs,
		project: { root_path: root },
		permissionMode: 'ask_approval',
		requestApproval: async () => true,
	});
	const approved = await callWith(sessionFor(root), 'write_project_file', outsideArgs, 'ask_approval');
	assert.equal(approved.success, false, 'permissionGranted is required even with a prepared approval');
	const approvedWithGrant = await executeAgentTool({
		name: 'write_project_file',
		arguments: outsideArgs,
		sessionId: sessionFor(root),
		permissionMode: 'ask_approval',
		permissionGranted: true,
		approval,
	});
	assert.equal(approvedWithGrant.success, true);
	assert.equal(fs.readFileSync(path.join(path.dirname(root), 'approved.txt'), 'utf8'), 'approved');
});

test('21-25. expected-hash writes reject stale versions and never overwrite them', async () => {
	const root = makeWorkspace();
	const v1 = await call(root, 'write_project_file', { relative_path: 'stale.txt', content: 'version one\n' });
	const v2 = await call(root, 'write_project_file', {
		relative_path: 'stale.txt',
		content: 'version two\n',
		expected_content_hash: v1.content_hash,
	});
	assert.equal(v2.success, true);
	assert.equal(v2.created, false);
	assert.equal(v2.content_hash, wireHash('version two\n'));

	fs.writeFileSync(path.join(root, 'stale.txt'), 'external edit\n');
	const stale = await call(root, 'write_project_file', {
		relative_path: 'stale.txt',
		content: 'must not land\n',
		expected_content_hash: v2.content_hash,
	});
	assert.equal(stale.success, false);
	assert.equal(stale.code, 'STALE_FILE');
	assert.equal(stale.outcome, 'version_conflict');
	assert.equal(stale.expected_content_hash, v2.content_hash);
	assert.equal(stale.current_content_hash, wireHash('external edit\n'));
	assert.equal(stale.size_bytes, Buffer.byteLength('external edit\n'));
	assert.equal(fs.readFileSync(path.join(root, 'stale.txt'), 'utf8'), 'external edit\n');

	const current = await call(root, 'read_project_file', { relative_path: 'stale.txt' });
	assert.equal(current.content, 'external edit\n');
	assert.equal(current.content_hash, wireHash('external edit\n'), 'never serves stale content as current');

	const missing = await call(root, 'write_project_file', {
		relative_path: 'missing.txt',
		content: 'new',
		expected_content_hash: v1.content_hash,
	});
	assert.equal(missing.success, false);
	assert.equal(missing.code, 'STALE_FILE');
	assert.equal(missing.current_content_hash, null);
	assert.equal(fs.existsSync(path.join(root, 'missing.txt')), false);
});

test('23. concurrent workspace agents cannot silently clobber each other', async () => {
	const root = makeWorkspace();
	const agentA = newSession(root);
	const agentB = newSession(root);
	const first = await callWith(agentA, 'write_project_file', {
		relative_path: 'shared.txt',
		content: 'from A\n',
	});
	const seenByB = await callWith(agentB, 'read_project_file', { relative_path: 'shared.txt' });
	assert.equal(seenByB.content_hash, first.content_hash);

	await callWith(agentA, 'write_project_file', { relative_path: 'shared.txt', content: 'from A again\n' });
	const bWrite = await callWith(agentB, 'write_project_file', {
		relative_path: 'shared.txt',
		content: 'from B\n',
		expected_content_hash: seenByB.content_hash,
	});
	assert.equal(bWrite.success, false);
	assert.equal(bWrite.code, 'STALE_FILE');
	assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'from A again\n');

	const refreshed = await callWith(agentB, 'read_project_file', { relative_path: 'shared.txt' });
	const retried = await callWith(agentB, 'write_project_file', {
		relative_path: 'shared.txt',
		content: 'from B\n',
		expected_content_hash: refreshed.content_hash,
	});
	assert.equal(retried.success, true);
	assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'from B\n');
});

test('26. writes keep a restorable recovery checkpoint', async () => {
	const root = makeWorkspace({ 'recover.txt': 'original\n' });
	const written = await call(root, 'write_project_file', { relative_path: 'recover.txt', content: 'changed\n' });
	const checkpoint = recovery.getCheckpoint(written.recoveryCheckpointId);
	assert.equal(checkpoint.tool_name, 'write_project_file');
	assert.ok(checkpoint.manifest.paths['recover.txt']);
	const restored = await recovery.restoreCheckpoint(written.recoveryCheckpointId, {
		force: true,
		preRestore: false,
	});
	assert.equal(restored.complete, true, JSON.stringify(restored));
	assert.equal(fs.readFileSync(path.join(root, 'recover.txt'), 'utf8'), 'original\n');
});

test('27. Git and non-Git workspaces get the same contract', async () => {
	const gitRoot = makeWorkspace({ 'tracked.txt': 'tracked\n' });
	execFileSync('git', ['init', '-b', 'main'], { cwd: gitRoot, stdio: 'ignore' });
	const nonGitRoot = makeWorkspace({ 'plain.txt': 'plain\n' });
	for (const [root, file, content] of [
		[gitRoot, 'tracked.txt', 'tracked changed\n'],
		[nonGitRoot, 'plain.txt', 'plain changed\n'],
	]) {
		const written = await call(root, 'write_project_file', { relative_path: file, content });
		assert.equal(written.success, true);
		assert.equal(written.content_hash, wireHash(content));
		const read = await call(root, 'read_project_file', { relative_path: file });
		assert.equal(read.content, content);
		const unchanged = await call(root, 'read_project_file', {
			relative_path: file,
			if_content_hash: written.content_hash,
		});
		assert.equal(unchanged.not_modified, true);
	}
});

test('28. work-log digests describe conditional reads without leaking content', async () => {
	const root = makeWorkspace({ 'a.txt': 'secret-ish content\n' });
	const written = await call(root, 'write_project_file', { relative_path: 'a.txt', content: 'secret-ish content\n' });
	const conditional = await call(root, 'read_project_file', {
		relative_path: 'a.txt',
		if_content_hash: written.content_hash,
	});
	const digest = buildTurnDigest([{
		type: 'tool_call',
		id: 'call-1',
		toolName: 'read_project_file',
		status: 'complete',
		args: { relative_path: 'a.txt', if_content_hash: written.content_hash },
		result: conditional,
	}], { turnSeq: 1 });
	assert.match(digest.text, /verified a\.txt unchanged/);
	assert.doesNotMatch(digest.text, /secret-ish content/);
	assert.ok(digest.text.length <= 2000);
});

test('29-31. main and child dispatch plus bounded context remain compatible', async () => {
	const root = makeWorkspace({ 'child.txt': 'child content\n' });
	const written = await call(root, 'write_project_file', { relative_path: 'child.txt', content: 'child content\n' });
	assert.ok(CHILD_TOOL_NAMES.includes('read_project_file'));
	assert.ok(!CHILD_TOOL_NAMES.includes('write_project_file'));

	const childRead = await childCall(root, 'read_project_file', { relative_path: 'child.txt' });
	assert.equal(childRead.content, 'child content\n');
	assert.equal(childRead.content_hash, written.content_hash);
	const childConditional = await childCall(root, 'read_project_file', {
		relative_path: 'child.txt',
		if_content_hash: written.content_hash,
	});
	assert.equal(childConditional.not_modified, true);
	assert.equal(Object.hasOwn(childConditional, 'content'), false);

	const childWrite = await childCall(root, 'write_project_file', {
		relative_path: 'child.txt',
		content: 'not allowed',
	});
	assert.equal(childWrite.success, false);
	assert.equal(fs.readFileSync(path.join(root, 'child.txt'), 'utf8'), 'child content\n');
});

test('32. write responses can include a bounded changed-range summary without content', async () => {
	const root = makeWorkspace({ 'diff.txt': 'one\ntwo\nthree\n' });
	const replaced = await call(root, 'write_project_file', {
		relative_path: 'diff.txt',
		content: 'one\nTWO\nthree\nfour\n',
		include_diff: true,
	});
	assert.equal(replaced.success, true);
	assert.equal(replaced.diff.available, true);
	assert.equal(replaced.diff.changed, true);
	assert.equal(replaced.diff.created, false);
	assert.equal(replaced.diff.truncated, false);
	assert.equal(replaced.diff.lines_added, 3);
	assert.equal(replaced.diff.lines_removed, 2);
	assert.equal(Array.isArray(replaced.diff.ranges), true);
	assert.equal(Object.hasOwn(replaced.diff, 'oldLines'), false);
	assert.equal(Object.hasOwn(replaced.diff, 'newLines'), false);
	assert.doesNotMatch(JSON.stringify(replaced.diff), /TWO/);

	const created = await call(root, 'write_project_file', {
		relative_path: 'created-diff.txt',
		content: 'fresh\n',
		include_diff: true,
	});
	assert.equal(created.diff.created, true);
	assert.equal(created.diff.available, true);
	assert.ok(created.diff.lines_added >= 1);

	const noDiff = await call(root, 'write_project_file', {
		relative_path: 'no-diff.txt',
		content: 'default is off\n',
	});
	assert.equal(Object.hasOwn(noDiff, 'diff'), false);

	const manyBefore = Array.from({ length: 300 }, (_, index) => `before ${index}`).join('\n') + '\n';
	const manyAfter = Array.from({ length: 300 }, (_, index) => `after ${index}`).join('\n') + '\n';
	await call(root, 'write_project_file', { relative_path: 'many-lines.txt', content: manyBefore });
	const truncated = await call(root, 'write_project_file', {
		relative_path: 'many-lines.txt',
		content: manyAfter,
		include_diff: true,
	});
	assert.equal(truncated.diff.available, true);
	assert.equal(truncated.diff.truncated, true);
	assert.equal(truncated.diff.ranges.length, 1);
	assert.equal(Object.hasOwn(truncated.diff, 'oldLines'), false);
	assert.equal(Object.hasOwn(truncated.diff, 'newLines'), false);

	const large = await call(root, 'write_project_file', {
		relative_path: 'large-diff.txt',
		content: `${'x'.repeat(200001)}\n`,
		include_diff: true,
	});
	assert.equal(large.success, true);
	assert.equal(large.diff.available, false);
	assert.equal(large.diff.reason, 'file_too_large');
});

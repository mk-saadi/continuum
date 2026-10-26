'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-native-')), load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
  return load.call(this, name, ...args);
};
const db = require('../src/main/db'); db.initDatabase(directory);
const root = path.join(directory, 'project'); fs.mkdirSync(root);
const project = require('../src/main/projectManager').createProject({ name: 'R2', root_path: root });
require('../src/main/sessionManager').getOrCreateSession('r2', 'fixture', project.id);
const { executeAgentTool } = require('../src/main/tools/agentTools');
const run = (name, args, mode = 'workspace_write') => executeAgentTool({ name, arguments: args, sessionId: 'r2', permissionMode: mode });
const read = args => run('read_project_file', { relative_path: 'source.txt', ...args });
const write = text => fs.writeFileSync(path.join(root, 'source.txt'), text);
const hash = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const numbered = n => Array.from({ length: n }, (_, i) => `\tline ${i + 1} α😀\r\n`).join('');
test.after(() => { db.closeDatabase(); Module._load = load; fs.rmSync(directory, { recursive: true, force: true }); });

for (const count of [100, 1000, 10000]) test(`default and complete pagination of ${count} lines preserve every byte`, async () => {
  const text = numbered(count); write(text);
  let args = {}, content = '', expectedLine = 1, calls = 0;
  do {
    const page = await read(args); calls++;
    assert.equal(page.success, true, JSON.stringify(page));
    assert.equal(page.relative_path, 'source.txt'); assert.equal(page.total_lines, count);
    assert.equal(page.content_hash, hash(text)); assert.equal(page.start_line, expectedLine);
    assert.ok(page.content.length <= 20000); assert.ok(page.end_line - page.start_line < 200);
    assert.equal(page.content_truncated, false); // default page boundary is navigation, not a cap
    assert.equal(page.line_numbers[0], expectedLine);
    assert.equal(page.line_numbers.at(-1), page.end_line);
    content += page.content; expectedLine = page.end_line + 1;
    if (!page.has_more) { assert.equal(page.next_start_line, null); break; }
    assert.equal(page.next_start_line, expectedLine);
    args = { start_line: page.next_start_line, expected_content_hash: page.content_hash };
    assert.ok(calls <= Math.ceil(count / 200));
  } while (true);
  assert.equal(content, text); assert.equal(calls, Math.ceil(count / 200));
});

test('range cap differs from ordinary continuation and EOF clipping', async () => {
  write(numbered(1000));
  let page = await read({ start_line: 450, end_line: 520 });
  assert.equal(page.content, numbered(1000).split(/(?<=\n)/).slice(449, 520).join(''));
  assert.equal(page.content_truncated, false); assert.equal(page.next_start_line, 521);
  page = await read({ start_line: 1, end_line: 1000 });
  assert.equal(page.end_line, 400); assert.equal(page.content_truncated, true);
  page = await read({ start_line: 999, end_line: 1100 });
  assert.equal(page.end_line, 1000); assert.equal(page.content_truncated, false); assert.equal(page.has_more, false);
  write(('x'.repeat(9999) + '\n').repeat(5));
  page = await read({ start_line: 1, end_line: 5 });
  assert.equal(page.end_line, 2); assert.equal(page.content.length, 20000);
  assert.equal(page.content_truncated, true); assert.equal(page.next_start_line, 3);
});

test('long Unicode line windows progress without omissions, duplicates, or surrogate splits', async () => {
  const line = 'x'.repeat(65535) + '😀漢字\t'.repeat(17000) + '\r\n'; write(line + 'tail');
  const oversized = await read({ start_line: 1, end_line: 1 });
  assert.equal(oversized.code, 'LINE_TOO_LONG'); assert.equal(oversized.end_line, null);
  let offset = 0, content = '', calls = 0;
  do {
    const page = await read({ start_line: 1, end_line: 1, char_start: offset, expected_content_hash: oversized.content_hash });
    assert.equal(page.success, true, JSON.stringify(page));
    assert.equal(page.content_hash, hash(line + 'tail'));
    assert.ok(page.content.length <= 20000); assert.doesNotMatch(page.content, /\uFFFD/);
    assert.doesNotMatch(page.content, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    content += page.content; calls++;
    if (page.next_char_start === null) { assert.equal(page.next_start_line, 2); break; }
    assert.ok(page.next_char_start > offset); assert.equal(page.next_start_line, 1);
    offset = page.next_char_start; assert.ok(calls < 20);
  } while (true);
  assert.equal(content, line);
  assert.equal((await read({ start_line: 1, end_line: 2, char_start: 0 })).success, false);
});

test('empty, no final newline, unchanged and stale revisions', async () => {
  write(''); let page = await read({});
  assert.equal(page.content, ''); assert.equal(page.total_lines, 0); assert.equal(page.end_line, 0);
  assert.equal(page.has_more, false); assert.equal(page.content_truncated, false);
  write('  one\n\tlast😀'); page = await read({ start_line: 2, end_line: 2 });
  assert.equal(page.content, '\tlast😀'); assert.equal(page.total_lines, 2);
  assert.equal((await read({ if_content_hash: page.content_hash })).not_modified, true);
  write('changed'); const stale = await read({ start_line: 2, expected_content_hash: page.content_hash });
  assert.equal(stale.reason, 'FILE_REVISION_CHANGED'); assert.equal(stale.current_content_hash, hash('changed'));
  assert.equal(Object.hasOwn(stale, 'content'), false);
  assert.equal((await read({ expected_content_hash: 'invalid' })).success, false);
});

test('E2 failed edit -> diagnostic range -> exact narrow edit -> changed revision', async () => {
  write('function run() {\n  const value = 1;\n  return value;\n}\n');
  const failed = await run('str_replace_editor', { relative_path: 'source.txt', old_str: 'function run() {\n  const value = 99;', new_str: '  const value = 2;' });
  assert.equal(failed.success, false);
  const ranges = failed.nearby_source;
  assert.ok(ranges?.length, JSON.stringify(failed));
  const range = ranges[0]; const page = await read({ start_line: range.start_line, end_line: range.end_line });
  assert.equal(page.success, true); assert.match(page.content, /const value = 1;/);
  const fixed = await run('str_replace_editor', { relative_path: 'source.txt', old_str: '  const value = 1;', new_str: '  const value = 2;', expected_content_hash: page.content_hash });
  assert.equal(fixed.success, true, JSON.stringify(fixed));
  const refreshed = await read({ start_line: 2, end_line: 2 });
  assert.equal(refreshed.content, '  const value = 2;\n'); assert.notEqual(refreshed.content_hash, page.content_hash);
});

test('every continuation rechecks permission and binaries beyond the page still reject', async () => {
  write(numbered(1000)); const first = await read({});
  const denied = await executeAgentTool({ name: 'read_project_file', arguments: { relative_path: 'source.txt', start_line: first.next_start_line }, sessionId: 'missing-r2-session', permissionMode: 'workspace_write' });
  assert.equal(denied.success, false); assert.equal(Object.hasOwn(denied, 'content'), false);
  write(numbered(1000) + '\0'); assert.equal((await read({ start_line: 1, end_line: 1 })).success, false);
});

test('workspace boundary rejects traversal, outside absolute paths and symlink escape in every mode', async () => {
  const outside = path.join(directory, 'private.txt'); fs.writeFileSync(outside, 'private bytes');
  fs.symlinkSync(outside, path.join(root, 'escape.txt'));
  write('inside'); fs.symlinkSync(path.join(root, 'source.txt'), path.join(root, 'inside-link.txt'));
  for (const mode of ['read_only', 'workspace_write', 'full_access']) {
    for (const relative_path of ['../private.txt', outside, 'escape.txt']) {
      const page = await run('read_project_file', { relative_path, start_line: 1, end_line: 1 }, mode);
      assert.equal(page.success, false, JSON.stringify(page));
      assert.equal(Object.hasOwn(page, 'content'), false); assert.equal(Object.hasOwn(page, 'content_hash'), false);
      assert.doesNotMatch(JSON.stringify(page), /private bytes/);
    }
    assert.equal((await run('read_project_file', { relative_path: 'inside-link.txt' }, mode)).content, 'inside');
  }
});

test('authorization revoked during the scan returns no source or revision', async () => {
  write(numbered(1000)); let checks = 0;
  const page = await executeAgentTool({ name: 'read_project_file', arguments: { relative_path: 'source.txt' }, sessionId: 'r2', permissionMode: 'workspace_write',
    validateToolAuthorization() { if (++checks >= 3) throw new Error('fixture authorization revoked'); } });
  assert.equal(page.success, false, JSON.stringify(page)); assert.ok(checks >= 3);
  assert.equal(Object.hasOwn(page, 'content'), false); assert.equal(Object.hasOwn(page, 'content_hash'), false);
});

test('multi-megabyte input stays bounded and page metadata survives JSON persistence and context projection', async () => {
  write('x'.repeat(3 * 1024 * 1024) + '\n\ttail😀');
  const page = await read({ start_line: 2, end_line: 2 });
  assert.equal(page.content, '\ttail😀'); assert.equal(page.size_bytes, 3 * 1024 * 1024 + Buffer.byteLength('\n\ttail😀'));
  assert.equal(page.total_lines, 2); assert.ok(JSON.stringify(page).length < 1000);
  const raw = JSON.stringify(page), restored = JSON.parse(raw);
  assert.deepEqual(restored, page);
  const { trimToolResult } = require('../src/main/subagents/contextRecovery');
  assert.equal(trimToolResult(raw), raw);
  write(numbered(1000)); const large = JSON.stringify(await read({ start_line: 1, end_line: 400 }));
  const projected = JSON.parse(trimToolResult(large, { maxCharacters: 1200 }));
  assert.equal(projected.content_hash, JSON.parse(large).content_hash);
  assert.equal(projected.next_start_line, 401); assert.equal(projected.context_trimmed, true);
  assert.ok(JSON.stringify(projected).length <= large.length);
});

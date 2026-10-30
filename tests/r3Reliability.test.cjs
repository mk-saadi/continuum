'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const rpc = require('vscode-jsonrpc/node');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-reliability-'));
const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, ipcMain: { handle() {}, removeHandler() {} } };
  return originalLoad.call(this, name, ...args);
};
const database = require('../src/main/db'); database.initDatabase(directory);
const sessions = require('../src/main/sessionManager');
const project = require('../src/main/projectManager').createProject({ name: 'R3 disposable', root_path: workspace });
for (const id of ['r3', 'foreign']) sessions.getOrCreateSession(id, 'mock', project.id);
const { executeAgentTool, agentTools } = require('../src/main/tools/agentTools');
const permissions = require('../src/main/toolPermissions');
const contexts = require('../src/main/lspExecutionContext');
const uploads = require('../src/main/fileUploads');
const reader = require('../src/main/attachmentReader');
const call = (args, extra = {}) => executeAgentTool({ name: 'read_project_file', arguments: args, sessionId: 'r3', permissionMode: 'workspace_write', ...extra });
const hash = `sha256:${'a1'.repeat(32)}`;
const secret = 'sk-abcdefghijklmnopqrstuvwx1234567890';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function attach(name, bytes, sessionId = 'r3') {
  const source = path.join(directory, name); fs.writeFileSync(source, bytes);
  const files = await uploads.processUploads([source]);
  sessions.saveMessage(sessionId, 'user', 'Inspect attachment', files);
  const row = database.db.prepare(`SELECT a.* FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE m.session_id = ? ORDER BY a.id DESC LIMIT 1`).get(sessionId);
  return { row, ref: reader.reference(row), files };
}
test.after(() => { database.closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); });

test('trusted native structured hash survives; nested, untrusted, malformed hashes and credentials remain redacted', async () => {
  const { formatToolResult } = await import('../src/lib/toolResultFormatter.mjs');
  const raw = { success: true, content_hash: hash, content: JSON.stringify({ content_hash: hash, api_key: secret }), nested: { content_hash: hash }, api_key: secret };
  const result = JSON.parse(formatToolResult(raw, 'read_project_file', { nativeTool: 'read_project_file' }).content);
  assert.equal(result.content_hash, hash);
  assert.ok(!result.content.includes(hash)); assert.ok(!result.content.includes(secret));
  assert.ok(!JSON.stringify(result.nested).includes(hash)); assert.equal(result.api_key, '[redacted]');
  for (const options of [{}, { nativeTool: 'web_search' }]) assert.ok(!formatToolResult(raw, 'read_project_file', options).content.includes(hash));
  assert.ok(!formatToolResult({ nativeTool: 'read_project_file', content_hash: hash }, 'read_project_file').content.includes(hash));
  assert.ok(!formatToolResult({ content_hash: secret }, 'read_project_file', { nativeTool: 'read_project_file' }).content.includes(secret));
  assert.ok(!formatToolResult({ content: JSON.stringify({ content_hash: hash }) }, 'read_project_file', { nativeTool: 'read_project_file' }).content.includes(hash));
});

test('ordinary, conditional, revision-constrained, conflicting, invalid and stale reads recover without weakening writes', async () => {
  fs.writeFileSync(path.join(workspace, 'revision.txt'), 'first\nsecond\n');
  const a = await call({ relative_path: 'revision.txt' });
  const b = await call({ relative_path: 'revision.txt' });
  assert.equal(a.success, true); assert.equal(a.content_hash, b.content_hash);
  assert.equal((await call({ relative_path: 'revision.txt', expected_content_hash: a.content_hash })).content, a.content);
  assert.equal((await call({ relative_path: 'revision.txt', if_content_hash: a.content_hash })).not_modified, true);
  assert.equal((await call({ relative_path: 'revision.txt', if_content_hash: a.content_hash, expected_content_hash: a.content_hash })).code, 'INVALID_CONTENT_HASH_MODE');
  assert.equal((await call({ relative_path: 'revision.txt', expected_content_hash: 'sha256:[redacted token]' })).code, 'INVALID_CONTENT_HASH');
  assert.equal((await call({ relative_path: 'revision.txt', expected_content_hash: hash })).code, 'STALE_FILE');
  assert.equal((await call({ relative_path: 'revision.txt' })).success, true);
  const rejected = await executeAgentTool({ name: 'write_project_file', sessionId: 'r3', permissionMode: 'workspace_write', arguments: { relative_path: 'revision.txt', content: 'unsafe', expected_content_hash: hash } });
  assert.equal(rejected.success, false); assert.equal(fs.readFileSync(path.join(workspace, 'revision.txt'), 'utf8'), a.content);
  assert.equal((await call({ relative_path: 'missing.txt' })).code, 'FILE_NOT_FOUND');
  assert.equal((await call({ relative_path: '../escape.txt' })).code, 'UNAUTHORIZED_PATH');
});

test('parent model-visible messages and provider conversion preserve real hashes byte-for-byte for the next operation', async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const requests = []; let currentHash;
  const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const reply = calls => Response.json({ choices: [{ message: { content: calls ? '' : 'Finished [TASK COMPLETE]', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] });
  await runMemoryChat({ baseUrl: 'http://mock.invalid', modelId: 'mock', messages: [{ role: 'system', content: 'Use tools' }, { role: 'user', content: 'Inspect a revision' }],
    chatTools: agentTools.filter(t => ['read_project_file'].includes(t.function.name)), resolveTool: name => ({ serverName: 'native', toolName: name }),
    executeTool: async input => { const out = await call(JSON.parse(input.arguments)); if (out.success) currentHash = out.content_hash; return out; },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (requests.length === 1) return reply([tc('r3-read', 'read_project_file', { relative_path: 'revision.txt' })]);
      const visible = JSON.parse(body.messages.at(-1).content); assert.equal(visible.content_hash, currentHash);
      if (requests.length === 2) {
        const converted = require('../src/main/cloudProviders').anthropicPayload(body, 'mock');
        assert.ok(JSON.stringify(converted).includes(currentHash));
        return reply([tc('r3-check', 'read_project_file', { relative_path: 'revision.txt', expected_content_hash: visible.content_hash })]);
      }
      assert.equal(visible.success, true); return reply(null);
    },
  });
  assert.equal(requests.length, 3);
});

test('child native formatter preserves revision fields and still redacts file secrets', async () => {
  fs.writeFileSync(path.join(workspace, 'child.txt'), `api_key=${secret}`);
  const child = require('../src/main/subagents/agentLoop');
  const text = await child.executeChildTool({ name: 'read_project_file', rawArguments: JSON.stringify({ relative_path: 'child.txt' }), rootPath: workspace });
  const result = JSON.parse(text);
  assert.match(result.content_hash, /^sha256:[a-f0-9]{64}$/); assert.ok(!text.includes(secret));
});

test('large native file pages keep a trusted revision through the real output cap and wire sanitization', async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const { truncateToolOutput } = require('../src/main/engineManager');
  fs.writeFileSync(path.join(workspace, 'large-page.txt'), 'y'.repeat(20000));
  const raw = await call({ relative_path: 'large-page.txt' }); let turns = 0;
  assert.equal(raw.success, true);
  await runMemoryChat({ baseUrl: 'http://mock.invalid', modelId: 'mock', projectId: 'r3-disposable',
    messages: [{ role: 'system', content: 'Use tools' }, { role: 'user', content: 'Inspect a large file' }],
    chatTools: agentTools.filter(t => t.function.name === 'read_project_file'), guardToolContent: truncateToolOutput,
    resolveTool: name => ({ serverName: 'native', toolName: name }), executeTool: async () => raw,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (++turns === 1) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'r3-large', type: 'function', function: { name: 'read_project_file', arguments: '{"relative_path":"large-page.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      const text = body.messages.at(-1).content, page = JSON.parse(text);
      assert.equal(page.content_hash, raw.content_hash); assert.equal(page.context_excerpt, true); assert.equal(page.content_truncated, true);
      assert.match(page.source_evidence, /r3-large/); assert.ok(page.content.length < raw.content.length);
      assert.equal(truncateToolOutput(text), text);
      return Response.json({ choices: [{ message: { content: 'Complete [TASK COMPLETE]' }, finish_reason: 'stop' }] });
    },
  });
  assert.equal(turns, 2);
});

for (const mode of ['read_only', 'ask_approval', 'workspace_write', 'full_access']) test(`attachment image read in ${mode} requires no approval; mutation keeps its policy`, async () => {
  const fixture = await attach(`image-${mode}.png`, png);
  let approvals = 0;
  const decision = await permissions.guardTool({ name: 'read_project_file', args: { attachment_id: fixture.ref }, sessionId: 'r3', project, permissionMode: mode, requestApproval: async () => { approvals++; return false; } });
  assert.equal(approvals, 0); assert.equal(decision.mode, mode);
  const out = await call({ attachment_id: fixture.ref }, { permissionMode: mode });
  assert.equal(out.success, true); assert.equal(out.inspection, 'image');
  assert.equal(out.image.image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(fs.readFileSync(fixture.row.file_path), png);
  assert.equal(permissions.baseDecision({ capability: permissions.capabilityOf('write_project_file'), mode, hasWorkspace: true, native: true }).decision,
    mode === 'read_only' ? 'deny' : 'allow');
});

test('attachment reading also works in casual conversations without a workspace', async () => {
  sessions.getOrCreateSession('casual-r3', 'mock');
  const fixture = await attach('casual.txt', 'explicitly supplied', 'casual-r3');
  for (const mode of ['read_only', 'ask_approval', 'workspace_write', 'full_access']) {
    const out = await call({ attachment_id: fixture.ref }, { sessionId: 'casual-r3', permissionMode: mode });
    assert.equal(out.content, 'explicitly supplied');
  }
});

test('attachment references replace storage paths in prompt context and briefs; compact/full retain the existing reader', async () => {
  const fixture = await attach('visible.png', png);
  const message = database.db.prepare('SELECT * FROM messages WHERE id = ?').get(fixture.row.message_id);
  const visible = require('../src/main/promptBuilder').messageForModel({ ...message, attachments: fixture.files });
  const text = JSON.stringify(visible);
  assert.ok(text.includes(fixture.ref)); assert.ok(!text.includes(fixture.row.file_path));
  const briefs = require('../src/main/taskBriefs').buildTaskBriefSection('r3');
  assert.ok(briefs.content.includes(fixture.ref)); assert.ok(!briefs.content.includes(fixture.row.file_path));
  const notes = await attach('brief-notes.md', '# User-provided notes');
  const textBriefs = require('../src/main/taskBriefs').buildTaskBriefSection('r3');
  assert.ok(textBriefs.content.includes(notes.ref)); assert.ok(!textBriefs.content.includes(notes.row.file_path));
  const formatter = await import('../src/lib/toolResultFormatter.mjs');
  const out = formatter.formatToolResult(await call({ attachment_id: fixture.ref }), 'read_project_file', { nativeTool: 'read_project_file' });
  assert.equal(out.content.some(part => part.type === 'image_url'), true);
  const profile = require('../src/main/compactNativeTools');
  assert.ok(profile.DEFAULT_NAMES.includes('read_project_file'));
  const tools = require('../src/main/promptBuilder').getToolContext([], false, 'r3', 'read_only', null, { fullCatalog: true }).tools;
  assert.ok(tools.some(t => t.function.name === 'read_project_file' && t.function.parameters.properties.attachment_id));
});

test('foreign, detached, deleted, malformed and traversal references cannot access app storage', async () => {
  const fixture = await attach('private.txt', 'private content');
  assert.equal((await call({ attachment_id: fixture.ref }, { sessionId: 'foreign' })).code, 'ATTACHMENT_UNAVAILABLE');
  for (const bad of ['../private.txt', fixture.row.file_path, fixture.ref + '/../../directories.json'])
    assert.equal((await call({ attachment_id: bad })).code, 'ATTACHMENT_INVALID_REFERENCE');
  assert.equal((await call({ relative_path: fixture.row.file_path })).success, false);
  const rejected = await executeAgentTool({ name: 'write_project_file', sessionId: 'r3', permissionMode: 'full_access', arguments: { attachment_id: fixture.ref, content: 'changed' } });
  assert.equal(rejected.success, false); assert.equal(fs.readFileSync(fixture.row.file_path, 'utf8'), 'private content');
  database.db.prepare('DELETE FROM message_attachments WHERE id = ?').run(fixture.row.id);
  assert.equal((await call({ attachment_id: fixture.ref })).code, 'ATTACHMENT_UNAVAILABLE');
  const deleted = await attach('deleted.txt', 'content', 'foreign');
  sessions.deleteSession('foreign');
  assert.equal((await call({ attachment_id: deleted.ref }, { sessionId: 'foreign' })).success, false);
});

test('delegated children may read parent attachments only while the trusted delegation exists', async () => {
  const fixture = await attach('delegated.txt', 'delegated evidence');
  const parent = contexts.createContext('r3', 'workspace_write');
  const childSessions = require('../src/main/subagents/sessionManager');
  const child = childSessions.createSession({ parentSessionId: 'r3' });
  const delegated = contexts.authorizeChild(child, parent, 'read_only');
  const options = { sessionId: null, permissionMode: 'read_only', executionContext: delegated, rootPath: workspace };
  assert.equal((await call({ attachment_id: fixture.ref }, options)).content, 'delegated evidence');
  assert.equal((await call({ attachment_id: fixture.ref }, { ...options, executionContext: { ...delegated } })).code, 'ATTACHMENT_UNAUTHORIZED');
  childSessions.deleteSession(child.id);
  assert.equal((await call({ attachment_id: fixture.ref }, options)).code, 'ATTACHMENT_UNAUTHORIZED');
});

test('video/audio metadata, supported documents, binary diagnostics and resource bounds remain accurate', async () => {
  for (const name of ['video.mp4', 'audio.wav']) {
    const fixture = await attach(name, Buffer.from([1, 2, 3]));
    const out = await call({ attachment_id: fixture.ref });
    assert.equal(out.inspection, 'metadata'); assert.equal(out.capability_code, 'ATTACHMENT_CONTENT_CAPABILITY_UNAVAILABLE');
    assert.match(out.note, /compatible model/); assert.equal(out.size_bytes, 3);
  }
  const Excel = require('exceljs'); const workbook = new Excel.Workbook(); workbook.addWorksheet('data').addRow(['evidence', 42]);
  const xlsx = await attach('data.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  const doc = await call({ attachment_id: xlsx.ref });
  assert.equal(doc.inspection, 'extracted-document-text'); assert.match(doc.content, /evidence\t42/);
  const binary = await attach('binary.txt', Buffer.from([0, 1, 2]));
  assert.equal((await call({ attachment_id: binary.ref })).code, 'ATTACHMENT_UNSUPPORTED_CONTENT');
  const large = await attach('bounded.txt', 'x'.repeat(22000));
  const out = await call({ attachment_id: large.ref }); assert.equal(out.content.length, 20000); assert.equal(out.content_truncated, true);
  fs.truncateSync(large.row.file_path, uploads.MAX_FILE_BYTES + 1);
  assert.equal((await call({ attachment_id: large.ref })).success, false);
});

function fakeServer() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const server = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdin), new rpc.StreamMessageWriter(child.stdout)); server.listen();
  server.onRequest('shutdown', () => null); server.onNotification('exit', () => child.kill());
  return { child, server };
}
test('LSP waits for shared initialization, detects crashes and bounds recovery', async () => {
  const { LspManager } = require('../src/main/lspManager'); let starts = 0; const fixtures = [];
  const manager = new LspManager({ authorize: () => workspace, maxRestarts: 1, shutdownTimeout: 10, spawnServer: () => {
    starts++; const f = fakeServer(); fixtures.push(f);
    f.server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 1, workspaceSymbolProvider: true } }));
    f.server.onRequest('workspace/symbol', () => []); return f.child;
  } });
  try {
    const results = await Promise.all([manager.request({}, 'workspace/symbol', { query: 'a' }), manager.request({}, 'workspace/symbol', { query: 'b' })]);
    assert.deepEqual(results, [[], []]); assert.equal(starts, 1);
    fixtures[0].child.kill(); assert.equal(manager.stats().instances[0].failure.reason, 'SERVER_EXITED');
    assert.deepEqual(await manager.request({}, 'workspace/symbol', { query: 'a' }), []); assert.equal(starts, 2);
    fixtures[1].child.kill(); await assert.rejects(manager.acquire({})); assert.equal(starts, 2);
  } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); }
});

test('LSP missing executable and initialization timeout expose precise safe diagnostics without retry loops', async () => {
  const { LspManager } = require('../src/main/lspManager'); const { LspCodeIntelligence } = require('../src/main/lspCodeIntelligence');
  for (const reason of ['EXECUTABLE_NOT_FOUND', 'INITIALIZATION_TIMEOUT']) {
    let starts = 0; const fixtures = [];
    const manager = new LspManager({ authorize: () => workspace, initializationTimeout: 20, shutdownTimeout: 5, spawnServer: () => {
      starts++;
      if (reason === 'EXECUTABLE_NOT_FOUND') throw Object.assign(new Error('/private/server/path'), { code: 'ENOENT' });
      const f = fakeServer(); fixtures.push(f); f.server.onRequest('initialize', () => new Promise(() => {})); return f.child;
    } });
    try {
      const adapter = new LspCodeIntelligence(manager);
      for (let n = 0; n < 2; n++) {
        const out = await adapter.workspaceSymbols({ query: 'anything', executionContext: {} });
        assert.equal(out.success, false); assert.equal(out.reason, reason); assert.equal(out.operation_executed, false);
        assert.ok(!JSON.stringify(out).includes('/private/server/path')); assert.match(out.recovery, /file reads/);
      }
      assert.equal(starts, 1);
    } finally { await manager.close(); fixtures.forEach(f => f.server.dispose()); }
  }
});

test('LSP authorization errors are classified before dispatch without granting execution', async () => {
  const original = permissions.guardTool; const ctx = contexts.createContext('r3', 'workspace_write');
  try {
    permissions.guardTool = async () => { throw Object.assign(new Error('/private/diagnostic'), { code: 'PERMISSION_REVOKED' }); };
    const out = await require('../src/main/tools/lspTools').executeLspTool('lsp_workspace_symbols', { query: 'x' }, ctx);
    assert.equal(out.phase, 'authorization'); assert.equal(out.reason, 'PERMISSION_REVOKED'); assert.equal(out.error.code, 'LSP_PERMISSION_DENIED');
    assert.equal(out.operation_executed, false); assert.ok(!JSON.stringify(out).includes('/private/diagnostic'));
  } finally { permissions.guardTool = original; }
  assert.equal((await call({ relative_path: 'revision.txt' })).success, true);
});

test('one persisted attachment stays readable across mode transitions, then ownership changes revoke its old grant', async () => {
  const fixture = await attach('same-reference.txt', 'unchanged attachment');
  for (const mode of ['read_only', 'ask_approval', 'workspace_write', 'full_access', 'read_only']) {
    await contexts.setMode('r3', mode);
    const out = await call({ attachment_id: fixture.ref }, { permissionMode: mode });
    assert.equal(out.content, 'unchanged attachment');
  }
  sessions.getOrCreateSession('new-owner', 'mock', project.id);
  database.db.prepare('UPDATE messages SET session_id = ? WHERE id = ?').run('new-owner', fixture.row.message_id);
  assert.equal((await call({ attachment_id: fixture.ref })).code, 'ATTACHMENT_UNAVAILABLE');
  assert.equal((await call({ attachment_id: fixture.ref }, { sessionId: 'new-owner' })).content, 'unchanged attachment');
  await contexts.setMode('r3', 'workspace_write');
});

test('attachment symlink replacement, unavailable parser and text-only child image inspection fail safely', async () => {
  const fixture = await attach('replace.txt', 'authorized'); const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'not attached');
  fs.unlinkSync(fixture.row.file_path); fs.symlinkSync(outside, fixture.row.file_path);
  assert.equal((await call({ attachment_id: fixture.ref })).code, 'ATTACHMENT_UNAVAILABLE');
  const image = await attach('child-image.png', png);
  const children = require('../src/main/subagents/sessionManager'); const child = children.createSession({ parentSessionId: 'r3' });
  const delegated = contexts.authorizeChild(child, contexts.createContext('r3', 'read_only'), 'read_only');
  const out = await call({ attachment_id: image.ref }, { sessionId: null, executionContext: delegated, permissionMode: 'read_only' });
  assert.equal(out.inspection, 'metadata'); assert.equal(out.capability_code, 'ATTACHMENT_CONTENT_CAPABILITY_UNAVAILABLE');
  assert.ok(!JSON.stringify(out).includes('base64')); children.deleteSession(child.id);
});

test('PDF attachment ingestion, persisted ownership and the existing text parser work end-to-end', async () => {
  const stream = 'BT /F1 12 Tf 72 720 Td (R3 PDF evidence) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const fixture = await attach('evidence.pdf', pdf);
  const out = await call({ attachment_id: fixture.ref }, { permissionMode: 'read_only' });
  assert.equal(out.inspection, 'extracted-document-text'); assert.match(out.content, /R3 PDF evidence/);
  fs.unlinkSync(fixture.row.file_path + '.extracted.txt');
  const unavailable = await call({ attachment_id: fixture.ref });
  assert.equal(unavailable.inspection, 'metadata'); assert.equal(unavailable.capability_code, 'ATTACHMENT_CONTENT_CAPABILITY_UNAVAILABLE');
});

test('selected-model media policy reports text-only limitations and rechecks revocation after capability lookup', async () => {
  const fixture = await attach('model-policy.png', png);
  const access = require('../src/main/attachmentAccess'); const original = access.getAttachmentPolicy;
  const engine = { provider: 'local', modelId: 'mock-text-only', port: 9 };
  try {
    access.getAttachmentPolicy = async () => ({ enabled: { image: false } });
    const denied = await call({ attachment_id: fixture.ref }, { engine });
    assert.equal(denied.inspection, 'metadata'); assert.match(denied.note, /unsupported or unverified/);
    assert.equal(denied.image, undefined); assert.deepEqual(fs.readFileSync(fixture.row.file_path), png);
    access.getAttachmentPolicy = async () => ({ enabled: { image: true } });
    assert.equal((await call({ attachment_id: fixture.ref }, { engine })).inspection, 'image');
    access.getAttachmentPolicy = async () => { database.db.prepare('DELETE FROM message_attachments WHERE id = ?').run(fixture.row.id); return { enabled: { image: true } }; };
    assert.equal((await call({ attachment_id: fixture.ref }, { engine })).code, 'ATTACHMENT_UNAVAILABLE');
  } finally { access.getAttachmentPolicy = original; }
  const gif = await attach('legacy.gif', Buffer.from('GIF89a'));
  const limited = await call({ attachment_id: gif.ref });
  assert.equal(limited.inspection, 'metadata'); assert.match(limited.note, /existing tool-image validator/);
});

test('exact GLM hash misuse classes remain deterministic, and a fresh ordinary read escapes the retry loop', async () => {
  const source = { relative_path: 'revision.txt' };
  const errors = [];
  for (let n = 0; n < 5; n++) errors.push((await call({ ...source, if_content_hash: hash, expected_content_hash: hash })).code);
  for (let n = 0; n < 3; n++) errors.push((await call({ ...source, expected_content_hash: hash })).code);
  assert.equal(errors.filter(code => code === 'INVALID_CONTENT_HASH_MODE').length, 5);
  assert.equal(errors.filter(code => code === 'STALE_FILE').length, 3);
  const fresh = await call(source); assert.equal(fresh.success, true);
  assert.equal((await call({ ...source, expected_content_hash: fresh.content_hash })).success, true);
});

test('detached references never resurrect after row-ID reuse, and persisted references survive restart', async () => {
  const fixture = await attach('lifetime.txt', 'lifetime evidence');
  database.closeDatabase(); database.initDatabase(directory);
  assert.equal((await call({ attachment_id: fixture.ref })).content, 'lifetime evidence');
  database.db.prepare('DELETE FROM message_attachments WHERE id = ?').run(fixture.row.id);
  assert.equal(database.db.prepare('SELECT 1 FROM attachment_read_refs WHERE reference = ?').get(fixture.ref), undefined);
  database.db.prepare('INSERT INTO message_attachments(id, message_id, file_path, mime_type) VALUES (?, ?, ?, ?)')
    .run(fixture.row.id, fixture.row.message_id, fixture.row.file_path, fixture.row.mime_type);
  const renewed = reader.reference(fixture.row);
  assert.notEqual(renewed, fixture.ref);
  assert.equal((await call({ attachment_id: fixture.ref })).code, 'ATTACHMENT_UNAVAILABLE');
  assert.equal((await call({ attachment_id: renewed })).content, 'lifetime evidence');
});

test('recoverable crashed LSP remains advertised only within the existing restart budget', () => {
  const { manager } = require('../src/main/lspManager'); const { available } = require('../src/main/tools/lspTools');
  const key = '/r3-disposable-status';
  try {
    manager.instances.set(key, { state: 'failed', crashed: true });
    assert.equal(available({ root_path: key }), true);
    manager.restarts.set(key, manager.maxRestarts); assert.equal(available({ root_path: key }), false);
    manager.restarts.delete(key); manager.instances.set(key, { state: 'failed', crashed: false });
    assert.equal(available({ root_path: key }), false);
  } finally { manager.instances.delete(key); manager.restarts.delete(key); }
});

test('one optional LSP failure leaves the agent free to read files and complete with paired calls', async () => {
  const { runMemoryChat } = await import('../src/lib/memoryChat.mjs');
  const { createToolFailureCircuitBreaker } = require('../src/main/engineManager'); const requests = [];
  const names = ['lsp_workspace_symbols', 'read_project_file'];
  await runMemoryChat({ baseUrl: 'http://mock.invalid', modelId: 'mock', messages: [{ role: 'system', content: 'Use tools' }, { role: 'user', content: 'Inspect source' }],
    chatTools: agentTools.filter(t => names.includes(t.function.name)), resolveTool: name => ({ serverName: 'native', toolName: name }),
    toolFailureCircuitBreaker: createToolFailureCircuitBreaker(),
    executeTool: async input => input.name.startsWith('lsp') ? { success: false, error: { code: 'LSP_SERVER_UNAVAILABLE' } } : call({ relative_path: 'revision.txt' }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body); const index = requests.length - 1;
      return Response.json({ choices: [{ message: index < 2 ? { tool_calls: [{ id: `r3-optional-${index}`, type: 'function', function: { name: names[index], arguments: JSON.stringify(index ? { relative_path: 'revision.txt' } : { query: 'x' }) } }] } : { content: 'Completed [TASK COMPLETE]' }, finish_reason: index < 2 ? 'tool_calls' : 'stop' }] });
    },
  });
  assert.equal(requests.length, 3); assert.equal(requests[2].messages.filter(m => m.role === 'tool').length, 2);
});

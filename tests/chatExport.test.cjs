// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/chatExport.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = syncFs.mkdtempSync(path.join(os.tmpdir(), 'chat-export-'));
const handlers = new Map();
let dialogResult, lastOptions;
const dialog = { showSaveDialog: async options => { lastOptions = options; return dialogResult; } };
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory }, dialog,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) } };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase, db } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { getFullChatHistory, formatChatExport, exportChat } = require('../src/main/exportService');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');

(async () => {
  let dispose;
  try {
    initDatabase();
    sessions.getOrCreateSession('chat', 'model');
    sessions.updateSession('chat', 'title', '日本 / Project');
    const user = sessions.saveMessage('chat', 'user', '## Question\n**Hello** [site](https://example.com)');
    const reply = sessions.saveMessage('chat', 'assistant', 'First reply', [], { totalTokens: 24 }, [], { text: 'Reasoning', duration: 1 }, null, { modelName: 'Model A' });
    sessions.appendReplyVariant('chat', sessions.getRegenerationTarget('chat'), {
      content: '# Second reply\n\n**Bold** and `x_y`.\n\n```js\nconst value = "**literal**";\n```',
      model_name: 'Model B', created_at: '2026-09-27T10:00:00Z', stats: { total_tokens: 42, customMetric: 99 },
      custom: { preserved: true }, executionSteps: [{ type: 'tool_call', toolName: 'list_directory', status: 'complete', args: { path: '/tmp' }, result: ['a', 'b'] }],
    });
    sessions.setActiveVariant('chat', reply.id, 0);
    db.prepare('UPDATE messages SET archived = 1 WHERE session_id = ?').run('chat');
    db.prepare('INSERT INTO message_attachments(message_id, file_path, mime_type, estimated_tokens) VALUES (?, ?, ?, ?)').run(user.id, '/tmp/photo.png', 'image/png', 10);
    sessions.getOrCreateSession('other', 'other-model');
    sessions.saveMessage('other', 'user', 'Do not export me');
    const snapshot = getFullChatHistory('chat');
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.messages[0].archived, 1);
    assert.equal(snapshot.messages[0].attachments[0].file_path, '/tmp/photo.png');
    assert.equal(snapshot.messages[1].variants.length, 2);
    assert.equal(snapshot.messages[1].variants[1].custom.preserved, true);
    assert.equal(snapshot.messages[1].variants[1].stats.customMetric, 99);
    assert.equal(snapshot.messages[1].active_variant_index, 0);
    assert.throws(() => getFullChatHistory('missing'), /not found/);
    assert.throws(() => getFullChatHistory(''), /sessionId/);
    assert.deepEqual(JSON.parse(await formatChatExport(snapshot, 'json')), snapshot.messages);
    const markdown = await formatChatExport(snapshot, 'markdown');
    for (const expected of ['### AI Response (Variant 1) [Model: Model A] [Active]', '### AI Response (Variant 2) [Model: Model B]', 'customMetric', 'photo.png', 'list_directory', '2026-09-27T10:00:00Z']) assert.ok(markdown.includes(expected), expected);
    const text = await formatChatExport(snapshot, 'text');
    assert.ok(text.includes('AI Response (Variant 2) [Model: Model B]'));
    assert.ok(text.includes('Hello site (https://example.com)'));
    assert.ok(text.includes('Bold and x_y.'));
    assert.ok(text.includes('const value = "**literal**";')); // Code text must not be damaged.
    assert.ok(!text.includes('### AI Response') && !text.includes('```') && !text.includes('**Bold**'));
    assert.ok(!text.includes('Do not export me'));

    dispose = registerIpcHandlers({ isTrustedSender: event => event.trusted === true });
    await assert.rejects(handlers.get('chat:export')({ trusted: false }, { chatId: 'chat', format: 'json' }), /Unauthorized/);
    for (const [format, extension] of [['json', 'json'], ['markdown', 'md'], ['text', 'txt']]) {
      const filePath = path.join(directory, `export.${extension}`);
      dialogResult = { canceled: false, filePath };
      const result = await handlers.get('chat:export')({ trusted: true }, { chatId: 'chat', format });
      assert.deepEqual(result, { success: true, filePath });
      assert.deepEqual(lastOptions.filters[0].extensions, [extension]);
      assert.ok(lastOptions.defaultPath.endsWith(`.${extension}`));
      assert.equal(path.basename(lastOptions.defaultPath), lastOptions.defaultPath);
      assert.equal(await fs.readFile(filePath, 'utf8'), await formatChatExport(snapshot, format));
    }
    dialogResult = { canceled: true };
    assert.deepEqual(await exportChat({ chatId: 'chat', format: 'json' }, { dialog, writeFile: () => { throw new Error('Must not write'); } }), { success: false, canceled: true });
    dialogResult = { canceled: false, filePath: path.join(directory, 'failure.json') };
    const failure = await exportChat({ chatId: 'chat', format: 'json' }, { dialog, writeFile: async () => { throw new Error('Disk full'); } });
    assert.deepEqual(failure, { success: false, error: 'Disk full' });
    assert.equal((await exportChat({ chatId: 'chat', format: 'pdf' }, { dialog })).success, false);
    assert.equal((await exportChat(null, { dialog })).success, false);
    assert.equal((await exportChat({ chatId: 'missing', format: 'json' }, { dialog })).success, false);
    sessions.getOrCreateSession('empty', 'model');
    assert.equal(await formatChatExport(getFullChatHistory('empty'), 'json'), '[]\n');
    assert.match(await formatChatExport(getFullChatHistory('empty'), 'markdown'), /no saved messages/);
    console.log('Complete export snapshot, archived turns, variants, metadata, formats, trusted IPC, save filters, cancellation, and write failures passed.');
  } finally {
    dispose?.(); closeDatabase(); Module._load = originalLoad;
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/attachments.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-'));
const userData = path.join(directory, 'profile');
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { isReady: () => true, getPath: () => userData },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
  };
  return originalLoad.call(this, name, ...args);
};
const { db, initDatabase, closeDatabase } = require('../src/main/db');
const sessions = require('../src/main/sessionManager');
const { processUploads } = require('../src/main/fileUploads');
const { prepareChatMessages } = require('../src/main/promptBuilder');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
(async () => {
 try {
  initDatabase();
  const image = path.join(directory, 'image.PNG');
  const text = path.join(directory, 'notes.txt');
  const markdown = path.join(directory, 'plan.md');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(image, bytes); fs.writeFileSync(text, 'Attachment text'); fs.writeFileSync(markdown, '# Project plan');
  const dispose = registerIpcHandlers({isTrustedSender: (event) => event.trusted === true});
  await assert.rejects(handlers.get('file:process-uploads')({trusted: false}, [image]), /Unauthorized/);
  const attachments = await handlers.get('file:process-uploads')({trusted: true}, [image, text, markdown, image]);
  assert.equal(attachments.length, 4);
  assert.equal(new Set(attachments.map(a => a.file_path)).size, 4);
  assert.equal(attachments[0].mime_type, 'image/png');
  for (const attachment of attachments) assert.equal(path.dirname(attachment.file_path), path.join(userData, 'attachments'));
  assert.deepEqual(fs.readFileSync(attachments[0].file_path), bytes);
  assert.deepEqual(fs.readFileSync(image), bytes);

  // The renderer sends compressed bytes rather than the original disk path.
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
  const dataUrl = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;
  const optimized = await handlers.get('file:process-uploads')({trusted: true}, [{name: 'optimized.jpg', dataUrl}, text]);
  assert.equal(optimized[0].mime_type, 'image/jpeg');
  assert.deepEqual(fs.readFileSync(optimized[0].file_path), jpegBytes);
  assert.equal(optimized[1].mime_type, 'text/plain');
  await assert.rejects(processUploads([{name: 'bad.jpg', dataUrl: 'data:image/jpeg;base64,aGVsbG8='}]), /Invalid optimized JPEG/);
  await assert.rejects(processUploads([{name: 'bad.png', dataUrl: 'data:image/png;base64,AAAA'}]), /Invalid optimized JPEG/);

  const prompt = prepareChatMessages({sessionId: 'vision', modelId: 'model', userText: '', attachments});
  const parts = prompt.at(-1).content;
  assert.equal(parts[0].type, 'text');
  assert.match(parts[0].text, /Attached document for retrieval: notes.txt/); assert.match(parts[0].text, /plan.md/);
  assert.doesNotMatch(parts[0].text, /Attachment text|# Project plan/);
  assert.equal(parts.filter(p => p.type === 'image_url').length, 2);
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`);
  const original = sessions.loadSession('vision').messages[0];
  assert.equal(original.attachments.length, 4);
  sessions.saveMessage('vision', 'assistant', 'A picture');
  const next = prepareChatMessages({sessionId: 'vision', modelId: 'model', userText: 'Follow up'});
  assert.deepEqual(next[1].content, parts);
  const edited = sessions.editMessage(original.id, 'Describe again');
  assert.equal(edited.length, 1); assert.equal(edited[0].attachments.length, 4);
  const regenerated = prepareChatMessages({sessionId: 'vision', modelId: 'model', userText: 'Describe again', regenerate: true});
  assert.equal(regenerated[1].content[1].image_url.url, parts[1].image_url.url);
  assert.equal(sessions.loadSession('vision').messages.length, 1);

  const plain = prepareChatMessages({sessionId: 'text', modelId: 'model', userText: 'Read this', attachments: [attachments[1]]});
  assert.equal(typeof plain.at(-1).content, 'string');
  assert.match(plain.at(-1).content, /Read this[\s\S]*Attached document for retrieval: notes.txt/);
  assert.throws(() => sessions.saveMessage('text', 'user', 'bad', [{file_path: text, mime_type: 'text/plain'}]), /Invalid managed/);
  assert.throws(() => sessions.saveMessage('text', 'user', 'bad', [{...attachments[0], mime_type: 'text/plain'}]), /Invalid managed/);
  assert.equal(sessions.loadSession('text').messages.length, 1);

  db.prepare("CREATE TRIGGER fail_attachment BEFORE INSERT ON message_attachments WHEN NEW.mime_type = 'text/plain' BEGIN SELECT RAISE(ABORT, 'test attachment failure'); END;").run();
  assert.throws(() => sessions.saveMessage('text', 'user', 'roll back', attachments), /test attachment failure/);
  assert.equal(sessions.loadSession('text').messages.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_attachments').get().n, 5);
  db.prepare('DROP TRIGGER fail_attachment').run();

  // A missing historical image rolls back the whole new turn, preserving the draft for retry.
  fs.unlinkSync(attachments[0].file_path);
  assert.throws(() => prepareChatMessages({sessionId: 'vision', modelId: 'model', userText: 'should roll back'}), /ENOENT/);
  assert.equal(sessions.loadSession('vision').messages.length, 1);
  await assert.rejects(processUploads([path.join(directory, 'no.exe')]), /Supported attachments/);
  await assert.rejects(processUploads(Array(11).fill(text)), /at most 10/);
  const before = fs.readdirSync(path.join(userData, 'attachments')).sort();
  const copy = fs.promises.copyFile;
  let copies = 0;
  try {
   fs.promises.copyFile = async (...args) => { if (++copies === 2) throw new Error('Copy failure'); return copy(...args); };
   await assert.rejects(processUploads([text, markdown]), /Copy failure/);
  } finally { fs.promises.copyFile = copy; }
  assert.deepEqual(fs.readdirSync(path.join(userData, 'attachments')).sort(), before);
  sessions.deleteSession('vision');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_attachments').get().n, 1);
  dispose();
  console.log('Attachment IPC, copying, rollback, persistence, multimodal prompts, loading, and regeneration checks passed.');
 } finally {
  closeDatabase(); Module._load = originalLoad; fs.rmSync(directory, {recursive: true, force: true});
 }
})().catch(error => { console.error(error); process.exitCode = 1; });

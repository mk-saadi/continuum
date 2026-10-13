const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-attachments-'));
const userData = path.join(root, 'Continuum');
const oldRoot = path.join(root, 'LLM Desktop Assistant');
const data = path.join(userData, 'App_Data');
const target = path.join(data, 'attachments');
fs.mkdirSync(target, { recursive: true });
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => userData } };
  return original.call(this, name, ...args);
};
const { repairLegacyAttachmentPaths } = require('../src/main/legacyDataMigration');
const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE message_attachments (id INTEGER PRIMARY KEY, file_path TEXT, mime_type TEXT)');
  const add = db.prepare('INSERT INTO message_attachments(file_path,mime_type) VALUES (?,?)');
  fs.writeFileSync(path.join(target, 'photo.jpg'), 'photo');
  fs.writeFileSync(path.join(target, 'notes.txt'), 'notes');
  const legacyPhoto = path.join(oldRoot, 'attachments', 'photo.jpg');
  const legacyNotes = path.join(oldRoot, 'App_Data', 'attachments', 'notes.txt');
  const missing = path.join(oldRoot, 'attachments', 'missing.txt');
  const outside = path.join(root, 'outside', 'notes.txt');
  for (const name of [legacyPhoto, legacyNotes, missing, outside, path.join(target, 'notes.txt')]) add.run(name, 'text/plain');
  // Symlinks escaping the managed store must not become authorized attachments.
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(target, 'linked.txt'));
  const linked = path.join(oldRoot, 'attachments', 'linked.txt');
  add.run(linked, 'text/plain');
  assert.equal(repairLegacyAttachmentPaths(db, data, userData), 2);
  const rows = db.prepare('SELECT file_path FROM message_attachments ORDER BY id').all().map(row => row.file_path);
  assert.deepEqual(rows, [path.join(target, 'photo.jpg'), path.join(target, 'notes.txt'), missing, outside, path.join(target, 'notes.txt'), linked]);
  assert.equal(repairLegacyAttachmentPaths(db, data, userData), 0, 'repair is idempotent');
  console.log('Legacy attachment references repaired; missing, external and escaping symlink paths remain rejected.');
} finally {
  db.close(); Module._load = original; fs.rmSync(root, { recursive: true, force: true });
}

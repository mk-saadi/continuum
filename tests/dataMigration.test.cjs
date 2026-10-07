// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/dataMigration.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'data-migration-'));
const profile = path.join(root, 'profile');
fs.mkdirSync(profile);
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => profile } };
  return load.call(this, name, ...args);
};
const { getConfig, setModelDirectory } = require('../src/main/configStore');
const database = require('../src/main/db');
const { migrateAppData } = require('../src/main/dataMigration');
const { withDataAccess, isMigrating } = require('../src/main/dataAccess');
const folder = name => { const result = path.join(root, name); fs.mkdirSync(result); return result; };
(async () => {
  try {
    assert.equal(getConfig().appDataDirectory, path.join(profile, 'App_Data'));
    const modelDirectory = folder('models');
    assert.equal(setModelDirectory(modelDirectory), modelDirectory);
    database.initDatabase();
    const oldPath = getConfig().appDataDirectory;
    fs.mkdirSync(path.join(oldPath, 'attachments'));
    fs.mkdirSync(path.join(oldPath, 'embedding-models'));
    fs.writeFileSync(path.join(oldPath, 'attachments', 'file.txt'), 'preserve attachment');
    fs.writeFileSync(path.join(oldPath, 'embedding-models', 'weights.bin'), Buffer.from([0, 1, 2, 255]));
    const file = path.join(oldPath, 'attachments', 'file.txt');
    database.db.prepare("INSERT INTO sessions(id) VALUES ('session')").run();
    database.db.prepare("INSERT INTO messages(id, session_id, role, content) VALUES (1, 'session', 'user', 'searchable')").run();
    database.db.prepare("INSERT INTO message_attachments(message_id, file_path, mime_type) VALUES (1, ?, 'text/plain')").run(file);
    database.db.prepare("INSERT INTO document_chunks(file_name, file_path, content_hash, embedding_model, chunk_index, chunk_text, embedding_json) VALUES ('file', ?, 'hash', 'model', 0, 'text', '[1,0]')").run(file);
    database.db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('avatar-settings', ?)").run(JSON.stringify({globalAvatarUrl:'data:image/png;base64,AAAA'}));
    const nested = path.join(oldPath, 'nested'); fs.mkdirSync(nested);
    await assert.rejects(migrateAppData(nested), /overlap/);
    fs.rmdirSync(nested);
    const occupied = folder('occupied'); fs.writeFileSync(path.join(occupied, 'unrelated'), 'keep');
    await assert.rejects(migrateAppData(occupied), /empty/);
    const destination = folder('destination');
    let release;
    const operation = withDataAccess(() => new Promise(resolve => { release = resolve; }));
    const migration = migrateAppData(destination);
    assert.equal(isMigrating(), true);
    await assert.rejects(withDataAccess(() => {}), /migrating/);
    await assert.rejects(migrateAppData(destination), /already/);
    assert.equal(fs.existsSync(file), true);
    release(); await operation;
    const result = await migration;
    assert.equal(result.success, true);
    assert.equal(getConfig().appDataDirectory, destination);
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.readFileSync(path.join(destination, 'attachments', 'file.txt'), 'utf8'), 'preserve attachment');
    assert.equal(database.searchChatHistory('searchable').length, 1);
    assert.equal(database.db.prepare('SELECT file_path FROM message_attachments').get().file_path, path.join(destination, 'attachments', 'file.txt'));
    assert.equal(database.db.prepare('SELECT file_path FROM document_chunks').get().file_path, path.join(destination, 'attachments', 'file.txt'));
    assert.ok(database.db.prepare("SELECT value_json FROM app_settings WHERE key = 'avatar-settings'").get().value_json.includes('data:image'));
    assert.equal((await migrateAppData(destination)).success, true);
    const failed = folder('failed-copy');
    const cp = fsp.cp;
    try {
      fsp.cp = async () => { throw new Error('Simulated disk full'); };
      await assert.rejects(migrateAppData(failed), /disk full/);
    } finally { fsp.cp = cp; }
    assert.equal(getConfig().appDataDirectory, destination);
    assert.equal(database.searchChatHistory('searchable').length, 1);
    const corrupt = folder('corrupt-copy');
    try {
      fsp.cp = async (...args) => {
        await cp(...args);
        await fsp.writeFile(path.join(corrupt, 'attachments', 'file.txt'), 'corrupted');
      };
      await assert.rejects(migrateAppData(corrupt), /verification failed/);
    } finally { fsp.cp = cp; }
    assert.equal(database.searchChatHistory('searchable').length, 1);
    assert.equal(getConfig().appDataDirectory, destination);
    const unopened = folder('failed-open');
    const initialize = database.initDatabase;
    try {
      database.initDatabase = directory => {
        if (directory === unopened) throw new Error('Simulated SQLite open failure');
        return initialize(directory);
      };
      await assert.rejects(migrateAppData(unopened), /SQLite open failure/);
    } finally { database.initDatabase = initialize; }
    assert.equal(getConfig().appDataDirectory, destination);
    assert.equal(database.searchChatHistory('searchable').length, 1);
    const uncommitted = folder('failed-config');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (source, target) => {
        if (target === path.join(profile, 'directories.json')) throw new Error('Simulated config write failure');
        return rename(source, target);
      };
      await assert.rejects(migrateAppData(uncommitted), /config write failure/);
    } finally { fs.renameSync = rename; }
    assert.equal(getConfig().appDataDirectory, destination);
    assert.equal(database.searchChatHistory('searchable').length, 1);
    const link = path.join(destination, 'link');
    fs.symlinkSync(modelDirectory, link);
    await assert.rejects(migrateAppData(folder('symlink-test')), /symbolic link/);
    fs.unlinkSync(link);
    // Legacy migration copies only app-owned entries, preserving Electron profile files.
    database.closeDatabase();
    fs.rmSync(path.join(profile, 'directories.json'));
    fs.copyFileSync(path.join(destination, 'memory_palace.db'), path.join(profile, 'memory_palace.db'));
    fs.writeFileSync(path.join(profile, 'Preferences'), 'electron profile');
    database.initDatabase();
    assert.equal(getConfig().appDataDirectory, profile);
    const legacyTarget = path.join(profile, 'App_Data');
    fs.mkdirSync(legacyTarget);
    assert.equal((await migrateAppData(legacyTarget)).success, true);
    assert.equal(fs.readFileSync(path.join(profile, 'Preferences'), 'utf8'), 'electron profile');
    assert.equal(fs.existsSync(path.join(profile, 'memory_palace.db')), false);
    assert.equal(database.searchChatHistory('searchable').length, 1);
    console.log('Migration, hashes, FTS, attachments, RAG, avatars, rollback, access lock, and legacy profile preservation passed.');
  } finally {
    database.closeDatabase();
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

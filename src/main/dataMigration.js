'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { app } = require('electron');
const { getConfig, saveConfig, validatePath } = require('./configStore');
const { exclusiveMigration } = require('./dataAccess');

// Never copy/remove Electron's entire profile when upgrading a legacy installation.
const LEGACY_ENTRIES = ['memory_palace.db', 'memory_palace.db-wal', 'memory_palace.db-shm', 'attachments', 'embedding-models', 'avatars'];
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function manifest(directory) {
  const files = {};
  async function visit(relative) {
    const full = path.join(directory, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error('App data contains a symbolic link. Move linked files into the data directory first.');
    if (stat.isDirectory()) {
      files[relative] = 'directory';
      for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) files[relative] = await digest(full);
    else throw new Error('App data contains an unsupported file type.');
  }
  await visit('');
  return files;
}
function relocateReferences(connection, oldPath, newPath, configuredPath = oldPath) {
  const relocate = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
    const root = [configuredPath, oldPath].find(directory => contains(directory, value));
    return root ? path.join(newPath, path.relative(root, value)) : value;
  };
  connection.transaction(() => {
    for (const table of ['message_attachments', 'document_chunks']) {
      const update = connection.prepare(`UPDATE ${table} SET file_path = ? WHERE id = ?`);
      for (const row of connection.prepare(`SELECT id, file_path FROM ${table}`).all())
        update.run(relocate(row.file_path), row.id);
    }
  })();
}

async function migrateAppData(directory) {
  validatePath(directory);
  return exclusiveMigration(async () => {
    const database = require('./db');
    const oldConfig = getConfig();
    await fs.mkdir(oldConfig.appDataDirectory, { recursive: true });
    const oldPath = await fs.realpath(oldConfig.appDataDirectory);
    // The picker supplies an existing directory; realpath also resolves ancestor symlinks.
    const newPath = await fs.realpath(directory);
    if (!(await fs.stat(newPath)).isDirectory()) throw new Error('Choose a directory.');
    if (oldPath === newPath) return { success: true, config: oldConfig };
    const profile = await fs.realpath(app.getPath('userData'));
    const legacy = oldPath === profile;
    if (contains(newPath, oldPath) || (!legacy && contains(oldPath, newPath)) ||
        contains(newPath, profile)) throw new Error('Source and destination directories must not overlap.');
    if ((await fs.readdir(newPath)).length) throw new Error('Choose an empty App Data directory.');
    let committed = false;
    let closed = false;
    try {
      closed = true;
      database.closeDatabase();
      const entries = legacy ? (await fs.readdir(oldPath)).filter(name => LEGACY_ENTRIES.includes(name)) : await fs.readdir(oldPath);
      // Hash all source bytes before copying. No writes can run while the gate is held.
      const expected = {};
      for (const name of entries) {
        const stat = await fs.lstat(path.join(oldPath, name));
        if (stat.isSymbolicLink()) throw new Error('App data contains a symbolic link.');
        if (!stat.isDirectory() && !stat.isFile()) throw new Error('App data contains an unsupported file type.');
        expected[name] = stat.isDirectory() ? await manifest(path.join(oldPath, name)) : await digest(path.join(oldPath, name));
      }
      // Copy entries rather than the directory itself. newPath always exists -- it came
      // from a folder picker, and the emptiness check above reads it -- so copying the
      // source directory onto it makes Node's cp raise ERR_FS_CP_EEXIST under
      // errorOnExist. That failed every non-legacy migration regardless of how empty
      // the destination was. Copying children sidesteps the collision entirely because
      // the guard above proves no child target exists yet.
      for (const name of entries) await fs.cp(path.join(oldPath, name), path.join(newPath, name), { recursive: true, force: false, errorOnExist: true });
      for (const name of entries) {
        const actual = typeof expected[name] === 'string' ? await digest(path.join(newPath, name)) : await manifest(path.join(newPath, name));
        if (JSON.stringify(actual) !== JSON.stringify(expected[name])) throw new Error('App data copy verification failed.');
      }
      // Prove the copied DB opens, passes integrity checks, and accepts relocated references
      // before committing configuration or deleting any source files.
      const connection = database.initDatabase(newPath);
      if (connection.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Copied SQLite database failed integrity verification.');
      relocateReferences(connection, oldPath, newPath, oldConfig.appDataDirectory);
      database.closeDatabase();
      const config = saveConfig({ appDataDirectory: newPath });
      committed = true;
      database.initDatabase();
      let warning;
      try {
        if (legacy) {
          for (const name of entries) await fs.rm(path.join(oldPath, name), { recursive: true, force: true });
        } else await fs.rm(oldPath, { recursive: true });
      } catch (error) {
        warning = `Migration succeeded, but the old copy could not be fully removed: ${error.message}`;
      }
      return { success: true, config, warning };
    } catch (error) {
      if (closed) {
        // closeDatabase closes the handle even when checkpointing reports an error.
        try { database.closeDatabase(); } catch { /* Reopen the intact source below. */ }
        if (committed) saveConfig(oldConfig);
        database.initDatabase(oldPath);
      }
      // Retain incomplete copies for recovery. Never remove a user-selected folder on failure.
      throw new Error(`Migration failed: ${error.message}. The original data was retained; choose an empty destination to retry.`, { cause: error });
    }
  });
}
module.exports = { migrateAppData, relocateReferences };

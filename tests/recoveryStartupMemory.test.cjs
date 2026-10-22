'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function heapCheck() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-startup-memory-'));
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'electron') return { app: { isReady: () => true, getPath: () => directory } };
    return load.call(this, name, ...args);
  };
  const database = require('../src/main/db');
  database.initDatabase(directory);
  try {
    const recovery = require('../src/main/recoveryStore');
    recovery.ensureRecoverySchema();
    const db = database.db;
    const root = fs.realpathSync(directory);
    const session = db.prepare('INSERT INTO recovery_sessions(project_root) VALUES (?)').run(root).lastInsertRowid;
    const padding = 'x'.repeat(256 * 1024);
    const manifest = JSON.stringify({ root, paths: {}, padding });
    const op = JSON.stringify({ postState: { padding }, postComplete: true,
      changed: [{ change: 'modified' }, { change: 'created' }] });
    const insert = db.prepare(`INSERT INTO recovery_checkpoints
      (session_id, chat_session_id, kind, op_json, manifest_json, coverage_json)
      VALUES (?, ?, 'op', ?, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i < 300; i++) insert.run(session, i % 2 ? 'mine' : 'other', op, manifest,
        JSON.stringify({ complete: true, skipped: [], excluded: [] }));
    })();
    // More than 150 MB of stored JSON under a 64 MB JS heap. The sidebar
    // must read counts/endpoints, and history must stream metadata rows.
    const view = await recovery.getWorkspaceRecoveryOverview(root, 'mine');
    assert.equal(view.state, 'protected');
    assert.equal(view.checkpointCount, 150);
    assert.equal(view.otherCheckpointCount, 150);
    assert.equal(view.runStart.id, 2);
    assert.equal(view.latest.id, 300);
    assert.equal(view.latest.changedTotal, 2);
    assert.equal(view.latest.changedKinds.modified, 1);
    const empty = await recovery.getWorkspaceRecoveryOverview(root, 'new-chat');
    assert.equal(empty.reason, 'no-chat-history');
    assert.equal(empty.otherCheckpointCount, 300);
    assert.equal(empty.otherChats, 2);
    const history = await recovery.getRecoveryHistory(root, 'mine', 200);
    assert.equal(history.mine.length, 100);
    assert.equal(history.other.length, 100);
    assert.equal(history.mine[0].id, 300);
    assert.ok(history.mine.every(row => row.changedKinds.created === 1));
    assert.ok(history.mine.every(row => !('manifest_json' in row) && !('op_json' in row)));
    console.log('Recovery overview and history fit in a 64 MB heap with 150 MB of saved checkpoint JSON.');
  } finally {
    database.closeDatabase();
    Module._load = load;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--heap-check')) {
  heapCheck().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  require('node:test')('restoring a large recovery history stays within a bounded heap', () => {
    const { execFileSync } = require('node:child_process');
    const output = execFileSync(process.execPath, ['--max-old-space-size=64', __filename, '--heap-check'], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.match(output, /fit in a 64 MB heap/);
  });
}

'use strict';
// Recovery blob reference index: the fix for the settings panel freezing the
// app. Storage stats used to parse every checkpoint manifest on the Electron
// main thread (O(all history) — hundreds of MB of JSON on a real install),
// which blocked the main process for seconds every time the storage panel
// opened. The reference index answers the same questions from a refcount.
//
// Run with: node --test tests/recoveryReferenceIndex.test.cjs
// Uses temp dirs under os.tmpdir() only; never touches /tmp/opencode.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recidx-db-'));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => dbDir } };
  return load.call(this, name, ...args);
};
require('../src/main/db').initDatabase(dbDir);
const recovery = require('../src/main/recoveryStore');
const index = require('../src/main/recoveryReferenceIndex');
const conn = () => require('../src/main/db').db;

const workspaces = [];
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recidx-ws-'));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const blobDir = () => path.join(require('../src/main/configStore').getConfig().appDataDirectory, 'recovery', 'blobs');
const blobFiles = () => {
  const dir = blobDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((shard) => {
    const shardDir = path.join(dir, shard);
    return fs.statSync(shardDir).isDirectory() ? fs.readdirSync(shardDir) : [];
  });
};
const refcountOf = (hash) => conn().prepare('SELECT refcount FROM recovery_blobs WHERE hash = ?').get(hash)?.refcount;
const hashesOf = (checkpointId) => Object.values(recovery.getCheckpoint(checkpointId).manifest.paths)
  .filter((rec) => rec.kind === 'file').map((rec) => rec.hash);

// Insert a checkpoint the way a previous version of the app would have: the
// blob rows exist and the manifest lists them, but there is no reference
// index marker, so the index has to be built for it.
function insertLegacyCheckpoint(root, files) {
  let sessionId = conn().prepare('SELECT id FROM recovery_sessions WHERE project_root = ?').get(root)?.id;
  if (sessionId === undefined) {
    sessionId = Number(conn().prepare('INSERT INTO recovery_sessions(project_root) VALUES (?)').run(root).lastInsertRowid);
  }
  const paths = {};
  const hashes = [];
  for (const [rel, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const shard = path.join(blobDir(), hash.slice(0, 2));
    fs.mkdirSync(shard, { recursive: true });
    fs.writeFileSync(path.join(shard, hash), bytes);
    conn().prepare('INSERT OR IGNORE INTO recovery_blobs(hash, size) VALUES (?, ?)').run(hash, bytes.length);
    paths[rel] = { kind: 'file', hash, size: bytes.length, mode: 420, mtimeMs: 1 };
    hashes.push(hash);
  }
  const id = Number(conn().prepare(
    `INSERT INTO recovery_checkpoints(session_id, chat_session_id, tool_name, kind, op_json, manifest_json, coverage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, null, 'legacy', 'op', null, JSON.stringify({ paths }), JSON.stringify({ complete: true })).lastInsertRowid);
  return { id, hashes };
}

test('1. storage stats never read the checkpoint manifests', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n' });
  // A capture with a large workspace: the manifest is the whole workspace
  // state, and reading it is exactly what used to freeze the app.
  const files = {};
  for (let i = 0; i < 400; i++) files[`f${i}.txt`] = `content ${i}\n`;
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: Object.keys(files) });
  const manifestSize = conn().prepare('SELECT LENGTH(manifest_json) n FROM recovery_checkpoints WHERE id = ?')
    .get(cap.checkpointId).n;
  assert.ok(manifestSize > 10000, `manifest is big enough to matter (${manifestSize} bytes)`);

  // Watch what the stats path parses.
  const realParse = JSON.parse;
  const parsed = [];
  JSON.parse = function (text, ...rest) {
    if (typeof text === 'string') parsed.push(text.length);
    return realParse(text, ...rest);
  };
  let stats;
  try {
    stats = await recovery.getRecoveryStats();
  } finally {
    JSON.parse = realParse;
  }
  const biggest = parsed.length ? Math.max(...parsed) : 0;
  assert.ok(biggest < 10000, `stats must not parse manifests (largest parse was ${biggest} bytes)`);
  assert.equal(stats.checkpointCount >= 1, true);
});

test('2. a blob shared by two checkpoints is counted once per checkpoint', async () => {
  const root = makeWorkspace({ 'shared.txt': 'same bytes\n', 'other.txt': 'different\n' });
  const first = await recovery.captureOperation({ root, toolName: 't', paths: ['shared.txt', 'other.txt'] });
  const second = await recovery.captureOperation({ root, toolName: 't', paths: ['shared.txt'] });
  const shared = hashesOf(first.checkpointId).find((hash) => hashesOf(second.checkpointId).includes(hash));
  const unique = hashesOf(first.checkpointId).find((hash) => !hashesOf(second.checkpointId).includes(hash));
  assert.ok(shared && unique, 'one blob is shared and one is not');

  assert.equal(refcountOf(shared), 2, 'the shared blob is referenced by both checkpoints');
  assert.equal(refcountOf(unique), 1, 'the other blob is referenced by one checkpoint');

  const stats = await recovery.getRecoveryStats();
  assert.ok(stats.referencedBlobs >= 2);
  assert.equal(stats.logicalBytes, stats.physicalBytes, 'both blobs are referenced, so both totals agree');
});

test('3. the index is authoritative from the first capture on a fresh store', () => {
  assert.equal(index.isReady(), true, 'a store that only saw the current code needs no build');
  assert.equal(index.pendingCount(), 0);
});

test('4. deleting a checkpoint releases its blobs and cleanup can collect them', async () => {
  const root = makeWorkspace({ 'gone.txt': 'temporary\n' });
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: ['gone.txt'] });
  const hash = hashesOf(cap.checkpointId)[0];
  assert.equal(refcountOf(hash), 1);

  await recovery.deleteCheckpoints([cap.checkpointId]);
  assert.equal(refcountOf(hash), 0);
  assert.ok(blobFiles().includes(hash), 'the blob file is still there before cleanup');

  const gc = await recovery.gcRecoveryBlobs();
  assert.equal(gc.deletedBlobs, 1);
  assert.equal(blobFiles().includes(hash), false, 'an unreferenced blob is collected');
});

test('5. cleanup never collects a blob a checkpoint still references', async () => {
  const root = makeWorkspace({ 'kept.txt': 'keep me\n' });
  const cap = await recovery.captureOperation({ root, toolName: 't', paths: ['kept.txt'] });
  const hash = hashesOf(cap.checkpointId)[0];
  const gc = await recovery.gcRecoveryBlobs();
  assert.equal(gc.deletedBlobs, 0);
  assert.ok(blobFiles().includes(hash), 'the referenced blob survives cleanup');
  assert.equal(await recovery.blobExists(hash), true);
});

test('6. a legacy checkpoint is indexed by the build, and its numbers then match a manifest scan', async () => {
  const root = makeWorkspace({});
  const legacy = insertLegacyCheckpoint(root, { 'legacy.txt': 'legacy bytes\n' });
  // A checkpoint written by an older version has no index marker.
  assert.equal(index.pendingCount() > 0, true, 'the legacy checkpoint is not indexed yet');
  assert.equal(index.isReady(), false, 'the index is not authoritative yet');

  // While the index is incomplete the stats fall back to a conservative
  // reading: every known blob counts as referenced, so nothing is understated.
  const before = await recovery.getRecoveryStats();
  assert.equal(before.referencedBlobs, before.blobFiles);
  assert.equal(before.logicalBytes, before.physicalBytes);

  await index.build();
  assert.equal(index.isReady(), true);
  assert.equal(index.pendingCount(), 0);
  assert.equal(refcountOf(legacy.hashes[0]), 1, 'the legacy checkpoint is counted once');

  const after = await recovery.getRecoveryStats();
  // The numbers agree with what a full manifest scan would have produced.
  const rows = conn().prepare('SELECT manifest_json FROM recovery_checkpoints').all();
  const seen = new Set();
  for (const row of rows) {
    for (const rec of Object.values(JSON.parse(row.manifest_json).paths ?? {})) {
      if (rec && rec.kind === 'file' && typeof rec.hash === 'string') seen.add(rec.hash);
    }
  }
  assert.equal(after.referencedBlobs, seen.size, 'referenced blob count matches a manifest scan');
});

test('7. an incomplete index collects nothing rather than risking referenced bytes', async () => {
  const root = makeWorkspace({});
  insertLegacyCheckpoint(root, { 'legacy2.txt': 'legacy bytes two\n' });
  assert.equal(index.isReady(), false);
  const before = blobFiles().length;
  const gc = await recovery.gcRecoveryBlobs();
  assert.equal(gc.deletedBlobs, 0, 'cleanup is conservative while the index is incomplete');
  assert.equal(blobFiles().length, before, 'no blob was removed');
  await index.build();
});

test('8. pruning keeps the index in step with the checkpoints it removed', async () => {
  const root = makeWorkspace({ 'p.txt': 'prune me\n' });
  const first = await recovery.captureOperation({ root, chatSessionId: 'chat-a', toolName: 't', paths: ['p.txt'] });
  await recovery.captureOperation({ root, chatSessionId: 'chat-b', toolName: 't', paths: ['p.txt'] });
  await recovery.captureOperation({ root, chatSessionId: 'chat-c', toolName: 't', paths: ['p.txt'] });
  const hash = hashesOf(first.checkpointId)[0];
  assert.equal(refcountOf(hash), 3, 'all three checkpoints reference the same blob');
  const old = new Date(Date.now() - 48 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  conn().prepare('UPDATE recovery_checkpoints SET created_at = ? WHERE id = ?').run(old, first.checkpointId);

  const report = await recovery.pruneRecovery({ retentionDays: 1, storageCapMB: 512, latestPerSession: 1 });
  assert.ok(report.pruned.includes(first.checkpointId), 'the old checkpoint is pruned');
  assert.equal(refcountOf(hash), 2, 'the pruned checkpoint released its reference');
  const gc = await recovery.gcRecoveryBlobs();
  assert.equal(gc.deletedBlobs, 0, 'the blob is still referenced by the surviving checkpoints');
  assert.ok(blobFiles().includes(hash));
});

test('9. a shared blob survives the checkpoint that referenced it alone', async () => {
  const root = makeWorkspace({ 'one.txt': 'one\n' });
  const first = await recovery.captureOperation({ root, toolName: 't', paths: ['one.txt'] });
  const hash = hashesOf(first.checkpointId)[0];
  // A second checkpoint that references the same blob, written by an older
  // version of the app and therefore not in the index yet.
  const legacy = insertLegacyCheckpoint(root, { 'copy.txt': 'one\n' });
  assert.ok(legacy.hashes.includes(hash), 'the legacy checkpoint references the same blob');
  await index.build();
  assert.equal(refcountOf(hash), 2, 'both checkpoints are counted');

  await recovery.deleteCheckpoints([first.checkpointId]);
  assert.equal(refcountOf(hash), 1, 'the blob is still referenced by the other checkpoint');
  const gc = await recovery.gcRecoveryBlobs();
  assert.ok(!blobFiles().includes(hash) === false, 'a still-referenced blob is not collected');
  assert.equal(await recovery.blobExists(hash), true);
});

test('10. the refcounts always match what the manifests say', async () => {
  const root = makeWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const first = await recovery.captureOperation({ root, chatSessionId: 'x', toolName: 't', paths: ['a.txt', 'b.txt'] });
  await recovery.captureOperation({ root, chatSessionId: 'y', toolName: 't', paths: ['b.txt', 'c.txt'] });
  // A boundary checkpoint rewrites its manifest; the referenced set must not
  // change when it does.
  const boundary = await recovery.createManualCheckpoint(root, { chatSessionId: 'z' });
  assert.ok(boundary.checkpointId > 0);
  await recovery.deleteCheckpoints([first.checkpointId]);

  // Recompute the counts the way the manifests say they should be.
  const expected = new Map();
  for (const row of conn().prepare('SELECT manifest_json FROM recovery_checkpoints').all()) {
    for (const rec of Object.values(JSON.parse(row.manifest_json).paths ?? {})) {
      if (rec && rec.kind === 'file' && typeof rec.hash === 'string') {
        expected.set(rec.hash, (expected.get(rec.hash) ?? 0) + 1);
      }
    }
  }
  const actual = new Map(conn().prepare('SELECT hash, refcount FROM recovery_blobs WHERE refcount > 0').all()
    .map((row) => [row.hash, row.refcount]));
  assert.equal(actual.size, expected.size, 'the same blobs are referenced');
  for (const [hash, count] of expected) {
    assert.equal(actual.get(hash), count, `refcount for ${hash.slice(0, 8)}`);
  }
});

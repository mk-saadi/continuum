'use strict';

// Blob reference index for the recovery store.
//
// `recovery_blobs.refcount` records how many checkpoints reference each blob.
// It answers "which blobs are still referenced?" in O(blobs) instead of
// parsing every checkpoint manifest. That distinction matters: a manifest
// holds the full workspace state of one capture, so a real install carries
// hundreds of megabytes of manifest JSON across millions of path records.
// Reading them all on the Electron main thread froze the whole app for
// seconds every time the storage panel asked for stats.
//
// What this index is trusted with, and what it is not:
//
//   * TRUSTED: the storage panel's numbers (referenced blobs and the bytes
//     they hold). Getting one of these slightly wrong is a display error.
//   * NOT TRUSTED: deciding which blob bytes to delete. Cleanup derives the
//     referenced set from the manifests themselves, so deleting bytes never
//     depends on this counter being right.
//
// The index is built once per install by walking the manifests. The build is
// resumable, runs in time-boxed batches that yield to the event loop, and
// never blocks the app.
//
// Correctness rules that make the build safe against a live store:
//
//   * A checkpoint's set of referenced blobs is fixed at creation.
//     `finalizeBoundaryCheckpoint` only appends `absent` records and
//     `recordOpPostState` only rewrites op_json, so neither can add or
//     remove a file record.
//   * `recovery_indexed_checkpoints` says whether a checkpoint's references
//     are already counted. It is the index's own state: the index is
//     authoritative exactly when no checkpoint is missing from it.
//     It is a side table rather than a column on `recovery_checkpoints`
//     because a checkpoint row carries the whole manifest — updating any
//     column of such a row makes SQLite rewrite all of it (measured: 4.7s
//     for one install's history, against 3ms for the side table).
//   * The forward path (capture) always counts what it writes and marks the
//     checkpoint as indexed, so a store that only ever saw the current code
//     needs no build at all.
//   * The build counts the checkpoints that are not indexed yet and marks
//     them in the same transaction, so an interrupted build resumes where it
//     stopped and never counts a checkpoint twice.
//   * Deleting a checkpoint only decrements the refcounts of checkpoints that
//     were actually counted. Anything else could under-count a blob that
//     another checkpoint still references.
//   * While any checkpoint is missing from the index the counts are not
//     authoritative: callers fall back to a conservative reading, so an
//     unfinished build never understates the amount of data at risk.

const connection = () => require('./db').db;

// Wall-clock budget for one build batch. This is the longest the build may
// hold the main thread before it yields to the event loop.
const BUILD_BATCH_MS = 20;

// Blobs per refcount statement. SQLite's default parameter limit is far
// above this, so the chunking is about statement size, not the limit.
const REFCOUNT_CHUNK = 500;

function ensureReferenceSchema() {
  const db = connection();
  db.prepare(`CREATE TABLE IF NOT EXISTS recovery_meta(
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS recovery_indexed_checkpoints(
    checkpoint_id INTEGER PRIMARY KEY
  )`).run();
  // An earlier attempt at this index used a per-(checkpoint, blob) reference
  // table. It was never populated and nothing reads it; the refcount replaces
  // it. It is empty by construction, so dropping it loses nothing.
  db.prepare('DROP TABLE IF EXISTS recovery_checkpoint_blobs').run();
  // The blob table belongs to the recovery schema, which is created by
  // recoveryStore. Until that exists there is nothing to add a column to.
  const blobTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_blobs'").get();
  if (!blobTable) return;
  const blobColumns = db.prepare('PRAGMA table_info(recovery_blobs)').all();
  if (!blobColumns.some((column) => column.name === 'refcount')) {
    db.prepare('ALTER TABLE recovery_blobs ADD COLUMN refcount INTEGER NOT NULL DEFAULT 0').run();
  }
}

// Mark a checkpoint as counted in the reference index.
function markIndexed(checkpointId) {
  connection().prepare(
    'INSERT OR IGNORE INTO recovery_indexed_checkpoints(checkpoint_id) VALUES (?)',
  ).run(checkpointId);
}

function isIndexed(checkpointId) {
  return connection().prepare(
    'SELECT 1 AS ok FROM recovery_indexed_checkpoints WHERE checkpoint_id = ?',
  ).get(checkpointId) !== undefined;
}

function readMeta(key) {
  const row = connection().prepare('SELECT value FROM recovery_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function writeMeta(key, value) {
  connection().prepare(
    'INSERT INTO recovery_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// Whether the reference index is built and its counts can be trusted.
//
// The state is derived from the data rather than kept in a side file: the
// index is authoritative exactly when every checkpoint is counted. A store
// that only ever saw the current code is authoritative from the first
// capture, with no build at all.
function isReady() {
  try {
    return pendingCount() === 0;
  } catch {
    return false;
  }
}

// How many checkpoints are still missing from the index.
function pendingCount() {
  return connection().prepare(
    `SELECT COUNT(*) AS n FROM recovery_checkpoints c
      WHERE NOT EXISTS (SELECT 1 FROM recovery_indexed_checkpoints i WHERE i.checkpoint_id = c.id)`,
  ).get()?.n ?? 0;
}

// Distinct blob hashes a checkpoint references. Corrupt manifests contribute
// no hashes rather than throwing: a damaged row must not break cleanup.
function checkpointBlobHashes(manifest) {
  const hashes = new Set();
  if (!manifest || typeof manifest !== 'object') return hashes;
  const paths = manifest.paths;
  if (!paths || typeof paths !== 'object') return hashes;
  for (const rec of Object.values(paths)) {
    if (rec && rec.kind === 'file' && typeof rec.hash === 'string' && rec.hash) hashes.add(rec.hash);
  }
  return hashes;
}

function parseManifest(manifestJson) {
  try {
    return JSON.parse(manifestJson);
  } catch {
    return null;
  }
}

// Add `delta` to the refcount of every blob in `hashes`.
function applyRefcountDelta(hashes, delta) {
  const list = [...hashes];
  if (!list.length) return;
  for (let start = 0; start < list.length; start += REFCOUNT_CHUNK) {
    const chunk = list.slice(start, start + REFCOUNT_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    connection().prepare(
      `UPDATE recovery_blobs SET refcount = MAX(refcount + ?, 0) WHERE hash IN (${placeholders})`,
    ).run(delta, ...chunk);
  }
}

// Add a per-blob delta (a blob referenced by several checkpoints in the same
// batch needs a delta larger than one). The deltas are grouped by value so
// each group is one indexed UPDATE; a correlated subquery over a materialized
// delta would be quadratic in the group size.
function applyRefcountCounts(counts) {
  const groups = new Map();
  for (const [hash, n] of counts) {
    if (!n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(hash);
  }
  for (const [n, hashes] of groups) applyRefcountDelta(hashes, n);
}

// Yield to the event loop between batches.
//
// This uses a timer, not setImmediate: a setImmediate callback that
// schedules another setImmediate runs in the same check phase, so the loop
// never reaches its timer phase and pending timers (and with them the
// renderer's own event handling) starve for the whole build. A timer hands
// the loop back a full cycle.
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

// Build (or resume building) the reference index.
//
// The build walks the checkpoints that are not indexed yet, in id order, and
// counts the blob references they make. The batch is bounded by wall-clock
// time rather than by a row count: one manifest is the full workspace state
// of a capture and can be a megabyte of JSON, so a row-count batch would
// block the main thread for hundreds of milliseconds at a time.
//
// The counts are applied in a single transaction at the end, together with
// the marks that say the checkpoints are indexed. Applying them per batch
// would rewrite every blob row once per batch, which turns the build into
// millions of row updates; applying them once is one pass over the blobs.
// The trade-off is that an interrupted build restarts from the beginning
// rather than resuming — which is safe, because until the final transaction
// runs, nothing is marked and no count is applied, so the store is in exactly
// the state it started in.
async function build({ onProgress, rebuild = false } = {}) {
  const db = connection();
  // The recovery tables have to exist before there is anything to index.
  // Required lazily: recoveryStore is what uses this module, so requiring it
  // at load time would be a cycle.
  require('./recoveryStore').ensureRecoverySchema();
  ensureReferenceSchema();
  if (rebuild) {
    // Throw the index away and count everything again. The counts are derived
    // from the manifests, so this is the way to repair an index that was
    // built by something else, or that drifted.
    db.transaction(() => {
      db.prepare('UPDATE recovery_blobs SET refcount = 0').run();
      db.prepare('DELETE FROM recovery_indexed_checkpoints').run();
    })();
  }
  const ids = db.prepare(
    `SELECT c.id FROM recovery_checkpoints c
      WHERE NOT EXISTS (SELECT 1 FROM recovery_indexed_checkpoints i WHERE i.checkpoint_id = c.id)
      ORDER BY c.id ASC`,
  ).all().map((row) => row.id);
  if (!ids.length) return { built: false, processed: 0, ready: isReady() };

  // Counts per blob, with the checkpoint that last contributed so the same
  // blob referenced twice by one checkpoint is counted once. One map with a
  // marker is measurably cheaper than a set per checkpoint plus a global map.
  const counts = new Map();
  let processed = 0;
  let batchStarted = Date.now();
  // Manifests are fetched in small groups: one row per query costs more in
  // query overhead than the rows themselves, and one big fetch would
  // materialise the whole history in memory at once.
  const FETCH_BATCH = 4;
  for (let start = 0; start < ids.length; start += FETCH_BATCH) {
    const group = ids.slice(start, start + FETCH_BATCH);
    const rows = db.prepare(
      `SELECT id, manifest_json FROM recovery_checkpoints WHERE id IN (${group.map(() => '?').join(',')})`,
    ).all(...group);
    for (const row of rows) {
      const manifest = parseManifest(row.manifest_json);
      const paths = manifest?.paths;
      if (paths && typeof paths === 'object') {
        for (const rec of Object.values(paths)) {
          if (!rec || rec.kind !== 'file' || typeof rec.hash !== 'string' || !rec.hash) continue;
          const entry = counts.get(rec.hash);
          if (entry === undefined) counts.set(rec.hash, { n: 1, last: row.id });
          else if (entry.last !== row.id) { entry.n += 1; entry.last = row.id; }
        }
      }
      processed += 1;
      // Time-boxed on the work actually done: the batch boundary follows the
      // manifests that were read, not the number of rows.
      if (Date.now() - batchStarted >= BUILD_BATCH_MS) {
        batchStarted = Date.now();
        onProgress?.({ processed, remaining: ids.length - processed });
        await yieldToEventLoop();
      }
    }
  }

  const deltas = new Map();
  for (const [hash, entry] of counts) deltas.set(hash, entry.n);
  db.transaction(() => {
    applyRefcountCounts(deltas);
    const mark = db.prepare('INSERT OR IGNORE INTO recovery_indexed_checkpoints(checkpoint_id) VALUES (?)');
    for (const id of ids) mark.run(id);
    writeMeta('reference_index_built_at', String(Date.now()));
  })();
  return { built: true, processed, ready: isReady() };
}

let buildPromise = null;

// Build the index in the background. Safe to call repeatedly: a build that is
// already running is reused, and an install whose index is already complete
// does nothing.
function startBuild(options = {}) {
  if (buildPromise) return buildPromise;
  buildPromise = build(options)
    .catch((error) => {
      console.error('Recovery reference index build failed:', error);
      // The index stays incomplete, which keeps cleanup conservative. Never
      // leave the counts half-applied and treated as authoritative.
      return { built: false, error: error.message };
    })
    .finally(() => {
      buildPromise = null;
    });
  return buildPromise;
}

// Await the current build (used by tests and by callers that must not read
// half-built counts).
function waitForBuild() {
  return buildPromise ?? Promise.resolve({ built: false });
}

module.exports = {
  ensureReferenceSchema,
  isReady,
  pendingCount,
  markIndexed,
  isIndexed,
  checkpointBlobHashes,
  parseManifest,
  applyRefcountDelta,
  applyRefcountCounts,
  build,
  startBuild,
  waitForBuild,
};

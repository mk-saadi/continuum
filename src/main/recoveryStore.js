'use strict';

// Workspace file recovery (Phase 1): content-addressed before-image journal
// for native agent file mutations.
//
// Design (see docs/workspace-recovery-architecture.md): unique file contents
// are stored once as SHA-256-addressed blobs outside the workspace; checkpoint
// manifests + coverage records live in small SQLite tables next to the main
// database. Capture happens BEFORE the first irreversible mutation; restore
// is explicit, selective, and conflict-checked. Shell/MCP mutations are NOT
// covered in this phase (no step scanning yet).
//
// Ordering guarantee: blob bytes are fsynced to disk BEFORE any manifest row
// references them, and both land inside one SQLite transaction. A crash can
// therefore leave orphan blobs (swept by gcRecoveryBlobs) but never a
// manifest pointing at a missing blob.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  checkpointBlobHashes,
  parseManifest,
  applyRefcountDelta,
  markIndexed,
  isIndexed,
  isReady: referenceIndexReady,
} = require('./recoveryReferenceIndex');

const RECOVERY_MAX_FILE_BYTES = 2 * 1024 * 1024; // per-file capture cap (OpenCode parity)
const RECOVERY_MAX_OP_FILES = 1000; // per-operation file cap (targeted captures)
const RECOVERY_MAX_OP_BYTES = 100 * 1024 * 1024; // per-operation byte cap (targeted captures)
// Full-workspace scans (shell/MCP boundaries) cover far more files than one
// tool call touches. Separate generous caps: overflow degrades to disclosed
// partial coverage, never silent omission.
const RECOVERY_SCAN_MAX_FILES = 20000;
const RECOVERY_SCAN_MAX_BYTES = 1024 * 1024 * 1024;
// Scope excludes: version-control internals, our own scratch space, and
// regenerable dependency/build output. Applied at every depth, recorded in
// coverage.excluded (never silent). Explicitly listed tool paths bypass this
// (an agent asked to write dist/bundle.js still gets it captured).
const RECOVERY_SCOPE_EXCLUDES = new Set(['.git', '.llm_workspace', 'node_modules', 'dist', 'build']);
// A file modified within this window at capture time may still be changing;
// flag it volatile rather than pretending the bytes are settled.
const RECOVERY_VOLATILE_MS = 2000;
// SHA-256 of zero bytes. Used to recognize empty-file blobs explicitly — an
// empty file is legitimate content (never an error by itself), but restores
// that would newly empty non-empty files are treated as risky.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// Restore safety gate: an empty recorded file overwriting a non-empty current
// file always needs explicit authorization; a checkpoint whose in-scope file
// records are all (or nearly all) empty is treated as possibly damaged.
const EMPTY_OVER_HARD_COUNT = 10;
const EMPTY_OVER_HARD_BYTES = 1024 * 1024;
const DEGENERATE_EMPTY_RATIO = 0.9;
const DEGENERATE_MIN_FILES = 3;
// A recorded file less than a quarter of a sizable current file is
// "suspiciously smaller": reported, and escalated in aggregate.
const SHRINK_RATIO = 0.25;
const SHRINK_MIN_CURRENT_BYTES = 4096;
const SHRINK_HARD_COUNT = 5;
const SHRINK_HARD_BYTES = 1024 * 1024;

function appDataDirectory() {
  return require('./configStore').getConfig().appDataDirectory;
}

function recoveryBaseDir() {
  return path.join(appDataDirectory(), 'recovery');
}

function blobPath(hash) {
  return path.join(recoveryBaseDir(), 'blobs', hash.slice(0, 2), hash);
}

function connection() {
  return require('./db').db;
}

function ensureRecoverySchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS recovery_sessions(
      id INTEGER PRIMARY KEY,
      project_root TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS recovery_checkpoints(
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES recovery_sessions(id),
      chat_session_id TEXT,
      tool_name TEXT,
      kind TEXT NOT NULL DEFAULT 'op',
      op_json TEXT,
      manifest_json TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS recovery_blobs(
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_recovery_checkpoints_session ON recovery_checkpoints(session_id, id)`,
    // Workspace content index: last-seen hash/size/mtime per path, so
    // repeated boundary scans rehash only changed files instead of the whole
    // tree. Correctness never depends on it (stale rows just cost a rehash;
    // missing blob files are always re-stored); only speed does.
    `CREATE TABLE IF NOT EXISTS recovery_workspace_index(
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      hash TEXT,
      size INTEGER,
      mtime_ms INTEGER,
      PRIMARY KEY(root, path)
    )`,
  ];
  connection().transaction(() => {
    for (const sql of statements) connection().prepare(sql).run();
    // Pinned checkpoints survive retention pruning (Phase 3). ALTER once;
    // PRAGMA check keeps this idempotent across restarts.
    const columns = connection().prepare('PRAGMA table_info(recovery_checkpoints)').all();
    if (!columns.some((column) => column.name === 'pinned')) {
      connection().prepare('ALTER TABLE recovery_checkpoints ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0').run();
    }
    // ctime hardens the mtime index (Phase 1 perf): writers cannot preserve
    // ctime while changing content, so (size, mtime, ctime) stays conservative
    // where (size, mtime) alone trusts a stale entry. Pre-migration rows read
    // NULL and always miss — safe direction, one rehash per file.
    const indexColumns = connection().prepare('PRAGMA table_info(recovery_workspace_index)').all();
    if (!indexColumns.some((column) => column.name === 'ctime_ms')) {
      connection().prepare('ALTER TABLE recovery_workspace_index ADD COLUMN ctime_ms INTEGER').run();
    }
  })();
  // The blob reference index owns the refcount column and the build state
  // that says whether those counts can be trusted.
  require('./recoveryReferenceIndex').ensureReferenceSchema();
}

// Checkpoints with in-flight restores. GC unions their blobs into the
// referenced set so cleanup can never delete bytes a restore is reading.
const activeRestores = new Map();
function trackRestoreStart(checkpointId) {
  activeRestores.set(checkpointId, (activeRestores.get(checkpointId) ?? 0) + 1);
}
function trackRestoreEnd(checkpointId) {
  const left = (activeRestores.get(checkpointId) ?? 1) - 1;
  if (left <= 0) activeRestores.delete(checkpointId);
  else activeRestores.set(checkpointId, left);
}

// ---------------------------------------------------------------------------
// Blob reference index
//
// `recovery_blobs.refcount` counts how many checkpoints reference a blob.
// It replaces the old "parse every manifest to find the referenced set" scan,
// which was O(all history) — 632 MB of manifest JSON and 2.8M path records on
// a real install — and ran on the Electron main thread, freezing the app for
// seconds every time the storage panel asked for stats.
//
// Invariant: a checkpoint's set of referenced blobs is fixed at creation.
// `finalizeBoundaryCheckpoint` only appends `absent` records and
// `recordOpPostState` only rewrites op_json, so neither can add or remove a
// file record. The refcount therefore only changes when a checkpoint is
// created or deleted.
//
// The index itself lives in src/main/recoveryReferenceIndex.js, which also
// owns building it from the existing manifests.
// ---------------------------------------------------------------------------

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Resolve a manifest-relative path against root with write-tool-grade
// containment, WITHOUT following the final component: the final entry may
// itself be a symlink (recorded as such), and restore must operate on the
// link rather than passing through it. Intermediate outside-pointing links
// are still rejected.
async function resolveRestoreTarget(root, rel, { uncontained = false } = {}) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error(`Invalid recovery path: ${rel}.`);
  const abs = path.resolve(root, rel);
  if (uncontained) return abs;
  if (!insideRoot(root, abs)) throw new Error('Execution blocked: Path escapes the project root.');
  await assertParentsContained(root, rel);
  return abs;
}

// Every existing ancestor below the final component must resolve inside the
// workspace. Missing ancestors stop the walk (they cannot hide a link).
//
// `validated` is an optional per-scan cache of already-checked ancestor
// absolute paths. Walks proceed top-down, so a parent directory is always
// validated before its children are recorded; re-checking the same ancestors
// for every sibling file costs O(depth) lstat+realpath per file (the dominant
// warm-scan cost on deep trees). Every ancestor of every recorded path is
// still validated once per scan — the check is deduplicated, never skipped.
// Callers that need the strictest per-path re-validation (restore time) omit
// the cache. Concurrent-link-swap TOCTOU is unchanged in kind: the pre-existing
// readdir→lstat race already makes containment point-in-time per scan.
async function assertParentsContained(root, rel, validated = null) {
  const parts = rel.split('/').filter((part) => part && part !== '.');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (part === '..') throw new Error('Execution blocked: Path escapes the project root.');
    current = path.join(current, part);
    if (validated?.has(current)) continue;
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    void stat;
    const real = await fs.realpath(current);
    if (!insideRoot(root, real)) throw new Error('Execution blocked: Symlink escapes the project root.');
    validated?.add(current);
  }
}

async function getOrCreateRecoverySession(projectRoot) {
  ensureRecoverySchema();
  const root = path.resolve(projectRoot);
  const existing = connection().prepare('SELECT id FROM recovery_sessions WHERE project_root = ?').get(root);
  if (existing) return existing.id;
  return Number(connection().prepare('INSERT INTO recovery_sessions(project_root) VALUES (?)').run(root).lastInsertRowid);
}

// fsync-durable blob publication: temp file in the same directory, fsync,
// rename over the final name. Returns {hash, size, deduplicated}.
// `opts.knownShards` (a per-scan Set of shard dirs already ensured to exist)
// skips the redundant recursive mkdir on every blob; the call stays correct
// without it (mkdir is idempotent), so single-path callers omit it.
async function putBlob(bytes, opts = {}) {
  const hash = sha256Hex(bytes);
  const final = blobPath(hash);
  try {
    const st = await fs.stat(final);
    if (st.isFile() && st.size === bytes.length) return { hash, size: bytes.length, deduplicated: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const shard = path.dirname(final);
  if (!opts.knownShards?.has(shard)) {
    await fs.mkdir(shard, { recursive: true });
    opts.knownShards?.add(shard);
  }
  const temporary = `${final}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, final);
  return { hash, size: bytes.length, deduplicated: false };
}

async function readBlob(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}.`);
  let bytes;
  try {
    bytes = await fs.readFile(blobPath(hash));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Recovery blob missing: ${hash}.`);
    throw error;
  }
  if (sha256Hex(bytes) !== hash) throw new Error(`Recovery blob corrupted: ${hash}.`);
  return bytes;
}

async function blobExists(hash) {
  try {
    await fs.stat(blobPath(hash));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Thrown inside a workspace walk when scan caps overflow. Scanners catch it
// per top-level entry and degrade to disclosed partial coverage; targeted
// captures (hardCaps) let it propagate as a blocking error instead.
class ScanCapExceeded extends Error {}

// Record one path's state. Directories walk recursively. Options:
// - explicit: an explicitly listed path (tool target), honored even when
//   exclude-named; discovered children are never explicit.
// - excluded: array collecting scope-excluded entries (policy, not failure).
// - hardCaps: true (targeted captures) throws on cap overflow to block the
//   operation; false (boundary scans) marks truncation and unwinds.
// - index: Map(path -> {hash,size,mtime_ms,ctime_ms}) for reuse without rehashing.
// - validated: per-scan Set of containment-checked ancestor absolute paths
//   (top-down walks check each ancestor once, not once per file).
// - shards: per-scan Set of known blob shard dirs, skipping redundant mkdir.
// Unreadable/oversized/unsupported files are recorded as `uncaptured` (never
// as `absent` — a failed read is not proof of absence) AND listed in skipped.
async function recordPath(root, rel, manifest, skipped, budget, uncontained = false, opts = {}) {
  const { explicit = false, excluded = null, hardCaps = true, index = null, now = Date.now(), validated = null, shards = null } = opts;
  const abs = path.resolve(root, rel);
  if (!uncontained) {
    if (!insideRoot(root, abs)) {
      skipped.push({ path: rel, reason: 'escape' });
      return;
    }
    try {
      await assertParentsContained(root, rel, validated);
    } catch {
      skipped.push({ path: rel, reason: 'escape' });
      return;
    }
  }
  let stat;
  try {
    stat = await fs.lstat(abs);
  } catch (error) {
    if (error.code === 'ENOENT') {
      manifest.paths[rel] = { kind: 'absent' };
      return;
    }
    skipped.push({ path: rel, reason: 'unreadable' });
    manifest.paths[rel] = { kind: 'uncaptured', reason: 'unreadable' };
    return;
  }
  const mode = stat.mode & 0o7777;
  const mtimeMs = Math.floor(stat.mtimeMs);
  // ctime cannot be set by writers (only the system updates it), so the
  // (size, mtime, ctime) triple stays conservative where (size, mtime) alone
  // is not: content changed under a preserved mtime still bumps ctime and
  // forces a rehash instead of trusting a stale index entry. Same-tick
  // double writes with a forced mtime remain a disclosed residual.
  const ctimeMs = Math.floor(stat.ctimeMs);
  const volatile = now - mtimeMs < RECOVERY_VOLATILE_MS;
  if (stat.isSymbolicLink()) {
    manifest.paths[rel] = { kind: 'symlink', target: await fs.readlink(abs), mode };
    return;
  }
  if (stat.isDirectory()) {
    manifest.paths[rel] = { kind: 'dir', mode };
    let entries;
    try {
      entries = await fs.readdir(abs);
    } catch {
      skipped.push({ path: rel, reason: 'unreadable' });
      manifest.paths[rel] = { kind: 'uncaptured', reason: 'unreadable' };
      return;
    }
    for (const entry of entries) {
      if (!explicit && RECOVERY_SCOPE_EXCLUDES.has(entry)) {
        if (excluded) excluded.push({ path: path.join(rel, entry), reason: 'scope-excluded' });
        continue;
      }
      await recordPath(root, path.join(rel, entry), manifest, skipped, budget, uncontained, { ...opts, explicit: false });
    }
    return;
  }
  if (!stat.isFile()) {
    skipped.push({ path: rel, reason: 'unsupported' });
    manifest.paths[rel] = { kind: 'uncaptured', reason: 'unsupported' };
    return;
  }
  if (stat.size > RECOVERY_MAX_FILE_BYTES) {
    skipped.push({ path: rel, reason: 'too_large' });
    manifest.paths[rel] = { kind: 'uncaptured', reason: 'too_large' };
    return;
  }
  const caps = budget.scanCaps ?? { files: RECOVERY_MAX_OP_FILES, bytes: RECOVERY_MAX_OP_BYTES };
  budget.files += 1;
  budget.bytes += stat.size;
  if (budget.files > caps.files || budget.bytes > caps.bytes) {
    if (hardCaps) {
      throw new Error(
        `Recovery scope exceeds operation caps (${RECOVERY_MAX_OP_FILES} files / 100 MiB). ` +
        'Refusing to proceed without a complete capture.',
      );
    }
    budget.truncated = true;
    skipped.push({ path: rel, reason: 'cap_exceeded' });
    manifest.paths[rel] = { kind: 'uncaptured', reason: 'cap_exceeded' };
    throw new ScanCapExceeded(rel);
  }
  // Index fast path: unchanged size+mtime+ctime with a live blob needs no
  // rehash. The blob-existence check keeps the core guarantee (no dangling
  // manifest references) even if GC or another process removed the file.
  // Rows predating the ctime column (NULL) always miss: safe direction.
  const known = index?.get(rel);
  if (known && known.size === stat.size && known.mtime_ms === mtimeMs && known.ctime_ms === ctimeMs && typeof known.hash === 'string') {
    if (await blobExists(known.hash)) {
      manifest.paths[rel] = { kind: 'file', hash: known.hash, size: stat.size, mode, mtimeMs, ctimeMs, ...(volatile ? { volatile: true } : {}) };
      budget.blobs.push({ hash: known.hash, size: stat.size });
      return;
    }
  }
  let bytes;
  try {
    bytes = await fs.readFile(abs);
  } catch {
    skipped.push({ path: rel, reason: 'unreadable' });
    manifest.paths[rel] = { kind: 'uncaptured', reason: 'unreadable' };
    return;
  }
  // A file changing mid-read is still captured (bytes are real), but flagged
  // so consumers know the snapshot may already be stale. Youth alone also
  // flags: a file written moments before capture may yet be appended to.
  let settled = true;
  try {
    const after = await fs.lstat(abs);
    settled = Math.floor(after.mtimeMs) === mtimeMs && after.size === bytes.length;
  } catch {
    settled = false;
  }
  const { hash } = await putBlob(bytes, { knownShards: shards });
  manifest.paths[rel] = { kind: 'file', hash, size: bytes.length, mode, mtimeMs, ctimeMs, ...(volatile || !settled ? { volatile: true } : {}) };
  budget.blobs.push({ hash, size: bytes.length });
}

// Ancestors of `absTarget` (workspace-relative, top-down) that do not exist
// yet. An operation creating them should record them so restore can remove
// ones that are still empty afterwards — never ones holding user content.
async function missingAncestors(root, absTarget) {
  const chain = [];
  let current = path.dirname(absTarget);
  while (insideRoot(root, current) && path.relative(root, current) !== '') {
    try {
      await fs.lstat(current);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      chain.unshift(path.relative(root, current));
      current = path.dirname(current);
    }
  }
  return chain;
}

// Capture before-images for `paths` (workspace-relative; directories walk
// recursively). Blobs land on disk first; the checkpoint row + blob rows
// commit atomically. Never returns a manifest referencing unwritten blobs.
async function captureOperation({ root, chatSessionId = null, toolName = null, kind = 'op', op = null, paths = [], required = [], uncontained = false, explicitPaths = true }) {
  if (!root || typeof root !== 'string') throw new Error('Recovery capture requires a project root.');
  const realRoot = await fs.realpath(root).catch(() => { throw new Error('Project root is not a directory.'); });
  if (!(await fs.stat(realRoot).catch(() => null))?.isDirectory()) throw new Error('Project root is not a directory.');
  ensureRecoverySchema();
  const manifest = { version: 1, root: realRoot, uncontained: uncontained === true, op: op ?? null, parentsCreated: [], paths: {} };
  const skipped = [];
  const excluded = [];
  const budget = { files: 0, bytes: 0, blobs: [] };
  const parentSet = new Set();
  const now = Date.now();
  const validated = new Set();
  const shards = new Set();
  for (const rel of paths) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) {
      skipped.push({ path: String(rel), reason: 'invalid' });
      continue;
    }
    const abs = path.resolve(realRoot, rel);
    if (!uncontained && !insideRoot(realRoot, abs)) {
      skipped.push({ path: rel, reason: 'escape' });
      continue;
    }
    for (const ancestor of await missingAncestors(realRoot, abs)) parentSet.add(ancestor);
    await recordPath(realRoot, rel, manifest, skipped, budget, uncontained,
      { explicit: explicitPaths, excluded, now, validated, shards });
  }
  manifest.parentsCreated = [...parentSet].sort();
  const volatile = Object.entries(manifest.paths)
    .filter(([, rec]) => rec && rec.volatile === true)
    .map(([rel]) => rel);
  // Empty files are legitimate content, recorded here as verified metadata
  // (not a warning by itself) so history views and the restore safety gate
  // can distinguish intentional empties from damage-shaped checkpoints.
  const fileRecords = Object.entries(manifest.paths)
    .filter(([, rec]) => rec && rec.kind === 'file');
  const emptyFiles = fileRecords
    .filter(([, rec]) => rec.size === 0)
    .map(([rel]) => rel);
  const coverage = {
    complete: skipped.length === 0,
    skipped,
    excluded,
    volatile,
    emptyFiles,
    allEmptyFiles: fileRecords.length > 0 && emptyFiles.length === fileRecords.length,
  };
  // A path the operation WILL mutate must never be half-protected: any skip
  // on a required path blocks the whole capture instead of proceeding with
  // a checkpoint that cannot restore it.
  const requiredSet = new Set(required);
  const isRequired = (skippedPath) => requiredSet.has(skippedPath)
    || [...requiredSet].some((req) => req && skippedPath.startsWith(`${req}/`));
  const missing = skipped.filter((entry) => isRequired(entry.path));
  if (missing.length) {
    throw new Error(
      `Recovery capture incomplete for required path(s) ${missing.map((entry) => `${entry.path} (${entry.reason})`).join(', ')}. ` +
      'Refusing to proceed without a complete capture.',
    );
  }
  const sessionId = await getOrCreateRecoverySession(realRoot);
  const checkpointId = connection().transaction(() => {
    insertBlobRows(budget.blobs);
    const id = Number(connection().prepare(
      `INSERT INTO recovery_checkpoints(session_id, chat_session_id, tool_name, kind, op_json, manifest_json, coverage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, chatSessionId, toolName, kind, op ? JSON.stringify(op) : null,
      JSON.stringify(manifest), JSON.stringify(coverage)).lastInsertRowid);
    // Register the blobs this checkpoint references. Inside the same
    // transaction as the checkpoint row, so a checkpoint can never exist
    // without its references (or the reverse).
    applyRefcountDelta(checkpointBlobHashes(manifest), 1);
    markIndexed(id);
    return id;
  })();
  return { checkpointId, sessionId, manifest, coverage };
}

// Batched INSERT OR IGNORE: per-row prepare() of the same statement dominates
// commit cost on large scans (measured 23ms → 1ms per 1500 rows). Semantics
// are identical to the per-row loop — rows are keyed by hash, so re-inserting
// fast-path-reused hashes still heals crash-orphaned rows (blob file present,
// row missing), which GC would otherwise sweep as orphans.
function insertBlobRows(blobs) {
  for (let start = 0; start < blobs.length; start += 500) {
    const chunk = blobs.slice(start, start + 500);
    connection().prepare(
      `INSERT OR IGNORE INTO recovery_blobs(hash, size) VALUES ${chunk.map(() => '(?, ?)').join(',')}`,
    ).run(...chunk.flatMap(({ hash, size }) => [hash, size]));
  }
}

// Full-workspace restore point (run-start / manual). Walks the whole project
// tree minus scope excludes; same caps and honesty rules as captureOperation.
async function createManualCheckpoint(root, { chatSessionId = null, label = null } = {}) {
  const realRoot = await fs.realpath(root).catch(() => { throw new Error('Project root is not a directory.'); });
  const entries = await fs.readdir(realRoot).catch(() => { throw new Error('Project root is not a directory.'); });
  const paths = entries.filter((entry) => !RECOVERY_SCOPE_EXCLUDES.has(entry));
  return captureOperation({ root: realRoot, chatSessionId, toolName: label ?? 'manual', kind: 'manual', paths });
}

function loadWorkspaceIndex(root) {
  ensureRecoverySchema();
  const rows = connection().prepare('SELECT path, hash, size, mtime_ms, ctime_ms FROM recovery_workspace_index WHERE root = ?').all(root);
  return new Map(rows.map((row) => [row.path, row]));
}

function saveWorkspaceIndex(root, records) {
  ensureRecoverySchema();
  connection().transaction(() => {
    connection().prepare('DELETE FROM recovery_workspace_index WHERE root = ?').run(root);
    const insert = connection().prepare(
      'INSERT INTO recovery_workspace_index(root, path, hash, size, mtime_ms, ctime_ms) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [rel, rec] of records) {
      insert.run(root, rel,
        rec.kind === 'file' ? rec.hash : null,
        rec.kind === 'file' ? rec.size : null,
        rec.kind === 'file' ? (rec.mtimeMs ?? null) : null,
        rec.kind === 'file' ? (rec.ctimeMs ?? null) : null);
    }
  })();
}

// Pure comparison for the warm-scan fast path: skip the index DELETE+rewrite
// when the observed file records are identical to the loaded index rows.
// The index is a cache (correctness never depends on it), so skipping an
// identical rewrite is observably equivalent — a crash before or after yields
// the same content. Stale rows for vanished files linger until the next
// content change, exactly as harmless as before (fast path revalidates blobs).
function indexRecordsEqual(index, observed) {
  if (!index || index.size !== observed.length) return false;
  for (const [rel, rec] of observed) {
    const known = index.get(rel);
    if (!known || known.hash !== rec.hash || known.size !== rec.size
      || (known.mtime_ms ?? null) !== (rec.mtimeMs ?? null)
      || (known.ctime_ms ?? null) !== (rec.ctimeMs ?? null)) return false;
  }
  return true;
}

// Full eligible-workspace scan for shell/MCP boundaries. Unlike targeted
// capture, cap overflow degrades to disclosed partial coverage (truncated)
// instead of blocking: the caller decides whether partial pre-state may
// proceed, and the checkpoint always says exactly what it holds.
async function scanWorkspaceState(root, { uncontained = false } = {}) {
  const started = Date.now();
  if (!root || typeof root !== 'string') throw new Error('Recovery scan requires a project root.');
  const realRoot = await fs.realpath(root).catch(() => { throw new Error('Project root is not a directory.'); });
  const topEntries = await fs.readdir(realRoot).catch(() => { throw new Error('Project root is not a directory.'); });
  ensureRecoverySchema();
  const manifest = { version: 1, root: realRoot, uncontained: uncontained === true, op: null, parentsCreated: [], paths: {} };
  const skipped = [];
  const excluded = [];
  const budget = {
    files: 0, bytes: 0, blobs: [],
    scanCaps: { files: RECOVERY_SCAN_MAX_FILES, bytes: RECOVERY_SCAN_MAX_BYTES },
    truncated: false,
  };
  const index = loadWorkspaceIndex(realRoot);
  const now = Date.now();
  // Per-scan caches: containment-checked ancestors and ensured blob shards.
  // Fresh per scan so no validation verdict outlives the walk that made it.
  const validated = new Set();
  const shards = new Set();
  const stopAt = (rel) => {
    skipped.push({ path: rel, reason: 'cap_exceeded' });
    manifest.paths[rel] = { kind: 'uncaptured', reason: 'cap_exceeded' };
  };
  for (const entry of topEntries) {
    if (!uncontained && RECOVERY_SCOPE_EXCLUDES.has(entry)) {
      excluded.push({ path: entry, reason: 'scope-excluded' });
      continue;
    }
    try {
      await recordPath(realRoot, entry, manifest, skipped, budget, uncontained,
        { explicit: false, excluded, hardCaps: false, index, now, validated, shards });
    } catch (error) {
      if (!(error instanceof ScanCapExceeded)) throw error;
      budget.truncated = true;
      stopAt(entry);
      for (const rest of topEntries.slice(topEntries.indexOf(entry) + 1)) {
        if (!uncontained && RECOVERY_SCOPE_EXCLUDES.has(rest)) {
          excluded.push({ path: rest, reason: 'scope-excluded' });
          continue;
        }
        stopAt(rest);
      }
      break;
    }
  }
  // Refresh the index from what was actually observed (present files only).
  // Unchanged warm scans skip the DELETE+rewrite: the comparator above proves
  // the stored rows are already identical.
  const observed = Object.entries(manifest.paths)
    .filter(([, rec]) => rec && rec.kind === 'file');
  if (!indexRecordsEqual(index, observed)) saveWorkspaceIndex(realRoot, observed);
  const volatile = Object.entries(manifest.paths)
    .filter(([, rec]) => rec && rec.volatile === true)
    .map(([rel]) => rel);
  return {
    root: realRoot,
    manifest,
    coverage: { complete: skipped.length === 0 && !budget.truncated, skipped, excluded, volatile },
    newBlobs: budget.blobs,
    truncated: budget.truncated,
    stats: { files: budget.files, bytes: budget.bytes, ms: Date.now() - started },
  };
}

// Commit a workspace scan as a checkpoint (pre-operation state for shell/MCP
// boundaries). Blob rows + checkpoint row land in one transaction.
async function commitScanResult({ root, chatSessionId = null, toolName = null, kind = 'shell', op = null, scan }) {
  ensureRecoverySchema();
  const sessionId = await getOrCreateRecoverySession(scan.root);
  const coverage = scan.coverage;
  const checkpointId = connection().transaction(() => {
    insertBlobRows(scan.newBlobs);
    const id = Number(connection().prepare(
      `INSERT INTO recovery_checkpoints(session_id, chat_session_id, tool_name, kind, op_json, manifest_json, coverage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, chatSessionId, toolName, kind, op ? JSON.stringify(op) : null,
      JSON.stringify(scan.manifest), JSON.stringify(coverage)).lastInsertRowid);
    applyRefcountDelta(checkpointBlobHashes(scan.manifest), 1);
    markIndexed(id);
    return id;
  })();
  return { checkpointId, sessionId, manifest: scan.manifest, coverage };
}

// Pure state diff: pre-manifest paths vs post-manifest paths. Returns
// changed[] with honest capture flags; rename pairing by content hash.
// States: file | dir | symlink | absent | uncaptured | unsupported.
function diffStates(prePaths, postPaths) {
  const changed = [];
  const deletedHashes = new Map(); // hash -> [paths] for rename pairing
  const createdByHash = new Map();
  for (const [rel, rec] of Object.entries(prePaths)) {
    const now = postPaths[rel];
    if (!now) {
      changed.push({ path: rel, change: 'deleted', captured: rec.kind === 'file' });
      if (rec.kind === 'file') {
        if (!deletedHashes.has(rec.hash)) deletedHashes.set(rec.hash, []);
        deletedHashes.get(rec.hash).push(rel);
      }
      continue;
    }
    if (rec.kind === 'file' && now.kind === 'file') {
      if (now.hash !== rec.hash) changed.push({ path: rel, change: 'modified', captured: true });
      continue;
    }
    if (rec.kind === 'absent' && now.kind !== 'absent') {
      changed.push({ path: rel, change: 'created', captured: true });
      continue;
    }
    if (rec.kind !== now.kind) {
      changed.push({ path: rel, change: 'type-changed', captured: rec.kind === 'file', from: rec.kind, to: now.kind });
      continue;
    }
    if ((rec.kind === 'uncaptured' || rec.kind === 'unsupported') && JSON.stringify(rec) !== JSON.stringify(now)) {
      changed.push({ path: rel, change: 'changed-uncaptured', captured: false });
    }
  }
  for (const [rel, rec] of Object.entries(postPaths)) {
    if (!prePaths[rel]) {
      const entry = { path: rel, change: 'created', captured: true };
      changed.push(entry);
      if (rec.kind === 'file') {
        if (!createdByHash.has(rec.hash)) createdByHash.set(rec.hash, []);
        createdByHash.get(rec.hash).push(entry);
      }
    }
  }
  // Pair deletions with same-hash creations as renames (reporting aid only;
  // restore handles each end through the normal per-path semantics).
  for (const [hash, fromRels] of deletedHashes) {
    const toEntries = createdByHash.get(hash);
    if (!toEntries) continue;
    while (fromRels.length && toEntries.length) {
      const from = fromRels.shift();
      const entry = toEntries.shift();
      entry.change = 'renamed';
      entry.from = from;
      const doomed = changed.findIndex((item) => item.path === from && item.change === 'deleted');
      if (doomed !== -1) changed.splice(doomed, 1);
    }
  }
  return changed;
}

// Merge a post-operation scan into a boundary checkpoint: created paths gain
// `absent` records (they did not exist at pre-state, so removal restores it),
// and the op record carries the change list plus post-scan honesty flags.
// A failed post-scan leaves the pre-state row untouched and records only the
// failure — the pre-state remains a valid, restorable recovery point.
async function finalizeBoundaryCheckpoint(preCheckpointId, { postPaths = null, postSkipped = [], changed = [], truncated = false, postFailed = null }) {
  ensureRecoverySchema();
  const row = connection().prepare('SELECT * FROM recovery_checkpoints WHERE id = ?').get(preCheckpointId);
  if (!row) throw new Error(`Unknown recovery checkpoint: ${preCheckpointId}.`);
  const manifest = JSON.parse(row.manifest_json);
  const priorOp = row.op_json ? JSON.parse(row.op_json) : {};
  let manifestTouched = false;
  if (postFailed) {
    priorOp.postFailed = String(postFailed).slice(0, 300);
    priorOp.postComplete = false;
  } else {
    // Created paths gain `absent` records (they did not exist at pre-state,
    // so removal restores it). When nothing was created or renamed, the
    // manifest is byte-identical and only op_json is rewritten — skipping a
    // full ~MB-scale re-serialization + row rewrite per boundary.
    for (const entry of changed) {
      if ((entry.change === 'created' || entry.change === 'renamed') && !manifest.paths[entry.path]) {
        manifest.paths[entry.path] = { kind: 'absent' };
        manifestTouched = true;
      }
    }
    // Persist full post-operation state so later restores can tell the
    // operation's own effects (revert freely) from later edits (conflicts).
    const postState = {};
    for (const rel of new Set([...Object.keys(manifest.paths), ...Object.keys(postPaths ?? {})])) {
      postState[rel] = compressStateRecord((postPaths ?? {})[rel]);
    }
    priorOp.postState = postState;
    priorOp.changed = changed;
    priorOp.postComplete = postSkipped.length === 0 && !truncated;
    priorOp.postSkipped = postSkipped;
  }
  if (manifestTouched || postFailed) {
    connection().prepare('UPDATE recovery_checkpoints SET manifest_json = ?, op_json = ? WHERE id = ?')
      .run(JSON.stringify(manifest), JSON.stringify(priorOp), preCheckpointId);
  } else {
    connection().prepare('UPDATE recovery_checkpoints SET op_json = ? WHERE id = ?')
      .run(JSON.stringify(priorOp), preCheckpointId);
  }
  return getCheckpoint(preCheckpointId);
}

function getCheckpoint(checkpointId) {
  ensureRecoverySchema();
  const row = connection().prepare('SELECT * FROM recovery_checkpoints WHERE id = ?').get(checkpointId);
  if (!row) throw new Error(`Unknown recovery checkpoint: ${checkpointId}.`);
  return {
    ...row,
    op: row.op_json ? JSON.parse(row.op_json) : null,
    manifest: JSON.parse(row.manifest_json),
    coverage: JSON.parse(row.coverage_json),
  };
}

function listCheckpoints(sessionId, limit = 50) {
  ensureRecoverySchema();
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  return connection().prepare('SELECT * FROM recovery_checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, safeLimit).map((row) => ({
      ...row,
      op: row.op_json ? JSON.parse(row.op_json) : null,
      coverage: JSON.parse(row.coverage_json),
    }));
}

// Compact post-operation state for conflict detection: per path just
// kind + content hash (or symlink target). Lets restore tell the operation's
// own effects (safe to revert without force) apart from later edits
// (conflicts unless forced). Unknown paths stay conservative.
function compressStateRecord(rec) {
  if (!rec) return { k: 'absent' };
  if (rec.kind === 'file' && typeof rec.hash === 'string') return { k: 'file', h: rec.hash };
  if (rec.kind === 'absent') return { k: 'absent' };
  if (rec.kind === 'symlink') return { k: 'symlink', t: rec.target };
  return { k: 'other' };
}

function postMatchesCurrent(post, current) {
  if (!post) return false;
  if (post.k === 'file') return current.kind === 'file' && current.hash === post.h;
  if (post.k === 'absent') return current.kind === 'absent';
  if (post.k === 'symlink') return current.kind === 'symlink' && current.target === post.t;
  return false;
}

// Snapshot current state of listed paths for post-operation comparison.
// Best-effort per path: unreadable paths are omitted (conservative — unknown
// means strict conflicts), never fatal to the operation that just succeeded.
async function snapshotCurrentState(root, rels, uncontained = false) {
  const state = {};
  for (const rel of rels) {
    try {
      const abs = path.resolve(root, rel);
      if (!uncontained && !insideRoot(root, abs)) continue;
      if (!uncontained) {
        try {
          await assertParentsContained(root, rel);
        } catch {
          continue;
        }
      }
      state[rel] = compressStateRecord(await currentRecord(abs));
    } catch {
      /* Omit: unknown post-state stays conservative. */
    }
  }
  return state;
}

async function recordOpPostState(checkpointId, postState) {
  ensureRecoverySchema();
  const row = connection().prepare('SELECT op_json FROM recovery_checkpoints WHERE id = ?').get(checkpointId);
  if (!row) throw new Error(`Unknown recovery checkpoint: ${checkpointId}.`);
  const op = row.op_json ? JSON.parse(row.op_json) : {};
  op.postState = postState;
  connection().prepare('UPDATE recovery_checkpoints SET op_json = ? WHERE id = ?')
    .run(JSON.stringify(op), checkpointId);
  return postState;
}

// Current on-disk record for conflict detection. lstat-first: symlinks are
// reported as symlinks, never followed.
async function currentRecord(abs) {
  let stat;
  try {
    stat = await fs.lstat(abs);
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: await fs.readlink(abs) };
  if (stat.isDirectory()) return { kind: 'dir' };
  if (!stat.isFile()) return { kind: 'unsupported' };
  if (stat.size > RECOVERY_MAX_FILE_BYTES) return { kind: 'too_large' };
  const bytes = await fs.readFile(abs);
  return { kind: 'file', hash: sha256Hex(bytes), size: bytes.length, mode: stat.mode & 0o7777, mtimeMs: Math.floor(stat.mtimeMs) };
}

async function atomicWriteRestored(abs, bytes, mode) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const temporary = `${abs}.restore-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  await fs.writeFile(temporary, bytes);
  try {
    await fs.rename(temporary, abs);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  if (mode !== undefined) await fs.chmod(abs, mode).catch(() => {});
}

// Restore one manifest path. Returns an action string for the report.
// With dryRun, computes the action vocabulary identically but performs no
// writes, removals, or directory changes (blob existence is still verified,
// since a missing blob turns a planned restore into a planned skip).
// Conflict rule: reverting the operation's own effect (current matches the
// recorded post-operation state) needs no force; genuinely later edits
// conflict unless forced. Without post-state (old/manual checkpoints),
// any difference stays conservative.
async function restoreOne(root, rel, rec, { force, uncontained = false, dryRun = false, post = undefined }) {
  const abs = await resolveRestoreTarget(root, rel, { uncontained });
  const current = await currentRecord(abs);
  if (rec.kind === 'absent') {
    if (current.kind === 'absent') return 'unchanged';
    if (current.kind === 'file' || current.kind === 'symlink') {
      if (post !== undefined && !postMatchesCurrent(post, current) && !force) return 'skip:conflict';
      if (!dryRun) await fs.rm(abs, { force: true });
      return 'removed';
    }
    if (current.kind === 'dir') {
      if (dryRun) {
        const empty = await fs.readdir(abs).then((entries) => entries.length === 0).catch(() => false);
        return empty ? 'removed' : 'skip:non_empty_directory';
      }
      try {
        await fs.rmdir(abs);
        return 'removed';
      } catch {
        return 'skip:non_empty_directory';
      }
    }
    return 'skip:unsupported_current';
  }
  if (rec.kind === 'unsupported' || rec.kind === 'uncaptured') return 'skip:uncapturable';
  if (rec.kind === 'dir') {
    if (current.kind === 'dir') return 'unchanged';
    if (current.kind !== 'absent') return 'skip:conflict';
    if (!dryRun) {
      await fs.mkdir(abs, { recursive: true });
      if (rec.mode !== undefined) await fs.chmod(abs, rec.mode).catch(() => {});
    }
    return 'restored';
  }
  if (rec.kind === 'symlink') {
    if (current.kind === 'symlink' && current.target === rec.target) return 'unchanged';
    if (current.kind !== 'absent' && !force) return 'skip:conflict';
    if (!dryRun) {
      await fs.rm(abs, { force: true, recursive: true });
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.symlink(rec.target, abs);
    }
    return 'restored';
  }
  // rec.kind === 'file'
  if (current.kind === 'file') {
    if (current.hash === rec.hash && current.mode === rec.mode) return 'unchanged';
    if (!postMatchesCurrent(post, current) && !force) return 'skip:conflict';
  } else if (current.kind === 'absent') {
    // Fresh write below.
  } else if (current.kind === 'symlink') {
    if (!postMatchesCurrent(post, current) && !force) return 'skip:conflict';
    // Never write through a link: remove the link itself, then write.
    if (!dryRun) await fs.rm(abs, { force: true });
  } else {
    return 'skip:conflict';
  }
  // Blob verified before any write — and before a dry-run claims success.
  let bytes;
  try {
    bytes = await readBlob(rec.hash);
  } catch {
    return 'skip:blob_missing';
  }
  if (dryRun) return 'restored';
  // Brief §5: resolveRestoreTarget + lstat discipline above guarantees `abs`
  // itself is not a link here, so the write cannot pass through one.
  await atomicWriteRestored(abs, bytes, rec.mode);
  if (sha256Hex(bytes) !== rec.hash) {
    throw new Error(`Restore verification failed for ${rel}.`);
  }
  return current.kind === 'absent' ? 'restored' : 'restored';
}

// Restore safety analysis. Plans every wanted path with the same decision
// logic as the real restore (via dry-run restoreOne, which performs no
// writes) and measures what would be overwritten. Empty files are legitimate
// content, so a single empty-over-nonempty is authorization-gated rather
// than refused; mass emptying or a checkpoint whose file records are nearly
// all empty (likely captured damage) is refused pending stronger proof.
// Pure read-only: safe to run before any snapshot or write.
async function analyzeRestoreSafety(root, manifest, wanted, { force = false, uncontained = false, postState = null } = {}) {
  const perPath = [];
  for (const rel of wanted) {
    const rec = manifest.paths[rel];
    let action = 'error: unknown-record';
    try {
      action = await restoreOne(root, rel, rec, { force, uncontained, dryRun: true, post: postState?.[rel] });
    } catch (error) {
      action = `error: ${String(error.message).slice(0, 160)}`;
    }
    let currentSize = null;
    let currentKind = null;
    try {
      const abs = await resolveRestoreTarget(root, rel, { uncontained });
      const current = await currentRecord(abs);
      currentKind = current.kind;
      if (typeof current.size === 'number') currentSize = current.size;
    } catch {
      /* Unknown current state stays conservative: excluded from risk math. */
    }
    perPath.push({
      path: rel,
      action,
      recKind: rec?.kind ?? 'unknown',
      recSize: typeof rec?.size === 'number' ? rec.size : null,
      currentKind,
      currentSize,
    });
  }
  const wouldWrite = (entry) => entry.action === 'restored';
  const emptyOvers = perPath.filter((entry) =>
    wouldWrite(entry) && entry.recKind === 'file' && entry.recSize === 0 &&
    entry.currentKind === 'file' && (entry.currentSize ?? 0) > 0);
  const inScopeFiles = perPath.filter((entry) => entry.recKind === 'file' && (entry.action === 'restored' || entry.action === 'unchanged'));
  const degenerate = inScopeFiles.length >= DEGENERATE_MIN_FILES
    && inScopeFiles.filter((entry) => entry.recSize === 0).length / inScopeFiles.length >= DEGENERATE_EMPTY_RATIO
    && emptyOvers.length > 0;
  const shrinks = perPath.filter((entry) =>
    wouldWrite(entry) && entry.recKind === 'file' && (entry.recSize ?? 0) > 0 &&
    entry.currentKind === 'file' && (entry.currentSize ?? 0) >= SHRINK_MIN_CURRENT_BYTES &&
    entry.recSize < entry.currentSize * SHRINK_RATIO);
  const bytesEmptied = emptyOvers.reduce((total, entry) => total + (entry.currentSize ?? 0), 0);
  const shrinkBytes = shrinks.reduce((total, entry) => total + ((entry.currentSize ?? 0) - (entry.recSize ?? 0)), 0);
  const anomalies = [];
  if (degenerate) {
    anomalies.push({ type: 'degenerate-checkpoint',
      message: `Checkpoint file records are nearly all empty (${inScopeFiles.filter((e) => e.recSize === 0).length}/${inScopeFiles.length}) while current files hold content; it may capture already-damaged state.`,
      paths: emptyOvers.map((entry) => entry.path) });
  }
  if (emptyOvers.length > 0) {
    anomalies.push({ type: 'empty-over-nonempty',
      message: `Restore would turn ${emptyOvers.length} non-empty file(s) into empty files (${bytesEmptied} bytes of current content).`,
      paths: emptyOvers.map((entry) => ({ path: entry.path, currentSize: entry.currentSize })) });
  }
  if (shrinks.length > 0) {
    anomalies.push({ type: 'mass-shrink',
      message: `Restore would shrink ${shrinks.length} file(s) to under ${Math.round(SHRINK_RATIO * 100)}% of current size (${shrinkBytes} bytes).`,
      paths: shrinks.map((entry) => ({ path: entry.path, currentSize: entry.currentSize, restoreSize: entry.recSize })) });
  }
  const massEmpty = emptyOvers.length >= EMPTY_OVER_HARD_COUNT || bytesEmptied >= EMPTY_OVER_HARD_BYTES;
  const massShrink = shrinks.length >= SHRINK_HARD_COUNT || shrinkBytes >= SHRINK_HARD_BYTES;
  const verdict = degenerate || massEmpty ? 'refused'
    : emptyOvers.length > 0 || massShrink ? 'authorization-required'
    : 'safe';
  const warnings = shrinks.length > 0 && !massShrink
    ? [{ type: 'shrink', message: `${shrinks.length} file(s) restore to a much smaller size.`, paths: shrinks.map((entry) => entry.path) }]
    : [];
  return { verdict, anomalies, warnings, filesWouldEmpty: emptyOvers.length, bytesWouldDestroy: bytesEmptied + shrinkBytes, perPath };
}

// Restore a checkpoint: one path, a selected set, or everything. Never
// reports success when paths were skipped. Unless preRestore is false, the
// current state of affected paths is captured first as its own checkpoint,
// so a restore is itself undoable.
//
// Safety gate: a restore the analysis flags as risky is NOT applied unless
// explicitly authorized ({ allowRisky: true }; a refused verdict additionally
// needs { force: true }). The refusal itself writes nothing — not even a
// pre-restore snapshot. Results carry a `safety` report distinguishing safe,
// authorization-required, refused, and failed (thrown) outcomes.
async function restoreCheckpoint(checkpointId, { paths = null, force = false, preRestore = true, uncontained = false, dryRun = false, allowRisky = false } = {}) {
  const checkpoint = getCheckpoint(checkpointId);
  const root = checkpoint.manifest.root;
  if (checkpoint.manifest.uncontained && !(uncontained && force)) {
    throw new Error(
      `Checkpoint #${checkpointId} covers paths outside its workspace; ` +
      'restore requires explicit { uncontained: true, force: true }.',
    );
  }
  const scopeUncontained = checkpoint.manifest.uncontained === true && uncontained && force;
  const wanted = paths === null ? Object.keys(checkpoint.manifest.paths)
    : [...new Set(paths)];
  for (const rel of wanted) {
    if (!Object.hasOwn(checkpoint.manifest.paths, rel)) throw new Error(`Path not in checkpoint #${checkpointId}: ${rel}.`);
  }
  const postState = checkpoint.op?.postState ?? null;
  const safety = await analyzeRestoreSafety(root, checkpoint.manifest, wanted, { force, uncontained: scopeUncontained, postState });
  // A refused verdict (likely captured damage) needs double opt-in; anything
  // else risky needs explicit authorization. Neither writes anything.
  const authorized = allowRisky === true && (safety.verdict === 'authorization-required' || force === true);
  if (!dryRun && safety.verdict !== 'safe' && !authorized) {
    return {
      complete: false, restored: [], removed: [], skipped: [], warnings: safety.warnings,
      preRestoreCheckpointId: null, strategy: safety.verdict === 'refused' ? 'refused' : 'authorization-required',
      dryRun: false, safety, needsAuthorization: true,
    };
  }
  let preRestoreCheckpointId = null;
  if (preRestore && !dryRun) {
    const pre = await captureOperation({
      root, chatSessionId: checkpoint.chat_session_id, toolName: 'restore',
      kind: 'pre-restore', paths: wanted, uncontained: scopeUncontained,
    });
    preRestoreCheckpointId = pre.checkpointId;
  }
  // Move fast path: when the moved tree is untouched since the move, one
  // rename reverses the operation atomically instead of replaying blobs.
  // Skipped for dry runs (which must not mutate) — per-path actions instead.
  const op = checkpoint.manifest.op;
  if (op?.kind === 'move' && paths === null && !force && !dryRun) {
    const fast = await tryMoveBack(root, op, checkpoint.manifest, scopeUncontained);
    if (fast) {
      return {
        complete: fast.skipped.length === 0, restored: fast.restored, removed: fast.removed,
        skipped: fast.skipped, warnings: safety.warnings, preRestoreCheckpointId, strategy: 'move-back',
        safety,
      };
    }
  }
  const restored = [];
  const removed = [];
  const skipped = [];
  const warnings = [...safety.warnings];
  // Restore deeper paths before their parents: removing a created file must
  // precede removing its (then-empty) created directory. Per-path writes are
  // independent (parents are mkdir -p'd as needed), so depth order is safe.
  const ordered = [...wanted].sort((a, b) => b.split('/').length - a.split('/').length);
  trackRestoreStart(checkpointId);
  try {
    for (const rel of ordered) {
      const rec = checkpoint.manifest.paths[rel];
      try {
        const action = await restoreOne(root, rel, rec, { force, uncontained: scopeUncontained, dryRun, post: postState?.[rel] });
        if (action === 'unchanged') restored.push({ path: rel, action });
        else if (action === 'removed') removed.push({ path: rel });
        else if (action === 'restored') restored.push({ path: rel, action });
        else if (action.startsWith('skip:')) skipped.push({ path: rel, reason: action.slice(5) });
      } catch (error) {
        skipped.push({ path: rel, reason: `restore_failed: ${error.message.slice(0, 200)}` });
      }
    }
    // Destination-parent cleanup: remove ancestors the operation created when
    // they are still empty. Non-empty directories hold user content and stay.
    // Dry runs report planned removals without touching anything: empty
    // created parents would go, parents holding content would stay.
    if (dryRun) {
      for (const rel of [...(checkpoint.manifest.parentsCreated ?? [])].reverse()) {
        try {
          const abs = await resolveRestoreTarget(root, rel, { uncontained: scopeUncontained });
          const st = await fs.lstat(abs).catch(() => null);
          if (st && st.isDirectory()) {
            const empty = (await fs.readdir(abs).catch(() => ['?'])).length === 0;
            removed.push({ path: rel, planned: true, wouldRemove: empty });
          }
        } catch {
          /* Unresolvable: nothing to report. */
        }
      }
    } else {
      for (const entry of await cleanupCreatedParents(root, checkpoint.manifest, scopeUncontained)) removed.push(entry);
    }
  } finally {
    trackRestoreEnd(checkpointId);
  }
  // An authorized risky restore overwrites content the gate flagged: pin the
  // pre-restore snapshot so the last-known state survives retention pruning
  // until the user unpins it. Smallest bounded hold: one checkpoint, reversible.
  let undoPinned = false;
  if (!dryRun && safety.verdict !== 'safe' && preRestoreCheckpointId !== null) {
    try {
      await setCheckpointPinned(preRestoreCheckpointId, true);
      undoPinned = true;
    } catch {
      /* Pin failure must not fail an already-applied restore. */
    }
  }
  return {
    complete: skipped.length === 0, restored, removed, skipped, warnings,
    preRestoreCheckpointId, strategy: dryRun ? 'preview' : 'per-path', dryRun: dryRun === true,
    safety, undoPinned,
  };
}

// Remove ancestor directories an operation created, when they are still
// empty. Anything holding content (user files included) is left alone.
async function cleanupCreatedParents(root, manifest, uncontained = false) {
  const removed = [];
  for (const rel of [...(manifest.parentsCreated ?? [])].reverse()) {
    try {
      const abs = await resolveRestoreTarget(root, rel, { uncontained });
      const st = await fs.lstat(abs).catch(() => null);
      if (st && st.isDirectory()) {
        await fs.rmdir(abs);
        removed.push({ path: rel });
      }
    } catch {
      /* Still holds content or is otherwise busy: leave it alone. */
    }
  }
  return removed;
}

// Attempt an atomic rename-back for a captured move. Returns null when the
// tree changed since the move (caller falls back to per-path restore).
async function tryMoveBack(root, op, manifest, uncontained = false) {
  const source = await resolveRestoreTarget(root, op.source, { uncontained }).catch(() => null);
  const dest = await resolveRestoreTarget(root, op.dest, { uncontained }).catch(() => null);
  if (!source || !dest) return null;
  const sourceNow = await currentRecord(source).catch(() => null);
  if (sourceNow && sourceNow.kind !== 'absent') return null;
  // Every captured file under the old source must exist under dest with
  // identical content; otherwise the tree changed and rename-back is unsafe.
  const rels = Object.keys(manifest.paths).filter((rel) =>
    rel === op.source || rel.startsWith(`${op.source}/`));
  if (!rels.length) return null;
  for (const rel of rels) {
    const rec = manifest.paths[rel];
    const counterpart = path.join(op.dest, path.relative(op.source, rel));
    const abs = path.resolve(root, counterpart);
    if (!uncontained && !insideRoot(root, abs)) return null;
    const now = await currentRecord(abs).catch(() => null);
    if (rec.kind === 'file') {
      if (!now || now.kind !== 'file' || now.hash !== rec.hash) return null;
    } else if (rec.kind === 'dir') {
      if (!now || now.kind !== 'dir') return null;
    } else if (rec.kind === 'absent') {
      if (now && now.kind !== 'absent') return null;
    } else {
      return null;
    }
  }
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.rename(dest, source);
  const removed = await cleanupCreatedParents(root, manifest, uncontained);
  return { restored: [{ path: op.source, action: 'moved-back' }], removed, skipped: [] };
}

// Mark-and-sweep: delete blob rows + files referenced by no retained
// checkpoint, plus blob files with no row at all.
//
// The mark phase reads the manifests, exactly as it always has. The blob
// refcount (see src/main/recoveryReferenceIndex.js) is deliberately NOT used
// here: this is the one operation that destroys bytes, and it must not depend
// on an incrementally maintained counter being right. The refcount exists to
// answer the storage panel's questions quickly, and that is all it is trusted
// with.
//
// The scan is chunked and yields to the event loop between chunks, so
// cleaning up a large history stays responsive instead of freezing the app.
async function gcRecoveryBlobs(retainCheckpointIds = null) {
  ensureRecoverySchema();
  const referenced = await collectReferencedHashes(retainCheckpointIds);
  const stale = connection().prepare('SELECT hash FROM recovery_blobs').all()
    .map((row) => row.hash).filter((hash) => !referenced.has(hash));
  let deletedFiles = 0;
  for (const hash of stale) {
    await fs.rm(blobPath(hash), { force: true }).catch(() => {});
    deletedFiles += 1;
  }
  if (stale.length) {
    connection().transaction(() => {
      const del = connection().prepare('DELETE FROM recovery_blobs WHERE hash = ?');
      for (const hash of stale) del.run(hash);
    })();
  }
  const orphans = await gcOrphanBlobFiles();
  return { deletedBlobs: stale.length, orphanFiles: orphans.orphanFiles, kept: orphans.kept };
}

// The hashes referenced by the checkpoints that are being retained.
//
// In-flight restores hold their blobs: their checkpoint is unioned in so
// cleanup can never delete bytes a restore is currently reading.
async function collectReferencedHashes(retainCheckpointIds = null) {
  const ids = retainCheckpointIds === null
    ? connection().prepare('SELECT id FROM recovery_checkpoints').all().map((row) => row.id)
    : [...retainCheckpointIds];
  const referenced = new Set();
  const add = (id) => {
    const row = connection().prepare('SELECT manifest_json FROM recovery_checkpoints WHERE id = ?').get(id);
    if (!row) return;
    for (const hash of checkpointBlobHashes(parseManifest(row.manifest_json))) referenced.add(hash);
  };
  for (const id of activeRestores.keys()) ids.push(id);
  const CHUNK = 20;
  for (let start = 0; start < ids.length; start += CHUNK) {
    for (const id of ids.slice(start, start + CHUNK)) add(id);
    // Yield to the event loop between chunks: a manifest is the whole
    // workspace state of a capture and can be a megabyte of JSON.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return referenced;
}

// Sweep blob files that have no row (orphans from interrupted captures).
async function gcOrphanBlobFiles() {
  let orphanFiles = 0;
  const shardDir = path.join(recoveryBaseDir(), 'blobs');
  const shards = await fs.readdir(shardDir).catch(() => []);
  const known = new Set(connection().prepare('SELECT hash FROM recovery_blobs').all().map((row) => row.hash));
  for (const shard of shards) {
    if (shard.startsWith('.')) continue;
    const files = await fs.readdir(path.join(shardDir, shard)).catch(() => []);
    for (const file of files) {
      if (file.includes('.tmp-')) {
        await fs.rm(path.join(shardDir, shard, file), { force: true }).catch(() => {});
        orphanFiles += 1;
        continue;
      }
      if (!known.has(`${shard}${file}`) && !known.has(file)) {
        await fs.rm(path.join(shardDir, shard, file), { force: true }).catch(() => {});
        orphanFiles += 1;
      }
    }
  }
  return { orphanFiles, kept: known.size };
}

async function countBlobs() {
  ensureRecoverySchema();
  return connection().prepare('SELECT COUNT(*) AS n FROM recovery_blobs').get().n;
}

// Pinning: pinned checkpoints survive retention pruning (never auto-deleted,
// never cap-evicted). Set from the recovery UI; stored on the checkpoint row.
async function setCheckpointPinned(checkpointId, pinned) {
  ensureRecoverySchema();
  const row = connection().prepare('SELECT id FROM recovery_checkpoints WHERE id = ?').get(checkpointId);
  if (!row) throw new Error(`Unknown recovery checkpoint: ${checkpointId}.`);
  connection().prepare('UPDATE recovery_checkpoints SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, checkpointId);
  return { checkpointId, pinned: pinned === true };
}

// Physical vs logical storage accounting. Physical = deduplicated bytes on
// disk; logical = content bytes referenced by checkpoints. Both are exposed so
// the UI can show real disk cost and the amount of history that cost buys.
//
// This runs on the Electron main thread every time the storage panel opens,
// so it must never touch the checkpoint manifests: they hold the full
// workspace state of every capture (632 MB and 2.8M path records on a real
// install), and parsing them froze the app for ~5s per call. The reference
// index answers the same questions in O(blobs).
async function getRecoveryStats() {
  ensureRecoverySchema();
  const { physicalBytes, blobFiles } = await measureBlobStore();
  const totals = connection().prepare(
    `SELECT COUNT(*) AS n,
            SUM(size) AS bytes,
            SUM(CASE WHEN refcount > 0 THEN 1 ELSE 0 END) AS referenced,
            SUM(CASE WHEN refcount > 0 THEN size ELSE 0 END) AS referencedBytes
     FROM recovery_blobs`,
  ).get();
  // Until the reference index is built the refcounts do not say which blobs
  // are still referenced. Fall back to the conservative reading — every known
  // blob is referenced — which is what the panel showed before and never
  // understates the amount of data at risk.
  const ready = referenceIndexReady();
  const referencedBlobs = ready ? (totals.referenced ?? 0) : (totals.n ?? 0);
  const logicalBytes = ready ? (totals.referencedBytes ?? 0) : (totals.bytes ?? 0);
  return {
    physicalBytes,
    logicalBytes,
    blobFiles,
    referencedBlobs,
    checkpointCount: connection().prepare('SELECT COUNT(*) AS n FROM recovery_checkpoints').get().n,
    sessionCount: connection().prepare('SELECT COUNT(*) AS n FROM recovery_sessions').get().n,
  };
}

// Bytes actually held by the blob store. This is the number the storage cap
// is enforced against, so it is measured from disk rather than from the
// database: an orphan file left by an interrupted capture still occupies
// space. The walk is async, so it never blocks the event loop, and the stats
// are read from SQLite concurrently while it runs.
async function measureBlobStore() {
  const shardDir = path.join(recoveryBaseDir(), 'blobs');
  const shards = await fs.readdir(shardDir).catch(() => []);
  const paths = [];
  for (const shard of shards) {
    if (shard.startsWith('.')) continue;
    const files = await fs.readdir(path.join(shardDir, shard)).catch(() => []);
    for (const file of files) {
      if (file.includes('.tmp-')) continue;
      paths.push(path.join(shardDir, shard, file));
    }
  }
  let physicalBytes = 0;
  let blobFiles = 0;
  // Bounded concurrency: one stat per blob file, but not 10k at once.
  const CONCURRENCY = 64;
  let index = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (index < paths.length) {
      const target = paths[index++];
      let size = null;
      try {
        size = (await fs.stat(target)).size;
      } catch {
        /* Raced deletion: skip. */
      }
      // Read-modify-write after the await. Folding the await into the
      // expression would read the accumulator before yielding, so parallel
      // workers would clobber each other's totals.
      if (size === null) continue;
      physicalBytes += size;
      blobFiles += 1;
    }
  }));
  return { physicalBytes, blobFiles };
}

// Retention pruning with explicit guarantees. Keeps, per recovery session:
// pinned checkpoints, everything younger than retentionDays, the latest
// `latestPerSession` checkpoints, and the earliest checkpoint per chat run
// younger than twice the retention window (run-start proxy). Storage-cap
// enforcement then evicts oldest-first among the remainder, but never pinned
// checkpoints, never the latest per session, and never anything from the
// last `recentHours` (active-run proxy). Anything still over cap afterwards
// is reported as capShortfallMB — never silently forced.
async function pruneRecovery({ retentionDays = 30, storageCapMB = 512, latestPerSession = 10, recentHours = 24, now = Date.now() } = {}) {
  ensureRecoverySchema();
  const rows = connection().prepare(
    'SELECT id, session_id, chat_session_id, kind, pinned, created_at FROM recovery_checkpoints ORDER BY id ASC').all();
  // SQLite CURRENT_TIMESTAMP is UTC ("YYYY-MM-DD HH:MM:SS"); parse as such.
  const ageDays = (createdAt) => {
    const ms = Date.parse(`${createdAt} UTC`);
    return Number.isFinite(ms) ? (now - ms) / 86400000 : Infinity;
  };
  const keep = new Set();
  const bySession = new Map();
  for (const row of rows) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }
  for (const [, list] of bySession) {
    for (const row of list) {
      if (row.pinned) keep.add(row.id);
      else if (ageDays(row.created_at) < retentionDays) keep.add(row.id);
    }
    for (const row of list.slice(-Math.max(1, latestPerSession))) keep.add(row.id);
    const earliestByChat = new Map();
    for (const row of list) {
      const key = row.chat_session_id ?? '';
      if (!earliestByChat.has(key)) earliestByChat.set(key, row);
    }
    for (const row of earliestByChat.values()) {
      if (ageDays(row.created_at) < retentionDays * 2) keep.add(row.id);
    }
  }
  // Active restores pin their checkpoints for this run.
  for (const id of activeRestores.keys()) keep.add(id);
  const pruned = rows.filter((row) => !keep.has(row.id)).map((row) => row.id);
  await deleteCheckpoints(pruned);
  // Storage cap: evict oldest-first among non-pinned, non-latest, non-recent.
  const capBytes = storageCapMB * 1024 * 1024;
  const recentCutoff = now - recentHours * 3600000;
  const latestIds = new Set();
  for (const [, list] of bySession) {
    for (const row of list.slice(-5)) latestIds.add(row.id);
  }
  const createdMs = (createdAt) => {
    const ms = Date.parse(`${createdAt} UTC`);
    return Number.isFinite(ms) ? ms : 0;
  };
  let stats = await getRecoveryStats();
  const capEvicted = [];
  if (stats.physicalBytes > capBytes) {
    const candidates = rows
      .filter((row) => keep.has(row.id) && !row.pinned && !latestIds.has(row.id) && createdMs(row.created_at) < recentCutoff)
      .sort((a, b) => a.id - b.id);
    await deleteCheckpoints(candidates.map((row) => row.id));
    for (const row of candidates) {
      keep.delete(row.id);
      capEvicted.push(row.id);
    }
  }
  // Every checkpoint that is not retained has already been deleted, so the
  // checkpoints that are left are exactly the ones to keep.
  const gc = await gcRecoveryBlobs();
  stats = await getRecoveryStats();
  return {
    pruned,
    capEvicted,
    kept: keep.size,
    capShortfallMB: stats.physicalBytes > capBytes
      ? Math.ceil((stats.physicalBytes - capBytes) / 1048576)
      : 0,
    storage: stats,
  };
}

// Delete checkpoints and keep the blob refcounts in step.
//
// The refcount is what the storage panel reports, so it has to follow the
// checkpoints exactly: every removed checkpoint gives back the references it
// held. The decrement is derived from the manifest of the checkpoint being
// removed, which is read before the row is deleted. A prune can remove many
// checkpoints at once, and reading a manifest is milliseconds of work, so the
// reading happens in time-boxed batches that yield to the event loop:
// pruning a large history stays responsive instead of freezing the app.
const DELETE_BATCH_MS = 25;
async function deleteCheckpoints(ids) {
  const list = [...new Set(ids)].filter((id) => Number.isSafeInteger(id));
  if (!list.length) return;
  const del = connection().prepare('DELETE FROM recovery_checkpoints WHERE id = ?');
  const readManifest = connection().prepare('SELECT manifest_json FROM recovery_checkpoints WHERE id = ?');
  const dropIndex = connection().prepare('DELETE FROM recovery_indexed_checkpoints WHERE checkpoint_id = ?');
  let pending = [];
  let batchStarted = Date.now();
  const flush = () => {
    if (!pending.length) return;
    connection().transaction(() => {
      for (const entry of pending) {
        // Only a checkpoint whose references were counted can be decremented.
        // A checkpoint that is not in the index yet contributes nothing to
        // the refcounts, so decrementing for it would under-count a blob that
        // another checkpoint still references.
        if (entry.hashes) applyRefcountDelta(entry.hashes, -1);
        dropIndex.run(entry.id);
        del.run(entry.id);
      }
    })();
    pending = [];
    batchStarted = Date.now();
  };
  for (const id of list) {
    const row = readManifest.get(id);
    // The manifest is read and parsed here, outside the transaction, so the
    // transaction itself stays short and the batch can be time-boxed.
    const hashes = row && isIndexed(id) ? checkpointBlobHashes(parseManifest(row.manifest_json)) : null;
    pending.push({ id, hashes });
    if (Date.now() - batchStarted >= DELETE_BATCH_MS) {
      flush();
      // A timer, not setImmediate: a setImmediate that schedules another
      // setImmediate runs in the same check phase, so the loop never reaches
      // its timer phase and the app's own timers starve for the whole prune.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  flush();
}

// Small bounded line diff for the compare view: common prefix/suffix trim,
// then one hunk (or counts when too large). Text only; callers gate size.
function diffTextLines(oldText, newText, maxLines = 400) {
  const oldLines = String(oldText ?? '').split('\n');
  const newLines = String(newText ?? '').split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  if (!oldMid.length && !newMid.length) return { identical: true, hunks: [], truncated: false };
  if (oldMid.length + newMid.length > maxLines) {
    return {
      identical: false, truncated: true,
      hunks: [{ oldStart: prefix + 1, oldCount: oldMid.length, newStart: prefix + 1, newCount: newMid.length, oldLines: [], newLines: [] }],
    };
  }
  return {
    identical: false,
    truncated: false,
    hunks: [{ oldStart: prefix + 1, oldCount: oldMid.length, newStart: prefix + 1, newCount: newMid.length, oldLines: oldMid, newLines: newMid }],
  };
}

function shortChatId(chatSessionId) {
  return typeof chatSessionId === 'string' && chatSessionId ? chatSessionId.slice(0, 8) : 'unknown run';
}

function summarizeCheckpointRow(row) {
  const op = row.op_json ? JSON.parse(row.op_json) : null;
  const coverage = JSON.parse(row.coverage_json);
  const changed = Array.isArray(op?.changed) ? op.changed : null;
  return {
    id: row.id,
    kind: row.kind,
    tool: row.tool_name,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    originChat: shortChatId(row.chat_session_id),
    mine: false,
    coverageComplete: coverage.complete === true,
    skipped: coverage.skipped ?? [],
    excludedCount: (coverage.excluded ?? []).length,
    emptyFileCount: (coverage.emptyFiles ?? []).length,
    allEmptyFiles: coverage.allEmptyFiles === true,
    changedTotal: changed ? changed.length : null,
    changedKinds: changed
      ? { modified: 0, created: 0, deleted: 0, renamed: 0, other: 0, ...summarizeKinds(changed) }
      : null,
  };
}

function summarizeKinds(changed) {
  const counts = { modified: 0, created: 0, deleted: 0, renamed: 0, other: 0 };
  for (const entry of changed) {
    if (entry.change === 'modified') counts.modified += 1;
    else if (entry.change === 'created') counts.created += 1;
    else if (entry.change === 'deleted') counts.deleted += 1;
    else if (entry.change === 'renamed') counts.renamed += 1;
    else counts.other += 1;
  }
  return counts;
}

// Chat-scoped overview for the sidebar card. `chatSessionId` selects the
// relevant run; checkpoints from other chats in the same workspace are
// counted separately and never presented as this chat's protection.
async function getWorkspaceRecoveryOverview(root, chatSessionId) {
  ensureRecoverySchema();
  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return { state: 'empty', reason: 'no-workspace' };
  const session = connection().prepare('SELECT id FROM recovery_sessions WHERE project_root = ?').get(realRoot);
  if (!session) return { state: 'empty', reason: 'no-history' };
  const rows = connection().prepare('SELECT * FROM recovery_checkpoints WHERE session_id = ? ORDER BY id ASC').all(session.id);
  if (!rows.length) return { state: 'empty', reason: 'no-history' };
  const mine = rows.filter((row) => (row.chat_session_id ?? null) === (chatSessionId ?? null));
  const latest = mine.length ? summarizeCheckpointRow(mine[mine.length - 1]) : null;
  if (!latest) {
    return {
      state: 'empty', reason: 'no-chat-history', checkpointCount: rows.length,
      otherCheckpointCount: rows.length,
      otherChats: new Set(rows.map((row) => shortChatId(row.chat_session_id))).size,
    };
  }
  const earliest = summarizeCheckpointRow(mine[0]);
  // Positive protection only on verified evidence: complete coverage AND all
  // referenced blobs physically present (bounded check, stat only).
  let blobsMissing = 0;
  let blobsChecked = 0;
  try {
    const full = getCheckpoint(latest.id);
    for (const rec of Object.values(full.manifest.paths)) {
      if (blobsChecked >= 50) break;
      if (rec && rec.kind === 'file' && typeof rec.hash === 'string') {
        blobsChecked += 1;
        if (!(await blobExists(rec.hash))) blobsMissing += 1;
      }
    }
  } catch {
    blobsMissing = -1;
  }
  const postOk = (() => {
    try {
      const op = getCheckpoint(latest.id).op;
      return op?.postComplete !== false && op?.postFailed === undefined;
    } catch {
      return false;
    }
  })();
  const state = !latest.coverageComplete || !postOk || blobsMissing !== 0 ? 'partial'
    : latest ? 'protected' : 'empty';
  return {
    state,
    checkpointCount: mine.length,
    otherCheckpointCount: rows.length - mine.length,
    latest,
    runStart: { id: earliest.id, kind: earliest.kind, createdAt: earliest.createdAt },
    blobsChecked,
    blobsMissing,
  };
}

async function getRecoveryHistory(root, chatSessionId, limit = 50) {
  ensureRecoverySchema();
  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return { mine: [], other: [] };
  const session = connection().prepare('SELECT id FROM recovery_sessions WHERE project_root = ?').get(realRoot);
  if (!session) return { mine: [], other: [] };
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = connection().prepare('SELECT * FROM recovery_checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(session.id, safeLimit);
  const mine = [];
  const other = [];
  for (const row of rows) {
    const summary = summarizeCheckpointRow(row);
    summary.mine = (row.chat_session_id ?? null) === (chatSessionId ?? null);
    (summary.mine ? mine : other).push(summary);
  }
  return { mine, other };
}

// Latest checkpoint covering one project-relative path, for single-file
// revert: the renderer restores that path from the returned checkpoint via
// the normal preview/restore path. Scans newest-first with a bounded window;
// returns null when nothing covers the path (caller reports a clear error).
// Lookup only — manifest JSON is parsed, no blob bytes are touched.
const COVER_SCAN_CAP = 200;
async function findLatestCheckpointForPath(root, rel) {
  ensureRecoverySchema();
  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return null;
  const session = connection().prepare('SELECT id FROM recovery_sessions WHERE project_root = ?').get(realRoot);
  if (!session) return null;
  const rows = connection().prepare(
    'SELECT id, kind, created_at, manifest_json FROM recovery_checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT ?',
  ).all(session.id, COVER_SCAN_CAP);
  for (const row of rows) {
    let manifest;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      continue;
    }
    if (manifest && manifest.paths && Object.hasOwn(manifest.paths, rel)) {
      return { checkpointId: row.id, kind: row.kind, createdAt: row.created_at };
    }
  }
  return null;
}

// Ownership gate: a checkpoint restores only inside its own workspace root.
// Renderer-supplied ids can never reach another workspace's files.
function assertCheckpointInRoot(checkpointId, root) {
  const checkpoint = getCheckpoint(checkpointId);
  const manifestRoot = checkpoint.manifest.root;
  const normalized = path.resolve(root);
  if (path.resolve(manifestRoot) !== normalized) {
    throw new Error(`Checkpoint #${checkpointId} belongs to another workspace and cannot be used here.`);
  }
  return checkpoint;
}

const DETAIL_PATH_CAP = 500;
const DIFF_SIZE_CAP = 512 * 1024;
const DIFF_FILES_CAP = 10;

// Checkpoint detail for the modal: per-path current-vs-checkpoint status,
// bounded line diffs for small modified text files, coverage, pin state.
// Metadata only — blob contents never cross IPC except as capped excerpts.
async function getCheckpointDetail(root, checkpointId) {
  const checkpoint = assertCheckpointInRoot(checkpointId, root);
  const manifestPaths = checkpoint.manifest.paths;
  const rels = Object.keys(manifestPaths);
  const detail = {
    id: checkpoint.id, kind: checkpoint.kind, tool: checkpoint.tool_name,
    pinned: checkpoint.pinned === 1, createdAt: checkpoint.created_at,
    originChat: shortChatId(checkpoint.chat_session_id),
    coverage: checkpoint.coverage, op: checkpoint.op,
    totalPaths: rels.length, truncated: rels.length > DETAIL_PATH_CAP,
    paths: [],
  };
  let diffsUsed = 0;
  for (const rel of rels.slice(0, DETAIL_PATH_CAP)) {
    const rec = manifestPaths[rel];
    const entry = { path: rel, recorded: rec.kind };
    try {
      const abs = await resolveRestoreTarget(root, rel, { uncontained: checkpoint.manifest.uncontained === true });
      const current = await currentRecord(abs);
      entry.current = current.kind;
      if (typeof current.size === 'number') entry.currentSize = current.size;
      if (rec.kind === 'file') {
        entry.recordedSize = rec.size ?? null;
        if (current.kind === 'absent') entry.status = 'deleted';
        else if (current.kind === 'file' && current.hash === rec.hash) entry.status = 'unchanged';
        else if (current.kind === 'file') {
          entry.status = 'modified';
          if (diffsUsed < DIFF_FILES_CAP && rec.size <= DIFF_SIZE_CAP && current.size <= DIFF_SIZE_CAP) {
            try {
              const oldBytes = await readBlob(rec.hash);
              const newBytes = await fs.readFile(abs);
              if (!oldBytes.includes(0) && !newBytes.includes(0)) {
                entry.diff = diffTextLines(oldBytes.toString('utf8'), newBytes.toString('utf8'));
                diffsUsed += 1;
              }
            } catch {
              entry.diffUnavailable = true;
            }
          }
        }
        else entry.status = current.kind === 'uncaptured' || current.kind === 'too_large' ? 'unverifiable' : 'conflict';
      } else if (rec.kind === 'absent') {
        entry.status = current.kind === 'absent' ? 'unchanged' : 'created';
      } else if (rec.kind === 'dir') {
        entry.status = current.kind === 'dir' ? 'unchanged' : current.kind === 'absent' ? 'deleted' : 'conflict';
      } else if (rec.kind === 'symlink') {
        entry.status = current.kind === 'symlink' && current.target === rec.target ? 'unchanged' : 'modified';
      } else {
        entry.status = 'unavailable';
        entry.reason = rec.reason ?? 'uncaptured';
      }
    } catch (error) {
      entry.status = 'unverifiable';
      entry.reason = error.message.slice(0, 160);
    }
    detail.paths.push(entry);
  }
  return detail;
}

module.exports = {
  RECOVERY_MAX_FILE_BYTES,
  RECOVERY_MAX_OP_FILES,
  RECOVERY_MAX_OP_BYTES,
  RECOVERY_SCAN_MAX_FILES,
  RECOVERY_SCAN_MAX_BYTES,
  RECOVERY_SCOPE_EXCLUDES,
  RECOVERY_VOLATILE_MS,
  EMPTY_SHA256,
  ScanCapExceeded,
  ensureRecoverySchema,
  getOrCreateRecoverySession,
  captureOperation,
  createManualCheckpoint,
  scanWorkspaceState,
  commitScanResult,
  diffStates,
  finalizeBoundaryCheckpoint,
  loadWorkspaceIndex,
  indexRecordsEqual,
  getCheckpoint,
  listCheckpoints,
  readBlob,
  blobExists,
  restoreCheckpoint,
  gcRecoveryBlobs,
  countBlobs,
  snapshotCurrentState,
  recordOpPostState,
  setCheckpointPinned,
  getRecoveryStats,
  pruneRecovery,
  deleteCheckpoints,
  diffTextLines,
  getWorkspaceRecoveryOverview,
  getRecoveryHistory,
  assertCheckpointInRoot,
  findLatestCheckpointForPath,
  getCheckpointDetail,
};

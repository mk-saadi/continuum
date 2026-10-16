'use strict';

// Workspace recovery IPC service (Phase 3): thin validation + ownership
// gates over recoveryStore. Every entry resolves the chat session to its
// project workspace first; checkpoint ids are then gated to that workspace
// root, so renderer input can never reach another workspace's files or the
// blob store directly. Restore additionally requires a stopped run.

const path = require('node:path');
const recoveryStore = require('./recoveryStore');

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) {
    throw new Error('A chat session is required.');
  }
  return sessionId;
}

function requireCheckpointId(checkpointId) {
  if (!Number.isSafeInteger(checkpointId) || checkpointId < 1) {
    throw new Error('A recovery checkpoint is required.');
  }
  return checkpointId;
}

// Chat session -> authorized workspace root (realpath'd). Casual chats and
// unknown sessions have no workspace: recovery calls report empty/throw
// instead of touching the app directory.
function workspaceRootFor(sessionId) {
  requireSessionId(sessionId);
  const project = require('./toolPermissions').sessionProject(sessionId);
  const raw = project?.root_path ?? project?.rootDirectory ?? null;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Workspace recovery needs a project workspace for this chat.');
  }
  return path.resolve(raw);
}

function overviewEmpty(reason) {
  return { state: 'empty', reason };
}

async function recoveryOverview(sessionId) {
  try {
    var root = workspaceRootFor(sessionId);
  } catch {
    return overviewEmpty('no-workspace');
  }
  return recoveryStore.getWorkspaceRecoveryOverview(root, sessionId);
}

async function recoveryHistory(sessionId, limit) {
  const root = workspaceRootFor(sessionId);
  return recoveryStore.getRecoveryHistory(root, sessionId, limit);
}

async function recoveryDetail(sessionId, checkpointId) {
  const root = workspaceRootFor(sessionId);
  return recoveryStore.getCheckpointDetail(root, requireCheckpointId(checkpointId));
}

function normalizePaths(paths) {
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths) || !paths.length || paths.length > 500) {
    throw new Error('paths must be a non-empty array of at most 500 entries.');
  }
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry || entry.includes('\0')) throw new Error('Invalid restore path.');
  }
  return [...new Set(paths)];
}

async function recoveryPreview(sessionId, checkpointId, { paths = null, force = false } = {}) {
  const root = workspaceRootFor(sessionId);
  const id = requireCheckpointId(checkpointId);
  recoveryStore.assertCheckpointInRoot(id, root);
  return recoveryStore.restoreCheckpoint(id, { paths: normalizePaths(paths), force: force === true, dryRun: true });
}

async function recoveryRestore(sessionId, checkpointId, { paths = null, force = false, allowRisky = false } = {}, isActive = false) {
  const root = workspaceRootFor(sessionId);
  if (isActive) {
    throw new Error('Stop the run before restoring: recovery cannot run while the agent may still change files.');
  }
  const id = requireCheckpointId(checkpointId);
  recoveryStore.assertCheckpointInRoot(id, root);
  return recoveryStore.restoreCheckpoint(id, { paths: normalizePaths(paths), force: force === true, allowRisky: allowRisky === true });
}

async function recoveryPin(sessionId, checkpointId, pinned) {
  const root = workspaceRootFor(sessionId);
  const id = requireCheckpointId(checkpointId);
  // Ownership first: pinning also validates the checkpoint belongs here.
  recoveryStore.assertCheckpointInRoot(id, root);
  return recoveryStore.setCheckpointPinned(id, pinned === true);
}

async function recoveryPin(sessionId, checkpointId, pinned) {
  const root = workspaceRootFor(sessionId);
  const id = requireCheckpointId(checkpointId);
  // Ownership first: pinning also validates the checkpoint belongs here.
  recoveryStore.assertCheckpointInRoot(id, root);
  return recoveryStore.setCheckpointPinned(id, pinned === true);
}

// Diff-review reads (UI-only). Changed-file rows come from git worktree
// status; per-file diffs are capped unified text (or capped worktree content
// for untracked files). All git runs use the shared sandboxed runGit runner,
// so these fail closed on non-repos and non-Linux exactly like the agent git
// tools. No shell interpolation anywhere: argv only, `--` separators, and
// GIT_LITERAL_PATHSPECS from the runner.
const CHANGED_FILES_CAP = 500;
const FILE_DIFF_CHAR_CAP = 20000;
const FILE_DIFF_SIZE_CAP = 512 * 1024;
const UNTRACKED_LINES_BYTE_CAP = 64 * 1024;

function requireRelPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) {
    throw new Error('A project-relative file path is required.');
  }
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Path escapes the project root.');
  }
  return value;
}

// Defense in depth: git-provided paths are still re-contained before any
// worktree read. Returns null on escape (caller skips supplementary data,
// never the row itself).
function containedAbs(root, rel) {
  const abs = path.resolve(root, rel);
  const relative = path.relative(root, abs);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return abs;
}

function truncateDiffText(text) {
  return text.length > FILE_DIFF_CHAR_CAP ? `${text.slice(0, FILE_DIFF_CHAR_CAP)}\n[Output truncated]` : text;
}

async function recoveryChangedFiles(sessionId) {
  const root = workspaceRootFor(sessionId);
  const { runGit } = require('./tools/agentTools');
  const statusOut = await runGit(root, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all']);
  // Unborn HEAD (no commits yet) has no revision to diff against: rows still
  // list, per-file counts fall back below.
  const numstatOut = await runGit(root, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD', '--']).catch((error) => {
    if (/unknown revision|bad revision|ambiguous argument/i.test(error?.message ?? '')) return '';
    throw error;
  });
  let branch = null;
  try {
    branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null;
  } catch {
    branch = null;
  }
  const counts = new Map();
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    counts.set(parts.slice(2).join('\t'), parts[0] === '-' ? { binary: true } : { added: Number(parts[0]) || 0, deleted: Number(parts[1]) || 0 });
  }
  const all = [];
  for (const line of statusOut.split('\n')) {
    if (!line || line.startsWith('!!')) continue;
    if (line.startsWith('??')) {
      all.push({ path: line.slice(3), status: 'untracked', staged: false, unstaged: false, untracked: true });
      continue;
    }
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    let renamedFrom = null;
    const arrow = rest.indexOf(' -> ');
    if (code[0] === 'R' && arrow >= 0) {
      renamedFrom = rest.slice(0, arrow);
      rest = rest.slice(arrow + 4);
    }
    all.push({
      path: rest,
      status: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : renamedFrom ? 'renamed' : 'modified',
      staged: code[0] !== ' ' && code[0] !== '?',
      unstaged: code[1] !== ' ' && code[1] !== '?',
      untracked: false,
      ...(renamedFrom ? { renamedFrom } : {}),
    });
  }
  const truncated = all.length > CHANGED_FILES_CAP;
  const files = all.slice(0, CHANGED_FILES_CAP);
  const fsPromises = require('node:fs/promises');
  for (const entry of files) {
    const hit = counts.get(entry.path);
    if (hit) {
      if (hit.binary) entry.binary = true;
      else {
        entry.added = hit.added;
        entry.deleted = hit.deleted;
      }
      continue;
    }
    // Untracked files have no numstat data: count lines with a small bounded
    // read. Larger files keep bytes only; non-files keep neither.
    if (!entry.untracked) continue;
    const abs = containedAbs(root, entry.path);
    if (!abs) continue;
    try {
      const stat = await fsPromises.lstat(abs);
      if (!stat.isFile()) continue;
      entry.bytes = stat.size;
      if (stat.size > UNTRACKED_LINES_BYTE_CAP) continue;
      const bytes = await fsPromises.readFile(abs);
      if (bytes.includes(0)) entry.binary = true;
      else {
        const text = bytes.toString('utf8');
        entry.added = text.length ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
        entry.deleted = 0;
      }
    } catch {
      /* Counts stay absent; the row still lists. */
    }
  }
  return { branch, files, truncated };
}

async function worktreeContent(root, rel) {
  const fsPromises = require('node:fs/promises');
  const abs = containedAbs(root, rel);
  if (!abs) return { bytes: null, content: null, binary: false };
  try {
    const stat = await fsPromises.lstat(abs);
    if (!stat.isFile()) return { bytes: null, content: null, binary: false };
    if (stat.size > FILE_DIFF_SIZE_CAP) return { bytes: stat.size, content: null, binary: false };
    const raw = await fsPromises.readFile(abs);
    if (raw.includes(0)) return { bytes: stat.size, content: null, binary: true };
    return { bytes: stat.size, content: raw.toString('utf8'), binary: false };
  } catch {
    return { bytes: null, content: null, binary: false };
  }
}

async function recoveryFileDiff(sessionId, relPath) {
  const root = workspaceRootFor(sessionId);
  const rel = requireRelPath(relPath);
  const { runGit } = require('./tools/agentTools');
  const base = ['-c', 'core.quotePath=false'];
  const statusOut = await runGit(root, [...base, 'status', '--porcelain=v1', '--untracked-files=all', '--', rel]);
  const first = statusOut.split('\n').find((line) => line.length > 0);
  if (!first) {
    return { path: rel, untracked: false, binary: false, bytes: null, text: '', truncated: false, clean: true };
  }
  if (first.startsWith('??')) {
    const seen = await worktreeContent(root, rel);
    if (seen.binary) return { path: rel, untracked: true, binary: true, bytes: seen.bytes, text: null, truncated: false };
    if (seen.content === null) return { path: rel, untracked: true, binary: false, bytes: seen.bytes, text: null, truncated: false, unavailable: true };
    const text = truncateDiffText(seen.content);
    return { path: rel, untracked: true, binary: false, bytes: seen.bytes, text, truncated: text !== seen.content };
  }
  const numstat = await runGit(root, [...base, 'diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD', '--', rel]).catch(() => '');
  const numLine = numstat.split('\n').find((line) => line.trim());
  if (numLine && numLine.split('\t')[0] === '-') {
    const abs = containedAbs(root, rel);
    let bytes = null;
    if (abs) {
      try {
        const stat = await require('node:fs/promises').lstat(abs);
        bytes = stat.isFile() ? stat.size : null;
      } catch {
        bytes = null;
      }
    }
    return { path: rel, untracked: false, binary: true, bytes, text: null, truncated: false };
  }
  let raw;
  try {
    raw = await runGit(root, [...base, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', rel]);
  } catch (error) {
    // Unborn HEAD: staged-new files have no revision to diff against, so
    // show worktree content as the addition instead of failing.
    if (!/unknown revision|bad revision|ambiguous argument/i.test(error?.message ?? '')) throw error;
    const seen = await worktreeContent(root, rel);
    if (seen.binary) return { path: rel, untracked: false, binary: true, bytes: seen.bytes, text: null, truncated: false };
    if (seen.content === null) return { path: rel, untracked: false, binary: false, bytes: seen.bytes, text: null, truncated: false, unavailable: true };
    const text = truncateDiffText(seen.content);
    return { path: rel, untracked: false, binary: false, bytes: seen.bytes, text, truncated: text !== seen.content };
  }
  const text = truncateDiffText(raw);
  return { path: rel, untracked: false, binary: false, bytes: null, text, truncated: text !== raw };
}

async function recoveryCoveringCheckpoint(sessionId, relPath) {
  const root = workspaceRootFor(sessionId);
  const rel = requireRelPath(relPath);
  const found = await recoveryStore.findLatestCheckpointForPath(root, rel);
  if (!found) return { checkpointId: null };
  // Ownership re-asserted on the way out: the id below gates the restore.
  recoveryStore.assertCheckpointInRoot(found.checkpointId, root);
  return { checkpointId: found.checkpointId, createdAt: found.createdAt, kind: found.kind };
}

async function recoveryStats() {
  const stats = await recoveryStore.getRecoveryStats();
  const { getAppSettings } = require('./configManager');
  const settings = getAppSettings();
  const capBytes = settings.recoveryStorageCapMB * 1024 * 1024;
  return {
    ...stats,
    capMB: settings.recoveryStorageCapMB,
    retentionDays: settings.recoveryRetentionDays,
    usagePercent: capBytes > 0 ? Math.min(100, (stats.physicalBytes / capBytes) * 100) : 0,
  };
}

async function recoveryPrune() {
  const { getAppSettings } = require('./configManager');
  const settings = getAppSettings();
  return recoveryStore.pruneRecovery({
    retentionDays: settings.recoveryRetentionDays,
    storageCapMB: settings.recoveryStorageCapMB,
  });
}

module.exports = {
  recoveryOverview,
  recoveryHistory,
  recoveryDetail,
  recoveryPreview,
  recoveryRestore,
  recoveryPin,
  recoveryChangedFiles,
  recoveryFileDiff,
  recoveryCoveringCheckpoint,
  recoveryStats,
  recoveryPrune,
};

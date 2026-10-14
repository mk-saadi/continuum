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

async function recoveryRestore(sessionId, checkpointId, { paths = null, force = false } = {}, isActive = false) {
  const root = workspaceRootFor(sessionId);
  if (isActive) {
    throw new Error('Stop the run before restoring: recovery cannot run while the agent may still change files.');
  }
  const id = requireCheckpointId(checkpointId);
  recoveryStore.assertCheckpointInRoot(id, root);
  return recoveryStore.restoreCheckpoint(id, { paths: normalizePaths(paths), force: force === true });
}

async function recoveryPin(sessionId, checkpointId, pinned) {
  const root = workspaceRootFor(sessionId);
  const id = requireCheckpointId(checkpointId);
  // Ownership first: pinning also validates the checkpoint belongs here.
  recoveryStore.assertCheckpointInRoot(id, root);
  return recoveryStore.setCheckpointPinned(id, pinned === true);
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
  recoveryStats,
  recoveryPrune,
};

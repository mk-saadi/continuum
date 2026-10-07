// Shared permission-mode catalog and context rules.
//
// The JSON next to this module is the single source of truth for which
// permission modes exist, how they are labelled, and what the per-context
// defaults are. The renderer imports this module for the permission selector
// and chat defaults; the main process requires the same JSON directly in
// src/main/toolPermissions.js (CommonJS cannot require ESM synchronously).
// tests/permissionSelector.test.mjs asserts both sides stay in agreement, so
// the selector can never advertise a mode the backend would reject or
// silently normalize away.
import spec from './permissionModes.json' with { type: 'json' };

export const PERMISSION_MODES = Object.freeze([...spec.modes]);
export const PERMISSION_MODE_LABELS = Object.freeze({ ...spec.labels });
export const PERMISSION_MODE_DEFAULTS = Object.freeze({ ...spec.defaults });

export function isPermissionMode(mode) {
  return PERMISSION_MODES.includes(mode);
}

/**
 * Whether a project record represents an actual workspace (a connected root
 * directory). Mirrors toolPermissions.projectRoot: a project without a root
 * has nothing to write into, so it behaves like a casual chat for permission
 * purposes.
 */
export function hasWorkspace(project) {
  if (!project || typeof project !== 'object') return false;
  const raw = project.rootDirectory ?? project.root_path ?? project.rootPath;
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * Mirror of toolPermissions.normalizeMode: workspace_write without a
 * workspace runs as ask_approval, so workspace_write is not a valid choice
 * in that context. Every helper below funnels through this one rule, which
 * is what keeps the UI from showing a mode the backend would rewrite.
 */
export function normalizePermissionMode(mode, project) {
  if (mode === 'workspace_write' && !hasWorkspace(project)) return 'ask_approval';
  return mode;
}

/**
 * "What modes are valid for this chat context?" — the exact question the
 * permission selector asks. Casual chats (no workspace root) offer
 * read_only / ask_approval / full_access; workspace chats offer all four.
 */
export function availablePermissionModes(project) {
  return PERMISSION_MODES.filter(mode => normalizePermissionMode(mode, project) === mode);
}

/**
 * The mode a chat in this context starts with when the user never chose one:
 * the project's configured default for project chats, the casual default
 * otherwise, normalized against the workspace so the shown default is always
 * a mode the backend honors as-is.
 */
export function defaultPermissionMode(project) {
  if (!project || typeof project !== 'object') return PERMISSION_MODE_DEFAULTS.casual;
  const stored = [project.permissionMode, project.permission_mode].find(isPermissionMode);
  return normalizePermissionMode(stored ?? PERMISSION_MODE_DEFAULTS.workspace, project);
}

/**
 * Resolve the mode a chat should show, with stored selections taking
 * precedence over context defaults:
 *
 *   stored for this session (or, when reloading the chat the tab is already
 *   showing, the tab's stored mode) -> that mode, context-normalized
 *   no stored mode                  -> the context default
 *
 * This is the single decision point behind chat loading, so opening or
 * reloading a chat never overwrites an intentional user selection.
 */
export function resolveChatPermissionMode({ sessionId, currentSessionId = null, tabMode, sessionMode, project }) {
  const stored = sessionMode
    ?? (sessionId != null && sessionId === currentSessionId ? tabMode : undefined);
  if (isPermissionMode(stored)) return normalizePermissionMode(stored, project);
  return defaultPermissionMode(project);
}

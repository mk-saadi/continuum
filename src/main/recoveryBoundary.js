'use strict';

// Phase 2 recovery boundaries for indirect mutations: shell commands and MCP
// tools can change workspace files without passing the native file-tool
// hooks, so they get a before/after workspace boundary instead of per-path
// interception. Same store, same manifests, same restore API as Phase 1
// (src/main/recoveryStore.js) — no second storage system.
//
// Guarantees (see docs/workspace-recovery-architecture.md §6):
// - Pre-state is committed BEFORE the operation runs; a failed post-scan
//   never invalidates it.
// - Post-scan establishes state-at-scan-time, not final state: detached
//   processes and long-lived MCP servers can write afterwards (documented,
//   tested, detected at the next boundary).
// - Read-only operations never scan: known-read MCP tools skip, native reads
//   are untouched, and MCP calls with no workspace-resident arguments skip.

const fs = require('node:fs');
const path = require('node:path');
const recoveryStore = require('./recoveryStore');

// MCP tool names known to only read (mirrors filesystemToolLimits LIST_TOOLS
// plus the read-text tool). Everything else is judged by name + arguments.
const MCP_READ_TOOLS = new Set(['list_directory', 'list_directory_with_size', 'search_files', 'read_text_file']);
// Mutating verbs: scan even when argument sniffing finds no resident path
// (e.g. a create call whose target does not exist yet).
const MCP_MUTATION_NAME = /(write|edit|delete|create|move|copy|mkdir|remove|trash|append|patch|rename|rmdir|stage|commit|stash)/i;

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stringValues(value, out = [], depth = 0) {
  if (out.length >= 200 || depth > 6) return out;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringValues(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringValues(item, out, depth + 1);
  }
  return out;
}

// Heuristic, safe direction (over-scanning costs time; under-scanning loses
// recovery): a string argument counts as workspace-affecting when it resolves
// inside the workspace AND either exists on disk or looks like a path
// (separator or file extension). URLs, flags, and prose almost never match;
// when they do, the only cost is one extra scan, disclosed in no UI.
function looksLikeWorkspacePath(root, value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 512 || text.includes('\0')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return false;
  if (/^(data|blob|file):/i.test(text)) return false;
  if (text.startsWith('-')) return false;
  let abs;
  try {
    abs = path.resolve(root, text);
  } catch {
    return false;
  }
  if (!insideRoot(root, abs)) return false;
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    /* Absent path: fall through to shape matching (created targets). */
  }
  return text.includes('/') || text.includes('\\') || /\.[a-z0-9]{1,5}$/i.test(text);
}

// Whether an MCP call deserves a recovery boundary. Pure and synchronous
// apart from existence probes; never authorizes anything by itself.
async function shouldScanMcpCall({ toolName, args = {}, root = null } = {}) {
  if (!root || typeof toolName !== 'string') return false;
  if (MCP_READ_TOOLS.has(toolName)) return false;
  if (MCP_MUTATION_NAME.test(toolName)) return true;
  for (const value of stringValues(args)) {
    if (looksLikeWorkspacePath(root, value)) return true;
  }
  return false;
}

// Summarized change list for tool results (full list lives in op_json).
function summarizeChanged(changed, limit = 50) {
  return {
    total: changed.length,
    entries: changed.slice(0, limit).map((entry) => entry.change === 'renamed'
      ? `${entry.path} (renamed from ${entry.from})`
      : `${entry.path} (${entry.change}${entry.captured === false ? ', uncaptured' : ''})`),
  };
}

// Shared boundary: commit pre-state, run the operation, scan afterwards,
// merge the diff into the checkpoint. `mutate` throwing (abort, timeout,
// tool error) still attempts the post-scan — effects may have landed —
// before the error propagates with a recovery note attached.
async function withExternalRecovery({ root, chatSessionId = null, toolName, opKind, opMeta = {} }, mutate) {
  if (!root) return mutate();
  let pre;
  try {
    const scan = await recoveryStore.scanWorkspaceState(root);
    pre = await recoveryStore.commitScanResult({
      root, chatSessionId, toolName, kind: opKind, op: { kind: opKind, ...opMeta }, scan,
    });
  } catch (error) {
    throw new Error(`Recovery capture failed; refusing ${toolName} to protect existing content: ${error.message}`);
  }
  let result;
  let opError = null;
  try {
    result = await mutate();
  } catch (error) {
    opError = error;
  }
  let post = null;
  let postFailed = null;
  try {
    post = await recoveryStore.scanWorkspaceState(root);
  } catch (error) {
    postFailed = error.message;
  }
  if (postFailed) {
    await recoveryStore.finalizeBoundaryCheckpoint(pre.checkpointId, { postFailed });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result = {
        ...result,
        recoveryCheckpointId: pre.checkpointId,
        recoveryComplete: false,
        recoveryPostFailed: true,
      };
    }
  } else {
    const changed = recoveryStore.diffStates(pre.manifest.paths, post.manifest.paths);
    await recoveryStore.finalizeBoundaryCheckpoint(pre.checkpointId, {
      postPaths: post.manifest.paths, postSkipped: post.coverage.skipped, changed, truncated: post.truncated,
    });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const summary = summarizeChanged(changed);
      result = {
        ...result,
        recoveryCheckpointId: pre.checkpointId,
        recoveryChangedTotal: summary.total,
        recoveryChanged: summary.entries,
        recoveryComplete: post.coverage.complete && pre.coverage.complete,
      };
    }
  }
  if (opError) {
    opError.message = `${opError.message} [Recovery checkpoint #${pre.checkpointId} captured pre-operation state.]`;
    throw opError;
  }
  return result;
}

async function withShellRecovery(options, mutate) {
  return withExternalRecovery({ ...options, opKind: 'shell', toolName: options.toolName ?? 'execute_command' }, mutate);
}

async function withMcpRecovery(options, mutate) {
  return withExternalRecovery({ ...options, opKind: 'mcp', toolName: options.toolName ?? 'mcp_tool' }, mutate);
}

module.exports = {
  MCP_READ_TOOLS,
  MCP_MUTATION_NAME,
  shouldScanMcpCall,
  withExternalRecovery,
  withShellRecovery,
  withMcpRecovery,
};

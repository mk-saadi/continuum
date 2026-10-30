'use strict';

// Read-only, bounded serializers for the Workspace Context inspection panel.
// Nothing here mutates history: every query is a SELECT (or a pure function
// of one), archived rows are returned as stored, and unresolvable references
// resolve to an explicit { found: false } instead of invented data.
//
// Bounds keep renderer payloads predictable: checkpoint JSON is already
// capped at CHECKPOINT_BYTE_CAP by validation; archived-message pages are
// paginated; per-step tool output is truncated with an explicit flag (the
// stored record is never altered). Brief text is user-authored and returned
// in full so the panel never silently truncates the underlying record.

const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const briefs = require('./taskBriefs');
const checkpoints = require('./taskCheckpoints');
const { redactSecrets } = require('../lib/secretRedaction.cjs');
const { readExecutionSteps } = require('./executionSteps');

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 25;
const DEFAULT_ARCHIVED_LIMIT = 20;
const MAX_ARCHIVED_LIMIT = 100;
const MAX_STEP_RESULT_CHARS = 2000;
const MAX_SNIPPET_CHARS = 300;
const MAX_ARG_SUMMARY_CHARS = 500;

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) {
    throw new TypeError('sessionId must be a non-empty string without null characters.');
  }
}

function findSessionForDisplay(sessionId) {
  requireSessionId(sessionId);
  const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!row || db.prepare('SELECT id FROM deleted_sessions WHERE id=?').get(sessionId)) return null;
  return row;
}

function clampPage(value, def, max) {
  if (value === undefined || value === null) return def;
  if (!Number.isSafeInteger(value)) throw new TypeError('Pagination values must be safe integers.');
  if (value < 0) throw new RangeError('Pagination values must be non-negative.');
  return Math.min(value === 0 ? def : value, max);
}

function truncateFlagged(text, limit) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function fileAvailable(filePath) {
  try {
    return typeof filePath === 'string' && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

// --- Checkpoints ---

function collectCheckpointSources(checkpoint) {
  const refs = new Map();
  if (!checkpoint || typeof checkpoint !== 'object') return [];
  const take = (messageId, stepId) => {
    if (!Number.isSafeInteger(messageId)) return;
    const key = `${messageId}:${stepId ?? ''}`;
    if (!refs.has(key)) refs.set(key, { messageId, stepId: stepId ?? null });
  };
  for (const item of checkpoint.completedWork ?? []) {
    if (item && typeof item === 'object') for (const source of item.sources ?? []) take(source?.messageId, source?.stepId);
  }
  for (const item of [...(checkpoint.decisions ?? []), ...(checkpoint.filesChanged ?? []), ...(checkpoint.commands ?? []), ...(checkpoint.tests ?? [])]) {
    if (!item || typeof item !== 'object') continue;
    for (const source of item.sources ?? []) take(source?.messageId, source?.stepId);
    if (item.stepRef && typeof item.stepRef === 'object') take(item.stepRef.messageId, item.stepRef.stepId);
  }
  for (const item of checkpoint.inProgress ?? []) {
    if (item?.stepRef && typeof item.stepRef === 'object') take(item.stepRef.messageId, item.stepRef.stepId);
  }
  return [...refs.values()];
}

// Resolve evidence references against persisted records. Unresolvable
// references (deleted messages, missing steps) resolve to { found: false }
// so the panel can say so instead of guessing.
function resolveEvidence(sessionId, checkpoint) {
  const evidence = {};
  const refs = collectCheckpointSources(checkpoint);
  if (!refs.length) return evidence;
  const selectMessage = db.prepare('SELECT id, role, content, execution_steps FROM messages WHERE id = ? AND session_id = ?');
  for (const { messageId, stepId } of refs) {
    const key = `${messageId}:${stepId ?? ''}`;
    const row = selectMessage.get(messageId, sessionId);
    if (!row) {
      evidence[key] = { found: false };
      continue;
    }
    if (stepId == null) {
      evidence[key] = {
        found: true,
        role: row.role,
        snippet: typeof row.content === 'string' ? redactSecrets(row.content).slice(0, MAX_SNIPPET_CHARS) : '',
      };
      continue;
    }
    let steps = [];
    try {
      steps = readExecutionSteps(row) || [];
    } catch {
      steps = [];
    }
    const step = steps.find(candidate => candidate && candidate.id === stepId);
    if (!step || step.type !== 'tool_call') {
      evidence[key] = { found: false };
      continue;
    }
    const outcome = checkpoints.classifyStepOutcome(step);
    let detail = '';
    if (typeof step.error === 'string' && step.error) detail = step.error;
    else if (step.result !== undefined) {
      try {
        detail = typeof step.result === 'string' ? step.result : JSON.stringify(step.result);
      } catch {
        detail = '';
      }
    }
    evidence[key] = {
      found: true,
      role: row.role,
      toolName: step.toolName || 'Tool',
      status: outcome,
      snippet: redactSecrets(detail || '').slice(0, MAX_SNIPPET_CHARS),
    };
  }
  return evidence;
}

function redactCheckpointValue(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactCheckpointValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCheckpointValue(item)]));
  return value;
}

function serializeCheckpointRow(sessionId, row) {
  const { stale, reasons } = checkpoints.isCheckpointStale(sessionId, row);
  return {
    id: row.id,
    status: row.status,
    model_id: row.model_id ?? null,
    created_at: row.created_at ?? null,
    stale,
    staleReasons: reasons,
    checkpoint: redactCheckpointValue(row.checkpoint),
    workingState: row.checkpoint?.lifecycle === 'w3-current' ? (() => {
      const content = checkpoints.workspaceCompactSection(row.checkpoint).content;
      const displayed = redactSecrets(content);
      return { content: displayed, redacted: displayed !== content,
        format: row.checkpoint.summaryFormat ?? 'legacy-structured', summaryMeasurement: row.checkpoint.summaryMeasurement ?? null,
        representation: row.checkpoint.savedWorkingState ? 'exact-persisted-continuation' : 'reconstructed-legacy-continuation',
        consumedToolCount: row.checkpoint.projection?.consumedToolIds?.length ?? 0,
        durableEvidenceCount: row.checkpoint.evidence?.length ?? 0 };
    })() : null,
    summary: { id: row.summary_id ?? null, text: row.summary_text ?? '' },
    archivedCount: (() => {
      try {
        return JSON.parse(row.archived_ids_json || '[]').filter(id => Number.isSafeInteger(id)).length;
      } catch {
        return 0;
      }
    })(),
  };
}

function getCheckpointForDisplay(sessionId) {
  if (!findSessionForDisplay(sessionId)) return { checkpoint: null };
  const row = checkpoints.getLatestCheckpoint(sessionId);
  if (!row) return { checkpoint: null };
  const serialized = serializeCheckpointRow(sessionId, row);
  return { checkpoint: serialized, evidence: resolveEvidence(sessionId, row.checkpoint) };
}

function getCheckpointHistoryForDisplay(sessionId, limit, checkpointId) {
  const session = findSessionForDisplay(sessionId);
  const safeLimit = clampPage(limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  if (!session) return { checkpoints: [], limit: safeLimit };
  const rows = checkpoints.getCheckpointHistory(sessionId, safeLimit);
  if (Number.isSafeInteger(checkpointId) && !rows.some(row => row.id === checkpointId)) {
    const row = db.prepare('SELECT * FROM workspace_checkpoints WHERE session_id=? AND id=?').get(sessionId, checkpointId);
    if (row) { try { rows.push({ ...row, checkpoint: JSON.parse(row.checkpoint_json) }); } catch {} }
  }
  return {
    checkpoints: rows.map(row => {
      const serialized = serializeCheckpointRow(sessionId, row);
      return { ...serialized, evidence: resolveEvidence(sessionId, row.checkpoint) };
    }),
    limit: safeLimit,
  };
}

// --- Task briefs ---

function serializeBrief(brief, applicable) {
  return {
    id: brief.id,
    kind: brief.kind,
    content_text: brief.content_text,
    message_id: brief.message_id ?? null,
    supersedes_id: brief.supersedes_id ?? null,
    created_at: brief.created_at ?? null,
    applicable,
    attachments: (brief.attachments ?? []).map(attachment => ({
      file_name: attachment.file_name ?? null,
      mime_type: attachment.mime_type ?? null,
      size: typeof attachment.size === 'number' ? attachment.size : null,
      available: fileAvailable(attachment.file_path),
    })),
  };
}

// --- Turn work logs (per-brief attachment) ---

// Bounds for work-log display: file-existence probes share one budget per
// panel load so pathological histories cannot stall inspection.
const MAX_WORKLOG_STAT_CALLS = 100;
const MAX_CHIP_PATHS = 6;

function workspaceRootForDisplay(sessionId) {
  try {
    const project = require('./toolPermissions').sessionProject(sessionId);
    const raw = project?.root_path ?? project?.rootDirectory ?? null;
    return typeof raw === 'string' && raw.trim() ? path.resolve(raw) : null;
  } catch {
    return null;
  }
}

function digestCreatedMs(createdAt) {
  if (typeof createdAt !== 'string' || !createdAt) return null;
  const ms = Date.parse(`${createdAt.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Paths changed since the recorded work, one turn at a time. A path counts
// only when the file exists now AND its mtime is safely past the digest's
// own second: same-second writes (including the turn's own edits, which
// always precede recording) can never mark, and missing files, directories,
// unresolvable paths, or an unreadable baseline omit the marker rather than
// guessing. mtime cannot distinguish "touched with identical content" (e.g.
// a later checkout), which callers document on the marker instead of hiding.
function stalePathsForTurn(root, digestRow, budget) {
  const stale = [];
  if (!root || !digestRow || !digestRow.digest || budget.remaining <= 0) return stale;
  const baseline = digestCreatedMs(digestRow.created_at);
  if (baseline === null) return stale;
  const seen = new Set();
  const entries = Array.isArray(digestRow.digest.entries) ? digestRow.digest.entries : [];
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.paths)) continue;
    for (const rel of entry.paths) {
      if (typeof rel !== 'string' || !rel || rel.includes('\0') || seen.has(rel)) continue;
      seen.add(rel);
      if (budget.remaining <= 0) return stale;
      if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((part) => part === '..' || part === '.')) continue;
      const abs = path.resolve(root, rel);
      const relative = path.relative(root, abs);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      budget.remaining -= 1;
      let stat = null;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) continue;
      if (stat.mtimeMs > baseline + 1000) stale.push(rel);
    }
  }
  return stale;
}

function serializeDigestIssue(issue) {
  if (!issue || typeof issue !== 'object') return null;
  return {
    id: typeof issue.id === 'string' ? issue.id : null,
    kind: typeof issue.kind === 'string' ? issue.kind : null,
    sig: typeof issue.sig === 'string' ? issue.sig : '',
    excerpt: typeof issue.excerpt === 'string' ? issue.excerpt : '',
    exitCode: Number.isSafeInteger(issue.exitCode) ? issue.exitCode : null,
  };
}

function serializeDigestTurn(digestRow, stalePaths) {
  const digest = digestRow.digest;
  const ledgerIssues = digest && typeof digest === 'object' && Array.isArray(digest.ledger?.issues)
    ? digest.ledger.issues
    : [];
  const turnSeq = Number.isSafeInteger(digest?.turnSeq) ? digest.turnSeq : null;
  return {
    turnSeq,
    partial: digest?.partial === true,
    createdAt: typeof digestRow.created_at === 'string' ? digestRow.created_at : null,
    briefId: digestRow.brief_id ?? null,
    entries: (Array.isArray(digest?.entries) ? digest.entries : []).map((entry) => ({
      kind: entry?.kind ?? null,
      tool: entry?.tool ?? null,
      status: entry?.status ?? null,
      paths: Array.isArray(entry?.paths) ? entry.paths.filter((part) => typeof part === 'string') : [],
      summary: typeof entry?.summary === 'string' ? entry.summary : '',
      exitCode: Number.isSafeInteger(entry?.exitCode) ? entry.exitCode : null,
      hash: typeof entry?.hash === 'string' ? entry.hash : null,
      linesAdded: Number.isSafeInteger(entry?.linesAdded) ? entry.linesAdded : null,
      linesRemoved: Number.isSafeInteger(entry?.linesRemoved) ? entry.linesRemoved : null,
    })),
    openIssues: (Array.isArray(digest?.openIssues) ? digest.openIssues : [])
      .map(serializeDigestIssue)
      .filter(Boolean),
    resolvedIssues: ledgerIssues
      .filter((issue) => issue && issue.status === 'resolved' && issue.resolvedTurn === turnSeq)
      .map(serializeDigestIssue)
      .filter(Boolean),
    omitted: {
      entries: digest?.omitted && Number.isSafeInteger(digest.omitted.entries) ? digest.omitted.entries : 0,
      issues: digest?.omitted && Number.isSafeInteger(digest.omitted.issues) ? digest.omitted.issues : 0,
    },
    stalePaths,
  };
}

function workLogChips(turns) {
  const edited = [];
  const read = [];
  const seenEdited = new Set();
  const seenRead = new Set();
  let editedMore = 0;
  let readMore = 0;
  for (const turn of turns) {
    for (const entry of turn.entries) {
      const target =
        entry.kind === 'edit' && entry.status === 'complete'
          ? { list: edited, seen: seenEdited, overflow: (value) => { editedMore += value; } }
          : entry.kind === 'read'
            ? { list: read, seen: seenRead, overflow: (value) => { readMore += value; } }
            : null;
      if (!target) continue;
      for (const filePath of entry.paths) {
        if (target.seen.has(filePath)) continue;
        target.seen.add(filePath);
        if (target.list.length < MAX_CHIP_PATHS) target.list.push(filePath);
        else target.overflow(1);
      }
    }
  }
  const openIds = new Set();
  const resolvedIds = new Set();
  for (const turn of turns) {
    for (const issue of turn.openIssues) if (issue.id) openIds.add(issue.id);
    for (const issue of turn.resolvedIssues) if (issue.id) resolvedIds.add(issue.id);
  }
  for (const id of resolvedIds) openIds.delete(id);
  return { turns: turns.length, edited, editedMore, read, readMore, openIssues: openIds.size };
}

function serializeBriefWorkLog(root, digestRows, budget) {
  const ordered = [...digestRows].sort((a, b) => {
    const turnA = Number.isSafeInteger(a.digest?.turnSeq) ? a.digest.turnSeq : 0;
    const turnB = Number.isSafeInteger(b.digest?.turnSeq) ? b.digest.turnSeq : 0;
    return turnA - turnB || a.id - b.id;
  });
  const turns = ordered.map((row) => serializeDigestTurn(row, stalePathsForTurn(root, row, budget)));
  return { turns, chips: workLogChips(turns) };
}

function getBriefsForDisplay(sessionId) {
  if (!findSessionForDisplay(sessionId)) return { applicable: [], others: [] };
  const all = briefs.getAllBriefs(sessionId);
  const applicableIds = new Set(briefs.getApplicableBriefs(sessionId).map(item => item.id));
  const applicable = [];
  const others = [];
  for (const brief of all) {
    const serialized = serializeBrief(brief, applicableIds.has(brief.id));
    if (applicableIds.has(brief.id)) applicable.push(serialized);
    else others.push(serialized);
  }
  // Per-brief work logs (turn digests). Best-effort: a lookup failure must
  // never break the brief payload itself.
  let grouped = null;
  try {
    grouped = require('./workLog').getWorkLogsByBrief(sessionId);
  } catch {
    grouped = null;
  }
  const root = workspaceRootForDisplay(sessionId);
  const budget = { remaining: MAX_WORKLOG_STAT_CALLS };
  for (const serialized of [...applicable, ...others]) {
    const rows = grouped?.byBriefId.get(serialized.id) ?? [];
    serialized.workLog = rows.length ? serializeBriefWorkLog(root, rows, budget) : null;
  }
  const unassignedRows = grouped?.unassigned ?? [];
  const outcome = { applicable, others };
  if (unassignedRows.length) {
    outcome.unassignedWorkLog = serializeBriefWorkLog(root, unassignedRows, budget);
  }
  return outcome;
}

// --- Rolling summary ---

function getSummaryForDisplay(sessionId) {
  if (!findSessionForDisplay(sessionId)) return { text: null };
  const text = require('./sessionManager').getSessionSummary(sessionId);
  return { text: text ?? null };
}

// --- Archived conversation history ---

function summarizeStepArgs(step) {
  if (!step || step.type !== 'tool_call') return null;
  const args = step.args;
  if (!args || typeof args !== 'object') {
    return typeof step.streamingArguments === 'string' && step.streamingArguments
      ? step.streamingArguments.slice(0, MAX_ARG_SUMMARY_CHARS)
      : null;
  }
  const parts = [];
  if (typeof args.command === 'string') parts.push(args.command);
  for (const key of ['relative_path', 'path', 'file_path', 'url', 'query', 'task']) {
    if (typeof args[key] === 'string' && args[key]) parts.push(args[key]);
  }
  if (!parts.length) return null;
  const joined = parts.join(' · ');
  return joined.length > MAX_ARG_SUMMARY_CHARS ? joined.slice(0, MAX_ARG_SUMMARY_CHARS) : joined;
}

function serializeExecutionStep(step) {
  if (!step || typeof step !== 'object') return null;
  if (step.type === 'thought') {
    const content = truncateFlagged(typeof step.content === 'string' ? step.content : '', MAX_STEP_RESULT_CHARS);
    return { id: step.id ?? null, type: 'thought', content: content.text, truncated: content.truncated };
  }
  if (step.type !== 'tool_call') return null;
  const entry = {
    id: step.id ?? null,
    type: 'tool_call',
    toolName: typeof step.toolName === 'string' ? step.toolName : 'Tool',
    status: typeof step.status === 'string' ? step.status : 'unknown',
    argsSummary: summarizeStepArgs(step),
    error: typeof step.error === 'string' && step.error ? step.error.slice(0, MAX_STEP_RESULT_CHARS) : null,
    result: null,
    resultTruncated: false,
  };
  if (step.result !== undefined) {
    const rendered = typeof step.result === 'string' ? step.result : (() => {
      try {
        return JSON.stringify(step.result);
      } catch {
        return '';
      }
    })();
    const bounded = truncateFlagged(rendered, MAX_STEP_RESULT_CHARS);
    entry.result = bounded.text;
    entry.resultTruncated = bounded.truncated;
  }
  return entry;
}

function getArchivedMessagesForDisplay(sessionId, { limit, offset } = {}) {
  const session = findSessionForDisplay(sessionId);
  const safeLimit = clampPage(limit, DEFAULT_ARCHIVED_LIMIT, MAX_ARCHIVED_LIMIT);
  const safeOffset = offset === undefined || offset === null ? 0 : clampPage(offset, 0, Number.MAX_SAFE_INTEGER);
  // Draft tabs have an ID before persistence; deletion can also race a read.
  // Inspection must not create a session just to display empty context.
  if (!session) return { messages: [], total: 0, limit: safeLimit, offset: safeOffset };
  // Branch-aware: only archived rows on the session's active path, oldest
  // first — the same history compression reasoned about.
  let pathIds;
  try {
    pathIds = briefs.activeMessageIds(sessionId);
  } catch {
    return { messages: [], total: 0, limit: safeLimit, offset: safeOffset };
  }
  const archived = db.prepare(`SELECT id, role, content, created_at, archived, is_summarized, estimated_tokens
    FROM messages WHERE session_id = ? AND archived = 1 ORDER BY id ASC`).all(sessionId)
    .filter(row => pathIds.has(row.id));
  const total = archived.length;
  const page = archived.slice(safeOffset, safeOffset + safeLimit);
  const selectAttachments = db.prepare('SELECT file_path, mime_type FROM message_attachments WHERE message_id = ? ORDER BY id');
  const selectSteps = db.prepare('SELECT execution_steps FROM messages WHERE id = ? AND session_id = ?');
  const messages = page.map(row => {
    let steps = [];
    try {
      const raw = selectSteps.get(row.id, sessionId)?.execution_steps;
      steps = raw == null ? [] : (readExecutionSteps({ execution_steps: raw }) || []);
    } catch {
      steps = [];
    }
    return {
      id: row.id,
      role: row.role,
      content: typeof row.content === 'string' ? row.content : '',
      created_at: row.created_at ?? null,
      archived: row.archived,
      is_summarized: row.is_summarized,
      estimated_tokens: row.estimated_tokens,
      attachments: selectAttachments.all(row.id).map(attachment => ({
        file_name: (() => {
          try {
            return require('node:path').basename(attachment.file_path);
          } catch {
            return null;
          }
        })(),
        mime_type: attachment.mime_type ?? null,
        available: fileAvailable(attachment.file_path),
      })),
      executionSteps: steps.map(serializeExecutionStep).filter(Boolean),
    };
  });
  return { messages, total, limit: safeLimit, offset: safeOffset };
}

module.exports = {
  MAX_HISTORY_LIMIT,
  MAX_ARCHIVED_LIMIT,
  MAX_STEP_RESULT_CHARS,
  getCheckpointForDisplay,
  getCheckpointHistoryForDisplay,
  getBriefsForDisplay,
  getSummaryForDisplay,
  getArchivedMessagesForDisplay,
};

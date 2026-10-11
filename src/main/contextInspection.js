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
const { db } = require('./db');
const briefs = require('./taskBriefs');
const checkpoints = require('./taskCheckpoints');
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

function requireExistingSession(sessionId) {
  requireSessionId(sessionId);
  const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!row) throw new Error('Session not found.');
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
        snippet: typeof row.content === 'string' ? row.content.slice(0, MAX_SNIPPET_CHARS) : '',
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
      snippet: (detail || '').slice(0, MAX_SNIPPET_CHARS),
    };
  }
  return evidence;
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
    checkpoint: row.checkpoint,
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
  requireExistingSession(sessionId);
  const row = checkpoints.getLatestCheckpoint(sessionId);
  if (!row) return { checkpoint: null };
  const serialized = serializeCheckpointRow(sessionId, row);
  return { checkpoint: serialized, evidence: resolveEvidence(sessionId, row.checkpoint) };
}

function getCheckpointHistoryForDisplay(sessionId, limit) {
  requireExistingSession(sessionId);
  const safeLimit = clampPage(limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  const rows = checkpoints.getCheckpointHistory(sessionId, safeLimit);
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

function getBriefsForDisplay(sessionId) {
  requireExistingSession(sessionId);
  const all = briefs.getAllBriefs(sessionId);
  const applicableIds = new Set(briefs.getApplicableBriefs(sessionId).map(item => item.id));
  const applicable = [];
  const others = [];
  for (const brief of all) {
    const serialized = serializeBrief(brief, applicableIds.has(brief.id));
    if (applicableIds.has(brief.id)) applicable.push(serialized);
    else others.push(serialized);
  }
  return { applicable, others };
}

// --- Rolling summary ---

function getSummaryForDisplay(sessionId) {
  requireExistingSession(sessionId);
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
  requireExistingSession(sessionId);
  const safeLimit = clampPage(limit, DEFAULT_ARCHIVED_LIMIT, MAX_ARCHIVED_LIMIT);
  const safeOffset = offset === undefined || offset === null ? 0 : clampPage(offset, 0, Number.MAX_SAFE_INTEGER);
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

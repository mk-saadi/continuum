'use strict';
// Content-free activity projection. Never owns checkpoint activation or execution.
const { randomUUID } = require('node:crypto');
const { db } = require('./db');
const terminal = new Set(['completed', 'deferred', 'failed', 'cancelled', 'continued']);
const statuses = new Set(['started', 'generating', 'validating', 'checking-fit', 'committing', ...terminal]);
const pending = new Map();
const fields = ['beforeTokens', 'afterTokens', 'usableInputTokens', 'triggerTokens', 'measurementMethod', 'afterMeasurementMethod', 'generationStages', 'checkpointId', 'continued', 'sourceVersion', 'targetTokens', 'targetMet', 'targetReason', 'percentageSaved', 'tokensSaved', 'tokensUntilNextTrigger', 'workingCheckpointTokens', 'protectedContextTokens', 'irreducibleContextTokens', 'durationMs'];
const safeCodes = new Set(['output-budget-exceeded', 'optional-fallback-measurement-unavailable', 'owning-request-required', 'user-cancelled', 'unexpected-abort', 'renderer-destroyed', 'ipc-disposed', 'generation-inactivity-timeout', 'archive-conflict', 'budget-exceeded', 'cancelled-run', 'candidate-busy', 'capacity-changed', 'compaction-busy', 'compaction-disabled-context-overflow', 'compaction-error', 'concurrent-state-change', 'context-overflow', 'deleted-conversation', 'empty-response', 'generation-stage-budget', 'generation-time-budget', 'generation-token-budget', 'incomplete-response', 'incomplete-tool-pair', 'intermediate-size-budget', 'interrupted-before-verified-commit', 'interrupted-commit-unverified', 'invalid-background-state', 'invalid-json', 'invalid-reference', 'invalid-safe-point', 'invalid-source-evidence', 'irreducible-context-overflow', 'missing-required-data', 'missing-task-brief', 'missing-task-brief-reference', 'model-unavailable', 'no-meaningful-reduction', 'no-reducible-history', 'not-safe-to-compact-yet', 'operation-state-changed', 'output-truncated', 'pending-background-operation', 'pending-child-operation', 'pending-tool-operation', 'post-commit-mismatch', 'prospective-context-overflow', 'provider-error', 'runtime-state-changed', 'schema-invalid', 'sensitive-candidate-data', 'stale-candidate', 'stale-task-brief', 'tool-round-not-durable', 'unfinished-assistant', 'unknown-cloud-capacity', 'unsupported-completion-claim', 'unsupported-file-claim', 'workspace-only']);
function safeCode(code) { return safeCodes.has(code) ? code : 'compaction-error'; }
function install(connection) {
  connection.exec(`CREATE TABLE IF NOT EXISTS workspace_compaction_activity (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id TEXT, message_id INTEGER, anchor_step_id TEXT,
    status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, code TEXT,
    metadata TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS idx_compaction_activity_session ON workspace_compaction_activity(session_id, sequence);
    CREATE TRIGGER IF NOT EXISTS compaction_activity_deleted BEFORE INSERT ON workspace_compaction_activity
    WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE id = NEW.session_id)
    BEGIN SELECT RAISE(ABORT, 'Conversation was permanently deleted.'); END;`);
  // A current checkpoint proves activation, not post-commit verification. Never
  // infer success from it after a crash. Preserve state and label uncertainty.
  for (const row of connection.prepare("SELECT * FROM workspace_compaction_activity WHERE status NOT IN ('completed','deferred','failed','cancelled','continued')").all()) {
    const checkpoints = connection.prepare('SELECT id, checkpoint_json FROM workspace_checkpoints WHERE session_id = ?').all(row.session_id);
    const metadata = JSON.parse(row.metadata);
    const activated = checkpoints.some(c => {
      try {
        const projection = JSON.parse(c.checkpoint_json).projection;
        return metadata.checkpointId === c.id || (metadata.sourceVersion && projection?.sourceVersion === metadata.sourceVersion && projection?.runId === row.run_id);
      } catch { return false; }
    });
    connection.prepare("UPDATE workspace_compaction_activity SET status='cancelled', code=?, revision=revision+1, updated_at=? WHERE id=?")
      .run(activated ? 'interrupted-commit-unverified' : 'interrupted-before-verified-commit', new Date().toISOString(), row.id);
  }
}
function decode(row) { return row ? { ...row, metadata: JSON.parse(row.metadata) } : null; }
function list(sessionId) {
  for (const [id, retry] of [...pending]) if (retry.sessionId === sessionId) retry.flush();
  return db.prepare('SELECT * FROM workspace_compaction_activity WHERE session_id = ? ORDER BY sequence').all(sessionId).map(decode);
}
function create({ sessionId, runId, messageId, anchorStepId, broadcast = () => {} }) {
  const id = randomUUID();
  let durable = false;
  const publish = record => { try { broadcast(record); } catch { /* Durable polling repairs missed IPC. */ } };
  const update = (status, values = {}) => {
    if (!statuses.has(status)) return;
    values = { ...pending.get(id)?.values, ...values };
    try {
      const record = db.transaction(() => {
        const row = db.prepare('SELECT * FROM workspace_compaction_activity WHERE id=?').get(id);
        if (!row) return null; // Deleted owners are never recreated.
        if (terminal.has(row.status) && !(['completed', 'continued'].includes(row.status) && status === row.status && values.continued === true)) return null;
        const metadata = JSON.parse(row.metadata);
        for (const key of fields) if (values[key] !== undefined) metadata[key] = values[key];
        const code = values.code ? safeCode(values.code) : row.code;
        if (status === row.status && JSON.stringify(metadata) === row.metadata && code === row.code) return null;
        db.prepare('UPDATE workspace_compaction_activity SET status=?, revision=revision+1, updated_at=?, code=?, metadata=? WHERE id=?')
          .run(status, new Date().toISOString(), code, JSON.stringify(metadata), id);
        return decode(db.prepare('SELECT * FROM workspace_compaction_activity WHERE id=?').get(id));
      })();
      pending.delete(id);
      if (record) publish(record);
    } catch {
      // Retry known terminal facts on the next read; never block activation.
      if (terminal.has(status)) pending.set(id, { sessionId, values, flush: () => update(status, values) });
    }
  };
  try {
    const now = new Date().toISOString();
    durable = db.prepare(`INSERT INTO workspace_compaction_activity(id,session_id,run_id,message_id,anchor_step_id,status,started_at,updated_at)
      SELECT ?,?,?,?,?, 'started',?,? FROM sessions WHERE id=? AND project_id IS NOT NULL`)
      .run(id, sessionId, runId ?? null, messageId ?? null, anchorStepId ?? null, now, now, sessionId).changes === 1;
    if (durable) publish(decode(db.prepare('SELECT * FROM workspace_compaction_activity WHERE id=?').get(id)));
  } catch { /* No volatile success if the durable start cannot be recorded. */ }
  return { id, update: durable ? update : () => {} };
}
module.exports = { install, create, list, safeCode };

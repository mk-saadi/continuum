'use strict';

// Phase 2.1 — run-scoped live steering queue.
//
// A steering instruction belongs to exactly one executing main-agent run. The
// run is identified by a main-process-generated run id, never by a renderer
// supplied text. The queue is deliberately small and synchronous: this module
// owns only persistence and lifecycle transitions, not execution. The chat
// loop (src/lib/memoryChat.mjs) calls take() at a model-request boundary and
// records the outcome after the request has actually been dispatched.
//
// States:
//   queued      persisted, waiting for a safe checkpoint
//   claimed     selected for the next request; delivery not yet confirmed
//   delivered   included in a model request that the transport accepted
//   undelivered the run ended (or failed) before delivery could be confirmed
//   cancelled   explicitly withdrawn by the user before delivery
//
// `claimed` is an additive state required by the crash-consistency rule: a
// request may be in flight when the process dies. Marking it `delivered` before
// the transport returns would over-claim, while leaving it `queued` would let a
// recovery path replay it. On startup every queued/claimed row is therefore
// reported as undelivered with an explicit ambiguous-delivery reason.

const { db } = require('./db');

const MAX_STEERING_CHARS = 4000;
const MAX_PENDING_PER_RUN = 20;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

const STATES = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  DELIVERED: 'delivered',
  UNDELIVERED: 'undelivered',
  CANCELLED: 'cancelled',
});

const INTERRUPTED_REASON =
  'The application closed before delivery could be confirmed.';

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without null characters.`);
  }
  return value;
}

function validateContent(content) {
  if (typeof content !== 'string' || !content.trim() || content.includes('\0')) {
    throw new Error('Write a steering instruction before sending.');
  }
  if (content.length > MAX_STEERING_CHARS) {
    throw new Error(`Steering instructions are limited to ${MAX_STEERING_CHARS.toLocaleString()} characters.`);
  }
  return content.trim();
}

function validateIdempotencyKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.includes('\0') ||
      key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new Error('Invalid steering idempotency key.');
  }
  return key.trim();
}

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    content: row.content,
    state: row.state,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? null,
    deliveredAt: row.delivered_at ?? null,
    deliveryRequestId: row.delivery_request_id ?? null,
    failureReason: row.failure_reason ?? null,
  };
}

// A compact update for live event listeners. The text is deliberately omitted
// on state transitions: the renderer already holds it from the submit response
// or the persisted history read, so events cannot become a second copy.
function toEvent(record, { includeContent = false } = {}) {
  if (!record) return null;
  return {
    id: record.id,
    sessionId: record.sessionId,
    runId: record.runId,
    state: record.state,
    createdAt: record.createdAt,
    claimedAt: record.claimedAt ?? null,
    deliveredAt: record.deliveredAt ?? null,
    deliveryRequestId: record.deliveryRequestId ?? null,
    failureReason: record.failureReason ?? null,
    ...(includeContent ? { content: record.content } : {}),
  };
}

function sessionExists(sessionId) {
  return Boolean(db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId));
}

/**
 * Persist one instruction for an active run. The caller must have resolved the
 * run from trusted state and verified its ownership first; this function only
 * enforces the durable queue invariants.
 *
 * Same-session/idempotency-key submissions return the existing row unchanged,
 * so an IPC retry cannot duplicate the instruction.
 */
function submitSteering({ sessionId, runId, content, idempotencyKey }) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(runId, 'runId');
  const text = validateContent(content);
  const key = validateIdempotencyKey(idempotencyKey);
  if (!sessionExists(sessionId)) throw new Error('Session not found.');

  return db.transaction(() => {
    const existing = db.prepare(
      'SELECT * FROM run_steering_messages WHERE session_id = ? AND idempotency_key = ?',
    ).get(sessionId, key);
    if (existing) return { record: toRecord(existing), duplicate: true };

    const pending = db.prepare(
      `SELECT COUNT(*) AS count FROM run_steering_messages
       WHERE session_id = ? AND run_id = ? AND state IN ('queued', 'claimed')`,
    ).get(sessionId, runId).count;
    if (pending >= MAX_PENDING_PER_RUN) {
      throw new Error('Too many steering instructions are waiting for this run.');
    }

    const id = require('node:crypto').randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO run_steering_messages
         (id, session_id, run_id, content, state, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(id, sessionId, runId, text, key, createdAt);
    return {
      record: toRecord(db.prepare('SELECT * FROM run_steering_messages WHERE id = ?').get(id)),
      duplicate: false,
    };
  }).immediate();
}

/**
 * Claim the next eligible instructions for one run at a model-request
 * boundary. Claiming is transactional and ordered by insertion (rowid), so
 * concurrent delivery checks cannot consume the same row or reorder a batch.
 */
function takeSteering({ sessionId, runId, requestId, limit = MAX_PENDING_PER_RUN }) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(runId, 'runId');
  const request = requireIdentifier(requestId, 'requestId');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PENDING_PER_RUN) {
    throw new TypeError('Invalid steering batch limit.');
  }
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM run_steering_messages
       WHERE session_id = ? AND run_id = ? AND state = 'queued'
       ORDER BY rowid ASC LIMIT ?`,
    ).all(sessionId, runId, limit);
    if (!rows.length) return [];
    const claim = db.prepare(
      `UPDATE run_steering_messages
       SET state = 'claimed', claimed_at = ?, delivery_request_id = ?
       WHERE id = ? AND state = 'queued'`,
    );
    const claimedAt = new Date().toISOString();
    for (const row of rows) claim.run(claimedAt, request, row.id);
    return rows.map(row => toRecord(
      db.prepare('SELECT * FROM run_steering_messages WHERE id = ?').get(row.id),
    ));
  }).immediate();
}

/** The transport accepted the request: delivery is now provable. */
function markDelivered({ sessionId, runId, ids, requestId, deliveredAt = null }) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(runId, 'runId');
  if (!Array.isArray(ids) || !ids.length) return [];
  const request = requireIdentifier(requestId, 'requestId');
  return db.transaction(() => {
    const update = db.prepare(
      `UPDATE run_steering_messages
       SET state = 'delivered', delivered_at = ?, failure_reason = NULL
       WHERE id = ? AND session_id = ? AND run_id = ? AND state IN ('queued', 'claimed')`,
    );
    const timestamp = deliveredAt ?? new Date().toISOString();
    for (const id of ids) update.run(timestamp, id, sessionId, runId);
    return ids.map(id => toRecord(
      db.prepare('SELECT * FROM run_steering_messages WHERE id = ? AND session_id = ? AND run_id = ?')
        .get(id, sessionId, runId),
    )).filter(Boolean);
  }).immediate();
}

/** The request failed before transport acceptance, or the batch was rejected. */
function markUndelivered({ sessionId, runId, ids, reason }) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(runId, 'runId');
  if (!Array.isArray(ids) || !ids.length) return [];
  const failureReason = typeof reason === 'string' && reason.trim()
    ? reason.trim() : 'Delivery could not be confirmed.';
  return db.transaction(() => {
    const update = db.prepare(
      `UPDATE run_steering_messages
       SET state = 'undelivered', failure_reason = ?
       WHERE id = ? AND session_id = ? AND run_id = ? AND state IN ('queued', 'claimed')`,
    );
    for (const id of ids) update.run(failureReason, id, sessionId, runId);
    return ids.map(id => toRecord(
      db.prepare('SELECT * FROM run_steering_messages WHERE id = ? AND session_id = ? AND run_id = ?')
        .get(id, sessionId, runId),
    )).filter(Boolean);
  }).immediate();
}

/**
 * Close the queue for a run that is no longer executing. Anything not already
 * delivered is reported undelivered with a reason that distinguishes "never
 * reached a checkpoint" from "was in flight when the run ended".
 */
function finalizeRun({ sessionId, runId, reason = null }) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(runId, 'runId');
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM run_steering_messages
       WHERE session_id = ? AND run_id = ? AND state IN ('queued', 'claimed')
       ORDER BY rowid ASC`,
    ).all(sessionId, runId);
    if (!rows.length) return [];
    const update = db.prepare(
      `UPDATE run_steering_messages
       SET state = 'undelivered', failure_reason = ?
       WHERE id = ? AND session_id = ? AND run_id = ? AND state = ?`,
    );
    const endedReason = typeof reason === 'string' && reason.trim()
      ? reason.trim() : 'The run ended before this instruction was delivered.';
    for (const row of rows) {
      update.run(row.state === 'claimed'
        ? 'The run ended while this instruction was in flight; delivery could not be confirmed.'
        : endedReason,
      row.id, sessionId, runId, row.state);
    }
    return rows.map(row => toRecord(
      db.prepare('SELECT * FROM run_steering_messages WHERE id = ?').get(row.id),
    ));
  }).immediate();
}

/** Explicit withdrawal of a still-queued instruction. */
function cancelSteering({ sessionId, steeringId }) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(steeringId, 'steeringId');
  return db.transaction(() => {
    const row = db.prepare(
      'SELECT * FROM run_steering_messages WHERE id = ? AND session_id = ?',
    ).get(steeringId, sessionId);
    if (!row) throw new Error('Steering instruction not found.');
    if (row.state !== STATES.QUEUED) {
      throw new Error('This instruction has already been taken up by the run.');
    }
    db.prepare(
      `UPDATE run_steering_messages
       SET state = 'cancelled', failure_reason = 'Withdrawn by the user before delivery.'
       WHERE id = ? AND session_id = ? AND state = 'queued'`,
    ).run(steeringId, sessionId);
    return toRecord(db.prepare('SELECT * FROM run_steering_messages WHERE id = ?').get(steeringId));
  }).immediate();
}

function getSteeringHistory(sessionId, limit = DEFAULT_HISTORY_LIMIT) {
  requireIdentifier(sessionId, 'sessionId');
  const bounded = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
  return db.prepare(
    `SELECT * FROM run_steering_messages
     WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`,
  ).all(sessionId, bounded).reverse().map(toRecord);
}

function getRunSteering(sessionId, runId) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(runId, 'runId');
  return db.prepare(
    `SELECT * FROM run_steering_messages
     WHERE session_id = ? AND run_id = ? ORDER BY rowid ASC`,
  ).all(sessionId, runId).map(toRecord);
}

function getSteering(sessionId, steeringId) {
  requireIdentifier(sessionId, 'sessionId');
  requireIdentifier(steeringId, 'steeringId');
  return toRecord(db.prepare(
    'SELECT * FROM run_steering_messages WHERE id = ? AND session_id = ?',
  ).get(steeringId, sessionId));
}

/**
 * Startup reconciliation. No main-agent run survives a process restart in this
 * application, so every queued or claimed row is an orphan. It is retained for
 * inspection but never attached to a later run, and it is never described as
 * delivered. Called once by initDatabase after the schema migration.
 */
function recoverInterruptedSteering() {
  return db.prepare(
    `UPDATE run_steering_messages
     SET state = 'undelivered', failure_reason = ?
     WHERE state IN ('queued', 'claimed')`,
  ).run(INTERRUPTED_REASON).changes;
}

module.exports = {
  MAX_STEERING_CHARS,
  MAX_PENDING_PER_RUN,
  STATES,
  INTERRUPTED_REASON,
  submitSteering,
  takeSteering,
  markDelivered,
  markUndelivered,
  finalizeRun,
  cancelSteering,
  getSteeringHistory,
  getRunSteering,
  getSteering,
  recoverInterruptedSteering,
  toRecord,
  toEvent,
};

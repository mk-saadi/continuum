'use strict';

// Workspace task plan: durable, session-owned intended work.
//
// Ownership: a plan belongs to the Workspace session — the same entity that
// owns task briefs, checkpoints, and turn digests. One plan row per session;
// steps are child rows scoped by session_id. Multi-tab behavior follows the
// existing session model: each tab/task has its own session, so switching
// tabs loads that session's plan and no two tasks can share or overwrite step
// state. A step id is a global row id but every read and write re-checks
// session_id, so reusing a "local" step number cannot touch another plan.
//
// Authority: the plan records intended work and model-reported progress. It is
// NOT evidence that a step succeeded; completion claims still require real
// verification (for example run_tests). Compaction reads the persisted plan but
// never writes it, so a generated summary can neither advance nor complete a
// step.
//
// Durability: each update commits synchronously in one SQLite transaction
// (synchronous=FULL, WAL). There is no debounce. A failed write returns an
// explicit persistence error and leaves the previous plan intact.
//
// Casual Chat never reads or writes this module: every entry point resolves
// the session's project first, exactly like briefs and checkpoints.

const { db } = require('./db');
const briefs = require('./taskBriefs');

const PLAN_MARKER = '[WORKSPACE TASK PLAN]';
const PLAN_END = '[END OF WORKSPACE TASK PLAN]';
const STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked']);
const MAX_STEPS = 50;
const MAX_DESCRIPTION = 500;
const MAX_NOTE = 600;
const MAX_OBJECTIVE = 500;
// Prompt budget for the rendered section (~1,000 tokens). Completed steps are
// dropped first; unfinished steps are kept and only their descriptions are
// shortened, so pending/in-progress/blocked state is never lost.
const PLAN_CHAR_CAP = 4000;

// Cross-session project reads (get_project_plans). Listing is deliberately
// bounded: the summary list never returns steps, and a page is capped so a
// project with many chats cannot flood the model's context.
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
// Derived aggregate plan status, most-attention-needed first. A plan has no
// stored status column; this is computed from its step statuses so the list can
// summarize without loading every step.
const PLAN_AGGREGATE_STATUSES = Object.freeze(['empty', 'blocked', 'in_progress', 'pending', 'completed']);

class PlanError extends Error {
  constructor(message, code = 'INVALID_PLAN') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PlanError('sessionId must be a non-empty string without null characters.', 'INVALID_SESSION');
  }
  return value;
}

function isWorkspaceSession(sessionId) {
  try {
    return briefs.isWorkspaceSession(sessionId);
  } catch {
    return false;
  }
}

// Single-line, length-bounded user/model text. Collapsing whitespace keeps the
// rendered prompt one line per step and makes the stored value stable.
function normalizeText(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new PlanError(`${name} is required.`, 'MISSING_FIELD');
    return '';
  }
  if (typeof value !== 'string') throw new PlanError(`${name} must be a string.`, 'INVALID_FIELD');
  const text = value.replace(/\s+/g, ' ').trim();
  if (required && !text) throw new PlanError(`${name} must not be empty.`, 'MISSING_FIELD');
  if (text.length > max) throw new PlanError(`${name} exceeds ${max} characters.`, 'FIELD_TOO_LONG');
  return text;
}

function normalizeStatus(value, name = 'status') {
  if (typeof value !== 'string' || !STATUSES.includes(value)) {
    throw new PlanError(`${name} must be one of: ${STATUSES.join(', ')}.`, 'INVALID_STATUS');
  }
  return value;
}

// Accept a numeric id or its digit-only JSON spelling; anything else is a
// clear error rather than a coerced NaN that silently misses.
function normalizeStepId(value, name = 'id') {
  const id = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PlanError(`${name} must be a positive integer step id from create/get.`, 'INVALID_STEP_ID');
  }
  return id;
}

function normalizeRemoveIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlanError('remove_step_ids must be an array of step ids.', 'INVALID_STEP_IDS');
  const ids = value.map((id, index) => normalizeStepId(id, `remove_step_ids[${index}]`));
  if (new Set(ids).size !== ids.length) throw new PlanError('remove_step_ids contains a duplicate id.', 'DUPLICATE_STEP_ID');
  return ids;
}

function normalizeExpectedRevision(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PlanError('expected_revision must be a positive integer from a previous create/get.', 'INVALID_REVISION');
  }
  return value;
}

// Cross-session read arguments (get_project_plans). These are validated
// loudly, like every other plan argument, so a bad request never silently
// widens a listing.
function normalizeListLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new PlanError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`, 'INVALID_LIMIT');
  }
  return value;
}

function normalizeListOffset(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PlanError('offset must be a non-negative integer.', 'INVALID_OFFSET');
  }
  return value;
}

// The stable plan identity is the owning session id (the plan row is keyed by
// it). A caller may name either `plan_id` or `session_id`; both must be a
// non-empty string and are checked against the current project before use.
function normalizeTargetId(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PlanError('plan_id (or session_id) must be a non-empty string from action "list".', 'INVALID_TARGET');
  }
  return value;
}

function normalizeCreateSteps(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlanError('steps must be a non-empty array when creating a plan.', 'INVALID_STEPS');
  }
  if (value.length > MAX_STEPS) {
    throw new PlanError(`A plan may contain at most ${MAX_STEPS} steps.`, 'TOO_MANY_STEPS');
  }
  return value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new PlanError(`steps[${index}] must be an object.`, 'INVALID_STEP');
    }
    if (Object.hasOwn(step, 'id')) {
      throw new PlanError(
        `steps[${index}]: do not provide id when creating a plan; ids are assigned and returned.`,
        'UNEXPECTED_STEP_ID',
      );
    }
    const description = normalizeText(step.description, `steps[${index}].description`, MAX_DESCRIPTION, {
      required: true,
    });
    const status = step.status === undefined ? 'pending' : normalizeStatus(step.status, `steps[${index}].status`);
    const note = normalizeText(step.note, `steps[${index}].note`, MAX_NOTE);
    if (status === 'blocked' && !note) {
      throw new PlanError(
        `steps[${index}] is blocked; provide a concise note explaining the blocker.`,
        'BLOCKED_NOTE_REQUIRED',
      );
    }
    return { description, status, note };
  });
}

function normalizeUpdateEntries(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlanError('steps must be an array when provided.', 'INVALID_STEPS');
  if (value.length > MAX_STEPS) {
    throw new PlanError(`A plan may contain at most ${MAX_STEPS} steps.`, 'TOO_MANY_STEPS');
  }
  return value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new PlanError(`steps[${index}] must be an object.`, 'INVALID_STEP');
    }
    const hasId = Object.hasOwn(step, 'id');
    const hasDescription = Object.hasOwn(step, 'description');
    const hasStatus = Object.hasOwn(step, 'status');
    const hasNote = Object.hasOwn(step, 'note');
    if (!hasDescription && !hasStatus && !hasNote) {
      throw new PlanError(
        `steps[${index}] must change description, status, or note${hasId ? '' : ', or include a description to add a step'}.`,
        'EMPTY_STEP_UPDATE',
      );
    }
    if (!hasId && !hasDescription) {
      throw new PlanError(`steps[${index}]: description is required when adding a new step.`, 'MISSING_FIELD');
    }
    const entry = { index, id: hasId ? normalizeStepId(step.id, `steps[${index}].id`) : null };
    if (hasDescription) {
      entry.description = normalizeText(step.description, `steps[${index}].description`, MAX_DESCRIPTION, {
        required: true,
      });
    }
    if (hasStatus) entry.status = normalizeStatus(step.status, `steps[${index}].status`);
    if (hasNote) entry.note = normalizeText(step.note, `steps[${index}].note`, MAX_NOTE);
    return entry;
  });
}

function readPlan(sessionId) {
  return db.transaction(() => {
    const row = db.prepare('SELECT objective, revision, created_at, updated_at FROM workspace_plans WHERE session_id = ?')
      .get(sessionId);
    if (!row) return null;
    const steps = db
      .prepare(`SELECT id, position, description, status, note, created_at, updated_at
        FROM workspace_plan_steps WHERE session_id = ? ORDER BY position ASC, id ASC`)
      .all(sessionId)
      .map((step) => ({
        id: step.id,
        position: step.position,
        description: step.description,
        status: step.status,
        note: step.note ?? '',
        createdAt: step.created_at,
        updatedAt: step.updated_at,
      }));
    return {
      objective: row.objective ?? '',
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps,
    };
  })();
}

// The trusted project identity for a session, resolved server-side. Never
// supplied by the model. `undefined` means the session does not exist; `null`
// means it exists but is a Casual Chat (no project).
function projectIdOfSession(sessionId) {
  const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId);
  return row ? row.project_id : undefined;
}

// One derived aggregate status for a plan, most-attention-needed first, so a
// listing can summarize without shipping steps.
function planAggregateStatus(counts, total) {
  if (!total) return 'empty';
  if (counts.blocked > 0) return 'blocked';
  if (counts.in_progress > 0) return 'in_progress';
  if (counts.pending > 0) return 'pending';
  return 'completed';
}

// Bounded list row: metadata and counts only, never step text.
function summarizePlanRow(row) {
  const counts = {
    pending: row.pending_steps ?? 0,
    in_progress: row.in_progress_steps ?? 0,
    completed: row.completed_steps ?? 0,
    blocked: row.blocked_steps ?? 0,
  };
  const total = row.total_steps ?? 0;
  return {
    plan_id: row.session_id,
    session_id: row.session_id,
    session_title: row.session_title ?? null,
    objective: row.objective ?? '',
    status: planAggregateStatus(counts, total),
    revision: row.revision,
    total_steps: total,
    completed_steps: counts.completed,
    blocked_steps: counts.blocked,
    in_progress_steps: counts.in_progress,
    pending_steps: counts.pending,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_active_at: row.last_active_at ?? null,
  };
}

// Full selected plan, same authoritative records update_plan reads, plus the
// owning-session reference and derived completion information. Read-only.
function planDetail(sessionId, owner, plan) {
  const counts = statusCounts(plan);
  return {
    plan_id: sessionId,
    session_id: sessionId,
    session_title: owner?.session_title ?? owner?.title ?? null,
    objective: plan.objective,
    status: planAggregateStatus(counts, plan.steps.length),
    revision: plan.revision,
    total_steps: plan.steps.length,
    completed_steps: counts.completed,
    blocked_steps: counts.blocked,
    in_progress_steps: counts.in_progress,
    pending_steps: counts.pending,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    steps: plan.steps.map((step) => ({
      id: step.id,
      position: step.position,
      description: step.description,
      status: step.status,
      note: step.note,
    })),
  };
}

// Project-scoped listing. Only plans whose owning session still belongs to the
// current project are ever returned (the JOIN is the authorization boundary):
// a plan from another project, a detached session (project deleted), or a
// Casual Chat session can never appear. Bounded page + total for pagination.
function listProjectPlans(sessionId, { limit, offset } = {}) {
  requireSessionId(sessionId);
  const projectId = projectIdOfSession(sessionId);
  if (projectId == null) {
    throw new PlanError('Plans are only available in a Workspace session.', 'PLAN_REQUIRES_WORKSPACE');
  }
  const lim = normalizeListLimit(limit);
  const off = normalizeListOffset(offset);
  return db.transaction(() => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM workspace_plans p JOIN sessions s ON s.id = p.session_id
        WHERE s.project_id = ?`)
      .get(projectId).n;
    const rows = db
      .prepare(`SELECT p.session_id, p.objective, p.revision, p.created_at, p.updated_at,
          s.title AS session_title, s.last_active_at,
          COUNT(st.id) AS total_steps,
          SUM(CASE WHEN st.status = 'pending' THEN 1 ELSE 0 END) AS pending_steps,
          SUM(CASE WHEN st.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_steps,
          SUM(CASE WHEN st.status = 'completed' THEN 1 ELSE 0 END) AS completed_steps,
          SUM(CASE WHEN st.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_steps
        FROM workspace_plans p
        JOIN sessions s ON s.id = p.session_id
        LEFT JOIN workspace_plan_steps st ON st.session_id = p.session_id
        WHERE s.project_id = ?
        GROUP BY p.session_id
        ORDER BY p.updated_at DESC, s.last_active_at DESC, s.id ASC
        LIMIT ? OFFSET ?`)
      .all(projectId, lim, off);
    return {
      plans: rows.map(summarizePlanRow),
      total,
      limit: lim,
      offset: off,
      has_more: off + rows.length < total,
    };
  })();
}

// Project-scoped single plan. The target session must exist and belong to the
// caller's project; anything else (unknown id, Casual Chat, another project)
// yields the identical non-accessible result, so a guessed id cannot confirm
// or reach a plan outside the project.
function getProjectPlan(sessionId, { target } = {}) {
  requireSessionId(sessionId);
  const projectId = projectIdOfSession(sessionId);
  if (projectId == null) {
    throw new PlanError('Plans are only available in a Workspace session.', 'PLAN_REQUIRES_WORKSPACE');
  }
  const targetId = normalizeTargetId(target);
  return db.transaction(() => {
    const owner = db
      .prepare('SELECT id, title, project_id FROM sessions WHERE id = ?')
      .get(targetId);
    if (!owner || owner.project_id == null || owner.project_id !== projectId) {
      return { accessible: false, exists: false, owner: null, plan: null };
    }
    const ownerRef = { session_id: owner.id, session_title: owner.title ?? null };
    const plan = readPlan(targetId);
    if (!plan || !plan.steps.length) {
      return { accessible: true, exists: false, owner: ownerRef, plan: null };
    }
    return { accessible: true, exists: true, owner: ownerRef, plan: planDetail(targetId, ownerRef, plan) };
  })();
}

function createPlan(sessionId, { objective, steps }) {
  const planned = normalizeCreateSteps(steps);
  return db
    .transaction(() => {
      const existing = db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(sessionId);
      if (existing) {
        throw new PlanError(
          `A plan already exists for this task (revision ${existing.revision}). Use action "update" to revise it.`,
          'PLAN_EXISTS',
        );
      }
      db.prepare('INSERT INTO workspace_plans(session_id, objective, revision) VALUES (?, ?, 1)')
        .run(sessionId, objective);
      const insert = db.prepare(
        'INSERT INTO workspace_plan_steps(session_id, position, description, status, note) VALUES (?, ?, ?, ?, ?)',
      );
      planned.forEach((step, index) => insert.run(sessionId, index + 1, step.description, step.status, step.note));
      return readPlan(sessionId);
    })
    .immediate();
}

function updateSteps(sessionId, { objective, steps, removeIds, expectedRevision }) {
  const entries = normalizeUpdateEntries(steps);
  const removes = normalizeRemoveIds(removeIds);
  if (!entries.length && !removes.length && objective === undefined) {
    throw new PlanError(
      'No changes were requested. Provide steps, remove_step_ids, or objective.',
      'EMPTY_UPDATE',
    );
  }
  return db
    .transaction(() => {
      const planRow = db.prepare('SELECT revision, objective FROM workspace_plans WHERE session_id = ?').get(sessionId);
      if (!planRow) {
        throw new PlanError('No plan exists for this task. Call update_plan with action "create" first.', 'PLAN_NOT_FOUND');
      }
      if (expectedRevision !== null && expectedRevision !== planRow.revision) {
        throw new PlanError(
          `The plan changed since revision ${expectedRevision} (current revision ${planRow.revision}). Call action "get" to reload it, then retry.`,
          'STALE_PLAN',
        );
      }
      const existing = db
        .prepare(`SELECT id, position, description, status, note FROM workspace_plan_steps
          WHERE session_id = ? ORDER BY position ASC, id ASC`)
        .all(sessionId);
      const byId = new Map(existing.map((step) => [step.id, step]));
      const removeSet = new Set(removes);
      for (const id of removeSet) {
        if (!byId.has(id)) {
          throw new PlanError(
            `Unknown step id ${id}: it does not belong to this task's plan. Call action "get" to list valid ids.`,
            'UNKNOWN_STEP',
          );
        }
      }

      const update = db.prepare(
        `UPDATE workspace_plan_steps SET description = ?, status = ?, note = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND session_id = ?`,
      );
      const insert = db.prepare(
        'INSERT INTO workspace_plan_steps(session_id, position, description, status, note) VALUES (?, ?, ?, ?, ?)',
      );
      // Only these steps are reported in the compact mutation result. They are
      // resolved from the committed rows below, never from requested values.
      const touchedIds = new Set();
      const addedIds = new Set();
      let position = existing.length ? existing[existing.length - 1].position : 0;
      let added = 0;
      for (const entry of entries) {
        if (entry.id !== null) {
          if (removeSet.has(entry.id)) {
            throw new PlanError(
              `Step id ${entry.id} cannot be updated and removed in the same call.`,
              'CONFLICTING_STEP',
            );
          }
          const current = byId.get(entry.id);
          if (!current) {
            throw new PlanError(
              `Unknown step id ${entry.id}: it does not belong to this task's plan. Call action "get" to list valid ids.`,
              'UNKNOWN_STEP',
            );
          }
          const description = entry.description !== undefined ? entry.description : current.description;
          const status = entry.status !== undefined ? entry.status : current.status;
          const note = entry.note !== undefined ? entry.note : current.note;
          if (status === 'blocked' && !note) {
            throw new PlanError(
              `Step ${entry.id} is blocked; provide a concise note explaining the blocker.`,
              'BLOCKED_NOTE_REQUIRED',
            );
          }
          update.run(description, status, note, entry.id, sessionId);
          touchedIds.add(entry.id);
          continue;
        }
        if (existing.length - removeSet.size + added >= MAX_STEPS) {
          throw new PlanError(`A plan may contain at most ${MAX_STEPS} steps.`, 'TOO_MANY_STEPS');
        }
        const status = entry.status ?? 'pending';
        const note = entry.note ?? '';
        if (status === 'blocked' && !note) {
          throw new PlanError(
            `New step "${entry.description}" is blocked; provide a concise note explaining the blocker.`,
            'BLOCKED_NOTE_REQUIRED',
          );
        }
        position += 1;
        const inserted = insert.run(sessionId, position, entry.description, status, note);
        const newId = Number(inserted.lastInsertRowid);
        touchedIds.add(newId);
        addedIds.add(newId);
        added += 1;
      }
      for (const id of removeSet) {
        db.prepare('DELETE FROM workspace_plan_steps WHERE id = ? AND session_id = ?').run(id, sessionId);
      }
      if (objective !== undefined) {
        db.prepare('UPDATE workspace_plans SET objective = ? WHERE session_id = ?').run(objective, sessionId);
      }
      // Re-number ordering positions deterministically. Step ids — the stable
      // identities the model updates by — are never reassigned.
      const remaining = db
        .prepare('SELECT id FROM workspace_plan_steps WHERE session_id = ? ORDER BY position ASC, id ASC')
        .all(sessionId);
      const setPosition = db.prepare(
        'UPDATE workspace_plan_steps SET position = ? WHERE id = ? AND session_id = ?',
      );
      remaining.forEach((step, index) => setPosition.run(index + 1, step.id, sessionId));
      db.prepare(
        'UPDATE workspace_plans SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
      ).run(sessionId);
      return {
        plan: readPlan(sessionId),
        touchedIds,
        addedIds,
        removedIds: [...removeSet].sort((a, b) => a - b),
        objectiveChanged: objective !== undefined && objective !== (planRow.objective ?? ''),
      };
    })
    .immediate();
}

// Public read path for the renderer and tests. Casual sessions have no plan.
function getPlan(sessionId) {
  requireSessionId(sessionId);
  if (!isWorkspaceSession(sessionId)) return null;
  return readPlan(sessionId);
}

// Compact mutation response. An update reports only the authoritative
// post-commit revision, the steps the call actually touched, removals, and
// whole-plan progress — never the unchanged steps. Planned work is echoed from
// the committed rows (not the request) so a response can never describe state
// that was not saved. `changed_steps` follows plan order; removals are sorted by
// id, making the response byte-stable for an identical mutation.
function compactMutationResult(sessionId, { plan, touchedIds, addedIds, removedIds, objectiveChanged }) {
  const counts = statusCounts(plan);
  const result = {
    success: true,
    action: 'update',
    exists: true,
    plan_id: sessionId,
    revision: plan.revision,
    changed_steps: plan.steps
      .filter((step) => touchedIds.has(step.id))
      .map((step) => ({
        id: step.id,
        position: step.position,
        description: step.description,
        status: step.status,
        note: step.note,
        change: addedIds.has(step.id) ? 'added' : 'updated',
      })),
    progress: {
      total: plan.steps.length,
      completed: counts.completed,
      in_progress: counts.in_progress,
      pending: counts.pending,
      blocked: counts.blocked,
    },
  };
  if (removedIds.length) result.removed_step_ids = removedIds;
  if (objectiveChanged) result.objective = plan.objective;
  return result;
}

// Tool entry point. Validation failures and persistence failures are returned
// as structured, explicit errors: a caller must never mistake a failed write
// for a durable update.
function updatePlan(sessionId, args) {
  try {
    requireSessionId(sessionId);
    if (!isWorkspaceSession(sessionId)) {
      throw new PlanError('Plans are only available in a Workspace session.', 'PLAN_REQUIRES_WORKSPACE');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new PlanError('Tool arguments must be an object.', 'INVALID_ARGUMENTS');
    }
    const action = args.action;
    if (action !== 'create' && action !== 'update' && action !== 'get') {
      throw new PlanError('action must be "create", "update", or "get".', 'INVALID_ACTION');
    }
    if (action === 'get') {
      const plan = readPlan(sessionId);
      return plan
        ? { success: true, action, exists: true, plan }
        : {
            success: true,
            action,
            exists: false,
            plan: null,
            message: 'No plan exists for this task yet. Call update_plan with action "create".',
          };
    }
    const objective = args.objective === undefined
      ? undefined
      : normalizeText(args.objective, 'objective', MAX_OBJECTIVE);
    if (action === 'create') {
      const plan = createPlan(sessionId, { objective: objective ?? '', steps: args.steps });
      return { success: true, action, exists: true, plan };
    }
    const mutation = updateSteps(sessionId, {
      objective,
      steps: args.steps,
      removeIds: args.remove_step_ids,
      expectedRevision: normalizeExpectedRevision(args.expected_revision),
    });
    return compactMutationResult(sessionId, mutation);
  } catch (error) {
    if (error instanceof PlanError) {
      return { success: false, error: error.message, code: error.code };
    }
    return {
      success: false,
      error: `Plan update was not saved: ${error?.message ?? error}`,
      code: 'PLAN_PERSISTENCE_FAILED',
    };
  }
}

// Public read-only cross-session entry point. Preserves update_plan semantics
// and is strictly non-mutating: it only reads the same authoritative tables.
function getProjectPlans(sessionId, args) {
  try {
    requireSessionId(sessionId);
    if (!isWorkspaceSession(sessionId)) {
      throw new PlanError('Plans are only available in a Workspace session.', 'PLAN_REQUIRES_WORKSPACE');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new PlanError('Tool arguments must be an object.', 'INVALID_ARGUMENTS');
    }
    const action = args.action;
    if (action !== 'list' && action !== 'get') {
      throw new PlanError('action must be "list" or "get".', 'INVALID_ACTION');
    }
    if (action === 'list') {
      const listing = listProjectPlans(sessionId, { limit: args.limit, offset: args.offset });
      return { success: true, action, ...listing };
    }
    const target = args.plan_id ?? args.session_id;
    if (target === undefined || target === null) {
      throw new PlanError('plan_id (or session_id) is required for action "get".', 'MISSING_FIELD');
    }
    const found = getProjectPlan(sessionId, { target });
    if (!found.accessible) {
      // Neutral: a guessed id from another project is indistinguishable from
      // an unknown one, so this cannot confirm that a plan exists elsewhere.
      return {
        success: true,
        action,
        exists: false,
        plan: null,
        message: 'No plan found for that id in this project.',
      };
    }
    if (!found.exists) {
      return {
        success: true,
        action,
        exists: false,
        owner: found.owner,
        plan: null,
        message: 'That session has no plan yet.',
      };
    }
    return { success: true, action, exists: true, owner: found.owner, plan: found.plan };
  } catch (error) {
    if (error instanceof PlanError) {
      return { success: false, error: error.message, code: error.code };
    }
    return {
      success: false,
      error: `Project plan read failed: ${error?.message ?? error}`,
      code: 'PLAN_READ_FAILED',
    };
  }
}

function statusCounts(plan) {
  const counts = { pending: 0, in_progress: 0, completed: 0, blocked: 0 };
  for (const step of plan.steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
  return counts;
}

function stepLine(entry) {
  const note = entry.note ? ` — ${entry.note}` : '';
  return `${entry.position}. [${entry.status}] (id ${entry.id}) ${entry.description}${note}`;
}

// Bounded, deterministic rendering. All unfinished steps survive budget
// pressure; completed steps are folded first (oldest first), then individual
// descriptions are shortened while blocker notes are preserved. Omission is
// stated explicitly.
function renderPlanSection(plan, charCap = PLAN_CHAR_CAP) {
  const cap = Number.isSafeInteger(charCap) && charCap > 0 ? charCap : PLAN_CHAR_CAP;
  const counts = statusCounts(plan);
  const header = [
    PLAN_MARKER,
    'The current plan for this task. It records intended work and reported progress; it is not proof that a step succeeded. Verify finished implementation (for example with run_tests) before reporting completion, and keep the plan current with update_plan.',
    `Revision: ${plan.revision}`,
  ];
  if (plan.objective) header.push(`Objective: ${plan.objective}`);
  header.push(
    `Progress: ${counts.completed}/${plan.steps.length} completed · ${counts.in_progress} in progress · ` +
      `${counts.blocked} blocked · ${counts.pending} pending`,
  );
  header.push('Steps:');

  const kept = plan.steps.map((step, index) => {
    const entry = {
      status: step.status,
      position: index + 1,
      id: step.id,
      description: step.description,
      note: step.note,
    };
    entry.line = stepLine(entry);
    return entry;
  });
  let omittedCompleted = 0;
  const compose = () => {
    const parts = [...header];
    for (const entry of kept) parts.push(entry.line);
    if (omittedCompleted) parts.push(`Omitted for budget: ${omittedCompleted} completed step(s).`);
    parts.push(PLAN_END);
    return parts.join('\n');
  };
  let text = compose();
  while (text.length > cap) {
    const at = kept.findIndex((entry) => entry.status === 'completed');
    if (at < 0) break;
    kept.splice(at, 1);
    omittedCompleted += 1;
    text = compose();
  }
  if (text.length > cap && kept.length) {
    // Never drop an unfinished step. Shorten the longest description instead,
    // preferring non-blocked steps so blocker explanations survive; a note is
    // re-appended after the shortened description, never cut by the ellipsis.
    const trimOnce = (pool) => {
      let target = null;
      for (const entry of pool) {
        if (entry.line.length > 64 && (!target || entry.line.length > target.line.length)) target = entry;
      }
      if (!target) return false;
      const fixed = `${target.position}. [${target.status}] (id ${target.id}) `;
      const note = target.note ? ` — ${target.note}` : '';
      const overflow = text.length - cap;
      const targetDescription = Math.max(
        20,
        target.line.length - fixed.length - note.length - Math.max(20, Math.ceil(overflow / kept.length) + 20),
      );
      const shortened = target.description.length > targetDescription
        ? `${target.description.slice(0, targetDescription).trimEnd()}…`
        : target.description;
      const next = `${fixed}${shortened}${note}`;
      if (next.length >= target.line.length) return false;
      target.line = next;
      return true;
    };
    let guard = 0;
    while (text.length > cap && guard++ < 400) {
      const unfinishedOnly = kept.filter((entry) => entry.status !== 'blocked');
      const changed = trimOnce(unfinishedOnly.length ? unfinishedOnly : kept)
        || (unfinishedOnly.length > 0 && trimOnce(kept));
      if (!changed) break;
      text = compose();
    }
    // Pathological cap (smaller than the irreducible header/footer): hard-bound
    // the whole section, keeping the end marker truthful.
    if (text.length > cap) text = `${text.slice(0, Math.max(0, cap - PLAN_END.length - 2))}\n${PLAN_END}`;
  }
  return text;
}

function buildPlanSection(sessionId, { contextWindowLimit = null } = {}) {
  requireSessionId(sessionId);
  if (!isWorkspaceSession(sessionId)) return null;
  const plan = readPlan(sessionId);
  if (!plan || !plan.steps.length) return null;
  const content = renderPlanSection(plan);
  const tokens = Math.ceil(content.length / 4);
  if (Number.isSafeInteger(contextWindowLimit) && contextWindowLimit > 0 && tokens > contextWindowLimit) {
    console.error('[workspacePlan] plan exceeds the context window; omitting it from this prompt.');
    return null;
  }
  return {
    role: 'system',
    content,
    workspacePlan: true,
    planRevision: plan.revision,
    planStepCount: plan.steps.length,
    planTokens: tokens,
  };
}

module.exports = {
  PLAN_MARKER,
  PLAN_END,
  STATUSES,
  MAX_STEPS,
  MAX_DESCRIPTION,
  MAX_NOTE,
  MAX_OBJECTIVE,
  PLAN_CHAR_CAP,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  PLAN_AGGREGATE_STATUSES,
  PlanError,
  isWorkspaceSession,
  getPlan,
  updatePlan,
  getProjectPlans,
  buildPlanSection,
  renderPlanSection,
};

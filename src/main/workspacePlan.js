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
      const planRow = db.prepare('SELECT revision FROM workspace_plans WHERE session_id = ?').get(sessionId);
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
        insert.run(sessionId, position, entry.description, status, note);
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
      return readPlan(sessionId);
    })
    .immediate();
}

// Public read path for the renderer and tests. Casual sessions have no plan.
function getPlan(sessionId) {
  requireSessionId(sessionId);
  if (!isWorkspaceSession(sessionId)) return null;
  return readPlan(sessionId);
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
    const plan = updateSteps(sessionId, {
      objective,
      steps: args.steps,
      removeIds: args.remove_step_ids,
      expectedRevision: normalizeExpectedRevision(args.expected_revision),
    });
    return { success: true, action, exists: true, plan };
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
  PlanError,
  isWorkspaceSession,
  getPlan,
  updatePlan,
  buildPlanSection,
  renderPlanSection,
};

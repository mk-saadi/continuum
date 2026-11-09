'use strict';

// Persistent scheduled-task store and in-process scheduler.
//
// This module is deliberately renderer-independent. It owns:
//   * validation of every renderer-supplied task definition;
//   * SQLite persistence for task definitions and execution history;
//   * recurrence/missed-run evaluation (the pure math lives in
//     src/lib/scheduleCalc.cjs);
//   * a persistent, serial (concurrency 1) execution queue;
//   * model preparation and fallback policy;
//   * unattended approval boundaries and notifications.
//
// It never starts a model before the queue has prepared it, and it never
// silently substitutes a different loaded model. Every occurrence is claimed
// atomically through the unique (task_id, scheduled_for) key, so repeated
// ticks, restart and wake cannot create duplicate executions.

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const scheduleCalc = require('../lib/scheduleCalc.cjs');
const { db } = require('./db');
const { waitForTurnLeasesToClear } = require('./modelSwitchCoordinator');
const {
  queryGpuMemory,
  estimateOffloadRequirements,
  assessGpuFit,
  DEFAULT_SAFETY_MARGIN_MIB,
} = require('./gpuMemory');

const TERMINAL_RUN_STATUSES = Object.freeze([
  'completed', 'failed', 'skipped', 'missed', 'interrupted', 'expired', 'blocked', 'cancelled',
]);
const NON_TERMINAL_RUN_STATUSES = Object.freeze([
  'deferred', 'queued', 'waiting_for_model', 'waiting_for_lease', 'running',
]);
const RUN_STATUSES = Object.freeze([...NON_TERMINAL_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);
const TRIGGERS = Object.freeze(['schedule', 'manual']);
const PERMISSION_MODES = Object.freeze(require('../lib/permissionModes.json').modes);
const DEFAULT_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();
const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_MAX_OVERDUE_DAYS = 7;
const DEFAULT_TICK_MS = 30_000;
const DEFAULT_STARTUP_CAP = 5;
const DEFAULT_MODEL_LEASE_WAIT_MS = 10 * 60_000;
const DEFAULT_MODEL_READY_WAIT_MS = 10 * 60_000;
const DEFAULT_MODEL_READY_POLL_MS = 250;
const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60_000;
const MAX_RUN_REASON = 1000;

const TASK_FIELDS = Object.freeze([
  'name', 'prompt', 'projectId', 'schedule', 'recurrence', 'timezone', 'model', 'modelRef',
  'fallback', 'missedPolicy', 'catchup', 'permissionMode', 'budget', 'enabled',
]);
const TASK_UPDATE_FIELDS = new Set(TASK_FIELDS);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be an object.`);
  return value;
}

function optionalString(value, name, { max = 200, trim = true } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const result = trim ? value.trim() : value;
  if (!result) throw new TypeError(`${name} cannot be empty.`);
  if (result.length > max) throw new TypeError(`${name} is too long.`);
  if (result.includes('\0')) throw new TypeError(`${name} cannot contain null characters.`);
  return result;
}

function requiredString(value, name, options) {
  const result = optionalString(value, name, options);
  if (result === null) throw new TypeError(`${name} is required.`);
  return result;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function optionalInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function requireId(value, name = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || value.includes('\0'))
    throw new TypeError(`A valid ${name} is required.`);
  return value.trim();
}

function normalizeTimezone(value) {
  const timezone = value === undefined || value === null
    ? DEFAULT_TIMEZONE
    : requiredString(value, 'timezone', { max: 100 });
  scheduleCalc.assertTimezone(timezone);
  return timezone;
}

function normalizeScheduleSpec(value, timezone, now) {
  if (value === undefined || value === null) throw new TypeError('A schedule is required.');
  return scheduleCalc.normalizeSchedule(value, { timezone, now });
}

function normalizeMissedPolicy(value) {
  if (value === undefined || value === null) {
    return { policy: 'grace', graceHours: DEFAULT_GRACE_HOURS, maxOverdueDays: DEFAULT_MAX_OVERDUE_DAYS };
  }
  if (typeof value === 'string') value = { policy: value };
  assertPlainObject(value, 'missedPolicy');
  let policy = value.policy;
  if (policy === undefined || policy === null) policy = 'grace';
  if (policy === 'run_on_next' || policy === 'run-on-next' || policy === 'runOnNext') policy = 'catch_up';
  if (!['grace', 'skip', 'catch_up'].includes(policy))
    throw new TypeError('Missed-run policy must be grace, skip, or catch_up.');
  const graceHours = value.graceHours ?? value.grace_hours;
  const maxOverdueDays = value.maxOverdueDays ?? value.max_overdue_days;
  return {
    policy,
    graceHours: optionalInteger(graceHours, 'graceHours', { min: 0, max: 24 * 365 }) ?? DEFAULT_GRACE_HOURS,
    maxOverdueDays: optionalInteger(maxOverdueDays, 'maxOverdueDays', { min: 1, max: 365 }) ?? DEFAULT_MAX_OVERDUE_DAYS,
  };
}

function normalizePermissionMode(value) {
  const mode = value === undefined || value === null ? 'read_only' : value;
  if (typeof mode !== 'string' || !PERMISSION_MODES.includes(mode))
    throw new TypeError(`Permission mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
  return mode;
}

function normalizeBudget(value) {
  if (value === undefined || value === null) return null;
  assertPlainObject(value, 'budget');
  const budget = {};
  const maxTurns = optionalInteger(value.maxTurns ?? value.max_turns, 'maxTurns', { min: 1, max: 10_000 });
  const maxToolCalls = optionalInteger(value.maxToolCalls ?? value.max_tool_calls, 'maxToolCalls', { min: 1, max: 100_000 });
  const maxWallClockMs = optionalInteger(value.maxWallClockMs ?? value.max_wall_clock_ms, 'maxWallClockMs', { min: 1_000, max: 6 * 60 * 60_000 });
  if (maxTurns !== null) budget.maxTurns = maxTurns;
  if (maxToolCalls !== null) budget.maxToolCalls = maxToolCalls;
  if (maxWallClockMs !== null) budget.maxWallClockMs = maxWallClockMs;
  return Object.keys(budget).length ? budget : null;
}

function normalizeModelRef(value, { field = 'model', allowAnyLoaded = false } = {}) {
  if (typeof value === 'string') value = { kind: 'local', modelPath: value };
  assertPlainObject(value, field);
  const kind = value.kind ?? value.type;
  if (allowAnyLoaded && (kind === 'any-loaded' || kind === 'any_loaded')) return { kind: 'any-loaded' };
  if (kind === 'local') {
    const modelPath = requiredString(value.modelPath ?? value.modelId ?? value.path, `${field}.modelPath`, { max: 4096 });
    const config = value.config === undefined || value.config === null ? null : assertPlainObject(value.config, `${field}.config`);
    return { kind: 'local', modelPath, ...(config ? { config: { ...config } } : {}) };
  }
  if (kind === 'cloud') {
    const provider = requiredString(value.provider, `${field}.provider`, { max: 200 });
    const modelId = requiredString(value.modelId ?? value.model, `${field}.modelId`, { max: 300 });
    if (/[\r\n]/.test(provider) || /[\r\n]/.test(modelId))
      throw new TypeError(`${field} must not contain line breaks.`);
    return { kind: 'cloud', provider, modelId };
  }
  throw new TypeError(`${field} must be a local model or a cloud provider/model pair.`);
}

function normalizeFallback(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('fallback must be an array.');
  if (value.length > 8) throw new TypeError('fallback supports at most 8 entries.');
  return value.map((entry, index) => normalizeModelRef(entry, { field: `fallback[${index}]` }));
}

function normalizeProjectId(value) {
  if (value === undefined || value === null || value === '') return null;
  const projectId = requireId(value, 'projectId');
  require('./projectManager').getProject(projectId);
  return projectId;
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function boundedReason(value) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : String(value);
  return text.length <= MAX_RUN_REASON ? text : `${text.slice(0, MAX_RUN_REASON)}…`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function taskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    projectId: row.project_id ?? null,
    schedule: parseJson(row.schedule_json, null),
    timezone: row.timezone,
    model: parseJson(row.model_json, null),
    fallback: parseJson(row.fallback_json, []),
    missedPolicy: parseJson(row.missed_policy_json, { policy: 'grace', graceHours: DEFAULT_GRACE_HOURS, maxOverdueDays: DEFAULT_MAX_OVERDUE_DAYS }),
    permissionMode: row.permission_mode,
    budget: parseJson(row.budget_json, null),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id ?? null,
    scheduledFor: row.scheduled_for,
    trigger: row.trigger || 'schedule',
    status: row.status,
    claimedAt: row.claimed_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    failureReason: row.failure_reason ?? null,
    model: parseJson(row.model_json, null),
    fallbackUsed: Boolean(row.fallback_used),
    usage: parseJson(row.usage_json, null),
    deferredUntil: row.deferred_until ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function getTaskRow(id) {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(requireId(id));
}

function listTaskRecords({ includeDisabled = true } = {}) {
  if (typeof includeDisabled !== 'boolean') throw new TypeError('includeDisabled must be a boolean.');
  const rows = includeDisabled
    ? db.prepare('SELECT * FROM scheduled_tasks ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, name, id').all()
    : db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at IS NULL, next_run_at, name, id').all();
  return rows.map(taskFromRow);
}

function getTaskRecord(id) {
  return taskFromRow(getTaskRow(id));
}

function getRunRow(id) {
  return db.prepare('SELECT * FROM scheduled_task_runs WHERE id = ?').get(requireId(id));
}

function getRunRecord(id) {
  return runFromRow(getRunRow(id));
}

function listRunRecords({ taskId = null, limit = 50, offset = 0, status = null } = {}) {
  if (taskId !== null && taskId !== undefined) taskId = requireId(taskId, 'taskId');
  const boundedLimit = optionalInteger(limit, 'limit', { min: 1, max: 200 }) ?? 50;
  const boundedOffset = optionalInteger(offset, 'offset', { min: 0, max: 1_000_000 }) ?? 0;
  let statuses = null;
  if (status !== null && status !== undefined) {
    statuses = Array.isArray(status) ? status : [status];
    if (!statuses.length || statuses.length > RUN_STATUSES.length || statuses.some(item => !RUN_STATUSES.includes(item)))
      throw new TypeError('Invalid run status filter.');
  }
  const clauses = [];
  const params = [];
  if (taskId !== null) { clauses.push('task_id = ?'); params.push(taskId); }
  if (statuses) { clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`); params.push(...statuses); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM scheduled_task_runs ${where}
    ORDER BY scheduled_for DESC, created_at DESC LIMIT ? OFFSET ?`).all(...params, boundedLimit, boundedOffset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM scheduled_task_runs ${where}`).get(...params).count;
  return { runs: rows.map(runFromRow), total, limit: boundedLimit, offset: boundedOffset };
}

function nextOccurrenceFor(schedule, timezone, now) {
  if (schedule?.type === 'once') return Number.isSafeInteger(schedule.at) ? schedule.at : null;
  return scheduleCalc.computeNextOccurrence(schedule, timezone, now);
}

function createTaskRecord(input, { now = Date.now() } = {}) {
  assertPlainObject(input, 'Scheduled task');
  for (const key of Object.keys(input))
    if (!TASK_FIELDS.includes(key)) throw new TypeError(`Unknown scheduled-task field: ${key}.`);
  const timezone = normalizeTimezone(input.timezone);
  const schedule = normalizeScheduleSpec(input.schedule ?? input.recurrence, timezone, now);
  const model = normalizeModelRef(input.model ?? input.modelRef, { field: 'model' });
  const fallback = normalizeFallback(input.fallback);
  const missedPolicy = normalizeMissedPolicy(input.missedPolicy ?? input.catchup);
  const permissionMode = normalizePermissionMode(input.permissionMode);
  const budget = normalizeBudget(input.budget);
  const projectId = normalizeProjectId(input.projectId);
  const enabled = optionalBoolean(input.enabled, 'enabled') ?? true;
  const name = requiredString(input.name, 'name', { max: 200 });
  const prompt = requiredString(input.prompt, 'prompt', { max: 100_000, trim: false });
  const id = randomUUID();
  const nextRunAt = enabled ? nextOccurrenceFor(schedule, timezone, now) : null;
  db.prepare(`INSERT INTO scheduled_tasks
    (id, name, prompt, project_id, schedule_json, timezone, model_json, fallback_json,
     missed_policy_json, permission_mode, budget_json, enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, name, prompt, projectId, JSON.stringify(schedule), timezone, JSON.stringify(model),
    fallback.length ? JSON.stringify(fallback) : null, JSON.stringify(missedPolicy), permissionMode,
    budget ? JSON.stringify(budget) : null, enabled ? 1 : 0, nextRunAt, now, now,
  );
  return getTaskRecord(id);
}

function updateTaskRecord(id, patch, { now = Date.now() } = {}) {
  id = requireId(id);
  assertPlainObject(patch, 'Scheduled task update');
  for (const key of Object.keys(patch))
    if (!TASK_UPDATE_FIELDS.has(key)) throw new TypeError(`Unknown scheduled-task field: ${key}.`);
  const existingRow = getTaskRow(id);
  if (!existingRow) throw new Error('Scheduled task not found.');
  const existing = taskFromRow(existingRow);
  const scheduleChanged = Object.hasOwn(patch, 'schedule') || Object.hasOwn(patch, 'recurrence') ||
    Object.hasOwn(patch, 'timezone');
  const timezone = Object.hasOwn(patch, 'timezone') ? normalizeTimezone(patch.timezone) : existing.timezone;
  const schedule = normalizeScheduleSpec(
    Object.hasOwn(patch, 'schedule') ? patch.schedule
      : Object.hasOwn(patch, 'recurrence') ? patch.recurrence : existing.schedule,
    timezone, now,
  );
  const model = Object.hasOwn(patch, 'model') || Object.hasOwn(patch, 'modelRef')
    ? normalizeModelRef(patch.model ?? patch.modelRef, { field: 'model' })
    : existing.model;
  const fallback = Object.hasOwn(patch, 'fallback') ? normalizeFallback(patch.fallback) : existing.fallback;
  const missedPolicy = Object.hasOwn(patch, 'missedPolicy') || Object.hasOwn(patch, 'catchup')
    ? normalizeMissedPolicy(patch.missedPolicy ?? patch.catchup) : existing.missedPolicy;
  const permissionMode = Object.hasOwn(patch, 'permissionMode')
    ? normalizePermissionMode(patch.permissionMode) : existing.permissionMode;
  const budget = Object.hasOwn(patch, 'budget') ? normalizeBudget(patch.budget) : existing.budget;
  const projectId = Object.hasOwn(patch, 'projectId') ? normalizeProjectId(patch.projectId) : existing.projectId;
  const enabled = Object.hasOwn(patch, 'enabled')
    ? (optionalBoolean(patch.enabled, 'enabled') ?? existing.enabled) : existing.enabled;
  const name = Object.hasOwn(patch, 'name') ? requiredString(patch.name, 'name', { max: 200 }) : existing.name;
  const prompt = Object.hasOwn(patch, 'prompt')
    ? requiredString(patch.prompt, 'prompt', { max: 100_000, trim: false }) : existing.prompt;

  let nextRunAt = existing.nextRunAt;
  if (!enabled) nextRunAt = existing.nextRunAt;
  else if (scheduleChanged || (!existing.enabled && enabled)) nextRunAt = nextOccurrenceFor(schedule, timezone, now);

  const cancelledRunIds = [];
  if ((scheduleChanged || !enabled) && existingRow) {
    const rows = db.prepare(`SELECT id FROM scheduled_task_runs
      WHERE task_id = ? AND trigger = 'schedule' AND status IN ('deferred', 'queued')`).all(id);
    const cancel = db.prepare(`UPDATE scheduled_task_runs SET status = 'cancelled',
      finished_at = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND status IN ('deferred', 'queued')`);
    for (const row of rows) {
      if (cancel.run(now, scheduleChanged ? 'task-updated' : 'task-paused', now, row.id).changes)
        cancelledRunIds.push(row.id);
    }
  }

  db.prepare(`UPDATE scheduled_tasks SET name = ?, prompt = ?, project_id = ?, schedule_json = ?,
    timezone = ?, model_json = ?, fallback_json = ?, missed_policy_json = ?, permission_mode = ?,
    budget_json = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`).run(
    name, prompt, projectId, JSON.stringify(schedule), timezone, JSON.stringify(model),
    fallback.length ? JSON.stringify(fallback) : null, JSON.stringify(missedPolicy), permissionMode,
    budget ? JSON.stringify(budget) : null, enabled ? 1 : 0, nextRunAt, now, id,
  );
  return { task: getTaskRecord(id), cancelledRunIds };
}

function setTaskEnabledRecord(id, enabled, { now = Date.now() } = {}) {
  id = requireId(id);
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
  const row = getTaskRow(id);
  if (!row) throw new Error('Scheduled task not found.');
  const existing = taskFromRow(row);
  let nextRunAt = existing.nextRunAt;
  if (enabled && !existing.enabled)
    nextRunAt = nextOccurrenceFor(existing.schedule, existing.timezone, now);
  const cancelledRunIds = [];
  if (!enabled) {
    const rows = db.prepare(`SELECT id FROM scheduled_task_runs
      WHERE task_id = ? AND trigger = 'schedule' AND status IN ('deferred', 'queued')`).all(id);
    const cancel = db.prepare(`UPDATE scheduled_task_runs SET status = 'cancelled',
      finished_at = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND status IN ('deferred', 'queued')`);
    for (const run of rows) {
      if (cancel.run(now, 'task-paused', now, run.id).changes) cancelledRunIds.push(run.id);
    }
  }
  db.prepare('UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nextRunAt, now, id);
  return { task: getTaskRecord(id), cancelledRunIds };
}

function deleteTaskRecord(id) {
  id = requireId(id);
  const task = getTaskRecord(id);
  if (!task) throw new Error('Scheduled task not found.');
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  // Run history deliberately survives: the table has no cascading foreign key.
  return task;
}

function uniqueManualSlot(taskId, now) {
  let slot = now;
  const exists = db.prepare('SELECT 1 FROM scheduled_task_runs WHERE task_id = ? AND scheduled_for = ?');
  while (exists.get(taskId, slot)) slot++;
  return slot;
}

function insertRunRecord({
  taskId, scheduledFor, trigger = 'schedule', status = 'queued', sessionId = null,
  failureReason = null, model = null, fallbackUsed = false, usage = null,
  deferredUntil = null, startedAt = null, finishedAt = null, claimedAt = null,
  now = Date.now(),
} = {}) {
  taskId = requireId(taskId, 'taskId');
  if (!Number.isSafeInteger(scheduledFor)) throw new TypeError('A valid scheduled_for timestamp is required.');
  if (!TRIGGERS.includes(trigger)) throw new TypeError('Invalid run trigger.');
  if (!RUN_STATUSES.includes(status)) throw new TypeError('Invalid run status.');
  const id = randomUUID();
  const result = db.prepare(`INSERT OR IGNORE INTO scheduled_task_runs
    (id, task_id, session_id, scheduled_for, trigger, status, claimed_at, started_at, finished_at,
     failure_reason, model_json, fallback_used, usage_json, deferred_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, taskId, sessionId, scheduledFor, trigger, status, claimedAt, startedAt, finishedAt,
    boundedReason(failureReason), model ? JSON.stringify(model) : null, fallbackUsed ? 1 : 0,
    usage ? JSON.stringify(usage) : null, deferredUntil, now, now,
  );
  return result.changes ? getRunRecord(id) : null;
}

function createManualRunRecord(taskId, { now = Date.now() } = {}) {
  taskId = requireId(taskId, 'taskId');
  const task = getTaskRecord(taskId);
  if (!task) throw new Error('Scheduled task not found.');
  const scheduledFor = uniqueManualSlot(taskId, now);
  return insertRunRecord({ taskId, scheduledFor, trigger: 'manual', status: 'queued', now });
}

// ---------------------------------------------------------------------------
// Notification / event helpers
// ---------------------------------------------------------------------------

function defaultNotify(payload) {
  try {
    require('./services/notificationService').sendDesktopNotification(payload);
  } catch {
    // Notifications are advisory. A missing permission or unsupported platform
    // must never change the run outcome.
  }
}

function abortReason(code) {
  return Object.assign(new Error(code), { code, name: 'AbortError' });
}

function isTerminal(status) {
  return TERMINAL_RUN_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const DEFAULT_UNLOAD_IDLE_FOR_TASK = false; // opt-in only
const DEFAULT_SWAP_WAIT_MS = 10 * 60_000; // reuse modelLeaseWaitMs default

function createScheduler({
  tickMs = DEFAULT_TICK_MS,
  startupCap = DEFAULT_STARTUP_CAP,
  startupDeferMs = null,
  modelLeaseWaitMs = DEFAULT_MODEL_LEASE_WAIT_MS,
  modelReadyWaitMs = DEFAULT_MODEL_READY_WAIT_MS,
  modelReadyPollMs = DEFAULT_MODEL_READY_POLL_MS,
  modelRetryAttempts = 2,
  modelRetryDelayMs = 1_000,
  maxWallClockMs = DEFAULT_MAX_WALL_CLOCK_MS,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  runAgentTurn = null,
  launchModel = null,
  getLoadConfig = null,
  getEngineConfig = () => null,
  getEngines = () => [],
  getEngineLifecycle = () => null,
  waitForTurnLeases = waitForTurnLeasesToClear,
  prepareChatMessages = null,
  getOrCreateSession = null,
  updateSession = null,
  notify = defaultNotify,
  onRunEvent = () => {},
  logger = console,
  createAbortController = () => new AbortController(),
  isAppShuttingDown = () => false,
  unloadIdleForScheduledTask = DEFAULT_UNLOAD_IDLE_FOR_TASK,
  swapWaitMs = DEFAULT_SWAP_WAIT_MS,
  getScannedModels = () => new Map(),
  stopEngine = null,
} = {}) {
  if (!Number.isSafeInteger(tickMs) || tickMs < 1_000) throw new TypeError('tickMs must be at least 1000ms.');
  if (!Number.isSafeInteger(startupCap) || startupCap < 0) throw new TypeError('startupCap must be a non-negative integer.');
  if (!Number.isSafeInteger(modelRetryAttempts) || modelRetryAttempts < 1) throw new TypeError('modelRetryAttempts must be at least 1.');
  if (!Number.isSafeInteger(modelReadyWaitMs) || modelReadyWaitMs < 1_000) throw new TypeError('modelReadyWaitMs must be at least 1000ms.');
  if (!Number.isSafeInteger(modelReadyPollMs) || modelReadyPollMs < 1) throw new TypeError('modelReadyPollMs must be a positive integer.');
  if (!Number.isSafeInteger(maxWallClockMs) || maxWallClockMs < 1_000) throw new TypeError('maxWallClockMs must be at least 1000ms.');
  if (unloadIdleForScheduledTask !== true && unloadIdleForScheduledTask !== 'vram-pressure' && unloadIdleForScheduledTask !== false) {
    throw new TypeError('unloadIdleForScheduledTask must be true, "vram-pressure", or false.');
  }
  if (!Number.isSafeInteger(swapWaitMs) || swapWaitMs < 1_000) throw new TypeError('swapWaitMs must be at least 1000ms.');
  const deferMs = Number.isSafeInteger(startupDeferMs) && startupDeferMs >= 0 ? startupDeferMs : tickMs;
  const events = new EventEmitter();
  const activeRuns = new Map();
  const activeByTask = new Map();
  let timer = null;
  let started = false;
  let shuttingDown = false;
  let suspended = false;
  let tickPromise = null;
  let drainPromise = null;

  const runner = () => runAgentTurn ?? require('./agentTurnRunner').runAgentTurn;
  // Saved per-model load preferences ("Remember settings for this model") are
  // owned by the load settings dialog. Scheduled runs must start the model with
  // exactly those preferences instead of the bare defaults.
  const loadConfigFor = () => getLoadConfig ?? require('./configManager').getLoadConfig;
  const prepareMessages = () => prepareChatMessages ?? require('./promptBuilder').prepareChatMessages;
  const getOrCreate = () => getOrCreateSession ?? require('./sessionManager').getOrCreateSession;
  const updateSessionRecord = () => updateSession ?? require('./sessionManager').updateSession;

  function emit(type, payload = {}) {
    const event = { type, at: now(), ...payload };
    try { events.emit('event', event); } catch (error) {
      logger.error?.('[scheduled-tasks] event listener failed:', error?.message ?? error);
    }
    return event;
  }

  function emitTaskUpdated(task) {
    if (task) emit('task-updated', { task });
  }

  function emitRunUpdated(run) {
    if (run) emit('run-updated', { run });
  }

  function updateTaskLastStatus(taskId, status, at) {
    try {
      db.prepare(`UPDATE scheduled_tasks SET last_run_at = ?, last_status = ?, updated_at = ?
        WHERE id = ?`).run(at, status, at, taskId);
      emitTaskUpdated(getTaskRecord(taskId));
    } catch {
      // History can outlive its task; a missing task is a normal deletion race.
    }
  }

  function markRunTerminal(runId, status, reason, at) {
    db.prepare(`UPDATE scheduled_task_runs SET status = ?, finished_at = ?, failure_reason = ?,
      updated_at = ? WHERE id = ? AND status IN (${NON_TERMINAL_RUN_STATUSES.map(() => '?').join(',')})`)
      .run(status, at, boundedReason(reason), at, runId, ...NON_TERMINAL_RUN_STATUSES);
  }

  function finalizeRun(run, task, {
    status, reason = null, usage = null, model = null, fallbackUsed = false,
    sessionId = null, startedAt = null,
  }) {
    if (!RUN_STATUSES.includes(status)) throw new TypeError('Invalid final run status.');
    const at = now();
    const result = db.prepare(`UPDATE scheduled_task_runs SET status = ?, finished_at = ?,
      failure_reason = ?, usage_json = ?, model_json = ?, fallback_used = ?, session_id = COALESCE(?, session_id),
      started_at = COALESCE(?, started_at), updated_at = ?
      WHERE id = ? AND status IN (${NON_TERMINAL_RUN_STATUSES.map(() => '?').join(',')})`).run(
      status, at, boundedReason(reason), usage ? JSON.stringify(usage) : null,
      model ? JSON.stringify(model) : null, fallbackUsed ? 1 : 0, sessionId, startedAt, at,
      run.id, ...NON_TERMINAL_RUN_STATUSES,
    );
    if (!result.changes) {
      // A cancellation or shutdown already persisted a terminal state. Never
      // overwrite it with a later catch-path result.
      return getRunRecord(run.id);
    }
    if (task) updateTaskLastStatus(task.id, status, at);
    const updated = getRunRecord(run.id);
    emitRunUpdated(updated);
    return updated;
  }

  function notifyOutcome(task, run, status, reason) {
    const name = task?.name ?? 'Scheduled task';
    if (status === 'completed') {
      notify({ title: 'Scheduled task completed', body: `${name} finished.`, type: 'completion' });
    } else if (status === 'blocked') {
      notify({
        title: 'Scheduled task needs attention',
        body: `${name} stopped at an approval or input boundary. ${reason ?? ''}`.trim(),
        type: 'action_required',
      });
    } else if (status === 'failed' || status === 'interrupted' || status === 'skipped' || status === 'expired') {
      notify({
        title: `Scheduled task ${status}`,
        body: `${name}: ${reason ?? 'The run did not complete.'}`.slice(0, 500),
        type: 'error',
      });
    }
  }

  function updateRunProgress(run, status, reason = null) {
    if (!NON_TERMINAL_RUN_STATUSES.includes(status)) throw new TypeError('Invalid progress status.');
    const at = now();
    const result = db.prepare(`UPDATE scheduled_task_runs SET status = ?, failure_reason = ?,
      updated_at = ? WHERE id = ? AND status IN ('queued', 'waiting_for_model', 'waiting_for_lease', 'running')`)
      .run(status, boundedReason(reason), at, run.id);
    if (result.changes) emitRunUpdated(getRunRecord(run.id));
  }

  // -- Recovery / schedule evaluation --------------------------------------

  function recoverInterruptedRuns(at) {
    const rows = db.prepare(`SELECT * FROM scheduled_task_runs
      WHERE status IN ('running', 'waiting_for_model', 'waiting_for_lease')`).all();
    for (const row of rows) {
      if (activeRuns.has(row.id)) continue;
      markRunTerminal(row.id, 'interrupted', 'The application closed before the run finished.', at);
      const task = getTaskRecord(row.task_id);
      if (task) updateTaskLastStatus(task.id, 'interrupted', at);
      const run = getRunRecord(row.id);
      emitRunUpdated(run);
      notifyOutcome(task, run, 'interrupted', 'The application closed before the run finished.');
    }
  }

  function existingQueuedAutomaticCount() {
    return db.prepare(`SELECT COUNT(*) AS count FROM scheduled_task_runs
      WHERE status = 'queued' AND trigger = 'schedule'`).get().count;
  }

  function applyStartupCap(at) {
    const cap = Math.max(0, startupCap);
    const queued = db.prepare(`SELECT id FROM scheduled_task_runs
      WHERE status = 'queued' AND trigger = 'schedule' ORDER BY scheduled_for, created_at`).all();
    for (let index = cap; index < queued.length; index++) {
      const result = db.prepare(`UPDATE scheduled_task_runs SET status = 'deferred',
        failure_reason = 'startup-cap', deferred_until = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'`).run(at + deferMs, at, queued[index].id);
      if (result.changes) emitRunUpdated(getRunRecord(queued[index].id));
    }
    return Math.min(queued.length, cap);
  }

  function processDueTasks({ at, startup }) {
    const rows = db.prepare(`SELECT * FROM scheduled_tasks
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at, id`).all(at);
    if (!rows.length) return { enqueued: 0, recorded: 0 };

    const entries = [];
    const evaluations = [];
    for (const row of rows) {
      const task = taskFromRow(row);
      const policy = task.missedPolicy;
      let evaluation;
      try {
        evaluation = scheduleCalc.evaluateMissedOccurrences({
          schedule: task.schedule,
          timezone: task.timezone,
          nextRunAt: task.nextRunAt,
          now: at,
          policy: policy.policy,
          graceMs: policy.graceHours * 60 * 60 * 1000,
          maxOverdueMs: policy.maxOverdueDays * 24 * 60 * 60 * 1000,
        });
      } catch (error) {
        logger.error?.(`[scheduled-tasks] could not evaluate ${task.id}:`, error?.message ?? error);
        continue;
      }
      evaluations.push({ task, evaluation });
      for (const action of evaluation.actions) entries.push({ task, action, nextRunAt: evaluation.nextRunAt });
    }

    entries.sort((left, right) => left.action.scheduledFor - right.action.scheduledFor ||
      String(left.task.id).localeCompare(String(right.task.id)));

    let automaticBudget = startup ? Math.max(0, startupCap - existingQueuedAutomaticCount()) : Infinity;
    const prepared = [];
    for (const entry of entries) {
      const { task, action, nextRunAt } = entry;
      if (action.action === 'run') {
        const deferred = startup && automaticBudget <= 0;
        prepared.push({
          task, action, nextRunAt,
          status: deferred ? 'deferred' : 'queued',
          deferredUntil: deferred ? at + deferMs : null,
          failureReason: deferred ? 'startup-cap' : null,
        });
        if (!deferred) automaticBudget--;
      } else {
        prepared.push({
          task, action, nextRunAt,
          status: action.action,
          deferredUntil: null,
          failureReason: action.reason ?? null,
        });
      }
    }

    const inserted = [];
    const advanced = new Map();
    db.transaction(() => {
      for (const item of prepared) {
        const { task, action, nextRunAt } = item;
        const run = insertRunRecord({
          taskId: task.id,
          scheduledFor: action.scheduledFor,
          trigger: 'schedule',
          status: item.status,
          failureReason: item.failureReason,
          deferredUntil: item.deferredUntil,
          finishedAt: action.action === 'missed' || action.action === 'expired' ? at : null,
          now: at,
        });
        if (run) inserted.push({ run, task, action });
        const current = advanced.get(task.id);
        advanced.set(task.id, {
          task,
          nextRunAt: current ? current.nextRunAt : nextRunAt,
          lastStatus: current?.lastStatus ?? null,
          sawRun: Boolean(current?.sawRun || action.action === 'run'),
        });
        if (action.action !== 'run')
          advanced.get(task.id).lastStatus = action.action;
      }
      for (const [taskId, value] of advanced) {
        const lastStatus = value.sawRun ? null : value.lastStatus;
        db.prepare(`UPDATE scheduled_tasks SET next_run_at = ?, last_status = COALESCE(?, last_status),
          updated_at = ? WHERE id = ?`).run(value.nextRunAt, lastStatus, at, taskId);
      }
    }).immediate();

    const missedByTask = new Map();
    for (const item of inserted) {
      emitRunUpdated(item.run);
      emit('run-created', { run: item.run, task: item.task });
      if (item.action.action === 'missed' || item.action.action === 'expired') {
        const record = missedByTask.get(item.task.id) ?? { task: item.task, missed: 0, expired: 0 };
        if (item.action.action === 'missed') record.missed++;
        else record.expired++;
        missedByTask.set(item.task.id, record);
      }
    }
    for (const record of missedByTask.values()) {
      const parts = [];
      if (record.missed) parts.push(`${record.missed} missed`);
      if (record.expired) parts.push(`${record.expired} expired`);
      notify({
        title: 'Scheduled task missed',
        body: `${record.task.name}: ${parts.join(', ')} occurrence(s) were not executed.`,
        type: 'error',
      });
    }
    for (const value of advanced.values()) emitTaskUpdated(getTaskRecord(value.task.id));
    return { enqueued: inserted.filter(item => item.action.action === 'run').length, recorded: inserted.length };
  }

  function promoteDeferred(at) {
    const rows = db.prepare(`SELECT * FROM scheduled_task_runs
      WHERE status = 'deferred' AND (deferred_until IS NULL OR deferred_until <= ?)
      ORDER BY scheduled_for, created_at LIMIT ?`).all(at, Math.max(1, startupCap));
    let promoted = 0;
    for (const row of rows) {
      const task = getTaskRecord(row.task_id);
      if (!task) {
        markRunTerminal(row.id, 'cancelled', 'task-deleted', at);
        emitRunUpdated(getRunRecord(row.id));
        continue;
      }
      if (row.trigger === 'schedule' && !task.enabled) {
        markRunTerminal(row.id, 'cancelled', 'task-paused', at);
        emitRunUpdated(getRunRecord(row.id));
        continue;
      }
      const result = db.prepare(`UPDATE scheduled_task_runs SET status = 'queued',
        deferred_until = NULL, failure_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'deferred'`).run(at, row.id);
      if (result.changes) {
        promoted++;
        emitRunUpdated(getRunRecord(row.id));
      }
    }
    return promoted;
  }

  function claimNextQueued(at) {
    while (!shuttingDown && !isAppShuttingDown()) {
      const row = db.prepare(`SELECT * FROM scheduled_task_runs
        WHERE status = 'queued' ORDER BY scheduled_for, created_at LIMIT 1`).get();
      if (!row) return null;
      const task = getTaskRecord(row.task_id);
      if (!task) {
        markRunTerminal(row.id, 'cancelled', 'task-deleted', at);
        emitRunUpdated(getRunRecord(row.id));
        continue;
      }
      if (row.trigger === 'schedule' && !task.enabled) {
        markRunTerminal(row.id, 'cancelled', 'task-paused', at);
        emitRunUpdated(getRunRecord(row.id));
        continue;
      }
      const policy = task.missedPolicy;
      if (at - row.scheduled_for > policy.maxOverdueDays * 24 * 60 * 60 * 1000) {
        markRunTerminal(row.id, 'expired', `The scheduled time was more than ${policy.maxOverdueDays} day(s) overdue.`, at);
        updateTaskLastStatus(task.id, 'expired', at);
        const expired = getRunRecord(row.id);
        emitRunUpdated(expired);
        notifyOutcome(task, expired, 'expired', expired.failureReason);
        continue;
      }
      const claimed = db.prepare(`UPDATE scheduled_task_runs SET status = 'waiting_for_model',
        claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).run(at, at, row.id);
      if (!claimed.changes) continue;
      const run = getRunRecord(row.id);
      emitRunUpdated(run);
      return run;
    }
    return null;
  }

  // -- Model preparation ---------------------------------------------------

  function modelReady(ref) {
    if (ref.kind === 'cloud') {
      const target = require('./cloudProviders').validateChatProvider({
        type: 'cloud', provider: ref.provider, model: ref.modelId,
      });
      const chatModelId = `cloud:${ref.provider}:${ref.modelId}`;
      return {
        ok: true,
        ref,
        chatModelId,
        chatProvider: target,
        modelName: ref.modelId,
        model: { kind: 'cloud', provider: ref.provider, modelId: ref.modelId },
      };
    }
    const config = getEngineConfig(ref.modelPath);
    if (!config) return null;
    return {
      ok: true,
      ref,
      chatModelId: ref.modelPath,
      chatProvider: { type: 'local' },
      modelName: ref.modelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, ''),
      model: { kind: 'local', modelPath: ref.modelPath },
    };
  }

  async function waitRetry(signal) {
    if (!modelRetryDelayMs) return;
    await new Promise(resolve => {
      const timer = setTimeoutImpl(resolve, modelRetryDelayMs);
      const stop = () => { clearTimeoutImpl(timer); resolve(); };
      if (signal) {
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });
      }
    });
  }

  // A local load resolves as soon as the process spawns, not when the engine can
  // accept a request. Starting the turn against a still-warming engine makes the
  // context guard fall back to its conservative 8k capacity and reject an
  // otherwise valid prompt, so a scheduled run must wait for readiness. An
  // engine that exits during startup is reported as unavailable instead of
  // surfacing a misleading context error.
  function awaitEngineReady(ref, signal) {
    const maxAttempts = Math.max(1, Math.ceil(modelReadyWaitMs / modelReadyPollMs));
    return new Promise(resolve => {
      let attempts = 0;
      let timer = null;
      let settled = false;
      const finish = outcome => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutImpl(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({
        ok: false, reason: 'cancelled',
        detail: 'The run was cancelled while waiting for the model.',
      });
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const check = () => {
        const config = getEngineConfig(ref.modelPath);
        const status = config?.contextStatus;
        if (config && (status === undefined || status === null || status === 'ready'))
          return finish({ ok: true });
        if (config && status === 'warmup-failed')
          return finish({
            ok: false, reason: 'model_unavailable',
            detail: `The local model failed to warm up${config.warmupError ? `: ${config.warmupError}` : '.'}`,
          });
        if (!config)
          return finish({ ok: false, reason: 'model_unavailable', detail: 'The local engine exited while starting.' });
        if (attempts >= maxAttempts)
          return finish({ ok: false, reason: 'model_unavailable', detail: 'The model did not become ready in time.' });
        attempts++;
        timer = setTimeoutImpl(check, modelReadyPollMs);
      };
      check();
    });
  }

  // -- Model swap helper ---------------------------------------------------

  /**
   * Attempt to swap the currently loaded model for the task model.
   * Returns { ok: true, swappedOut: { modelPath, config, wasLoaded } }
   * or { ok: false, reason }.
   */
  async function trySwapForTaskModel(taskModelRef, signal) {
    // Only for local->local
    if (taskModelRef.kind !== 'local') {
      return { ok: false, reason: 'cloud-model-no-swap' };
    }
    const taskModelPath = taskModelRef.modelPath;

    // Find currently loaded local model
    let currentModelPath = null;
    let currentEntry = null;
    for (const entry of getEngines()) {
      if (entry && entry.childProcess) {
        currentModelPath = entry.modelPath;
        currentEntry = entry;
        break;
      }
    }

    // If no model loaded, nothing to swap
    if (!currentModelPath) {
      return { ok: false, reason: 'no-model-loaded' };
    }

    // If same model already loaded, no swap needed
    if (currentModelPath === taskModelPath) {
      return { ok: false, reason: 'same-model-loaded' };
    }

    // Get current model's saved config for restoration
    let currentConfig = {};
    let currentWasLoaded = true;
    try {
      const savedLoad = loadConfigFor()(currentModelPath) ?? {};
      currentConfig = savedLoad.remembered ? { ...savedLoad.config } : {};
      if (savedLoad.projectorPath !== undefined) {
        currentConfig.mmprojPath = savedLoad.projectorPath;
      }
    } catch (error) {
      logger.warn?.('[scheduled-tasks] could not read saved config for current model:', error?.message ?? error);
    }

    // Check VRAM: if task model fits alongside, no swap needed
    // (unless unloadIdleForScheduledTask === true which forces swap)
    if (unloadIdleForScheduledTask !== true) {
      const modelInfo = getScannedModels().get(taskModelPath) ?? { modelPath: taskModelPath };
      const taskEstimate = estimateOffloadRequirements({
        model: modelInfo,
        config: taskModelRef.config ?? {},
        projectorBytes: taskModelRef.config?.mmprojPath ? null : null,
      });
      if (taskEstimate.totalMiB !== null) {
        const memory = await queryGpuMemory();
        if (memory.available) {
          const fit = assessGpuFit({ estimate: taskEstimate, memory, safetyMarginMiB: DEFAULT_SAFETY_MARGIN_MIB });
          if (fit.status !== 'insufficient') {
            // Ample VRAM - load alongside without swap
            return { ok: false, reason: 'vram-sufficient' };
          }
        }
      }
    }

    // Check if current model has active turn lease
    if (currentEntry?.lifecycle?.hasActiveTurnLease) {
      // Wait for lease release (bounded by swapWaitMs)
      const leaseResult = await currentEntry.lifecycle.waitForTurnLeaseRelease({
        timeoutMs: swapWaitMs,
        signal,
      });
      if (!leaseResult.released) {
        if (leaseResult.aborted || signal?.aborted) {
          return { ok: false, reason: 'cancelled' };
        }
        if (leaseResult.timedOut) {
          return { ok: false, reason: 'vram_conflict' };
        }
        return { ok: false, reason: 'lease-wait-failed' };
      }
    }

    // Current model is idle - unload it
    if (typeof launchModel !== 'function' || typeof stopEngine !== 'function') {
      return { ok: false, reason: 'loader-unavailable' };
    }

    // Use stopEngine from main.js to unload the current model
    const stopResult = await stopEngine(currentModelPath, 'scheduled-task-swap', 'model-loader', false);
    if (!stopResult.success && !stopResult.deferred) {
      return { ok: false, reason: 'unload-failed', detail: stopResult.error };
    }
    if (stopResult.deferred) {
      // Should not happen since we waited for lease, but handle gracefully
      return { ok: false, reason: 'unload-deferred' };
    }

    // Wait for process to actually exit
    await new Promise((resolve) => {
      const check = () => {
        const entry = getEngineConfig(currentModelPath);
        if (!entry) return resolve();
        setTimeoutImpl(check, 100);
      };
      check();
    });

    return { ok: true, swappedOut: { modelPath: currentModelPath, config: currentConfig, wasLoaded: currentWasLoaded } };
  }

  async function prepareModelForTask(task, { signal, onStatus }) {
    const candidates = [task.model, ...(Array.isArray(task.fallback) ? task.fallback : [])];
    let last = { reason: 'model_unavailable', detail: 'No model is configured.' };
    for (let index = 0; index < candidates.length; index++) {
      if (shuttingDown || isAppShuttingDown()) return { ok: false, reason: 'cancelled' };
      if (signal?.aborted) return { ok: false, reason: 'cancelled' };
      const ref = candidates[index];
      const fallbackUsed = index > 0;
      if (ref.kind === 'cloud') {
        try {
          const ready = modelReady(ref);
          return { ...ready, fallbackUsed };
        } catch (error) {
          last = { reason: 'model_unavailable', detail: error?.message ?? 'Cloud provider is unavailable.' };
          continue;
        }
      }

      const already = modelReady(ref);
      if (already) {
        // The engine may still be warming from an earlier load. Never hand a
        // not-yet-ready engine to the turn; wait for it like a fresh load.
        const readiness = await awaitEngineReady(ref, signal);
        if (!readiness.ok) {
          last = { reason: readiness.reason ?? 'model_unavailable', detail: readiness.detail };
          if (last.reason === 'cancelled') return { ok: false, ...last };
          continue;
        }
        const ready = modelReady(ref);
        if (ready) return { ...ready, fallbackUsed };
        last = { reason: 'model_unavailable', detail: 'The model did not become available.' };
        continue;
      }

      onStatus?.('waiting_for_lease', fallbackUsed ? 'fallback-model-switch' : 'model-switch');
      const lease = await waitForTurnLeases({
        engines: getEngines,
        timeoutMs: modelLeaseWaitMs,
        signal,
        isCancelled: () => shuttingDown || isAppShuttingDown(),
      });
      if (!lease?.ok) {
        last = {
          reason: lease?.reason === 'cancelled' ? 'cancelled' : 'waiting_for_lease_timeout',
          detail: lease?.reason === 'cancelled'
            ? 'The run was cancelled while waiting for the model.'
            : 'The model is still in use by an active turn.',
        };
        if (last.reason === 'cancelled') return { ok: false, ...last };
        continue;
      }

      let swapResult = null;
      // Attempt model swap if configured and models differ
      if (unloadIdleForScheduledTask !== false && ref.kind === 'local') {
        swapResult = await trySwapForTaskModel(ref, signal);
        if (swapResult.ok) {
          // Swap successful - track for restoration
          onStatus?.('waiting_for_model', fallbackUsed ? 'fallback-load' : 'load');
        } else if (swapResult.reason === 'vram_conflict') {
          // Could not swap due to VRAM conflict - skip this model
          last = { reason: 'vram_conflict', detail: 'The model does not fit in available GPU memory and swap was not possible.' };
          break;
        } else if (swapResult.reason === 'cancelled') {
          return { ok: false, reason: 'cancelled' };
        }
        // For other reasons (vram-sufficient, same-model-loaded, no-model-loaded, etc.),
        // continue with normal load behavior
      }

      if (typeof launchModel !== 'function') {
        last = { reason: 'model_unavailable', detail: 'The local model loader is unavailable.' };
        continue;
      }

      onStatus?.('waiting_for_model', fallbackUsed ? 'fallback-load' : 'load');
      // Use the preferences saved from the load settings dialog. An explicit
      // per-task config still wins, and an absent saved config falls back to
      // the loader's defaults. `rememberSettings` is deliberately omitted so
      // the load does not rewrite or forget the user's saved preferences.
      let savedLoad = {};
      try {
        savedLoad = loadConfigFor()(ref.modelPath) ?? {};
      } catch (error) {
        logger.warn?.('[scheduled-tasks] could not read saved model settings:', error?.message ?? error);
      }
      const launchOptions = {
        ...(savedLoad.remembered ? savedLoad.config : {}),
        ...(savedLoad.projectorPath !== undefined ? { mmprojPath: savedLoad.projectorPath } : {}),
        ...(ref.config ?? {}),
        ...(ref.config?.allowPartialOffload === undefined ? { allowPartialOffload: false } : {}),
      };
      for (let attempt = 0; attempt < Math.max(1, modelRetryAttempts); attempt++) {
        if (signal?.aborted || shuttingDown || isAppShuttingDown()) return { ok: false, reason: 'cancelled' };
        let result;
        try {
          result = await launchModel(ref.modelPath, launchOptions);
        } catch (error) {
          result = { success: false, error: error?.message ?? 'Model load failed.' };
        }
        if (result?.success) {
          // The process spawned, but the engine may still be loading. Starting
          // the turn now would let the context guard fall back to 8k and reject
          // a prompt that actually fits the configured context.
          const readiness = await awaitEngineReady(ref, signal);
          if (!readiness.ok) {
            last = { reason: readiness.reason ?? 'model_unavailable', detail: readiness.detail };
            if (last.reason === 'cancelled') return { ok: false, ...last };
            break;
          }
          const ready = modelReady(ref);
          if (ready) return { ...ready, fallbackUsed, swappedOut: swapResult?.swappedOut ?? null };
          last = { reason: 'model_unavailable', detail: 'The model did not become available after loading.' };
          break;
        }
        if (result?.requiresConfirmation) {
          last = { reason: 'vram_conflict', detail: 'The model does not fit in available GPU memory.' };
          break;
        }
        if (result?.deferred) {
          last = {
            reason: 'waiting_for_lease_timeout',
            detail: result.error ?? 'The model was in use by an active turn.',
          };
          break;
        }
        last = { reason: 'model_unavailable', detail: result?.error ?? 'The model could not be loaded.' };
        if (attempt + 1 < modelRetryAttempts) await waitRetry(signal);
      }
    }
    return { ok: false, ...last };
  }

  // -- Execution -----------------------------------------------------------

  function handleAgentEvent(active, event) {
    const channel = event?.channel;
    const payload = event?.payload;
    onRunEvent({ runId: active.run.id, taskId: active.task.id, sessionId: active.sessionId, ...event });
    if (!payload || payload.resolved) return;
    if (channel === 'engine:request-tool-approval') {
      active.approvalBlocked = {
        reason: 'approval_required',
        detail: `Tool approval required${payload.name ? ` for ${payload.name}` : ''}.`,
      };
      active.controller.abort(abortReason('approval-required'));
    } else if (channel === 'engine:ask-user') {
      active.approvalBlocked = { reason: 'user_input_required', detail: 'The agent asked for user input.' };
      active.controller.abort(abortReason('user-input-required'));
    } else if (channel === 'engine:tool-limit-reached') {
      active.approvalBlocked = { reason: 'tool_limit_reached', detail: 'The agent reached the tool-call limit.' };
      active.controller.abort(abortReason('tool-limit-reached'));
    } else if (channel === 'loop:paused') {
      if (payload.executionState === 'running') return;
      active.approvalBlocked = { reason: 'loop_paused', detail: 'The agent paused for a decision.' };
      active.controller.abort(abortReason('loop-paused'));
    }
  }

  async function executeRun(run) {
    const taskRow = getTaskRow(run.taskId);
    const task = taskFromRow(taskRow);
    if (!task) {
      finalizeRun(run, null, { status: 'cancelled', reason: 'task-deleted' });
      return;
    }
    if (run.trigger === 'schedule' && !task.enabled) {
      finalizeRun(run, task, { status: 'cancelled', reason: 'task-paused' });
      return;
    }
    if (shuttingDown || isAppShuttingDown()) {
      finalizeRun(run, task, { status: 'interrupted', reason: 'The application is shutting down.' });
      return;
    }

    const controller = createAbortController();
    const active = {
      run, task, controller, sessionId: null, startedAt: null,
      cancelled: false, cancelledReason: null, timedOut: false, approvalBlocked: null,
    };
    activeRuns.set(run.id, active);
    if (!activeByTask.has(task.id)) activeByTask.set(task.id, new Set());
    activeByTask.get(task.id).add(run.id);

    const budget = task.budget ?? {};
    const timeoutMs = budget.maxWallClockMs ?? maxWallClockMs;
    const timeout = setTimeoutImpl(() => {
      active.timedOut = true;
      controller.abort(abortReason('scheduled-task-timeout'));
    }, timeoutMs);
    let lease = null;
    let model = null;
    let fallbackUsed = false;
    let swappedOutModel = null;
    try {
      updateRunProgress(run, 'waiting_for_model');
      const prepared = await prepareModelForTask(task, {
        signal: controller.signal,
        onStatus: (status, reason) => {
          if (shuttingDown || controller.signal.aborted) return;
          updateRunProgress(run, status, reason);
        },
      });
      if (!prepared.ok) {
        const status = prepared.reason === 'vram_conflict' || prepared.reason === 'model_unavailable'
          ? 'skipped'
          : prepared.reason === 'cancelled' ? 'cancelled' : 'blocked';
        const result = finalizeRun(run, task, { status, reason: prepared.detail ?? prepared.reason });
        notifyOutcome(task, result, status, result?.failureReason);
        return;
      }
      model = prepared.model;
      fallbackUsed = prepared.fallbackUsed;
      swappedOutModel = prepared.swappedOut ?? null;
      active.model = model;
      active.fallbackUsed = fallbackUsed;
      active.swappedModel = swappedOutModel;

      if (shuttingDown || isAppShuttingDown()) {
        finalizeRun(run, task, { status: 'interrupted', reason: 'The application is shutting down.' });
        return;
      }

      // The model is ready. Pin it for the handoff into the agent turn, then
      // let the normal chat turn acquire its own nested lease. The pin is
      // released in the finally block on every path.
      if (prepared.ref.kind === 'local')
        lease = getEngineLifecycle?.(prepared.ref.modelPath)?.acquireTurnLease?.() ?? null;

      const sessionId = `scheduled-${run.id}`;
      active.sessionId = sessionId;
      getOrCreate()(sessionId, prepared.chatModelId, task.projectId);
      try { updateSessionRecord()(sessionId, 'title', `Scheduled: ${task.name}`); } catch { /* title is cosmetic */ }
      const messages = prepareMessages()({
        sessionId,
        modelId: prepared.chatModelId,
        userText: task.prompt,
      });
      if (shuttingDown || isAppShuttingDown()) {
        finalizeRun(run, task, { status: 'interrupted', reason: 'The application is shutting down.', sessionId });
        return;
      }

      const startedAt = now();
      active.startedAt = startedAt;
      const running = db.prepare(`UPDATE scheduled_task_runs SET status = 'running', started_at = ?,
        session_id = ?, model_json = ?, fallback_used = ?, updated_at = ?
        WHERE id = ? AND status IN ('claimed', 'waiting_for_model', 'waiting_for_lease')`).run(
        startedAt, sessionId, JSON.stringify(model), fallbackUsed ? 1 : 0, startedAt, run.id,
      );
      if (!running.changes) {
        // Cancelled between preparation and the final claim.
        return;
      }
      emitRunUpdated(getRunRecord(run.id));

      const request = {
        requestId: run.id,
        modelId: prepared.chatModelId,
        messages,
        sessionId,
        displayName: `Scheduled: ${task.name}`,
        modelName: prepared.modelName,
        activeChatProvider: prepared.chatProvider,
        permissionMode: task.permissionMode,
        messageId: run.id,
      };
      let result;
      let failure = null;
      try {
        result = await runner()(request, {
          signal: controller.signal,
          onEvent: event => handleAgentEvent(active, event),
        });
      } catch (error) {
        failure = error;
      }

      if (active.approvalBlocked) {
        const reason = `${active.approvalBlocked.reason}: ${active.approvalBlocked.detail}`;
        const finished = finalizeRun(run, task, {
          status: 'blocked', reason, usage: result?.stats ?? null, model,
          fallbackUsed, sessionId, startedAt,
        });
        notifyOutcome(task, finished, 'blocked', reason);
        return;
      }
      if (active.timedOut) {
        const reason = `The run exceeded its ${Math.round(timeoutMs / 1000)} second budget.`;
        const finished = finalizeRun(run, task, {
          status: 'failed', reason, usage: result?.stats ?? null, model,
          fallbackUsed, sessionId, startedAt,
        });
        notifyOutcome(task, finished, 'failed', reason);
        return;
      }
      if (active.cancelled || controller.signal.aborted) {
        const reason = active.cancelledReason ?? (shuttingDown || isAppShuttingDown()
          ? 'The application is shutting down.'
          : 'The run was cancelled.');
        const status = shuttingDown || isAppShuttingDown() ? 'interrupted' : 'cancelled';
        const finished = finalizeRun(run, task, {
          status, reason, usage: result?.stats ?? null, model, fallbackUsed, sessionId, startedAt,
        });
        if (status === 'interrupted') notifyOutcome(task, finished, status, reason);
        return;
      }
      if (failure) {
        const reason = failure?.name === 'AbortError'
          ? 'The run was cancelled.'
          : (failure?.message ?? 'The agent turn failed.');
        const status = failure?.name === 'AbortError' ? 'cancelled' : 'failed';
        const finished = finalizeRun(run, task, {
          status, reason, usage: result?.stats ?? null, model, fallbackUsed, sessionId, startedAt,
        });
        notifyOutcome(task, finished, status, reason);
        return;
      }
      const interrupted = result?.message?.status === 'interrupted' || result?.incompleteTask;
      const status = interrupted ? 'interrupted' : 'completed';
      const reason = interrupted ? 'The agent turn was interrupted before it completed.' : null;
      const finished = finalizeRun(run, task, {
        status, reason, usage: result?.stats ?? null, model, fallbackUsed, sessionId, startedAt,
      });
      notifyOutcome(task, finished, status, reason);
    } catch (error) {
      const reason = error?.message ?? 'The scheduled run failed.';
      const status = shuttingDown || isAppShuttingDown() ? 'interrupted'
        : error?.name === 'AbortError' ? 'cancelled' : 'failed';
      const finished = finalizeRun(run, task, {
        status, reason, model, fallbackUsed, sessionId: active.sessionId, startedAt: active.startedAt,
      });
      notifyOutcome(task, finished, status, reason);
    } finally {
      clearTimeoutImpl(timeout);
      try { lease?.release?.(); } catch { /* idempotent */ }
      
      // Restore swapped model if needed
      if (active.swappedModel && active.swappedModel.wasLoaded) {
        const { modelPath: prevModelPath, config: prevConfig } = active.swappedModel;
        // Check if the previous model is still unloaded (not reloaded by something else)
        const prevEntry = getEngineConfig(prevModelPath);
        if (!prevEntry) {
          try {
            // Reload the previous model with its saved config
            const launchOptions = {
              ...prevConfig,
              ...(prevConfig.mmprojPath !== undefined ? { mmprojPath: prevConfig.mmprojPath } : {}),
              // Don't rewrite saved settings
              rememberSettings: undefined,
            };
            if (typeof launchModel === 'function') {
              const reloadResult = await launchModel(prevModelPath, launchOptions);
              if (!reloadResult?.success) {
                logger.warn?.(`[scheduled-tasks] failed to restore previous model ${prevModelPath}:`, reloadResult?.error);
              }
            }
          } catch (restoreError) {
            logger.warn?.(`[scheduled-tasks] error restoring previous model ${prevModelPath}:`, restoreError?.message ?? restoreError);
          }
        }
        // If previous model was already reloaded by something else, don't interfere
      }
      activeRuns.delete(run.id);
      const taskRuns = activeByTask.get(task.id);
      if (taskRuns) {
        taskRuns.delete(run.id);
        if (!taskRuns.size) activeByTask.delete(task.id);
      }
    }
  }

  async function drain() {
    if (shuttingDown || isAppShuttingDown()) return drainPromise;
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      while (!shuttingDown && !isAppShuttingDown()) {
        const run = claimNextQueued(now());
        if (!run) break;
        try {
          await require('./dataAccess').withDataAccess(() => executeRun(run));
        } catch (error) {
          logger.error?.('[scheduled-tasks] run execution failed:', error?.message ?? error);
        }
      }
    })().finally(() => { drainPromise = null; });
    return drainPromise;
  }

  async function tick({ startup = false, reason = 'tick', awaitDrain = false } = {}) {
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      if (shuttingDown || isAppShuttingDown()) return { skipped: true, reason: 'shutdown' };
      if (suspended) return { skipped: true, reason: 'suspended' };
      const at = now();
      let result;
      try {
        result = await require('./dataAccess').withDataAccess(() => {
          if (startup) {
            recoverInterruptedRuns(at);
            applyStartupCap(at);
          }
          const processed = processDueTasks({ at, startup });
          if (!startup) promoteDeferred(at);
          return processed;
        });
      } catch (error) {
        logger.error?.('[scheduled-tasks] tick failed:', error?.message ?? error);
        return { failed: true, reason };
      }
      if (awaitDrain) await drain();
      else void drain().catch(error => logger.error?.('[scheduled-tasks] drain failed:', error?.message ?? error));
      emit('tick', { startup, reason, at, ...result });
      return result;
    })().finally(() => { tickPromise = null; });
    return tickPromise;
  }

  async function waitForIdle() {
    while (tickPromise || drainPromise) {
      if (drainPromise) await drainPromise;
      else if (tickPromise) await tickPromise;
      await Promise.resolve();
    }
  }

  async function start() {
    if (started) return api;
    started = true;
    shuttingDown = false;
    await tick({ startup: true, reason: 'startup' });
    if (timer === null) {
      timer = setIntervalImpl(() => {
        void tick({ reason: 'interval' }).catch(error =>
          logger.error?.('[scheduled-tasks] interval tick failed:', error?.message ?? error));
      }, tickMs);
      timer?.unref?.();
    }
    emit('scheduler-started', { tickMs, startupCap });
    return api;
  }

  function markInterruptedSync(reason = 'app-shutdown') {
    if (shuttingDown && !activeRuns.size) return;
    shuttingDown = true;
    if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    const at = now();
    for (const active of [...activeRuns.values()]) {
      active.cancelled = true;
      active.cancelledReason = reason;
      try {
        markRunTerminal(active.run.id, 'interrupted', 'The application closed before the run finished.', at);
        if (active.task) updateTaskLastStatus(active.task.id, 'interrupted', at);
        emitRunUpdated(getRunRecord(active.run.id));
      } catch { /* shutdown is best-effort; history may already be closed */ }
      try { active.controller.abort(abortReason('app-shutdown')); } catch { /* noop */ }
    }
  }

  async function stop({ reason = 'app-shutdown', timeoutMs = 10_000 } = {}) {
    shuttingDown = true;
    if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    const at = now();
    for (const active of [...activeRuns.values()]) {
      active.cancelled = true;
      active.cancelledReason = reason;
      const status = reason === 'app-shutdown' ? 'interrupted' : 'cancelled';
      try {
        markRunTerminal(active.run.id, status, reason === 'app-shutdown'
          ? 'The application closed before the run finished.' : reason, at);
        if (active.task) updateTaskLastStatus(active.task.id, status, at);
        emitRunUpdated(getRunRecord(active.run.id));
      } catch { /* best-effort */ }
      try { active.controller.abort(abortReason(reason === 'app-shutdown' ? 'app-shutdown' : 'cancelled')); } catch { /* noop */ }
    }
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      await Promise.race([
        waitForIdle(),
        new Promise(resolve => setTimeoutImpl(resolve, timeoutMs)),
      ]);
    }
    started = false;
    emit('scheduler-stopped', { reason });
  }

  function forceTick(reason = 'manual') {
    return tick({ reason });
  }

  function handleSuspend() {
    suspended = true;
    emit('scheduler-suspended');
  }

  function handleResume() {
    suspended = false;
    return tick({ reason: 'power-resume' });
  }

  // -- Public task API -----------------------------------------------------

  function createTask(input) {
    const task = createTaskRecord(input, { now: now() });
    emitTaskUpdated(task);
    emit('task-created', { task });
    if (started && !shuttingDown) void tick({ reason: 'task-created' });
    return task;
  }

  function updateTask(id, patch) {
    const { task, cancelledRunIds } = updateTaskRecord(id, patch, { now: now() });
    for (const runId of cancelledRunIds) emitRunUpdated(getRunRecord(runId));
    emitTaskUpdated(task);
    if (started && !shuttingDown) void tick({ reason: 'task-updated' });
    return task;
  }

  function pauseTask(id) {
    const { task, cancelledRunIds } = setTaskEnabledRecord(id, false, { now: now() });
    for (const runId of cancelledRunIds) emitRunUpdated(getRunRecord(runId));
    emitTaskUpdated(task);
    return task;
  }

  function resumeTask(id) {
    const { task } = setTaskEnabledRecord(id, true, { now: now() });
    emitTaskUpdated(task);
    if (started && !shuttingDown) void tick({ reason: 'task-resumed' });
    return task;
  }

  function cancelRunById(runId, reason = 'user-cancelled', at = now()) {
    runId = requireId(runId, 'runId');
    const row = getRunRow(runId);
    if (!row) throw new Error('Scheduled run not found.');
    const active = activeRuns.get(runId);
    if (active) {
      active.cancelled = true;
      active.cancelledReason = reason;
      try { active.controller.abort(abortReason(reason)); } catch { /* noop */ }
    }
    if (!isTerminal(row.status)) {
      markRunTerminal(runId, 'cancelled', reason, at);
      if (row.task_id) updateTaskLastStatus(row.task_id, 'cancelled', at);
      emitRunUpdated(getRunRecord(runId));
    }
    return getRunRecord(runId);
  }

  function cancelTaskRuns(taskId, { reason = 'user-cancelled', includeRunning = true, onlyAutomatic = false, at = now() } = {}) {
    taskId = requireId(taskId, 'taskId');
    const rows = db.prepare(`SELECT * FROM scheduled_task_runs WHERE task_id = ?
      AND status IN (${NON_TERMINAL_RUN_STATUSES.map(() => '?').join(',')})`)
      .all(taskId, ...NON_TERMINAL_RUN_STATUSES);
    const cancelled = [];
    for (const row of rows) {
      if (!includeRunning && row.status === 'running') continue;
      if (onlyAutomatic && row.trigger !== 'schedule') continue;
      cancelled.push(cancelRunById(row.id, reason, at));
    }
    return cancelled;
  }

  function deleteTask(id) {
    id = requireId(id);
    const task = getTaskRecord(id);
    if (!task) throw new Error('Scheduled task not found.');
    cancelTaskRuns(id, { reason: 'task-deleted', includeRunning: true });
    deleteTaskRecord(id);
    emit('task-deleted', { taskId: id, task });
    return { deleted: true, id };
  }

  function runNow(id) {
    id = requireId(id);
    const run = createManualRunRecord(id, { now: now() });
    if (!run) throw new Error('Could not enqueue the scheduled run.');
    emit('run-created', { run, task: getTaskRecord(id) });
    emitRunUpdated(run);
    // Manual runs are explicit user intent, so they do not wait for the
    // scheduler interval or for start() to have been called. They still must
    // never execute during shutdown.
    if (!shuttingDown && !isAppShuttingDown()) void drain().catch(error =>
      logger.error?.('[scheduled-tasks] manual drain failed:', error?.message ?? error));
    return run;
  }

  function cancelRun(input = {}) {
    assertPlainObject(input, 'cancel request');
    if (typeof input.runId === 'string' && input.runId) return cancelRunById(input.runId);
    if (typeof input.taskId === 'string' && input.taskId) {
      const runs = cancelTaskRuns(input.taskId, { includeRunning: true, reason: 'user-cancelled' });
      return { runs };
    }
    throw new TypeError('Provide a runId or taskId to cancel.');
  }

  const api = {
    // store
    listTasks: listTaskRecords,
    getTask: getTaskRecord,
    listRuns: listRunRecords,
    getRun: getRunRecord,
    createTask,
    updateTask,
    pauseTask,
    resumeTask,
    deleteTask,
    runNow,
    cancelRun,
    cancelTaskRuns,
    // scheduler lifecycle
    start,
    stop,
    forceTick,
    handleSuspend,
    handleResume,
    tick,
    drain,
    waitForIdle,
    markInterruptedSync,
    isRunning: () => started && !shuttingDown,
    isShuttingDown: () => shuttingDown,
    get activeRunCount() { return activeRuns.size; },
    events,
    // exposed for focused diagnostics/tests
    _internal: {
      processDueTasks, promoteDeferred, claimNextQueued, prepareModelForTask,
      taskFromRow, runFromRow,
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Module-level singleton helpers used by main.js
// ---------------------------------------------------------------------------

let singleton = null;

function startScheduledTasks(options = {}) {
  if (singleton) return singleton;
  singleton = createScheduler(options);
  void singleton.start().catch(error =>
    console.error('[scheduled-tasks] scheduler start failed:', error?.message ?? error));
  return singleton;
}

async function stopScheduledTasks(options = {}) {
  const scheduler = singleton;
  singleton = null;
  if (scheduler) await scheduler.stop(options);
}

function getScheduledTasks() {
  return singleton;
}

module.exports = {
  createScheduler,
  startScheduledTasks,
  stopScheduledTasks,
  getScheduledTasks,
  // store-level helpers (also useful to focused tests)
  listTaskRecords,
  getTaskRecord,
  listRunRecords,
  getRunRecord,
  createTaskRecord,
  updateTaskRecord,
  setTaskEnabledRecord,
  deleteTaskRecord,
  insertRunRecord,
  createManualRunRecord,
  taskFromRow,
  runFromRow,
  TERMINAL_RUN_STATUSES,
  NON_TERMINAL_RUN_STATUSES,
  RUN_STATUSES,
};

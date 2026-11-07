'use strict';

// Pure, dependency-free schedule math for scheduled tasks.
//
// All instants crossing this module are UTC epoch milliseconds. Recurrence is
// expressed as a local wall-clock time in an IANA timezone. Nothing here reads
// Electron, SQLite, the clock or the filesystem, so it is fully unit-testable.
//
// DST rules:
//   - spring-forward nonexistent wall times execute at the first valid instant
//     at or after the intended wall time (e.g. 02:30 -> 03:00);
//   - fall-back ambiguous wall times execute once, at the first occurrence.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OVERDUE_MS = 7 * DAY_MS;
const MAX_OCCURRENCES = 400;

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function assertTimezone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 100 || timeZone.includes('\0'))
    throw new TypeError('A valid IANA timezone is required.');
  try {
    getFormatter(timeZone).formatToParts(new Date(0));
  } catch {
    throw new TypeError('Invalid IANA timezone.');
  }
  return timeZone;
}

function wallClockAt(instantMs, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(new Date(instantMs));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  // Some Intl builds report midnight as hour 24 with h23.
  const hour = values.hour === 24 ? 0 : values.hour;
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour,
    minute: values.minute,
    second: values.second,
    weekday: new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay(),
  };
}

function offsetAt(instantMs, timeZone) {
  const wall = wallClockAt(instantMs, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const wholeSeconds = instantMs - (((instantMs % 1000) + 1000) % 1000);
  return wallAsUtc - wholeSeconds;
}

function sameWall(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === (b.second ?? 0);
}

function compareWall(a, b) {
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
    const left = a[key] ?? 0;
    const right = b[key] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * Resolve a local wall-clock time to the first valid UTC instant at or after it.
 * Returns epoch ms. Throws only for invalid input / timezone.
 */
function wallTimeToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  assertTimezone(timeZone);
  const intended = { year, month, day, hour, minute, second };
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(intendedUtc)) throw new TypeError('Invalid wall-clock time.');

  // Probe a wide window so offsets for very large UTC offsets are included.
  const offsets = new Set();
  for (const delta of [-30, -12, 0, 12, 30]) {
    offsets.add(offsetAt(intendedUtc + delta * 60 * 60 * 1000, timeZone));
  }
  const matches = [];
  for (const offset of offsets) {
    const candidate = intendedUtc - offset;
    if (sameWall(wallClockAt(candidate, timeZone), intended)) matches.push(candidate);
  }
  if (matches.length) return Math.min(...matches);

  // Nonexistent wall time (spring forward): scan for the first instant whose
  // local clock is at or after the intended wall time. The scan is bounded to
  // one day around the intended time, which is far wider than any DST gap.
  const start = intendedUtc - 12 * 60 * 60 * 1000;
  for (let step = 0; step <= 24 * 60; step++) {
    const candidate = start + step * MINUTE_MS;
    if (compareWall(wallClockAt(candidate, timeZone), intended) >= 0) return candidate;
  }
  throw new Error('Could not resolve the local wall time in this timezone.');
}

function normalizeTimeOfDay(value) {
  if (typeof value !== 'string') throw new TypeError('Schedule time of day is required.');
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new TypeError('Schedule time of day must be HH:MM.');
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function parseTimeOfDay(value) {
  const normalized = normalizeTimeOfDay(value);
  const [hour, minute] = normalized.split(':').map(Number);
  return { hour, minute };
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}

function startInstant(raw, timeZone, atTime, now) {
  if (raw === undefined || raw === null || raw === '') return now;
  if (Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    const time = parseTimeOfDay(atTime);
    return wallTimeToInstant({ year, month, day, hour: time.hour, minute: time.minute, second: 0 }, timeZone);
  }
  throw new TypeError('Schedule start must be an epoch timestamp or YYYY-MM-DD date.');
}

/**
 * Validate and normalize a schedule spec. The returned object is safe to store.
 */
function normalizeSchedule(input, { timezone, now = Date.now() } = {}) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new TypeError('Invalid schedule JSON.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('A schedule object is required.');
  assertTimezone(timezone);

  const type = input.type ?? input.kind;
  if (type === 'once') {
    const at = input.at ?? input.atMs ?? input.timestamp;
    if (!Number.isSafeInteger(at) || at <= 0) throw new TypeError('One-time schedules require a valid UTC timestamp.');
    return { type: 'once', at };
  }
  if (!['daily', 'every_n_days', 'weekdays'].includes(type))
    throw new TypeError('Schedule type must be once, daily, every_n_days, or weekdays.');

  const atTime = normalizeTimeOfDay(input.atTime ?? input.timeOfDay);
  const startAt = startInstant(input.startAt ?? input.startDate, timezone, atTime, now);
  const endAt = input.endAt ?? input.endDate;
  if (endAt !== undefined && endAt !== null && (!Number.isSafeInteger(endAt) || endAt <= 0))
    throw new TypeError('Schedule end must be a valid UTC timestamp.');

  const normalized = { type, atTime, startAt, ...(endAt != null ? { endAt } : {}) };
  if (type === 'every_n_days') {
    const intervalDays = integer(input.intervalDays ?? input.everyNDays, 'Schedule interval', { min: 1, max: 3650 });
    normalized.intervalDays = intervalDays;
  }
  if (type === 'weekdays') {
    const weekdays = input.weekdays;
    if (!Array.isArray(weekdays) || !weekdays.length) throw new TypeError('Select at least one weekday.');
    const unique = [...new Set(weekdays)];
    if (unique.some(day => !Number.isInteger(day) || day < 0 || day > 6))
      throw new TypeError('Weekdays must be integers from 0 (Sunday) to 6 (Saturday).');
    normalized.weekdays = unique.sort((a, b) => a - b);
  }
  return normalized;
}

/**
 * First occurrence strictly after `afterMs`, or null when the schedule ends.
 */
function computeNextOccurrence(schedule, timezone, afterMs) {
  const normalized = normalizeSchedule(schedule, { timezone, now: 0 });
  if (normalized.type === 'once') return normalized.at > afterMs ? normalized.at : null;

  assertTimezone(timezone);
  const time = parseTimeOfDay(normalized.atTime);
  const startWall = wallClockAt(normalized.startAt, timezone);
  const startDateUtc = Date.UTC(startWall.year, startWall.month - 1, startWall.day);
  const afterWall = wallClockAt(afterMs, timezone);
  const afterDateUtc = Date.UTC(afterWall.year, afterWall.month - 1, afterWall.day);

  // Day-by-day iteration is intentionally simple: supported recurrences never
  // need sub-day arithmetic, and the bound prevents a malformed schedule from
  // spinning forever.
  for (let offset = 0; offset <= 3660; offset++) {
    const dayUtc = afterDateUtc + offset * DAY_MS;
    const date = new Date(dayUtc);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (dayUtc < startDateUtc) continue;
    const weekday = date.getUTCDay();
    if (normalized.type === 'weekdays' && !normalized.weekdays.includes(weekday)) continue;
    if (normalized.type === 'every_n_days') {
      const dayDifference = Math.round((dayUtc - startDateUtc) / DAY_MS);
      if (dayDifference < 0 || dayDifference % normalized.intervalDays !== 0) continue;
    }
    const candidate = wallTimeToInstant({ year, month, day, hour: time.hour, minute: time.minute, second: 0 }, timezone);
    if (candidate <= afterMs) continue;
    if (normalized.endAt != null && candidate > normalized.endAt) return null;
    return candidate;
  }
  return null;
}

/**
 * Enumerate occurrences from nextRunAt through now and classify each one under
 * the task's missed-execution policy. Pure and deterministic.
 *
 * Returns:
 *   actions: [{ scheduledFor, action: 'run'|'missed'|'expired', reason }]
 *   nextRunAt: first occurrence after now (or null)
 */
function evaluateMissedOccurrences({
  schedule,
  timezone,
  nextRunAt,
  now,
  policy = 'grace',
  graceMs = DEFAULT_GRACE_MS,
  maxOverdueMs = DEFAULT_MAX_OVERDUE_MS,
} = {}) {
  if (!Number.isSafeInteger(nextRunAt) || nextRunAt <= 0) throw new TypeError('A valid next run timestamp is required.');
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('A valid current timestamp is required.');
  if (!['grace', 'skip', 'catch_up'].includes(policy)) throw new TypeError('Invalid missed-execution policy.');
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError('Invalid grace period.');
  if (!Number.isFinite(maxOverdueMs) || maxOverdueMs < 0) throw new TypeError('Invalid maximum overdue age.');

  const normalized = normalizeSchedule(schedule, { timezone, now: 0 });
  const occurrences = [];
  let cursor = nextRunAt - 1;
  while (occurrences.length < MAX_OCCURRENCES) {
    const occurrence = computeNextOccurrence(normalized, timezone, cursor);
    if (occurrence == null || occurrence > now) break;
    occurrences.push(occurrence);
    cursor = occurrence;
  }

  const actions = [];
  const eligible = [];
  for (const occurrence of occurrences) {
    const age = now - occurrence;
    if (age > maxOverdueMs) {
      actions.push({
        scheduledFor: occurrence,
        action: 'expired',
        reason: `The scheduled time was more than ${Math.round(maxOverdueMs / DAY_MS)} day(s) overdue.`,
      });
    } else if (policy === 'skip') {
      actions.push({
        scheduledFor: occurrence,
        action: 'missed',
        reason: 'The scheduled time passed while the application was unavailable.',
      });
    } else if (policy === 'grace') {
      if (age <= graceMs) eligible.push(occurrence);
      else actions.push({
        scheduledFor: occurrence,
        action: 'missed',
        reason: 'The scheduled time was missed beyond the grace period.',
      });
    } else {
      eligible.push(occurrence);
    }
  }

  // Grace runs at most once per absence: keep only the latest eligible slot and
  // record older in-grace slots as superseded.
  if (policy === 'grace' && eligible.length > 1) {
    for (const occurrence of eligible.slice(0, -1)) {
      actions.push({
        scheduledFor: occurrence,
        action: 'missed',
        reason: 'Superseded by the latest eligible occurrence.',
      });
    }
    eligible.splice(0, eligible.length - 1);
  }
  for (const occurrence of eligible) {
    actions.push({ scheduledFor: occurrence, action: 'run', reason: null });
  }

  actions.sort((a, b) => a.scheduledFor - b.scheduledFor);
  return {
    actions,
    occurrences,
    nextRunAt: computeNextOccurrence(normalized, timezone, now),
  };
}

function isOverdue({ nextRunAt, now, maxOverdueMs = DEFAULT_MAX_OVERDUE_MS }) {
  return Number.isSafeInteger(nextRunAt) && now - nextRunAt > maxOverdueMs;
}

module.exports = {
  DAY_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OVERDUE_MS,
  MAX_OCCURRENCES,
  assertTimezone,
  wallClockAt,
  wallTimeToInstant,
  normalizeTimeOfDay,
  normalizeSchedule,
  computeNextOccurrence,
  evaluateMissedOccurrences,
  isOverdue,
};

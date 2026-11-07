'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../src/lib/scheduleCalc.cjs');

const TZ_NY = 'America/New_York';
const TZ_UTC = 'UTC';
const day = (year, month, date, hour = 0, minute = 0) =>
  Date.UTC(year, month - 1, date, hour, minute, 0);
const iso = value => value == null ? null : new Date(value).toISOString();

test('daily recurrence uses the local wall clock and the schedule anchor', () => {
  const spec = { type: 'daily', atTime: '09:30', startAt: day(2026, 1, 1) };
  const first = schedule.computeNextOccurrence(spec, TZ_NY, day(2026, 1, 10, 15));
  assert.equal(iso(first), '2026-01-11T14:30:00.000Z'); // EST
  const afterDst = schedule.computeNextOccurrence(spec, TZ_NY, day(2026, 3, 7, 20));
  assert.equal(iso(afterDst), '2026-03-08T13:30:00.000Z'); // EDT
});

test('every-N-days is anchored to the start date, not the last execution', () => {
  const spec = { type: 'every_n_days', intervalDays: 3, atTime: '08:00', startAt: day(2026, 2, 1) };
  assert.equal(iso(schedule.computeNextOccurrence(spec, TZ_UTC, day(2026, 2, 1, 9))), '2026-02-04T08:00:00.000Z');
  // A late execution on Feb 5 still resolves to the anchored Feb 7 slot.
  assert.equal(iso(schedule.computeNextOccurrence(spec, TZ_UTC, day(2026, 2, 5, 9))), '2026-02-07T08:00:00.000Z');
});

test('weekday recurrence selects only the requested local weekdays', () => {
  const spec = { type: 'weekdays', weekdays: [1, 3, 5], atTime: '17:00', startAt: day(2026, 2, 1) };
  // Sunday Feb 1 -> Monday Feb 2.
  assert.equal(iso(schedule.computeNextOccurrence(spec, TZ_UTC, day(2026, 2, 1, 10))), '2026-02-02T17:00:00.000Z');
  // Monday after 17:00 -> Wednesday.
  assert.equal(iso(schedule.computeNextOccurrence(spec, TZ_UTC, day(2026, 2, 2, 18))), '2026-02-04T17:00:00.000Z');
});

test('one-time schedules run once and never compute a second occurrence', () => {
  const at = day(2026, 4, 1, 15);
  assert.equal(schedule.computeNextOccurrence({ type: 'once', at }, TZ_UTC, at - 1), at);
  assert.equal(schedule.computeNextOccurrence({ type: 'once', at }, TZ_UTC, at), null);
});

test('DST spring-forward resolves a nonexistent 02:30 wall time to 03:00', () => {
  const resolved = schedule.wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, TZ_NY);
  assert.equal(iso(resolved), '2026-03-08T07:00:00.000Z');
  const daily = schedule.computeNextOccurrence(
    { type: 'daily', atTime: '02:30', startAt: day(2026, 3, 1) }, TZ_NY, day(2026, 3, 7, 12),
  );
  assert.equal(iso(daily), '2026-03-08T07:00:00.000Z');
});

test('DST fall-back fires an ambiguous 01:30 wall time exactly once, at the first instant', () => {
  const resolved = schedule.wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, TZ_NY);
  assert.equal(iso(resolved), '2026-11-01T05:30:00.000Z'); // EDT, before the second 01:30
  const next = schedule.computeNextOccurrence(
    { type: 'daily', atTime: '01:30', startAt: day(2026, 10, 30) }, TZ_NY, day(2026, 10, 31, 12),
  );
  assert.equal(iso(next), '2026-11-01T05:30:00.000Z');
});

test('grace keeps only the latest eligible occurrence and records older in-grace slots as superseded', () => {
  const result = schedule.evaluateMissedOccurrences({
    schedule: { type: 'daily', atTime: '09:00', startAt: day(2026, 1, 1) },
    timezone: TZ_UTC,
    nextRunAt: day(2026, 1, 5, 9),
    now: day(2026, 1, 7, 10),
    policy: 'grace',
    graceMs: 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(result.actions.map(action => action.action), ['missed', 'missed', 'run']);
  assert.equal(iso(result.actions.at(-1).scheduledFor), '2026-01-07T09:00:00.000Z');
  assert.equal(iso(result.nextRunAt), '2026-01-08T09:00:00.000Z');
});

test('skip records every due occurrence as missed and advances past now', () => {
  const result = schedule.evaluateMissedOccurrences({
    schedule: { type: 'daily', atTime: '09:00', startAt: day(2026, 1, 1) },
    timezone: TZ_UTC,
    nextRunAt: day(2026, 1, 5, 9),
    now: day(2026, 1, 7, 10),
    policy: 'skip',
  });
  assert.deepEqual(result.actions.map(action => action.action), ['missed', 'missed', 'missed']);
  assert.equal(iso(result.nextRunAt), '2026-01-08T09:00:00.000Z');
});

test('catch-up queues every eligible occurrence and respects the maximum overdue age', () => {
  const result = schedule.evaluateMissedOccurrences({
    schedule: { type: 'daily', atTime: '09:00', startAt: day(2026, 1, 1) },
    timezone: TZ_UTC,
    nextRunAt: day(2026, 1, 1, 9),
    now: day(2026, 1, 10, 10),
    policy: 'catch_up',
    maxOverdueMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(result.actions.map(action => action.action),
    ['expired', 'expired', 'expired', 'run', 'run', 'run', 'run', 'run', 'run', 'run']);
});

test('invalid timezones and malformed schedules fail validation', () => {
  assert.throws(() => schedule.assertTimezone('Not/AZone'), /Invalid IANA timezone/);
  assert.throws(() => schedule.normalizeSchedule({ type: 'daily', atTime: '25:00' }, { timezone: TZ_UTC }), /HH:MM/);
  assert.throws(() => schedule.normalizeSchedule({ type: 'weekdays', weekdays: [], atTime: '09:00' }, { timezone: TZ_UTC }), /weekday/);
  assert.throws(() => schedule.normalizeSchedule({ type: 'once', at: -1 }, { timezone: TZ_UTC }), /timestamp/);
});

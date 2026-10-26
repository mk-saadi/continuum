const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
// Isolated app_settings fixture: never open the user's database.
const rows = new Map();
const db = {
  prepare(sql) {
    if (sql.startsWith('SELECT key, value_json FROM app_settings')) return { all: () => [...rows].map(([key, value_json]) => ({ key, value_json })) };
    if (sql.startsWith('INSERT INTO app_settings')) return { run: (key, value) => rows.set(key, value) };
    throw Error(`Unexpected SQL: ${sql}`);
  },
  transaction: fn => fn,
};
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === './db') return { db };
  return original.call(this, name, ...args);
};
const config = require('../src/main/configManager');
test('sound defaults, partial updates, durable reload and independent desktop settings', () => {
  assert.deepEqual(config.getAppSettings().notificationSounds, { enabled: true, volume: 25, completed: true, interrupted: true, inputRequired: true });
  config.saveNotificationPrefs({ notificationSounds: { volume: 18, interrupted: false } });
  config.saveNotificationPrefs({ notificationSounds: { enabled: false } });
  config.saveNotificationPrefs({ notificationsEnabled: false });
  delete require.cache[require.resolve('../src/main/configManager')];
  const reloaded = require('../src/main/configManager').getAppSettings();
  assert.deepEqual(reloaded.notificationSounds, { enabled: false, volume: 18, completed: true, interrupted: false, inputRequired: true });
  assert.equal(reloaded.notificationsEnabled, false);
  assert.ok(rows.has('notificationSounds'));
});
test('reject invalid sound preferences before writing', () => {
  for (const value of [{ volume: -1 }, { volume: 101 }, { volume: NaN }, { enabled: 'true' }, { completed: 1 }, { surprise: true }, null, []]) {
    assert.throws(() => config.normalizeAppSettings({ notificationSounds: value }), /notification sounds/);
  }
});
test.after(() => { Module._load = original; });

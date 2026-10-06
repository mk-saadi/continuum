// node --test tests/legacyDataMigration.test.cjs
// The legacy profile folder is kept for recovery, so migrateLegacyUserData() runs on every launch.
// It must import the legacy directories.json only into keys the renamed profile never stored.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-migration-'));
const newRoot = path.join(root, 'Continuum');
const oldRoot = path.join(root, 'LLM Desktop Assistant');
const legacyModelDirectory = '/media/mk_saadi/e_drive/llm-folder/extra_llms';

fs.mkdirSync(newRoot, { recursive: true });
fs.mkdirSync(oldRoot, { recursive: true });
fs.mkdirSync(path.join(oldRoot, 'attachments'));
fs.writeFileSync(path.join(oldRoot, 'attachments', 'legacy.txt'), 'legacy attachment');
fs.writeFileSync(
  path.join(oldRoot, 'directories.json'),
  JSON.stringify({ modelDirectory: legacyModelDirectory, appDataDirectory: oldRoot }, null, 2)
);

const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => newRoot } };
  return load.call(this, name, ...args);
};

const { migrateLegacyUserData } = require('../src/main/legacyDataMigration');
const { setModelDirectory } = require('../src/main/configStore');
const configFile = path.join(newRoot, 'directories.json');
const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

(async () => {
  let modelDirectory = null;
  try {
    // First launch: legacy configuration and data are carried over.
    migrateLegacyUserData();
    assert.equal(readConfig().modelDirectory, legacyModelDirectory);
    assert.equal(readConfig().appDataDirectory, path.join(newRoot, 'App_Data'));
    assert.equal(fs.readFileSync(path.join(newRoot, 'attachments', 'legacy.txt'), 'utf8'), 'legacy attachment');

    // The user picks a new model directory and an engine idle timeout.
    modelDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'models-')));
    assert.equal(setModelDirectory(modelDirectory), modelDirectory);
    assert.ok(Object.hasOwn(readConfig(), 'engineIdleTimeoutMinutes'));

    // Every later launch re-runs the migration: saved choices must survive untouched.
    migrateLegacyUserData();
    migrateLegacyUserData();
    const config = readConfig();
    assert.equal(config.modelDirectory, modelDirectory, 'model directory was reset to the legacy value');
    assert.equal(config.appDataDirectory, path.join(newRoot, 'App_Data'), 'app data directory was reset');
    assert.ok(Object.hasOwn(config, 'engineIdleTimeoutMinutes'), 'engine idle timeout was dropped');

    // A key the renamed profile never stored is still filled from the legacy profile.
    fs.writeFileSync(configFile, JSON.stringify({ modelDirectory: config.modelDirectory }, null, 2));
    migrateLegacyUserData();
    const filled = readConfig();
    assert.equal(filled.modelDirectory, modelDirectory);
    assert.equal(filled.appDataDirectory, path.join(newRoot, 'App_Data'));

    console.log('Legacy migration keeps saved model directory, app data directory, and idle timeout across launches.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (modelDirectory) fs.rmSync(modelDirectory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

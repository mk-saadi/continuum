// Focused coverage for the custom background image + surface opacity feature:
// validation, managed-copy persistence, graceful missing-file handling, and
// the background:* IPC channels (picked file must be adopted into the managed
// directory, never trusted in place).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'background-settings-'));
let dialogResult;
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron')
    return {
      app: { isReady: () => true, getPath: () => directory, getAppPath: () => directory },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
      dialog: { showOpenDialogSync: () => dialogResult },
      shell: {},
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    };
  return originalLoad.call(this, name, ...args);
};
const { initDatabase, closeDatabase } = require('../src/main/db');
const background = require('../src/main/backgroundSettings');
const { registerIpcHandlers } = require('../src/main/ipcHandlers');
// The mock stays installed for the whole file: backgroundSettings resolves
// configStore lazily at call time, and each test file runs in its own process.
// (No restore here; restoring would hand lazy requires the real electron shim.)

// Minimal 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function writeSource(name, bytes) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('background settings: defaults, opacity validation, and persistence', () => {
  initDatabase(path.join(directory, 'db-default'));
  try {
    assert.deepEqual(background.getBackgroundSettings(), { imagePath: null, opacity: 85 });
    assert.equal(background.normalizeOpacity(undefined), 85);
    assert.equal(background.normalizeOpacity(40), 40);
    assert.equal(background.normalizeOpacity(100), 100);
    assert.equal(background.normalizeOpacity(84.4), 84);
    assert.throws(() => background.normalizeOpacity(39), /between 40 and 100/);
    assert.throws(() => background.normalizeOpacity(101), /between 40 and 100/);
    assert.throws(() => background.normalizeOpacity(Number.NaN), /must be a number/);
    assert.throws(() => background.setBackgroundOpacity(10), /between 40 and 100/);
    assert.deepEqual(background.setBackgroundOpacity(60), { imagePath: null, opacity: 60 });
    assert.deepEqual(background.getBackgroundSettings(), { imagePath: null, opacity: 60 });
  } finally {
    closeDatabase();
  }
});

test('background image: adopt, replace, remove, and missing-file fallback', () => {
  initDatabase(path.join(directory, 'db-image'));
  try {
    const first = writeSource('first.png', PNG);
    const adopted = background.adoptBackgroundImage(first);
    assert.ok(adopted.imagePath.startsWith(background.backgroundsDirectory()));
    assert.ok(fs.existsSync(adopted.imagePath));
    assert.equal(adopted.opacity, 85);
    // The stored record survives a fresh read and keeps the opacity.
    background.setBackgroundOpacity(70);
    assert.deepEqual(background.getBackgroundSettings(), { imagePath: adopted.imagePath, opacity: 70 });
    // Replacing removes the previous managed copy.
    const second = writeSource('second.jpg', PNG);
    const replaced = background.adoptBackgroundImage(second);
    assert.ok(fs.existsSync(replaced.imagePath));
    assert.ok(!fs.existsSync(adopted.imagePath));
    assert.equal(replaced.opacity, 70);
    // A deleted file degrades to "no image" instead of a broken layer.
    fs.unlinkSync(replaced.imagePath);
    assert.deepEqual(background.getBackgroundSettings(), { imagePath: null, opacity: 70 });
    // Non-images and oversized files are rejected before adoption.
    assert.throws(() => background.adoptBackgroundImage(writeSource('note.txt', 'hello')), /PNG, JPEG/);
    assert.throws(
      () => background.adoptBackgroundImage(writeSource('huge.png', Buffer.alloc(11 * 1024 * 1024))),
      /smaller than 10 MB/,
    );
    // Removing clears the record and deletes the managed copy.
    const third = background.adoptBackgroundImage(writeSource('third.png', PNG));
    assert.deepEqual(background.removeBackgroundImage(), { imagePath: null, opacity: 70 });
    assert.ok(!fs.existsSync(third.imagePath));
  } finally {
    closeDatabase();
  }
});

test('background settings: paths outside the managed directory are never honored', () => {
  initDatabase(path.join(directory, 'db-untrusted'));
  try {
    const outside = writeSource('outside.png', PNG);
    require('../src/main/db').db
      .prepare("INSERT INTO app_settings(key, value_json) VALUES ('background-settings', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(JSON.stringify({ imagePath: outside, opacity: 90 }));
    assert.deepEqual(background.getBackgroundSettings(), { imagePath: null, opacity: 90 });
  } finally {
    closeDatabase();
  }
});

test('background IPC: pick adopts the file, cancel keeps the previous image', async () => {
  initDatabase(path.join(directory, 'db-ipc'));
  const dispose = registerIpcHandlers({ isTrustedSender: () => true });
  try {
    const event = { sender: { isDestroyed: () => false } };
    assert.deepEqual(await handlers.get('background:get')(event), { imagePath: null, opacity: 85 });
    assert.deepEqual(await handlers.get('background:set-opacity')(event, { opacity: 55 }), {
      imagePath: null,
      opacity: 55,
    });
    await assert.rejects(handlers.get('background:set-opacity')(event, { opacity: 5 }), /between 40 and 100/);
    dialogResult = undefined;
    assert.equal(await handlers.get('background:pick')(event), null);
    assert.deepEqual(await handlers.get('background:get')(event), { imagePath: null, opacity: 55 });
    dialogResult = [writeSource('picked.png', PNG)];
    const picked = await handlers.get('background:pick')(event);
    assert.ok(picked.imagePath.startsWith(background.backgroundsDirectory()));
    assert.equal(picked.opacity, 55);
    assert.deepEqual(await handlers.get('background:get')(event), picked);
    assert.deepEqual(await handlers.get('background:remove')(event), { imagePath: null, opacity: 55 });
    assert.ok(!fs.existsSync(picked.imagePath));
  } finally {
    dispose();
    closeDatabase();
  }
});

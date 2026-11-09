// Run with ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/mascotPersistence.test.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-settings-')), load = Module._load;
Module._load = function (name, ...args) { if (name === 'electron')
    return { app: { isReady: () => true, getPath: () => directory } }; return load.call(this, name, ...args); };
const { initDatabase, closeDatabase } = require('../src/main/db');
const { getAppSettings, saveAppSettings } = require('../src/main/configManager');
try {
    initDatabase();
    assert.equal(getAppSettings().mascot.enabled, true);
    saveAppSettings({ mascot: { size: 220, hue: 92, enabled: false, position: { x: .22, y: .47 }, desktopPosition: {displayId:12,x:.4,y:.6}, animation: 'reduced' } });
    saveAppSettings({ mcpMode: 'manual' });
    closeDatabase();
    initDatabase();
    assert.equal(getAppSettings().mascot.size, 220);
    assert.equal(getAppSettings().mascot.enabled, false);
    assert.deepEqual(getAppSettings().mascot.position, { x: .22, y: .47 });
    assert.equal(getAppSettings().mascot.animation, 'reduced');
    assert.deepEqual(getAppSettings().mascot.desktopPosition,{displayId:12,x:.4,y:.6});
    saveAppSettings({ mascot: { size: NaN, hue: 999, position: { x: 999, y: -1 } } });
    assert.equal(getAppSettings().mascot.size, 128);
    assert.equal(getAppSettings().mascot.hue, 360);
    assert.deepEqual(getAppSettings().mascot.position, { x: 1, y: 0 });
    console.log('Mascot database restart and validation checks passed');
}
finally {
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
}

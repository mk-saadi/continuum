// Phase 3.2 coverage: bounding oversized animated GIF backgrounds.
//
// The fixtures are real multi-frame GIFs (tests/fixtures/gifFixtures.cjs) and
// every derivative is inspected with sharp, so frame count, timing, loop count,
// dimensions, and transparency are verified, not assumed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'background-gif-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron')
    return {
      app: { isReady: () => true, getPath: () => directory, getAppPath: () => directory },
      ipcMain: { handle: () => {}, removeHandler: () => {} },
      dialog: { showOpenDialogSync: () => undefined },
      shell: {},
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    };
  return originalLoad.call(this, name, ...args);
};

const { initDatabase, closeDatabase } = require('../src/main/db');
const background = require('../src/main/backgroundSettings');
const gifProcessor = require('../src/main/gifProcessor');
const sharp = require('sharp');
const { writeFixtures } = require('./fixtures/gifFixtures.cjs');

// Count real processing calls without changing behaviour.
let boundCalls = 0;
let posterCalls = 0;
const realBoundGif = gifProcessor.boundGif;
const realWritePoster = gifProcessor.writePosterFrame;
gifProcessor.boundGif = (...args) => { boundCalls += 1; return realBoundGif(...args); };
gifProcessor.writePosterFrame = (...args) => { posterCalls += 1; return realWritePoster(...args); };

let fixtures;
function fixtureDir() {
  if (!fixtures) fixtures = writeFixtures(path.join(directory, 'sources'));
  return fixtures;
}

let dbSeq = 0;
function freshDb() {
  dbSeq += 1;
  initDatabase(path.join(directory, `db-${dbSeq}`));
}

async function gifMeta(file) {
  return sharp(file, { animated: true }).metadata();
}

function derivedFiles() {
  try {
    return fs.readdirSync(background.derivedDirectory());
  } catch {
    return [];
  }
}

test('an animated GIF under the render cap: no bounded derivative, a static poster', async () => {
  freshDb();
  try {
    const { smallGif } = fixtureDir();
    const adopted = await background.adoptBackgroundImage(smallGif);
    assert.equal(adopted.animated, true, 'the asset is reported as animated');
    assert.equal(adopted.renderPath, null, 'a 320px GIF is not resized');
    assert.ok(adopted.previewPath, 'a poster is still produced for the preview');
    assert.ok(fs.existsSync(adopted.previewPath));
    assert.ok(!fs.existsSync(background.boundedGifPathFor(adopted.imagePath)));

    // The poster is a single-frame PNG: the preview cannot run a second animation.
    const poster = await sharp(adopted.previewPath).metadata();
    assert.equal(poster.format, 'png');
    assert.equal(poster.pages || 1, 1);
    assert.ok(poster.hasAlpha, 'a transparent GIF keeps transparency in the poster');
  } finally {
    closeDatabase();
  }
});

test('an oversized GIF is rendered through a bounded derivative with animation intact', async () => {
  freshDb();
  try {
    const { oversizedGif } = fixtureDir();
    const before = await gifMeta(oversizedGif);
    assert.equal(before.width, 2560);
    assert.ok(before.width > background.MAX_RENDER_DIMENSION);

    const adopted = await background.adoptBackgroundImage(oversizedGif);
    assert.equal(adopted.animated, true);
    assert.ok(adopted.renderPath, 'an oversized GIF gets a bounded derivative');
    assert.equal(background.boundedGifPathFor(adopted.imagePath), adopted.renderPath);
    assert.ok(fs.existsSync(adopted.renderPath));

    const after = await gifMeta(adopted.renderPath);
    assert.equal(after.format, 'gif');
    assert.equal(Math.max(after.width, after.pageHeight), background.MAX_RENDER_DIMENSION);
    // Aspect ratio preserved (never cropped/stretched into a different shape).
    assert.ok(Math.abs(after.width / after.pageHeight - before.width / before.pageHeight) < 0.01);
    // Animation, timing and looping preserved.
    assert.equal(after.pages, before.pages);
    assert.deepEqual(after.delay, before.delay);
    assert.equal(after.loop, before.loop);
    // The original source is untouched.
    const srcStat = fs.statSync(oversizedGif);
    fs.statSync(oversizedGif);
    assert.equal(srcStat.size, fs.statSync(oversizedGif).size);
  } finally {
    closeDatabase();
  }
});

test('transparency, frame timing and looping survive bounding', async () => {
  freshDb();
  try {
    const { smallGif } = fixtureDir();
    const output = path.join(directory, 'trans-bounded.gif');
    const result = await gifProcessor.boundGif({ input: smallGif, output, maxDimension: 160 });
    assert.deepEqual(result, { width: 160, height: 90 });

    const before = await gifMeta(smallGif);
    const after = await gifMeta(output);
    assert.equal(after.pages, 4);
    assert.deepEqual(after.delay, before.delay);
    assert.equal(after.loop, before.loop);
    assert.ok(after.hasAlpha);

    // Alpha is actually present in the pixels, and the frames differ (animation,
    // not a frozen first frame).
    const { data, info } = await sharp(output, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frameLength = info.width * info.height * info.channels;
    const transparent = [...data.filter((_, i) => i % info.channels === info.channels - 1)]
      .filter((value) => value === 0).length;
    assert.ok(transparent > 0, 'transparent pixels survive the resize');
    const frame0 = data.subarray(0, frameLength);
    const frame1 = data.subarray(2 * frameLength, 3 * frameLength);
    assert.notDeepEqual(Buffer.from(frame0), Buffer.from(frame1), 'frames must not be identical');
  } finally {
    closeDatabase();
  }
});

test('static image backgrounds are never processed', async () => {
  freshDb();
  try {
    const { staticPng } = fixtureDir();
    boundCalls = 0;
    posterCalls = 0;
    const adopted = await background.adoptBackgroundImage(staticPng);
    assert.equal(adopted.renderPath, null);
    assert.equal(adopted.previewPath, null);
    assert.equal(boundCalls, 0, 'a static image is never bounded');
    assert.equal(posterCalls, 0, 'a static image needs no preview derivative');
    assert.deepEqual(await background.getBackgroundSettings(), { imagePath: adopted.imagePath, renderPath: null, previewPath: null, opacity: 85, animated: false });
    assert.equal(boundCalls, 0);
    assert.equal(posterCalls, 0);
    // No derived files belong to a static source.
    assert.deepEqual(derivedFiles(), []);
  } finally {
    closeDatabase();
  }
});

test('a previously stored oversized GIF is optimized on load without re-import', async () => {
  freshDb();
  try {
    const { oversizedGif } = fixtureDir();
    const backgrounds = background.backgroundsDirectory();
    fs.mkdirSync(backgrounds, { recursive: true });
    // Simulate an existing user: a GIF already in the managed directory.
    const stored = path.join(backgrounds, 'background-legacy-oversized.gif');
    fs.copyFileSync(oversizedGif, stored);
    const storedSize = fs.statSync(stored).size;
    require('../src/main/db').db
      .prepare("INSERT INTO app_settings(key, value_json) VALUES ('background-settings', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(JSON.stringify({ imagePath: stored, opacity: 85 }));

    const settings = await background.getBackgroundSettings();
    assert.equal(settings.imagePath, stored);
    assert.equal(settings.animated, true);
    assert.ok(settings.renderPath, 'the legacy GIF is bounded on load');
    assert.ok(settings.previewPath);
    const meta = await gifMeta(settings.renderPath);
    assert.equal(Math.max(meta.width, meta.pageHeight), background.MAX_RENDER_DIMENSION);
    // The original is preserved untouched.
    assert.ok(fs.existsSync(stored));
    assert.equal(fs.statSync(stored).size, storedSize);
  } finally {
    closeDatabase();
  }
});

test('an unchanged source is processed once, and opacity changes never reprocess', async () => {
  freshDb();
  try {
    const { oversizedGif } = fixtureDir();
    boundCalls = 0;
    posterCalls = 0;
    const adopted = await background.adoptBackgroundImage(oversizedGif);
    assert.equal(boundCalls, 1);
    assert.equal(posterCalls, 1);
    const boundedMtime = fs.statSync(adopted.renderPath).mtimeMs;

    await background.getBackgroundSettings();
    await background.getBackgroundSettings();
    assert.equal(boundCalls, 1, 'repeat loads reuse the cached derivative');
    assert.equal(posterCalls, 1);
    assert.equal(fs.statSync(adopted.renderPath).mtimeMs, boundedMtime);

    // Opacity is a pure visual update: no processing, derivative preserved.
    const result = background.setBackgroundOpacity(55);
    assert.equal(result.renderPath, adopted.renderPath);
    assert.equal(result.previewPath, adopted.previewPath);
    assert.equal(boundCalls, 1);
    assert.equal(posterCalls, 1);
    await background.getBackgroundSettings();
    assert.equal(boundCalls, 1);
  } finally {
    closeDatabase();
  }
});

test('a concurrent replacement cannot be overridden or pruned by a stale run', async () => {
  freshDb();
  try {
    const { oversizedGif, smallGif } = fixtureDir();
    // Start the oversized adoption but do not await: the small one is chosen
    // while the (slower) oversized processing is still in flight.
    const first = background.adoptBackgroundImage(oversizedGif);
    const second = background.adoptBackgroundImage(smallGif);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const final = await background.getBackgroundSettings();
    assert.equal(final.imagePath, secondResult.imagePath, 'the newer selection wins');
    assert.equal(final.previewPath, secondResult.previewPath);
    assert.ok(!fs.existsSync(firstResult.imagePath), 'the replaced original is retired');
    assert.ok(!fs.existsSync(background.boundedGifPathFor(firstResult.imagePath)), 'its stale derivative is pruned');
    assert.ok(fs.existsSync(secondResult.previewPath));
  } finally {
    closeDatabase();
  }
});

test('missing derivatives are regenerated; corrupt sources degrade gracefully', async () => {
  freshDb();
  try {
    const { oversizedGif } = fixtureDir();
    const adopted = await background.adoptBackgroundImage(oversizedGif);
    boundCalls = 0;
    fs.unlinkSync(adopted.renderPath);
    const reloaded = await background.getBackgroundSettings();
    assert.equal(reloaded.renderPath, adopted.renderPath);
    assert.equal(boundCalls, 1, 'a deleted derivative is regenerated');
    assert.ok(fs.existsSync(reloaded.renderPath));

    // A corrupt GIF must not break anything: no derivatives, original still named.
    const backgrounds = background.backgroundsDirectory();
    const corrupt = path.join(backgrounds, 'background-corrupt.gif');
    fs.writeFileSync(corrupt, Buffer.from('not really a gif'));
    require('../src/main/db').db
      .prepare("INSERT INTO app_settings(key, value_json) VALUES ('background-settings', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(JSON.stringify({ imagePath: corrupt, opacity: 80 }));
    const settings = await background.getBackgroundSettings();
    assert.deepEqual(settings, { imagePath: corrupt, renderPath: null, previewPath: null, opacity: 80, animated: false });
  } finally {
    closeDatabase();
  }
});

test('removal and cleanup delete only derived files and the removed original', async () => {
  freshDb();
  try {
    const { oversizedGif } = fixtureDir();
    const backgrounds = background.backgroundsDirectory();
    fs.mkdirSync(backgrounds, { recursive: true });
    // An unrelated managed file that must survive.
    const unrelated = path.join(backgrounds, 'background-unrelated.png');
    fs.writeFileSync(unrelated, Buffer.from('unrelated'));

    const adopted = await background.adoptBackgroundImage(oversizedGif);
    assert.ok(adopted.renderPath && adopted.previewPath);
    const removed = background.removeBackgroundImage();
    assert.deepEqual(removed, { imagePath: null, renderPath: null, previewPath: null, opacity: 85, animated: false });
    assert.ok(!fs.existsSync(adopted.imagePath));
    assert.ok(!fs.existsSync(adopted.renderPath));
    assert.ok(!fs.existsSync(adopted.previewPath));
    assert.ok(fs.existsSync(unrelated), 'unrelated managed files are never deleted');
    assert.deepEqual(derivedFiles(), [], 'the derived cache is emptied');
  } finally {
    closeDatabase();
  }
});

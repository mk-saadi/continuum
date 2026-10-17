// Phase 3.2 renderer regression suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/backgroundLayer.ui.cjs
//
// Verifies the renderer half of the GIF work against the real hook and the real
// Settings section:
//  - an opacity change updates the visual factor only (no source re-read, no
//    image re-probe, no image reload);
//  - an animated background is flagged for CSS so per-frame compositor effects
//    can be gated off;
//  - the Settings thumbnail uses the static poster frame, so an animated
//    background never decodes a second full-resolution animation;
//  - replacing the background does re-read the source.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const PNG_PAYLOAD = {
  imagePath: '/tmp/bg/background-static.png',
  renderPath: null,
  previewPath: null,
  opacity: 85,
  animated: false,
};
const GIF_PAYLOAD = {
  imagePath: '/tmp/bg/background-a.gif',
  renderPath: '/tmp/bg/derived/background-a.bounded.gif',
  previewPath: '/tmp/bg/derived/background-a.poster.png',
  opacity: 85,
  animated: true,
};

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'background-layer-ui-'));
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    show: true,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures/backgroundLayer.jsx')],
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find((name) => name.endsWith('.css'));
    await fs.writeFile(
      path.join(directory, 'index.html'),
      `<html><head><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`,
    );
    await window.loadFile(path.join(directory, 'index.html'));

    const result = await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const results = [];

      const mount = async (mode, payload) => {
        window.__reset();
        window.__setPayload(payload);
        window.__mount(mode);
        await tick(60);
        return window.__counts();
      };

      // 1. Animated GIF: the layer is applied once, flagged animated, and the
      //    probe runs exactly once.
      let counts = await mount('hook', ${JSON.stringify(GIF_PAYLOAD)});
      let state = window.__state();
      check(counts.getCalls === 1, 'mount must read the source once, got ' + counts.getCalls);
      check(counts.probes === 1, 'mount must probe the image once, got ' + counts.probes);
      check(state.bgImage === 'true', 'the image layer must be marked');
      check(state.bgAnimated === 'true', 'an animated asset must be flagged');
      check(state.backgroundImage.includes('background-a.bounded.gif'), 'the bounded derivative must be painted: ' + state.backgroundImage);
      check(state.bodyOpacity === '0.85', 'opacity must be applied, got ' + state.bodyOpacity);
      results.push({ name: 'gif-mount', counts, state });

      // 2. Opacity change: purely visual. No source re-read, no re-probe, no
      //    image replacement.
      window.__reset();
      window.__opacityChanged(60);
      await tick(40);
      counts = window.__counts();
      state = window.__state();
      check(counts.getCalls === 0, 'opacity change must not re-read the source, got ' + counts.getCalls);
      check(counts.probes === 0, 'opacity change must not re-probe the image, got ' + counts.probes);
      check(state.bodyOpacity === '0.6', 'opacity must update, got ' + state.bodyOpacity);
      check(state.opacityVar === '0.6', 'the CSS factor must update, got ' + state.opacityVar);
      check(state.backgroundImage.includes('background-a.bounded.gif'), 'the image must be untouched');
      results.push({ name: 'opacity-change', counts, state });

      // 3. Replacing the background does re-read the source.
      window.__reset();
      window.__changed();
      await tick(40);
      counts = window.__counts();
      check(counts.getCalls === 1, 'a background change must re-read the source, got ' + counts.getCalls);
      check(counts.probes === 1, 'a background change must re-probe the image, got ' + counts.probes);
      results.push({ name: 'background-change', counts });

      // 4. Static image: never flagged animated, painted directly.
      counts = await mount('hook', ${JSON.stringify(PNG_PAYLOAD)});
      state = window.__state();
      check(state.bgImage === 'true', 'the static layer must be marked');
      check(state.bgAnimated === null, 'a static image must not be flagged animated, got ' + state.bgAnimated);
      check(state.backgroundImage.includes('background-static.png'), 'the original must be painted: ' + state.backgroundImage);
      results.push({ name: 'static-mount', counts, state });

      // 5. Settings thumbnail: the preview uses the poster, not the animation.
      await mount('settings', ${JSON.stringify(GIF_PAYLOAD)});
      let previewSrc = window.__state().previewSrc;
      check(previewSrc && previewSrc.includes('background-a.poster.png'), 'the preview must use the static poster, got ' + previewSrc);
      results.push({ name: 'settings-preview-poster', previewSrc });

      // 6. Without a poster the preview falls back to the source.
      await mount('settings', { ...${JSON.stringify(GIF_PAYLOAD)}, previewPath: null });
      previewSrc = window.__state().previewSrc;
      check(previewSrc && previewSrc.includes('background-a.gif'), 'the preview must fall back to the source, got ' + previewSrc);
      results.push({ name: 'settings-preview-fallback', previewSrc });

      return results;
    })()`);

    const byName = Object.fromEntries(result.map((entry) => [entry.name, entry]));
    // Independent, host-side assertions so the suite fails loudly rather than
    // trusting the page's own checks.
    assert.equal(byName['gif-mount'].counts.getCalls, 1);
    assert.equal(byName['opacity-change'].counts.getCalls, 0);
    assert.equal(byName['opacity-change'].counts.probes, 0);
    assert.equal(byName['background-change'].counts.getCalls, 1);
    assert.equal(byName['static-mount'].state.bgAnimated, null);
    assert.ok(byName['settings-preview-poster'].previewSrc.endsWith('background-a.poster.png'));
    assert.ok(byName['settings-preview-fallback'].previewSrc.endsWith('background-a.gif'));
    console.log('backgroundLayer.ui.cjs: all scenarios passed');
    for (const entry of result) console.log('  -', entry.name, JSON.stringify({ counts: entry.counts, bgAnimated: entry.state?.bgAnimated, previewSrc: entry.previewSrc }));
  } catch (error) {
    console.error('backgroundLayer.ui.cjs FAILED:', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(process.exitCode || 0);
});

// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/compressionDispatch.ui.cjs
//
// The app keeps every open tab mounted, and each tab used to subscribe to
// `session:compression-complete` itself. This suite mounts the real provider
// with several per-session consumers and proves the channel is registered
// once, payloads reach only the matching session, and the registration is
// released when the tree unmounts.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'compression-dispatch-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: {
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import {
            CompressionEventsProvider,
            useCompressionEvents,
          } from './src/context/CompressionEventsContext.jsx';

          window.__stats = { registrations: 0, removals: 0 };
          window.__events = [];
          window.__emit = null;
          window.memoryPalace = {
            onCompressionComplete: (callback) => {
              window.__stats.registrations += 1;
              window.__emit = callback;
              return () => {
                window.__stats.removals += 1;
                if (window.__emit === callback) window.__emit = null;
              };
            },
          };

          function Consumer({ sessionId, label, suffix = '' }) {
            useCompressionEvents(sessionId, (result) => {
              window.__events.push(label + ':' + result.sessionId + ':' + suffix);
            });
            return <span>{label}</span>;
          }

          const root = createRoot(document.getElementById('root'));
          window.__render = (consumers) => {
            root.render(
              <CompressionEventsProvider>
                {consumers.map((c) => (
                  <Consumer key={c.label} sessionId={c.sessionId} label={c.label} suffix={c.suffix} />
                ))}
              </CompressionEventsProvider>,
            );
          };
          window.__unmount = () => root.unmount();
        `,
        loader: 'jsx',
        resolveDir: process.cwd(),
      },
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));

    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
      const until = async (fn, message) => {
        for (let i = 0; i < 100; i += 1) { if (fn()) return; await wait(); }
        throw new Error(message);
      };
      const check = (condition, message) => { if (!condition) throw new Error(message); };

      window.__render([
        { label: 'a1', sessionId: 'a' },
        { label: 'a2', sessionId: 'a' },
        { label: 'b1', sessionId: 'b' },
      ]);
      await until(() => window.__stats.registrations > 0, 'provider never subscribed');

      check(window.__stats.registrations === 1, 'channel registered once for all consumers');

      window.__emit({ sessionId: 'a', summarizedMessageIds: [1] });
      check(
        JSON.stringify(window.__events) === JSON.stringify(['a1:a:', 'a2:a:']),
        'session a event reached exactly its two consumers',
      );

      window.__events = [];
      window.__emit({ sessionId: 'b', summarizedMessageIds: [2] });
      check(JSON.stringify(window.__events) === JSON.stringify(['b1:b:']), 'session b event isolated');

      window.__events = [];
      window.__emit({ sessionId: 'unknown', summarizedMessageIds: [] });
      check(window.__events.length === 0, 'unknown session dropped');
      window.__emit({ summarizedMessageIds: [] });
      check(window.__events.length === 0 && window.__stats.registrations === 1, 'payload without sessionId dropped');

      // A new closure must be used without re-registering the channel.
      window.__render([
        { label: 'a1', sessionId: 'a', suffix: 'v2' },
        { label: 'a2', sessionId: 'a' },
        { label: 'b1', sessionId: 'b' },
      ]);
      await wait();
      window.__events = [];
      window.__emit({ sessionId: 'a', summarizedMessageIds: [3] });
      check(
        JSON.stringify(window.__events) === JSON.stringify(['a1:a:v2', 'a2:a:']),
        'handlers see their latest closures',
      );
      check(window.__stats.registrations === 1, 'handler churn does not resubscribe');

      // Closing a tab releases only that tab's registration.
      window.__render([
        { label: 'a1', sessionId: 'a', suffix: 'v2' },
        { label: 'b1', sessionId: 'b' },
      ]);
      await wait();
      window.__events = [];
      window.__emit({ sessionId: 'a', summarizedMessageIds: [4] });
      check(JSON.stringify(window.__events) === JSON.stringify(['a1:a:v2']), 'closed tab stops receiving events');
      check(window.__stats.registrations === 1, 'tab close does not touch the shared subscription');

      window.__unmount();
      await until(() => window.__stats.removals === 1, 'shared subscription not released on unmount');
      check(window.__emit === null, 'no listener left behind');

      return { ...window.__stats, events: window.__events };
    })()`);

    assert.equal(result.registrations, 1);
    assert.equal(result.removals, 1);
    console.log('Compression dispatch: one channel registration, per-session routing, handler freshness, and cleanup passed.');
    app.quit();
  } catch (error) {
    console.error('Compression dispatch UI test failed:', error.message);
    app.exit(1);
  }
});

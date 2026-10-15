// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/palacePolling.ui.cjs
// Drives the REAL useMemoryPalace hook with fake setInterval timers and mocked
// IPC: proves inactive panes create no timers and cause no polling IPC, with
// deterministic switching, unmount, staleness, and multi-tab scaling.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'palace-poll-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useMemoryPalace } from './src/components/MemoryPalace';

      // Fake ONLY setInterval (the hook's poll loop); real setTimeout stays for waits.
      window.__intervals = new Map();
      window.__nextIntervalId = 1;
      window.setInterval = (fn, ms) => { const id = window.__nextIntervalId++; window.__intervals.set(id, { fn, ms }); return id; };
      window.clearInterval = (id) => { window.__intervals.delete(id); };
      window.tickAll = () => { for (const { fn } of [...window.__intervals.values()]) fn(); };

      window.__ipc = { usage: [], core: 0, settings: 0, measure: 0 };
      window.__usageImpl = null;
      window.__usagePayload = { totalTokens: 100, messageCount: 2, hasSummary: false, telemetry: null };
      window.__pendingUsage = [];
      window.memoryPalace = {
        getContextUsage: async (sessionId) => {
          window.__ipc.usage.push(sessionId);
          if (window.__usageImpl) return window.__usageImpl(sessionId);
          return { ...window.__usagePayload };
        },
        getCoreMemories: async () => { window.__ipc.core++; return []; },
        measureContext: async () => { window.__ipc.measure++; return { sessionId: 's', modelId: 'm', measuredAt: '', messageCount: 0, toolCount: 0, memoryEnabled: true, tokens: 10, method: 'approximate-full-request', limit: 100, budget: 50, confidence: 'estimated' }; },
        scheduleIdleCompression: async () => {},
        onCompressionComplete: (cb) => { window.__compressionCb = cb; return () => {}; },
      };
      window.api = {
        getEffectiveSettings: async () => { window.__ipc.settings++; return { effective: { memoryEnabled: true } }; },
        saveSessionMemorySettings: async () => ({}),
      };
      window.mcpAPI = { onChanged: () => () => {}, getStatus: async () => ({ servers: [], pluginTokens: 0, toolTokens: 0 }) };

      window.__renders = {};
      window.__palace = {};
      function Probe({ id, sessionId, active }) {
        window.__renders[id] = (window.__renders[id] || 0) + 1;
        const palace = useMemoryPalace('model-1', { contextLength: 100000 }, sessionId, () => {}, { engineReady: false, isActive: active, pollIntervalMs: 50 });
        window.__palace[id] = palace;
        return null;
      }
      function Fixture() {
        const [actives, setActives] = useState({ p1: true });
        const [mounted, setMounted] = useState({ p1: true });
        window.__setActive = (id, v) => setActives(a => ({ ...a, [id]: v }));
        window.__setMounted = (id, v) => setMounted(m => ({ ...m, [id]: v }));
        window.__addProbe = (id) => { setActives(a => ({ ...a, [id]: false })); setMounted(m => ({ ...m, [id]: true })); };
        return <>{Object.keys(mounted).filter(id => mounted[id]).map(id => <Probe key={id} id={id} sessionId={'session-' + id} active={!!actives[id]} />)}</>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const summary = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const usageCount = () => window.__ipc.usage.length;
      for (let i = 0; i < 100 && !window.__palace.p1; i++) await wait();
      check(window.__palace.p1, 'p1 hook mounted');
      await wait();
      // 1. Active tab polls; interval uses the configured cadence.
      check(window.__intervals.size === 1, 'active pane owns exactly one interval, got ' + window.__intervals.size);
      check([...window.__intervals.values()][0].ms === 50, 'interval uses pollIntervalMs');
      check(usageCount() >= 1 && window.__ipc.usage.every(s => s === 'session-p1'), 'immediate refresh targets the active session');
      // 2. Mount 9 inactive probes: no new timers, no polling IPC for them.
      for (const id of ['p2','p3','p4','p5','p6','p7','p8','p9','p10']) window.__addProbe(id);
      await wait();
      check(window.__intervals.size === 1, 'inactive panes create no intervals, got ' + window.__intervals.size);
      const before = usageCount();
      for (let t = 0; t < 5; t++) { window.tickAll(); await wait(); }
      check(usageCount() - before === 5, '5 ticks cause 5 polls, got ' + (usageCount() - before));
      check(window.__ipc.usage.every(s => s === 'session-p1'), 'all polls target the active session (10 panes mounted)');
      // 3. Identical results cause no re-renders of the active probe.
      const rendersBefore = window.__renders.p1;
      for (let t = 0; t < 5; t++) { window.tickAll(); await wait(); }
      check(window.__renders.p1 === rendersBefore, 'identical polls do not re-render (renders ' + rendersBefore + ' -> ' + window.__renders.p1 + ')');
      // 4. Switch active pane: old timer dies, new pane refreshes, cadence resumes.
      window.__setActive('p1', false);
      window.__setActive('p2', true);
      await wait();
      check(window.__intervals.size === 1, 'switch keeps exactly one interval, got ' + window.__intervals.size);
      const atSwitch = usageCount();
      window.tickAll(); await wait();
      const fresh = window.__ipc.usage.slice(atSwitch);
      check(fresh.length >= 1 && fresh.every(s => s === 'session-p2'), 'polls follow the newly active session (got ' + JSON.stringify(fresh) + ')');
      // 5. Rapid switching never duplicates intervals.
      for (let i = 0; i < 10; i++) { window.__setActive('p1', i % 2 === 0); window.__setActive('p2', i % 2 !== 0); }
      await wait();
      check(window.__intervals.size === 1, 'rapid switching leaves one interval, got ' + window.__intervals.size);
      window.tickAll(); await wait();
      // 6. Unmount the active pane: timer gone, ticks silent.
      window.__setMounted('p1', false);
      window.__setMounted('p2', false);
      await wait();
      check(window.__intervals.size === 0, 'unmount clears intervals, got ' + window.__intervals.size);
      const silentBefore = usageCount();
      window.tickAll(); await wait();
      check(usageCount() === silentBefore, 'ticks after unmount cause no polling');
      // 7. Stale async responses cannot overwrite newer state across a switch.
      // (Flips are separated by waits: React would batch back-to-back flips
      // into a single no-op render with no new refresh.)
      window.__setMounted('p1', true); // remount, still inactive: no timer, no refresh
      await wait();
      check(window.__intervals.size === 0, 'remounted inactive pane starts nothing, got ' + window.__intervals.size);
      let seq = 0;
      window.__pendingUsage = [];
      window.__usageImpl = () => new Promise(resolve => { window.__pendingUsage.push((total) => resolve({ totalTokens: total, messageCount: 2, hasSummary: false, telemetry: null })); void seq; seq++; });
      window.__setActive('p1', true);
      await wait(); // reactivation refresh = call A, pending
      window.__setActive('p1', false);
      await wait(); // cleanup invalidates A, timer cleared
      window.__setActive('p1', true);
      await wait(); // reactivation refresh = call B, pending
      check(window.__pendingUsage.length >= 2, 'two overlapping refreshes pending, got ' + window.__pendingUsage.length);
      const [resolveA, resolveB] = window.__pendingUsage;
      resolveB(222); await wait();
      resolveA(111); await wait(); // stale loser resolves last
      check(window.__palace.p1.usage && window.__palace.p1.usage.totalTokens === 222, 'stale response discarded, usage is newest (got ' + JSON.stringify(window.__palace.p1.usage) + ')');
      window.__usageImpl = null;
      // 8. Event-driven updates still reach an inactive pane; toggle refreshes.
      window.__setActive('p1', false);
      await wait();
      const eventsBefore = usageCount();
      window.__compressionCb({ sessionId: 'session-p1', compressed: true, archivedCount: 3 });
      await wait();
      check(usageCount() > eventsBefore, 'compression event still refreshes an inactive pane');
      await window.__palace.p1.toggle();
      await wait();
      check(usageCount() > eventsBefore + 1, 'explicit toggle refreshes');
      const measureBefore = window.__ipc.measure;
      window.dispatchEvent(new Event('generation-settings-changed'));
      await new Promise(resolve => setTimeout(resolve, 450)); // past the 300ms settings debounce
      check(window.__ipc.measure > measureBefore, 'settings change re-measures');
      check(usageCount() > eventsBefore + 1, 'settings change refreshes usage');
      return { intervals: window.__intervals.size, usageCalls: usageCount(), probes: Object.keys(window.__renders).length };
    })()`);
    console.log('palace-polling-ui: ' + JSON.stringify(summary));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    app.exit(0);
  }
}).catch((error) => { console.error('palace-polling-ui FAILED:', error); app.exit(1); });

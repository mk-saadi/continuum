// Phase 8 virtualization regression suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/transcriptVirtual.ui.cjs
//
// chatPagination.ui.cjs proves the *behavioral* contract of the logical window
// (initial 15, ±2px prepend anchor, streaming, auto-follow, session reset). This
// suite proves the *resource* contract that Phase 8 adds on top of it:
//
//   1. the mounted DOM is bounded and independent of how much history has been
//      revealed (100 / 300 / 600 complex messages);
//   2. a genuinely tall, variable-height row is measured, mountable on demand,
//      and does not blow up the mounted range;
//   3. scrolling to an arbitrary message in a fully revealed history mounts the
//      requested identity (scroll-to-identity), not a nearby guess;
//   4. row UI state (an expanded thinking section) survives the row leaving and
//      re-entering the mounted range, and is cleared on a session switch.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const stubDesktopChat = {
  name: 'stub-desktop-chat',
  setup(build) {
    build.onResolve({ filter: /desktopChat\.mjs$/ }, () => ({
      path: path.join(__dirname, 'fixtures/desktopChatStub.mjs'),
    }));
  },
};

const BOUND = 30; // mounted rows: viewport + overscan for the tallest fixture.
const NODE_BOUND = 3000; // total document elements while a transcript is mounted.

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-virtual-ui-'));
  const window = new BrowserWindow({
    width: 820,
    height: 760,
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures/chatPagination.jsx')],
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [stubDesktopChat],
    });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find((name) => name.endsWith('.css'));
    await fs.writeFile(
      path.join(directory, 'index.html'),
      `<html><head><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`,
    );
    await window.loadFile(path.join(directory, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const results = [];
      const list = () => document.querySelector('[data-transcript-list]');
      const rows = () => list() ? [...list().querySelectorAll('[data-message-id]')] : [];
      const ids = () => rows().map((row) => row.getAttribute('data-message-id'));
      const windowCount = () => { const el = list(); return el ? Number(el.getAttribute('data-window-count')) : -1; };
      const mountedCount = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-mounted')) : -1; };
      const vtFirst = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-first')) : -1; };
      const vtLast = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-last')) : -1; };
      const scroller = () => list().parentElement;
      const nodeCount = () => document.querySelectorAll('*').length;
      const until = async (fn, message, tries = 300) => {
        for (let i = 0; i < tries; i += 1) { if (fn()) return true; await tick(); }
        throw new Error(message);
      };

      // Complex/shape-varied history so row heights are not uniform.
      const marker = 'MARKER-' + Math.random().toString(36).slice(2);
      const complexText = (i) => '# Result ' + i + '\\n\\n| Field | Value |\\n|---|---|\\n| alpha | beta |\\n\\n' +
        '\`\`\`javascript\\n' + Array.from({ length: 10 }, (_, j) => 'const value' + j + ' = ' + j + ';').join('\\n') + '\\n\`\`\`\\n\\n' +
        '- **Check** item ' + marker + '\\n'.repeat(5);
      const plainText = (i) => 'Message ' + i + ' ' + (marker + ' ').repeat(20);
      const makeMessages = (count, { complex = false, thinking = false, tallId = null } = {}) => Array.from({ length: count }, (_, index) => {
        const id = index + 1;
        const role = index % 2 === 0 ? 'user' : 'assistant';
        const message = { id, role, content: role === 'assistant' && complex ? complexText(id) : plainText(id) };
        if (thinking && role === 'assistant') message.thinking = 'THOUGHT-' + marker + '-' + id;
        if (tallId === id) message.content = Array.from({ length: 320 }, (_, line) => 'Tall row line ' + line + ' ' + marker).join('\\n');
        return message;
      });

      const assertBounded = (label) => {
        check(mountedCount() >= 1, label + ': nothing mounted');
        check(mountedCount() <= ${BOUND}, label + ': mounted rows must stay bounded, got ' + mountedCount() + ' for a window of ' + windowCount());
        check(ids().length === mountedCount(), label + ': mounted attribute must match rendered rows');
        check(ids().length === vtLast() - vtFirst() + 1, label + ': mounted rows must form one contiguous index range');
        check(vtFirst() >= 0 && vtLast() < windowCount(), label + ': mounted range must sit inside the logical window');
        check(new Set(ids()).size === ids().length, label + ': duplicate mounted rows');
        check(nodeCount() <= ${NODE_BOUND}, label + ': total DOM must stay bounded, got ' + nodeCount());
      };

      const settle = async (frames = 2) => { for (let i = 0; i < frames; i += 1) await new Promise((r) => requestAnimationFrame(() => r())); };
      const loadOlderPage = async () => {
        const before = windowCount();
        const node = scroller();
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        await until(() => windowCount() > before, 'older page did not load (window ' + before + ')', 400);
      };
      const revealAll = async (count) => {
        const guard = Math.ceil(count / 15) + 6;
        for (let i = 0; i < guard && windowCount() < count; i += 1) await loadOlderPage();
        check(windowCount() === count, 'reveal did not reach every message: ' + windowCount() + ' of ' + count);
      };

      // Scroll to a position where the mounted range includes \`targetIndex\`, then
      // center that row in the viewport. Proves scroll-to-identity rather than a
      // proportional guess.
      const revealIndex = async (targetIndex, label) => {
        const node = scroller();
        const max = Math.max(0, node.scrollHeight - node.clientHeight);
        let lo = 0;
        let hi = max;
        let best = null;
        for (let i = 0; i < 44 && lo <= hi; i += 1) {
          const mid = Math.floor((lo + hi) / 2);
          node.scrollTop = mid;
          node.dispatchEvent(new Event('scroll', { bubbles: true }));
          await tick(18);
          if (vtLast() >= targetIndex) { best = mid; hi = mid - 1; } else { lo = mid + 1; }
        }
        check(best !== null, label + ': could not reach index ' + targetIndex + ' by scrolling');
        node.scrollTop = best;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        await until(() => vtFirst() <= targetIndex && vtLast() >= targetIndex, label + ': target index not mounted after scrolling');
        const row = document.querySelector('[data-message-id="' + (targetIndex + 1) + '"]');
        check(row, label + ': target row ' + (targetIndex + 1) + ' is not mounted');
        // Center it (a row taller than the viewport can only be intersected).
        const container = node.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const delta = rect.top - container.top - (container.height - rect.height) / 2;
        node.scrollTop += delta;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        await settle(2);
        const settled = document.querySelector('[data-message-id="' + (targetIndex + 1) + '"]');
        check(settled, label + ': target row left the range while centering');
        const finalRect = settled.getBoundingClientRect();
        check(finalRect.bottom > container.top + 2 && finalRect.top < container.bottom - 2, label + ': target row must intersect the viewport');
        return { id: targetIndex + 1, height: Math.round(finalRect.height), top: Math.round(finalRect.top - container.top) };
      };

      // --- 1. Bounded DOM is independent of revealed history length ----------
      const boundsByCount = {};
      for (const count of [100, 300, 600]) {
        window.renderScenario({ key: 'bounds-' + count, sessionId: 'bounds-' + count, messages: makeMessages(count, { complex: true }) });
        await until(() => windowCount() === 15, 'bounds ' + count + ': initial window did not render');
        assertBounded('bounds ' + count + ' initial');
        const initialNodes = nodeCount();
        const initialMounted = mountedCount();
        await revealAll(count);
        assertBounded('bounds ' + count + ' revealed');
        // Sweep across the whole revealed history and re-check the bound.
        const node = scroller();
        let peakMounted = 0;
        let peakNodes = 0;
        for (let i = 0; i < 24; i += 1) {
          node.scrollTop = (node.scrollHeight - node.clientHeight) * (i / 23);
          node.dispatchEvent(new Event('scroll', { bubbles: true }));
          await tick(12);
          peakMounted = Math.max(peakMounted, mountedCount());
          peakNodes = Math.max(peakNodes, nodeCount());
        }
        check(peakMounted <= ${BOUND}, 'bounds ' + count + ': sweep mounted ' + peakMounted);
        check(peakNodes <= ${NODE_BOUND}, 'bounds ' + count + ': sweep DOM ' + peakNodes);
        check(window.__canonical.length === count, 'bounds ' + count + ': canonical history changed');
        boundsByCount[count] = { initialNodes, initialMounted, revealedNodes: nodeCount(), peakNodes };
        results.push({ name: 'bounds-' + count, ...boundsByCount[count] });
      }
      // The DOM must not scale with the conversation: 600 complex messages cost
      // about the same as 100 (allow generous slack for the sweep's peak).
      check(
        boundsByCount[600].peakNodes - boundsByCount[100].initialNodes < 700,
        'bounded DOM must not grow with history: 100->' + boundsByCount[100].initialNodes + ' 600->' + boundsByCount[600].peakNodes,
      );

      // --- 2. A tall, variable-height row is measured and mountable ----------
      window.renderScenario({ key: 'tall', sessionId: 'tall', messages: makeMessages(80, { tallId: 41 }) });
      await until(() => windowCount() === 15, 'tall: initial window did not render');
      await revealAll(80);
      assertBounded('tall revealed');
      const tall = await revealIndex(40, 'tall');
      check(tall.height > 400, 'the tall row must report its real measured height, got ' + tall.height);
      check(document.querySelector('[data-message-id="41"]').textContent.includes('Tall row line 319'), 'the tall row must render its full content');
      assertBounded('tall focused');

      // --- 3. Scroll-to-identity across a long uniform history ---------------
      window.renderScenario({ key: 'identity', sessionId: 'identity', messages: makeMessages(600) });
      await until(() => windowCount() === 15, 'identity: initial window did not render');
      await revealAll(600);
      assertBounded('identity revealed');
      for (const targetIndex of [60, 300, 540]) {
        const found = await revealIndex(targetIndex, 'identity');
        check(found.id === targetIndex + 1, 'scroll-to-identity mounted ' + found.id + ' instead of ' + (targetIndex + 1));
        assertBounded('identity at ' + targetIndex);
        results.push({ name: 'identity-' + (targetIndex + 1), ...found });
      }

      // --- 4. Row UI state survives eviction; resets on session switch -------
      window.renderScenario({ key: 'uistate', sessionId: 'uistate', messages: makeMessages(200, { thinking: true }) });
      await until(() => windowCount() === 15, 'uistate: initial window did not render');
      await revealAll(200);
      // Open the thinking section of a mid-history assistant message (even id).
      const targetId = 100;
      await revealIndex(targetId - 1, 'uistate');
      const row = document.querySelector('[data-message-id="' + targetId + '"]');
      const summary = row.querySelector('details > summary');
      check(summary, 'thinking summary must be present');
      check(!row.textContent.includes('THOUGHT-' + marker + '-' + targetId), 'thinking body should start collapsed');
      summary.click();
      await until(() => document.querySelector('[data-message-id="' + targetId + '"]').textContent.includes('THOUGHT-' + marker + '-' + targetId), 'thinking section did not expand');
      // Evict it: scroll to the tail so the row leaves the mounted range.
      const node = scroller();
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      await until(() => !document.querySelector('[data-message-id="' + targetId + '"]'), 'the row was not evicted when scrolled away');
      assertBounded('uistate after eviction');
      // Return: the expansion must have been restored.
      await revealIndex(targetId - 1, 'uistate-return');
      const restored = document.querySelector('[data-message-id="' + targetId + '"]');
      check(restored, 'the row did not re-mount');
      check(restored.textContent.includes('THOUGHT-' + marker + '-' + targetId), 'expanded state must survive the row leaving the mounted range');
      check(restored.querySelector('details[open]'), 'the restored row must reflect the expanded state on the details element');
      results.push({ name: 'row-ui-state-persist', restored: true });
      // Switching conversation clears the row UI state so a shared key cannot
      // leak one chat's expansion into another.
      window.seedSession('uistate-b', makeMessages(200, { thinking: true }));
      window.switchSession('uistate-b');
      await until(() => windowCount() === 15 && Number(list().getAttribute('data-window-last-id')) === 200, 'session switch did not reset the window');
      await revealAll(200);
      await revealIndex(targetId - 1, 'uistate-b');
      const otherRow = document.querySelector('[data-message-id="' + targetId + '"]');
      check(otherRow, 'shared id must be present in the second session');
      check(!otherRow.textContent.includes('THOUGHT-' + marker + '-' + targetId), 'row UI state must not leak across sessions');
      window.switchSession('uistate');
      await until(() => windowCount() === 15 && Number(list().getAttribute('data-window-last-id')) === 200, 'switching back did not reset the window');
      await revealAll(200);
      await revealIndex(targetId - 1, 'uistate-return2');
      const cleared = document.querySelector('[data-message-id="' + targetId + '"]');
      check(cleared && !cleared.textContent.includes('THOUGHT-' + marker + '-' + targetId), 'expanded state must be cleared after a session switch');
      results.push({ name: 'row-ui-state-session-reset', cleared: true });

      return results;
    })()`);

    const byName = Object.fromEntries(result.map((entry) => [entry.name, entry]));
    assert.ok(byName['bounds-100'] && byName['bounds-300'] && byName['bounds-600'], 'bounded-DOM scenarios must run');
    assert.ok(byName['bounds-600'].peakNodes <= NODE_BOUND, '600-message DOM must stay bounded');
    assert.ok(byName['identity-61'] && byName['identity-301'] && byName['identity-541'], 'scroll-to-identity scenarios must run');
    assert.ok(byName['row-ui-state-persist'].restored, 'row UI state must persist across eviction');
    assert.ok(byName['row-ui-state-session-reset'].cleared, 'row UI state must reset on session switch');
    console.log('Transcript virtualization: bounded DOM independent of history length, tall variable-height rows, scroll-to-identity, and cross-eviction row UI state passed.');
    for (const entry of result) console.log('  -', entry.name, JSON.stringify(entry));
  } catch (error) {
    console.error('transcriptVirtual.ui.cjs FAILED:', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(process.exitCode || 0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

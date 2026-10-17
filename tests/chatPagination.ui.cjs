// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/chatPagination.ui.cjs
//
// Phase 8: the transcript keeps a logical window (newest 15, grown by older
// pages on scroll-up) but only MOUNTS a bounded range of that window around the
// viewport. These assertions therefore check the logical window via
// `data-window-count` and the mounted rows via `data-message-id`, never assuming
// "every revealed message is in the DOM".
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
// Keep the process alive after the window is torn down so a failed assertion
// (which destroys the window in `finally`) still surfaces its stack instead of
// racing Electron's default quit-on-window-all-closed.
app.on('window-all-closed', () => {});

// Replace the real network-facing desktopChat with a deterministic stub so the
// "new message during streaming" path can be observed without an engine. Only
// the pagination fixture bundle is affected.
const stubDesktopChat = {
  name: 'stub-desktop-chat',
  setup(build) {
    build.onResolve({ filter: /desktopChat\.mjs$/ }, () => ({
      path: path.join(__dirname, 'fixtures/desktopChatStub.mjs'),
    }));
  },
};

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-pagination-ui-'));
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
      const list = () => document.querySelector('[data-transcript-list]');
      const rows = () => list() ? [...list().querySelectorAll('[data-message-id]')] : [];
      const ids = () => rows().map((row) => row.getAttribute('data-message-id'));
      const windowCount = () => { const el = list(); return el ? Number(el.getAttribute('data-window-count')) : -1; };
      const mountedCount = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-mounted')) : -1; };
      const vtFirst = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-first')) : -1; };
      const vtLast = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-last')) : -1; };
      const lastId = () => { const mounted = ids(); return mounted.length ? mounted[mounted.length - 1] : null; };
      const windowFirstId = () => { const el = list(); return el ? Number(el.getAttribute('data-window-first-id')) : -1; };
      const windowLastId = () => { const el = list(); return el ? Number(el.getAttribute('data-window-last-id')) : -1; };
      const scroller = () => list().parentElement;
      const atBottom = () => { const node = scroller(); return node.scrollHeight - (node.scrollTop + node.clientHeight) <= 2; };
      const distanceToBottom = () => { const node = scroller(); return node.scrollHeight - (node.scrollTop + node.clientHeight); };
      const topVisibleId = () => {
        const container = scroller().getBoundingClientRect();
        for (const row of rows()) {
          if (row.getBoundingClientRect().bottom > container.top) return row.getAttribute('data-message-id');
        }
        return null;
      };
      const until = async (fn, message, tries = 220) => {
        for (let i = 0; i < tries; i += 1) { if (fn()) return true; await tick(); }
        throw new Error(message);
      };
      const makeMessages = (count) => Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: 'Message ' + (index + 1) + ' ' + 'details '.repeat(20),
      }));
      const scrollToTop = async () => {
        const node = scroller();
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        await tick(30);
      };
      const sendMessage = async (text) => {
        const textarea = document.querySelector('textarea[aria-label="Message"]');
        if (!textarea) throw new Error('composer textarea missing');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        let send = null;
        for (let i = 0; i < 120; i += 1) {
          send = document.querySelector('button[aria-label="Send"]');
          if (send && !send.disabled) break;
          await tick();
        }
        if (!send) throw new Error('Send button missing');
        if (send.disabled) throw new Error('Send never enabled (value=' + textarea.value + ', window=' + windowCount() + ')');
        send.click();
      };
      // The mounted range must stay tied to the viewport + overscan, not to the
      // length of the revealed window.
      const assertBounded = (label) => {
        check(mountedCount() >= 1, label + ': nothing mounted');
        check(mountedCount() <= 40, label + ': mounted rows must stay bounded, got ' + mountedCount() + ' for a window of ' + windowCount());
        check(ids().length <= 40, label + ': too many mounted rows');
        check(ids().length === mountedCount(), label + ': mounted attribute must match rendered rows');
        check(ids().length === vtLast() - vtFirst() + 1, label + ': mounted rows must form one index range');
        check(vtFirst() >= 0 && vtLast() < windowCount(), label + ': mounted range must sit inside the logical window');
        check(new Set(ids()).size === ids().length, label + ': duplicate mounted rows');
        // Chronological order. Message ids are numeric for seeded history and
        // UUIDs for streamed replies; UUIDs sort after the numeric history.
        let sawText = false;
        let previous = -Infinity;
        for (const id of ids()) {
          const numeric = Number(id);
          if (Number.isNaN(numeric)) { sawText = true; continue; }
          check(!sawText && numeric > previous, label + ': mounted rows must be in chronological order (' + ids().join(',') + ')');
          previous = numeric;
        }
      };
      const assertChronological = (label) => {
        const mounted = ids().map(Number);
        check(mounted.every((value, index) => index === 0 || value > mounted[index - 1]), label + ': mounted rows must be chronological');
      };

      // --- 1. Initial window: newest 15 logical, bounded mounted rows ---------
      window.renderScenario({ key: 'a', sessionId: 'sess-a', messages: makeMessages(100) });
      await until(() => windowCount() === 15 && windowLastId() === 100, 'initial render did not show the newest window');
      check(windowCount() === 15, 'initial logical window must be exactly 15 messages');
      check(windowFirstId() === 86, 'initial window must be the newest 15 messages');
      assertBounded('initial');
      assertChronological('initial');
      check(window.__canonical.length === 100, 'canonical history must remain 100 messages');
      check(window.sessionMessageCount('sess-a') === 100, 'canonical store must remain intact');
      await until(() => atBottom(), 'transcript did not scroll to the newest message');

      // --- 2. Scroll to top reveals the preceding page, anchored ±2px ---------
      const node = scroller();
      node.scrollTop = 0;
      const anchorId = topVisibleId();
      check(anchorId, 'precondition: a visible row must exist at the top');
      const anchorTop = document.querySelector('[data-message-id="' + anchorId + '"]').getBoundingClientRect().top;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      await until(() => windowCount() === 30, 'scrolling to the top did not reveal older messages');
      check(windowFirstId() === 71, 'older page must be prepended in correct order');
      assertBounded('after first page');
      const anchored = document.querySelector('[data-message-id="' + anchorId + '"]');
      check(anchored, 'the previously visible message must still be mounted');
      check(
        Math.abs(anchored.getBoundingClientRect().top - anchorTop) <= 2,
        'the previously visible message must stay at the same screen position (delta ' + Math.round(anchored.getBoundingClientRect().top - anchorTop) + 'px)',
      );

      // --- 3. Repeated scrolling reaches the oldest message and then stops ----
      for (let i = 0; i < 16 && windowCount() < 100; i += 1) await scrollToTop();
      check(windowCount() === 100, 'repeated scrolling must eventually reveal every message');
      check(windowFirstId() === 1, 'full reveal must reach the oldest message');
      await scrollToTop();
      await tick(60);
      check(ids().includes('1'), 'the oldest message must become mountable at the top');
      assertBounded('fully revealed');
      assertChronological('fully revealed');
      for (let i = 0; i < 3; i += 1) await scrollToTop();
      check(windowCount() === 100, 'pagination must stop once the oldest message is reached');
      check(window.__canonical.length === 100, 'canonical history must be untouched after pagination');

      // --- 4. Messages shorter than a page, and empty conversations -----------
      window.renderScenario({ key: 'small', sessionId: 'sess-small', messages: makeMessages(5) });
      await until(() => windowCount() === 5 && windowLastId() === 5, 'short conversation did not render all messages');
      await scrollToTop();
      await scrollToTop();
      check(windowCount() === 5, 'short conversation must not paginate');
      check(mountedCount() <= 5, 'short conversation must not mount more rows than exist');
      window.renderScenario({ key: 'empty', sessionId: 'sess-empty', messages: [] });
      await until(() => document.body.textContent.includes('chatting'), 'empty conversation did not render');
      check(rows().length === 0, 'empty conversation must render no message rows');

      // --- 5. New message during streaming; full context preserved ------------
      window.renderScenario({ key: 'stream', sessionId: 'sess-stream', messages: makeMessages(100) });
      await until(() => windowCount() === 15 && windowLastId() === 100, 'stream scenario did not initialize');
      await until(() => atBottom(), 'stream scenario did not reach the bottom');
      await sendMessage('hello from the test');
      await until(() => document.querySelector('[data-message-id="1001"]'), 'new user message was not rendered');
      check(windowCount() === 15, 'sending must not grow the logical window');
      assertBounded('after send');
      check(
        document.querySelector('[data-message-id="1001"]').textContent.includes('hello from the test'),
        'new user message must appear with its text',
      );
      check(
        Array.isArray(window.__inferenceMessages) && window.__inferenceMessages.length === 101,
        'inference must receive the complete canonical context, not the rendered window',
      );
      check(window.__runDesktopChatCalls >= 1, 'generation must run after a send');
      await until(
        () => document.querySelector('[data-message-id="1002"]')?.textContent.includes('Streamed reply'),
        'streamed assistant reply did not complete',
      );
      check(windowCount() === 15, 'completed reply must remain inside the logical window');
      assertBounded('after reply');
      check(window.sessionMessageCount('sess-stream') === 102, 'canonical history must include both new messages');

      // --- 6. Auto-follow keeps the newest message visible when at the bottom -
      window.renderScenario({ key: 'follow', sessionId: 'sess-follow', messages: makeMessages(20) });
      await until(() => windowCount() === 15 && windowFirstId() === 6, 'follow scenario did not initialize');
      await until(() => atBottom(), 'follow scenario did not reach the bottom');
      await sendMessage('follow up');
      await until(() => document.querySelector('[data-message-id="1001"]'), 'follow-up user message missing');
      await tick(120);
      check(atBottom(), 'auto-scroll must keep the newest message visible while following');
      await until(() => window.sessionMessageCount('sess-follow') === 22, 'follow-up reply did not finish persisting');

      // --- 7. Reading history is not yanked to the bottom by new output -------
      window.renderScenario({ key: 'reading', sessionId: 'sess-reading', messages: makeMessages(100) });
      await until(() => windowCount() === 15 && windowLastId() === 100, 'reading scenario did not initialize');
      await until(() => atBottom(), 'reading scenario did not reach the bottom');
      await scrollToTop();
      await until(() => windowCount() === 30, 'reading scenario did not reveal a page');
      check(distanceToBottom() > 50, 'precondition: user is reading history');
      await sendMessage('while reading');
      // The new message joins the logical window but must not be scrolled to or
      // mounted while the reader is away from the bottom.
      await until(
        () => window.sessionMessageCount('sess-reading') >= 101,
        'reading user message did not join the logical window',
      );
      await tick(60);
      check(distanceToBottom() > 50, 'reading history must not be pulled to the bottom by new output');
      check(
        !document.querySelector('[data-message-id="1001"]'),
        'the newest message must not be force-mounted while the reader is away from the bottom',
      );
      await until(() => window.sessionMessageCount('sess-reading') === 102, 'reading reply did not finish persisting');

      // --- 8. Switching conversations initializes the correct window ----------
      window.renderScenario({ key: 'switch', sessionId: 'sess-x', messages: makeMessages(100) });
      await until(() => windowCount() === 15 && windowLastId() === 100, 'switch scenario did not initialize');
      for (let i = 0; i < 12 && windowCount() < 100; i += 1) await scrollToTop();
      check(windowCount() === 100, 'switch scenario did not fully expand');
      window.seedSession('sess-y', makeMessages(20));
      window.switchSession('sess-y');
      await until(() => windowCount() === 15 && windowFirstId() === 6, 'switched conversation did not reset its window');
      check(windowCount() === 15, 'a different conversation must start at the initial window, not the previous one');
      check(windowLastId() === 20, 'switched window must show the newest messages of the new chat');
      check(ids().every((id) => Number(id) >= 6 && Number(id) <= 20), 'switched window must not leak the previous conversation');
      assertBounded('switched conversation');

      return true;
    })()`);
    assert.equal(result, true);
    console.log('Automatic transcript pagination (bounded virtualized): initial window, scroll reveal with ±2px anchor, bounded mounting, chronological order, full reveal/termination, streaming, auto-follow, history reading, and conversation switching passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true });
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

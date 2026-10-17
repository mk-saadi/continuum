// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/chatFindNavigation.ui.cjs
//
// Phase 2.1: in-chat find must search the COMPLETE canonical conversation, and
// selecting an older result must reveal it with a bounded window (never mounting
// every intervening message). Reuses the chat-pagination fixture.
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

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-find-ui-'));
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
      const until = async (fn, message, tries = 260) => {
        for (let i = 0; i < tries; i += 1) { if (fn()) return true; await tick(); }
        throw new Error(message);
      };
      const list = () => document.querySelector('[data-transcript-list]');
      const rows = () => { const el = list(); return el ? [...el.querySelectorAll('[data-message-id]')] : []; };
      const ids = () => rows().map((row) => row.getAttribute('data-message-id'));
      const scroller = () => list().parentElement;
      const windowCount = () => { const el = list(); return el ? Number(el.getAttribute('data-window-count')) : -1; };
      const mountedCount = () => { const el = list(); return el ? Number(el.getAttribute('data-vt-mounted')) : -1; };
      const windowFirstId = () => { const el = list(); return el ? Number(el.getAttribute('data-window-first-id')) : -1; };
      const windowLastId = () => { const el = list(); return el ? Number(el.getAttribute('data-window-last-id')) : -1; };
      const findInput = () => document.querySelector('input[aria-label="Find in chat"]');
      const counterEl = () => document.querySelector('[role="search"] span[aria-live="polite"]');
      const counter = () => counterEl()?.textContent.trim() ?? '';
      const activeMark = () => document.querySelector('span[data-chat-find][data-active="true"]');
      const markCount = () => document.querySelectorAll('span[data-chat-find]').length;
      const rowIdOf = (node) => node?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
      const messageIdCount = (count, hitIds = []) => Array.from({ length: count }, (_, index) => {
        const id = index + 1;
        return {
          id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: 'Message ' + id + ' token-' + id + ' ' + 'details '.repeat(12) + (hitIds.includes(id) ? ' hit' : ''),
        };
      });
      const openFind = async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }));
        await until(() => findInput(), 'find bar did not open');
        return findInput();
      };
      const typeQuery = async (text) => {
        const input = findInput();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick(40);
      };
      const pressKey = (key, options = {}) => {
        findInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
      };
      const clickNext = () => document.querySelector('button[aria-label="Next match (Enter)"]').click();
      const clickPrev = () => document.querySelector('button[aria-label="Previous match (Shift+Enter)"]').click();
      const scrollToTop = async () => {
        const node = scroller();
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        await tick();
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
        if (!send || send.disabled) throw new Error('send button never enabled');
        send.click();
      };
      const assertBounded = (label, limit = 50) => {
        check(ids().length <= limit, label + ': rendered rows must stay bounded, got ' + ids().length);
        check(ids().length < 120, label + ': must not mount the whole transcript');
        check(new Set(ids()).size === ids().length, label + ': duplicate rows');
      };
      const assertActiveIn = (messageId, label) => {
        const mark = activeMark();
        check(mark, label + ': no active highlight');
        check(rowIdOf(mark) === String(messageId), label + ': active highlight is in message ' + rowIdOf(mark) + ', expected ' + messageId);
      };
      // The result counter updates in the same commit that (re)resolves the
      // active result, but an off-window target needs one more commit to mount
      // its bounded window and paint the highlight. Wait for it explicitly.
      const untilActiveIn = async (messageId, label) => {
        await until(
          () => rowIdOf(activeMark()) === String(messageId),
          label + ': active highlight never reached message ' + messageId + ' (saw ' + rowIdOf(activeMark()) + ')',
        );
      };

      // --- 1. Initial window stays the newest 15; canonical untouched ---------
      window.renderScenario({ key: 'find', sessionId: 'sess-find', messages: messageIdCount(120, [5, 55, 105]) });
      await until(() => windowCount() === 15 && windowFirstId() === 106, 'find scenario did not initialize');
      check(window.__canonical.length === 120, 'canonical history must remain 120 messages');

      // --- 2/3. A query matching only an out-of-window message is found -------
      await openFind();
      check(windowCount() === 15, 'opening find must not mount more rows');
      await typeQuery('hit');
      await until(() => counter() === '1/3', 'expected 1/3 results, got "' + counter() + '"');
      await untilActiveIn(5, 'old result');
      check(ids().includes('5'), 'the matching old message must be revealed');
      check(!ids().includes('106'), 'the newest window should be replaced by the target window');
      assertBounded('old result', 30);
      assertActiveIn(5, 'old result');

      // --- 3. The match is scrolled into view inside the transcript ----------
      await until(() => {
        const mark = activeMark();
        if (!mark) return false;
        const view = scroller().getBoundingClientRect();
        const rect = mark.getBoundingClientRect();
        return rect.top >= view.top - 2 && rect.bottom <= view.bottom + 2;
      }, 'the selected match must be visible in the viewport');

      // --- 4/5/6. Next/prev reach results many pages apart, in order, wrapping -
      await clickNext();
      await until(() => counter() === '2/3', 'next should reach 2/3, got "' + counter() + '"');
      await untilActiveIn(55, 'next');
      assertActiveIn(55, 'next');
      assertBounded('mid result', 30);
      await clickNext();
      await until(() => counter() === '3/3', 'next should reach 3/3, got "' + counter() + '"');
      await untilActiveIn(105, 'next far');
      assertActiveIn(105, 'next far');
      assertBounded('newest hit', 30);
      await clickNext();
      await until(() => counter() === '1/3', 'next must wrap to the first result');
      await untilActiveIn(5, 'wrap forward');
      assertActiveIn(5, 'wrap forward');
      await clickPrev();
      await until(() => counter() === '3/3', 'prev must wrap to the last result');
      await untilActiveIn(105, 'wrap backward');
      assertActiveIn(105, 'wrap backward');

      // --- 7. Keyboard navigation (Enter / Shift+Enter) ----------------------
      pressKey('Enter');
      await until(() => counter() === '1/3', 'Enter should advance and wrap to the first result');
      await untilActiveIn(5, 'Enter wrap');
      pressKey('Enter');
      await until(() => counter() === '2/3', 'Enter should advance to the second result');
      await untilActiveIn(55, 'Enter');
      pressKey('Enter', { shiftKey: true });
      await until(() => counter() === '1/3', 'Shift+Enter should step back to the first result');
      await untilActiveIn(5, 'Shift+Enter');
      assertActiveIn(5, 'keyboard');

      // --- 8. Ordinary pagination still works after search navigation --------
      await clickNext(); // message 55, a window with older history above it
      await until(() => counter() === '2/3', 'precondition: reach message 55');
      await untilActiveIn(55, 'precondition');
      const beforeWindow = windowCount();
      await scrollToTop();
      await until(() => windowCount() > beforeWindow, 'scrolling to the top after search navigation must reveal older messages');
      check(windowCount() > beforeWindow, 'older page must be prepended');
      assertBounded('after ordinary pagination', 60);

      // --- 9. Switching conversations cannot leak the previous target --------
      check(counter().endsWith('/3'), 'precondition: first session shows three results, got "' + counter() + '"');
      window.seedSession('sess-find-b', messageIdCount(40));
      window.switchSession('sess-find-b');
      await until(() => windowCount() === 15 && windowFirstId() === 26, 'switched conversation did not reset its window');
      await until(() => counter() === '0/0', 'search results must not carry across conversations, got "' + counter() + '"');
      check(markCount() === 0, 'marks from the previous conversation must be cleared');
      check(!ids().includes('5'), 'a target from another conversation must never be applied');

      // --- 10. Deleting a matching message drops the stale target ------------
      window.renderScenario({ key: 'delete', sessionId: 'sess-del', messages: messageIdCount(120, [5, 55, 105]) });
      await until(() => windowCount() === 15 && windowFirstId() === 106, 'delete scenario did not initialize');
      await openFind();
      await typeQuery('hit');
      await until(() => counter() === '1/3', 'delete scenario did not find three results');
      const deleteRow = document.querySelector('[data-message-id="5"]');
      check(deleteRow, 'the matching message must be revealed to delete it');
      deleteRow.querySelector('[aria-label="Delete message"]').click();
      await until(() => counter() === '1/2', 'after deletion the active result must move on, got "' + counter() + '"');
      await until(() => !ids().includes('5'), 'the deleted message must be removed from the transcript');
      await untilActiveIn(55, 'after delete');
      assertActiveIn(55, 'after delete');
      assertBounded('after delete', 30);
      check(window.sessionMessageCount('sess-del') === 119, 'canonical history must reflect the deletion');

      // --- 11. Streaming/new output updates results without corrupting them ---
      window.renderScenario({ key: 'stream', sessionId: 'sess-stream-find', messages: messageIdCount(120, [5, 55, 105]) });
      await until(() => windowCount() === 15 && windowFirstId() === 106, 'stream scenario did not initialize');
      await openFind();
      await typeQuery('hit');
      await until(() => counter() === '1/3', 'stream scenario did not find three results');
      await sendMessage('hit from the test');
      await until(() => counter() === '1/4', 'a newly sent matching message must extend the results, got "' + counter() + '"');
      await untilActiveIn(5, 'streaming keeps position');
      await clickNext();
      await until(() => counter() === '2/4', 'navigation must still work during/after streaming');
      await untilActiveIn(55, 'streaming navigation');
      assertActiveIn(55, 'streaming navigation');
      assertBounded('streaming', 30);
      check(
        Array.isArray(window.__inferenceMessages) && window.__inferenceMessages.length === 121,
        'inference must receive the full canonical context (' + (window.__inferenceMessages || []).length + ')',
      );
      check(mountedCount() <= 30, 'search navigation must not mount the whole transcript for inference');
      await until(() => window.sessionMessageCount('sess-stream-find') === 122, 'streamed reply did not finish persisting');
      check(counter() === '2/4', 'settled results must stay stable');

      // --- 12. Returning to the newest messages from an old result -----------
      window.renderScenario({ key: 'latest', sessionId: 'sess-latest', messages: messageIdCount(120, [5, 55, 105]) });
      await until(() => windowCount() === 15 && windowFirstId() === 106, 'latest scenario did not initialize');
      await openFind();
      await typeQuery('hit');
      await until(() => counter() === '1/3', 'latest scenario did not find three results');
      const jump = () => document.querySelector('button[aria-label="Jump to latest"]');
      await until(() => jump(), 'a target window below the newest messages must offer a way back');
      jump().click();
      await until(() => windowCount() === 15 && windowFirstId() === 106, 'Jump to latest must restore the newest window');
      await until(() => {
        const node = scroller();
        return node.scrollHeight - (node.scrollTop + node.clientHeight) <= 2;
      }, 'Jump to latest must scroll to the newest message');
      check(!jump(), 'the Jump to latest affordance must disappear at the bottom');
      await until(() => counter() === '1/3', 'find results must survive returning to the latest messages');
      check(!activeMark(), 'returning to the latest messages must not leave a stale off-window highlight');
      await clickNext();
      await until(() => counter() === '2/3', 'navigation must work again after returning');
      await untilActiveIn(55, 'after return navigation');

      // --- 13. Canonical history and inference inputs stay complete ----------
      check(window.__canonical.length === 120, 'canonical history must never be truncated by search navigation');
      check(window.sessionMessageCount('sess-latest') === 120, 'the persisted store must be unchanged by search navigation');

      return true;
    })()`);
    assert.equal(result, true);
    console.log('In-chat find over canonical history: full-history matching, bounded navigation to old results, next/prev wrapping, keyboard, pagination, session isolation, deletion, streaming, and return-to-latest passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true });
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

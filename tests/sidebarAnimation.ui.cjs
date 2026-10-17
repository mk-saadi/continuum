// Phase 3 sidebar animation/layout regression suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/sidebarAnimation.ui.cjs
//
// Renders the REAL ChatInterface (both sidebars) through the sidebar fixture and
// verifies observable layout/interaction behaviour: panel geometry, transcript
// space, pointer interception, controls, scroll preservation, pagination,
// search navigation, streaming/auto-follow and accessibility state.
//
// The window is 1000px wide so BOTH sidebars are in-flow flex items (the right
// sidebar becomes an absolute overlay below 900px, which is exercised by the
// existing rightSidebarSliders/contextPanel suites).
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidebar-animation-ui-'));
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    show: true,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'fixtures/sidebarAnimation.jsx')],
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
      const until = async (fn, message, tries = 300) => {
        for (let i = 0; i < tries; i += 1) { if (fn()) return true; await tick(); }
        throw new Error(message);
      };
      const list = () => document.querySelector('[data-transcript-list]');
      const rows = () => { const el = list(); return el ? [...el.querySelectorAll('[data-message-id]')] : []; };
      const ids = () => rows().map((row) => row.getAttribute('data-message-id'));
      const windowCount = () => { const el = list(); return el ? Number(el.getAttribute('data-window-count')) : -1; };
      const windowFirstId = () => { const el = list(); return el ? Number(el.getAttribute('data-window-first-id')) : -1; };
      // Wait for the fixture named by key to be mounted AND fully rendered, so a
      // previous (still unmounting) scenario's rows can never satisfy the wait.
      // Phase 8: the logical window (data-window-count) is the stable size; the
      // number of MOUNTED rows is bounded and must not be asserted exactly.
      const ready = (key, expectedWindow, firstId = null) => until(
        () => window.__scenarioKey === key
          && windowCount() === expectedWindow
          && rows().length > 0
          && (firstId === null || String(windowFirstId()) === String(firstId)),
        key + ' scenario did not render (window=' + windowCount() + ', first=' + windowFirstId() + ')',
      );
      const scroller = () => list().parentElement;
      const topVisibleId = () => {
        const node = scroller();
        const top = node.getBoundingClientRect().top;
        const visible = rows().filter((row) => row.getBoundingClientRect().bottom > top + 1);
        return visible[0]?.getAttribute('data-message-id') ?? null;
      };
      const anchorStillInView = (id) => {
        const node = scroller();
        const view = node.getBoundingClientRect();
        const row = node.querySelector('[data-message-id="' + id + '"]');
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        return rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
      };
      const leftSpacer = () => document.querySelector('#chat-sidebar');
      const leftPanel = () => leftSpacer().firstElementChild;
      const rightSpacer = () => document.querySelector('#right-sidebar');
      const rightPanel = () => rightSpacer().firstElementChild;
      const width = (node) => Math.round(node.getBoundingClientRect().width);
      const style = (node) => getComputedStyle(node);
      const translateOf = (node) => style(node).translate;
      const isShown = (node) => {
        const translate = translateOf(node);
        return Number(style(node).opacity) > 0.99 && (translate === '0px' || translate === 'none' || translate === '');
      };
      const isHidden = (node) => Number(style(node).opacity) < 0.01;
      const rowIdOf = (node) => node?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
      const counter = () => document.querySelector('[role="search"] span[aria-live="polite"]')?.textContent.trim() ?? '';
      const activeMark = () => document.querySelector('span[data-chat-find][data-active="true"]');
      const findInput = () => document.querySelector('input[aria-label="Find in chat"]');
      const makeMessages = (count, hitIds = []) => Array.from({ length: count }, (_, index) => {
        const id = index + 1;
        return {
          id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: 'Message ' + id + ' token-' + id + ' ' + 'details '.repeat(14) + (hitIds.includes(id) ? ' hit' : ''),
        };
      });
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
      const typeQuery = async (input, text) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick(40);
      };

      // --- 1. Left sidebar opens and closes correctly ------------------------
      window.renderSidebarScenario({ key: 'left', sessionId: 'sid-left', messages: makeMessages(30) });
      await ready('left', 15);
      check(width(leftSpacer()) === 0, 'left sidebar must start collapsed');
      check(leftSpacer().hasAttribute('inert'), 'closed left sidebar must be inert');
      check(leftSpacer().getAttribute('aria-hidden') === 'true', 'closed left sidebar must be aria-hidden');
      await tick(60);
      check(isHidden(leftPanel()), 'closed left panel must be visually hidden');
      check(translateOf(leftPanel()) === '-100%', 'closed left panel must be translated off-canvas to the left');
      window.__setLeftOpen(true);
      await until(() => width(leftSpacer()) === 272, 'left sidebar spacer did not expand to 272px');
      await until(() => isShown(leftPanel()), 'left panel did not finish opening');
      check(translateOf(leftPanel()) === '0px', 'open left panel must be at its resting position');
      check(!leftSpacer().hasAttribute('inert'), 'open left sidebar must not be inert');
      check(leftSpacer().getAttribute('aria-hidden') === 'false', 'open left sidebar must not be aria-hidden');
      window.__setLeftOpen(false);
      await until(() => width(leftSpacer()) === 0, 'left sidebar spacer did not collapse');
      await until(() => isHidden(leftPanel()), 'left panel did not finish closing');
      check(leftSpacer().hasAttribute('inert'), 're-closed left sidebar must be inert');

      // --- 2. Right sidebar opens and closes correctly -----------------------
      window.renderSidebarScenario({ key: 'right', sessionId: 'sid-right', messages: makeMessages(30) });
      await ready('right', 15);
      check(width(rightSpacer()) === 0, 'right sidebar must start collapsed');
      await tick(60);
      check(isHidden(rightPanel()), 'closed right panel must be visually hidden');
      check(translateOf(rightPanel()) === '100%', 'closed right panel must be translated off-canvas to the right');
      window.__setRightOpen(true);
      await until(() => width(rightSpacer()) === 320, 'right sidebar spacer did not expand to 320px');
      await until(() => isShown(rightPanel()), 'right panel did not finish opening');
      check(translateOf(rightPanel()) === '0px', 'open right panel must be at its resting position');
      check(!rightSpacer().hasAttribute('inert'), 'open right sidebar must not be inert');
      window.__setRightOpen(false);
      await until(() => width(rightSpacer()) === 0, 'right sidebar spacer did not collapse');
      await until(() => isHidden(rightPanel()), 'right panel did not finish closing');
      check(rightSpacer().hasAttribute('inert'), 're-closed right sidebar must be inert');

      // --- 3. Rapid toggling never leaves a panel stuck ----------------------
      window.renderSidebarScenario({ key: 'rapid', sessionId: 'sid-rapid', messages: makeMessages(20) });
      await ready('rapid', 15);
      // An even number of toggles from the closed baseline must land back closed.
      for (let i = 0; i < 8; i += 1) window.__toggleLeft();
      await until(() => width(leftSpacer()) === 0 && isHidden(leftPanel()), 'even rapid left toggles left it stuck open');
      check(leftSpacer().hasAttribute('inert'), 'rapidly closed left sidebar must be inert');
      // An odd number must land open, clearing inert/aria-hidden.
      for (let i = 0; i < 7; i += 1) window.__toggleLeft();
      await until(() => width(leftSpacer()) === 272 && isShown(leftPanel()), 'odd rapid left toggles left it stuck closed');
      check(!leftSpacer().hasAttribute('inert'), 'rapidly opened left sidebar must clear inert');
      // A single toggle must close it again.
      window.__toggleLeft();
      await until(() => width(leftSpacer()) === 0 && isHidden(leftPanel()), 'a single left toggle did not close it');
      check(leftSpacer().hasAttribute('inert'), 'left sidebar closed by a single toggle must be inert');
      for (let i = 0; i < 6; i += 1) window.__toggleRight();
      await until(() => width(rightSpacer()) === 0 && isHidden(rightPanel()), 'even rapid right toggles left it stuck open');
      check(rightSpacer().hasAttribute('inert'), 'rapidly closed right sidebar must be inert');
      for (let i = 0; i < 5; i += 1) window.__toggleRight();
      await until(() => width(rightSpacer()) === 320 && isShown(rightPanel()), 'odd rapid right toggles left it stuck closed');
      check(!rightSpacer().hasAttribute('inert'), 'rapidly opened right sidebar must clear inert');

      // --- 4 + 5. Both panels in sequence + transcript space -----------------
      window.renderSidebarScenario({ key: 'space', sessionId: 'sid-space', messages: makeMessages(40) });
      await ready('space', 15);
      const rootWidth = width(leftSpacer().parentElement);
      const none = width(scroller());
      window.__setLeftOpen(true);
      await until(() => width(leftSpacer()) === 272 && isShown(leftPanel()), 'left panel did not open for spacing test');
      const leftOnly = width(scroller());
      window.__setRightOpen(true);
      await until(() => width(rightSpacer()) === 320 && isShown(rightPanel()), 'right panel did not open for spacing test');
      const both = width(scroller());
      window.__setLeftOpen(false);
      await until(() => width(leftSpacer()) === 0 && isHidden(leftPanel()), 'left panel did not close for spacing test');
      const rightOnly = width(scroller());
      window.__setRightOpen(false);
      await until(() => width(rightSpacer()) === 0 && isHidden(rightPanel()), 'right panel did not close for spacing test');
      check(Math.abs(none - rootWidth) <= 2, 'with both sidebars closed the transcript must fill the chat root');
      check(Math.abs(leftOnly - (none - 272)) <= 4, 'opening the left sidebar must reduce the transcript by 272px');
      check(Math.abs(rightOnly - (none - 320)) <= 4, 'opening the right sidebar must reduce the transcript by 320px');
      check(Math.abs(both - (none - 272 - 320)) <= 6, 'both sidebars open must reduce the transcript by 592px');
      check(both < leftOnly && both < rightOnly && leftOnly < none, 'the transcript must expand when each sidebar closes');

      // --- 6. A closed sidebar does not intercept transcript pointer input ---
      window.__setLeftOpen(false);
      window.__setRightOpen(false);
      await until(
        () => width(leftSpacer()) === 0 && width(rightSpacer()) === 0 && isHidden(leftPanel()) && isHidden(rightPanel()),
        'sidebars did not return to closed for the pointer test',
      );
      const view = scroller().getBoundingClientRect();
      const midY = view.top + view.height / 2;
      const leftHit = document.elementFromPoint(view.left + 4, midY);
      const rightHit = document.elementFromPoint(view.right - 4, midY);
      check(leftHit && scroller().contains(leftHit), 'closed left sidebar must not intercept transcript clicks');
      check(rightHit && scroller().contains(rightHit), 'closed right sidebar must not intercept transcript clicks');
      window.__setLeftOpen(true);
      await until(() => isShown(leftPanel()), 'left panel did not reopen for the pointer test');
      const openHit = document.elementFromPoint(4, midY);
      check(openHit && leftSpacer().contains(openHit), 'open left sidebar must occupy the left edge');
      window.__setLeftOpen(false);
      await until(() => isHidden(leftPanel()), 'left panel did not reclose after the pointer test');

      // --- 7. Existing sidebar controls and content remain functional --------
      check(leftSpacer().querySelector('aside[aria-label="Chat navigation"]'), 'left sidebar navigation landmark missing');
      window.__setRightOpen(true);
      await until(() => isShown(rightPanel()), 'right panel did not open for the controls test');
      check(rightSpacer().getAttribute('aria-label') === 'Chat controls', 'right sidebar controls landmark missing');
      const closeButton = rightSpacer().querySelector('button[aria-label="Close chat controls"]');
      check(closeButton, 'right sidebar close control missing');
      closeButton.click();
      await until(() => width(rightSpacer()) === 0 && isHidden(rightPanel()), 'the right sidebar close control did not close it');

      // --- 8 + 9. Reading history survives a toggle; pagination still works --
      window.renderSidebarScenario({ key: 'read', sessionId: 'sid-read', messages: makeMessages(100) });
      await ready('read', 15, '86');
      await scrollToTop();
      await until(() => windowCount() === 30, 'read scenario did not reveal an older page');
      const anchor = topVisibleId();
      const beforeTop = scroller().scrollTop;
      check(anchor && anchor !== ids()[0], 'precondition: the reader is mid-history, not at the very top');
      check(scroller().scrollHeight - (beforeTop + scroller().clientHeight) > 50, 'precondition: user is reading history');
      window.__setLeftOpen(true);
      await until(() => isShown(leftPanel()), 'left panel did not open while reading history');
      await tick(80);
      // Narrowing the transcript reflows text, so the byte offset may be adjusted
      // by scroll anchoring; what must hold is that the message the user was
      // reading stays in view rather than being yanked to the top or bottom.
      check(
        anchorStillInView(anchor),
        'toggling a sidebar must keep the message being read in view',
      );
      check(scroller().scrollTop > 0, 'toggling a sidebar must not reset a history reader to the top');
      check(
        scroller().scrollHeight - (scroller().scrollTop + scroller().clientHeight) > 50,
        'toggling a sidebar must not yank a history reader to the bottom',
      );
      const countWhileOpen = windowCount();
      await scrollToTop();
      await until(
        () => windowCount() > countWhileOpen,
        'pagination must still reveal older messages after a sidebar toggle',
      );
      check(window.__canonical.length === 100, 'canonical history must remain intact after toggling');

      // --- 10. Search navigation remains correct after a sidebar toggle ------
      window.renderSidebarScenario({ key: 'find', sessionId: 'sid-find', messages: makeMessages(120, [5, 55, 105]), left: true });
      await ready('find', 15, '106');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true }));
      await until(() => findInput(), 'find bar did not open');
      await typeQuery(findInput(), 'hit');
      await until(() => counter() === '1/3', 'expected 1/3 results, got "' + counter() + '"');
      await until(() => rowIdOf(activeMark()) === '5', 'the old match was not revealed');
      window.__setLeftOpen(false);
      await until(() => isHidden(leftPanel()), 'left panel did not close during search');
      document.querySelector('button[aria-label="Next match (Enter)"]').click();
      await until(() => counter() === '2/3', 'next match did not advance to 2/3 after toggling');
      await until(() => rowIdOf(activeMark()) === '55', 'next match highlight is not in message 55 after toggling');

      // --- 11. Streaming and auto-follow still work with a sidebar open ------
      window.renderSidebarScenario({ key: 'stream', sessionId: 'sid-stream', messages: makeMessages(20), left: true });
      await ready('stream', 15, '6');
      await until(() => {
        const node = scroller();
        return node.scrollHeight - (node.scrollTop + node.clientHeight) <= 2;
      }, 'stream scenario did not reach the bottom');
      await sendMessage('hello after a sidebar toggle');
      await until(() => document.querySelector('[data-message-id="1001"]'), 'the sent message did not appear');
      await tick(140);
      const streamNode = scroller();
      check(
        streamNode.scrollHeight - (streamNode.scrollTop + streamNode.clientHeight) <= 2,
        'auto-follow must keep the newest message visible with a sidebar open',
      );
      check(
        window.__inferencePrepared && window.__inferencePrepared.count === 21,
        'inference must still receive the complete canonical history (20 + 1)',
      );

      // --- 12. Accessibility / focus state mirrors the open state ------------
      const focusableIn = (root) => [...root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
        .find((node) => !node.disabled && node.tabIndex >= 0 && node.offsetParent !== null);
      const navButton = focusableIn(leftSpacer());
      check(navButton, 'left sidebar has no focusable control to probe');
      navButton.focus();
      check(document.activeElement === navButton, 'an open sidebar control must be focusable');
      window.__setLeftOpen(false);
      await until(() => isHidden(leftPanel()), 'left panel did not close for the focus test');
      navButton.focus();
      check(document.activeElement !== navButton, 'a closed sidebar control must not be focusable');
      check(leftSpacer().hasAttribute('inert'), 'a closed sidebar must stay inert');
      check(leftSpacer().getAttribute('aria-hidden') === 'true', 'a closed sidebar must stay aria-hidden');

      return true;
    })()`);
    assert.equal(result, true);
    console.log('Sidebar animation/layout: open/close, rapid toggling, sequencing, transcript space, pointer interception, controls, scroll preservation, pagination, search navigation, streaming and accessibility passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true });
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

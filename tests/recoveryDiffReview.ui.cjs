// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/recoveryDiffReview.ui.cjs
// Under plain `node --test` the browser flow below is skipped (it needs the
// Electron harness); parser coverage lives in tests/diffView.test.mjs.
const IS_ELECTRON = !!process.versions.electron;
if (!IS_ELECTRON) {
  const test = require('node:test');
  test('diff review browser flow requires the electron harness', async (t) => {
    t.skip('run under xvfb-run electron');
  });
} else {
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
// Electron quits when the last window closes: without this, a failure thrown
// after window.destroy() in the finally below loses its rejection and the
// run exits 0 silently. Verified empirically — keeps failures loud.
app.on('window-all-closed', (event) => event.preventDefault());
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'recovery-diff-ui-'));
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import DiffReviewModal from './src/components/chat/DiffReviewModal';
        window.apiCalls = { preview: [], restore: [] };
        window.reviewState = { filesVersion: 0, coverNull: false, scenario: 'safe', previewCalls: 0 };
        window.runActive = false;
        const fullList = () => ([
          { path: 'a.jsx', status: 'modified', staged: false, unstaged: true, untracked: false, added: 3, deleted: 1 },
          { path: 'b.txt', status: 'modified', staged: true, unstaged: false, untracked: false, added: 40, deleted: 2 },
          { path: 'new.txt', status: 'untracked', staged: false, unstaged: false, untracked: true, added: 2, deleted: 0, bytes: 12 },
          { path: 'img.bin', status: 'modified', staged: false, unstaged: true, untracked: false, binary: true, bytes: 2048 },
        ]);
        const unifiedA = [
          'diff --git a/a.jsx b/a.jsx', 'index 111..222 100644', '--- a/a.jsx', '+++ b/a.jsx',
          '@@ -1,3 +1,4 @@', ' same', '-old line', '+const color = "new line";', '+extra line', ' tail',
        ].join('\\n');
        const truncatedB = '@@ -1,1 +1,1 @@\\n-x\\n+Y\\n'.repeat(120) + '\\n[Output truncated]';
        const safePreview = () => ({
          complete: true, strategy: 'preview', dryRun: true, preRestoreCheckpointId: null,
          restored: [{ path: 'a.jsx', action: 'restored' }], removed: [], skipped: [], warnings: [],
          safety: { verdict: 'safe', anomalies: [], warnings: [], filesWouldEmpty: 0, bytesWouldDestroy: 0 },
        });
        const refusedRestore = () => ({
          complete: false, strategy: 'refused', dryRun: false, preRestoreCheckpointId: null,
          restored: [], removed: [], skipped: [], warnings: [],
          safety: { verdict: 'refused', filesWouldEmpty: 1, bytesWouldDestroy: 9,
            anomalies: [{ type: 'empty-over-nonempty', message: 'Revert would empty 1 file.',
              paths: [{ path: 'a.jsx', currentSize: 9 }] }], warnings: [] },
        });
        window.api = {
          getRecoveryChangedFiles: async () => {
            const files = fullList();
            return { branch: 'main', files: window.reviewState.filesVersion === 0 ? files : files.filter((f) => f.path !== 'a.jsx'), truncated: false };
          },
          getRecoveryFileDiff: async (sessionId, relPath) => {
            if (relPath === 'b.txt') return { path: relPath, untracked: false, binary: false, bytes: null, text: truncatedB, truncated: true };
            if (relPath === 'new.txt') return { path: relPath, untracked: true, binary: false, bytes: 12, text: 'hello\\nworld\\n', truncated: false };
            if (relPath === 'img.bin') return { path: relPath, untracked: false, binary: true, bytes: 2048, text: null, truncated: false };
            return { path: relPath, untracked: false, binary: false, bytes: null, text: unifiedA, truncated: false };
          },
          getRecoveryCoveringCheckpoint: async (sessionId, relPath) => {
            if (window.reviewState.coverNull) return { checkpointId: null };
            return { checkpointId: 7, createdAt: '2026-10-14 06:00:00', kind: 'op' };
          },
          previewRecoveryRestore: async (sessionId, id, options) => {
            window.apiCalls.preview.push({ id, ...options });
            window.reviewState.previewCalls++;
            return safePreview();
          },
          restoreRecoveryCheckpoint: async (sessionId, id, options) => {
            window.apiCalls.restore.push({ id, ...options });
            if (window.reviewState.scenario === 'failure') throw new Error('disk vanished');
            if (window.reviewState.scenario === 'slow') await new Promise((resolve) => setTimeout(resolve, 250));
            if (window.reviewState.scenario === 'refused-restore') return refusedRestore();
            window.reviewState.filesVersion = 1;
            return { complete: true, strategy: 'per-path', preRestoreCheckpointId: 11, undoPinned: true,
              restored: [{ path: 'a.jsx', action: 'restored' }], removed: [], skipped: [], warnings: [],
              safety: { verdict: 'safe', anomalies: [], warnings: [], filesWouldEmpty: 0, bytesWouldDestroy: 0 } };
          },
        };
        const root = createRoot(document.getElementById('root'));
        window.rerender = () => root.render(
          <DiffReviewModal sessionId="chat-1" projectName="demo" running={!!window.runActive} onClose={() => { window.closed = true; }} />);
        window.rerender();
    `, loader: 'jsx', resolveDir: process.cwd() },
      bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    // Pass the built app stylesheet to also exercise actual layout geometry.
    if (process.env.DIFF_REVIEW_CSS) {
      await window.webContents.insertCSS(await fs.readFile(process.env.DIFF_REVIEW_CSS, 'utf8'));
      await window.webContents.executeJavaScript('window.checkLayout = true');
    }
    // Rejections inside executeJavaScript are invisible to the outer catch
    // in this harness, so the evaluated script returns errors as values and
    // the assertion below fails loudly in main instead.
    const evalResult = await window.webContents.executeJavaScript(`(async () => {
      const flow = (async () => {
      try {
      const tick = () => new Promise(resolve => setTimeout(resolve, 60));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      const button = (label) => {
        const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
        if (!found) throw new Error('missing button: ' + label);
        return found;
      };
      const fileRow = (name) => {
        const found = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(name) && b.textContent !== name);
        if (!found) throw new Error('missing file row: ' + name);
        return found;
      };
      const selectFile = async (name) => {
        const row = fileRow(name);
        row.click();
        await tick(); await tick();
        // Let the selection change flush first: the previous file's covering
        // line is still in the DOM on the synchronous read after click, so
        // wait out the loading state before asserting on fresh content.
        for (let i = 0; i < 40 && text().includes('Loading diff…'); i++) await tick();
        for (let i = 0; i < 40 && !text().includes('Covered by checkpoint') && !text().includes('never captured'); i++) await tick();
      };
      for (let i = 0; i < 80 && !text().includes('Review changes'); i++) await tick();
      for (let i = 0; i < 80 && !text().includes('old line'); i++) await tick();

      const bounds = () => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        return { modal: rect('dialog'), footer: rect('[aria-label="Revert controls"]'), files: rect('[aria-label="Changed files"]'), list: rect('[aria-label="Changed files"] ul'), column: rect('[aria-label="File diff"]') };
      };
      const initialBounds = bounds();
      const checkStableLayout = (state) => {
        if (!window.checkLayout) return;
        const current = bounds();
        check(Math.abs(current.modal.height - initialBounds.modal.height) < 1, state + ': modal height stays fixed');
        check(Math.abs(current.footer.bottom - initialBounds.footer.bottom) < 1, state + ': controls stay at the bottom');
        check(Math.abs(current.files.bottom - current.column.bottom) < 1, state + ': file section fills height');
        check(Math.abs(current.list.bottom - current.files.bottom) < 1, state + ': file list fills section');
      };
      checkStableLayout('initial');
      const overwrite = document.querySelector('[aria-label="Revert controls"] input[type="checkbox"]');
      overwrite.click(); await tick(); await tick();
      checkStableLayout('overwrite preview');
      overwrite.click(); await tick(); await tick();
      checkStableLayout('overwrite reset');

      // 1. File list rows carry paths, counts, and status flags.
      check(text().includes('a.jsx'), 'modified file listed');
      check(text().includes('+3/−1'), 'added/deleted counts shown');
      check(text().includes('untracked'), 'untracked badge shown');
      check(text().includes('staged'), 'staged badge shown');
      check(text().includes('binary · 2.0 KiB'), 'binary size shown');

      // 2. Side-by-side pairs deletions with additions; unified toggle shows raw hunks.
      check(text().includes('@@ -1,3 +1,4 @@'), 'hunk header shown');
      check(text().includes('new line'), 'addition side shown');
      for (let i = 0; i < 80 && !document.querySelector('[aria-label="Updated code"] span[style*="--code-keyword"]'); i++) await tick();
      check(document.querySelector('[aria-label="Updated code"] span[style*="--code-keyword"]'), 'JSX syntax tokens use theme colors');
      check(document.querySelectorAll('[aria-label="Side-by-side diff"] pre').length === 2, 'one code block per pane instead of per-row scrollbars');
      check(text().includes('Original') && text().includes('Updated'), 'split columns clearly labeled');
      button('Unified').click(); await tick();
      check(text().includes('-old line'), 'unified text shown');
      button('Side-by-side').click(); await tick();

      // 3. Truncated diffs fall back to unified with a note; untracked shows additions.
      await selectFile('b.txt');
      check(text().includes('Diff truncated for display'), 'truncation noted');
      check(text().includes('Side-by-side unavailable'), 'unified fallback explained');
      await selectFile('new.txt');
      check(text().includes('hello'), 'untracked content shown as additions');
      await selectFile('img.bin');
      check(text().includes('Binary file') && text().includes('2.0 KiB'), 'binary shown without content');
      check(!text().includes('old line'), 'binary leaks no file bytes');
      checkStableLayout('binary selection');
      await selectFile('a.jsx');

      // 4. Safe revert: preview, single dispatch with the file scope, undo point, list refresh.
      window.reviewState.scenario = 'safe';
      window.apiCalls.restore.length = 0;
      button('Preview revert').click(); await tick(); await tick();
      check(text().includes('Preview: complete revert'), 'revert preview renders');
      checkStableLayout('revert preview');
      button('Revert this file…').click();
      for (let i = 0; i < 40 && !document.querySelector('[role=alertdialog]'); i++) await tick();
      check(document.querySelector('[role=alertdialog]'), 'confirm step still required');
      checkStableLayout('confirmation');
      button('Confirm revert').click(); await tick(); await tick(); await tick();
      check(window.apiCalls.restore.length === 1, 'safe revert dispatched once');
      check(window.apiCalls.restore[0].id === 7, 'revert targets the covering checkpoint');
      check(JSON.stringify(window.apiCalls.restore[0].paths) === JSON.stringify(['a.jsx']), 'revert scoped to the file');
      check(window.apiCalls.restore[0].allowRisky === false && window.apiCalls.restore[0].force === false, 'no authorization flags');
      check(text().includes('Undo point #11 (pinned against cleanup)'), 'success reports undo pin');
      check(text().includes('Changed files (3)'), 'list refreshes after revert');

      // 5. Repeated clicks: single dispatch (busy guard).
      window.reviewState.filesVersion = 0;
      window.reviewState.scenario = 'slow';
      window.apiCalls.restore.length = 0;
      button('Refresh').click(); await tick(); await tick();
      await selectFile('a.jsx');
      button('Preview revert').click(); await tick(); await tick();
      button('Revert this file…').click();
      for (let i = 0; i < 40 && !document.querySelector('[role=alertdialog]'); i++) await tick();
      const confirm = button('Confirm revert');
      confirm.click(); confirm.click();
      for (let i = 0; i < 40 && window.apiCalls.restore.length === 0; i++) await tick();
      await tick(); await tick();
      check(window.apiCalls.restore.length === 1, 'double click dispatches once');
      window.reviewState.scenario = 'safe';

      // 6. Active run refuses reverting.
      window.runActive = true; window.rerender(); await tick(); await tick();
      check(text().includes('Stop the run to enable reverting'), 'running state explained');
      check(button('Revert this file…').disabled, 'revert blocked while running');
      window.runActive = false; window.rerender(); await tick(); await tick();

      // 7. No covering checkpoint: clear error naming the path, no dispatch.
      // The slow restore above removed a.jsx from the mocked list again, so
      // restore the full list first (selection stays put across Refresh).
      window.reviewState.coverNull = true;
      window.reviewState.filesVersion = 0;
      window.apiCalls.restore.length = 0;
      button('Refresh').click(); await tick(); await tick();
      await selectFile('a.jsx');
      check(text().includes('No recovery checkpoint covers a.jsx yet'), 'missing coverage explained');
      check(button('Revert this file…').disabled, 'revert unavailable without coverage');
      check(window.apiCalls.restore.length === 0, 'nothing dispatched without coverage');
      window.reviewState.coverNull = false;
      await selectFile('b.txt');
      await selectFile('a.jsx');

      // 8. Failure: the actual backend error is shown.
      window.reviewState.scenario = 'failure';
      button('Preview revert').click(); await tick(); await tick();
      button('Revert this file…').click();
      for (let i = 0; i < 40 && !document.querySelector('[role=alertdialog]'); i++) await tick();
      button('Confirm revert').click(); await tick(); await tick(); await tick();
      check(text().includes('Revert failed: disk vanished'), 'actual failure message shown');
      window.reviewState.scenario = 'safe';

      // 9. Backend refusal surfaces the verdict panel, not a generic error.
      window.reviewState.scenario = 'refused-restore';
      button('Preview revert').click(); await tick(); await tick();
      button('Revert this file…').click();
      for (let i = 0; i < 40 && !document.querySelector('[role=alertdialog]'); i++) await tick();
      button('Confirm revert').click(); await tick(); await tick(); await tick();
      check(text().includes('Restore refused'), 'refusal verdict shown');
      check(text().includes('No files were changed'), 'refusal states nothing changed');
      check(!text().includes('Revert failed'), 'no generic error for verdict refusals');
        return { ok: true };
      } catch (error) { return { evalError: error?.message ?? String(error) }; }
      })();
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 90000));
      return Promise.race([flow, timeout]);
    })()`);
    if (evalResult?.evalError) throw new Error(`UI flow failed: ${evalResult.evalError}`);
    if (evalResult?.timedOut) throw new Error('UI flow timed out without completing');
    require('node:fs').writeSync(1, `DIFF-EVAL-RESULT ${JSON.stringify(evalResult).slice(0, 200)}\n`);
    require('node:fs').writeSync(1, 'Diff review list, split/unified diffs, revert confirm, busy-guard, running gate, coverage, failure, and refusal passed.\n');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { require('node:fs').writeSync(2, `${error?.stack ?? error}\n`); app.exit(1); });
}

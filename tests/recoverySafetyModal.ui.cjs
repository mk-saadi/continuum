// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/recoverySafetyModal.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'recovery-safety-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import RecoveryHistoryModal from './src/components/chat/RecoveryHistoryModal';
        window.apiCalls = { preview: [], restore: [] };
        window.scenario = 'safe';
        window.previewCalls = 0;
        const detail = {
          id: 9, kind: 'op', tool: 'write_project_file', pinned: false, createdAt: '2026-10-14 06:00:00',
          originChat: 'abc12345',
          coverage: { complete: true, skipped: [], excluded: [], emptyFiles: ['a.txt'] },
          op: null, totalPaths: 1, truncated: false,
          paths: [{ path: 'a.txt', recorded: 'file', current: 'file', status: 'modified', recordedSize: 0, currentSize: 9 }],
        };
        const safePreview = () => ({
          complete: true, strategy: 'preview', dryRun: true, preRestoreCheckpointId: null,
          restored: [{ path: 'a.txt', action: 'restored' }], removed: [], skipped: [], warnings: [],
          safety: { verdict: 'safe', anomalies: [], warnings: [], filesWouldEmpty: 0, bytesWouldDestroy: 0 },
        });
        const riskyPreview = () => ({
          complete: false, strategy: 'authorization-required', dryRun: true, preRestoreCheckpointId: null,
          restored: [], removed: [], skipped: [], warnings: [],
          safety: { verdict: 'authorization-required', filesWouldEmpty: 1, bytesWouldDestroy: 9,
            anomalies: [{ type: 'empty-over-nonempty', message: 'Restore would turn 1 non-empty file(s) into empty files (9 bytes of current content).',
              paths: [{ path: 'a.txt', currentSize: 9 }] }], warnings: [] },
        });
        const refusedPreview = () => ({
          complete: false, strategy: 'refused', dryRun: true, preRestoreCheckpointId: null,
          restored: [], removed: [], skipped: [], warnings: [],
          safety: { verdict: 'refused', filesWouldEmpty: 4, bytesWouldDestroy: 40,
            anomalies: [{ type: 'degenerate-checkpoint', message: 'Checkpoint file records are nearly all empty (4/4).', paths: ['x.txt'] },
              { type: 'empty-over-nonempty', message: 'Restore would turn 4 non-empty file(s) into empty files.', paths: [{ path: 'x.txt', currentSize: 10 }] }], warnings: [] },
        });
        window.api = {
          getRecoveryHistory: async () => ({ mine: [
            { id: 9, kind: 'op', tool: 'write_project_file', pinned: false, createdAt: '2026-10-14 06:00:00', originChat: 'abc12345', mine: true, coverageComplete: true, skipped: [], excludedCount: 0, emptyFileCount: 1, changedTotal: null, changedKinds: null },
          ], other: [] }),
          getRecoveryDetail: async () => detail,
          previewRecoveryRestore: async (sessionId, id, options) => {
            window.apiCalls.preview.push({ ...options });
            window.previewCalls++;
            if (window.scenario === 'stale-first') return window.previewCalls === 1 ? safePreview() : riskyPreview();
            if (window.scenario === 'risky') return riskyPreview();
            if (window.scenario === 'refused') return refusedPreview();
            return safePreview();
          },
          restoreRecoveryCheckpoint: async (sessionId, id, options) => {
            window.apiCalls.restore.push({ ...options });
            if (window.scenario === 'failure') throw new Error('disk vanished');
            if (window.scenario === 'slow') await new Promise((resolve) => setTimeout(resolve, 250));
            return { complete: true, strategy: 'per-path', preRestoreCheckpointId: 11, undoPinned: true,
              restored: [{ path: 'a.txt', action: 'restored' }], removed: [], skipped: [], warnings: [],
              safety: { verdict: window.scenario === 'safe' ? 'safe' : 'authorization-required', anomalies: [], warnings: [], filesWouldEmpty: 0, bytesWouldDestroy: 0 } };
          },
          pinRecoveryCheckpoint: async (sessionId, id, pinned) => ({ checkpointId: id, pinned }),
        };
        createRoot(document.getElementById('root')).render(
          <RecoveryHistoryModal sessionId="chat-1" projectName="demo" running={false} onClose={() => { window.closed = true; }} />);
    `, loader: 'jsx', resolveDir: process.cwd() },
      bundle: true, outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    // Rejections inside executeJavaScript are invisible to the outer catch
    // in this harness, so the evaluated script returns errors as values and
    // the assertion below fails loudly in main instead.
    const evalResult = await window.webContents.executeJavaScript(`(async () => {
      const flow = (async () => {
      try {
      const tick = () => new Promise(resolve => setTimeout(resolve, 60));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
      const openConfirm = async () => {
        button('Restore this checkpoint…').click();
        for (let i = 0; i < 40 && !document.querySelector('[role=alertdialog]'); i++) await tick();
        check(document.querySelector('[role=alertdialog]'), 'confirm dialog opened');
        for (let i = 0; i < 40 && ![...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm restore'); i++) await tick();
        check(button('Confirm restore'), 'confirm button settled (not stuck on Restoring…)');
      };
      const boxes = () => [...document.querySelectorAll('input[type="checkbox"]')];
      const forceBox = () => boxes().find((b) => (b.parentElement?.textContent ?? '').includes('Overwrite files changed'));
      const riskyBox = () => boxes().find((b) => (b.parentElement?.textContent ?? '').includes('I authorize exactly'));
      const setBox = async (box, value) => {
        check(box, 'checkbox present');
        if (box.checked !== value) { box.click(); await tick(); }
      };
      for (let i = 0; i < 80 && !text().includes('Workspace Recovery'); i++) await tick();
      for (let i = 0; i < 80 && !text().includes('a.txt'); i++) await tick();
      check(text().includes('1 empty'), 'history marks checkpoints containing empty files');
      check(text().includes('1 recorded file(s) is empty'), 'detail calls out empty recorded files');

      // 1. Safe preview: normal result, no authorization UI, options pass through.
      window.scenario = 'safe';
      button('Preview restore').click(); await tick(); await tick();
      check(text().includes('Preview: complete restore'), 'safe preview renders normally');
      check(!riskyBox(), 'no authorization checkbox for safe previews');
      await openConfirm(); await tick();
      check(document.querySelector('[role=alertdialog]'), 'confirm step still required');
      button('Confirm restore').click(); await tick(); await tick(); await tick();
      check(window.apiCalls.restore.length === 1, 'safe restore dispatched once');
      check(window.apiCalls.restore[0].allowRisky === false && window.apiCalls.restore[0].force === false, 'safe restore sends no authorization');
      check(text().includes('Restored 1 path') && text().includes('Undo point #11 (pinned against cleanup)'), 'success reports undo pin');

      // 2. Risky preview: paths, sizes, reason; confirm gated on the checkbox; force stays independent.
      window.scenario = 'risky';
      window.apiCalls.restore.length = 0;
      button('Preview restore').click(); await tick(); await tick();
      check(text().includes('Risky restore needs your confirmation'), 'risky panel shown');
      check(text().includes('a.txt (9 B now'), 'affected path with sizes shown');
      await openConfirm(); await tick();
      check(button('Confirm restore').disabled, 'confirm disabled without authorization');
      await setBox(riskyBox(), true);
      check(forceBox().checked === false, 'authorizing risk does not touch the overwrite checkbox');
      check(!button('Confirm restore').disabled, 'confirm enabled after authorization');
      button('Confirm restore').click(); await tick(); await tick(); await tick();
      check(window.apiCalls.restore.length === 1, 'risky restore dispatched once');
      check(window.apiCalls.restore[0].allowRisky === true && window.apiCalls.restore[0].force === false, 'risky authorization sent without forcing conflicts');
      check(text().includes('Restored 1 path'), 'authorized restore succeeds');

      // 3. Cancel: no dispatch.
      await openConfirm(); await tick();
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(); await tick();
      check(window.apiCalls.restore.length === 1, 'cancel dispatches nothing');

      // 4. Refused: explains, names the blocker, needs both boxes, changes nothing.
      window.scenario = 'refused';
      window.apiCalls.restore.length = 0;
      const previewsBefore = window.apiCalls.preview.length;
      await setBox(forceBox(), false);
      button('Preview restore').click(); await tick(); await tick();
      check(text().includes('Restore refused'), 'refusal explained');
      check(text().includes('No files were changed'), 'refusal states nothing changed');
      await openConfirm(); await tick();
      check(button('Confirm restore').disabled, 'refused confirm needs both boxes');
      await setBox(riskyBox(), true);
      check(button('Confirm restore').disabled, 'risky alone is not enough for refused');
      await setBox(forceBox(), true);
      for (let i = 0; i < 40 && window.apiCalls.preview.length < previewsBefore + 2; i++) await tick();
      check(text().includes('Restore refused'), 'preview refreshed for the new flags');
      await setBox(riskyBox(), true);
      await openConfirm(); await tick();
      check(!button('Confirm restore').disabled, 'both boxes unlock refused confirm');
      button('Confirm restore').click(); await tick(); await tick(); await tick();
      check(window.apiCalls.restore.length === 1, 'refused restore dispatched once authorized');
      check(window.apiCalls.restore[0].allowRisky === true && window.apiCalls.restore[0].force === true, 'both flags sent');
      const previewsAfter = window.apiCalls.preview.length;
      await setBox(forceBox(), false);
      for (let i = 0; i < 40 && window.apiCalls.preview.length < previewsAfter + 1; i++) await tick();

      // 5. Stale preview: verdict change between preview and confirm blocks the apply.
      window.scenario = 'stale-first';
      window.previewCalls = 0;
      window.apiCalls.restore.length = 0;
      button('Preview restore').click(); await tick(); await tick();
      check(text().includes('Preview: complete restore'), 'first preview is safe');
      await openConfirm(); await tick();
      button('Confirm restore').click(); await tick(); await tick(); await tick();
      check(window.apiCalls.restore.length === 0, 'stale verdict blocks the apply');
      check(text().includes('changed since this preview was taken'), 'staleness reported');
      check(text().includes('Risky restore needs your confirmation'), 'updated preview shown');

      // 6. Failure: actual error shown.
      window.scenario = 'failure';
      window.apiCalls.restore.length = 0;
      button('Preview restore').click(); await tick(); await tick();
      await openConfirm(); await tick();
      button('Confirm restore').click(); await tick(); await tick(); await tick();
      check(text().includes('Restore failed: disk vanished'), 'actual failure message shown');

      // 7. Repeated clicks: single dispatch.
      window.scenario = 'slow';
      window.apiCalls.restore.length = 0;
      button('Preview restore').click(); await tick(); await tick();
      await openConfirm(); await tick();
      const confirm = button('Confirm restore');
      confirm.click(); confirm.click();
      for (let i = 0; i < 40 && window.apiCalls.restore.length === 0; i++) await tick();
      await tick(); await tick();
      check(window.apiCalls.restore.length === 1, 'double click dispatches once');
        return { ok: true };
      } catch (error) { return { evalError: error?.message ?? String(error) }; }
      })();
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 60000));
      return Promise.race([flow, timeout]);
    })()`);
    if (evalResult?.evalError) throw new Error(`UI flow failed: ${evalResult.evalError}`);
    if (evalResult?.timedOut) throw new Error('UI flow timed out without completing');
    require('node:fs').writeSync(1, `SAFETY-EVAL-RESULT ${JSON.stringify(evalResult).slice(0, 200)}\n`);
    require('node:fs').writeSync(1, 'Recovery safety modal verdicts, authorization, refusal, staleness, failure, and click-guard passed.\n');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { require('node:fs').writeSync(2, `${error?.stack ?? error}\n`); app.exit(1); });

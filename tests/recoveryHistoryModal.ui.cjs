// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/recoveryHistoryModal.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'recovery-modal-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import RecoveryHistoryModal from './src/components/chat/RecoveryHistoryModal';
        window.restored = [];
        const detail = {
          id: 9, kind: 'op', tool: 'write_project_file', pinned: false, createdAt: '2026-10-14 06:00:00',
          originChat: 'abc12345', coverage: { complete: false, skipped: [{ path: 'big.bin', reason: 'too_large' }], excluded: [] },
          op: null, totalPaths: 2, truncated: false,
          paths: [
            { path: 'a.txt', recorded: 'file', current: 'file', status: 'modified',
              diff: { identical: false, truncated: false, hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, oldLines: ['old'], newLines: ['new'] }] } },
            { path: 'big.bin', recorded: 'uncaptured', current: 'file', status: 'unavailable', reason: 'too_large' },
          ],
        };
        window.api = {
          getRecoveryHistory: async () => ({ mine: [
            { id: 9, kind: 'op', tool: 'write_project_file', pinned: false, createdAt: '2026-10-14 06:00:00', originChat: 'abc12345', mine: true, coverageComplete: false, skipped: [{ path: 'big.bin', reason: 'too_large' }], excludedCount: 0, changedTotal: null, changedKinds: null },
            { id: 4, kind: 'shell', tool: 'execute_command', pinned: true, createdAt: '2026-10-14 05:00:00', originChat: 'abc12345', mine: true, coverageComplete: true, skipped: [], excludedCount: 0, changedTotal: 2, changedKinds: { modified: 1, created: 1, deleted: 0, renamed: 0, other: 0 } },
          ], other: [
            { id: 2, kind: 'op', tool: 'write_project_file', pinned: false, createdAt: '2026-10-14 04:00:00', originChat: 'def67890', mine: false, coverageComplete: true, skipped: [], excludedCount: 0, changedTotal: null, changedKinds: null },
          ] }),
          getRecoveryDetail: async (sessionId, id) => {
            if (id === 999) throw new Error('Unknown recovery checkpoint: 999.');
            return detail;
          },
          previewRecoveryRestore: async (sessionId, id, options) => ({
            complete: false, strategy: 'preview', dryRun: true, preRestoreCheckpointId: null,
            restored: [{ path: 'a.txt', action: 'restored' }],
            removed: [], skipped: [{ path: 'big.bin', reason: 'uncapturable' }], warnings: [],
          }),
          restoreRecoveryCheckpoint: async (sessionId, id) => {
            window.restored.push(id);
            return { complete: true, restored: [{ path: 'a.txt', action: 'restored' }], removed: [], skipped: [], warnings: [], preRestoreCheckpointId: 10, strategy: 'per-path' };
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
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      for (let i = 0; i < 80 && !text().includes('Workspace Recovery'); i++) await tick();
      check(document.querySelector('dialog').open, 'modal opens over content');
      for (let i = 0; i < 80 && !text().includes('This chat (2)'); i++) await tick();
      check(text().includes('Other chats in this workspace'), 'other-chat checkpoints separated, origin kept');
      for (let i = 0; i < 80 && !text().includes('a.txt'); i++) await tick();
      check(text().includes('Partial capture'), 'partial coverage called out, not complete');
      check(text().includes('unavailable (too_large)'), 'uncapturable path labeled with reason');
      const preview = [...document.querySelectorAll('button')].find(b => b.textContent === 'Preview restore');
      check(preview && !preview.disabled, 'preview available');
      preview.click(); await tick(); await tick();
      check(text().includes('Preview: partial restore'), 'preview shows partial, not complete');
      check(text().includes('big.bin (uncapturable)'), 'preview lists unrestorable paths');
      const restore = [...document.querySelectorAll('button')].find(b => b.textContent === 'Restore this checkpoint…');
      check(restore && !restore.disabled, 'restore offered for loadable checkpoint');
      restore.click(); await tick();
      check(document.querySelector('[role=alertdialog]'), 'explicit confirmation step required');
      const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Confirm restore');
      confirm.click(); await tick(); await tick();
      check((await (async () => window.restored)()).length === 1, 'restore dispatched once after confirm');
      check(text().includes('pre-restore point was saved first'), 'pre-restore preservation reported');
      check(!window.closed, 'closing state untouched by actions so far');
      const pin = [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Pin ('));
      check(pin, 'pin control present');
    })()`);
    console.log('Recovery modal history, detail, preview, confirm-restore, and pin controls passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

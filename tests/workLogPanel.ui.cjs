// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/workLogPanel.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
// Electron quits when the last window closes: without this, a failure thrown
// after window.destroy() in the finally below loses its rejection and the
// run exits 0 silently. Verified empirically; keeps failures loud.
app.on('window-all-closed', (event) => event.preventDefault());

async function renderCase(window, directory, name, briefs, usage) {
  await esbuild.build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ContextPanel from './src/components/ContextPanel';
      window.briefsFixture = ${briefs};
      window.usageFixture = ${usage};
      window.memoryPalace = {
        getBriefs: async () => window.briefsFixture,
        getContextUsage: async () => window.usageFixture,
        getCheckpoint: async () => ({ checkpoint: null }),
        getCheckpointHistory: async () => ({ checkpoints: [], limit: 10 }),
        getSessionSummary: async () => ({ text: null }),
        getArchivedMessages: async () => ({ messages: [], total: 0, offset: 0, limit: 20 }),
      };
      createRoot(document.getElementById('root')).render(
        <ContextPanel sessionId="chat-1" modelId="model" active={true} />);
    `, loader: 'jsx', resolveDir: process.cwd() },
    bundle: true, outfile: path.join(directory, `${name}.js`),
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  await fs.writeFile(path.join(directory, `${name}.html`), `<div id="root"></div><script src="${name}.js"></script>`);
  await window.loadFile(path.join(directory, `${name}.html`));
}

const FULL_BRIEFS = JSON.stringify({
  applicable: [
    {
      id: 195, kind: 'instruction', content_text: 'Make it dark.', message_id: 2695,
      supersedes_id: null, created_at: null, attachments: [],
      workLog: {
        turns: [
          {
            turnSeq: 1, partial: false, createdAt: '2026-10-16 10:00:00', briefId: 195,
            entries: [
              { kind: 'read', tool: 'read_project_file', status: 'complete', paths: ['index.css'], summary: 'read index.css (120 chars)', exitCode: null, hash: null, linesAdded: null, linesRemoved: null },
              { kind: 'edit', tool: 'str_replace_editor', status: 'complete', paths: ['ThemeProvider.jsx'], summary: 'edited ThemeProvider.jsx (+4/-2)', exitCode: null, hash: null, linesAdded: 4, linesRemoved: 2 },
            ],
            openIssues: [], resolvedIssues: [],
            omitted: { entries: 0, issues: 0 }, stalePaths: ['index.css'],
          },
          {
            turnSeq: 2, partial: false, createdAt: '2026-10-16 10:05:00', briefId: 195,
            entries: [
              { kind: 'check', tool: 'execute_command', status: 'error', paths: [], summary: 'tests failed: npm test (exit 1): boom', exitCode: 1, hash: null, linesAdded: null, linesRemoved: null },
            ],
            openIssues: [{ id: 'iss-1', kind: 'check-failure', sig: 'cmd:npm test', excerpt: 'tests failed (exit 1): boom', exitCode: 1 }],
            resolvedIssues: [{ id: 'iss-0', kind: 'edit-failure', sig: 'edit:old.txt', excerpt: 'fixed earlier', exitCode: null }],
            omitted: { entries: 0, issues: 0 }, stalePaths: [],
          },
          {
            turnSeq: 3, partial: true, createdAt: '2026-10-16 10:09:00', briefId: 195,
            entries: [
              { kind: 'edit', tool: 'apply_patch', status: 'unfinished', paths: ['ThemeProvider.jsx'], summary: 'started apply_patch on ThemeProvider.jsx — unfinished', exitCode: null, hash: null, linesAdded: null, linesRemoved: null },
            ],
            openIssues: [{ id: 'iss-1', kind: 'check-failure', sig: 'cmd:npm test', excerpt: 'tests failed (exit 1): boom', exitCode: 1 }],
            resolvedIssues: [],
            omitted: { entries: 2, issues: 0 }, stalePaths: [],
          },
        ],
        chips: { turns: 3, edited: ['ThemeProvider.jsx'], editedMore: 0, read: ['index.css'], readMore: 0, openIssues: 1 },
      },
    },
    {
      id: 196, kind: 'instruction', content_text: 'Make it white.',
      message_id: 2697, supersedes_id: null, created_at: null, attachments: [], workLog: null,
    },
  ],
  others: [],
  unassignedWorkLog: {
    turns: [
      {
        turnSeq: 1, partial: false, createdAt: '2026-10-16 09:00:00', briefId: null,
        entries: [
          { kind: 'read', tool: 'read_project_file', status: 'complete', paths: ['solo.txt'], summary: 'read solo.txt (5 chars)', exitCode: null, hash: null, linesAdded: null, linesRemoved: null },
        ],
        openIssues: [], resolvedIssues: [],
        omitted: { entries: 0, issues: 0 }, stalePaths: [],
      },
    ],
    chips: { turns: 1, edited: [], editedMore: 0, read: ['solo.txt'], readMore: 0, openIssues: 0 },
  },
});

const FULL_USAGE = JSON.stringify({
  totalTokens: 3248, workLogTokens: 312, messageCount: 12, hasSummary: false, telemetry: null,
});

const EMPTY_BRIEFS = JSON.stringify({ applicable: [], others: [] });
const EMPTY_USAGE = JSON.stringify({ totalTokens: 100, workLogTokens: 0, messageCount: 2, hasSummary: false, telemetry: null });

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'worklog-panel-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await renderCase(window, directory, 'full', FULL_BRIEFS, FULL_USAGE);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      for (let i = 0; i < 60 && !text().includes('Brief #195'); i++) await tick();
      check(text().includes('Make it dark.'), 'original brief content intact');
      // Work log collapsed by default: header visible, turns hidden.
      check(text().includes('Work log'), 'work log affordance present');
      check(text().includes('3 turns'), 'turn count shown');
      // textContent includes collapsed <details> content, so collapsed state
      // is asserted on the open property rather than text absence.
      const detailsOf = () => [...document.querySelectorAll('details')];
      check(detailsOf().length === 2, 'one collapsible per work-log section');
      check(detailsOf().every((el) => !el.open), 'turn groups collapsed by default');
      const summaries = () => [...document.querySelectorAll('summary')].filter(el => el.textContent.includes('Work log'));
      summaries()[0].click(); await tick(); await tick();
      check(detailsOf()[0].open, 'section expands on click');
      check(text().includes('edited: ThemeProvider.jsx'), 'edited chip shown');
      check(text().includes('read: index.css'), 'read chip shown');
      check(text().includes('1 open issue'), 'open-issue chip shown');
      check(text().includes('Turn 1'), 'turn groups render chronologically on expand');
      check(text().includes('Turn 3'), 'newest turn shown');
      check(text().includes('Partial'), 'partial badge shown');
      check(text().includes('Recorded'), 'recorded badge shown');
      check(text().includes('Resolved'), 'resolved issues presented');
      check(text().includes('Omitted for budget: 2 entries.'), 'omission accounting shown');
      check(text().includes('changed since recorded'), 'stale marker shown');
      summaries()[1].click(); await tick(); await tick();
      check(text().includes('Unassigned work'), 'unassigned section shown');
      check(text().includes('solo.txt'), 'unassigned turn content shown');
      check(text().includes('No work log recorded for this brief.'), 'empty brief states record-absence, not work-absence');
      check(text().includes('Work log (approx)'), 'token contribution row shown');
      check(text().includes('312 tokens'), 'approximate contribution amount shown');
    })()`);
    await renderCase(window, directory, 'empty', EMPTY_BRIEFS, EMPTY_USAGE);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      for (let i = 0; i < 60 && !text().includes('No task brief recorded'); i++) await tick();
      check(!text().includes('Work log'), 'no work-log UI without briefs or digests');
      check(!text().includes('Unassigned work'), 'no unassigned section when empty');
      check(!text().includes('Work log (approx)'), 'no token row without contribution');
    })()`);
    console.log('Work log panel chips, collapsed groups, turns, issues, omission, staleness, unassigned, and token row passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

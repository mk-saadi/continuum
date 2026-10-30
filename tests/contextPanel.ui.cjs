// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/contextPanel.ui.cjs
// Workspace Context panel: renders checkpoint/brief/summary/archived inspection
// states from stubbed memoryPalace APIs, with no chat-composer or casual UI.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const writeSync = require('node:fs').writeSync;
const path = require('node:path');
const mark = text => writeSync(2, `${text}\n`);
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'context-panel-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ContextPanel from './src/components/ContextPanel';
      const root = createRoot(document.getElementById('root'));
      window.renderPanel = (sessionId, active) => root.render(<ContextPanel sessionId={sessionId} active={active} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 80));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.getElementById('root').textContent;
      const failMode = { on: false };

      const checkpoint = {
        objective: 'Build the widget and keep it green.',
        outstandingRequirements: [
          { text: 'Build the widget.', briefId: 1, status: 'open' },
          { text: 'Second instruction.', briefId: 2, status: 'done' },
        ],
        decisions: [{ text: 'Use X.', rationale: 'Faster.', verified: false, sources: [] }],
        completedWork: [{ text: 'Edited src/foo.js.', sources: [{ messageId: 4, stepId: 'edit-1' }] }],
        inProgress: [{ text: 'Waiting on review.', status: 'unknown', stepRef: null }],
        filesChanged: [{ path: 'src/foo.js', nature: 'edited', verified: true, stepRef: { messageId: 4, stepId: 'edit-1' } }],
        commands: [{ command: 'npm test', exitCode: 0, verified: true, stepRef: { messageId: 5, stepId: 'cmd-1' } }],
        tests: [{ command: 'npm test', exitCode: 0, passed: 5, failed: 0, total: 5, parsedAs: 'regex', verified: true, stepRef: { messageId: 5, stepId: 'cmd-1' } }],
        blockers: ['Waiting on review.'],
        risks: [],
        unknowns: ['Unknown perf impact.'],
        nextActions: ['Ship it.'],
      };
      const record = (id, status, stale, reasons) => ({
        id, status, model_id: 'm', created_at: '2026-10-01 12:00:00', stale, staleReasons: reasons,
        checkpoint, summary: { id: 9, text: 'Old turns summarized.' }, archivedCount: 10,
        workingState: { content: '[WORKSPACE CHECKPOINT]\\n' + JSON.stringify({objective:'Exact persisted working state ' + id, research:[{text:'Saved finding'}]}),
          representation:'exact-persisted-continuation',consumedToolCount:3,durableEvidenceCount:5 },
      });
      const evidence = {
        '4:edit-1': { found: true, role: 'assistant', toolName: 'str_replace_editor', status: 'success', snippet: '{success:true}' },
        '5:cmd-1': { found: true, role: 'assistant', toolName: 'execute_command', status: 'success', snippet: '5 passed' },
        '6:ghost': { found: false },
      };
      const full = {
        checkpoint: { checkpoint: record(3, 'current', false, []), evidence },
        history: { checkpoints: [
          { ...record(3, 'current', false, []), evidence },
          { ...record(2, 'superseded', true, ['conversation summary changed']), evidence: { '6:ghost': { found: false } } },
        ], limit: 10 },
        briefs: { applicable: [
          { id: 1, kind: 'original', content_text: 'Build the widget.', message_id: 1, supersedes_id: null, created_at: '2026-10-01 11:00:00', applicable: true, attachments: [] },
          { id: 2, kind: 'instruction', content_text: 'Second instruction.', message_id: 6, supersedes_id: null, created_at: '2026-10-01 11:30:00', applicable: true, attachments: [{ file_name: 'notes.md', mime_type: 'text/markdown', size: 12, available: false }] },
        ], others: [
          { id: 3, kind: 'revision', content_text: 'Superseded draft.', message_id: null, supersedes_id: 1, created_at: '2026-10-01 11:15:00', applicable: false, attachments: [] },
        ] },
        summary: 'Old turns summarized.',
      };
      const archivedAll = Array.from({ length: 25 }, (_, i) => ({
        id: i + 1, role: i % 2 ? 'assistant' : 'user', content: 'archived body ' + (i + 1),
        created_at: '2026-10-01 10:00:00', archived: 1, is_summarized: 1, estimated_tokens: 4,
        attachments: [], executionSteps: i === 3 ? [{ id: 'edit-1', type: 'tool_call', toolName: 'str_replace_editor', status: 'complete', argsSummary: 'src/foo.js', error: null, result: '{success:true}', resultTruncated: false }] : [],
      }));
      window.memoryPalace = {
        getCheckpoint: async () => { if (failMode.on) throw new Error('db locked'); return full.checkpoint; },
        getCheckpointHistory: async () => { if (failMode.on) throw new Error('db locked'); return full.history; },
        getBriefs: async () => { if (failMode.on) throw new Error('db locked'); return full.briefs; },
        getSessionSummary: async () => { if (failMode.on) throw new Error('db locked'); return full.summary; },
        getArchivedMessages: async (sessionId, { limit, offset }) => {
          if (failMode.on) throw new Error('db locked');
          check(sessionId === 's', 'archived fetch scoped to the panel session');
          return { messages: archivedAll.slice(offset, offset + limit), total: archivedAll.length, limit, offset };
        },
        onCompressionComplete: (cb) => { window.__compressionCb = cb; return () => {}; },
      };

      // 1. Full render: every inspection area with live data.
      window.renderPanel('s', true);
      await wait(); await wait(); await wait();
      check(text().includes('Compression status'), 'status card renders');
      check(text().includes('Current checkpoint'), 'checkpoint card renders');
      check(text().includes('Checkpoint history'), 'history card renders');
      check(text().includes('Original task brief'), 'brief card renders');
      check(text().includes('Rolling summary'), 'summary card renders');
      check(text().includes('Archived messages'), 'archived card renders');
      check(text().includes('Checkpoint v3'), 'current version shown');
      check(text().includes('Exact persisted working state 3'), 'persisted working state shown without generation');
      check(text().includes('Raw working state'), 'raw saved representation available');
      window.dispatchEvent(new CustomEvent('continuum:inspect-checkpoint', {detail:{sessionId:'s',checkpointId:2}}));
      await wait(); await wait();
      check(text().includes('Exact persisted working state 2'), 'event focuses historical saved content');
      window.dispatchEvent(new CustomEvent('continuum:inspect-checkpoint', {detail:{sessionId:'s',checkpointId:3}}));
      await wait(); await wait();
      check(text().includes('Build the widget and keep it green.'), 'objective shown');
      check(text().includes('brief #1') && text().includes('brief #2'), 'requirement brief references shown');
      check(text().includes('Verified') && text().includes('Unverified'), 'evidence labels distinguish verified claims');
      check(text().includes('parsed output'), 'parsed test counts labeled, not presented as direct records');
      check(text().includes('Old turns summarized.'), 'summary text shown');
      check(text().includes('Generated historical summary'), 'summary labeled as generated');
      check(text().includes('Second instruction.'), 'verbatim brief text shown');
      check(text().includes('not applicable to this branch'), 'off-branch briefs labeled');
      check(text().includes('file unavailable'), 'missing attachment flagged');
      check(text().includes('1–20 of 25'), 'archived pager shows range');

      // 2. Evidence details and missing records.
      const details = [...document.querySelectorAll('details')];
      check(details.length > 0, 'evidence references expandable');
      check(text().includes('(record unavailable)') === false, 'no missing records on current version');
      const versionButtons = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('superseded'));
      check(versionButtons.length === 1, 'superseded version listed distinctly');
      versionButtons[0].click();
      await wait(); await wait();
      check(text().includes('Checkpoint v2'), 'selected historical version inspects');
      check(text().includes('Superseded versions describe past history'), 'superseded banner explains staleness');
      check(text().includes('conversation summary changed'), 'stale reason shown on historical version');

      // 3. Archived pager.
      const newer = [...document.querySelectorAll('button')].find(b => b.textContent === 'Newer');
      check(newer && !newer.disabled, 'newer page available');
      newer.click();
      await wait(); await wait();
      check(text().includes('21–25 of 25'), 'pager advances to the second page');
      check(text().includes('archived body 25'), 'second page shows later originals');

      // 4. Compression events: success status without token claims, then failure.
      window.__compressionCb({ sessionId: 'other', compressed: true, archivedCount: 3, checkpointId: 9 });
      await wait();
      check(!text().includes('checkpoint v9'), 'other-session events ignored');
      window.__compressionCb({ sessionId: 's', compressed: true, archivedCount: 7, checkpointId: 4 });
      await wait(); await wait();
      check(text().includes('Compressed 7 earlier messages into checkpoint v4.'), 'success status names the checkpoint');
      check(!/[0-9]+(?:[.,][0-9]+)?% (?:saved|less)/i.test(text().split('Archived messages')[0]), 'no fabricated token-savings claims in status');
      window.__compressionCb({ sessionId: 's', compressed: false, error: 'checkpoint backend offline', reason: 'checkpoint-generation-failed' });
      await wait(); await wait();
      check(text().includes('Last compression attempt failed: checkpoint backend offline.'), 'failure reason surfaced');
      check(text().includes('Saved history is unchanged.'), 'failure distinguishes transient attempt from persisted state');

      // C9 displays the exact saved Markdown. No generator/activation API exists
      // in this fixture; historical legacy versions remain independently viewable.
      const c9Record = { ...record(3, 'current', false, []), checkpoint: { ...checkpoint, summaryFormat: 'c9-markdown', evidence: [{messageId:4,stepId:'edit-1'}], sourceCoverage: [{digest:'technical-only-hash'}] },
        workingState: { format:'c9-markdown', content:'# Working Summary\\n\\n## Objective\\nExact C9 saved objective.\\n\\n## Progress\\n- Metadata preserved.\\n\\n## Next Steps\\n1. Verify DOM.', consumedToolCount:3, durableEvidenceCount:5 } };
      full.checkpoint.checkpoint = c9Record;
      full.history.checkpoints[0] = { ...c9Record, evidence };
      [...document.querySelectorAll('button')].filter(b => b.textContent === 'Refresh').at(-1).click();
      await wait(); await wait(); await wait();
      window.dispatchEvent(new CustomEvent('continuum:inspect-checkpoint', {detail:{sessionId:'s',checkpointId:3}}));
      await wait(); await wait();
      check(!![...document.querySelectorAll('h1')].find(h => h.textContent === 'Working Summary'), 'saved Markdown renders as headings');
      check(text().includes('Exact C9 saved objective.'), 'exact saved summary displayed');
      const technical = [...document.querySelectorAll('details')].filter(d => d.querySelector(':scope > summary')?.textContent === 'Technical details');
      check(technical.length > 0 && technical.every(d => !d.open), 'technical metadata hidden by default');
      const evidenceViews = [...document.querySelectorAll('details')].filter(d => d.querySelector(':scope > summary')?.textContent === 'Evidence');
      check(evidenceViews.length > 0 && evidenceViews.every(d => !d.open), 'evidence hidden by default');
      evidenceViews[0].open = true;
      check(evidenceViews[0].textContent.includes('str_replace_editor'), 'source evidence remains inspectable');
      window.dispatchEvent(new CustomEvent('continuum:inspect-checkpoint', {detail:{sessionId:'s',checkpointId:2}}));
      await wait(); await wait();
      check(text().includes('Legacy structured checkpoint'), 'legacy version labelled without rewriting');
      full.checkpoint.checkpoint = record(3, 'current', false, []);
      full.history.checkpoints[0] = { ...record(3, 'current', false, []), evidence };

      // 5. Error and empty states with retry.
      failMode.on = true;
      window.renderPanel('s', true);
      await wait(); await wait(); await wait();
      check(document.querySelector('[role=alert]'), 'fetch failures surface as alerts');
      check(text().includes('Retry') || text().includes('Refresh'), 'retry affordance present');
      failMode.on = false;
      [...document.querySelectorAll('button')].filter(b => b.textContent === 'Refresh').at(-1).click();
      await wait(); await wait(); await wait();
      check(text().includes('Checkpoint v3'), 'retry recovers the panel');
      window.memoryPalace.getCheckpoint = async () => ({ checkpoint: null });
      window.memoryPalace.getCheckpointHistory = async () => ({ checkpoints: [], limit: 10 });
      window.memoryPalace.getBriefs = async () => ({ applicable: [], others: [] });
      window.memoryPalace.getSessionSummary = async () => null;
      window.memoryPalace.getArchivedMessages = async () => ({ messages: [], total: 0, limit: 20, offset: 0 });
      window.renderPanel('s', true);
      await wait(); await wait(); await wait();
      [...document.querySelectorAll('button')].filter(b => b.textContent === 'Refresh').at(-1).click();
      await wait(); await wait(); await wait();
      check(text().includes('No checkpoint yet'), 'empty checkpoint state');
      check(text().includes('No task brief recorded'), 'empty brief state');
      check(text().includes('No rolling summary yet'), 'empty summary state');
      check(text().includes('No archived messages on this branch'), 'empty archived state');
      return true;
    })()`);
    assert.equal(result, true);
    mark('Workspace Context panel: full render, evidence, history selection, pager, events, errors, and empty states passed.');
  } catch (error) {
    mark(`Workspace Context panel UI test failed: ${error && error.stack ? error.stack : error}`);
    await fs.rm(directory, { recursive: true, force: true });
    app.exit(1);
    return;
  }
  window.destroy();
  await fs.rm(directory, { recursive: true, force: true });
  app.exit(0);
}).catch(error => { mark(`Workspace Context panel UI test failed: ${error && error.stack ? error.stack : error}`); app.exit(1); });

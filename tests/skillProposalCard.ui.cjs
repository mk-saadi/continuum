// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/skillProposalCard.ui.cjs
// B1: SkillProposalCard must receive a real proposal object on every path that
// renders it (live step-update, completion, history load, abort) and register
// exactly { name, description, instructions, projectId } — even past 10,000 chars.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const writeSync = require('node:fs').writeSync;
const path = require('node:path');
// The repo's UI tests note that app.exit can swallow console output, so the
// result is written synchronously to stderr.
const mark = text => writeSync(2, `${text}\n`);
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'skill-proposal-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatMessage from './src/components/ChatMessage';
      import { compactMessageForDisplay, compactStepsForDisplay } from './src/lib/toolDisplay.mjs';
      const root = createRoot(document.getElementById('root'));
      window.__saved = [];
      window.api = { saveSkill: payload => { window.__saved.push(payload); return Promise.resolve({ id: 'saved' }); } };
      window.compactSteps = steps => compactStepsForDisplay(steps);
      window.compactMessage = message => compactMessageForDisplay(message);
      window.renderMessage = message => root.render(<ChatMessage message={message} projectId={7} />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 80));
      // The card persists its decision per step id in localStorage; clear it so
      // a previous run of this test cannot hide the Register button.
      localStorage.clear();
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const clickRegister = async (card, label) => {
        const button = card.querySelector('button.project-button.primary');
        if (!button) throw new Error('register button missing: ' + label);
        button.click();
        await wait(); await wait();
      };
      const bigInstructions = '# Big skill\\n\\n' + 'Repeatable step with details.\\n'.repeat(800);
      const proposal = { name: 'large-skill', description: 'Keeps a long workflow', instructions: bigInstructions };
      check(JSON.stringify(proposal).length > 10000, 'fixture exceeds the 10,000-char display cap');
      const step = (id, args, status) => ({ id, type: 'tool_call', toolName: 'propose_skill', serverName: 'native', status, args });
      const finalize = steps => window.compactSteps(steps.map(s => s.type === 'tool_call' && ['pending', 'running'].includes(s.status)
        ? { ...s, status: 'error', error: 'Tool execution cancelled.' } : s));

      // 1. Normal proposal after normal completion (message state as stored by
      //    ChatInterface after finishMessage, i.e. compactMessageForDisplay).
      window.renderMessage(window.compactMessage({ id: 'm1', role: 'assistant', content: '',
        executionSteps: [step('skill-small', { name: 'small-skill', description: 'Short one', instructions: 'Do the thing.' }, 'complete')] }));
      await wait();
      let card = document.querySelector('[aria-label="Skill proposal"]');
      check(card, 'normal proposal renders a card');
      check(card.textContent.includes('small-skill'), 'normal proposal shows its name');
      await clickRegister(card, 'normal proposal');
      check(window.__saved.length === 1, 'normal proposal registers');
      check(JSON.stringify(window.__saved[0]) === JSON.stringify({ name: 'small-skill', description: 'Short one', instructions: 'Do the thing.', projectId: 7 }),
        'normal payload is exactly name, description, instructions, projectId: ' + JSON.stringify(Object.keys(window.__saved[0])));

      // 2. Proposal with >10,000 characters of instructions survives display
      //    compaction (used after completion and on history load) and registers
      //    every character.
      const largeStep = step('skill-large', proposal, 'complete');
      const compacted = window.compactSteps([largeStep])[0];
      check(typeof compacted.args === 'object' && compacted.args !== null, 'compaction keeps structured args');
      check(compacted.args.instructions === bigInstructions, 'compaction keeps the full instructions');
      window.renderMessage(window.compactMessage({ id: 'm2', role: 'assistant', content: '', executionSteps: [largeStep] }));
      await wait();
      card = document.querySelector('[aria-label="Skill proposal"]');
      check(card && card.textContent.includes('large-skill'), 'large proposal renders a card with its name');
      await clickRegister(card, 'large proposal after compaction');
      check(window.__saved.length === 2, 'large proposal registers');
      const payload = window.__saved[1];
      check(JSON.stringify(Object.keys(payload)) === JSON.stringify(['name', 'description', 'instructions', 'projectId']),
        'large payload keys are exact: ' + JSON.stringify(Object.keys(payload)));
      check(payload.instructions === bigInstructions, 'large payload carries every instruction character');
      check(payload.projectId === 7, 'large payload carries the project id');

      // 3. Live step-update snapshot: the card receives the real proposal object
      //    while the tool is still running, but registration waits for completion.
      window.renderMessage({ id: 'm3', role: 'assistant', content: '', executionSteps: window.compactSteps([step('skill-live', proposal, 'running')]) });
      await wait();
      card = document.querySelector('[aria-label="Skill proposal"]');
      check(card && card.textContent.includes('large-skill'), 'live snapshot still shows the proposal');
      check(card.querySelector('button.project-button.primary').disabled, 'live registration waits for completion');

      // 4. Abort/interruption: the proposal completed before the stop is still
      //    registrable, with the full payload.
      window.renderMessage({ id: 'm4', role: 'assistant', content: '', executionSteps: finalize([step('skill-abort-done', proposal, 'complete')]) });
      await wait();
      card = document.querySelector('[aria-label="Skill proposal"]');
      check(card, 'completed proposal survives an interrupted turn');
      await clickRegister(card, 'completed proposal in interrupted turn');
      check(window.__saved.length === 3, 'interrupted turn still registers');
      check(window.__saved[2].instructions === bigInstructions, 'interrupted registration carries the full instructions');

      // 5. Abort while the proposal was still running: falls back to the tool
      //    block instead of crashing on a corrupted payload.
      window.renderMessage({ id: 'm5', role: 'assistant', content: '', executionSteps: finalize([step('skill-abort-live', proposal, 'running')]) });
      await wait();
      check(document.querySelector('[aria-label="Tool executions"]'), 'interrupted live proposal falls back to the tool block');
      check(!document.querySelector('[aria-label="Skill proposal"]'), 'no register control before the tool finished');
    })()`);
    mark('Skill proposal card: normal, >10k instructions, live, completion, and abort paths passed.');
  } catch (error) {
    mark(`Skill proposal card UI test failed: ${error && error.stack ? error.stack : error}`);
    // Do not destroy the window first: closing the last window triggers
    // Electron's default quit with code 0, which races (and here beat)
    // the app.exit(1) below, so failures reported exit code 0.
    await fs.rm(directory, { recursive: true, force: true });
    app.exit(1);
    return;
  }
  window.destroy();
  await fs.rm(directory, { recursive: true, force: true });
  app.exit(0);
}).catch(error => { mark(`Skill proposal card UI test failed: ${error && error.stack ? error.stack : error}`); app.exit(1); });

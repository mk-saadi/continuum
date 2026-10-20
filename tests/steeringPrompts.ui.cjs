// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/steeringPrompts.ui.cjs
//
// Deterministic renderer check for the completed-reply footer. It renders the
// shared component directly; the run/reply association is covered by the IPC
// and display-helper tests.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'steering-prompts-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({
      stdin: {
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import AdditionalPrompts from './src/components/AdditionalPrompts.jsx';
          window.interactionsFixture = [
            {
              key: 'question:q1',
              kind: 'question',
              status: 'answered',
              question: 'Which toast library should we use?',
              answer: 'react-toastify',
              label: 'Question answered · react-toastify',
            },
            {
              key: 'skill:s1',
              kind: 'skill',
              status: 'approved',
              name: 'render-generated-media-as-png',
              description: 'Store generated media beside the chat.',
              label: 'Skill registration approved · render-generated-media-as-png',
            },
            {
              key: 'question:q2',
              kind: 'question',
              status: 'cancelled',
              question: 'Continue with the migration?',
              answer: '',
              label: 'Question cancelled',
            },
          ];
          function Fixture() {
            const [prompts, setPrompts] = useState([
              { id: 'a', content: 'Focus on the failing tests first.' },
              { id: 'b', content: 'Then\\nsummarize the change.' },
            ]);
            const [items, setItems] = useState(window.interactionsFixture);
            window.setPrompts = setPrompts;
            window.setInteractions = setItems;
            return <AdditionalPrompts prompts={prompts} interactions={items} />;
          }
          createRoot(document.getElementById('root')).render(<Fixture />);
        `,
        loader: 'jsx',
        resolveDir: process.cwd(),
      },
      bundle: true,
      outfile: path.join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    const outcome = await window.webContents.executeJavaScript(`(async () => {
      try {
        const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        for (let i = 0; i < 50 && !document.querySelector('[aria-label="Additional prompts"]'); i++) await wait();
        const section = document.querySelector('[aria-label="Additional prompts"]');
        check(section, 'Completed replies show an additional-prompts footer');
        check(section.textContent.includes('Additional prompts'), 'The footer has a clear heading');
        check(section.textContent.includes('These steering instructions were sent while this task was running.'), 'The footer explains what the prompts are');
        const rows = [...section.querySelectorAll('ol > li')].map(row => row.textContent);
        check(rows.length === 2, 'Every delivered instruction is listed');
        check(rows[0] === 'Focus on the failing tests first.', 'Instruction text is preserved');
        check(rows[1] === 'Then\\nsummarize the change.', 'Multi-line instructions keep their line break');

        const outcomes = [...section.querySelectorAll('[aria-label="Turn outcomes"] > li')].map(row => row.textContent);
        check(outcomes.length === 3, 'Answered questions and skill decisions are listed too');
        check(
          outcomes[0].includes('Question asked · Which toast library should we use?') &&
          outcomes[0].includes('Answered: react-toastify'),
          'The question asked and the answer are shown',
        );
        check(
          outcomes[1].includes('Skill registration approved · render-generated-media-as-png') &&
          outcomes[1].includes('Store generated media beside the chat.'),
          'The skill registry text is shown',
        );
        check(outcomes[2].includes('Question cancelled · Continue with the migration?'), 'Cancelled questions are shown honestly');

        window.setPrompts([]);
        window.setInteractions([]);
        await wait();
        check(!document.querySelector('[aria-label="Additional prompts"]'), 'Replies without steering or interactions render no footer');

        window.setInteractions([window.interactionsFixture[0]]);
        await wait();
        const onlyInteraction = document.querySelector('[aria-label="Additional prompts"]');
        check(onlyInteraction, 'An answered question alone still shows the footer');
        check(onlyInteraction.textContent.includes('These were recorded while this task was running.'), 'The footer explains interactions when there are no steering instructions');
        check(!onlyInteraction.querySelector('ol'), 'No empty instruction list is rendered');
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error && error.message ? error.message : String(error) };
      }
    })()`);
    if (!outcome?.ok) throw new Error(outcome?.message || 'The additional-prompts UI check failed.');
    console.log('Completed-reply steering footer UI passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/workspacePlan.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', (event) => event.preventDefault());

async function renderCase(window, directory, name, contents) {
  await esbuild.build({
    stdin: { contents, loader: 'jsx', resolveDir: process.cwd() },
    bundle: true,
    outfile: path.join(directory, `${name}.js`),
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  await fs.writeFile(
    path.join(directory, `${name}.html`),
    `<div id="root"></div><script src="${name}.js"></script>`,
  );
  await window.loadFile(path.join(directory, `${name}.html`));
}

const TAB_PLAN = {
  objective: 'Ship feature A',
  revision: 4,
  steps: [
    { id: 11, position: 1, description: 'Inspect repository', status: 'completed', note: '' },
    { id: 12, position: 2, description: 'Implement parser', status: 'in_progress', note: '' },
    { id: 13, position: 3, description: 'Deploy to staging', status: 'blocked', note: 'Waiting for credentials' },
    { id: 14, position: 4, description: 'Write docs', status: 'pending', note: '' },
  ],
};
const OTHER_PLAN = {
  objective: 'Tab B task',
  revision: 2,
  steps: [
    { id: 21, position: 1, description: 'B step one', status: 'completed', note: '' },
    { id: 22, position: 2, description: 'B step two', status: 'completed', note: '' },
  ],
};
const UPDATED_PLAN = {
  objective: 'Ship feature A',
  revision: 5,
  steps: [
    { id: 11, position: 1, description: 'Inspect repository', status: 'completed', note: '' },
    { id: 12, position: 2, description: 'Implement parser', status: 'completed', note: '' },
    { id: 13, position: 3, description: 'Deploy to staging', status: 'in_progress', note: 'Credentials arrived' },
    { id: 14, position: 4, description: 'Write docs', status: 'pending', note: '' },
    { id: 15, position: 5, description: 'Polish release notes', status: 'pending', note: '' },
  ],
};

const TABS_SOURCE = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import WorkspacePlanCard from './src/components/chat/WorkspacePlanCard';
  window.__plans = { a: ${JSON.stringify(TAB_PLAN)}, b: ${JSON.stringify(OTHER_PLAN)} };
  window.__planListeners = [];
  window.__renderCounts = { a: 0, b: 0 };
  window.memoryPalace = {
    getPlan: async (sessionId) => window.__plans[sessionId] ?? null,
    onPlanUpdated: (callback) => {
      window.__planListeners.push(callback);
      return () => { window.__planListeners = window.__planListeners.filter(item => item !== callback); };
    },
  };
  window.__emitPlan = (payload) => window.__planListeners.forEach((callback) => callback(payload));
  createRoot(document.getElementById('root')).render(
    <>
      <React.Profiler id="a" onRender={() => { window.__renderCounts.a += 1; }}>
        <WorkspacePlanCard sessionId="a" />
      </React.Profiler>
      <React.Profiler id="b" onRender={() => { window.__renderCounts.b += 1; }}>
        <WorkspacePlanCard sessionId="b" />
      </React.Profiler>
    </>
  );
`;

const STATES_SOURCE = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import WorkspacePlanCard from './src/components/chat/WorkspacePlanCard';
  window.__plans = {
    'chat-1': ${JSON.stringify(TAB_PLAN)},
    empty: null,
    done: {
      objective: 'Finished task',
      revision: 9,
      steps: [
        { id: 31, position: 1, description: 'Do the work', status: 'completed', note: '' },
        { id: 32, position: 2, description: 'Verify the work', status: 'completed', note: '' },
      ],
    },
  };
  window.__failOnce = true;
  window.memoryPalace = {
    getPlan: (sessionId) => new Promise((resolve, reject) => {
      setTimeout(() => {
        if (sessionId === 'chat-1' && window.__failOnce) {
          window.__failOnce = false;
          reject(new Error('backend unavailable'));
          return;
        }
        resolve(window.__plans[sessionId] ?? null);
      }, 10);
    }),
    onPlanUpdated: () => () => {},
  };
  function Harness() {
    const [sessionId, setSessionId] = useState('chat-1');
    window.__switchTo = setSessionId;
    return <WorkspacePlanCard sessionId={sessionId} />;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

const SWITCH_SOURCE = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import WorkspacePlanCard from './src/components/chat/WorkspacePlanCard';
  window.__plans = {
    old: { objective: 'Old task', revision: 1, steps: [{ id: 41, position: 1, description: 'Old step', status: 'pending', note: '' }] },
    new: { objective: 'New task', revision: 1, steps: [{ id: 51, position: 1, description: 'New step', status: 'in_progress', note: '' }] },
  };
  window.memoryPalace = {
    getPlan: (sessionId) => new Promise((resolve) => {
      setTimeout(() => resolve(window.__plans[sessionId] ?? null), sessionId === 'old' ? 350 : 0);
    }),
    onPlanUpdated: () => () => {},
  };
  function Harness() {
    const [sessionId, setSessionId] = useState('old');
    window.__switchTo = setSessionId;
    return <WorkspacePlanCard sessionId={sessionId} />;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'workspace-plan-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await renderCase(window, directory, 'tabs', TABS_SOURCE);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      const card = (id) => document.querySelector('[data-plan-session="' + id + '"]');
      for (let i = 0; i < 80 && !text().includes('Ship feature A'); i++) await tick();
      check(card('a') && card('b'), 'both tab cards mounted');
      check(!card('a').textContent.includes('Tab B task'), 'tab A does not show tab B plan');
      check(!card('b').textContent.includes('Ship feature A'), 'tab B does not show tab A plan');
      check(card('a').textContent.includes('1 of 4 complete'), 'progress summary shown');
      check(card('a').textContent.includes('1 in progress'), 'in-progress count shown');
      check(card('a').textContent.includes('1 blocked'), 'blocked count shown');
      check(card('a').textContent.includes('Waiting for credentials'), 'blocker explanation shown');
      check(card('a').querySelector('[data-step-status="blocked"]'), 'blocked step rendered');
      check(card('a').querySelector('[data-step-id="12"]').getAttribute('aria-current') === 'step', 'in-progress step marked current');
      const progress = card('a').querySelector('[role="progressbar"]');
      check(progress.getAttribute('aria-valuenow') === '1', 'progress value tracks completed steps');
      check(progress.getAttribute('aria-valuemax') === '4', 'progress maximum tracks total steps');
      check(card('b').textContent.includes('All steps completed.'), 'completed tab shows completion state');
      check(card('b').textContent.includes('2 of 2 complete'), 'completed tab progress shown');

      const beforeA = window.__renderCounts.a;
      const beforeB = window.__renderCounts.b;
      window.__plans.a = ${JSON.stringify(UPDATED_PLAN)};
      window.__emitPlan({ sessionId: 'a', plan: window.__plans.a });
      await tick(80);
      check(card('a').textContent.includes('Credentials arrived'), 'live update applied to the matching tab');
      check(card('a').textContent.includes('2 of 5 complete'), 'live update progress applied');
      check(card('a').textContent.includes('Polish release notes'), 'added step rendered');
      check(card('a').textContent.includes('Rev 5'), 'revision badge updated');
      check(window.__renderCounts.a > beforeA, 'matching tab re-rendered');
      check(window.__renderCounts.b === beforeB, 'unrelated tab did not re-render');
      check(!card('b').textContent.includes('Credentials arrived'), 'unrelated tab content unchanged');

      const afterA = window.__renderCounts.a;
      const afterB = window.__renderCounts.b;
      window.__emitPlan({ sessionId: 'missing', plan: ${JSON.stringify(TAB_PLAN)} });
      await tick(80);
      check(window.__renderCounts.a === afterA && window.__renderCounts.b === afterB, 'unknown-session event renders nothing');
    })()`);

    await renderCase(window, directory, 'states', STATES_SOURCE);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      const waitFor = async (needle) => { for (let i = 0; i < 100 && !text().includes(needle); i++) await tick(); };
      await waitFor('Could not load the plan');
      check(text().includes('backend unavailable'), 'error cause shown');
      const retry = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry');
      check(retry, 'retry affordance shown');
      retry.click();
      await waitFor('Ship feature A');
      check(text().includes('In progress'), 'plan rendered after successful retry');
      check(!text().includes('Could not load the plan'), 'error cleared after retry');

      window.__switchTo('empty');
      await waitFor('No plan yet');
      check(!text().includes('Ship feature A'), 'previous plan cleared on session switch');
      check(text().includes('stays available across turns'), 'empty state explains durability');

      window.__switchTo('done');
      await waitFor('Finished task');
      check(text().includes('All steps completed.'), 'completed state shown');
      check(text().includes('2 of 2 complete'), 'completed progress shown');
      const doneProgress = document.querySelector('[role="progressbar"]');
      check(doneProgress.getAttribute('aria-valuenow') === '2', 'completed progress value');
    })()`);

    await renderCase(window, directory, 'switch', SWITCH_SOURCE);
    await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const text = () => document.body.textContent;
      check(text().includes('Loading plan…'), 'loading state shown before the read resolves');
      await tick(20);
      window.__switchTo('new');
      for (let i = 0; i < 40 && !text().includes('New task'); i++) await tick();
      check(text().includes('New task'), 'new session plan shown after switch');
      await tick(450);
      check(!text().includes('Old task'), 'stale response for the previous session is ignored');
      check(text().includes('New task'), 'new session plan remains after the stale response arrives');
      check(!text().includes('Loading plan…'), 'loading cleared');
    })()`);

    console.log('Workspace plan UI: statuses, blocker notes, live updates, tab isolation, loading/error/retry/empty/completed, stale switch guard passed.');
  } finally {
    window.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });

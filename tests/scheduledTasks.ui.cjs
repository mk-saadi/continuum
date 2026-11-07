// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/scheduledTasks.ui.cjs
//
// Focused UI acceptance for the dedicated Tasks page and its sidebar entry.
// The backend is mocked at the preload boundary (window.api.scheduledTasks) so
// the test proves the page renders persisted records, sends the documented
// payloads and reacts to the real event envelope.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
// The fixture window is destroyed in the finally block; without this handler
// Electron would quit before the failure reason is printed.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
	const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'tasks-ui-'));
	const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true } });
	try {
		await esbuild.build({
			stdin: {
				contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import TasksView from './src/components/scheduled-tasks/TasksView.jsx';
          import Sidebar from './src/components/Sidebar.jsx';

          const START = Date.UTC(2026, 0, 1, 9);
          const NEXT = Date.UTC(2026, 0, 11, 9);
          const baseTask = (id, name, extra) => ({
            id, name, prompt: name + ' instructions for the assistant.', projectId: null,
            schedule: { type: 'daily', atTime: '09:00', startAt: START }, timezone: 'UTC',
            model: { kind: 'local', modelPath: '/models/alpha.gguf' }, fallback: [],
            missedPolicy: { policy: 'grace', graceHours: 24, maxOverdueDays: 7 },
            permissionMode: 'read_only', budget: null, enabled: true, nextRunAt: NEXT,
            lastRunAt: null, lastStatus: null, createdAt: START, updatedAt: START, ...extra,
          });
          let tasks = [
            baseTask('a', 'Alpha'),
            baseTask('b', 'Beta', { lastStatus: 'failed' }),
            baseTask('c', 'Gamma', { enabled: false }),
          ];
          let runs = [
            { id: 'r1', taskId: 'a', sessionId: 'scheduled-r1', status: 'completed', trigger: 'schedule', scheduledFor: NEXT - 86400000, startedAt: NEXT - 86400000, finishedAt: NEXT - 86400000 + 41000, model: { kind: 'local', modelPath: '/models/alpha.gguf' }, fallbackUsed: false, failureReason: null },
            { id: 'r4', taskId: 'a', status: 'blocked', trigger: 'schedule', scheduledFor: NEXT - 172800000, startedAt: NEXT - 172800000, finishedAt: NEXT - 172800000 + 2000, model: null, fallbackUsed: false, failureReason: 'approval_required: Tool approval required for write_file.' },
            { id: 'r2', taskId: 'b', status: 'failed', trigger: 'schedule', scheduledFor: NEXT - 86400000, startedAt: NEXT - 86400000, finishedAt: NEXT - 86400000 + 9000, model: null, fallbackUsed: false, failureReason: 'The model exploded.' },
            { id: 'r3', taskId: 'c', status: 'skipped', trigger: 'schedule', scheduledFor: NEXT - 86400000, startedAt: null, finishedAt: null, model: null, fallbackUsed: false, failureReason: 'The model does not fit in available GPU memory.' },
          ];
          const calls = { list: 0, history: [], create: [], update: [], pause: [], resume: [], remove: [], runNow: [], cancel: [] };
          const listeners = new Set();
          const subscriptions = { added: 0, removed: 0 };
          const clone = value => JSON.parse(JSON.stringify(value));
          const emit = event => { for (const listener of [...listeners]) listener(clone(event)); };
          const byId = id => tasks.find(task => task.id === id);

          window.calls = calls;
          window.subscriptions = subscriptions;
          window.failList = false;
          window.setTasks = next => { tasks = next; };
          window.pushEvent = emit;

          window.api = { scheduledTasks: {
            list: async () => { calls.list++; if (window.failList) throw new Error('Backend unavailable'); return clone(tasks); },
            history: async (options = {}) => {
              calls.history.push({ ...options });
              const rows = options.taskId ? runs.filter(run => run.taskId === options.taskId) : runs;
              const offset = options.offset || 0;
              const limit = options.limit || 25;
              return { runs: clone(rows.slice(offset, offset + limit)), total: rows.length, limit, offset };
            },
            create: async payload => {
              calls.create.push(clone(payload));
              const task = { ...clone(payload), id: 'new-task', createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: NEXT, lastStatus: null };
              tasks.push(task); emit({ type: 'task-created', task }); return clone(task);
            },
            update: async (id, patch) => {
              calls.update.push({ id, patch: clone(patch) });
              Object.assign(byId(id), clone(patch)); const task = clone(byId(id));
              emit({ type: 'task-updated', task }); return task;
            },
            pause: async id => { calls.pause.push(id); byId(id).enabled = false; emit({ type: 'task-updated', task: clone(byId(id)) }); return clone(byId(id)); },
            resume: async id => { calls.resume.push(id); byId(id).enabled = true; emit({ type: 'task-updated', task: clone(byId(id)) }); return clone(byId(id)); },
            remove: async id => id,
            delete: async id => {
              calls.remove.push(id);
              const index = tasks.findIndex(task => task.id === id);
              if (index >= 0) tasks.splice(index, 1);
              emit({ type: 'task-deleted', taskId: id }); return { deleted: true, id };
            },
            runNow: async id => {
              calls.runNow.push(id);
              const run = { id: 'run-now-' + id, taskId: id, status: 'queued', trigger: 'manual', scheduledFor: Date.now(), startedAt: null, finishedAt: null, model: null, fallbackUsed: false, failureReason: null };
              runs = [run, ...runs]; emit({ type: 'run-created', run }); return clone(run);
            },
            cancel: async options => {
              calls.cancel.push(options.runId);
              const run = runs.find(item => item.id === options.runId);
              if (run) { run.status = 'cancelled'; run.failureReason = 'user-cancelled'; emit({ type: 'run-updated', run: clone(run) }); }
              return run ? clone(run) : null;
            },
            onEvent: listener => {
              listeners.add(listener); subscriptions.added++;
              return () => { listeners.delete(listener); subscriptions.removed++; };
            },
          } };

          function Navigation() {
            const [view, setView] = useState('chat');
            window.currentView = () => view;
            return <Sidebar
              projects={[{ id: 'p1', name: 'Proj' }]}
              view={view}
              groups={[]}
              activeId={null}
              onLoad={() => {}}
              onNew={() => setView('chat')}
              onAction={async () => {}}
              onChat={() => setView('chat')}
              onProjects={() => setView('projects')}
              onProject={() => {}}
              onCreateProject={() => {}}
              onTasks={() => setView('tasks')}
              tasksActive={view === 'tasks'}
            />;
          }

          function Harness() {
            const [mounted, setMounted] = useState(true);
            window.setMounted = setMounted;
            return <>
              <div style={{ display: 'flex', height: '100%' }}>
                <Navigation />
                <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>{mounted && <TasksView
                  models={[{ id: '/models/alpha.gguf', name: 'Local/alpha.gguf' }, { id: 'cloud:openai:gpt-4o-mini', name: 'OpenAI / gpt-4o-mini' }]}
                  projects={[{ id: 'p1', name: 'Proj' }]}
                  onOpenRun={id => { window.openedRun = id; }}
                />}</div>
              </div>
            </>;
          }
          createRoot(document.getElementById('root')).render(<Harness />);
        `,
				loader: 'jsx',
				resolveDir: process.cwd(),
			},
			bundle: true,
			outfile: path.join(directory, 'fixture.js'),
			loader: { '.css': 'css' },
			define: { 'process.env.NODE_ENV': '"test"' },
		});
		// The fixture owns the theme variables it asserts on, mirroring the values
		// index.css sets for the light and dark themes.
		await fs.writeFile(
			path.join(directory, 'index.html'),
			`<html data-theme="dark" data-appearance="aero"><head>
        <link rel="stylesheet" href="fixture.css">
        <style>
          :root { --surface:#1b1d22; --surface-raised:#23262c; --surface-hover:#2a2e36; --bg-secondary:#15171b;
            --text-primary:#f2f3f5; --text-secondary:#c8ccd3; --text-muted:#9aa1ac; --border:#343842;
            --accent:#5aa9ff; --accent-hover:#78b8ff; --on-accent:#04101f; --input:#14161a;
            --active-chat:#26303c; --error:#ff6b6b; --warning:#e0a64a; --success:#5cc98a;
            --window-shadow:rgba(0,0,0,.45); --aero-line:rgba(255,255,255,.16); --aero-line-bottom:rgba(0,0,0,.35); }
          html, body, #root { height: 100%; margin: 0; }
          body { background: var(--bg-secondary); color: var(--text-primary); font-family: system-ui, sans-serif; }
        </style>
      </head><body><div id="root"></div><script src="fixture.js"></script></body></html>`,
		);
		await window.loadFile(path.join(directory, 'index.html'));
		const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const text = () => document.body.textContent;
      const buttons = () => [...document.querySelectorAll('button')];
      const button = (label, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === label);
      const ariaButton = label => document.querySelector('button[aria-label="' + label + '"]');
      const field = label => {
        const target = [...document.querySelectorAll('label')].find(node => node.textContent.trim().replace(/\\*$/, '') === label);
        return target ? document.getElementById(target.htmlFor) : null;
      };
      const setValue = (element, value) => {
        const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const selectValue = value => {
        const select = [...document.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === value));
        check(!!select, 'select for ' + value);
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const rowOf = name => [...document.querySelectorAll('.tasks-list-table tbody tr')].find(row => row.textContent.includes(name));
      const dialog = () => document.querySelector('dialog[open]');

      // ---- Navigation -----------------------------------------------------
      for (let i = 0; i < 60 && !rowOf('Alpha'); i++) await wait();
      const tasksNav = [...document.querySelectorAll('aside nav button')].find(b => b.textContent.trim() === 'Tasks');
      check(!!tasksNav, 'sidebar exposes a Tasks entry');
      const newChat = button('✦ New chat');
      check(!!newChat, 'chat home entry present');
      check(newChat.compareDocumentPosition(tasksNav) & Node.DOCUMENT_POSITION_FOLLOWING, 'Tasks sits after the chat home entry');
      check(text().includes('Projects (1)'), 'projects section still present');
      tasksNav.click(); await wait();
      check(window.currentView() === 'tasks', 'Tasks opens the page');
      check(tasksNav.getAttribute('aria-current') === 'page', 'Tasks entry marks the page');

      // ---- List, overview and states --------------------------------------
      check(!!rowOf('Alpha') && !!rowOf('Beta') && !!rowOf('Gamma'), 'all persisted tasks listed');
      const alphaRow = rowOf('Alpha');
      check(alphaRow.textContent.includes('Daily 09:00'), 'recurrence shown');
      check(alphaRow.textContent.includes('Local/alpha.gguf'), 'selected model shown');
      check(alphaRow.textContent.includes('Scheduled'), 'scheduled status shown');
      check(alphaRow.textContent.includes('Completed'), 'last result shown');
      check(rowOf('Beta').textContent.includes('Last run failed'), 'failed task differs from blocked');
      check(rowOf('Gamma').textContent.includes('Paused'), 'paused task shown');
      check(text().includes('Tasks run inside Continuum while the app is open'), 'closed-app behaviour is stated');
      check(text().includes('1') && text().includes('Upcoming'), 'overview renders');

      // ---- Details and history --------------------------------------------
      [...alphaRow.querySelectorAll('button')].find(b => b.textContent.trim() === 'Alpha').click(); await wait();
      const detail = document.querySelector('.tasks-detail');
      check(!!detail, 'details panel opens');
      check(detail.textContent.includes('Configuration') && detail.textContent.includes('History'), 'sections present');
      check(detail.textContent.includes('Alpha instructions for the assistant.'), 'instructions visible');
      check(detail.textContent.includes('read_only'), 'permission mode visible');
      check(detail.textContent.includes('Completed') && detail.textContent.includes('Needs attention'), 'history shows success and blocked');
      check(detail.textContent.includes('approval_required'), 'blocked reason visible');
      check(window.calls.history.some(call => call.taskId === 'a'), 'history queried for the task');
      check(!!button('Open chat', detail), 'completed run offers its saved chat');
      button('Open chat', detail).click();
      check(window.openedRun === 'scheduled-r1', 'open chat selects the run session');

      // ---- Live events touch the right task --------------------------------
      window.pushEvent({ type: 'run-updated', run: { id: 'live-1', taskId: 'b', status: 'running', trigger: 'schedule', scheduledFor: Date.now(), startedAt: Date.now() } });
      await wait(80);
      check(rowOf('Beta').textContent.includes('Running'), 'live run status updates the right row');
      check(!rowOf('Alpha').textContent.includes('Running'), 'unrelated rows are untouched');
      window.pushEvent({ type: 'task-updated', task: { ...{ id: 'b', name: 'Beta renamed', prompt: 'p', schedule: { type: 'daily', atTime: '09:00', startAt: 0 }, timezone: 'UTC', model: { kind: 'local', modelPath: '/models/alpha.gguf' }, fallback: [], missedPolicy: { policy: 'grace', graceHours: 24, maxOverdueDays: 7 }, permissionMode: 'read_only', enabled: true, nextRunAt: Date.UTC(2026,0,11,9), lastStatus: 'failed', createdAt: 0, updatedAt: 0 } } });
      await wait(80);
      check(!!rowOf('Beta renamed'), 'live task rename is applied');
      check(!!rowOf('Alpha'), 'other tasks survive the update');

      // ---- Create (with validation) ---------------------------------------
      button('Create task').click(); await wait();
      check(!!dialog(), 'create dialog opens');
      setValue(field('Task name'), 'Nightly digest');
      setValue(field('Instructions'), 'Write a short digest of the day.');
      setValue(field('Timezone'), 'Not/AZone');
      button('Create task', dialog()).click(); await wait(120);
      check(text().includes('Choose a valid IANA timezone.'), 'validation errors are shown');
      check(window.calls.create.length === 0, 'invalid form never reaches IPC');

      setValue(field('Timezone'), 'UTC');
      selectValue('once');
      await wait();
      setValue(field('Date'), '2026-02-03');
      setValue(field('Time'), '21:30');
      selectValue('/models/alpha.gguf'); await wait();
      button('Create task', dialog()).click();
      for (let i = 0; i < 40 && !window.calls.create.length; i++) await wait();
      const created = window.calls.create[0];
      check(!!created, 'create reaches IPC');
      check(created.name === 'Nightly digest' && created.prompt === 'Write a short digest of the day.', 'name and prompt sent');
      check(created.schedule && created.schedule.type === 'once' && created.schedule.at === Date.UTC(2026, 1, 3, 21, 30), 'one-time schedule converted from the task timezone');
      check(created.model && created.model.kind === 'local' && created.model.modelPath === '/models/alpha.gguf', 'model sent as a backend reference');
      check(created.permissionMode === 'read_only', 'safe default permission mode');
      check(created.projectId === null && Array.isArray(created.fallback) && created.fallback.length === 0, 'optional fields default cleanly');
      check(!Object.keys(created).some(key => ['recurrence', 'modelRef', 'catchup'].includes(key)), 'only documented fields are sent');
      await wait(80);
      check(!!rowOf('Nightly digest'), 'created task appears from persisted state');

      // ---- Edit sends a minimal patch -------------------------------------
      ariaButton('Edit Alpha').click(); await wait();
      check(!!dialog(), 'edit dialog opens');
      setValue(field('Task name'), 'Alpha edited');
      button('Save changes', dialog()).click();
      for (let i = 0; i < 40 && !window.calls.update.length; i++) await wait();
      const patch = window.calls.update[0];
      check(patch && patch.id === 'a', 'update targets the task');
      check(JSON.stringify(patch.patch) === JSON.stringify({ name: 'Alpha edited' }), 'rename sends only the changed field: ' + JSON.stringify(patch.patch));
      await wait(80);
      check(!!rowOf('Alpha edited'), 'edit applied to the list');

      // ---- Pause, resume, run now, cancel ---------------------------------
      ariaButton('Pause Alpha edited').click();
      for (let i = 0; i < 40 && !window.calls.pause.length; i++) await wait();
      check(window.calls.pause.includes('a'), 'pause reaches IPC');
      await wait(80);
      check(rowOf('Alpha edited').textContent.includes('Paused'), 'paused state shown');
      ariaButton('Resume Alpha edited').click();
      for (let i = 0; i < 40 && !window.calls.resume.length; i++) await wait();
      check(window.calls.resume.includes('a'), 'resume reaches IPC');

      ariaButton('Run Alpha edited now').click();
      for (let i = 0; i < 40 && !window.calls.runNow.length; i++) await wait();
      check(window.calls.runNow.includes('a'), 'run now reaches IPC');
      await wait(120);
      check(text().includes('was queued'), 'queued run is acknowledged');
      [...rowOf('Alpha edited').querySelectorAll('button')].find(b => b.textContent.trim() === 'Alpha edited').click();
      await wait(120);
      const cancelButton = [...document.querySelectorAll('.tasks-detail button')].find(b => b.textContent.trim() === 'Cancel run');
      check(!!cancelButton, 'active run can be cancelled from details');
      cancelButton.click();
      for (let i = 0; i < 40 && !window.calls.cancel.length; i++) await wait();
      check(window.calls.cancel.includes('run-now-a'), 'cancel targets the active run');

      // ---- Delete needs confirmation --------------------------------------
      ariaButton('Delete Alpha edited').click(); await wait();
      check(dialog() && dialog().textContent.includes('history is kept'), 'deletion explains history is preserved');
      button('Delete task', dialog()).click();
      for (let i = 0; i < 40 && !window.calls.remove.length; i++) await wait();
      check(window.calls.remove.includes('a'), 'delete reaches IPC');
      await wait(120);
      check(!rowOf('Alpha edited'), 'deleted task removed from the list');

      // ---- Error and retry -------------------------------------------------
      window.failList = true;
      button('Refresh').click();
      for (let i = 0; i < 40 && !text().includes('Backend unavailable'); i++) await wait();
      check(text().includes('Backend unavailable'), 'failed list shows an error');
      check(!!button('Retry'), 'retry offered');
      window.failList = false;
      button('Retry').click();
      for (let i = 0; i < 40 && !rowOf('Gamma'); i++) await wait();
      check(!!rowOf('Gamma'), 'retry recovers the list');

      // ---- Theme variables drive colours ----------------------------------
      const failedChip = [...rowOf('Beta').querySelectorAll('.tasks-chip')].find(chip => chip.textContent.includes('Failed'));
      check(!!failedChip, 'failed chip present');
      document.documentElement.style.setProperty('--error', 'rgb(9, 9, 9)');
      check(getComputedStyle(failedChip).color === 'rgb(9, 9, 9)', 'status colour follows the theme variable');
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.setProperty('--error', 'rgb(200, 10, 10)');
      check(getComputedStyle(failedChip).color === 'rgb(200, 10, 10)', 'light theme re-colours the same chip');

      // ---- Empty state ------------------------------------------------------
      window.setTasks([]);
      button('Refresh').click();
      for (let i = 0; i < 40 && !text().includes('No scheduled tasks yet.'); i++) await wait();
      check(text().includes('No scheduled tasks yet.'), 'empty state shown');
      check(!!button('Create your first task'), 'empty state offers creation');

      // ---- Subscription cleanup --------------------------------------------
      const { added, removed } = window.subscriptions;
      check(added >= 1, 'page subscribed to events');
      window.setMounted(false);
      await wait(80);
      check(window.subscriptions.removed === window.subscriptions.added, 'subscription removed on unmount');
      return { added, removed: window.subscriptions.removed, checks: 40 };
    })()`);
		console.log('Scheduled tasks UI: navigation, list, details, create/edit, lifecycle, live events, error/empty states and theming passed.');
		console.log(JSON.stringify(result));
	} finally {
		window.destroy();
		await fs.rm(directory, { recursive: true, force: true });
	}
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

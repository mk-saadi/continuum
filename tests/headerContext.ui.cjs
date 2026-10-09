// Header context: a restored casual tab must label the header "Chat", a
// restored workspace tab must show Home + workspace name, and both controls
// must navigate through the existing tab.view mechanism (projects →
// ProjectsView, project → ProjectWorkspace) with the project id preserved.
// Output goes to stderr because console output can be swallowed when the app
// exits (see tabSavedFlag.ui.cjs / permissionMode.ui.cjs).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
// Subscribing suppresses Electron's quit-when-all-windows-closed default,
// which would otherwise exit 0 from window.destroy() before app.exit runs and
// turn an assertion failure into a false-green exit code.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'header-context-ui-'));
  app.setPath('userData', directory);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let exitCode = 0;
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures', 'headerContext.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));

    const passed = await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const header = () => document.querySelector('header');
      const hasLabel = (root, label) => !!root.querySelector('[aria-label="' + label + '"]');
      const hasText = (root, text) => Array.from(root.querySelectorAll('span')).some(span => span.textContent === text);

      // Phase 1 — the restored casual tab shows a plain Chat label.
      for (let i = 0; i < 150 && !header(); i++) await tick(20);
      check(header(), 'header renders');
      check(hasText(header(), 'Chat'), 'casual header shows Chat');
      check(!hasLabel(header(), 'Workspace Home'), 'casual header hides home');
      check(!hasLabel(header(), 'Open workspace'), 'casual header hides workspace name');

      // The pre-existing controls must all still be present.
      check(hasLabel(header(), 'Toggle chat history'), 'history toggle present');
      check(hasLabel(header(), 'Select or load model'), 'model selector present');
      check(hasLabel(header(), 'Open settings'), 'settings present');
      check(hasLabel(header(), 'Toggle chat controls'), 'right sidebar toggle present');
      check(header().textContent.includes('Context'), 'context indicator present');

      // Phase 2 — switching to the restored workspace tab swaps in Home + name.
      document.querySelector('[aria-label="switch-ws"]').click();
      await tick(40);
      check(hasLabel(header(), 'Workspace Home'), 'workspace header shows home');
      const name = header().querySelector('[aria-label="Open workspace"]');
      check(name && name.textContent.includes('llm-electron'), 'workspace header shows the project name');
      check(!hasText(header(), 'Chat'), 'workspace header drops the Chat label');

      // Phase 3 — the workspace name navigates to the overview, id preserved.
      header().querySelector('[aria-label="Open workspace"]').click();
      await tick(40);
      check(document.querySelector('[data-view]').getAttribute('data-view') === 'project:p_llm',
        'workspace name sets view=project with the project id (ProjectWorkspace branch)');
      check(window.navLog.some(entry => entry.tabId === 'ws' && entry.view === 'project' && entry.projectId === 'p_llm'),
        'overview patch preserves the project id');
      check(!!header().querySelector('[aria-label="Open workspace"]'),
        'the workspace name stays visible on the overview page');

      // Phase 4 — Home navigates to the all-workspaces view (ProjectsView) and
      // the single-workspace name must drop out, leaving Home alone.
      header().querySelector('[aria-label="Workspace Home"]').click();
      await tick(40);
      check(document.querySelector('[data-view]').getAttribute('data-view') === 'projects:p_llm',
        'home sets view=projects (ProjectsView branch) with the project id untouched');
      check(window.navLog.some(entry => entry.tabId === 'ws' && entry.view === 'projects' && !('projectId' in entry)),
        'home patch carries only the view');
      check(!!header().querySelector('[aria-label="Workspace Home"]'),
        'workspace home page keeps the home icon');
      check(!header().querySelector('[aria-label="Open workspace"]'),
        'workspace home page drops the single-workspace name');
      check(!Array.from(header().querySelectorAll('span')).some(span => span.textContent === '|'),
        'workspace home page drops the separator too');

      // Phase 5 — switching back to the casual tab restores the Chat header.
      document.querySelector('[aria-label="switch-casual"]').click();
      await tick(40);
      check(hasText(header(), 'Chat'), 'switching chats restores the Chat label');
      check(!hasLabel(header(), 'Workspace Home'), 'home disappears after switching back');

      // Phase 6 — the existing controls still fire their handlers.
      header().querySelector('[aria-label="Open settings"]').click();
      header().querySelector('[aria-label="Toggle chat history"]').click();
      header().querySelector('[aria-label="Toggle chat controls"]').click();
      header().querySelector('[aria-label="Select or load model"]').click();
      await tick(40);
      check(window.clicks.settings === 1, 'settings button still works');
      check(window.clicks.sidebar === 1, 'history toggle still works');
      check(window.clicks.right === 1, 'right sidebar toggle still works');
      check(window.clicks.models === 1, 'model selector still works');
      check(header().querySelector('[aria-label="Toggle chat history"]').getAttribute('aria-expanded') === 'true',
        'history toggle still updates aria-expanded');
      return true;
    })()`);
    assert.equal(passed, true);
    process.stderr.write('headerContext.ui: Chat vs Workspace header context and navigation OK\n');
  } catch (error) {
    exitCode = 1;
    process.stderr.write('FAIL: ' + (error && error.stack ? error.stack : error) + '\n');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(exitCode);
}).catch(error => { process.stderr.write('FAIL: ' + error + '\n'); app.exit(1); });

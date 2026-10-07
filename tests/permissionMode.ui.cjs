// Permission selector UI: the composer must advertise exactly the modes the
// context allows (three casual, four with a workspace), and the project
// settings panel must expose the project's default mode for new chats using
// the same catalog. Guards against a hard-coded option list drifting away
// from src/lib/permissionModes.json. Output goes to stderr because console
// output can be swallowed when the app exits (see tabSavedFlag.ui.cjs).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'permission-mode-ui-'));
  app.setPath('userData', directory);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let exitCode = 0;
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures', 'permissionMode.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'),
      '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));

    const passed = await window.webContents.executeJavaScript(`(async () => {
      const tick = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw new Error(message); };
      const options = (root, selector) =>
        Array.from(document.querySelector(root).querySelectorAll(selector + ' option'))
          .map(option => option.value).filter(Boolean);
      const select = (root, label) => document.querySelector(root + ' select[aria-label="' + label + '"]');

      // Phase 1 — the composer shows only modes valid for its context.
      const casual = select('#casual', 'Tool permission mode');
      const workspace = select('#workspace', 'Tool permission mode');
      check(casual && workspace, 'both composers render a permission selector');
      check(JSON.stringify(options('#casual', 'select[aria-label="Tool permission mode"]'))
        === JSON.stringify(['read_only', 'ask_approval', 'full_access']),
        'casual composer offers read_only, ask_approval, full_access');
      check(!options('#casual', 'select[aria-label="Tool permission mode"]').includes('workspace_write'),
        'casual composer never offers workspace_write');
      check(JSON.stringify(options('#workspace', 'select[aria-label="Tool permission mode"]'))
        === JSON.stringify(['read_only', 'workspace_write', 'ask_approval', 'full_access']),
        'workspace composer offers all four modes');
      check(casual.value === 'ask_approval', 'casual default is ask_approval');
      check(workspace.value === 'workspace_write', 'workspace default is workspace_write');

      // Phase 2 — the project settings panel exposes the default mode.
      for (let i = 0; i < 150; i++) {
        if (document.querySelector('#panel-workspace select[aria-label="Default permission mode"]') &&
            document.querySelector('#panel-rootless select[aria-label="Default permission mode"]')) break;
        await tick(20);
      }
      const panelSelect = root => select(root, 'Default permission mode');
      const wsPanel = panelSelect('#panel-workspace');
      const rootlessPanel = panelSelect('#panel-rootless');
      check(wsPanel && rootlessPanel, 'both project panels render the default mode control');
      check(wsPanel.value === 'workspace_write', 'workspace project defaults to workspace_write');
      check(options('#panel-workspace', 'select[aria-label="Default permission mode"]').length === 4,
        'workspace project can pick every mode');
      check(rootlessPanel.value === 'ask_approval',
        'project without a root defaults to ask_approval, never workspace_write');
      check(!options('#panel-rootless', 'select[aria-label="Default permission mode"]').includes('workspace_write'),
        'project without a root cannot select workspace_write');
      check(document.querySelector('#panel-rootless').textContent.includes('Connect a root folder'),
        'rootless project explains how to unlock Workspace Write');

      // Phase 3 — picking a mode saves it as the project default immediately.
      wsPanel.value = 'read_only';
      wsPanel.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && !window.updateCalls.length; i++) await tick(20);
      const call = window.updateCalls.find(entry => entry.id === 'p_workspace');
      check(call, 'selecting a mode saves the project');
      check(call.patch.permissionMode === 'read_only', 'save carries permissionMode: ' + JSON.stringify(call.patch));
      for (let i = 0; i < 100 && panelSelect('#panel-workspace').value !== 'read_only'; i++) await tick(20);
      check(panelSelect('#panel-workspace').value === 'read_only', 'panel reflects the saved default');
      return true;
    })()`);
    assert.equal(passed, true);
    process.stderr.write('permissionMode.ui: context option lists, defaults, and project save OK\n');
  } catch (error) {
    exitCode = 1;
    process.stderr.write('FAIL: ' + (error && error.stack ? error.stack : error) + '\n');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(exitCode);
}).catch(error => { process.stderr.write('FAIL: ' + error + '\n'); app.exit(1); });

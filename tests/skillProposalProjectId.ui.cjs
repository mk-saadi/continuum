// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/skillProposalProjectId.ui.cjs
// B2: SkillProposalCard registers against the chat/session's own project id
// (`chatProjectId`), never the selected tab's `activeProjectId`. The fixture
// mounts ChatInterface with activeProjectId='tab-project' and three sessions:
// one rebound to 'session-project', one on 'tab-project', one on no project.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const writeSync = require('node:fs').writeSync;
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
// The repo's UI tests note that app.exit can swallow console output, so the
// result is written synchronously to stderr.
const mark = text => writeSync(2, `${text}\n`);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proposal-project-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures', 'skillProposalProjectId.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    // The card persists its decision per step id in localStorage. Clear it in
    // the document *before* the fixture mounts — SkillProposalCard reads the
    // decision in its useState initializer — so a previous run cannot hide the
    // Register button behind "Skill registered."
    await fs.writeFile(path.join(directory, 'index.html'),
      '<script>localStorage.clear()</script><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const cardFor = async name => {
        for (let i = 0; i < 80; i++) {
          const card = [...document.querySelectorAll('[aria-label="Skill proposal"]')]
            .find(node => node.textContent.includes(name));
          if (card) return card;
          await wait();
        }
        throw new Error('skill proposal card never rendered: ' + name);
      };
      const register = async name => {
        const card = await cardFor(name);
        const button = card.querySelector('button.project-button.primary');
        check(button, 'register button missing: ' + name);
        check(!button.disabled, 'register button enabled for a completed step: ' + name);
        button.click();
        for (let i = 0; i < 40 && !window.savedSkills.some(skill => skill.name === name); i++) await wait();
        check(window.savedSkills.some(skill => skill.name === name), 'register did not save: ' + name);
        return window.savedSkills.find(skill => skill.name === name);
      };
      const shape = skill => JSON.stringify(Object.keys(skill));

      // 1. Regression: the tab is bound to 'tab-project' while the chat's
      //    session row says 'session-project'. The proposal must register
      //    against the chat's project.
      const divergent = await register('rebound-skill');
      check(window.savedSkills.length === 1, 'first proposal registers exactly once');
      check(shape(divergent) === JSON.stringify(['name', 'description', 'instructions', 'projectId']),
        'payload shape changed: ' + shape(divergent));
      check(divergent.projectId === 'session-project',
        'chat project id wins over the tab\\'s, got: ' + String(divergent.projectId));
      check(divergent.projectId !== 'tab-project', 'never falls back to the tab project');

      // 2. Normal case: the tab and the chat share the same project.
      window.switchSession('session-normal');
      const normal = await register('normal-skill');
      check(normal.projectId === 'tab-project',
        'matching chat/tab project still registers, got: ' + String(normal.projectId));

      // 3. Chats without a project keep registering without one.
      window.switchSession('session-casual');
      const casual = await register('casual-skill');
      check('projectId' in casual, 'projectless chat still sends the projectId field');
      check(casual.projectId === null,
        'projectless chat sends null, got: ' + String(casual.projectId));
    })()`);
    mark('Skill proposal project id: chat/session project used over the tab\u2019s (divergent, matching, and projectless cases passed).');
  } catch (error) {
    mark(`Skill proposal project id test failed: ${error && error.stack ? error.stack : error}`);
    // Do not destroy the window first: closing the last window triggers
    // Electron's default quit with code 0, which races (and here beat)
    // the app.exit(1) below, so failures reported exit code 0.
    await fs.rm(directory, { recursive: true, force: true });
    app.exit(1);
    return;
  }
  // Remove the bundle while the window is still alive: destroying the last
  // window can trigger Electron's default quit (code 0) before this cleanup
  // runs, which is what leaves stale fixture directories behind. Nothing else
  // writes into this directory (user data stays in the default location).
  await fs.rm(directory, { recursive: true, force: true });
  window.destroy();
  app.exit(0);
}).catch(error => { mark(`Skill proposal project id test failed: ${error && error.stack ? error.stack : error}`); app.exit(1); });

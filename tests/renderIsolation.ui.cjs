// Phase 4 render-isolation suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/renderIsolation.ui.cjs
//
// Renders the real App shell with heavy leaves stubbed to counters (see
// fixtures/renderIsolation.jsx) and measures, for each targeted UI action, how
// many ChatInterface instances re-rendered and how many distinct mounted tabs
// rendered. AppContent renders are proxied by the plain Titlebar counter.
//
// `RESULTS {...}` is always printed so a baseline run against a different
// working tree can be compared even when the post-change assertions fail.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

// Stub the expensive leaves. Each returns a stable-ish shape and records its
// own render count so propagation is observable. Header and TabBar stay real.
const stubs = require('./fixtures/renderIsolationStubs.cjs');

app.whenReady().then(async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'render-isolation-'));
	const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true } });
	try {
		await esbuild.build({
			entryPoints: [path.join(__dirname, 'fixtures/renderIsolation.jsx')],
			bundle: true,
			outfile: path.join(directory, 'fixture.js'),
			define: { 'process.env.NODE_ENV': '"test"' },
			plugins: [stubs],
		});
		await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
		await window.loadFile(path.join(directory, 'index.html'));

		const results = await window.webContents.executeJavaScript(`(async () => {
			const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
			const until = async (fn, tries = 400) => { for (let i = 0; i < tries; i += 1) { if (fn()) return; await wait(); } throw new Error('timeout'); };
			const snap = () => ({ i: window.chatRenderLog.length, t: window.titlebarRenders, ms: window.memorySettingsRenders, mdl: window.modelSelectorRenders });
			const delta = (m) => {
				const slice = window.chatRenderLog.slice(m.i);
				return {
					chatTotal: slice.length,
					tabsRendered: new Set(slice).size,
					app: window.titlebarRenders - m.t,
					memorySettings: window.memorySettingsRenders - m.ms,
					modelSelector: window.modelSelectorRenders - m.mdl,
				};
			};
			const header = () => document.querySelector('header');

			window.mountApp();
			await until(() => window.titlebarRenders > 0);
			await wait(700);
			await window.addTabs(2);
			await wait(400);
			const tabCount = document.querySelectorAll('[data-tab-id]').length;

			const out = { tabCount };

			// --- Modal open/close: settings ---
			let m = snap();
			header().querySelector('[aria-label="Open settings"]').click();
			await until(() => document.querySelector('[data-testid="memory-settings"]'));
			await wait(80);
			out.settingsOpen = delta(m);

			// --- Theme change while settings open ---
			m = snap();
			document.querySelector('[data-testid="change-theme"]').click();
			await wait(120);
			out.themeChange = delta(m);
			out.themeApplied = document.documentElement.getAttribute('data-theme');

			m = snap();
			document.querySelector('[data-testid="close-settings"]').click();
			await wait(120);
			out.settingsClose = delta(m);

			// --- Modal open/close: model selector ---
			m = snap();
			header().querySelector('[aria-label="Select or load model"]').click();
			await until(() => document.querySelector('[data-testid="model-selector"]'));
			await wait(80);
			out.modelSelectorOpen = delta(m);

			m = snap();
			document.querySelector('[data-testid="close-model-selector"]').click();
			await wait(120);
			out.modelSelectorClose = delta(m);

			// --- Sidebar toggles ---
			m = snap();
			header().querySelector('[aria-label="Toggle chat history"]').click();
			await wait(120);
			out.leftOpen = delta(m);

			m = snap();
			header().querySelector('[aria-label="Toggle chat history"]').click();
			await wait(120);
			out.leftClose = delta(m);

			m = snap();
			header().querySelector('[aria-label="Toggle chat controls"]').click();
			await wait(120);
			out.rightOpen = delta(m);

			m = snap();
			header().querySelector('[aria-label="Toggle chat controls"]').click();
			await wait(120);
			out.rightClose = delta(m);

			// --- Conversation switch (two tabs change, the rest must not) ---
			const tabsAt = (index) => document.querySelectorAll('[data-tab-id]')[index].querySelector('button');
			m = snap();
			tabsAt(0).click();
			await wait(150);
			out.switchToFirst = delta(m);

			m = snap();
			tabsAt(2).click();
			await wait(150);
			out.switchToThird = delta(m);

			// --- A real per-tab change still updates exactly that tab ---
			const streamingSession = window.chatRenderLog[0];
			m = snap();
			window.__emitStreamStatus({ sessionId: streamingSession, status: 'generating' });
			await wait(150);
			out.streamStatus = delta(m);

			return out;
		})()`);

		process.stderr.write('RESULTS ' + JSON.stringify(results) + '\n');

		const { tabCount } = results;
		assert.equal(tabCount, 3, 'three tabs mounted');

		// Modals and chrome state must not touch any mounted chat tab.
		for (const key of ['settingsOpen', 'settingsClose', 'modelSelectorOpen', 'modelSelectorClose']) {
			assert.equal(results[key].chatTotal, 0, key + ': no ChatInterface re-render');
			assert.equal(results[key].app, 0, key + ': AppContent did not re-render');
		}
		// Opening settings mounts exactly one settings panel (the active tab).
		assert.equal(results.settingsOpen.memorySettings, 1, 'settings panel mounted once');
		assert.equal(results.settingsClose.memorySettings, 0, 'settings panel closed without remount');
		assert.equal(results.modelSelectorOpen.modelSelector, 1, 'model selector mounted once');

		// Theme is a global setting: it updates the settings panel, not the tabs.
		assert.equal(results.themeApplied, 'light', 'theme applied');
		assert.equal(results.themeChange.chatTotal, 0, 'theme change: no ChatInterface re-render');
		assert.equal(results.themeChange.app, 0, 'theme change: AppContent did not re-render');

		// Sidebar toggles must not force chat transcripts through render work.
		for (const key of ['leftOpen', 'leftClose', 'rightOpen', 'rightClose']) {
			assert.equal(results[key].chatTotal, 0, key + ': no ChatInterface re-render');
			assert.equal(results[key].app, 0, key + ': AppContent did not re-render');
		}

		// Switching conversations re-renders only the two tabs involved.
		assert.equal(results.switchToFirst.tabsRendered, 2, 'switch: only the previous and next tabs render');
		assert.equal(results.switchToThird.tabsRendered, 2, 'switch back: only two tabs render');

		// Legitimate per-tab changes still reach their own tab (and only it).
		assert.equal(results.streamStatus.tabsRendered, 1, 'stream status renders only the affected tab');

		console.log('Render isolation: modals, theme, sidebars and tab switches propagate only to the components that own the change.');
	} finally {
		window.destroy();
		await fs.rm(directory, { recursive: true, force: true });
	}
	app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });

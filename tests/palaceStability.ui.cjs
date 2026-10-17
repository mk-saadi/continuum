// Phase 5 stability suite.
//
// Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/palaceStability.ui.cjs
//
// Drives the REAL `useMemoryPalace` hook and REAL `ChatInterface` (see
// fixtures/palaceStability.jsx) and measures, across forced parent rerenders
// with unchanged inputs:
//   - how many times the hook's returned object and callbacks change identity,
//   - how many keydown listeners ChatInterface re-registers,
//   - how many times `pendingSkillProposals` is recomputed,
// plus a behavioral check that a skill decision updates proposal visibility.
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

// Redirect ChatInterface's executionEvents import to the counting wrapper.
const skillProbe = {
	name: 'skill-probe',
	setup(build) {
		build.onResolve({ filter: /executionEvents\.mjs$/ }, (args) => {
			// The probe re-exports the real module; never redirect its own import.
			if (args.importer.endsWith('executionEventsProbe.mjs')) return null;
			return { path: path.join(__dirname, 'fixtures/executionEventsProbe.mjs') };
		});
	},
};

const TICKS = 8;

app.whenReady().then(async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'palace-stability-'));
	const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true } });
	try {
		await esbuild.build({
			entryPoints: [path.join(__dirname, 'fixtures/palaceStability.jsx')],
			bundle: true,
			outfile: path.join(directory, 'fixture.js'),
			define: { 'process.env.NODE_ENV': '"test"' },
			plugins: [skillProbe],
		});
		await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
		await window.loadFile(path.join(directory, 'index.html'));

		const results = await window.webContents.executeJavaScript(`(async () => {
			const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
			const until = async (fn, message, tries = 300) => {
				for (let i = 0; i < tries; i += 1) { if (fn()) return; await wait(); }
				throw new Error(message);
			};
			const out = {};
			try {

			// --- 1. Hook identity across forced rerenders ---
			window.installPhase5Api();
			window.mountProbe();
			await until(() => window.__palaceProbe, 'hook probe mounted');
			await wait(250); // let refresh/measure settle
			out.hookBase = JSON.parse(JSON.stringify(window.__probeChanges));
			for (let i = 0; i < ${TICKS}; i += 1) { window.__probeTick(); await wait(10); }
			out.hookDelta = {};
			for (const key of Object.keys(window.__probeChanges)) {
				out.hookDelta[key] = window.__probeChanges[key] - out.hookBase[key];
			}

			// --- 1b. A real data change still produces a new identity ---
			const beforeChange = window.__probeChanges.obj;
			window.__palaceProbe.setSessionId('sess-probe-2');
			await wait(60);
			out.sessionChange = { objDelta: window.__probeChanges.obj - beforeChange, sessionId: window.__palaceProbe.sessionId };

			// --- 2. ChatInterface churn: baseline TabPane wiring (fresh provider) ---
			window.installPhase5Api({ 'sess-chat': { id: 'sess-chat', messages: [] } });
			window.mountChat({ freshProvider: true, saved: false });
			await until(() => document.querySelector('textarea[aria-label="Message"]'), 'chat mount (fresh provider) errors=' + JSON.stringify(window.__errors));
			await wait(250);
			let k0 = window.__keydownAdds;
			let s0 = window.__skillCalls;
			for (let i = 0; i < ${TICKS}; i += 1) { window.__chatTick(); await wait(10); }
			out.freshProviderDelta = { keydownAdds: window.__keydownAdds - k0, skillCalls: window.__skillCalls - s0 };

			// --- 3. ChatInterface churn: stabilized TabPane wiring ---
			window.installPhase5Api({ 'sess-chat': { id: 'sess-chat', messages: [] } });
			window.mountChat({ freshProvider: false, saved: false });
			await until(() => document.querySelector('textarea[aria-label="Message"]'), 'chat mount (stable provider) errors=' + JSON.stringify(window.__errors));
			await wait(250);
			k0 = window.__keydownAdds;
			s0 = window.__skillCalls;
			for (let i = 0; i < ${TICKS}; i += 1) { window.__chatTick(); await wait(10); }
			out.stableProviderDelta = { keydownAdds: window.__keydownAdds - k0, skillCalls: window.__skillCalls - s0 };

			// --- 4. Skill decision updates proposal visibility (memo invalidation) ---
			const skillStep = { id: 'skill-1', type: 'tool_call', toolName: 'propose_skill', status: 'complete',
				args: { name: 'demo-skill', description: 'Does a thing', instructions: 'Do it.' } };
			window.installPhase5Api({ 'sess-chat': { id: 'sess-chat', messages: [
				{ id: 'm1', role: 'assistant', content: '', executionSteps: [skillStep] },
			] } });
			localStorage.removeItem('skill-proposal:skill-1');
			window.mountChat({ freshProvider: false, saved: true });
			await until(() => document.querySelector('[aria-label="Pending interactions"]'), 'pending skill panel did not appear');
			out.panelBeforeDecision = !!document.querySelector('[aria-label="Pending interactions"]');
			const sBefore = window.__skillCalls;
			const decline = [...document.querySelectorAll('[aria-label="Pending interactions"] button')]
				.find((button) => button.textContent.trim() === 'Decline');
			if (!decline) throw new Error('decline button missing');
			decline.click();
			await wait(60);
			out.panelAfterDecision = !!document.querySelector('[aria-label="Pending interactions"]');
			out.skillCallsOnDecision = window.__skillCalls - sBefore;
			// Unrelated rerenders after the decision must not resurrect the panel.
			const sAfter = window.__skillCalls;
			for (let i = 0; i < 4; i += 1) { window.__chatTick(); await wait(10); }
			out.panelAfterRerenders = !!document.querySelector('[aria-label="Pending interactions"]');
			out.skillCallsAfterRerenders = window.__skillCalls - sAfter;

			} catch (error) {
				out.error = String((error && error.message) || error);
				out.pageErrors = window.__errors;
			}
			return out;
		})()`);

		process.stderr.write('RESULTS ' + JSON.stringify(results) + '\n');
		assert.ok(!results.error, 'scenario failed: ' + results.error + ' page=' + JSON.stringify(results.pageErrors));

		// 1. Stable identity when meaningful values are unchanged.
		assert.equal(results.hookDelta.obj, 0, 'palace object identity stable across rerenders');
		for (const key of ['setSessionId', 'refresh', 'schedule', 'prepareMessages', 'finishMessage', 'toggle', 'measure', 'noteLivePhase', 'clearLiveTelemetry']) {
			assert.equal(results.hookDelta[key], 0, key + ' identity stable across rerenders');
		}
		// The stable object must still change when real data changes.
		assert.ok(results.sessionChange.objDelta >= 1, 'a session change produces a new palace identity');
		assert.equal(results.sessionChange.sessionId, 'sess-probe-2', 'session change is reflected in the returned value');

		// 2. Baseline wiring (fresh provider object every render) still causes churn —
		//    this is the cost the stabilized provider removes.
		assert.ok(results.freshProviderDelta.keydownAdds >= TICKS - 1, 'fresh provider: keydown re-registers each rerender');

		// 3. Stabilized wiring: no keydown churn, no skill-proposal recomputation.
		assert.equal(results.stableProviderDelta.keydownAdds, 0, 'stable wiring: no keydown re-registration');
		assert.equal(results.stableProviderDelta.skillCalls, 0, 'stable wiring: no skill-proposal recomputation');

		// 4. A decision still invalidates and hides the proposal.
		assert.equal(results.panelBeforeDecision, true, 'proposal panel shown before decision');
		assert.equal(results.panelAfterDecision, false, 'proposal panel hidden after decision');
		assert.ok(results.skillCallsOnDecision >= 1, 'decision triggers one recomputation');
		assert.equal(results.panelAfterRerenders, false, 'decided proposal stays hidden');
		assert.equal(results.skillCallsAfterRerenders, 0, 'no recomputation after the decision settles');

		console.log('Palace stability: hook identity, keydown churn, proposal recomputation, and decision invalidation verified.');
	} finally {
		window.destroy();
		await fs.rm(directory, { recursive: true, force: true });
	}
	app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });

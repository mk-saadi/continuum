const { localEngineFetch } = require("./src/main/localEngineFetch");
const { app, BrowserWindow, ipcMain, protocol, shell, powerMonitor } = require("electron");
const { registerLocalMediaProtocol, serveMediaRequest } = require("./src/main/localMedia");
protocol.registerSchemesAsPrivileged([
	{ scheme: "local", privileges: { standard: true, secure: true, stream: true } },
	// A standard origin is required for reliable Chromium media range requests.
	{ scheme: "media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const net = require("net");
const { pathToFileURL } = require("url");
const { initDatabase, syncSystemDate, closeDatabase } = require("./src/main/db.js");
const { registerIpcHandlers } = require("./src/main/ipcHandlers.js");
const { waitForTurnLeasesToClear, DEFAULT_TIMEOUT_MS } = require("./src/main/modelSwitchCoordinator");

// Establish the code-owned local-development entitlement (if any) before any
// readiness query. This never enables consent: Trusted Development still
// requires explicit native confirmation in Settings, and every eligible launch
// uses the primary application profile.
require("./src/main/localDevelopmentNetwork").initialize();

const {
	buildLlamaServerArgs,
	buildLlamaServerEnv,
	createStartupHandler,
	createIdleService,
	resolveEngineCommand,
	describeEngineSpawnError,
	ENGINE_BINARY,
} = require("./src/main/engineManager");
const {
	normalizeLoadConfig,
	saveLoadConfig,
	forgetLoadConfig,
	getAppSettings,
} = require("./src/main/configManager");
const { scanDirectoryForModels } = require("./src/main/modelScanner");
const {
	queryGpuMemory,
	estimateOffloadRequirements,
	assessGpuFit,
	describeGpuFitWarning,
	shouldPreflightOffload,
	evaluateOffloadResult,
	DEFAULT_SAFETY_MARGIN_MIB,
} = require("./src/main/gpuMemory");
const scannedModels = new Map();
// One heavy load at a time; each loaded model owns its own entry below.
let launching = false;
// modelPath -> engine entry. Several engines may run at once (one per model).
const engines = new Map();
// The last engine the UI acted on; used as the default for accessors that take
// no explicit model id (sub-agent default, capability probe, status queries).
let activeModelPath = null;
// Aborted on real application shutdown so a pending model load never spawns a
// new engine while the app is quitting. Close-window on macOS does not set it.
let appShuttingDown = false;
// Created after the database and IPC composition root are ready. Kept at
// module scope so signal-based shutdown can mark in-flight scheduled runs as
// interrupted before the process exits.
let scheduledTaskScheduler = null;
const MODEL_SWITCH_LEASE_WAIT_MS = DEFAULT_TIMEOUT_MS;

const isDev = process.env.NODE_ENV === "development";

let mainWindow = null;
require("./src/main/services/notificationService").configureNotificationService(() => mainWindow);
const transportRequestCounts = new WeakMap();
// Retain retired endpoints as unavailable so queued requests cannot dispatch
// to a process we already observed exiting. A new owner replaces its port entry.
const localRequestOwners = new Map();
require('./src/main/localEngineFetch').setLocalRequestOwner?.(url => {
  const endpoint = new URL(url);
  return ['127.0.0.1', 'localhost'].includes(endpoint.hostname) ? localRequestOwners.get(Number(endpoint.port)) : null;
});

// Two app instances each own a separate detached llama-server. The second
// window then reports the first model as unloaded while both still hold VRAM.
// Keep a single app instance and focus the existing window instead.
const hasSingleInstanceLock =
	typeof app.requestSingleInstanceLock === "function"
		? app.requestSingleInstanceLock()
		: true;
if (!hasSingleInstanceLock) {
	// The primary profile can only be written by one Electron process at a time.
	// Do not start a second writer: explain clearly, then exit.
	let profile = "the primary profile";
	try { profile = app.getPath("userData"); } catch { /* path not resolvable yet */ }
	console.error(`[continuum] Another Continuum instance already owns ${profile}. Focusing the existing window and exiting this launch.`);
	app.quit();
} else if (typeof app.on === "function") {
	app.on("second-instance", () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
}

// Electron skips before-quit/window-all-closed for SIGINT/SIGTERM (the usual
// way `npm run dev` is stopped). Without this the detached engine outlives the
// app and the next launch loads a second model beside it.
if (process.type === "browser") {
	const stopAllSync = () => {
		for (const entry of engines.values()) {
			if (!Number.isInteger(entry.childPid)) continue;
			entry.lifecycle?.requestStop("app-shutdown", "electron-app");
			killProcessTreeSync(entry.childPid);
		}
		engineRuntimeState.clear();
	};
	let terminating = false;
	const terminate = (code) => {
		if (terminating) return;
		terminating = true;
		appShuttingDown = true;
		try { scheduledTaskScheduler?.markInterruptedSync?.('app-shutdown'); } catch { /* best-effort */ }
		for (const entry of engines.values()) entry.idleService?.dispose();
		stopAllSync();
		process.exit(code);
	};
	process.once("SIGINT", () => terminate(130));
	process.once("SIGTERM", () => terminate(143));
	process.once("SIGHUP", () => terminate(129));
	// Last-resort synchronous cleanup for ordinary exits and uncaught errors.
	process.once("exit", stopAllSync);
}

// ---------------------------------------------------------------------------
// External link handling
// ---------------------------------------------------------------------------
// Without this, clicking an http(s) link inside a chat message navigates the
// main window away from the app. In production the window loads
// file://.../index.html, so the navigation appears to "hang" on a blank or
// opaque page -- and because the window is created transparent/frameless, the
// result reads as a crash or whiteout rather than a navigation.
//
// All real external links go to the user's default browser via shell, and the
// app window stays exactly where it is.
const DEV_SERVER_ORIGIN = "http://localhost:5173";

// Tracks the most recent handoff to the OS, used to de-duplicate the paired
// will-navigate / will-frame-navigate events for one click.
let lastExternallyOpened = { url: null, at: 0 };

// Classify a URL into one of three states, because the navigation handlers
// treat "unknown" and "internal" very differently.
//
//   "external" -> hand to the user's default browser, block in-app navigation
//   "internal" -> our own document; let it load
//   "unsafe"   -> malformed; BLOCK, do not hand to the OS
//
// Failing closed matters here. An earlier version collapsed "unparseable" into
// "not external", which reads as internal and therefore *allows* the
// navigation -- the exact opposite of the intended behaviour. A URL that
// cannot be parsed is not trustworthy, so it is blocked outright.
function classifyUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return "unsafe";
	}
	// Non-web schemes are our own app plumbing (local:, media:) or document
	// loads. Never forward these to the OS browser.
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "internal";
	// In dev the UI itself is served over http. A bare prefix check would
	// classify our own document as external and hijack reloads, so compare
	// the fully parsed origin. Comparing origin (not a substring or prefix)
	// is what stops userinfo confusion such as
	// "http://localhost:5173@evil.com/", whose real host is evil.com.
	if (isDev && parsed.origin === DEV_SERVER_ORIGIN) return "internal";
	return "external";
}

function openExternally(rawUrl) {
	// A single main-frame navigation surfaces on BOTH will-navigate and
	// will-frame-navigate, so without this guard one click would spawn two
	// browser tabs. Only collapse the duplicate event, not a genuine
	// double-click by the user (which is >150ms later).
	const now = Date.now();
	if (lastExternallyOpened.url === rawUrl && now - lastExternallyOpened.at < 150) return;
	lastExternallyOpened = { url: rawUrl, at: now };

	// Fire and forget: openExternal rejects when no handler is registered, and
	// that must not surface as an unhandled rejection.
	shell.openExternal(rawUrl).catch((err) => {
		console.error("shell.openExternal failed:", err);
	});
}

function configureExternalLinks(win) {
	// Shared policy for every event that can move the window off the app.
	const handleNavigation = (event, url) => {
		const kind = classifyUrl(url);
		if (kind === "external") {
			event.preventDefault();
			openExternally(url);
			return;
		}
		// Block malformed URLs rather than letting them through unvalidated.
		if (kind === "unsafe") event.preventDefault();
	};

	// target="_blank" / window.open(): route to the browser, never spawn an
	// Electron child window. Deny unconditionally -- nothing in this app
	// legitimately opens a new window, so an "allow" branch would only ever
	// be reachable by hostile or malformed content.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (classifyUrl(url) === "external") openExternally(url);
		return { action: "deny" };
	});

	// Ordinary link clicks in the renderer navigate the *current* window, so
	// they arrive here rather than at the window-open handler.
	win.webContents.on("will-navigate", handleNavigation);

	// Sub-frame (<iframe>/<webview>) navigations do not bubble through
	// will-navigate, so they need their own hook.
	win.webContents.on("will-frame-navigate", (event) => handleNavigation(event, event.url));

	// HTTP-level redirects bypass will-navigate too.
	win.webContents.on("will-redirect", handleNavigation);
}

let desktopMascot;

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 700,
		minHeight: 400,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: true,
		skipTaskbar: false,
		webPreferences: {
			preload: path.join(__dirname, "src", "preload.js"),
			backgroundThrottling: false,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	desktopMascot = require('./src/main/desktopMascot').createDesktopMascot({
        mainWindow, isDev, root: __dirname,
        getSettings: require('./src/main/configManager').getAppSettings,
        saveSettings: require('./src/main/configManager').saveAppSettings,
    });
	configureExternalLinks(mainWindow);

	mainWindow.webContents.on("did-finish-load", () => {
		// Apply the default 120% UI scale on startup and reload.
		mainWindow.webContents.setZoomFactor(1.2);
	});

	mainWindow.maximize();

	if (isDev) {
		mainWindow.loadURL("http://localhost:5173");
		mainWindow.webContents.openDevTools({ mode: "detach" });
	} else {
		mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
	}

	mainWindow.on("closed", () => {
		desktopMascot?.dispose();
		desktopMascot = null;
		mainWindow = null;
	});
}

// Resolve an engine entry by model path, or the active engine when omitted.
function getEngine(modelPath = null) {
	if (modelPath) return engines.get(modelPath) ?? null;
	return activeModelPath ? engines.get(activeModelPath) ?? null : null;
}

// A model load/switch must not race an active agent turn. Waits for every
// engine in the pool to release its turn lease, bounded by
// MODEL_SWITCH_LEASE_WAIT_MS and cancelled by application shutdown.
async function waitForModelSwitchClear() {
	return waitForTurnLeasesToClear({
		engines: () => engines.values(),
		timeoutMs: MODEL_SWITCH_LEASE_WAIT_MS,
		isCancelled: () => appShuttingDown,
	});
}

function getEngineStatus(modelPath = null) {
	const entry = getEngine(modelPath);
	const modelPathValue =
		entry && entry.childProcess && entry.contextStatus !== "stopped" ? entry.modelPath : null;
	return {
		isLoaded:
			!!entry &&
			!!entry.childProcess &&
			["warming", "ready", "warmup-failed"].includes(entry.contextStatus),
		modelPath: modelPathValue,
		modelName: modelPathValue ? path.basename(modelPathValue) : null,
	};
}

// Full renderer-facing snapshot of one engine.
function serializeEngine(entry) {
	return {
		modelPath: entry.modelPath,
		modelName: entry.modelPath ? path.basename(entry.modelPath) : null,
		running: true,
		isLoaded:
			!!entry.childProcess && ["warming", "ready", "warmup-failed"].includes(entry.contextStatus),
		contextStatus: entry.contextStatus,
		warmupError: entry.warmupError,
		port: entry.port,
		pid: entry.childPid ?? null,
		capabilities: entry.childProcess ? entry.capabilities : null,
		offloadDiagnostics: entry.childProcess ? entry.offloadDiagnostics : null,
		offloadWarning: entry.childProcess ? entry.offloadWarning : null,
		activeModelConfig:
			entry.childProcess && entry.activeModelConfig
				? { ...entry.activeModelConfig, runtimeIdentity: entry.runtimeIdentity }
				: null,
	};
}
function serializeEngines() {
	return [...engines.values()].map(serializeEngine);
}

// The per-model config accessor consumed by the IPC composition root. No
// argument returns the active engine, preserving the single-model lookups that
// remain (sub-agent default, capability probe).
function getEngineConfig(modelPath = null) {
	const entry = getEngine(modelPath);
	if (!entry || !entry.childProcess || ["stopped", "idle_unloaded"].includes(entry.contextStatus))
		return null;
	return {
		port: entry.port,
		contextStatus: entry.contextStatus,
		warmupError: entry.warmupError,
		capabilities: entry.capabilities,
		offloadDiagnostics: entry.offloadDiagnostics,
		offloadWarning: entry.offloadWarning,
		activeModelConfig: entry.activeModelConfig,
		runtimeIdentity: entry.runtimeIdentity,
		modelPath: entry.modelPath,
		modelMetadata: scannedModels.get(entry.modelPath) ?? null,
	};
}

// Port-keyed config lookup for the transport layer (localEngineFetch, the
// context budget) so each in-flight request resolves its own engine.
function getEngineForPort(port) {
	const numeric = Number(port);
	if (!Number.isInteger(numeric)) return null;
	for (const entry of engines.values())
		if (entry.port === numeric && entry.childProcess) return getEngineConfig(entry.modelPath);
	return null;
}

// Single-engine snapshot of the active engine, kept alongside the pool for
// callers/events that predate multi-model support.
function activeEngineSnapshot() {
	const active = getEngine();
	return {
		...getEngineStatus(),
		contextStatus: active?.contextStatus ?? "stopped",
		warmupError: active?.warmupError ?? null,
		capabilities: active?.childProcess ? active.capabilities : null,
		offloadDiagnostics: active?.childProcess ? active.offloadDiagnostics : null,
		offloadWarning: active?.childProcess ? active.offloadWarning : null,
		pid: active?.childPid ?? null,
		port: active?.childProcess ? active.port : null,
		activeModelConfig:
			active?.childProcess && active.activeModelConfig
				? { ...active.activeModelConfig, runtimeIdentity: active.runtimeIdentity }
				: null,
	};
}

function broadcastEngineStatus() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send("terminal:status", {
		running: engines.size > 0,
		engines: serializeEngines(),
		...activeEngineSnapshot(),
	});
}

ipcMain.handle("engine:get-status", () => getEngineStatus());

// Check the configured loopback port, or allocate one in automatic mode.
function getFreePort(requestedPort = null) {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", (error) => {
			if (error.code === "EADDRINUSE" && requestedPort !== null) {
				reject(
					new Error(
						`Port ${requestedPort} is already in use. Please select another port or stop the conflicting service.`,
					),
				);
			} else reject(error);
		});
		srv.listen({ port: requestedPort ?? 0, host: "127.0.0.1" }, () => {
			const port = srv.address().port;
			srv.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

// Stop the entire process tree for shell-based custom launches.
// childProcess.kill() only ever signaled the shell that `spawn(..., {shell:
// true})` creates — the shell's own PID, not llama-server's. Some shells
// don't forward SIGTERM to the child they exec'd, so the shell would exit,
// `close` would fire, the UI would report "not running"... and llama-server
// kept running as an orphan, still holding the model and the port. Unload
// needs to kill the whole tree, not just the shell.
//
// Fix: spawn with `detached: true` (below), which makes the shell the
// leader of its own new process group — its pid doubles as the group id.
// Signaling the *negative* pid delivers the signal to every process in
// that group at once (POSIX). Windows has no such concept, so we fall back
// to `taskkill /T` there, which walks the actual process tree instead.
const {
	createEngineRuntimeState,
	killProcessTree: moduleKillProcessTree,
	killProcessTreeSync,
} = require("./src/main/engineRuntimeState");

// Declared as a function (not a const alias) so the engine-launch test harness
// can substitute it when exercising model replacement.
function killProcessTree(pid, signal = "SIGTERM") {
	return moduleKillProcessTree(pid, signal);
}

function engineStatePath() {
	if (typeof app.getPath !== "function") return null;
	try {
		return path.join(app.getPath("userData"), "engine-runtime.json");
	} catch {
		return null;
	}
}

const engineRuntimeState = createEngineRuntimeState({
	stateFile: engineStatePath(),
	engineBinary: ENGINE_BINARY,
	killTree: killProcessTree,
	killTreeSync: killProcessTreeSync,
});

// Remove complete flag values, including quoted paths, without rewriting other arguments.
function stripFlag(cmd, flag) {
	const value = String.raw`(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s]+)`;
	return cmd.replace(new RegExp(`(^|\\s)--${flag}(?:=|\\s+)${value}(?=\\s|$)`, "g"), "$1").trim();
}

// ---------------------------------------------------------------------------
// Window control IPC
// ---------------------------------------------------------------------------
app.on("browser-window-created", (_event, window) => {
	window.on("close", (event) => {
		if (require("./src/main/dataAccess").isMigrating()) event.preventDefault();
	});
});

ipcMain.on("window:minimize", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) win.minimize();
});

ipcMain.on("window:maximize", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return;
	if (win.isMaximized()) {
		win.unmaximize();
	} else {
		win.maximize();
	}
});

ipcMain.on("window:close", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win && !require("./src/main/dataAccess").isMigrating()) win.close();
});

// ---------------------------------------------------------------------------
// Terminal engine (child process) IPC
// ---------------------------------------------------------------------------
// Persisted descriptor for one engine, used to reap it after a crash.
function runtimeStateEntry(entry) {
	return {
		enginePid: entry.childPid,
		port: entry.port,
		modelPath: entry.modelPath,
		engineCommand: entry.engineCommand,
	};
}
function persistEngines() {
	engineRuntimeState.save([...engines.values()].map(runtimeStateEntry));
}

async function launchProcess(command, model = null, config = null) {
	// Legacy shell launch is not a model loader and has no scoped approval.
	// All supported UI callers select a scanned model and use argv below.
	if (!model) return { success: false, error: 'Custom shell engine launch is disabled. Select a scanned local model.' };
	if (require("./src/main/dataAccess").isMigrating())
		return { success: false, error: "App data is migrating. Please wait." };
	if (launching) return { success: false, error: "Another model is already loading." };
	if (engines.has(model.modelPath))
		return { success: false, error: "This model is already loaded." };
	launching = true;

	const modelPath = model.modelPath;
	let engineCommand = null;
	let entry = null;
	try {
		// Never spawn a replacement engine while an agent turn still depends on
		// a model in the pool. `launching` is already set, so concurrent loads
		// are rejected rather than queued here.
		const lease = await waitForModelSwitchClear();
		if (!lease.ok) {
			return {
				success: false,
				deferred: true,
				reason: "turn-in-progress",
				error: lease.reason === "cancelled"
					? "Model load cancelled."
					: "A model is currently in use by an active agent turn. The load was not started; try again when the turn finishes.",
			};
		}
		const { apiServerPort } = getAppSettings();
		// The configured port belongs to the first engine. A later load falls
		// back to an automatic port so it never collides with an engine that
		// already holds the configured port.
		const portTaken = [...engines.values()].some((existing) => existing.port === apiServerPort);
		const requestedPort = apiServerPort != null && !portTaken ? apiServerPort : null;
		const port = await getFreePort(requestedPort);

		const appliedConfig = normalizeLoadConfig(config);
		const runtimeIdentity = require('node:crypto').randomUUID();
		const args = buildLlamaServerArgs(model, appliedConfig, port);
		engineCommand = resolveEngineCommand();
		const proc = spawn(engineCommand, args, {
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: buildLlamaServerEnv(),
		});
		entry = {
			modelPath,
			model,
			config: appliedConfig,
			port,
			runtimeIdentity,
			engineCommand,
			childProcess: proc,
			childPid: proc.pid,
			contextStatus: "loading",
			warmupError: null,
			capabilities: null,
			offloadDiagnostics: null,
			offloadWarning: null,
			activeModelConfig: null,
			idleService: null,
			lifecycle: null,
			startupHandler: null,
			killTimeout: null,
		};
		engines.set(modelPath, entry);
		activeModelPath = modelPath;
		require('./src/main/promptMeasurement').clearCache();

		let idleUnloaded = false;
		let processIdleService = null;
		const lifecycle = require('./src/main/engineLifecycle').createEngineLifecycle({
			generation: runtimeIdentity,
			modelPath,
			pid: proc.pid,
			activeRequests: () => transportRequestCounts.get(processIdleService) ?? 0,
		});
		entry.lifecycle = lifecycle;
		processIdleService = createIdleService({
			onIdle: () => {
				if (engines.get(modelPath) !== entry || entry.childProcess !== proc) return;
				idleUnloaded = true;
				void stopEngine(modelPath, 'idle-timeout', 'engine-idle-policy', false);
			},
			hasActiveTurnLease: () => lifecycle.hasActiveTurnLease,
		});
		entry.idleService = processIdleService;
		localRequestOwners.set(port, {
			generation: runtimeIdentity,
			get unavailable() { return lifecycle.terminated || lifecycle.stopping; },
			get terminated() { return lifecycle.terminated; },
			beginRequest: () => {
				const release = processIdleService.beginRequest();
				transportRequestCounts.set(processIdleService, (transportRequestCounts.get(processIdleService) ?? 0) + 1);
				return () => { transportRequestCounts.set(processIdleService, transportRequestCounts.get(processIdleService) - 1); release(); };
			},
			record: lifecycle.record,
		});
		lifecycle.record('server-starting', { component: 'model-loader', reason: 'user-load', userAction: true });

		// Record the runtime's real offload state, but only judge it against a
		// managed load. A custom shell command has no known intent, so it is
		// never warned about.
		const reportOffload = (diagnostics) => {
			if (engines.get(modelPath) !== entry || entry.childProcess !== proc) return;
			const evaluation = evaluateOffloadResult({
				diagnostics,
				gpuOffload: appliedConfig?.gpuOffload,
				layerCount: model?.layerCount ?? null,
			});
			// The runtime's own log wins over the preflight estimate.
			entry.offloadDiagnostics = {
				...diagnostics,
				state: evaluation.state,
				requestedLayers: evaluation.requestedLayers,
			};
			entry.offloadWarning = evaluation.warning?.message ?? null;
			broadcastEngineStatus();
		};
		const startup = createStartupHandler({
			port,
			getTools: async () => {
				const mcp = require("./src/main/mcpManager");
				await mcp.init();
				return require("./src/main/promptBuilder").getToolContext(mcp.getTools(null)).tools;
			},
			onDiagnostics: appliedConfig ? reportOffload : undefined,
			onStatus: async (contextStatus, error = null) => {
				if (engines.get(modelPath) !== entry || entry.childProcess !== proc) return;
				if (contextStatus === 'ready' || contextStatus === 'warmup-failed') {
					let capabilities = null;
					try { capabilities = await require('./src/main/modelCapabilities').queryCapabilities(port); }
					catch { /* Older engines leave media support unknown. */ }
					if (engines.get(modelPath) !== entry || entry.childProcess !== proc) return;
					entry.capabilities = capabilities;
				}
				entry.contextStatus = contextStatus;
				entry.warmupError = error;
				if (contextStatus === "ready" || contextStatus === "warmup-failed")
					processIdleService.resetIdleTimer();
				broadcastEngineStatus();
			},
		});
		entry.startupHandler = startup;

		persistEngines();

		proc.stdout.on("data", (data) => {
			const text = data.toString();
			startup.onOutput(text, "stdout");
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("terminal:output", { stream: "stdout", data: text });
			}
		});

		proc.stderr.on("data", (data) => {
			const text = data.toString();
			startup.onOutput(text, "stderr");
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("terminal:output", { stream: "stderr", data: text });
			}
		});

		proc.on("error", (err) => {
			startup.cancel();
			// The renderer shows this in the load dialog, but the launching
			// terminal is where a developer looks first. Without this the main
			// process stayed silent and the failure looked impossible to place.
			lifecycle.record("server-unavailable", { component: "model-loader", reason: "spawn-error" });
			console.error("[engine] failed to spawn", engineCommand ?? "engine binary", err);
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("terminal:output", {
					stream: "stderr",
					data: `\n[spawn error] ${err.message}\n`,
				});
			}
		});

		proc.on("exit", (code, signal) => {
			lifecycle.exited(code, signal);
			startup.cancel();
			processIdleService.dispose();
			if (engines.get(modelPath) !== entry || entry.childProcess !== proc) return;
			entry.contextStatus = "stopped";
			broadcastEngineStatus();
		});
		proc.on("close", (code, signal) => {
			lifecycle.exited(code, signal);
			startup.cancel();
			if (entry.startupHandler === startup) entry.startupHandler = null;
			processIdleService.dispose();
			if (entry.childProcess !== proc) return;
			entry.childProcess = null;
			entry.childPid = null;
			entry.runtimeIdentity = null;
			entry.capabilities = null;
			entry.activeModelConfig = null;
			entry.offloadDiagnostics = null;
			entry.offloadWarning = null;
			entry.contextStatus = idleUnloaded ? "idle_unloaded" : "stopped";
			require('./src/main/promptMeasurement').clearCache();
			localRequestOwners.delete(port);
			engineRuntimeState.clear(proc.pid);
			if (engines.get(modelPath) === entry) {
				engines.delete(modelPath);
				if (activeModelPath === modelPath) activeModelPath = engines.keys().next().value ?? null;
			}
			if (entry.killTimeout) { clearTimeout(entry.killTimeout); entry.killTimeout = null; }
			const msg = `\n[process exited] code=${code} signal=${signal}\n`;
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("terminal:output", { stream: "stdout", data: msg });
				if (idleUnloaded)
					mainWindow.webContents.send("engine:status-changed", { status: "idle_unloaded", modelPath });
				broadcastEngineStatus();
			}
		});

		await new Promise((resolve, reject) => {
			proc.once("spawn", resolve);
			proc.once("error", reject);
		});
		entry.activeModelConfig = appliedConfig ? { ...appliedConfig, runtimeIdentity } : null;
		broadcastEngineStatus();

		return {
			success: true,
			...getEngineStatus(modelPath),
			modelPath,
			pid: entry.childPid,
			port,
			activeModelConfig: entry.activeModelConfig,
		};
	} catch (err) {
		entry?.idleService?.dispose();
		// If the process was already spawned but setup failed afterwards, kill
		// its tree before dropping the reference — otherwise it becomes an
		// orphan holding the model and port with no way to unload from the UI.
		const liveProcess = entry?.childProcess;
		if (liveProcess && typeof liveProcess.pid === "number" && !liveProcess.killed) {
			entry.lifecycle?.requestStop("launch-setup-failed", "model-loader");
			killProcessTree(liveProcess.pid, "SIGKILL");
		}
		if (entry) {
			localRequestOwners.delete(entry.port);
			engineRuntimeState.clear(liveProcess?.pid);
			if (engines.get(modelPath) === entry) {
				engines.delete(modelPath);
				if (activeModelPath === modelPath) activeModelPath = engines.keys().next().value ?? null;
			}
		}
		const spawnFailed =
			engineCommand && typeof err?.syscall === "string" && err.syscall.startsWith("spawn");
		const message = spawnFailed ? describeEngineSpawnError(err, engineCommand) : err.message;
		if (spawnFailed && mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("terminal:output", {
				stream: "stderr",
				data: `\n[engine error] ${message}\n`,
			});
		}
		return { success: false, error: message };
	} finally {
		launching = false;
	}
}
ipcMain.handle("terminal:spawn", () => ({ success: false, error: 'Custom shell engine launch is disabled. Select a scanned local model.' }));

// Advisory preflight before a fresh load: estimate whether full GPU offload
// looks unlikely and, if so, describe it so the UI can ask the user. Returns
// null when the estimate is unavailable or looks fine — never a hard failure.
async function preflightGpuFit({ model, config, safetyMarginMiB = DEFAULT_SAFETY_MARGIN_MIB }) {
	const estimate = estimateOffloadRequirements({
		model,
		config,
		projectorBytes: model.mmprojPath
			? (model.projectorCandidates?.find((candidate) => candidate.path === model.mmprojPath)?.fileIdentity?.size ?? null)
			: null,
	});
	// Only warn when the caller expects full offload and the estimate is
	// complete enough to trust. Low-confidence estimates stay silent. A manual
	// layer count is excluded: the loader will not shed layers on its own, so a
	// tight fit fails loudly instead of degrading quietly (see shouldPreflightOffload).
	if (!shouldPreflightOffload(config)) return null;
	if (!estimate.expectedFullOffload || estimate.confidence === "low" || estimate.totalMiB === null) return null;
	const memory = await queryGpuMemory();
	const fit = assessGpuFit({ estimate, memory, safetyMarginMiB });
	if (fit.status !== "insufficient") return null;
	return { ...fit, message: describeGpuFitWarning(fit) };
}

// Stop one engine and resolve once its process has actually closed. Used when
// replacing an engine for the same model (settings change).
async function stopAndWaitForEngine(modelPath, reason) {
	const entry = engines.get(modelPath);
	if (!entry || !entry.childProcess) return;
	// Never replace an engine that an agent turn still depends on. This closes
	// the race where a new turn starts between the pool-wide wait in
	// launchProcess and the stop below.
	const lease = await waitForTurnLeasesToClear({
		engines: () => [engines.get(modelPath)].filter(Boolean),
		timeoutMs: MODEL_SWITCH_LEASE_WAIT_MS,
		isCancelled: () => appShuttingDown,
	});
	if (!lease.ok) {
		throw new Error(lease.reason === "cancelled"
			? "Model load cancelled."
			: "This model is still in use by an active agent turn. Wait for it to finish and try again.");
	}
	// The engine may have exited on its own while we waited.
	const current = engines.get(modelPath);
	if (!current || !current.childProcess) return;
	const proc = current.childProcess;
	await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			proc.removeListener("close", closed);
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const closed = () => finish();
		const timer = setTimeout(
			() => finish(new Error("Previous local engine did not stop. Try unloading it again.")),
			10000,
		);
		proc.once("close", closed);
		stopEngine(modelPath, reason, "model-loader", true).then(
			(result) => {
				if (result.deferred)
					finish(new Error("This model is still in use by an active agent turn. Wait for it to finish and try again."));
				else if (!result.success && result.error !== "No running process")
					finish(new Error(result.error));
			},
			(error) => finish(error),
		);
	});
}

async function launchModel(modelId, input) {
	if (launching) throw new Error("A local model is already loading.");
	let model = scannedModels.get(modelId);
		if (!model) throw new Error("Scan and select a local model first.");
        if (input.mmprojPath !== undefined) {
            if (input.mmprojPath !== null && !model.projectorCandidates?.some(candidate => candidate.path === input.mmprojPath)) throw new Error('Select a projector from the scanned model directory.');
            model = { ...model, mmprojPath: input.mmprojPath, hasVisionProjector: !!input.mmprojPath };
        }
		for (const [filePath, identity] of [[model.modelPath, model.fileIdentity], [model.mmprojPath, model.projectorCandidates?.find(candidate => candidate.path === model.mmprojPath)?.fileIdentity]]) {
            if (!filePath || !identity) continue;
            const stats = fs.statSync(filePath);
            if (stats.size !== identity.size || stats.mtimeMs !== identity.mtimeMs) throw new Error('Model or projector changed since scanning. Rescan your models.');
        }
        const config = normalizeLoadConfig({ reasoningFormat: model.reasoningFormat ?? "auto", ...input });
		// `rememberSettings` is intentionally tri-state: true saves the settings,
		// false forgets them (an explicit "do not remember" from the load
		// settings dialog), and omitting it leaves any saved preferences
		// untouched. Internal loads such as scheduled tasks must not erase the
		// user's per-model settings just because they did not come from the
		// dialog.
		if (input.rememberSettings !== undefined && typeof input.rememberSettings !== "boolean")
			throw new Error("Invalid remember settings option.");
		if (input.allowPartialOffload !== undefined && typeof input.allowPartialOffload !== "boolean")
			throw new Error("Invalid partial-offload option.");
		if (!fs.existsSync(model.modelPath) || (model.mmprojPath && !fs.existsSync(model.mmprojPath)))
			throw new Error("Model or projector file no longer exists. Rescan your models.");
		// Preflight whenever this model is not already loaded. With a pool of
		// engines, a second model reduces the free VRAM the estimate reads, so
		// the warning correctly reflects "this may spill into system RAM".
		if (!engines.has(modelId) && !input.allowPartialOffload) {
			const assessment = await preflightGpuFit({ model, config });
			if (assessment) return { success: false, requiresConfirmation: true, assessment };
		}
		// Loading a model that is already loaded replaces its engine (settings
		// reload). Wait for the whole pool to be turn-free *before* stopping the
		// old engine, so a failed wait cannot leave the model unloaded.
		if (engines.has(modelId)) {
			const lease = await waitForModelSwitchClear();
			if (!lease.ok) {
				return {
					success: false,
					deferred: true,
					reason: "turn-in-progress",
					error: lease.reason === "cancelled"
						? "Model load cancelled."
						: "A model is currently in use by an active agent turn. The load was not started; try again when the turn finishes.",
				};
			}
			await stopAndWaitForEngine(modelId, "settings-reload");
		}
		const result = await launchProcess(null, model, config);
		if (result.success) {
			try {
				require('./src/main/configManager').saveLastProjector(modelId, model.mmprojPath || null);
				if (input.rememberSettings === true) saveLoadConfig(modelId, config);
				else if (input.rememberSettings === false) forgetLoadConfig(modelId);
			} catch (error) {
				return {
					...result,
					warning: `Engine started, but settings could not be saved: ${error.message}`,
				};
			}
		}
		return result;
}

ipcMain.handle("terminal:getConfig", () => {
	const active = getEngine();
	return {
		port: active?.port ?? null,
		contextStatus: active?.contextStatus ?? "stopped",
		activeModelConfig: active?.activeModelConfig ?? null,
		runtimeIdentity: active?.runtimeIdentity ?? null,
		engines: serializeEngines(),
	};
});

async function stopEngine(modelPath, reason = "user-unload", component = "model-controls", userAction = true) {
	const entry = engines.get(modelPath);
	if (!entry || !entry.childProcess) {
		return { success: false, error: "No running process" };
	}
	// An automatic unload/switch must not tear down a model that an active agent
	// turn still depends on. Keep the idle service alive so the model can be
	// unloaded normally once the turn releases its lease.
	if (entry.lifecycle && !entry.lifecycle.requestStop(reason, component, userAction)) {
		return { success: true, deferred: true, reason: "turn-in-progress" };
	}
	entry.idleService?.dispose();
	entry.startupHandler?.cancel();
	const proc = entry.childProcess;
	const pid = entry.childPid;
	try {
		await killProcessTree(pid, "SIGTERM");
		// llama-server (and some shells) can ignore SIGTERM outright. Give
		// it a grace period to exit on its own — the `close` handler above
		// cancels this timeout when it does — then force-kill the tree.
		if (entry.killTimeout) clearTimeout(entry.killTimeout);
		entry.killTimeout = setTimeout(() => {
			if (engines.get(modelPath) === entry && entry.childProcess === proc) {
				entry.lifecycle?.record("stop-escalated", { component: "model-loader", reason: "shutdown-timeout" });
				killProcessTree(pid, "SIGKILL");
			}
		}, 2000);
		return { success: true };
	} catch (err) {
		return { success: false, error: err.message };
	}
}
ipcMain.handle("terminal:kill", () => stopEngine(activeModelPath));
// Unload one model's engine without touching the others in the pool.
ipcMain.handle("engine:unload", (_event, payload = {}) => {
	const { modelId } = payload ?? {};
	if (typeof modelId !== "string" || !modelId) throw new Error("Invalid model id.");
	return stopEngine(modelId);
});

ipcMain.handle("terminal:status", async () => {
	return {
		running: engines.size > 0,
		engines: serializeEngines(),
		...activeEngineSnapshot(),
	};
});

// ---------------------------------------------------------------------------
// Local model scanning (recursive)
// ---------------------------------------------------------------------------

ipcMain.handle("models:scanLocal", async (_event, scanPath) => {
	try {
		if (!scanPath) {
			return { success: false, error: "No scan path provided", models: [] };
		}
		if (!fs.existsSync(scanPath)) {
			return { success: false, error: `Path does not exist: ${scanPath}`, models: [] };
		}
		const models = await scanDirectoryForModels(scanPath);
		for (const model of models) scannedModels.set(model.id, model);
		return { success: true, models };
	} catch (err) {
		return { success: false, error: err.message, models: [] };
	}
});

// ---------------------------------------------------------------------------
// Active models from local LLM server (bypasses CORS via Node.js fetch)
// ---------------------------------------------------------------------------
ipcMain.handle("get-active-models", async () => {
	const active = getEngine();
	if (!active?.childProcess) return { data: [] };
	try {
		const res = await fetch(`http://127.0.0.1:${active.port}/v1/models`);
		if (!res.ok) return { data: [] };
		const json = await res.json();
		return json;
	} catch {
		return { data: [] };
	}
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const mcpManager = require("./src/main/mcpManager");
if (hasSingleInstanceLock)
	app.whenReady().then(async () => {
	// A previous Electron process may have died without unloading its detached
	// engine. Reap it before this session can start another model.
	await engineRuntimeState.reap();
	try { require('./src/main/gitIdentity').initializeHostGitIdentity(); }
	catch (error) { console.error('Global Git identity could not be read:', error.message); }
	if (process.platform === "win32") app.setAppUserModelId("com.continuum.assistant");
	protocol.handle("media", (request) => serveMediaRequest(request));
	require("./src/main/legacyDataMigration").migrateLegacyUserData();
	registerLocalMediaProtocol(protocol);
	mcpManager.init().catch((error) => console.error("MCP initialization failed:", error));
	const db = initDatabase();
	syncSystemDate(db);
	// The scheduler is created before IPC registration so the composition root
	// can subscribe to its events, but it is started only after the chat turn
	// handler exists. A scheduled run therefore reuses the exact same agent
	// pipeline as an interactive turn.
	scheduledTaskScheduler = require("./src/main/scheduledTasks").createScheduler({
		launchModel,
		getEngineConfig,
		getEngines: () => engines.values(),
		getEngineLifecycle: (modelId) => getEngine(modelId)?.lifecycle ?? null,
		isAppShuttingDown: () => appShuttingDown,
		getScannedModels: () => scannedModels,
		stopEngine,
	});
	// Build the recovery blob reference index in the background. Until it is
	// built the storage panel falls back to a conservative reading of the
	// recovery store; the build itself never blocks the main thread.
	require("./src/main/recoveryReferenceIndex").startBuild();
	registerIpcHandlers({
		launchEngine: launchModel,
		// A request counts against the idle timer of the engine it targets.
		beginEngineRequest: (modelId) => getEngine(modelId)?.idleService?.beginRequest(),
		onIdleTimeoutChanged: () => {
			for (const entry of engines.values())
				if (["ready", "warmup-failed"].includes(entry.contextStatus))
					entry.idleService?.resetIdleTimer();
		},
		getReasoningEfforts: (modelId) =>
			engines.has(modelId) ? (scannedModels.get(modelId)?.reasoningEfforts ?? []) : [],
		getLocalModelMetadata: (modelId) =>
			engines.has(modelId) ? (scannedModels.get(modelId) ?? null) : null,
		getEngineConfig,
		getEngineForPort,
		getEngineLifecycle: (modelId) => getEngine(modelId)?.lifecycle ?? null,
		getScheduledTasks: () => scheduledTaskScheduler,
		isTrustedSender: (event) => {
			if (!mainWindow || mainWindow.isDestroyed()) return false;
			if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame)
				return false;
			const expected = isDev
				? "http://localhost:5173/"
				: pathToFileURL(path.join(__dirname, "dist", "index.html")).href;
			try {
				const actual = new URL(event.senderFrame.url);
				actual.hash = "";
				actual.search = "";
				return actual.href === expected;
			} catch {
				return false;
			}
		},
        generateCompactionSummary: async (request, modelId, generation = {}) => {
            const entry = getEngine(modelId);
            if (!entry?.childProcess) throw new Error('Start the local model before compacting context.');
            const response = await localEngineFetch(`http://127.0.0.1:${entry.port}/v1/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: generation.signal,
                contextWindowLimit: entry.activeModelConfig?.contextLength, body: JSON.stringify({ ...request, stream: false }) });
            if (!response.ok) throw Object.assign(new Error('Summary generation failed'), { code: 'provider-error' });
            return require('./src/main/subagents/providers/streamCompletion').readCompletion(response);
        },
	});
	createWindow();

	// Start only after the renderer and the engine:chat handler exist. The
	// startup tick runs immediately and then repeats every 30 seconds; a
	// resume event forces another tick so sleep is treated exactly like a
	// closed laptop. The scheduler never needs a live window.
	scheduledTaskScheduler.start().catch(error =>
		console.error("Scheduled-task scheduler failed to start:", error));
	powerMonitor.on("suspend", () => {
		try { scheduledTaskScheduler?.handleSuspend?.(); } catch (error) {
			console.error("Scheduled-task suspend handling failed:", error);
		}
	});
	powerMonitor.on("resume", () => {
		try {
			void scheduledTaskScheduler?.handleResume?.().catch(error =>
				console.error("Scheduled-task resume tick failed:", error));
		} catch (error) {
			console.error("Scheduled-task resume handling failed:", error);
		}
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

// Stop every engine in the pool — same tree-kill as Unload, so quitting the
// app never leaves a llama-server running headless.
function stopAllEngines(reason = "app-shutdown") {
	for (const entry of engines.values()) {
		if (!entry.childPid) continue;
		entry.lifecycle?.requestStop(reason, "electron-app");
		killProcessTree(entry.childPid, "SIGTERM");
	}
}

app.on("window-all-closed", () => {
	stopAllEngines();
	if (process.platform !== "darwin") {
		app.quit();
	}
});

let mcpClosed = false;
app.on("before-quit", (event) => {
	appShuttingDown = true;
	if (require("./src/main/dataAccess").isMigrating()) {
		event.preventDefault();
		return;
	}
	for (const entry of engines.values()) entry.idleService?.dispose();
    require("./src/main/promptMeasurement").clearCache();
	if (!mcpClosed) {
		event.preventDefault();
		Promise.allSettled([scheduledTaskScheduler?.stop?.({ reason: 'app-shutdown' }) ?? Promise.resolve(), require("./src/main/mainChatCompaction").shutdownCompression(), require("./src/main/backgroundCommands").shutdown(), require("./src/main/developmentPreviews").service.shutdown(), require("./src/main/networkExecution").service.shutdown(), require("./src/main/foregroundCommand").shutdownForegroundCommands(), mcpManager.close(), require("./src/main/lspManager").manager.close()]).finally(() => {
			mcpClosed = true;
			app.quit();
		});
	}
	stopAllEngines();
});

app.on("will-quit", () => {
	try {
		closeDatabase();
	} catch (error) {
		console.error("Database shutdown failed:", error);
	}
});

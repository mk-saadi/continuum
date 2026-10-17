// Narrow external store for engine (terminal) output.
//
// The engine's stdout/stderr chunks arrive over `terminal:output` at a high
// rate while a model loads and generates. That state used to live in
// AppContent, so every chunk re-rendered the whole shell and every mounted
// chat tab. This store owns the lines instead; components subscribe through
// `useSyncExternalStore` (see useTerminalLog in TerminalLog.jsx), so only the
// terminal-log panel re-renders when output arrives.
//
// Chunks are coalesced on a short timer: a burst of output causes one
// notification per cadence instead of one per chunk. Order is preserved, each
// chunk stays its own entry (a chunk is not assumed to be a complete line,
// matching the previous rendering), and the existing 2,000-line retention is
// kept.

export const TERMINAL_LOG_LIMIT = 2000;
// One render per ~3 frames is imperceptible in a log panel but removes the
// per-chunk render cost during load/generation bursts.
export const TERMINAL_LOG_FLUSH_INTERVAL_MS = 50;

export function createTerminalLogStore({
	source,
	schedule = (callback, delay) => setTimeout(callback, delay),
	cancel = (handle) => clearTimeout(handle),
	interval = TERMINAL_LOG_FLUSH_INTERVAL_MS,
	limit = TERMINAL_LOG_LIMIT,
} = {}) {
	let lines = [];
	let pending = [];
	let flushHandle = null;
	let started = false;
	let stops = [];
	const listeners = new Set();

	// Stable snapshot: a new array is published only when lines actually
	// change, which is what useSyncExternalStore relies on to avoid loops.
	function getSnapshot() {
		return lines;
	}

	function subscribe(listener) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	function notify() {
		for (const listener of [...listeners]) listener();
	}

	function flush() {
		flushHandle = null;
		if (!pending.length) return;
		const next = lines.concat(pending);
		pending = [];
		lines = next.length > limit ? next.slice(-limit) : next;
		notify();
	}

	function scheduleFlush() {
		if (flushHandle === null) flushHandle = schedule(flush, interval);
	}

	function append(entry) {
		if (!entry || typeof entry.data !== "string") return;
		pending.push(entry);
		scheduleFlush();
	}

	function appendError(message) {
		append({ stream: "stderr", data: `[error] ${message}\n` });
	}

	function clear() {
		if (flushHandle !== null) {
			cancel(flushHandle);
			flushHandle = null;
		}
		pending = [];
		if (lines.length) {
			lines = [];
			notify();
		}
	}

	// Idempotent: guards against duplicate event handlers if start() is called
	// again (e.g. a source that returns no unsubscribe).
	function start() {
		if (started || !source) return;
		started = true;
		if (typeof source.onOutput === "function") {
			const stop = source.onOutput(append);
			if (typeof stop === "function") stops.push(stop);
		}
		if (typeof source.onError === "function") {
			const stop = source.onError(appendError);
			if (typeof stop === "function") stops.push(stop);
		}
	}

	// Test/teardown hook. Components only ever unsubscribe their own listener;
	// the source stays attached for the app's lifetime so output collected
	// while the log panel is closed is still shown when it reopens.
	function dispose() {
		if (flushHandle !== null) {
			cancel(flushHandle);
			flushHandle = null;
		}
		pending = [];
		for (const stop of stops) stop();
		stops = [];
		started = false;
		listeners.clear();
	}

	start();

	return { subscribe, getSnapshot, append, flush, clear, start, dispose };
}

// App-wide singleton. It attaches to the preload bridge as soon as the module
// loads, matching the previous lifetime: useTerminalLog was mounted in
// AppContent for the whole session, so logs kept collecting even while the
// settings panel was closed.
//
// The instance is cached on the global so a dev HMR re-evaluation reuses it
// instead of attaching a second source handler (which would duplicate lines).
const SINGLETON_KEY = Symbol.for("continuum.terminalLogStore");
function getAppStore() {
	if (typeof window === "undefined") return createTerminalLogStore();
	if (!window[SINGLETON_KEY]) {
		window[SINGLETON_KEY] = createTerminalLogStore({ source: window.terminalAPI });
	}
	return window[SINGLETON_KEY];
}

export const terminalLogStore = getAppStore();

// Small, bounded store for transcript row UI state that must survive a row
// leaving and re-entering the mounted virtual range (Phase 8).
//
// Virtualization unmounts rows; anything held in their component-local state
// would reset on remount. The only state moved here is the kind a reader
// expects to persist across a scroll: whether a code block, thinking section,
// tool card or workspace stage is expanded. It is keyed by a stable string and
// bounded; it is never a second source of truth for message content.
//
// The whole store is cleared whenever the active session changes, so a key
// that collides across conversations can never leak one chat's UI state into
// another.

const MAX_ENTRIES = 2000;

const values = new Map();
const listeners = new Map();

export function readRowUiState(key, fallback) {
	return values.has(key) ? values.get(key) : fallback;
}

export function writeRowUiState(key, value) {
	if (typeof key !== "string" || !key) return;
	values.set(key, value);
	while (values.size > MAX_ENTRIES) {
		const oldest = values.keys().next().value;
		if (oldest === undefined) break;
		values.delete(oldest);
	}
	const subscribers = listeners.get(key);
	if (subscribers) for (const notify of subscribers) notify();
}

export function subscribeRowUiState(key, listener) {
	let subscribers = listeners.get(key);
	if (!subscribers) {
		subscribers = new Set();
		listeners.set(key, subscribers);
	}
	subscribers.add(listener);
	return () => {
		subscribers.delete(listener);
		if (subscribers.size === 0) listeners.delete(key);
	};
}

// Clear on session switch (and on explicit teardown). Notifies subscribers so
// any still-mounted toggle resets to its default rather than showing another
// conversation's state.
export function clearRowUiState() {
	if (values.size === 0 && listeners.size === 0) return;
	values.clear();
	for (const subscribers of listeners.values()) {
		for (const notify of subscribers) notify();
	}
}

export function rowUiStateSize() {
	return values.size;
}

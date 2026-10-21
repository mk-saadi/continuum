// Pure helpers for the settings modal's lazy tab panels.
//
// The modal used to mount all ten panels at once: every panel fired its own
// IPC round-trips (skill files, recovery blobs, token and spending
// aggregates) and built its DOM before the first frame could be painted, so
// opening the modal stalled the whole app.
//
// A panel is now mounted the first time its tab is opened and stays mounted
// afterwards, so its local form state survives a tab switch. The rules live
// here, free of React, so they are directly testable in plain node
// (tests/settingsPanels.test.mjs).

// The panel shown when the modal opens.
export const DEFAULT_SETTINGS_TAB = "appearance";

// The panel that is mounted from the start: the default tab, so the modal
// never opens to an empty frame.
export const DEFAULT_VISITED = [DEFAULT_SETTINGS_TAB];

// Add a tab to the visited set. The same set is returned when the tab was
// already visited, so React can skip the re-render entirely.
export function markVisited(visited, id) {
	if (!id || visited.has(id)) return visited;
	const next = new Set(visited);
	next.add(id);
	return next;
}

// Whether a panel's content should be mounted.
export function shouldMountPanel(visited, id) {
	return visited.has(id);
}

// Regression tests for the settings modal's lazy tab panels.
//
// The modal used to mount all ten panels at once. Every panel then fired its
// own IPC round-trips (skill files, recovery blobs, token and spending
// aggregates) and built its DOM before the first frame could be painted, so
// opening the modal stalled the app and made scrolling/tab switching heavy.
//
// The rules are pure, so they are tested here without a renderer. The
// Electron UI suite (tests/memorySettings.ui.cjs) still covers the rendered
// behaviour of the modal itself.
//
// Run with: node --test tests/settingsPanels.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SETTINGS_TAB,
	DEFAULT_VISITED,
	markVisited,
	shouldMountPanel,
} from "../src/lib/settingsPanels.mjs";

test("only the default panel is mounted when the modal opens", () => {
	const visited = new Set(DEFAULT_VISITED);
	assert.equal(visited.size, 1, "exactly one panel is mounted up front");
	assert.ok(visited.has(DEFAULT_SETTINGS_TAB), "the default tab is mounted");
});

test("a panel mounts only after its tab has been visited", () => {
	let visited = new Set(DEFAULT_VISITED);
	assert.equal(shouldMountPanel(visited, "appearance"), true);
	assert.equal(shouldMountPanel(visited, "usage-costs"), false);
	assert.equal(shouldMountPanel(visited, "integrations"), false);

	visited = markVisited(visited, "usage-costs");
	assert.equal(shouldMountPanel(visited, "usage-costs"), true);
	assert.equal(shouldMountPanel(visited, "integrations"), false);
});

test("a visited panel stays mounted so its form state survives a tab switch", () => {
	let visited = markVisited(new Set(DEFAULT_VISITED), "storage");
	// Switching away and back must not unmount the panel.
	visited = markVisited(visited, "appearance");
	visited = markVisited(visited, "storage");
	assert.equal(shouldMountPanel(visited, "storage"), true);
});

test("marking an already visited tab returns the same set", () => {
	// React skips the re-render when the state identity is unchanged, so
	// re-selecting the current tab must not produce a new Set.
	const visited = new Set(DEFAULT_VISITED);
	assert.equal(markVisited(visited, DEFAULT_SETTINGS_TAB), visited);
});

test("markVisited does not mutate the set it is given", () => {
	const visited = new Set(DEFAULT_VISITED);
	const next = markVisited(visited, "models");
	assert.equal(visited.has("models"), false, "the previous set is untouched");
	assert.equal(next.has("models"), true);
});

test("markVisited ignores an empty tab id", () => {
	const visited = new Set(DEFAULT_VISITED);
	assert.equal(markVisited(visited, ""), visited);
	assert.equal(markVisited(visited, undefined), visited);
});

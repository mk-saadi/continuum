import test from "node:test";
import assert from "node:assert/strict";
import { resolvePortalTarget, resolveTooltipPosition } from "../src/lib/tooltip.mjs";

const viewport = { width: 1024, height: 768 };
const size = { width: 120, height: 32 };

test("places above the trigger when there is room", () => {
	const rect = { top: 300, bottom: 320, left: 200, right: 260 };
	const pos = resolveTooltipPosition(rect, size, viewport, "top", 8);
	assert.equal(pos.placement, "top");
	assert.equal(pos.top, 300 - 32 - 8);
	assert.equal(pos.left, 230 - 60);
});

test("flips below when there is no headroom", () => {
	const rect = { top: 10, bottom: 30, left: 200, right: 260 };
	const pos = resolveTooltipPosition(rect, size, viewport, "top", 8);
	assert.equal(pos.placement, "bottom");
	assert.equal(pos.top, 30 + 8);
});

test("flips above when bottom has no room", () => {
	const rect = { top: 730, bottom: 750, left: 200, right: 260 };
	const pos = resolveTooltipPosition(rect, size, viewport, "bottom", 8);
	assert.equal(pos.placement, "top");
	assert.equal(pos.top, 730 - 32 - 8);
});

test("clamps horizontally near viewport edges", () => {
	const nearLeft = resolveTooltipPosition(
		{ top: 300, bottom: 320, left: -50, right: 10 },
		size,
		viewport,
		"top",
		8,
	);
	assert.equal(nearLeft.left, 8);

	const nearRight = resolveTooltipPosition(
		{ top: 300, bottom: 320, left: 1000, right: 1060 },
		size,
		viewport,
		"top",
		8,
	);
	assert.equal(nearRight.left, 1024 - 120 - 8);
});

test("supports left and right placements", () => {
	const rect = { top: 300, bottom: 320, left: 400, right: 460 };
	const leftPos = resolveTooltipPosition(rect, size, viewport, "left", 8);
	assert.equal(leftPos.placement, "left");
	assert.equal(leftPos.left, 400 - 120 - 8);

	const rightPos = resolveTooltipPosition(rect, size, viewport, "right", 8);
	assert.equal(rightPos.placement, "right");
	assert.equal(rightPos.left, 460 + 8);
});

test("falls back to top for unknown placements", () => {
	const rect = { top: 300, bottom: 320, left: 200, right: 260 };
	const pos = resolveTooltipPosition(rect, size, viewport, "diagonal", 8);
	assert.equal(pos.placement, "top");
	assert.equal(pos.top, 300 - 32 - 8);
});

test("centers on the cursor when it is over a wide trigger", () => {
	const wide = { width: 1920, height: 1080 };
	const rect = { top: 540, bottom: 575, left: 985, right: 1540 };
	const pos = resolveTooltipPosition(rect, size, wide, "top", 8, 1450);
	assert.equal(pos.placement, "top");
	assert.equal(pos.top, 540 - 32 - 8);
	assert.equal(pos.left, 1450 - 60);
});

test("ignores out-of-range and missing anchors", () => {
	const rect = { top: 300, bottom: 320, left: 200, right: 260 };
	const center = 230 - 60;
	assert.equal(resolveTooltipPosition(rect, size, viewport, "top", 8, null).left, center);
	assert.equal(
		resolveTooltipPosition(rect, size, viewport, "top", 8, 9000).left,
		center,
		"stale cursor outside the trigger falls back to center",
	);
	assert.equal(
		resolveTooltipPosition(rect, size, viewport, "top", 8, Number.NaN).left,
		center,
	);
});

test("cursor-anchored tooltips still clamp into the viewport", () => {
	const rect = { top: 300, bottom: 320, left: 900, right: 1010 };
	const pos = resolveTooltipPosition(rect, size, viewport, "top", 8, 1000);
	assert.equal(pos.left, 1024 - 120 - 8);
});

test("resolvePortalTarget prefers the closest open dialog", () => {
	const dialog = { open: true };
	const doc = { body: { tag: "body" } };
	const trigger = { closest: (selector) => (selector === "dialog" ? dialog : null) };
	assert.equal(resolvePortalTarget(trigger, doc), dialog);
});

test("resolvePortalTarget falls back to body without a dialog ancestor", () => {
	const doc = { body: { tag: "body" } };
	const trigger = { closest: () => null };
	assert.equal(resolvePortalTarget(trigger, doc), doc.body);
	assert.equal(resolvePortalTarget(null, doc), doc.body);
});

test("resolvePortalTarget skips closed dialogs and missing documents", () => {
	const doc = { body: { tag: "body" } };
	const closed = { open: false };
	const trigger = { closest: (selector) => (selector === "dialog" ? closed : null) };
	assert.equal(resolvePortalTarget(trigger, doc), doc.body);
	assert.equal(resolvePortalTarget(trigger, null), null);
});

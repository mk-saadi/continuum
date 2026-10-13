// Portal target for floating UI: the closest ancestor <dialog> when the
// trigger lives inside one, otherwise document.body. A showModal() dialog
// paints in the browser top layer above all normal content, so a tooltip
// portaled to the body would render invisibly behind it; portaling into the
// dialog keeps it in the same top-layer stacking context. A closed dialog is
// never a valid target (its content is display:none).
export function resolvePortalTarget(trigger, doc = typeof document !== "undefined" ? document : null) {
	if (!doc) return null;
	const host = trigger?.closest?.("dialog") ?? null;
	if (host && host.open !== false) return host;
	return doc.body ?? null;
}

// Pure positioning math for the Tooltip component (see
// src/components/Tooltip.jsx). Kept DOM-free so it stays unit-testable.
//
// rect: trigger box { top, bottom, left, right } (viewport coordinates).
// size: measured tooltip box { width, height }.
// viewport: { width, height }.
// anchorX: optional cursor x (viewport coordinates). When it falls inside the
//   trigger, the tooltip centers on the cursor instead of the trigger — wide
//   triggers (full-width rows) would otherwise park the tooltip far from the
//   pointer. Ignored for keyboard focus (null) or when outside the trigger.
// Returns { top, left, placement } with the preferred placement flipped only
// when it does not fit, and both axes clamped into the viewport.
export function resolveTooltipPosition(rect, size, viewport, placement = "top", offset = 8, anchorX = null) {
	const width = Math.max(0, size?.width ?? 0);
	const height = Math.max(0, size?.height ?? 0);
	const vw = Math.max(0, viewport?.width ?? 0);
	const vh = Math.max(0, viewport?.height ?? 0);
	const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

	const top = rect?.top ?? 0;
	const bottom = rect?.bottom ?? 0;
	const left = rect?.left ?? 0;
	const right = rect?.right ?? 0;

	let place = ["top", "bottom", "left", "right"].includes(placement) ? placement : "top";
	const fitsAbove = top >= height + offset + 8;
	const fitsBelow = vh - bottom >= height + offset + 8;
	if (place === "top" && !fitsAbove && fitsBelow) place = "bottom";
	else if (place === "bottom" && !fitsBelow && fitsAbove) place = "top";

	let posTop;
	let posLeft;
	if (place === "left") posLeft = left - width - offset;
	else if (place === "right") posLeft = right + offset;
	else {
		// Center on the cursor when it is over the trigger; otherwise on the
		// trigger itself (keyboard focus, or a stale out-of-range position).
		const centerX = (left + right) / 2;
		const anchor =
			typeof anchorX === "number" && Number.isFinite(anchorX) && anchorX >= left && anchorX <= right
				? anchorX
				: centerX;
		posLeft = anchor - width / 2;
	}

	if (place === "top") posTop = top - height - offset;
	else if (place === "bottom") posTop = bottom + offset;
	else posTop = (top + bottom) / 2 - height / 2;

	return {
		top: clamp(posTop, 8, Math.max(8, vh - height - 8)),
		left: clamp(posLeft, 8, Math.max(8, vw - width - 8)),
		placement: place,
	};
}

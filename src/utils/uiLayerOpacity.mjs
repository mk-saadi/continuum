// Single composited UI-layer opacity for the custom background image.
//
// Architecture: the background image is painted on the <html> element (always
// behind everything, no z-index involved), and the configured opacity is set
// on <body> — the one ancestor of the entire UI, including React portal roots
// and native top-layer dialogs. The completed UI (opaque modal surfaces over
// conversation content included) composites first, then blends once over the
// image. Only background/foreground *colors* are untouched; no element is
// scanned and no per-component styles are rewritten.
//
// Semantics: `opacity` is UI OPACITY (0.4-1). 1 (100%) means fully opaque;
// lower values reveal more of the image. Opacity is applied only while a
// custom image is enabled; at exactly 1 the property is removed so the page
// avoids an unnecessary compositing group.

export const MIN_UI_OPACITY = 40;
export const MAX_UI_OPACITY = 100;

export function clampUiOpacity(value, fallback = MAX_UI_OPACITY) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(MAX_UI_OPACITY, Math.max(MIN_UI_OPACITY, Math.round(parsed)));
}

export function uiOpacityFactor(opacity) {
	return clampUiOpacity(opacity) / 100;
}

function rootOf(doc) {
	return doc?.documentElement ?? null;
}

function bodyOf(doc) {
	return doc?.body ?? null;
}

// Applies the image + layer opacity. Image stays at full brightness: it lives
// on <html>, outside the <body> opacity group. The same factor is exposed as
// --bg-ui-opacity for top-layer <dialog> elements (see index.css): native
// modals paint in the top layer, outside the body's opacity grouping, so they
// need their own reference to the identical factor. Each overlay still gets
// exactly one factor (body-level portals are inside the body group and never
// match the dialog rule).
export function applyUiLayer(doc, { imageUrl, opacity }) {
	const root = rootOf(doc);
	const body = bodyOf(doc);
	if (!root || !body) return false;
	if (!imageUrl) {
		clearUiLayer(doc);
		return false;
	}
	try {
		root.style.setProperty("background-image", `url("${imageUrl}")`);
		root.style.setProperty("background-size", "cover");
		root.style.setProperty("background-position", "center");
		root.style.setProperty("background-repeat", "no-repeat");
	} catch {
		return false;
	}
	const factor = uiOpacityFactor(opacity);
	try {
		root.style.setProperty("--bg-ui-opacity", String(factor));
		if (factor >= 1) body.style.removeProperty("opacity");
		else body.style.setProperty("opacity", String(factor));
	} catch {
		/* Image is set; opacity is best-effort. */
	}
	return true;
}

// Restores the normal fully opaque UI with no leftover inline styles.
export function clearUiLayer(doc) {
	const root = rootOf(doc);
	const body = bodyOf(doc);
	try {
		root?.style.removeProperty("background-image");
		root?.style.removeProperty("background-size");
		root?.style.removeProperty("background-position");
		root?.style.removeProperty("background-repeat");
		root?.style.removeProperty("--bg-ui-opacity");
		body?.style.removeProperty("opacity");
	} catch {
		/* Best-effort restoration. */
	}
}

export function readUiLayer(doc) {
	const root = rootOf(doc);
	const body = bodyOf(doc);
	let imageUrl = "";
	let opacity = "";
	try {
		imageUrl = root?.style.getPropertyValue("background-image") || "";
		opacity = body?.style.getPropertyValue("opacity") || "";
	} catch {
		/* Unavailable (tests with partial stubs). */
	}
	return { imageUrl, opacity };
}

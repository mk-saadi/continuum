import { useCallback, useEffect, useRef, useState } from "react";
import { mediaSource } from "../lib/markdownMedia.mjs";
import { applyUiLayer, applyUiOpacity, clearUiLayer } from "../utils/uiLayerOpacity.mjs";

export const BACKGROUND_CHANGED_EVENT = "background-changed";
// Opacity-only event: a live slider change updates the visual factor without
// re-identifying, re-probing, or re-processing the unchanged background.
export const BACKGROUND_OPACITY_EVENT = "background-opacity-changed";
// Must match src/main/backgroundSettings.js (duplicated to avoid importing
// main-process modules into the renderer bundle).
export const MIN_BACKGROUND_OPACITY = 40;
export const MAX_BACKGROUND_OPACITY = 100;
export const DEFAULT_BACKGROUND_OPACITY = 85;

function clampOpacity(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_BACKGROUND_OPACITY;
	return Math.min(MAX_BACKGROUND_OPACITY, Math.max(MIN_BACKGROUND_OPACITY, Math.round(parsed)));
}

// Single composited UI layer: the image lives on <html> (outside the opacity
// group, always at full brightness) and the configured UI opacity goes on
// <body>, the ancestor of the whole UI including portal roots and dialogs.
// Removing the image clears everything back to the normal opaque UI.
//
// `animated` marks an asset that keeps decoding frames. It is exposed to CSS so
// per-frame compositor effects that would otherwise re-run for every GIF frame
// can be gated off (see the dialog::backdrop rule in index.css).
function applyBackgroundState(imageUrl, opacity, animated = false) {
	const root = document.documentElement;
	try {
		if (imageUrl) {
			root.setAttribute("data-bg-image", "true");
			if (animated) root.setAttribute("data-bg-animated", "true");
			else root.removeAttribute("data-bg-animated");
			applyUiLayer(document, { imageUrl, opacity });
		} else {
			root.removeAttribute("data-bg-image");
			root.removeAttribute("data-bg-animated");
			clearUiLayer(document);
		}
	} catch {
		/* Translucency is decorative; the app still renders. */
	}
}

// Verifies the managed file still loads before exposing it. A missing or
// invalid file clears the layer and keeps the UI solid.
function verifyImageUrl(url) {
	if (!url) return Promise.resolve("");
	return new Promise((resolve) => {
		const probe = new Image();
		probe.onload = () => resolve(url);
		probe.onerror = () => resolve("");
		probe.src = url;
	});
}

// Shape returned by the main process. `imagePath` is the user's stored
// original, `renderPath` the (possibly bounded) asset to paint, and
// `previewPath` a small static frame for the Settings thumbnail.
function normalizeSaved(saved) {
	return {
		imagePath: saved?.imagePath ?? null,
		renderPath: saved?.renderPath ?? null,
		previewPath: saved?.previewPath ?? null,
		opacity: clampOpacity(saved?.opacity),
		animated: Boolean(saved?.animated),
	};
}

// The URL actually painted: the bounded derivative when one exists, otherwise
// the original.
function renderSourceOf(settings) {
	return settings.renderPath || settings.imagePath || "";
}

export default function useBackgroundSettings() {
	const [settings, setSettings] = useState({
		imagePath: null,
		renderPath: null,
		previewPath: null,
		opacity: DEFAULT_BACKGROUND_OPACITY,
		animated: false,
	});
	const [imageUrl, setImageUrl] = useState("");
	const [error, setError] = useState("");
	// The last verified URL, so an opacity-only update can reapply the factor
	// without reloading the image.
	const imageUrlRef = useRef("");
	// Monotonic token: a slower resolve must not overwrite a newer selection.
	const requestRef = useRef(0);

	const applySaved = useCallback(async (saved) => {
		const token = (requestRef.current += 1);
		const next = normalizeSaved(saved);
		const source = renderSourceOf(next);
		const verified = source ? await verifyImageUrl(mediaSource(source)) : "";
		if (token !== requestRef.current) return next; // superseded by a newer resolve
		setSettings(next);
		if (!verified) {
			applyBackgroundState("", next.opacity);
			imageUrlRef.current = "";
			setImageUrl("");
			return next;
		}
		applyBackgroundState(verified, next.opacity, next.animated);
		imageUrlRef.current = verified;
		setImageUrl(verified);
		return next;
	}, []);

	const refresh = useCallback(async () => {
		if (!window.api?.getBackgroundSettings) return null;
		try {
			const saved = await window.api.getBackgroundSettings();
			const next = await applySaved(saved);
			setError("");
			return next;
		} catch (cause) {
			setError(cause.message);
			return null;
		}
	}, [applySaved]);

	useEffect(() => {
		let active = true;
		window.api
			?.getBackgroundSettings?.()
			.then((saved) => {
				if (active) void applySaved(saved);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		const onChanged = () => {
			if (active) refresh();
		};
		const onOpacity = (event) => {
			if (!active) return;
			const opacity = clampOpacity(event?.detail?.opacity);
			setSettings((current) => ({ ...current, opacity }));
			if (imageUrlRef.current) applyUiOpacity(document, opacity);
		};
		window.addEventListener(BACKGROUND_CHANGED_EVENT, onChanged);
		window.addEventListener(BACKGROUND_OPACITY_EVENT, onOpacity);
		return () => {
			active = false;
			window.removeEventListener(BACKGROUND_CHANGED_EVENT, onChanged);
			window.removeEventListener(BACKGROUND_OPACITY_EVENT, onOpacity);
		};
	}, [refresh, applySaved]);

	return { settings, imageUrl, error, refresh };
}

export function notifyBackgroundChanged() {
	window.dispatchEvent(new CustomEvent(BACKGROUND_CHANGED_EVENT));
}

export function notifyBackgroundOpacityChanged(opacity) {
	window.dispatchEvent(new CustomEvent(BACKGROUND_OPACITY_EVENT, { detail: { opacity } }));
}

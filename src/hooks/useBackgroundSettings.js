import { useCallback, useEffect, useState } from "react";
import { mediaSource } from "../lib/markdownMedia.mjs";
import { applyUiLayer, clearUiLayer } from "../utils/uiLayerOpacity.mjs";

export const BACKGROUND_CHANGED_EVENT = "background-changed";
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
function applyBackgroundState(imageUrl, opacity) {
	const root = document.documentElement;
	try {
		if (imageUrl) {
			root.setAttribute("data-bg-image", "true");
			applyUiLayer(document, { imageUrl, opacity });
		} else {
			root.removeAttribute("data-bg-image");
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

async function resolveBackground(next, setImageUrl) {
	const candidate = next.imagePath ? mediaSource(next.imagePath) : "";
	if (!candidate) {
		applyBackgroundState("", next.opacity);
		setImageUrl("");
		return;
	}
	const verified = await verifyImageUrl(candidate);
	applyBackgroundState(verified, next.opacity);
	setImageUrl(verified);
}

export default function useBackgroundSettings() {
	const [settings, setSettings] = useState({ imagePath: null, opacity: DEFAULT_BACKGROUND_OPACITY });
	const [imageUrl, setImageUrl] = useState("");
	const [error, setError] = useState("");

	const refresh = useCallback(async () => {
		if (!window.api?.getBackgroundSettings) return null;
		try {
			const saved = await window.api.getBackgroundSettings();
			const next = {
				imagePath: saved?.imagePath ?? null,
				opacity: clampOpacity(saved?.opacity),
			};
			setSettings(next);
			await resolveBackground(next, setImageUrl);
			setError("");
			return next;
		} catch (cause) {
			setError(cause.message);
			return null;
		}
	}, []);

	useEffect(() => {
		let active = true;
		window.api
			?.getBackgroundSettings?.()
			.then((saved) => {
				if (!active) return;
				const next = {
					imagePath: saved?.imagePath ?? null,
					opacity: clampOpacity(saved?.opacity),
				};
				setSettings(next);
				void resolveBackground(next, (url) => {
					if (active) setImageUrl(url);
				});
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		const onChanged = () => {
			if (active) refresh();
		};
		window.addEventListener(BACKGROUND_CHANGED_EVENT, onChanged);
		return () => {
			active = false;
			window.removeEventListener(BACKGROUND_CHANGED_EVENT, onChanged);
		};
	}, [refresh]);

	return { settings, imageUrl, error, refresh };
}

export function notifyBackgroundChanged() {
	window.dispatchEvent(new CustomEvent(BACKGROUND_CHANGED_EVENT));
}

import React, { useEffect, useState } from "react";
import { SliderField } from "../FormControls";
import {
	DEFAULT_BACKGROUND_OPACITY,
	MAX_BACKGROUND_OPACITY,
	MIN_BACKGROUND_OPACITY,
	notifyBackgroundChanged,
} from "../../hooks/useBackgroundSettings";
import { mediaSource } from "../../lib/markdownMedia.mjs";

// Custom static background image + surface opacity. Self-contained like
// GeneralSettingsTab: loads/saves through window.api and notifies the App
// shell (which owns the background layer) via a window event.
export default function BackgroundSettings() {
	const [settings, setSettings] = useState({
		imagePath: null,
		opacity: DEFAULT_BACKGROUND_OPACITY,
	});
	const [previewUrl, setPreviewUrl] = useState("");
	const [previewBroken, setPreviewBroken] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			?.getBackgroundSettings?.()
			.then((saved) => {
				if (!active || !saved) return;
				setSettings({
					imagePath: saved.imagePath ?? null,
					opacity: saved.opacity ?? DEFAULT_BACKGROUND_OPACITY,
				});
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		setPreviewBroken(false);
		setPreviewUrl(settings.imagePath ? mediaSource(settings.imagePath) : "");
	}, [settings.imagePath]);

	async function run(action) {
		if (busy || !window.api?.getBackgroundSettings) return;
		setBusy(true);
		setError("");
		try {
			const saved = await action();
			// Cancelled picker resolves null: keep the previous image.
			if (saved) {
				setSettings({
					imagePath: saved.imagePath ?? null,
					opacity: saved.opacity ?? DEFAULT_BACKGROUND_OPACITY,
				});
				notifyBackgroundChanged();
			}
		} catch (cause) {
			setError(cause.message || "Could not update the background image.");
		} finally {
			setBusy(false);
		}
	}

	async function changeOpacity(value) {
		const opacity = Math.min(
			MAX_BACKGROUND_OPACITY,
			Math.max(MIN_BACKGROUND_OPACITY, Math.round(Number(value))),
		);
		if (!Number.isFinite(opacity) || busy) return;
		setSettings((current) => ({ ...current, opacity }));
		setBusy(true);
		setError("");
		try {
			const saved = await window.api.setBackgroundOpacity(opacity);
			setSettings({
				imagePath: saved.imagePath ?? null,
				opacity: saved.opacity ?? opacity,
			});
			notifyBackgroundChanged();
		} catch (cause) {
			setError(cause.message || "Could not save surface opacity.");
		} finally {
			setBusy(false);
		}
	}

	const hasImage = Boolean(previewUrl) && !previewBroken;

	return (
		<section
			className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
			aria-labelledby="background-image-title"
		>
			<h4
				id="background-image-title"
				className="font-semibold"
			>
				Background image
			</h4>
			<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
				Personalize the app with a static image behind the interface. Surfaces stay readable:
				only background colors turn translucent, never text or icons.
			</p>
			{hasImage ? (
				<div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
					<img
						src={previewUrl}
						alt="Background preview"
						className="h-32 w-full object-cover"
						onError={() => setPreviewBroken(true)}
					/>
				</div>
			) : (
				settings.imagePath && (
					<p
						role="status"
						className="mt-3 rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]"
					>
						The saved image file is missing or unreadable. Choose a new one below; the
						interface stays solid until then.
					</p>
				)
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					disabled={busy || !window.api?.pickBackgroundImage}
					onClick={() => run(() => window.api.pickBackgroundImage())}
					className="cursor-pointer rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy ? "Working…" : settings.imagePath ? "Replace image…" : "Choose image…"}
				</button>
				{settings.imagePath && (
					<button
						type="button"
						disabled={busy}
						onClick={() => run(() => window.api.removeBackgroundImage())}
						className="cursor-pointer rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						Remove image
					</button>
				)}
			</div>
			<div className="mt-4">
				<SliderField
					label="Surface opacity"
					valueLabel={`${settings.opacity}% solid`}
					hint={`How solid interface surfaces appear over the image (${MIN_BACKGROUND_OPACITY}–${MAX_BACKGROUND_OPACITY}% opacity; transparency is ${100 - settings.opacity}%). Lower values show more of the image but reduce contrast. Applies only while an image is set.`}
					min={MIN_BACKGROUND_OPACITY}
					max={MAX_BACKGROUND_OPACITY}
					step={1}
					value={settings.opacity}
					disabled={busy}
					onChange={(event) => changeOpacity(event.target.value)}
				/>
			</div>
			{error && (
				<p
					role="alert"
					className="mt-3 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
			{!window.api?.pickBackgroundImage && (
				<p className="mt-3 rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
					Background images are available in the desktop app.
				</p>
			)}
		</section>
	);
}

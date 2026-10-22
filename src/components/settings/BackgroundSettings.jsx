import React, { useEffect, useState } from "react";
import { LuImage } from "react-icons/lu";
import { SliderField } from "../FormControls";
import {
	DEFAULT_BACKGROUND_OPACITY,
	MAX_BACKGROUND_OPACITY,
	MIN_BACKGROUND_OPACITY,
	notifyBackgroundChanged,
	notifyBackgroundOpacityChanged,
} from "../../hooks/useBackgroundSettings";
import { mediaSource } from "../../lib/markdownMedia.mjs";
import {
	SettingsButton,
	SettingsCard,
	SettingsHint,
	SettingsMessage,
} from "./SettingsSection";

// Custom static background image + surface opacity. Self-contained like
// GeneralSettingsTab: loads/saves through window.api and notifies the App
// shell (which owns the background layer) via a window event.
export default function BackgroundSettings() {
	const [settings, setSettings] = useState({
		imagePath: null,
		previewPath: null,
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
					previewPath: saved.previewPath ?? null,
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
		// Prefer the static poster frame so an animated background never runs a
		// second full-resolution animation inside the thumbnail.
		const source = settings.previewPath || settings.imagePath;
		setPreviewUrl(source ? mediaSource(source) : "");
	}, [settings.imagePath, settings.previewPath]);

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
					previewPath: saved.previewPath ?? null,
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
				previewPath: saved.previewPath ?? null,
				opacity: saved.opacity ?? opacity,
			});
			// Visual-only update: never re-probe or re-process the image.
			notifyBackgroundOpacityChanged(saved.opacity ?? opacity);
		} catch (cause) {
			setError(cause.message || "Could not save surface opacity.");
		} finally {
			setBusy(false);
		}
	}

	const hasImage = Boolean(previewUrl) && !previewBroken;

	return (
		<SettingsCard
			icon={LuImage}
			title="Background image"
			description="Personalize the app with a static image behind the interface. Surfaces stay readable: only background colors turn translucent, never text or icons."
		>
			{hasImage ? (
				<div className="overflow-hidden rounded-lg border border-[var(--border)]">
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
						className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]"
					>
						The saved image file is missing or unreadable. Choose a new one below; the
						interface stays solid until then.
					</p>
				)
			)}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<SettingsButton
					variant="primary"
					disabled={busy || !window.api?.pickBackgroundImage}
					onClick={() => run(() => window.api.pickBackgroundImage())}
				>
					{busy ? "Working…" : settings.imagePath ? "Replace image…" : "Choose image…"}
				</SettingsButton>
				{settings.imagePath && (
					<SettingsButton
						disabled={busy}
						onClick={() => run(() => window.api.removeBackgroundImage())}
					>
						Remove image
					</SettingsButton>
				)}
			</div>
			<div className="mt-3 border-t border-[var(--border)] pt-3">
				<SliderField
					label="Surface opacity"
					valueLabel={`${settings.opacity}% solid`}
					hint={`How solid interface surfaces appear over the image (${MIN_BACKGROUND_OPACITY}–${MAX_BACKGROUND_OPACITY}% opacity; transparency is ${100 - settings.opacity}%). Lower values show more of the image but reduce contrast. Applies only while an image is set.`}
					min={MIN_BACKGROUND_OPACITY}
					max={MAX_BACKGROUND_OPACITY}
					step={1}
					value={settings.opacity}
					disabled={busy}
					onChange={(event) =>
						setSettings((current) => ({ ...current, opacity: Number(event.target.value) }))
					}
					onCommit={(event) => changeOpacity(event.target.value)}
				/>
			</div>
			<SettingsMessage>{error}</SettingsMessage>
			{!window.api?.pickBackgroundImage && (
				<SettingsHint>Background images are available in the desktop app.</SettingsHint>
			)}
		</SettingsCard>
	);
}

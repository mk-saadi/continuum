import React, { useId, useState } from "react";
import { optimizeImage } from "../utils/imageUtils.mjs";

export default function AvatarSettings({ avatars, models }) {
	const { settings, update } = avatars;
	const [busyId, setBusyId] = useState(null); // null | "global" | model.id
	const [error, setError] = useState("");
	const buttonClass = "rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-40";

	function change(patch) {
		try {
			update(patch);
			setError("");
		} catch {
			setError("Could not save avatar preferences. Local storage may be full or unavailable.");
		}
	}

	async function upload(event, targetModelId = null) {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file || busyId) return;

		if (file.size > 20 * 1024 * 1024) {
			setError("Choose an image smaller than 20 MB.");
			return;
		}
		setBusyId(targetModelId ?? "global");
		setError("");
		try {
			const url = await optimizeImage(file, 128, 128);
			change(
				targetModelId
					? (previous) => ({ modelAvatars: { ...previous.modelAvatars, [targetModelId]: url } })
					: { globalAvatarUrl: url },
			);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusyId(null);
		}
	}

	function removeModelAvatar(targetModelId) {
		change((previous) => {
			const modelAvatars = { ...previous.modelAvatars };
			delete modelAvatars[targetModelId];
			return { modelAvatars };
		});
	}

	return (
		<div className="space-y-4">
			<h3 className="font-semibold">Avatars &amp; Branding</h3>
			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					role="switch"
					checked={settings.showAvatars}
					onChange={(event) => change({ showAvatars: event.target.checked })}
				/>{" "}
				Enable Avatars
			</label>

			<div className="space-y-2">
				<label className="block">
					Global LLM Avatar
					<input
						type="file"
						accept=".png,.jpg,.jpeg"
						disabled={busyId !== null}
						onChange={(event) => upload(event)}
						className="mt-2 block w-full file:mr-2 file:rounded file:border file:border-[var(--border)] file:bg-transparent file:p-2 file:text-inherit"
					/>
				</label>
				{settings.globalAvatarUrl && (
					<div className="flex items-center gap-2">
						<img
							src={settings.globalAvatarUrl}
							alt="Global avatar preview"
							className="size-12 rounded-lg object-cover"
						/>
						<button
							type="button"
							className={buttonClass}
							disabled={busyId !== null}
							onClick={() => change({ globalAvatarUrl: null })}
						>
							Remove global avatar
						</button>
					</div>
				)}
			</div>

			<div className="space-y-2">
				<p className="font-medium">Per-model avatars</p>
				<p className="text-xs text-[var(--text-muted)]">
					Set a custom avatar for any individual model. Falls back to the global avatar when unset.
				</p>
				{!models.length ? (
					<p className="text-sm text-[var(--text-muted)]">No scanned models available.</p>
				) : (
					<ul className="max-h-96 space-y-1 overflow-y-auto rounded border border-[var(--border)] p-1">
						{models.map((model) => (
							<ModelAvatarRow
								key={model.id}
								model={model}
								avatarUrl={
									Object.hasOwn(settings.modelAvatars, model.id)
										? settings.modelAvatars[model.id]
										: null
								}
								busy={busyId === model.id}
								disabled={busyId !== null && busyId !== model.id}
								onUpload={(event) => upload(event, model.id)}
								onRemove={() => removeModelAvatar(model.id)}
								buttonClass={buttonClass}
							/>
						))}
					</ul>
				)}
			</div>

			{busyId && <p role="status">Preparing avatar…</p>}
			{error && (
				<p
					role="alert"
					className="palace-error"
				>
					{error}
				</p>
			)}
		</div>
	);
}

function ModelAvatarRow({ model, avatarUrl, busy, disabled, onUpload, onRemove, buttonClass }) {
	const inputId = useId();
	return (
		<li className="flex items-center gap-3 rounded-lg p-2 hover:bg-[var(--surface-hover)]">
			{avatarUrl ? (
				<img
					src={avatarUrl}
					alt={`${model.name || model.id} avatar preview`}
					className="size-10 shrink-0 rounded-lg object-cover"
				/>
			) : (
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[10px] text-[var(--text-muted)]">
					None
				</div>
			)}
			<span
				className="min-w-0 flex-1 truncate text-sm"
				title={model.name || model.id}
			>
				{model.name || model.id}
			</span>
			<input
				id={inputId}
				type="file"
				accept=".png,.jpg,.jpeg"
				disabled={disabled || busy}
				onChange={onUpload}
				className="sr-only"
			/>
			<label
				htmlFor={inputId}
				className={`${buttonClass} cursor-pointer ${disabled || busy ? "pointer-events-none opacity-40" : ""}`}
			>
				{busy ? "Uploading…" : avatarUrl ? "Change" : "Upload"}
			</label>
			{avatarUrl && (
				<button
					type="button"
					className={buttonClass}
					disabled={disabled}
					onClick={onRemove}
				>
					Remove
				</button>
			)}
		</li>
	);
}

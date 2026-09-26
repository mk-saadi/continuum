import React, { useId, useState } from "react";
import ModelProfileSettings from "./ModelProfileSettings";
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
			setError("Could not save branding preferences. Local storage may be full or unavailable.");
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

            <section className="space-y-3 rounded-lg border border-[var(--border)] p-3" aria-labelledby="global-llm-branding">
                <h4 id="global-llm-branding" className="font-medium">Global LLM Branding</h4>
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
                <label className="block" htmlFor="global-llm-name">Global LLM Name</label>
                <input id="global-llm-name" type="text" value={settings.globalModelName ?? ''}
                    onChange={event => change({ globalModelName: event.target.value })}
                    placeholder="e.g., Assistant" maxLength={200}
                    className="block w-full rounded border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm" />
                <p className="text-xs text-[var(--text-muted)]">Used when a model has no custom name. Existing replies keep their saved names.</p>
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
                <ModelProfileSettings />
			</section>

			<div className="space-y-2">
				<p className="font-medium">Per-model names and avatars</p>
				<p className="text-xs text-[var(--text-muted)]">
					Set a name and avatar for each model. Blank names use the global name, then the model filename.
				</p>
				{!models.length ? (
					<p className="text-sm text-[var(--text-muted)]">No scanned models available.</p>
				) : (
					<ul className="max-h-96 space-y-1 overflow-y-auto rounded border border-[var(--border)] p-1">
						{models.map((model) => (
							<ModelAvatarRow
								key={model.id}
								model={model}
                                displayName={settings.perModelNames?.[model.modelPath || model.path || model.id] || ''}
                                onNameChange={name => change(previous => ({ perModelNames: {
                                    ...previous.perModelNames, [model.modelPath || model.path || model.id]: name,
                                } }))}
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

function ModelAvatarRow({ model, displayName, onNameChange, avatarUrl, busy, disabled, onUpload, onRemove, buttonClass }) {
	const inputId = useId();
	return (
		<li className="flex flex-wrap items-center gap-3 rounded-lg p-2 hover:bg-[var(--surface-hover)]">
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
			<div className="min-w-0 flex-1">
            <span
				className="block truncate text-sm"
				title={model.name || model.id}
			>
				{model.name || model.id}
            </span>
            <input type="text" aria-label={`Display name for ${model.name || model.id}`}
                value={displayName} onChange={event => onNameChange(event.target.value)}
                placeholder="Use global name or model filename" maxLength={200}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-sm" />
            </div>
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
            <ModelProfileSettings modelPath={model.modelPath || model.path || model.id} />
		</li>
	);
}

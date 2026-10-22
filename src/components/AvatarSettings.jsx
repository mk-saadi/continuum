import React, { useId, useState } from "react";
import { LuImages, LuUserRound } from "react-icons/lu";
import { TextField } from "./FormControls";
import { optimizeImage } from "../utils/imageUtils.mjs";
import {
	SettingsButton,
	SettingsCard,
	SettingsCheckRow,
	SettingsEmpty,
	SettingsMessage,
	settingsLabel,
} from "./settings/SettingsSection";

const fileButtonClass =
	"inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

export default function AvatarSettings({ avatars, models }) {
	const { settings, update } = avatars;
	const [busyId, setBusyId] = useState(null); // null | "global" | model.id
	const [error, setError] = useState("");

	async function change(patch) {
		try {
			await update(patch);
			setError("");
		} catch (err) {
			setError(err.message || "Could not save branding preferences.");
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
			await change(
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
		<div className="space-y-3">
			<SettingsCard
				icon={LuUserRound}
				title="Avatars & branding"
				description="Choose the identity shown next to assistant replies."
			>
				<SettingsCheckRow
					role="switch"
					label="Enable avatars"
					checked={settings.showAvatars}
					onChange={(event) => change({ showAvatars: event.target.checked })}
				/>
				<SettingsMessage>{avatars.error}</SettingsMessage>
				<div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
					<div>
						<span className={settingsLabel}>Global LLM Avatar</span>
						<input
							type="file"
							accept=".png,.jpg,.jpeg"
							disabled={busyId !== null}
							onChange={(event) => upload(event)}
							className="block w-full cursor-pointer text-[11px] text-[var(--text-secondary)] file:mr-2 file:cursor-pointer file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--bg-secondary)] file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-[var(--text-primary)] hover:file:bg-[var(--surface-hover)]"
						/>
					</div>
					<TextField
						id="global-llm-name"
						label="Global LLM Name"
						value={settings.globalModelName ?? ""}
						onChange={(event) => change({ globalModelName: event.target.value })}
						placeholder="e.g., Assistant"
						maxLength={200}
						hint="Used when a model has no custom name. Existing replies keep their saved names."
					/>
					{settings.globalAvatarUrl && (
						<div className="flex items-center gap-3">
							<img
								src={settings.globalAvatarUrl}
								alt="Global avatar preview"
								className="size-12 rounded-lg object-cover"
							/>
							<SettingsButton
								disabled={busyId !== null}
								onClick={() => change({ globalAvatarUrl: null })}
							>
								Remove global avatar
							</SettingsButton>
						</div>
					)}
				</div>
			</SettingsCard>

			<SettingsCard
				icon={LuImages}
				title="Per-model names and avatars"
				description="Set a name and avatar for each model. Blank names use the global name, then the model filename."
			>
				{!models.length ? (
					<SettingsEmpty>No scanned models available.</SettingsEmpty>
				) : (
					<ul className="divide-y divide-[var(--border)]">
						{models.map((model) => (
							<ModelAvatarRow
								key={model.id}
								model={model}
								displayName={
									settings.perModelNames?.[model.modelPath || model.path || model.id] || ""
								}
								onNameChange={(name) =>
									change((previous) => ({
										perModelNames: {
											...previous.perModelNames,
											[model.modelPath || model.path || model.id]: name,
										},
									}))
								}
								avatarUrl={
									Object.hasOwn(settings.modelAvatars, model.id)
										? settings.modelAvatars[model.id]
										: null
								}
								busy={busyId === model.id}
								disabled={busyId !== null && busyId !== model.id}
								onUpload={(event) => upload(event, model.id)}
								onRemove={() => removeModelAvatar(model.id)}
							/>
						))}
					</ul>
				)}
			</SettingsCard>

			<SettingsMessage tone="info">{busyId ? "Preparing avatar…" : ""}</SettingsMessage>
			<SettingsMessage>{error}</SettingsMessage>
		</div>
	);
}

function ModelAvatarRow({ model, displayName, onNameChange, avatarUrl, busy, disabled, onUpload, onRemove }) {
	const inputId = useId();
	return (
		<li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
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
					className="block truncate text-xs font-medium"
					title={model.name || model.id}
				>
					{model.name || model.id}
				</span>
				<TextField
					type="text"
					aria-label={`Display name for ${model.name || model.id}`}
					value={displayName}
					onChange={(event) => onNameChange(event.target.value)}
					placeholder="Use global name or model filename"
					maxLength={200}
					className="mt-1"
				/>
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
				className={`${fileButtonClass} ${disabled || busy ? "pointer-events-none opacity-40" : ""}`}
			>
				{busy ? "Uploading…" : avatarUrl ? "Change" : "Upload"}
			</label>
			{avatarUrl && (
				<SettingsButton
					disabled={disabled}
					onClick={onRemove}
				>
					Remove
				</SettingsButton>
			)}
		</li>
	);
}

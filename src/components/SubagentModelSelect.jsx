import React, { useEffect, useState } from "react";
import { SelectField } from "./FormControls";

// Shared sub-agent model field used by Settings → General and the Workspace
// sidebar Agents tab. Same data (window.api.getSubagentModel,
// getCloudProviders) and same behavior/encoding in both places: '' = follow
// the chat model, 'local' = the local model server, otherwise a saved cloud
// provider id. This is a GLOBAL app setting: changing it affects every chat's
// future subagents, never the current session alone and never a live child.
export default function SubagentModelSelect({ disabled = false }) {
	// null/undefined while loading: null = "follow the chat model".
	const [subagentModel, setSubagentModel] = useState(undefined);
	const [cloudModels, setCloudModels] = useState([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			.getSubagentModel()
			.then((value) => {
				if (active) setSubagentModel(value);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		window.api
			.getCloudProviders()
			.then((rows) => {
				if (!active) return;
				setCloudModels(
					rows.filter(
						(row) => (row.category ?? "text") === "text" && row.configured && row.modelId?.trim(),
					),
				);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	// Same encoding the rest of the app uses for a model choice: '' = follow the
	// chat, 'local' = the local model server, otherwise the saved provider id.
	const encodedSubagentModel =
		subagentModel == null
			? ""
			: subagentModel.type === "local"
				? "local"
				: subagentModel.provider;
	const storedCloudMissing =
		subagentModel?.type === "cloud" && !cloudModels.some((row) => row.id === subagentModel.provider);

	async function updateSubagentModel(encoded) {
		if (saving || subagentModel === undefined) return;
		setSaving(true);
		setError("");
		try {
			const selection =
				encoded === ""
					? null
					: encoded === "local"
						? { type: "local" }
						: {
								type: "cloud",
								provider: encoded,
								model: cloudModels.find((row) => row.id === encoded)?.modelId,
							};
			setSubagentModel(await window.api.saveSubagentModel(selection));
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<SelectField
				label="Sub-agent model"
				value={encodedSubagentModel}
				disabled={disabled || saving || subagentModel === undefined}
				onChange={(event) => updateSubagentModel(event.target.value)}
			>
				<option value="">Follow the chat model</option>
				<option value="local">Local model server (the loaded model)</option>
				{cloudModels.map((row) => (
					<option
						key={row.id}
						value={row.id}
					>
						{row.name} — {row.modelId}
					</option>
				))}
				{storedCloudMissing && (
					<option value={subagentModel.provider}>
						{subagentModel.provider} — {subagentModel.model} (unavailable)
					</option>
				)}
			</SelectField>
			{!cloudModels.length && (
				<p className="mt-2 text-xs text-[var(--text-muted)]">
					No cloud providers configured. Add one in Settings → Cloud Providers to run sub-agents
					on a cloud model.
				</p>
			)}
			{error && (
				<p
					role="alert"
					className="mt-2 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
		</>
	);
}

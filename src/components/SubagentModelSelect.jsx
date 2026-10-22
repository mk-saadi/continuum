import React, { useEffect, useState } from "react";
import { SelectField } from "./FormControls";

// Shared sub-agent model field used by Settings → General and the Workspace
// sidebar Agents tab. Same data (window.api.getSubagentModel,
// getCloudProviders) and same behavior/encoding in both places: '' = follow
// the chat model, 'local' = the local model server, otherwise a saved cloud
// provider id plus the model chosen from that provider. This is a GLOBAL app
// setting: changing it affects every chat's future subagents, never the
// current session alone and never a live child.
export default function SubagentModelSelect({ disabled = false }) {
	// null/undefined while loading: null = "follow the chat model".
	const [subagentModel, setSubagentModel] = useState(undefined);
	const [cloudProviders, setCloudProviders] = useState([]);
	// Provider chosen in the first field while its model is still being picked.
	const [draftProvider, setDraftProvider] = useState(null);
	const [providerModels, setProviderModels] = useState({ loading: false, models: [], error: "" });
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
				setCloudProviders(
					rows.filter((row) => (row.category ?? "text") === "text" && row.configured),
				);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	const selectedProvider =
		draftProvider ??
		(subagentModel?.type === "cloud" ? subagentModel.provider : "");
	const savedModel =
		subagentModel?.type === "cloud" && subagentModel.provider === selectedProvider
			? subagentModel.model
			: "";

	useEffect(() => {
		if (!selectedProvider || !window.api?.fetchCloudModels) {
			setProviderModels({ loading: false, models: [], error: "" });
			return;
		}
		let active = true;
		setProviderModels({ loading: true, models: [], error: "" });
		window.api
			.fetchCloudModels({ id: selectedProvider })
			.then((result) => {
				if (!active) return;
				if (result?.error) throw new Error(result.error);
				setProviderModels({ loading: false, models: result?.models || [], error: "" });
			})
			.catch((cause) => {
				if (active) {
					setProviderModels({
						loading: false,
						models: [],
						error: cause.message || "Could not fetch this provider's models.",
					});
				}
			});
		return () => {
			active = false;
		};
	}, [selectedProvider]);

	// Same encoding the rest of the app uses for a model choice: '' = follow the
	// chat, 'local' = the local model server, otherwise the saved provider id.
	const encodedSubagentModel =
		selectedProvider || (subagentModel?.type === "local" ? "local" : "");
	const storedCloudMissing =
		subagentModel?.type === "cloud" &&
		!cloudProviders.some((row) => row.id === subagentModel.provider);

	async function persistSelection(selection) {
		if (saving || subagentModel === undefined) return;
		setSaving(true);
		setError("");
		try {
			setSubagentModel(await window.api.saveSubagentModel(selection));
			setDraftProvider(null);
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	function chooseProvider(encoded) {
		if (encoded === "") {
			setDraftProvider(null);
			persistSelection(null);
		} else if (encoded === "local") {
			setDraftProvider(null);
			persistSelection({ type: "local" });
		} else {
			setDraftProvider(encoded);
		}
	}

	return (
		<>
			<div className="space-y-3">
				<SelectField
					label="Sub-agent model"
					value={encodedSubagentModel}
					disabled={disabled || saving || subagentModel === undefined}
					onChange={(event) => chooseProvider(event.target.value)}
				>
					<option value="">Follow the chat model</option>
					<option value="local">Local model server (the loaded model)</option>
					{cloudProviders.map((row) => (
						<option
							key={row.id}
							value={row.id}
						>
							{row.name}
						</option>
					))}
					{storedCloudMissing && (
						<option value={subagentModel.provider}>
							{subagentModel.provider} (unavailable)
						</option>
					)}
				</SelectField>
				{selectedProvider && (
					<SelectField
						label="Sub-agent cloud model"
						value={savedModel}
						disabled={
							disabled || saving || providerModels.loading || !selectedProvider
						}
						placeholder={providerModels.loading ? "Loading models…" : "Choose a model…"}
						onChange={(event) => {
							const model = event.target.value;
							if (!model) return;
							persistSelection({
								type: "cloud",
								provider: selectedProvider,
								model,
							});
						}}
					>
						{providerModels.models.map((model) => (
							<option
								key={model}
								value={model}
							>
								{model}
							</option>
						))}
						{savedModel && !providerModels.models.includes(savedModel) && (
							<option value={savedModel}>{savedModel}</option>
						)}
					</SelectField>
				)}
			</div>
			{!cloudProviders.length && (
				<p className="mt-2 text-xs text-[var(--text-muted)]">
					No cloud providers configured. Add one in Settings → Models &amp; Generation to run
					sub-agents on a cloud model.
				</p>
			)}
			{providerModels.error && (
				<p
					role="alert"
					className="mt-2 text-xs text-[var(--error)]"
				>
					{providerModels.error}
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

import React, { useEffect, useRef, useState } from "react";
import ModelCapabilitiesModal from "../ModelCapabilitiesModal";
import Tooltip from "../Tooltip";
import ModelSettingsModal from "../ModelSettingsModal";
import { SearchableSelect, SelectField, TextField } from "../FormControls";
import {
	LuArrowRight,
	LuBrain,
	LuEye,
	LuWrench,
	LuX,
	LuSearch,
	LuRefreshCw,
	LuCpu,
	LuCloud,
	LuAudioLines,
	LuVideo,
	LuCheck,
	LuPencil,
	LuStar,
} from "react-icons/lu";

const secondaryButton =
	"aero-control aero-fill inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium";
const ghostButton = "aero-orb aero-fill size-7 shrink-0 cursor-pointer";
const modelCard = "aero-fill relative";
const rowGrid = "grid grid-cols-[minmax(240px,1fr)_95px_125px_60px_80px_80px_65px] items-center gap-3";
const capabilityIcons = [
	["image", "Image input", LuEye],
	["audio", "Audio input", LuAudioLines],
	["video", "Video input", LuVideo],
	["reasoning", "Reasoning", LuBrain],
	["tools", "Tool use", LuWrench],
];

const tokens = (value) =>
	value
		? value >= 1000
			? `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`
			: String(value)
		: "—";
function priceLabel(pricing) {
	if (pricing?.input == null || pricing?.output == null) return "—";
	const cost = (value) => `$${(value * 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })}`;
	return `${cost(pricing.input)} / ${cost(pricing.output)}`;
}

function overrideKey(model, local) {
	return JSON.stringify(
		local
			? ["local", model.modelPath || model.path || model.id]
			: ["cloud", model.id, model.baseUrl, model.modelId],
	);
}
function Capabilities({ model, local, runtime, overrides = {} }) {
	return (
		<span className="flex items-center gap-1">
			{capabilityIcons.map(([key, label, Icon]) => {
				const declared = model.capabilities?.[key] ?? model.declaredCapabilities?.[key];
				const inferred =
					key === "image"
						? model.hasVision || model.isVision
						: key === "audio"
							? model.hasAudio
							: key === "reasoning"
								? model.hasReasoning
								: key === "tools"
									? model.hasTools
									: null;
				const confirmed = typeof runtime?.[key] === "boolean";
				const overridden = typeof overrides[key] === "boolean";
				const value = overridden
					? overrides[key]
					: confirmed
						? runtime[key]
						: typeof declared === "boolean"
							? declared
							: inferred
								? true
								: null;
				const status = overridden
					? value
						? "enabled by you"
						: "disabled by you"
					: value === true
						? confirmed
							? "verified by loaded engine"
							: local
								? "inferred from model metadata; not runtime verified"
								: "reported by provider"
						: value === false
							? "unsupported"
							: "unknown";
				return (
					<Tooltip
						key={key}
						content={`${label}: ${status}`}
					>
						<span
							aria-label={`${label}: ${status}`}
							className={`grid size-5 shrink-0 place-items-center rounded ${value === true ? "bg-[var(--active-chat)] text-[var(--accent)]" : "text-[var(--text-muted)] opacity-40"}`}
						>
							<Icon
								size={13}
								aria-hidden="true"
							/>
						</span>
					</Tooltip>
				);
			})}
		</span>
	);
}

export default function ModelSelectorModal({
	models = [],
	engines = [],
	cloudProviders = [],
	activeChatProvider,
	onSelectProvider,
	selectedModel,
	onSelectModel,
	scanning,
	onScan,
	engineRunning,
	onClose,
	onLoaded,
	onUnloadModel,
	serverError,
}) {
	const dialog = useRef(null);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState("name");
	const [configuring, setConfiguring] = useState(null);
	const [editingCapabilities, setEditingCapabilities] = useState(null);
	const [capabilityOverrides, setCapabilityOverrides] = useState({});
	useEffect(() => {
		let active = true;
		window.api
			?.getCapabilityOverrides?.()
			.then((all) => {
				if (active) setCapabilityOverrides(all);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [cloudMetadata, setCloudMetadata] = useState([]);
	const [metadataStatus, setMetadataStatus] = useState("");
	const [expandedProvider, setExpandedProvider] = useState(null);
	const [modelsByProvider, setModelsByProvider] = useState({});
	const [manualModels, setManualModels] = useState({});
	// Starred cloud models per provider, persisted locally. Favorites that the
	// provider no longer offers are pruned whenever its model list is refreshed.
	const [favoritesByProvider, setFavoritesByProvider] = useState({});
	useEffect(() => {
		try {
			const stored = JSON.parse(localStorage.getItem("cloud-model-favorites") || "{}");
			if (stored && typeof stored === "object" && !Array.isArray(stored))
				setFavoritesByProvider(stored);
		} catch {
			// Corrupt favorites are ignored; the picker starts with none.
		}
	}, []);
	const persistFavorites = (next) => {
		setFavoritesByProvider(next);
		try {
			localStorage.setItem("cloud-model-favorites", JSON.stringify(next));
		} catch {
			// Storage may be unavailable; favorites just don't persist.
		}
	};
	const toggleFavorite = (providerId, modelId) => {
		const current = favoritesByProvider[providerId] || [];
		const next = current.includes(modelId)
			? current.filter((id) => id !== modelId)
			: [...current, modelId];
		persistFavorites({ ...favoritesByProvider, [providerId]: next });
	};
	const providerSignature = cloudProviders
		.map((row) => `${row.id}:${row.baseUrl}:${row.apiType}:${row.configured}`)
		.join("|");
	useEffect(() => {
		if (!window.api?.getCloudModelMetadata) return;
		let active = true;
		setCloudMetadata([]);
		setMetadataStatus("Refreshing cloud metadata…");
		window.api
			.getCloudModelMetadata()
			.then((rows) => {
				if (!active) return;
				setCloudMetadata(rows);
				setMetadataStatus(
					rows.some((row) => row.error)
						? "Some cloud metadata is unavailable. Model selection still works."
						: "",
				);
			})
			.catch(() => {
				if (active) setMetadataStatus("Cloud metadata unavailable; model selection still works.");
			});
		return () => {
			active = false;
		};
	}, [providerSignature]);
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		const previous = document.activeElement;
		element.showModal();
		return () => {
			element.close();
			previous?.focus();
		};
	}, [configuring, editingCapabilities]);

	const localModels = models.filter(
		(model) =>
			!/mmproj/i.test((model.modelPath || model.path || model.name || model.id).split(/[\\/]/).pop()),
	);
	// Providers are model-agnostic: every configured text provider can serve
	// any model it lists. The model is chosen below, per chat.
	const providers = cloudProviders.filter((row) => (row.category ?? "text") === "text" && row.configured);
	const activeProviderId = activeChatProvider?.type === "cloud" ? activeChatProvider.provider : null;
	const activeModelId = activeChatProvider?.type === "cloud" ? activeChatProvider.model : null;
	const metadataFor = (providerId, modelId) =>
		modelId
			? cloudMetadata.find((item) => item.providerId === providerId && item.modelId === modelId) || null
			: null;

	async function loadProviderModels(row, { force = false } = {}) {
		const existing = modelsByProvider[row.id];
		if (!force && (existing?.loading || existing?.models)) return;
		setModelsByProvider((previous) => ({
			...previous,
			[row.id]: { loading: true, models: existing?.models || [], error: "" },
		}));
		try {
			const result = await window.api.fetchCloudModels({ id: row.id });
			if (result?.error) throw new Error(result.error);
			const available = result?.models || [];
			setModelsByProvider((previous) => ({
				...previous,
				[row.id]: { loading: false, models: available, error: "" },
			}));
			if (available.length) {
				// A favorite the provider no longer offers is removed rather than
				// shown as selectable.
				setFavoritesByProvider((previous) => {
					const current = previous[row.id] || [];
					const kept = current.filter((modelId) => available.includes(modelId));
					if (kept.length === current.length) return previous;
					const next = { ...previous, [row.id]: kept };
					try {
						localStorage.setItem("cloud-model-favorites", JSON.stringify(next));
					} catch {
						// Non-fatal; the in-memory list is still pruned.
					}
					return next;
				});
			}
		} catch (cause) {
			setModelsByProvider((previous) => ({
				...previous,
				[row.id]: {
					loading: false,
					models: existing?.models || [],
					error: cause.message || "Could not fetch this provider's models.",
				},
			}));
		}
	}

	function toggleProvider(row) {
		const opening = expandedProvider !== row.id;
		setExpandedProvider(opening ? row.id : null);
		// Refresh first so starred favorites are validated against what the
		// provider currently offers before the user picks a model.
		if (opening) loadProviderModels(row, { force: true });
	}

	function chooseModel(row, modelId) {
		if (!modelId) return;
		onSelectProvider({ type: "cloud", provider: row.id, model: modelId });
		onClose();
	}

	const matchingQuery = (value) => value.toLowerCase().includes(query.toLowerCase());
	const localEntries = localModels
		.filter((model) => {
			const name =
				model.generalName ||
				(model.name || model.id)
					.split(/[\\/]/)
					.pop()
					.replace(/\.gguf$/i, "");
			return (
				!query ||
				matchingQuery(
					`${name} ${model.name || ""} ${model.modelId || ""} ${model.architecture || ""} ${model.quantization || ""}`,
				)
			);
		})
		.map((model) => ({
			kind: "local",
			model,
			name:
				model.generalName ||
				(model.name || model.id)
					.split(/[\\/]/)
					.pop()
					.replace(/\.gguf$/i, ""),
		}));
	const cloudEntries = providers
		.filter((row) => {
			if (!query) return true;
			const knownModels = cloudMetadata
				.filter((item) => item.providerId === row.id)
				.map((item) => item.modelId)
				.join(" ");
			return matchingQuery(
				`${row.name} ${row.baseUrl || ""} ${row.apiType || ""} ${row.modelId || ""} ${knownModels}`,
			);
		})
		.map((row) => ({ kind: "cloud", provider: row, name: row.name }));
	const compareEntries = (a, b) =>
		sort === "size"
			? (b.model?.fileIdentity?.size || 0) - (a.model?.fileIdentity?.size || 0) ||
				a.name.localeCompare(b.name)
			: a.name.localeCompare(b.name);
	const groups = [
		{ kind: "local", title: "Local models", entries: localEntries.sort(compareEntries) },
		{ kind: "cloud", title: "Cloud models", entries: cloudEntries.sort(compareEntries) },
	];
	const entries = groups.flatMap((group) => group.entries);

	if (editingCapabilities)
		return (
			<ModelCapabilitiesModal
				entry={editingCapabilities}
				overrides={
					capabilityOverrides[overrideKey(editingCapabilities.model, editingCapabilities.local)]
				}
				onClose={() => setEditingCapabilities(null)}
				onSaved={(all) => {
					setCapabilityOverrides(all);
					window.api
						.getCloudModelMetadata?.()
						.then(setCloudMetadata)
						.catch(() => {});
				}}
			/>
		);

	if (configuring)
		return (
			<ModelSettingsModal
				model={configuring}
				onClose={() => setConfiguring(null)}
				onLoaded={(result) => {
					onLoaded(result);
					onClose();
				}}
			/>
		);

	return (
		<dialog
			ref={dialog}
			aria-labelledby="model-selector-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
			className="aero-dialog fixed inset-0 m-auto w-[calc(100%-24px)] max-w-[1000px] overflow-hidden p-0"
		>
			<div className="flex max-h-[85dvh] flex-col">
				<header className="aero-header flex shrink-0 items-center justify-between gap-3 px-4 py-4">
					<div className="flex min-w-0 items-center gap-3">
						<span className="aero-fill grid size-9 shrink-0 place-items-center text-[var(--accent)]">
							<LuCpu
								size={18}
								aria-hidden="true"
							/>
						</span>
						<div className="min-w-0">
							<h2
								id="model-selector-title"
								className="text-sm font-semibold"
							>
								Choose a model
							</h2>
							<p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
								Local and cloud models, in one place.
							</p>
						</div>
					</div>
					<button
						type="button"
						aria-label="Close model selector"
						disabled={busy}
						onClick={onClose}
						className={ghostButton}
					>
						<LuX size={17} />
					</button>
				</header>
				<div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-3">
					<LuSearch
						size={16}
						className="shrink-0 text-[var(--accent)]"
						aria-hidden="true"
					/>
					<TextField
						className="flex-1"
						type="search"
						autoFocus
						aria-label="Search models"
						placeholder="Search models, providers, or quantization…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					{query && (
						<button
							type="button"
							aria-label="Clear model search"
							onClick={() => setQuery("")}
							className={ghostButton}
						>
							<LuX
								size={14}
								aria-hidden="true"
							/>
						</button>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 pb-3">
					<p className="text-[11px] text-[var(--text-muted)]">
						{localModels.length} local models · {providers.length} cloud providers
					</p>
					<div className="flex items-center gap-3">
						<SelectField
							aria-label="Sort models"
							value={sort}
							onChange={(event) => setSort(event.target.value)}
						>
							<option value="name">Name A–Z</option>
							<option value="size">Largest local files</option>
						</SelectField>
						<button
							type="button"
							disabled={scanning || busy}
							onClick={onScan}
							className={secondaryButton}
						>
							<LuRefreshCw
								size={13}
								className={scanning ? "animate-spin" : ""}
								aria-hidden="true"
							/>
							{scanning ? "Scanning…" : "Rescan"}
						</button>
					</div>
				</div>
				{(error || serverError) && (
					<p
						role="alert"
						className="shrink-0 border-b border-[var(--border)] px-5 py-2 text-xs text-[var(--error)]"
					>
						{error || serverError}
					</p>
				)}
				<div className="min-h-0 flex-1 overflow-auto px-3 py-4">
					<div className="min-w-[850px]">
						{groups
							.filter((group) => group.entries.length > 0)
							.map((group) => (
								<section
									key={group.kind}
									data-model-source={group.kind}
									aria-labelledby={`model-group-${group.kind}`}
									className="mb-6 last:mb-0"
								>
									<h3
										id={`model-group-${group.kind}`}
										className="mb-3 flex items-center gap-2 text-xs font-semibold"
									>
										{group.kind === "local" ? (
											<LuCpu aria-hidden="true" />
										) : (
											<LuCloud aria-hidden="true" />
										)}
										{group.title}
										<span className="aero-badge px-2 py-0.5 text-[10px]">
											{group.entries.length}
										</span>
									</h3>
									{/* <div
							aria-hidden="true"
							className={`${rowGrid} aero-flat sticky top-0 z-10 pl-3 pr-12 py-2 text-[11px] font-semibold text-[var(--text-muted)] mb-3`}
						>
							<span>Model</span>
							<span>Source</span>
							<span>Capabilities</span>
							<span>{group.kind === "cloud" ? "Context" : "Params"}</span>
							<span>{group.kind === "cloud" ? "Max output" : "Quantization"}</span>
							<span className="text-right">
								{group.kind === "cloud" ? "$/1M in · out" : "File size"}
							</span>
							<span />
						</div> */}
									<ul
										aria-label={group.title}
										className="m-0 list-none space-y-3 p-0"
									>
										{group.entries.map((entry) => {
											if (entry.kind === "local") {
												const { model, name } = entry;
												const modelPath =
													model.modelPath || model.path || model.id;
												const loadedEngine =
													engines.find(
														(engine) => engine.modelPath === modelPath,
													) ?? null;
												const loaded = !!loadedEngine?.isLoaded;
												const loading =
													!!loadedEngine && !loaded;
												const active =
													activeChatProvider?.type === "local" &&
													selectedModel === model.id;
												const runtime = loaded
													? loadedEngine.capabilities
													: undefined;
												return (
													<li
														key={`local:${model.id}`}
														className={modelCard}
													>
														<button
															type="button"
															disabled={busy || loading}
															aria-label={`${active ? "Selected" : loaded ? "Use loaded" : loading ? "Loading" : "Load"} ${name}`}
															aria-current={active ? "true" : undefined}
															onClick={() => {
																if (loaded) {
																	onSelectModel(model.id);
																	onSelectProvider({ type: "local" });
																	onClose();
																} else if (!loading) setConfiguring(model);
															}}
															className={`${rowGrid} aero-list-item group w-full cursor-pointer pl-3 pr-12 py-3 text-left disabled:opacity-40`}
														>
															<Tooltip
																content={
																	model.modelPath || model.path || model.id
																}
															>
																<span className="min-w-0">
																	<span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
																		<span className="truncate">
																			{name}
																		</span>
																		{loaded && (
																			<span className="shrink-0 text-[9px] font-normal text-[var(--accent)]">
																				Loaded
																			</span>
																		)}
																		{loading && (
																			<span className="shrink-0 text-[9px] font-normal text-[var(--text-muted)]">
																				Loading…
																			</span>
																		)}
																	</span>
																	<span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
																		{model.architecture ||
																			"GGUF · architecture unknown"}
																	</span>
																</span>
															</Tooltip>
															<span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-secondary)] [&>svg]:text-[var(--accent)]">
																<LuCpu
																	size={13}
																	aria-hidden="true"
																/>
																<Tooltip content="Local file">
																	<span className="truncate">Local</span>
																</Tooltip>
															</span>
															<Capabilities
																model={model}
																local
																runtime={runtime}
																overrides={
																	capabilityOverrides[
																		overrideKey(model, true)
																	]
																}
															/>
															<span className="text-[11px] tabular-nums text-[var(--text-secondary)]">
																{model.paramSize || "—"}
															</span>
															<span className="truncate font-mono text-[10px] text-[var(--text-secondary)]">
																{model.quantization || "—"}
															</span>
															<Tooltip content="File size on disk">
																<span className="text-right text-[11px] tabular-nums text-[var(--text-secondary)]">
																	{model.sizeFormatted || "—"}
																</span>
															</Tooltip>
															<span className="flex items-center justify-end gap-1 text-[10px] text-[var(--accent)]">
																{active ? (
																	<>
																		<LuCheck
																			size={12}
																			aria-hidden="true"
																		/>
																		Active
																	</>
																) : (
																	<>
																		{loading ? "Loading" : loaded ? "Use" : "Load"}
																		<LuArrowRight
																			size={12}
																			aria-hidden="true"
																		/>
																	</>
																)}
															</span>
														</button>
														<Tooltip content="Edit model capabilities">
															<button
																type="button"
																aria-label={`Edit capabilities for ${name}`}
																title="Edit model capabilities"
																disabled={busy}
																onClick={() =>
																	setEditingCapabilities({
																		model,
																		local: true,
																		name,
																	})
																}
																className={`${ghostButton} absolute right-2 top-3`}
															>
																<LuPencil
																	size={13}
																	aria-hidden="true"
																/>
															</button>
														</Tooltip>
													</li>
												);
											}

											const row = entry.provider;
											const isActive = activeProviderId === row.id;
											const expanded = expandedProvider === row.id;
											const providerModels = modelsByProvider[row.id];
											const modelList = providerModels?.models || [];
											const providerItems = [
												...(isActive &&
												activeModelId &&
												!modelList.includes(activeModelId)
													? [{ value: activeModelId, label: activeModelId }]
													: []),
												...modelList.map((modelId) => ({
													value: modelId,
													label: modelId,
												})),
											];
											const capabilityModelId =
												(isActive ? activeModelId : "") || row.modelId?.trim() || "";
											const capabilityMetadata = metadataFor(row.id, capabilityModelId);
											const capabilityModel = capabilityModelId
												? {
														...row,
														...(capabilityMetadata || {}),
														id: row.id,
														modelId: capabilityModelId,
													}
												: null;
											const overrides = capabilityModel
												? capabilityOverrides[overrideKey(capabilityModel, false)]
												: undefined;
											const providerHost = (() => {
												try {
													return new URL(row.baseUrl).hostname;
												} catch {
													return row.apiType || "Cloud";
												}
											})();
											return (
												<li
													key={`cloud:${row.id}`}
													className={modelCard}
												>
													<button
														type="button"
														disabled={busy}
														aria-expanded={expanded}
														aria-label={`${isActive ? "Change" : "Choose"} a model for ${row.name}`}
														aria-current={isActive ? "true" : undefined}
														onClick={() => toggleProvider(row)}
														className={`${rowGrid} aero-list-item group w-full cursor-pointer pl-3 pr-12 py-3 text-left disabled:opacity-40`}
													>
														<Tooltip content={row.baseUrl}>
															<span className="min-w-0">
																<span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
																	<span className="truncate">
																		{row.name}
																	</span>
																	{expanded && (
																		<span className="shrink-0 text-[9px] font-normal text-[var(--accent)]">
																			{providerModels?.loading
																				? "Loading…"
																				: "Choose a model"}
																		</span>
																	)}
																</span>
																<span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
																	{isActive
																		? activeModelId
																		: row.baseUrl || "Cloud provider"}
																</span>
															</span>
														</Tooltip>
														<span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-secondary)] [&>svg]:text-[var(--accent)]">
															<LuCloud
																size={13}
																aria-hidden="true"
															/>
															<Tooltip content={providerHost}>
																<span className="truncate">
																	{capabilityMetadata?.providerName ||
																		"Cloud"}
																</span>
															</Tooltip>
														</span>
														{capabilityModel ? (
															<Capabilities
																model={capabilityModel}
																local={false}
																overrides={overrides}
															/>
														) : (
															<span className="text-[11px] text-[var(--text-muted)]">
																—
															</span>
														)}
														<span className="text-[11px] tabular-nums text-[var(--text-secondary)]">
															{group.kind === "cloud"
																? tokens(
																		overrides?.contextLength ??
																			capabilityMetadata?.contextLength,
																	)
																: capabilityModel?.paramSize || "—"}
														</span>
														<Tooltip
															content={
																group.kind === "cloud"
																	? "Maximum output tokens reported by provider"
																	: "Remote quantization is not reported"
															}
														>
															<span className="truncate font-mono text-[10px] text-[var(--text-secondary)]">
																{group.kind === "cloud"
																	? tokens(
																			capabilityMetadata?.maxOutputTokens,
																		)
																	: capabilityModel?.quantization || "—"}
															</span>
														</Tooltip>
														<Tooltip
															content={
																group.kind === "cloud"
																	? "USD per million input / output tokens. Routing and cache pricing may vary."
																	: "Cloud providers have no local file size"
															}
														>
															<span className="text-right text-[11px] tabular-nums text-[var(--text-secondary)]">
																{group.kind === "cloud"
																	? priceLabel(capabilityMetadata?.pricing)
																	: "—"}
															</span>
														</Tooltip>
														<span className="flex items-center justify-end gap-1 text-[10px] text-[var(--accent)]">
															{isActive ? (
																<>
																	<LuCheck
																		size={12}
																		aria-hidden="true"
																	/>
																	Active
																</>
															) : (
																<>
																	{expanded ? "Choose" : "Models"}
																	<LuArrowRight
																		size={12}
																		aria-hidden="true"
																	/>
																</>
															)}
														</span>
													</button>
													{capabilityModel && (
														<Tooltip content="Edit model capabilities">
															<button
																type="button"
																aria-label={`Edit capabilities for ${row.name}`}
																title="Edit model capabilities"
																disabled={busy}
																onClick={() =>
																	setEditingCapabilities({
																		model: capabilityModel,
																		local: false,
																		name: `${row.name} / ${capabilityModelId}`,
																	})
																}
																className={`${ghostButton} absolute right-2 top-3`}
															>
																<LuPencil
																	size={13}
																	aria-hidden="true"
																/>
															</button>
														</Tooltip>
													)}
													{expanded && (
														<div className="aero-inset m-3 p-3">
															<div className="flex max-w-xl items-end gap-2">
																<SearchableSelect
																	className="min-w-0 flex-1"
																	label={`${row.name} model`}
																	value={isActive ? activeModelId : ""}
																	items={providerItems}
																	starred={
																		favoritesByProvider[row.id] || []
																	}
																	onToggleStar={(modelId) =>
																		toggleFavorite(row.id, modelId)
																	}
																	searchPlaceholder="Search models…"
																	disabled={providerModels?.loading}
																	placeholder={
																		providerModels?.loading
																			? "Loading models…"
																			: "Choose a model…"
																	}
																	onChange={(event) =>
																		chooseModel(row, event.target.value)
																	}
																/>
																<button
																	className={secondaryButton}
																	type="button"
																	disabled={providerModels?.loading}
																	onClick={() =>
																		loadProviderModels(row, {
																			force: true,
																		})
																	}
																>
																	{providerModels?.loading
																		? "Loading…"
																		: "Reload models"}
																</button>
															</div>
															{(favoritesByProvider[row.id] || []).length >
																0 && (
																<div
																	aria-label={`Starred ${row.name} models`}
																	className="mt-2 flex flex-wrap items-center gap-1.5"
																>
																	<span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
																		<LuStar
																			size={10}
																			aria-hidden="true"
																		/>
																		Starred
																	</span>
																	{favoritesByProvider[row.id].map(
																		(modelId) => (
																			<span
																				key={modelId}
																				className={`aero-badge max-w-full py-0.5 pr-1 pl-2 text-[11px] ${isActive && modelId === activeModelId ? "aero-badge--accent" : ""}`}
																			>
																				<button
																					type="button"
																					disabled={busy}
																					onClick={() =>
																						chooseModel(
																							row,
																							modelId,
																						)
																					}
																					className="flex min-w-0 cursor-pointer items-center gap-1 truncate text-left"
																				>
																					<LuStar
																						size={10}
																						className="shrink-0 text-[var(--accent)]"
																						style={{
																							fill: "currentColor",
																						}}
																						aria-hidden="true"
																					/>
																					<span className="truncate">
																						{modelId}
																					</span>
																				</button>
																				<button
																					type="button"
																					aria-label={`Remove ${modelId} from favorites`}
																					onClick={() =>
																						toggleFavorite(
																							row.id,
																							modelId,
																						)
																					}
																					className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
																				>
																					<LuX
																						size={10}
																						aria-hidden="true"
																					/>
																				</button>
																			</span>
																		),
																	)}
																</div>
															)}
															{providerModels?.error ? (
																<p
																	role="alert"
																	className="mt-2 text-[11px] leading-relaxed text-[var(--error)]"
																>
																	{providerModels.error}
																</p>
															) : null}
															{!providerModels?.loading &&
															!providerModels?.error &&
															!modelList.length ? (
																<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
																	No models were returned. Enter one
																	manually, or check this provider's base
																	URL and API key in Settings → Models &amp;
																	Generation.
																</p>
															) : null}
															{!providerModels?.loading &&
															(providerModels?.error || !modelList.length) ? (
																<div className="mt-2 flex max-w-xl items-end gap-2">
																	<TextField
																		className="min-w-0 flex-1"
																		label="Model ID"
																		value={manualModels[row.id] || ""}
																		placeholder="Type the provider's model ID"
																		onChange={(event) =>
																			setManualModels((previous) => ({
																				...previous,
																				[row.id]: event.target.value,
																			}))
																		}
																		onKeyDown={(event) => {
																			if (event.key !== "Enter") return;
																			event.preventDefault();
																			chooseModel(
																				row,
																				(
																					manualModels[row.id] || ""
																				).trim(),
																			);
																		}}
																	/>
																	<button
																		className={secondaryButton}
																		type="button"
																		disabled={
																			!manualModels[row.id]?.trim()
																		}
																		onClick={() =>
																			chooseModel(
																				row,
																				(
																					manualModels[row.id] || ""
																				).trim(),
																			)
																		}
																	>
																		Use model
																	</button>
																</div>
															) : null}
														</div>
													)}
												</li>
											);
										})}
									</ul>
								</section>
							))}
					</div>
					{!entries.length && (
						<p
							role="status"
							className="aero-empty aero-fill px-4 py-10 text-center text-xs leading-relaxed text-[var(--text-muted)]"
						>
							{query
								? "No models match your search."
								: "No models available. Rescan or add a cloud provider in Settings → Models & Generation."}
						</p>
					)}
				</div>
				<footer className="aero-fill flex shrink-0 flex-col gap-2 px-4 py-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<span
							className={`size-1.5 shrink-0 rounded-full ${engines.length ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]"}`}
						/>
						<span className="shrink-0 text-[var(--text-secondary)]">
							{engines.length
								? `${engines.length} local ${engines.length === 1 ? "engine" : "engines"} loaded`
								: "No local engine loaded"}
						</span>
						{engines.map((engine) => (
							<span
								key={engine.modelPath}
								className="aero-badge flex min-w-0 items-center gap-1 py-0.5 pr-1 pl-2"
							>
								<span className="max-w-[220px] truncate">
									{engine.modelName || engine.modelPath}
								</span>
								<button
									type="button"
									disabled={busy}
									aria-label={`Unload ${engine.modelName || engine.modelPath}`}
									className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
									onClick={async () => {
										setBusy(true);
										setError("");
										try {
											await onUnloadModel?.(engine.modelPath);
										} catch (err) {
											setError(err.message);
										} finally {
											setBusy(false);
										}
									}}
								>
									<LuX
										size={10}
										aria-hidden="true"
									/>
								</button>
							</span>
						))}
					</div>
					<span>
						{metadataStatus && <span className="block">{metadataStatus}</span>}
						Icons: image · audio · video · reasoning · tools. Hover for support status; muted
						means unsupported or unknown.
					</span>
				</footer>
			</div>
		</dialog>
	);
}

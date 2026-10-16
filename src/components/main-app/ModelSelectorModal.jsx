import React, { useEffect, useRef, useState } from "react";
import ModelCapabilitiesModal from "../ModelCapabilitiesModal";
import ModelSettingsModal from "../ModelSettingsModal";
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
} from "react-icons/lu";

const rowGrid = "grid grid-cols-[minmax(240px,1fr)_95px_125px_60px_80px_80px_65px] items-center gap-3";
const capabilityIcons = [
	["image", "Image input", LuEye],
	["audio", "Audio input", LuAudioLines],
	["video", "Video input", LuVideo],
	["reasoning", "Reasoning", LuBrain],
	["tools", "Tool use", LuWrench],
];

function cloudService(model) {
	if (model.providerName) return model.providerName;
	try {
		const host = new URL(model.baseUrl).hostname;
		return (
			{
				"openrouter.ai": "OpenRouter",
				"api.anthropic.com": "Anthropic",
				"api.openai.com": "OpenAI",
				"api.deepseek.com": "DeepSeek",
			}[host] || host
		);
	} catch {
		return model.apiType === "anthropic" ? "Anthropic" : "Cloud";
	}
}
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
					<span
						key={key}
						title={`${label}: ${status}`}
						aria-label={`${label}: ${status}`}
						className={`grid size-5 shrink-0 place-items-center rounded ${value === true ? "bg-[var(--active-chat)] text-[var(--accent)]" : "text-[var(--text-muted)] opacity-40"}`}
					>
						<Icon
							size={13}
							aria-hidden="true"
						/>
					</span>
				);
			})}
		</span>
	);
}

export default function ModelSelectorModal({
	models = [],
	loadedLocalModel,
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
	serverError,
}) {
	const dialog = useRef(null);
	const [query, setQuery] = useState("");
	const [source, setSource] = useState("all");
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
	const providerSignature = cloudProviders
		.map((row) => `${row.id}:${row.baseUrl}:${row.modelId}:${row.apiType}:${row.configured}`)
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
						? "Some cloud metadata is unavailable. Hover a cloud model for details."
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
	const providers = cloudProviders
		.filter((row) => (row.category ?? "text") === "text" && row.configured && row.modelId?.trim())
		.map((row) => {
			const metadata = cloudMetadata.find(
				(item) => item.providerId === row.id && item.modelId === row.modelId,
			);
			return { ...row, ...metadata, id: row.id, name: row.name, modelId: row.modelId };
		});
	const entries = [
		...localModels.map((model) => ({
			model,
			local: true,
			name:
				model.generalName ||
				(model.name || model.id)
					.split(/[\\/]/)
					.pop()
					.replace(/\.gguf$/i, ""),
		})),
		...providers.map((model) => ({ model, local: false, name: model.name || model.modelId })),
	]
		.filter(
			({ model, local, name }) =>
				(source === "all" || (source === "local") === local) &&
				`${name} ${model.name || ""} ${model.modelId || ""} ${model.architecture || ""} ${model.quantization || ""}`
					.toLowerCase()
					.includes(query.toLowerCase()),
		)
		.sort((a, b) =>
			sort === "size"
				? (b.model.fileIdentity?.size || 0) - (a.model.fileIdentity?.size || 0) ||
					a.name.localeCompare(b.name)
				: a.name.localeCompare(b.name),
		);

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
			className="fixed inset-0 m-auto w-[calc(100%-24px)] max-w-[1000px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60"
		>
			<div className="flex max-h-[85dvh] flex-col">
				<header className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4 pb-3">
					<div>
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
					<button
						type="button"
						aria-label="Close model selector"
						disabled={busy}
						onClick={onClose}
						className="grid size-8 cursor-pointer place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
					>
						<LuX size={17} />
					</button>
				</header>
				<div className="mx-5 mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--input)] px-3">
					<LuSearch
						size={16}
						className="shrink-0 text-[var(--text-muted)]"
						aria-hidden="true"
					/>
					<input
						autoFocus
						aria-label="Search models"
						placeholder="Search models, providers, or quantization…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="min-w-0 flex-1 bg-transparent py-2.5 text-xs outline-none"
					/>
					{query && (
						<button
							type="button"
							aria-label="Clear model search"
							onClick={() => setQuery("")}
							className="grid size-7 place-items-center rounded hover:bg-[var(--surface-hover)]"
						>
							<LuX size={14} />
						</button>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-5 pb-3">
					<div
						role="group"
						aria-label="Model source"
						className="flex gap-1"
					>
						{[
							["all", "All", localModels.length + providers.length],
							["local", "Local", localModels.length],
							["cloud", "Cloud", providers.length],
						].map(([id, label, count]) => (
							<button
								key={id}
								type="button"
								aria-pressed={source === id}
								onClick={() => setSource(id)}
								className={`rounded-md px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${source === id ? "bg-[var(--active-chat)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"}`}
							>
								{label}
								<span className="ml-1.5 text-[10px] opacity-60">{count}</span>
							</button>
						))}
					</div>
					<div className="flex items-center gap-3">
						<select
							aria-label="Sort models"
							value={sort}
							onChange={(event) => setSort(event.target.value)}
							className="rounded-md border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-[11px]"
						>
							<option value="name">Name A–Z</option>
							<option value="size">Largest local files</option>
						</select>
						<button
							type="button"
							disabled={scanning || busy}
							onClick={onScan}
							className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] disabled:opacity-40"
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
				<div className="min-h-0 overflow-auto">
					<div className="min-w-[850px]">
						<div
							aria-hidden="true"
							className={`${rowGrid} sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] mr-7`}
						>
							<span>Model</span>
							<span>Source</span>
							<span>Capabilities</span>
							<span>{source === "cloud" ? "Context" : "Params"}</span>
							<span>{source === "cloud" ? "Max output" : "Quantization"}</span>
							<span className="text-right">
								{source === "cloud" ? "$/1M in · out" : "File size"}
							</span>
							<span />
						</div>
						<ul
							aria-label="Available models"
							className="m-0 list-none p-0"
						>
							{entries.map(({ model, local, name }) => {
								const loaded =
									local &&
									loadedLocalModel?.modelPath ===
										(model.modelPath || model.path || model.id);
								const active = local
									? activeChatProvider?.type === "local" && selectedModel === model.id
									: activeChatProvider?.type === "cloud" &&
										activeChatProvider.provider === model.id &&
										activeChatProvider.model === model.modelId;
								const runtime = loaded ? loadedLocalModel.capabilities : undefined;
								return (
									<li
										key={`${local ? "local" : "cloud"}:${model.id}`}
										className="relative"
									>
										<button
											type="button"
											disabled={busy}
											aria-label={`${active ? "Selected" : loaded ? "Use loaded" : local ? "Load" : "Use"} ${name}`}
											aria-current={active ? "true" : undefined}
											onClick={() => {
												if (!local) {
													onSelectProvider({
														type: "cloud",
														provider: model.id,
														model: model.modelId,
													});
													onClose();
												} else if (loaded) {
													onSelectModel(model.id);
													onSelectProvider({ type: "local" });
													onClose();
												} else setConfiguring(model);
											}}
											className={`${rowGrid} group w-full cursor-pointer border-b border-[var(--border)] pl-5 pr-12 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-40 ${active ? "bg-[var(--active-chat)]" : ""}`}
										>
											<span
												className="min-w-0"
												title={
													local
														? model.modelPath || model.path || model.id
														: model.modelId
												}
											>
												<span className="flex min-w-0 items-center gap-2 text-xs font-medium">
													<span className="truncate">{name}</span>
													{loaded && (
														<span className="shrink-0 text-[9px] font-normal text-[var(--accent)]">
															Loaded
														</span>
													)}
												</span>
												<span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
													{local
														? model.architecture || "GGUF · architecture unknown"
														: model.modelId}
												</span>
											</span>
											<span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
												{local ? (
													<LuCpu
														size={13}
														aria-hidden="true"
													/>
												) : (
													<LuCloud
														size={13}
														aria-hidden="true"
													/>
												)}
												<span
													className="truncate"
													title={local ? "Local file" : cloudService(model)}
												>
													{local ? "Local" : cloudService(model)}
												</span>
											</span>
											<Capabilities
												model={model}
												local={local}
												runtime={runtime}
												overrides={capabilityOverrides[overrideKey(model, local)]}
											/>
											<span className="text-[11px] tabular-nums text-[var(--text-secondary)]">
												{source === "cloud"
													? tokens(
															capabilityOverrides[overrideKey(model, local)]
																?.contextLength ?? model.contextLength,
														)
													: model.paramSize || "—"}
											</span>
											<span
												title={
													local
														? "GGUF quantization"
														: source === "cloud"
															? "Maximum output tokens reported by provider"
															: "Remote quantization is not reported"
												}
												className="truncate font-mono text-[10px] text-[var(--text-secondary)]"
											>
												{source === "cloud"
													? tokens(model.maxOutputTokens)
													: model.quantization || "—"}
											</span>
											<span
												title={
													local
														? "File size on disk"
														: source === "cloud"
															? "USD per million input / output tokens. Routing and cache pricing may vary."
															: "Cloud models have no local file size"
												}
												className="text-right text-[11px] tabular-nums text-[var(--text-secondary)]"
											>
												{source === "cloud"
													? priceLabel(model.pricing)
													: local
														? model.sizeFormatted || "—"
														: "—"}
											</span>
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
														{loaded || !local ? "Use" : "Load"}
														<LuArrowRight
															size={12}
															aria-hidden="true"
														/>
													</>
												)}
											</span>
										</button>
										<button
											type="button"
											aria-label={`Edit capabilities for ${name}`}
											title="Edit model capabilities"
											disabled={busy}
											onClick={() => setEditingCapabilities({ model, local, name })}
											className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
										>
											<LuPencil
												size={13}
												aria-hidden="true"
											/>
										</button>
									</li>
								);
							})}
						</ul>
					</div>
					{!entries.length && (
						<p
							role="status"
							className="px-5 py-10 text-center text-xs text-[var(--text-muted)]"
						>
							{query
								? "No models match your search."
								: source === "cloud"
									? "No cloud models configured. Add a provider in Settings → Models & Generation."
									: "No models available. Rescan or add a cloud provider."}
						</p>
					)}
				</div>
				<footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-5 py-2.5 text-[10px] text-[var(--text-muted)]">
					<span className="flex min-w-0 items-center gap-2">
						<span
							className={`size-1.5 shrink-0 rounded-full ${engineRunning ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]"}`}
						/>
						<span
							className="max-w-[360px] truncate"
							title={loadedLocalModel?.name}
						>
							{loadedLocalModel?.name ||
								(engineRunning ? "Local engine loading…" : "Local engine stopped")}
						</span>
						{engineRunning && (
							<button
								type="button"
								disabled={busy}
								className="ml-1 text-[var(--text-secondary)] underline underline-offset-2 disabled:opacity-40 cursor-pointer"
								onClick={async () => {
									setBusy(true);
									setError("");
									try {
										const result = await window.terminalAPI.kill();
										if (!result.success) throw new Error(result.error);
									} catch (err) {
										setError(err.message);
									} finally {
										setBusy(false);
									}
								}}
							>
								Unload
							</button>
						)}
					</span>
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

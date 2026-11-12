import React, { useEffect, useRef, useState } from "react";
import {
	LuChevronRight,
	LuCpu,
	LuHardDrive,
	LuLayers,
	LuPlay,
	LuSlidersHorizontal,
	LuSparkles,
	LuTriangleAlert,
	LuX,
} from "react-icons/lu";
import {
	CheckboxField,
	NumberField,
	SelectField,
} from "./FormControls";
import Tooltip from "./Tooltip";
import { estimateMemoryUsage } from "../lib/memoryEstimate.mjs";

// Compact MiB/GiB readout for the live memory estimate. `null` means a required
// size could not be read from metadata, so it is shown as unknown rather than 0.
function formatMemory(mib) {
	if (mib === null || mib === undefined || !Number.isFinite(mib)) return "unknown";
	if (mib < 1) return "~0 MiB";
	if (mib >= 1024) return `~${(mib / 1024).toFixed(1)} GiB`;
	return `~${Math.round(mib)} MiB`;
}

const integerFields = [
	["contextLength", "Context length", "Total context tokens shared across concurrent predictions."],
	["threads", "CPU threads", "CPU thread pool size."],
	["evalBatch", "Evaluation batch size", "Maximum logical batch size."],
	["physicalBatch", "Physical batch size", "Must not exceed the evaluation batch size."],
	[
		"parallel",
		"Concurrent predictions",
		"Maximum simultaneous predictions. The total context is shared across these slots; each request may have a smaller runtime limit.",
	],
];

const cardClass = "aero-fill sk-fill min-w-0 p-3";
const secondaryButton = "aero-control sk-button aero-fill sk-fill inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium";

function SectionHeading({ Icon, title, description }) {
    return (
        <div className="mb-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold">
                <Icon size={16} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
                {title}
            </h3>
            {description && <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{description}</p>}
        </div>
    );
}

export default function ModelSettingsModal({ model, onClose, onLoaded }) {
	const dialog = useRef(null);
	const [config, setConfig] = useState(null);
	const [projectorPath, setProjectorPath] = useState(model.mmprojPath || "");
	const [confirmTextOnly, setConfirmTextOnly] = useState(false);
	const [projectorNotice, setProjectorNotice] = useState("");
	const [remember, setRemember] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [vramWarning, setVramWarning] = useState(null);

	useEffect(() => {
		const element = dialog.current;
		element.showModal();
		let active = true;
		setConfig(null);
		setConfirmTextOnly(false);
		setProjectorNotice("");
		setProjectorPath(model.mmprojPath || "");
		setError("");
		setVramWarning(null);
		window.api
			.getModelLoadConfig(model.id)
			.then(({ config: savedConfig, remembered, projectorPath: savedProjector }) => {
				if (active) {
					setConfig({
						cacheTypeK: "f16",
						cacheTypeV: "f16",
						mlock: false,
						chatTemplate: "auto",
						kvCacheOffload: "gpu",
						promptCacheMiB: 0,
						loadMode: "auto",
						moeExpertCount: null,
						mmprojOffload: true,
						mtp: true,
						...savedConfig,
						reasoningFormat: remembered
							? (savedConfig.reasoningFormat ?? "auto")
							: (model.reasoningFormat ?? "auto"),
					});
					setRemember(remembered);
					if (savedProjector !== undefined) {
						const available =
							savedProjector === null ||
							savedProjector === model.mmprojPath ||
							model.projectorCandidates?.some((candidate) => candidate.path === savedProjector);
						setProjectorPath(available ? savedProjector || "" : "");
						if (!available)
							setProjectorNotice(
								"The last-used projector is no longer in the scanned files. Choose a projector or rescan.",
							);
					}
				}
			})
			.catch((loadError) => {
				if (active) setError(loadError.message);
			});
		return () => {
			active = false;
			if (element.open) element.close();
		};
	}, [model.id]);

	const update = (key, value) => {
		// Any edit invalidates a prior VRAM preflight warning.
		setVramWarning(null);
		setConfig((previous) => ({ ...previous, [key]: value }));
	};

	// The mlock checkbox mirrors the Load Mode selection so the two controls can
	// never ask the server for contradictory loading behavior.
	const changeLoadMode = (value) =>
		setConfig((previous) => ({
			...previous,
			loadMode: value,
			mlock: value === "auto" ? previous.mlock : ["mlock", "mmap+mlock"].includes(value),
		}));

	const mlockControlled = !!config && config.loadMode !== "auto";
	const expertHint = !model.architecture
		? "Model architecture is unknown, so an explicit expert count cannot be forwarded to the server."
		: model.isMoe && model.expertCount
			? `Total experts for MoE models only; this model reports ${model.expertCount}. Leave empty to keep the GGUF value.`
			: "Total experts for MoE models only — not active experts per layer. Leave empty (auto) for dense models.";

	// Live VRAM/RAM split. Rough by design: it follows the selected projector and
	// the device placement of KV cache and projector as the user changes them.
	const projectorBytes = projectorPath
		? (model.projectorCandidates?.find((candidate) => candidate.path === projectorPath)?.fileIdentity
				?.size ?? null)
		: null;
	const memory = config
		? estimateMemoryUsage({
				model: { ...model, mmprojPath: projectorPath || null },
				config,
				projectorBytes,
			})
		: null;
	const memoryTitle = memory
		? `GPU VRAM — weights ${formatMemory(memory.components.weightsVramMiB)}, KV cache ${formatMemory(memory.components.kvVramMiB)}, ` +
			`compute ${formatMemory(memory.components.computeMiB)}, projector ${formatMemory(memory.components.projectorVramMiB)}. ` +
			`System RAM — weights ${formatMemory(memory.components.weightsRamMiB)}, KV cache ${formatMemory(memory.components.kvRamMiB)}, ` +
			`projector ${formatMemory(memory.components.projectorRamMiB)}.`
		: undefined;

	const runLaunch = async (allowPartialOffload) => {
		if (busy || !config) return;
		setBusy(true);
		setError("");
		setVramWarning(null);
		try {
			const result = await window.api.launchEngine(model.id, {
				...config,
				mmprojPath: projectorPath || null,
				rememberSettings: remember,
				allowPartialOffload,
			});
			// The engine declined to load until the user acknowledges a likely
			// partial offload. Surface the advisory and let them decide.
			if (result?.requiresConfirmation) {
				setVramWarning(result.assessment);
				return;
			}
			if (!result?.success) throw new Error(result?.error || "Could not start the engine.");
			onLoaded(result);
			onClose();
		} catch (launchError) {
			setError(launchError.message);
		} finally {
			setBusy(false);
		}
	};

	const submit = async (event) => {
		event.preventDefault();
		if (busy || !config) return;
		if (!projectorPath && model.projectorCandidates?.length && !confirmTextOnly) {
			setConfirmTextOnly(true);
			return;
		}
		await runLaunch(false);
	};

	return (
		<dialog
			ref={dialog}
			aria-labelledby="load-settings-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
			className="aero-dialog sk-window sk-dialog fixed inset-0 m-auto h-[85dvh] max-h-[85dvh] w-[calc(100%-24px)] max-w-[1000px] overflow-clip p-0"
		>
			<form
				onSubmit={submit}
				className="flex h-full min-h-0 flex-col"
			>
				<header className="aero-header sk-window-header sk-texture-grain flex shrink-0 items-center justify-between gap-3 px-4 py-4">
					<div className="flex min-w-0 items-center gap-3">
                        <span className="aero-fill sk-fill grid size-9 shrink-0 place-items-center text-[var(--accent)]">
                            <LuSlidersHorizontal size={18} aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
						<h2
							id="load-settings-title"
							className="text-sm font-semibold"
						>
							Model load settings
						</h2>
						<Tooltip content={model.name || model.id}>
							<p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
								{model.generalName || model.name || model.id}
							</p>
						</Tooltip>
                        </div>
					</div>
					<button
						type="button"
						aria-label="Close settings"
						onClick={onClose}
						disabled={busy}
						className="aero-orb sk-icon-button aero-fill sk-fill size-7 cursor-pointer shrink-0"
					>
						<LuX
							size={17}
							aria-hidden="true"
						/>
					</button>
				</header>

				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
					<section className={`${cardClass} space-y-3`}>
						<SectionHeading Icon={LuCpu} title="Model information" />
						<dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 text-[11px]">
							{[
								["Architecture", model.architecture],
								["Declared context", model.contextLength],
								["Layers", model.layerCount],
								["Experts", model.expertCount],
							].map(([label, value]) => (
								<div
									key={label}
									className="min-w-0"
								>
									<dt className="text-[11px] leading-relaxed text-[var(--text-muted)]">{label}</dt>
									<dd className="truncate tabular-nums">{value ?? "—"}</dd>
								</div>
							))}
						</dl>
						<details className="group text-[11px] text-[var(--text-muted)]">
							<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 transition-colors hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
								More model metadata
								<LuChevronRight
									size={12}
									aria-hidden="true"
									className="transition-transform duration-200 group-open:rotate-90"
								/>
							</summary>
							<dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
								{[
									["Active experts per token", model.activeExpertCount],
									["Embedding size", model.embeddingLength],
									["Attention heads", model.attentionHeads],
									["KV heads", model.kvHeads],
									["MTP layers", model.mtpLayers ?? 0],
									["Expert layer indices", model.expertLayers?.join(", ")],
								].map(([label, value]) => (
									<div key={label}>
										<dt>{label}</dt>
										<dd className="break-words text-[var(--text-primary)]">
											{value ?? "Unknown"}
										</dd>
									</div>
								))}
							</dl>
						</details>
						<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
							Image: {model.declaredCapabilities?.image ? "inferred" : "unknown"} · Audio:{" "}
							{model.declaredCapabilities?.audio ? "inferred" : "unknown"} · Video: unknown.
							Media support is verified after loading. Declared context is not the runtime
							context.
						</p>
						{model.metadataError && (
							<p className="text-xs text-[var(--text-muted)]">
								Metadata could not be fully read: {model.metadataError}
							</p>
						)}
						{!!model.projectorCandidates?.length && (
							<SelectField
								label="Multimodal projector"
								value={projectorPath}
								disabled={busy}
								onChange={(event) => {
									setProjectorPath(event.target.value);
									setConfirmTextOnly(false);
									setProjectorNotice("");
								}}
								hint="The last-used projector is remembered automatically for this model. Choose its matching projector; the engine validates it during loading."
							>
								<option value="">None (text only)</option>
								{model.projectorCandidates.map((candidate) => (
									<option
										key={candidate.path}
										value={candidate.path}
									>
										{candidate.name}
										{candidate.error ? " (metadata unreadable)" : ""}
									</option>
								))}
							</SelectField>
						)}
					</section>

					{error && (
						<p
							role="alert"
							className="whitespace-pre-line break-words ui-radius-surface border border-[var(--error)] bg-[var(--surface)] p-3 text-[11px] leading-relaxed text-[var(--error)]"
						>
							{error}
						</p>
					)}
					{vramWarning && (
						<div
							role="alert"
							className="ui-radius-surface border border-[var(--accent)] bg-[var(--active-chat)] p-3 text-[11px] leading-relaxed text-[var(--text-primary)]"
						>
							<p className="flex items-start gap-2">
								<LuTriangleAlert
									size={15}
									className="mt-0.5 shrink-0 text-[var(--accent)]"
									aria-hidden="true"
								/>
								<span>{vramWarning.message}</span>
							</p>
							<div className="mt-2 flex items-center gap-2 pl-[23px]">
								<button
									type="button"
									disabled={busy}
									onClick={() => runLaunch(true)}
									className={secondaryButton}
								>
									Continue anyway
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() => {
										setVramWarning(null);
										onClose();
									}}
									className={secondaryButton}
								>
									Cancel load
								</button>
							</div>
						</div>
					)}
					{!config && !error && (
						<p
							role="status"
							className="text-sm text-[var(--text-secondary)]"
						>
							Loading saved settings…
						</p>
					)}

					{config && (
						<fieldset
							disabled={busy}
							className="grid min-w-0 items-start gap-3 sm:grid-cols-2 disabled:opacity-40"
						>
							<div className={`${cardClass} sm:col-span-2`}>
								<SectionHeading
									Icon={LuCpu}
									title="Compute & context"
									description="Tune how much the model can process at once."
								/>
								<div className="grid items-start gap-3 sm:grid-cols-2">
									{integerFields.map(([key, label, hint]) => (
										<NumberField
											key={key}
											label={label}
											hint={hint}
											required
											min={1}
											max={2147483647}
											step={1}
											value={config[key]}
											onChange={(event) =>
												update(
													key,
													event.target.value === ""
														? ""
														: Number(event.target.value),
												)
											}
										/>
									))}
									<div className="space-y-3">
										<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
											GPU offload layers
										</p>
										<CheckboxField
											label="Automatic"
											checked={config.gpuOffload === "auto"}
											onChange={(event) =>
												update("gpuOffload", event.target.checked ? "auto" : 0)
											}
										/>
										<NumberField
											label="Manual layer count"
											hint="Set 0 for CPU-only inference."
											required
											min={0}
											max={2147483647}
											step={1}
											disabled={config.gpuOffload === "auto"}
											value={config.gpuOffload === "auto" ? "" : config.gpuOffload}
											placeholder="Auto"
											onChange={(event) =>
												update(
													"gpuOffload",
													event.target.value === ""
														? ""
														: Number(event.target.value),
												)
											}
										/>
									</div>
								</div>
							</div>

							<div className={cardClass}>
								<SectionHeading
									Icon={LuLayers}
									title="Cache & attention"
									description="KV cache, host prompt snapshots, and attention behavior."
								/>
								<div className="grid gap-3">
									{[
										[
											"cacheTypeK",
											"K-Cache Precision",
											"Key cache precision. f16 is FP16 KV cache.",
										],
										[
											"cacheTypeV",
											"V-Cache Precision",
											"Value cache precision. Explicit K/V precision selections always take precedence.",
										],
									].map(([key, label, hint]) => (
										<SelectField
											key={key}
											label={label}
											hint={hint}
											value={config[key]}
											onChange={(event) => update(key, event.target.value)}
										>
											<option value="f16">f16</option>
											<option value="q8_0">q8_0</option>
											<option value="q4_0">q4_0</option>
										</SelectField>
									))}
									<SelectField
										label="KV Cache Offload"
										hint="Where the KV cache lives: GPU (default) or CPU. This is not cache precision — precision sets the data type, offload sets the device."
										value={config.kvCacheOffload}
										onChange={(event) => update("kvCacheOffload", event.target.value)}
									>
										<option value="gpu">GPU (default)</option>
										<option value="cpu">CPU</option>
									</SelectField>
									<NumberField
										label="Host prompt cache (MiB)"
										hint="System RAM budget for prompt snapshots. 0 disables snapshots (default); enter a positive value such as 2048 to reuse prompts across requests. Active KV reuse and context checkpoint settings are unchanged. Retained snapshots are excluded from the RAM estimate."
										min={0}
										max={2147483647}
										step={1}
										required
										value={config.promptCacheMiB}
										onChange={(event) => update("promptCacheMiB", event.target.value === "" ? "" : Number(event.target.value))}
									/>
									<SelectField
										label="Flash attention"
										value={config.flashAttention}
										onChange={(event) => update("flashAttention", event.target.value)}
										className="z-9999"
									>
										<option value="auto">Auto</option>
										<option value="on">On</option>
										<option value="off">Off</option>
									</SelectField>
								</div>
							</div>

							<div className={cardClass}>
								<SectionHeading
									Icon={LuHardDrive}
									title="Model loading & memory"
									description="How model weights are read into memory for this model."
								/>
								<div className="grid gap-3">
									<SelectField
										label="Load Mode"
										hint="Auto keeps llama-server's default memory mapping. 'none' disables mmap-style model loading (recommended when tensors are pinned to CPU); mlock variants keep weights resident in RAM."
										value={config.loadMode}
										onChange={(event) => changeLoadMode(event.target.value)}
									>
										<option value="auto">Auto</option>
										<option value="mmap">mmap</option>
										<option value="none">none</option>
										<option value="mlock">mlock</option>
										<option value="mmap+mlock">mmap + mlock</option>
										<option value="dio">Direct I/O</option>
									</SelectField>
									<CheckboxField
										label="Lock in System RAM (mlock)"
										hint={
											mlockControlled
												? "Controlled by the Load Mode selection above."
												: "Keep model weights resident in RAM."
										}
										checked={config.mlock}
										disabled={mlockControlled}
										onChange={(event) => update("mlock", event.target.checked)}
									/>
									{(!!model.projectorCandidates?.length || !!projectorPath) && (
										<CheckboxField
											label="Offload vision projector to GPU"
											hint="Uncheck to keep the multimodal projector on the CPU (llama-server --no-mmproj-offload). This frees the projector's VRAM at the cost of slower image encoding; text generation is unaffected."
											checked={config.mmprojOffload}
											onChange={(event) =>
												update("mmprojOffload", event.target.checked)
											}
										/>
									)}
									<NumberField
										label="MoE Expert Count"
										hint={expertHint}
										min={1}
										max={2147483647}
										step={1}
										placeholder="Auto"
										disabled={!model.architecture}
										value={config.moeExpertCount ?? ""}
										onChange={(event) =>
											update(
												"moeExpertCount",
												event.target.value === "" ? null : Number(event.target.value),
											)
										}
									/>
									<CheckboxField
										label="Multi-token prediction (MTP)"
										hint={
											model.mtpLayers > 0
												? `Use the ${model.mtpLayers} built-in nextn layer(s) as a speculative draft head (llama-server --spec-type draft-mtp). This can speed up generation with no separate draft model. The MTP layer costs a little extra KV cache.`
												: "This GGUF has no MTP/nextn layers, so the setting has no effect."
										}
										checked={!!config.mtp}
										disabled={!model.mtpLayers}
										onChange={(event) => update("mtp", event.target.checked)}
									/>
								</div>
							</div>

							<div className={`${cardClass} sm:col-span-2`}>
								<SectionHeading
									Icon={LuSlidersHorizontal}
									title="Template & sampling"
									description="Per-model defaults for templating and generation."
								/>
								<div className="grid items-start gap-3 sm:grid-cols-2">
									<SelectField
										label="Chat Template"
										value={config.chatTemplate}
										onChange={(event) => update("chatTemplate", event.target.value)}
									>
										<option value="auto">Default (GGUF Embedded)</option>
										<option value="llama3">Llama 3</option>
										<option value="chatml">ChatML</option>
										<option value="deepseek">DeepSeek / R1</option>
										<option value="gemma">Gemma</option>
									</SelectField>
									<SelectField
										label="Reasoning Format"
										value={config.reasoningFormat}
										onChange={(event) => update("reasoningFormat", event.target.value)}
									>
										<option value="auto">Auto</option>
										<option value="deepseek">DeepSeek</option>
										<option value="none">None</option>
									</SelectField>
									<NumberField
										label="Seed"
										hint="Optional. Leave empty to use the server default."
										min={-1}
										max={4294967295}
										step={1}
										placeholder="Server default"
										value={config.seed ?? ""}
										onChange={(event) =>
											update(
												"seed",
												event.target.value === "" ? null : Number(event.target.value),
											)
										}
									/>
								</div>
							</div>
						</fieldset>
					)}
				</div>

				{(confirmTextOnly || projectorNotice) && (
					<div
						role="alert"
						className="shrink-0 border-t border-[var(--border)] bg-[var(--active-chat)] px-4 py-3 text-[11px] leading-relaxed text-[var(--text-primary)]"
					>
						{projectorNotice && <p>{projectorNotice}</p>}
						{confirmTextOnly && (
							<p>
								A multimodal projector is available, but none is selected. Multimodal input
								will be unavailable. Choose a projector above, or click{" "}
								<strong>Load text only</strong> to continue.
							</p>
						)}
					</div>
				)}

				{config && memory && (
					<Tooltip content={memoryTitle}>
						<div className="aero-footer sk-window-footer flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-[11px]">
							<span className="inline-flex items-center gap-1.5">
								<LuCpu
									size={13}
									className="text-[var(--accent)]"
									aria-hidden="true"
								/>
								<span className="text-[var(--text-muted)]">GPU VRAM</span>
								<strong className="tabular-nums">{formatMemory(memory.vramMiB)}</strong>
							</span>
							<span className="inline-flex items-center gap-1.5">
								<LuHardDrive
									size={13}
									className="text-[var(--accent)]"
									aria-hidden="true"
								/>
								<span className="text-[var(--text-muted)]">System RAM</span>
								<strong className="tabular-nums">{formatMemory(memory.ramMiB)}</strong>
							</span>
							<span className="text-[11px] leading-relaxed text-[var(--text-muted)]">
									rough estimate · excludes host prompt snapshots and runtime/OS/driver overhead
								{memory.confidence !== "high" || memory.ramIncomplete
									? " · some sizes unknown"
									: ""}
							</span>
						</div>
					</Tooltip>
				)}

				<footer className="aero-footer sk-window-footer flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 py-3">
					<div className="mr-auto">
						<CheckboxField
							label="Remember settings for this model"
							disabled={busy || !config}
							checked={remember}
							onChange={(event) => setRemember(event.target.checked)}
						/>
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={onClose}
						className={secondaryButton}
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={busy || !config}
						className="aero-primary sk-button sk-primary inline-flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-semibold"
					>
						{busy ? (
							<LuSparkles
								size={16}
								aria-hidden="true"
							/>
						) : (
							<LuPlay
								size={16}
								aria-hidden="true"
							/>
						)}
						{busy ? "Starting…" : confirmTextOnly ? "Load text only" : "Load model"}
					</button>
				</footer>
			</form>
		</dialog>
	);
}

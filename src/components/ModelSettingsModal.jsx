import React, { useEffect, useRef, useState } from "react";
import { LuCpu, LuHardDrive, LuLayers, LuPlay, LuSlidersHorizontal, LuSparkles, LuTriangleAlert, LuX } from "react-icons/lu";
import { NumberField as BaseNumberField, SelectField as BaseSelectField } from "./FormControls";
import Tooltip from "./Tooltip";

const integerFields = [
	["contextLength", "Context length", "Total context tokens shared across concurrent predictions."],
	["threads", "CPU threads", "CPU thread pool size."],
	["evalBatch", "Evaluation batch size", "Maximum logical batch size."],
	["physicalBatch", "Physical batch size", "Must not exceed the evaluation batch size."],
	["parallel", "Concurrent predictions", "Maximum simultaneous predictions."],
];

// Compact presentation is scoped to this modal; shared controls keep their behavior.
function CompactField({ Component, hint, ...props }) {
	return (
		<Tooltip
			content={hint}
			placement="top"
			delay={350}
		>
			<div className="min-w-0 [&>div]:grid [&>div]:grid-cols-[minmax(0,1fr)_120px] [&>div]:items-center [&>div]:gap-3 [&>div>label]:mb-0 [&>div>label]:text-[11px] [&>div>label]:font-normal [&_input]:text-xs [&_input]:py-1 [&_input]:px-2 [&_button]:text-[11px] [&_p]:sr-only">
				<Component
					{...props}
					hint={hint}
				/>
			</div>
		</Tooltip>
	);
}

function NumberField(props) {
	return (
		<CompactField
			Component={BaseNumberField}
			{...props}
		/>
	);
}
function SelectField(props) {
	return (
		<CompactField
			Component={BaseSelectField}
			{...props}
		/>
	);
}
function CheckboxField({ label, hint, disabled, ...props }) {
	return (
		<label
			title={hint}
			className={`flex min-h-8 cursor-pointer items-center justify-between gap-3 text-[11px] ${disabled ? "opacity-40" : ""}`}
		>
			<span>{label}</span>
			<input
				{...props}
				type="checkbox"
				disabled={disabled}
				className="size-3.5 accent-[var(--accent)]"
			/>
		</label>
	);
}
function SectionHeading({ Icon, title, description }) {
	return (
		<h3
			title={description}
			className="mb-3 flex items-center gap-2 text-[11px] font-semibold text-[var(--text-secondary)]"
		>
			<Icon
				size={14}
				className="text-[var(--accent)]"
				aria-hidden="true"
			/>
			{title}
		</h3>
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
						loadMode: "auto",
						moeExpertCount: null,
						...savedConfig,
						reasoningFormat: remembered
							? (savedConfig.reasoningFormat ?? "auto")
							: (model.reasoningFormat ?? "auto"),
					});
					setRemember(remembered);
                    if (savedProjector !== undefined) {
                        const available = savedProjector === null || savedProjector === model.mmprojPath || model.projectorCandidates?.some(candidate => candidate.path === savedProjector);
                        setProjectorPath(available ? savedProjector || '' : '');
                        if (!available) setProjectorNotice('The last-used projector is no longer in the scanned files. Choose a projector or rescan.');
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
			className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-24px)] max-w-[880px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60"
		>
			<form
				onSubmit={submit}
				className="flex max-h-[85dvh] flex-col"
			>
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3.5">
					<div className="min-w-0">
						<h2
							id="load-settings-title"
							className="text-sm font-semibold"
						>
							Model load settings
						</h2>
						<p
							title={model.name || model.id}
							className="mt-1 truncate text-[11px] text-[var(--text-muted)]"
						>
							{model.generalName || model.name || model.id}
						</p>
					</div>
					<button
						type="button"
						aria-label="Close settings"
						onClick={onClose}
						disabled={busy}
						className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
					>
						<LuX
							size={17}
							aria-hidden="true"
						/>
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
					<section className="mb-4 space-y-2 border-b border-[var(--border)] pb-3">
						<h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
							Model information
						</h3>
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
									<dt className="text-[10px] text-[var(--text-muted)]">{label}</dt>
									<dd className="truncate tabular-nums">{value ?? "—"}</dd>
								</div>
							))}
						</dl>
						<details className="text-[10px] text-[var(--text-muted)]">
							<summary className="cursor-pointer">More model metadata</summary>
							<dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
								{[
									["Active experts per token", model.activeExpertCount],
									["Embedding size", model.embeddingLength],
									["Attention heads", model.attentionHeads],
									["KV heads", model.kvHeads],
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
						<p className="text-[10px] text-[var(--text-muted)]">
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
								onChange={(event) => { setProjectorPath(event.target.value); setConfirmTextOnly(false); setProjectorNotice(""); }}
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
							className="mb-3 rounded-lg border border-[var(--error)] px-3 py-2 text-xs text-[var(--error-strong)]"
						>
							{error}
						</p>
					)}
					{vramWarning && (
						<div
							role="alert"
							className="mb-3 rounded-lg border border-[var(--accent)] bg-[var(--active-chat)] px-3 py-2 text-xs text-[var(--text-primary)]"
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
									className="cursor-pointer rounded-md border border-[var(--control-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
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
									className="cursor-pointer rounded-md px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
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
							className="grid gap-x-6 gap-y-4 sm:grid-cols-2 disabled:opacity-60"
						>
							<div className="border-b border-[var(--border)] pb-4 sm:col-span-2">
								<SectionHeading
									Icon={LuCpu}
									title="Compute & context"
									description="Tune how much the model can process at once."
								/>
								<div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
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
									<div className="space-y-1">
										<p className="text-[10px] text-[var(--text-muted)]">
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

							<div className="border-b border-[var(--border)] pb-4">
								<SectionHeading
									Icon={LuLayers}
									title="Cache & attention"
									description="KV cache precision, placement, and attention behavior."
								/>
								<div className="grid gap-y-2">
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

							<div className="border-b border-[var(--border)] pb-4">
								<SectionHeading
									Icon={LuHardDrive}
									title="Model loading & memory"
									description="How model weights are read into memory for this model."
								/>
								<div className="grid gap-y-2">
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
								</div>
							</div>

							<div className="border-b border-[var(--border)] pb-4 sm:col-span-2">
								<SectionHeading
									Icon={LuSlidersHorizontal}
									title="Template & sampling"
									description="Per-model defaults for templating and generation."
								/>
								<div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
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

                {(confirmTextOnly || projectorNotice) && <div role="alert" className="shrink-0 border-t border-[var(--border)] bg-[var(--active-chat)] px-5 py-3 text-xs text-[var(--text-primary)]">
                    {projectorNotice && <p>{projectorNotice}</p>}
                    {confirmTextOnly && <p>A multimodal projector is available, but none is selected. Multimodal input will be unavailable. Choose a projector above, or click <strong>Load text only</strong> to continue.</p>}
                </div>}

				<footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
					<div className="mr-auto">
						<CheckboxField
							label="Remember settings for this model"
							hint="Use these values the next time you load this model."
							disabled={busy || !config}
							checked={remember}
							onChange={(event) => setRemember(event.target.checked)}
						/>
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={onClose}
						className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40 cursor-pointer duration-300"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={busy || !config}
						className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40 cursor-pointer duration-300"
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

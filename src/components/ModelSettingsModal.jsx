import React, { useEffect, useRef, useState } from "react";
import { LuCpu, LuHardDrive, LuLayers, LuPlay, LuSettings2, LuSlidersHorizontal, LuSparkles, LuX } from "react-icons/lu";
import { CheckboxField, NumberField, SelectField } from "./FormControls";

const integerFields = [
	["contextLength", "Context length", "Total context tokens shared across concurrent predictions."],
	["threads", "CPU threads", "CPU thread pool size."],
	["evalBatch", "Evaluation batch size", "Maximum logical batch size."],
	["physicalBatch", "Physical batch size", "Must not exceed the evaluation batch size."],
	["parallel", "Concurrent predictions", "Maximum simultaneous predictions."],
];

function SectionHeading({ Icon, title, description }) {
	return (
		<div className="flex items-start gap-3">
			<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--active-chat)] text-[var(--accent)]">
				<Icon
					size={18}
					aria-hidden="true"
				/>
			</span>
			<div>
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
				<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
			</div>
		</div>
	);
}

export default function ModelSettingsModal({ model, onClose, onLoaded }) {
	const dialog = useRef(null);
	const [config, setConfig] = useState(null);
	const [remember, setRemember] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		const element = dialog.current;
		element.showModal();
		let active = true;
		setConfig(null);
		setError("");
		window.api
			.getModelLoadConfig(model.id)
			.then(({ config: savedConfig, remembered }) => {
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

	const update = (key, value) => setConfig((previous) => ({ ...previous, [key]: value }));

	// The mlock checkbox mirrors the Load Mode selection so the two controls can
	// never ask the server for contradictory loading behavior.
	const changeLoadMode = (value) =>
		setConfig((previous) => ({
			...previous,
			loadMode: value,
			mlock:
				value === "auto"
					? previous.mlock
					: ["mlock", "mmap+mlock"].includes(value),
		}));

	const mlockControlled = !!config && config.loadMode !== "auto";
	const expertHint = !model.architecture
		? "Model architecture is unknown, so an explicit expert count cannot be forwarded to the server."
		: model.isMoe && model.expertCount
			? `Total experts for MoE models only; this model reports ${model.expertCount}. Leave empty to keep the GGUF value.`
			: "Total experts for MoE models only — not active experts per layer. Leave empty (auto) for dense models.";

	const submit = async (event) => {
		event.preventDefault();
		if (busy || !config) return;
		setBusy(true);
		setError("");
		try {
			const result = await window.api.launchEngine(model.id, { ...config, rememberSettings: remember });
			if (!result?.success) throw new Error(result?.error || "Could not start the engine.");
			onLoaded(result);
			onClose();
		} catch (launchError) {
			setError(launchError.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<dialog
			ref={dialog}
			aria-labelledby="load-settings-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
			className="fixed inset-0 m-auto max-h-[min(90dvh,900px)] w-[calc(100%-24px)] max-w-2xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60"
		>
			<form
				onSubmit={submit}
				className="flex max-h-[min(90dvh,900px)] flex-col"
			>
				<header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-5 sm:px-6">
					<div className="flex min-w-0 items-start gap-3">
						<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--active-chat)] text-[var(--accent)]">
							<LuSettings2
								size={20}
								aria-hidden="true"
							/>
						</span>
						<div className="min-w-0">
							<h2
								id="load-settings-title"
								className="text-base font-semibold sm:text-lg"
							>
								Advanced load settings
							</h2>
							<p className="mt-1 break-all text-xs leading-relaxed text-[var(--text-secondary)]">
								{model.name || model.id}
							</p>
							{model.isVision && (
								<p className="mt-1 break-all text-[11px] text-[var(--text-muted)]">
									Vision projector: {model.mmprojPath?.split(/[\\/]/).pop()}
								</p>
							)}
						</div>
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

				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
					{error && (
						<p
							role="alert"
							className="mb-4 rounded-xl border border-[var(--error)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--error-strong)]"
						>
							{error}
						</p>
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
							className="space-y-5 disabled:opacity-60"
						>
							<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
								<SectionHeading
									Icon={LuCpu}
									title="Compute & context"
									description="Tune how much the model can process at once."
								/>
								<div className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-2">
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
										<p className="text-xs font-semibold">GPU offload layers</p>
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

							<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
								<SectionHeading
									Icon={LuLayers}
									title="Cache & attention"
									description="KV cache precision, placement, and attention behavior."
								/>
								<div className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-2">
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

							<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
								<SectionHeading
									Icon={LuHardDrive}
									title="Model loading & memory"
									description="How model weights are read into memory for this model."
								/>
								<div className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-2">
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

							<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
								<SectionHeading
									Icon={LuSlidersHorizontal}
									title="Template & sampling"
									description="Per-model defaults for templating and generation."
								/>
								<div className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-2">
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

							<CheckboxField
								label="Remember settings for this model"
								hint="Use these values the next time you load this model."
								checked={remember}
								onChange={(event) => setRemember(event.target.checked)}
							/>
						</fieldset>
					)}
				</div>

				<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-4 sm:px-6">
					<button
						type="button"
						disabled={busy}
						onClick={onClose}
						className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={busy || !config}
						className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40"
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
						{busy ? "Starting…" : "Load model"}
					</button>
				</footer>
			</form>
		</dialog>
	);
}

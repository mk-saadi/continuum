import React, { useEffect, useRef, useState } from "react";
import ModelSettingsModal from "../ModelSettingsModal";
import { LuArrowRight, LuBrain, LuEye, LuWrench, LuX } from "react-icons/lu";
import { BsRobot } from "react-icons/bs";

export default function ModelSelectorModal({
	models,
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
	const configuredProviders = cloudProviders.filter(row => (row.category ?? 'text') === 'text' && row.configured && row.modelId?.trim());
	const [query, setQuery] = useState("");
	const [configuring, setConfiguring] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		const previous = document.activeElement;
		element.showModal();
		return () => {
			element.close();
			previous?.focus();
		};
	}, [configuring]);
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
			className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-24px)] max-w-2xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60"
		>
			<header className="flex items-center justify-between border-b border-[var(--border)] p-4">
				<h2
					id="model-selector-title"
					className="font-semibold"
				>
					Select Chat Model
				</h2>
				<button
					type="button"
					aria-label="Close model selector"
					disabled={busy}
					onClick={onClose}
					className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
				>
					<LuX aria-hidden="true" />
				</button>
			</header>
					<div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
						<span><strong className="block">Local Engine Status</strong>{loadedLocalModel?.name || (engineRunning ? "Loading local model…" : "No local model loaded")}</span>
						<button
							type="button"
							disabled={busy || !engineRunning}
							className="flex ml-3 shrink-0 items-center justify-center rounded-md px-3 py-2 active:translate-y-0.5 border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
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
					</div>
			<div className="space-y-3 p-4">
				<div className="flex gap-2">
					<input
						autoFocus
						aria-label="Search models"
						placeholder="Search local models…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm"
					/>
					<button
						type="button"
						disabled={scanning}
						onClick={onScan}
						className={`flex shrink-0 px-3 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300 ${
							scanning ? "disabled:cursor-not-allowed! cursor-not-allowed" : "cursor-pointer"
						}`}
					>
						{scanning ? "Scanning…" : "Rescan"}
					</button>
				</div>

				{(error || serverError) && (
					<p
						role="alert"
						className="text-xs text-[var(--error)]"
					>
						{error || serverError}
					</p>
				)}
				<section aria-label="Cloud Models" className="space-y-2">
                    <h3 className="text-sm font-semibold">Cloud Models</h3>
                    {!configuredProviders.length && <p className="text-xs text-[var(--text-secondary)]">No cloud providers configured. Add one in Settings.</p>}
                    {configuredProviders.map(row => <button key={row.id} type="button" disabled={busy}
                        onClick={() => { onSelectProvider({ type: 'cloud', provider: row.id, model: row.modelId }); onClose(); }}
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3 text-left text-sm hover:bg-[var(--surface-hover)] disabled:opacity-50">
                        <span>{row.name}<span className="block text-xs text-[var(--text-secondary)]">{row.modelId}</span></span>
                        <span className="text-xs">{activeChatProvider?.provider === row.id && activeChatProvider?.model === row.modelId ? 'Active' : 'Use for chat'}</span>
                    </button>)}
                </section>
                <h3 className="text-sm font-semibold">Local Models</h3>
                <div className="space-y-2">
					{models
						.filter(
							(model) =>
								!/mmproj/i.test(
									(model.modelPath || model.path || model.name || model.id)
										.split(/[\\/]/)
										.pop(),
								),
						)
						.filter((model) =>
							(model.name || model.id).toLowerCase().includes(query.toLowerCase()),
						)
						.map((model) => (
							<button
								key={model.id}
								type="button"
								disabled={busy}
								onClick={() => {
									if (loadedLocalModel?.modelPath === (model.modelPath || model.path || model.id)) {
                                        onSelectModel(model.id);
                                        onSelectProvider({ type: 'local' });
                                        onClose();
                                    } else setConfiguring(model);
								}}
								className="flex w-full items-center justify-between gap-4 rounded-lg cursor-pointer border border-[var(--border)] px-3 py-2 duration-300 text-left hover:bg-[var(--surface-hover)] disabled:opacity-50"
							>
								<span className="min-w-0">
									<span className="block break-all text-xs line-clamp-1!">
										{model.name || model.id}
									</span>
									<span className="my-1.5 flex flex-wrap gap-1.5 text-[10px] text-[var(--text-secondary)]">
										{[
											[model.hasVision || model.isVision, LuEye, "Vision"],
											[model.hasTools, LuWrench, "Tools"],
											[model.hasReasoning, LuBrain, "Reasoning"],
										]
											.filter(([enabled]) => enabled)
											.map(([, Icon, label]) => (
												<span
													key={label}
													className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5"
												>
													<Icon aria-hidden="true" />
													{label}
												</span>
											))}
										{[model.paramSize, model.quantization, model.sizeFormatted]
											.filter(Boolean)
											.map((value) => (
												<span
													key={value}
													className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 text-[var(--text-muted)]"
												>
													{value}
												</span>
											))}
									</span>
									{/* <span className="text-[11px] text-[var(--text-muted)]">
										{model.id === selectedModel ? "Selected" : ""}
									</span> */}
								</span>
								<span aria-hidden="true">
									<LuArrowRight />
								</span>
							</button>
						))}
				</div>
				{!models.length && (
					<div className="flex flex-col w-full items-center gap-3 mt-6">
						<p className="text-[var(--text-muted)]">
							<BsRobot size={40} />
						</p>
						<p className="text-sm text-[var(--text-muted)]">
							No local models found. Scan to refresh the list.
						</p>
					</div>
				)}
			</div>
		</dialog>
	);
}

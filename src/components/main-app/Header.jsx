import React, { useState } from "react";
import { FaBars, FaCog, FaEject, FaSlidersH } from "react-icons/fa";
import { FiChevronDown } from "react-icons/fi";
import { LuFolder, LuHouse } from "react-icons/lu";

import { buildContextLabel, buildContextTooltip } from "../../lib/contextDisplay.mjs";
import { useLeftSidebar, useModalActions, useRightSidebar } from "../../context/UIStateContext.jsx";
import Tooltip from "../Tooltip";

export default function Header({
	isSidebarOpen: isSidebarOpenProp,
	onToggleSidebar: onToggleSidebarProp,
	isRightSidebarOpen: isRightSidebarOpenProp,
	onToggleRightSidebar: onToggleRightSidebarProp,
	modelName,
	modelId,
	isCloud = false,
	engineRunning,
	contextStatus,
	loadWarning = null,
	onOpenModels: onOpenModelsProp,
	onUnloadModel,
	palace,
	onOpenSettings: onOpenSettingsProp,
	workspace = null,
}) {
	// Chrome state comes from context in the real app; the explicit props remain
	// supported so Header can still be rendered standalone in tests.
	const leftSidebar = useLeftSidebar();
	const rightSidebar = useRightSidebar();
	const modals = useModalActions();
	const isSidebarOpen = isSidebarOpenProp ?? leftSidebar?.open ?? false;
	const onToggleSidebar = onToggleSidebarProp ?? leftSidebar?.toggle;
	const isRightSidebarOpen = isRightSidebarOpenProp ?? rightSidebar?.open ?? false;
	const onToggleRightSidebar = onToggleRightSidebarProp ?? rightSidebar?.toggle;
	const onOpenModels = onOpenModelsProp ?? modals?.openModelSelector;
	const onOpenSettings = onOpenSettingsProp ?? modals?.openSettings;
	// Primary figure: tokenizer-measured prepared prompt when available,
	// otherwise the legacy DB estimate. Older palace stubs (tests) only
	// provide totalTokens/pluginTokens, which keep working unchanged.
	const hasContext = palace.contextTokens !== undefined;
	const total = hasContext
		? (palace.contextTokens ?? null)
		: palace.totalTokens === null
			? null
			: palace.totalTokens + (palace.pluginTokens || 0);
	const { label: contextLabel } = buildContextLabel({ total, limit: palace.limit, error: palace.error, isCloud });

  const label = palace.contextMode ? `${contextLabel} · ${palace.contextMode}` : contextLabel;
	const live = palace.liveTelemetry ?? null;
	const persisted = palace.turnTelemetry ?? null;

	const tooltip = buildContextTooltip({
		total,
		limit: palace.limit,
		error: palace.error,
		isCloud,
		method: hasContext ? palace.contextMethod : undefined,
		confidence: hasContext ? palace.contextConfidence : undefined,
		live,
		persisted,
        budgetContract: palace.budgetContract,
        prepared: palace.preparedContextTokens,
	});

	const percent = total !== null && palace.limit ? Math.min(100, (total / palace.limit) * 100) : 0;
	const button =
		"aero-orb sk-icon-button aero-fill sk-fill size-7 cursor-pointer shrink-0";

	const [ejecting, setEjecting] = useState(false);
	const canEject = !isCloud && engineRunning && !!modelId && typeof onUnloadModel === "function";
	const ejectModel = async () => {
		if (!canEject || ejecting) return;
		setEjecting(true);
		try {
			await onUnloadModel(modelId);
		} catch {
			// The App-level handler already reports the failure; the status
			// event remains the source of truth for whether the model unloaded.
		} finally {
			setEjecting(false);
		}
	};

	return (
		<header className="aero-header sk-window-header sk-texture-grain relative flex h-9 shrink-0 items-center gap-3 px-3">
			<button
				type="button"
				className={button}
				aria-label="Toggle chat history"
				aria-expanded={isSidebarOpen}
				aria-pressed={isSidebarOpen}
				aria-controls="chat-sidebar"
				onClick={onToggleSidebar}
			>
				<FaBars />
			</button>

			{workspace ? (
				<div className="flex min-w-0 items-center gap-1.5">
					<button
						type="button"
						className="aero-orb sk-icon-button aero-fill sk-fill size-7 shrink-0 cursor-pointer"
						aria-label="Workspace Home"
						title="Workspace Home"
						onClick={workspace.onOpenHome}
					>
						<LuHouse className="size-3.5" />
					</button>
					{workspace.name && (
						<>
							<span
								aria-hidden="true"
								className="text-xs text-[var(--text-muted)]"
							>
								|
							</span>
							<button
								type="button"
								className="aero-control sk-button aero-fill sk-fill flex min-h-7 min-w-0 max-w-44 cursor-pointer items-center gap-1.5 px-1.5 py-1 text-xs text-[var(--text-primary)] max-[700px]:max-w-24"
								aria-label="Open workspace"
								title="Open workspace"
								onClick={workspace.onOpenWorkspace}
							>
								<LuFolder className="size-3.5 shrink-0" />
								<span className="truncate">{workspace.name}</span>
							</button>
						</>
					)}
				</div>
			) : (
				<span className="truncate text-xs font-medium text-[var(--text-primary)]">Chat</span>
			)}

			{/* Absolutely centered relative to the whole header, not the remaining flex space */}
			<div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 px-32 max-[600px]:px-20">
				<button
					type="button"
					onClick={onOpenModels}
					className="aero-control sk-button aero-fill sk-fill pointer-events-auto group flex min-w-0 max-w-md items-center gap-2 px-4 py-1 text-xs cursor-pointer"
					aria-label="Select or load model"
					aria-haspopup="dialog"
				>
					<span
						className={`size-2 shrink-0 ui-radius-round ${engineRunning ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]"}`}
					/>
					<span className="truncate">{modelName || "Select Model"}</span>
					{!isCloud && !engineRunning && modelName && (
						<span className="shrink-0 text-[10px] text-[var(--text-muted)]">Not loaded</span>
					)}
					{isCloud && (
						<span className="shrink-0 text-[10px] text-[var(--text-secondary)]">Cloud</span>
					)}
					{!isCloud && engineRunning && (
						<span
							role="status"
							className="shrink-0 text-[10px] text-[var(--text-secondary)]"
						>
							{contextStatus === "ready"
								? "Ready"
								: contextStatus === "warming"
									? "Warming up context..."
									: contextStatus === "warmup-failed"
										? "Warmup failed"
										: "Loading model..."}
						</span>
					)}
					{!isCloud && engineRunning && loadWarning && (
						<span
							role="status"
							aria-label="Partial GPU offload"
							title={loadWarning}
							className="shrink-0 text-[10px] font-medium text-[var(--error)]"
						>
							CPU offload
						</span>
					)}
					<span
						aria-hidden="true"
					>
						<FiChevronDown />
					</span>
				</button>
				{canEject && (
					<Tooltip content={ejecting ? "Unloading model..." : "Unload model"}>
						<button
							type="button"
							onClick={ejectModel}
							disabled={ejecting}
							className={`${button} pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40`}
							aria-label="Unload model"
						>
							<FaEject className="size-3.5" aria-hidden="true" />
						</button>
					</Tooltip>
				)}
			</div>

			{/* Spacer to keep the right-side group pushed right, now that the center div is absolute */}
			<div className="flex-1" />

			<Tooltip content={tooltip}>
				<div className="w-44 shrink-0 text-[10px] text-[var(--text-secondary)] max-[700px]:w-28">
					<span className="block truncate">{label}</span>
					<div
						role="progressbar"
						aria-label="Context usage"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={palace.limit && total !== null ? Math.round(percent) : undefined}
						aria-valuetext={tooltip}
						className="aero-track sk-track mt-1 h-1"
					>
						<div
							className="aero-track__fill sk-track-fill h-full transition-[width] motion-reduce:transition-none"
							style={{ width: `${percent}%` }}
						/>
					</div>
				</div>
			</Tooltip>
			<button
				type="button"
				className={button}
				aria-label="Open settings"
				onClick={onOpenSettings}
			>
				<FaCog />
			</button>
			<button
				type="button"
				className={button}
				aria-label="Toggle chat controls"
				aria-expanded={isRightSidebarOpen}
				aria-pressed={isRightSidebarOpen}
				aria-controls="right-sidebar"
				onClick={onToggleRightSidebar}
			>
				<FaSlidersH />
			</button>
		</header>
	);
}

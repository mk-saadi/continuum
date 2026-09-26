import React from "react";
import { FaBars, FaCog, FaSlidersH } from "react-icons/fa";
import { FiChevronDown } from "react-icons/fi";

export default function Header({
	isSidebarOpen,
	onToggleSidebar,
	isRightSidebarOpen,
	onToggleRightSidebar,
	modelName,
	engineRunning,
    contextStatus,
	onOpenModels,
	palace,
	onOpenSettings,
}) {
	const total = palace.totalTokens === null ? null : palace.totalTokens + (palace.pluginTokens || 0);
	const label =
		palace.limit === null
			? "Context: Not Loaded"
			: palace.error
				? "Context unavailable"
				: `${total === null ? "—" : total.toLocaleString()} / ${palace.limit.toLocaleString()} tokens`;
	const percent = total !== null && palace.limit ? Math.min(100, (total / palace.limit) * 100) : 0;
	const button =
		"flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300";

	return (
		<header className="relative flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3">
			<button
				type="button"
				className={button}
				aria-label="Toggle chat history"
				aria-expanded={isSidebarOpen}
				aria-controls="chat-sidebar"
				onClick={onToggleSidebar}
			>
				<FaBars />
			</button>

			{/* Absolutely centered relative to the whole header, not the remaining flex space */}
			<div className="pointer-events-none absolute inset-0 flex items-center justify-center px-32 max-[600px]:px-20">
				<button
					type="button"
					onClick={onOpenModels}
					className="pointer-events-auto group flex min-w-0 max-w-md items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--input)] px-4 py-1 text-xs cursor-pointer hover:bg-[var(--surface-hover)] duration-300"
					aria-label="Select or load model"
				>
					<span
						className={`size-2 shrink-0 rounded-full ${engineRunning ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]"}`}
					/>
					<span className="truncate">{modelName || "Select Model"}</span>
                    {!engineRunning && modelName && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">Not loaded</span>}
                    {engineRunning && <span role="status" className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                        {contextStatus === "ready" ? "Ready" : contextStatus === "warming" ? "Warming up context..." : contextStatus === "warmup-failed" ? "Warmup failed" : "Loading model..."}
                    </span>}
					<span
						aria-hidden="true"
						className="group-active:translate-y-0.5 duration-300"
					>
						<FiChevronDown />
					</span>
				</button>
			</div>

			{/* Spacer to keep the right-side group pushed right, now that the center div is absolute */}
			<div className="flex-1" />

			<div
				title={label}
				className="w-44 shrink-0 text-[10px] text-[var(--text-secondary)] max-[700px]:w-28"
			>
				<span className="block truncate">{label}</span>
				<div
					role="progressbar"
					aria-label="Estimated context usage"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={palace.limit && total !== null ? Math.round(percent) : undefined}
					aria-valuetext={label}
					className="mt-1 h-1 overflow-hidden rounded bg-[var(--surface-hover)]"
				>
					<div
						className="h-full bg-[var(--accent)] transition-[width]"
						style={{ width: `${percent}%` }}
					/>
				</div>
			</div>
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
				aria-controls="right-sidebar"
				onClick={onToggleRightSidebar}
			>
				<FaSlidersH />
			</button>
		</header>
	);
}

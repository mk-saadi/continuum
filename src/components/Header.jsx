import React from "react";
import { FaBars, FaCog, FaSlidersH } from "react-icons/fa";

export default function Header({
	isSidebarOpen,
	onToggleSidebar,
	isRightSidebarOpen,
	onToggleRightSidebar,
	modelName,
	engineRunning,
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
		"flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
	return (
		<header className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3">
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
			<div className="flex min-w-0 flex-1 justify-center">
				<button
					type="button"
					onClick={onOpenModels}
					className="flex min-w-0 max-w-md items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--input)] px-4 py-1 text-xs"
					aria-label="Select or load model"
				>
					<span
						className={`size-2 shrink-0 rounded-full ${engineRunning ? "bg-emerald-400" : "bg-[var(--text-muted)]"}`}
					/>
					<span className="truncate">{modelName || "Select / Load Model"}</span>
					<span aria-hidden="true">⌄</span>
				</button>
			</div>
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
				aria-label="Toggle chat controls"
				aria-expanded={isRightSidebarOpen}
				aria-controls="right-sidebar"
				onClick={onToggleRightSidebar}
			>
				<FaSlidersH />
			</button>
			<button
				type="button"
				className={button}
				aria-label="Open settings"
				onClick={onOpenSettings}
			>
				<FaCog />
			</button>
		</header>
	);
}

import React, { useSyncExternalStore } from "react";
import { LuTerminal } from "react-icons/lu";
import { terminalLogStore } from "../lib/terminalLogStore.mjs";
import { SettingsButton, SettingsCard, SettingsStatus } from "./settings/SettingsSection";

const noopSubscribe = () => () => {};

// Subscribes to the terminal-log store. Only the component calling this hook
// re-renders when engine output arrives — the state no longer lives in
// AppContent, so unrelated tabs, chats, and the shell are untouched.
export function useTerminalLog(active = true) {
	// An inactive consumer keeps the last known snapshot but is not notified,
	// so a hidden log panel costs nothing while the engine is running.
	const lines = useSyncExternalStore(
		active ? terminalLogStore.subscribe : noopSubscribe,
		terminalLogStore.getSnapshot,
		terminalLogStore.getSnapshot,
	);
	return { lines, clear: terminalLogStore.clear };
}
export default function TerminalLog({ engineRunning, serverPort, serverError, active = true }) {
	// The log view is the most expensive consumer in the app: the store keeps
	// up to 2,000 lines and a burst of engine output re-renders every one of
	// them. When the panel is not the visible one it must not subscribe at
	// all, or a hidden Usage tab keeps re-rendering the whole modal forever.
	const log = useTerminalLog(active);
	return (
		<SettingsCard
			icon={LuTerminal}
			title="Engine logs"
			action={
				<SettingsButton
					onClick={log.clear}
				>
					Clear logs
				</SettingsButton>
			}
		>
			<SettingsStatus
				active={engineRunning}
				pulse={engineRunning}
				className="mb-3"
			>
				{engineRunning ? `Engine running on port ${serverPort}` : "Engine stopped"}
			</SettingsStatus>
			{serverError && (
				<p
					role="alert"
					className="mb-3 text-[11px] font-medium leading-relaxed text-[var(--error)]"
				>
					{serverError}
				</p>
			)}
			<div
				aria-label="Terminal output"
				className="h-[45vh] select-text overflow-auto rounded-lg border border-[var(--border)] bg-[var(--terminal)] p-3 font-mono text-[11px] leading-relaxed text-[var(--terminal-text)]"
			>
				{!log.lines.length
					? "No output yet. Load a model to see logs."
					: log.lines.map((line, index) => (
							<div
								key={index}
								className={`whitespace-pre-wrap break-all ${line.stream === "stderr" ? "text-[var(--error)]" : ""}`}
							>
								{line.data}
							</div>
						))}
			</div>
		</SettingsCard>
	);
}

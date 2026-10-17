import React, { useSyncExternalStore } from "react";
import { terminalLogStore } from "../lib/terminalLogStore.mjs";

// Subscribes to the terminal-log store. Only the component calling this hook
// re-renders when engine output arrives — the state no longer lives in
// AppContent, so unrelated tabs, chats, and the shell are untouched.
export function useTerminalLog() {
	const lines = useSyncExternalStore(
		terminalLogStore.subscribe,
		terminalLogStore.getSnapshot,
		terminalLogStore.getSnapshot,
	);
	return { lines, clear: terminalLogStore.clear };
}
export default function TerminalLog({ engineRunning, serverPort, serverError }) {
	const log = useTerminalLog();
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between text-xs">
				<span>{engineRunning ? `Engine running on port ${serverPort}` : "Engine stopped"}</span>
				<button
					type="button"
					className="rounded border border-[var(--border)] px-2 py-1"
					onClick={log.clear}
				>
					Clear logs
				</button>
			</div>
			{serverError && (
				<p
					role="alert"
					className="palace-error"
				>
					{serverError}
				</p>
			)}
			<div
				aria-label="Terminal output"
				className="h-[45vh] overflow-auto rounded bg-[var(--terminal)] p-3 font-mono text-[11px] text-[var(--terminal-text)] select-text"
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
		</div>
	);
}

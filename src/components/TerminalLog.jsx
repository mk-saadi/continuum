import React, { useEffect, useState } from "react";

export function useTerminalLog() {
	const [lines, setLines] = useState([]);
	useEffect(() => {
		const append = (line) => setLines((previous) => [...previous, line].slice(-2000));
		const unsubscribe = window.terminalAPI?.onOutput(append);
		const unsubscribeError = window.terminalAPI?.onError?.((message) =>
			append({ stream: "stderr", data: `[error] ${message}\n` }),
		);
		return () => {
			unsubscribe?.();
			unsubscribeError?.();
		};
	}, []);
	return { lines, clear: () => setLines([]) };
}
export default function TerminalLog({ log, engineRunning, serverPort, serverError }) {
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

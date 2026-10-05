import React, { useEffect, useState } from "react";
import IntegrationsTab from "../IntegrationsTab";

const descriptions = {
	auto: "The AI dynamically enables MCP servers when needed to keep baseline prompt overhead minimal.",
	manual: "The AI can only access tools you explicitly enable below. manage_mcp_servers is disabled.",
};

export default function McpSettingsTab(props) {
	const [mode, setMode] = useState(null);
	const [saving, setSaving] = useState(false);
	const [modeError, setModeError] = useState("");

	useEffect(() => {
		let active = true;
		window.api.getAppSettings()
			.then(settings => { if (active) setMode(settings.mcpMode); })
			.catch(error => { if (active) setModeError(error.message); });
		return () => { active = false; };
	}, []);

	async function selectMode(nextMode) {
		if (saving || mode === nextMode) return;
		setSaving(true);
		setModeError("");
		try {
			const settings = await window.api.saveAppSettings({ mcpMode: nextMode });
			setMode(settings.mcpMode);
		} catch (error) {
			setModeError(error.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-5">
			<div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
				<h3 className="text-sm font-semibold">MCP Tool Management Mode</h3>
				<div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-[var(--surface)] p-1 sm:grid-cols-2" role="group" aria-label="MCP tool management mode">
					{[
						["auto", "🤖 Auto (Dynamic AI)"],
						["manual", "🎛️ Manual (User Control)"],
					].map(([value, label]) => (
						<button key={value} type="button" aria-pressed={mode === value} disabled={mode === null || saving}
							onClick={() => selectMode(value)}
							className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 ${mode === value ? "bg-[var(--accent)] text-[var(--on-accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`}>
							{label}
						</button>
					))}
				</div>
				<p className="mt-3 text-xs text-[var(--text-secondary)]" aria-live="polite">{mode && descriptions[mode]}</p>
				{modeError && <p role="alert" className="palace-error mt-2">{modeError}</p>}
			</div>
			<IntegrationsTab {...props} />
		</div>
	);
}

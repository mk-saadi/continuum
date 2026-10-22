import React, { useEffect, useState } from "react";
import { LuBot, LuPlug, LuSlidersHorizontal } from "react-icons/lu";
import IntegrationsTab from "../IntegrationsTab";
import { SettingsCard, SettingsMessage } from "./SettingsSection";

const modes = [
	{ value: "auto", label: "Auto (dynamic AI)", Icon: LuBot },
	{ value: "manual", label: "Manual (user control)", Icon: LuSlidersHorizontal },
];

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
		window.api
			.getAppSettings()
			.then((settings) => {
				if (active) setMode(settings.mcpMode);
			})
			.catch((error) => {
				if (active) setModeError(error.message);
			});
		return () => {
			active = false;
		};
	}, []);

	async function selectMode(nextMode) {
		if (saving || mode === nextMode) return;
		setSaving(true);
		setModeError("");
		try {
			const settings = await window.api.saveAppSettings({ mcpMode: nextMode });
			setMode(settings.mcpMode);
			// MCP mode reshapes the prepared prompt (tool schemas, protocol
			// paragraphs); listeners refresh their context measurements.
			window.dispatchEvent(new Event("generation-settings-changed"));
		} catch (error) {
			setModeError(error.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<SettingsCard
				icon={LuPlug}
				title="MCP tool management mode"
				description={mode ? descriptions[mode] : "Choose how the assistant may enable MCP servers."}
				descriptionLive
			>
				<div
					className="grid grid-cols-1 gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 sm:grid-cols-2"
					role="group"
					aria-label="MCP tool management mode"
				>
					{modes.map(({ value, label, Icon }) => (
						<button
							key={value}
							type="button"
							aria-pressed={mode === value}
							disabled={mode === null || saving}
							onClick={() => selectMode(value)}
							className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 ${mode === value ? "bg-[var(--accent)] text-[var(--on-accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"}`}
						>
							<Icon
								aria-hidden="true"
								className="text-sm"
							/>
							{label}
						</button>
					))}
				</div>
				<SettingsMessage>{modeError}</SettingsMessage>
			</SettingsCard>
			<IntegrationsTab {...props} />
		</>
	);
}

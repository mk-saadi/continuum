import React, { useContext, useEffect, useState } from "react";
import { LuBot, LuPlug, LuSlidersHorizontal } from "react-icons/lu";
import { SelectField } from "../FormControls";
import IntegrationsTab from "../IntegrationsTab";
import { SettingsMaterialContext, SettingsCard, SettingsMessage } from "./SettingsSection";

const modes = [
	{ value: "auto", label: "Auto (dynamic AI)", Icon: LuBot },
	{ value: "manual", label: "Manual (user control)", Icon: LuSlidersHorizontal },
];

const descriptions = {
	auto: "The AI dynamically enables MCP servers when needed to keep baseline prompt overhead minimal.",
	manual: "The AI can only access tools you explicitly enable below. manage_mcp_servers is disabled.",
};

export default function McpSettingsTab(props) {
	const aero = useContext(SettingsMaterialContext);
	const [mode, setMode] = useState(null);
	const [searchProvider, setSearchProvider] = useState(null);
	const [searchLoaded, setSearchLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [modeError, setModeError] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			.getAppSettings()
			.then((settings) => {
				if (active) { setMode(settings.mcpMode); setSearchProvider(settings.webSearchProvider ?? null); setSearchLoaded(true); }
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

	const searchChoices = Object.entries(props.config?.mcpServers ?? {}).filter(([, definition]) =>
		definition.disabled !== true && definition.enabled !== false && definition.uiEnabled !== false
	).map(([name]) => ({ value: name, label: name }));
	const searchValue = searchProvider?.serverName ?? '';

	async function selectSearch(value) {
		setSaving(true); setModeError('');
		try {
			const settings = await window.api.saveAppSettings({ webSearchProvider: value ? { serverName: value } : null });
			setSearchProvider(settings.webSearchProvider);
			window.dispatchEvent(new Event('generation-settings-changed'));
		} catch (error) { setModeError(error.message); }
		finally { setSaving(false); }
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
					className={`${aero ? "aero-inset sk-well sk-segments" : "ui-radius-surface border border-[var(--border)] bg-[var(--bg-secondary)]"} grid grid-cols-1 gap-1 p-1 sm:grid-cols-2`}
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
							className={
								aero
									? "aero-control sk-button sk-segment aero-fill sk-fill inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold cursor-pointer"
									: `inline-flex cursor-pointer items-center justify-center gap-2 ui-radius-control px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 ${mode === value ? "bg-[var(--accent)] text-[var(--on-accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"}`
							}
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
			<SettingsCard icon={LuPlug} title="Default web search"
				description="Use native DuckDuckGo, or choose a configured MCP server for web search. This applies to workspace and casual chats starting with the next message. The assistant chooses among its enabled tools for search, summaries, and page reading.">
				<SelectField label="Search provider" value={searchValue} disabled={!searchLoaded || saving}
					onChange={event => selectSearch(event.target.value)}>
					<option value="">Native DuckDuckGo (default)</option>
					{searchValue && !searchChoices.some(choice => choice.value === searchValue) &&
						<option value={searchValue}>{searchValue} (unavailable)</option>}
					{searchChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
				</SelectField>
				<p className="mt-2 text-xs text-[var(--text-muted)]">All enabled tools from the selected server are available to the assistant. Their own approval rules apply. If unavailable, the assistant reports the problem instead of switching to DuckDuckGo.</p>
				{mode === 'manual' && searchProvider && <p className="mt-2 text-xs text-[var(--text-muted)]">Manual mode: keep the selected server and its tools enabled below.</p>}
			</SettingsCard>
			<IntegrationsTab {...props} />
		</>
	);
}

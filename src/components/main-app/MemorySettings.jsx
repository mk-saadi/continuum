import MascotSettings from '../mascot/MascotSettings';
import { nextRadioChoice } from "../../lib/radioChoices.mjs";
import { themes, themeGroups } from "../../lib/themes.mjs";
import CloudProviderSettings from "../CloudProviderSettings";
import React, { useEffect, useRef, useState } from "react";
import TokenHistory from "../settings/TokenHistory";
import UsageCostsDashboard from "../settings/usage/UsageCostsDashboard";
import TerminalLog from "../TerminalLog";
import RagSettings from "../RagSettings";
import LocalApiSettings from "../LocalApiSettings";
import AvatarSettings from "../AvatarSettings";
import MemoryTab from "../MemoryTab";
import McpSettingsTab from "../settings/McpSettingsTab";
import ServerConfigTab from "../ServerConfigTab";
import WorkspaceNetworkSettings from "../WorkspaceNetworkSettings";
import EngineIdleSettings from "../EngineIdleSettings";
import NotificationSettings from "../settings/NotificationSettings";
import SkillsSettingsTab from "../settings/SkillsSettingsTab";
import GeneralSettingsTab from "../settings/GeneralSettingsTab";
import BackgroundSettings from "../settings/BackgroundSettings";
import AppearanceSettings from "../settings/AppearanceSettings";
import GitIdentitySettings from "../GitIdentitySettings";
import DirectorySettings from "../DirectorySettings";
import RecoveryStorageSettings from "../settings/RecoveryStorageSettings";
import ModelProfileSettings from "../ModelProfileSettings";
import { CheckboxField } from "../FormControls";
import {
	SettingsMaterialContext,
	SettingsCard,
	SettingsHint,
	SettingsStatus,
} from "../settings/SettingsSection";
import {
	LuPalette,
	LuUserRound,
	LuBell,
	LuCpu,
	LuBot,
	LuBrain,
	LuPlug,
	LuServer,
	LuHardDrive,
	LuWallet,
	LuX,
} from "react-icons/lu";
import { GiStarSwirl } from "react-icons/gi";
import {
	DEFAULT_SETTINGS_TAB,
	DEFAULT_VISITED,
	markVisited,
	shouldMountPanel,
} from "../../lib/settingsPanels.mjs";

const tabs = [
	{
		id: "mascot",
		group: "Preferences",
		label: "Mascot",
		icon: LuBot,
		description: "Your floating Continuum companion.",
	},
	{
		id: "appearance",
		group: "Preferences",
		label: "Appearance",
		icon: LuPalette,
		description: "Themes, backgrounds, and visual effects.",
	},
	{
		id: "branding",
		group: "Preferences",
		label: "Avatar & Branding",
		icon: LuUserRound,
		description: "Model names, avatars, memory, prompts, and sampling overrides.",
	},
	{
		id: "notifications",
		group: "Preferences",
		label: "Notifications",
		icon: LuBell,
		description: "Choose when the app alerts you.",
	},
	{
		id: "models",
		group: "AI configuration",
		label: "Models & Generation",
		icon: LuCpu,
		description: "Providers, model defaults, and response behavior.",
	},
	{
		id: "agents",
		group: "AI configuration",
		label: "Agents & Skills",
		icon: LuBot,
		description: "Agent execution and reusable workflows.",
	},
	{
		id: "integrations",
		group: "AI configuration",
		label: "MCP Integrations",
		icon: LuPlug,
		description: "Connect and manage external tools and servers.",
	},
	{
		id: "memory",
		group: "AI configuration",
		label: "Memory",
		icon: LuBrain,
		description: "Global memory defaults and saved memories.",
	},
	{
		id: "engine",
		group: "System",
		label: "Engine & API",
		icon: LuServer,
		description: "Local runtime, API server preferences, and engine logs.",
	},
	{
		id: "storage",
		group: "System",
		label: "Storage & Data",
		icon: LuHardDrive,
		description: "File locations and token-history retention.",
	},
	{
		id: "usage-costs",
		group: "System",
		label: "Usage & Costs",
		icon: LuWallet,
		description: "Local and cloud token usage, spending, and pricing evidence.",
	},
];



const panelClass = "min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm sm:px-6";

// A settings panel is mounted only after its tab has been opened once, and it
// stays mounted afterwards so its local form state survives a tab switch.
// The modal used to mount all ten panels at once, so opening it ran every
// panel's IPC round-trips and built every panel's DOM before the first frame
// could be painted — the main-process work (skill files, recovery blobs,
// token and spending aggregates) stalled the whole app with it.
function LazyPanel({ id, visited, children, ...rest }) {
	return (
		<section
			id={`settings-panel-${id}`}
			role="tabpanel"
			aria-labelledby={`settings-tab-${id}`}
			tabIndex={0}
			className={panelClass}
			{...rest}
		>
			<SettingsMaterialContext.Provider
				value={[
					"appearance",
					"mascot",
					"branding",
					"notifications",
					"integrations",
					"agents",
					"engine",
					"storage",
					"models",
					"memory",
					"usage-costs",
				].includes(id)}
			>
				{shouldMountPanel(visited, id) ? children : null}
			</SettingsMaterialContext.Provider>
		</section>
	);
}

function MemorySettings({
	initialTab = DEFAULT_SETTINGS_TAB,
	palace,
	onClose,
	avatars,
	models,
	theme,
	onChangeTheme,
	engineRunning,
	serverPort,
	serverError,
}) {
	const dialog = useRef(null);
	const mcpForm = useRef(null);
	const tabButtons = useRef([]);
	const themeChoiceRefs = useRef(new Map());
	const changing = useRef(false);
	const version = useRef(0);
	const [tab, setTab] = useState(() => tabs.some(item => item.id === initialTab) ? initialTab : DEFAULT_SETTINGS_TAB);
	// Tabs mount on first visit and stay mounted afterwards, so their local
	// form state survives a switch. Opening the modal therefore only pays for
	// the tab that is actually shown.
	const [visited, setVisited] = useState(() => new Set([...DEFAULT_VISITED, tab]));
	const [config, setConfig] = useState(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const activeTab = tabs.find((item) => item.id === tab);

	useEffect(() => {
		const previous = document.activeElement;
		const element = dialog.current;
		element.showModal();
		return () => {
			element.close();
			previous?.focus();
		};
	}, []);

	// The MCP configuration is only used by the Integrations panel, so it is
	// fetched when that tab is first opened instead of on every modal open.
	const mcpActive = visited.has("integrations");
	useEffect(() => {
		if (!mcpActive) return;
		let active = true;
		async function refresh() {
			const request = ++version.current;
			try {
				if (!window.api?.getMcpConfig) throw new Error("Open the desktop app to manage MCP servers.");
				const value = await window.api.getMcpConfig();
				if (active && request === version.current) setConfig(value);
			} catch (err) {
				if (active && request === version.current) setError(err.message);
			} finally {
				if (active && request === version.current) setLoading(false);
			}
		}
		const unsubscribe = window.mcpAPI?.onChanged(refresh);
		refresh();
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [mcpActive]);

	async function change(action) {
		if (changing.current) return false;
		changing.current = true;
		setBusy(true);
		setError("");
		try {
			const result = await action();
			++version.current;
			setConfig(result.config || result);
			setLoading(false);
			return true;
		} catch (err) {
			setError(err.message);
			return false;
		} finally {
			changing.current = false;
			setBusy(false);
		}
	}

	// Switching tabs also marks the target as visited so its panel is mounted.
	// Both updates are batched into a single render.
	function selectTab(id) {
		setTab(id);
		setVisited((current) => markVisited(current, id));
	}

	function onTabKey(event, index) {
		let next;
		// A vertical tablist uses Up/Down. Home/End also work from any tab.
		if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
		else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
			next = (index + tabs.length - 1) % tabs.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = tabs.length - 1;
		else return;
		event.preventDefault();
		selectTab(tabs[next].id);
		tabButtons.current[next]?.focus();
	}

	return (
		<dialog
			ref={dialog}
			aria-labelledby="memory-settings-title"
			className="aero-dialog sk-window sk-dialog m-auto overflow-hidden p-0"
			style={{
				width: "min(920px, calc(100vw - 32px))",
				maxWidth: "none",
				height: "min(730px, calc(100dvh - 32px))",
				maxHeight: "none",
			}}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			<div className="flex h-full min-h-0 flex-col">
				<header className="aero-header sk-window-header sk-texture-grain flex shrink-0 items-center justify-between px-5 py-4 sm:px-6">
					<div>
						<h2
							id="memory-settings-title"
							className="text-base font-bold"
						>
							Settings
						</h2>
						<p className="mt-0.5 text-xs text-[var(--text-muted)]">Your workspace, your way.</p>
					</div>
					<button
						type="button"
						className="aero-orb sk-icon-button aero-fill sk-fill flex size-7 shrink-0 items-center justify-center cursor-pointer"
						aria-label="Close settings"
						onClick={onClose}
						autoFocus
					>
						<LuX />
					</button>
				</header>

				<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
					<nav
						role="tablist"
						aria-label="Settings sections"
						aria-orientation="vertical"
						className="aero-navigation sk-sidebar flex shrink-0 gap-1.5 overflow-x-auto px-3 py-3 sm:w-56 sm:flex-col sm:overflow-y-auto sm:px-3 sm:py-5"
					>
						{tabs.map(({ id, label, group, icon: Icon }, index) => (
							<React.Fragment key={id}>
								{(index === 0 || tabs[index - 1].group !== group) && (
									<p className="hidden px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] sm:block">
										{group}
									</p>
								)}
								<button
									key={id}
									ref={(element) => {
										tabButtons.current[index] = element;
									}}
									type="button"
									role="tab"
									aria-current={tab === id ? "page" : undefined}
									id={`settings-tab-${id}`}
									aria-controls={`settings-panel-${id}`}
									aria-selected={tab === id}
									tabIndex={tab === id ? 0 : -1}
									onKeyDown={(event) => onTabKey(event, index)}
									onClick={() => selectTab(id)}
									className={`sk-nav-item ${tab === id ? "aero-control sk-button aero-fill sk-fill" : "cursor-pointer ui-radius-surface border border-transparent bg-transparent text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"} flex shrink-0 items-center gap-3 px-3 py-2 text-left text-xs font-medium sm:w-full`}
								>
									<span
										aria-hidden="true"
										className={`grid size-7 shrink-0 place-items-center text-base ${tab === id ? "text-current" : "text-[var(--text-muted)]"}`}
									>
										<Icon size={17} />
									</span>
									<span className="whitespace-nowrap">{label}</span>
								</button>
							</React.Fragment>
						))}
						<div className="mt-auto hidden border-t border-[var(--border)] px-3 pt-4 text-[10px] text-[var(--text-muted)] sm:flex gap-2 items-center">
							<GiStarSwirl /> Personalize your local AI space
						</div>
					</nav>

					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						<div className="aero-header aero-section-header sk-section-header shrink-0 px-5 py-4 sm:px-6">
							<h3 className="text-sm font-semibold">{activeTab.label}</h3>
							<p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
								{activeTab.description}
							</p>
						</div>

						<LazyPanel id="mascot" visited={visited} hidden={tab !== "mascot"}><MascotSettings active={tab === "mascot"}/></LazyPanel>
						<LazyPanel
							id="appearance"
							visited={visited}
							hidden={tab !== "appearance"}
						>
							<SettingsMaterialContext.Provider value={true}>
								<div className="appearance-settings space-y-3">
									<AppearanceSettings />
									<SettingsCard
										icon={LuPalette}
										title="Color theme"
										description="Choose a palette for the whole app. The original dark theme is preserved."
									>
										<div className="space-y-4" role="radiogroup" aria-label="Color theme">
											{themeGroups.map((group) => (
												<fieldset key={group.heading}>
													<legend className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
														{group.heading}
													</legend>
													<div className="grid grid-cols-1 gap-3 min-[720px]:grid-cols-2">
														{group.themes.map((option) => {
															const selected = theme === option.id;
															return (
																<button
																	key={option.id}
																	type="button"
																	role="radio"
																	aria-checked={selected}
																	data-selected={selected}
																	tabIndex={selected ? 0 : -1}
																	ref={node => { if (node) themeChoiceRefs.current.set(option.id, node); else themeChoiceRefs.current.delete(option.id); }}
																	onKeyDown={event => {
																		const index = nextRadioChoice(event.key, themes.findIndex(item => item.id === option.id), themes.length);
																		if (index === null || !onChangeTheme) return;
																		event.preventDefault();
																		onChangeTheme(themes[index].id);
																		themeChoiceRefs.current.get(themes[index].id)?.focus();
																	}}
																	disabled={!onChangeTheme}
																	onClick={() => onChangeTheme?.(option.id)}
																	className="aero-control sk-button aero-fill sk-fill aero-theme-choice sk-choice flex items-center gap-3 p-3 text-left cursor-pointer"
																>
																	<span
																		aria-hidden="true"
																		className="flex h-12 w-14 shrink-0 items-end gap-1 overflow-hidden ui-radius-control border border-[var(--border)] p-1.5"
																		style={{
																			backgroundColor:
																				option.swatches[0],
																		}}
																	>
																		<span
																			className="h-7 w-3 ui-radius-small"
																			style={{
																				backgroundColor:
																					option.swatches[1],
																			}}
																		/>
																		<span
																			className="h-4 w-5 ui-radius-small"
																			style={{
																				backgroundColor:
																					option.swatches[2],
																			}}
																		/>
																	</span>
																	<span className="min-w-0 flex-1">
																		<span className="block text-xs font-semibold">
																			{option.label}
																		</span>
																		<span
																			className={`mt-0.5 block text-[11px] leading-relaxed ${selected ? "text-[var(--on-accent)]" : "text-[var(--text-muted)]"}`}
																		>
																			{option.description}
																		</span>
																	</span>
																	<span
																		aria-hidden="true"
																		className={`grid size-4 shrink-0 place-items-center ui-radius-round border text-[10px] ${selected ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]" : "border-[var(--control-border)]"}`}
																	>
																		{selected ? "✓" : ""}
																	</span>
																</button>
															);
														})}
													</div>
												</fieldset>
											))}
										</div>
										{!onChangeTheme && (
											<SettingsHint>
												Pass an onChangeTheme handler from the app to enable theme
												selection.
											</SettingsHint>
										)}
									</SettingsCard>
									<BackgroundSettings />
								</div>
							</SettingsMaterialContext.Provider>
						</LazyPanel>

						<LazyPanel
							id="branding"
							visited={visited}
							hidden={tab !== "branding"}
						>
							<AvatarSettings
								avatars={avatars}
								models={models}
							/>
						</LazyPanel>

						<LazyPanel
							id="memory"
							visited={visited}
							hidden={tab !== "memory"}
						>
							<CheckboxField
								label="Enable memory for this chat (facts & past chats)"
								checked={palace.enabled}
								onChange={() => palace.toggle()}
							/>
							<ModelProfileSettings section="memory" />
							<MemoryTab palace={palace} />
						</LazyPanel>

						<LazyPanel
							id="integrations"
							visited={visited}
							hidden={tab !== "integrations"}
							aria-busy={busy}
						>
							{loading ? (
								<p
									role="status"
									className="text-[11px] text-[var(--text-muted)]"
								>
									Loading MCP servers…
								</p>
							) : config ? (
								<McpSettingsTab
									config={config}
									status={palace.mcpStatus}
									busy={busy}
									error={error}
									onConfigure={() => {
										mcpForm.current?.scrollIntoView({
											block: "start",
											behavior: "smooth",
										});
										mcpForm.current?.focus({ preventScroll: true });
									}}
									onServerToggle={(name, enabled) =>
										change(() => window.mcpAPI.setServerEnabled(name, enabled))
									}
									onToolToggle={(name, tool, enabled) =>
										change(() => window.mcpAPI.setToolEnabled(tool, enabled, name))
									}
									onAllToolsToggle={(name, enabled) =>
										change(() => window.mcpAPI.setAllToolsEnabled(name, enabled))
									}
									onDelete={(name) =>
										change(() => {
											const servers = { ...config.mcpServers };
											delete servers[name];
											return window.api.saveMcpConfig({
												...config,
												mcpServers: servers,
											});
										})
									}
								/>
							) : (
								<p
									role="alert"
									className="text-[11px] font-medium leading-relaxed text-[var(--error)]"
								>
									{error}
								</p>
							)}
							<div
								ref={mcpForm}
								tabIndex={-1}
							>
								{loading ? (
									<p
										role="status"
										className="text-[11px] text-[var(--text-muted)]"
									>
										Loading configuration…
									</p>
								) : (
									<ServerConfigTab
										config={config}
										busy={busy}
										error={error}
										onError={setError}
										onSave={(value) => change(() => window.api.saveMcpConfig(value))}
									/>
								)}
							</div>
						</LazyPanel>

						<LazyPanel
							id="notifications"
							visited={visited}
							hidden={tab !== "notifications"}
						>
							<NotificationSettings />
						</LazyPanel>

						<LazyPanel
							id="models"
							visited={visited}
							hidden={tab !== "models"}
						>
							<CloudProviderSettings />
							<ModelProfileSettings section="generation" />
						</LazyPanel>

						<LazyPanel
							id="agents"
							visited={visited}
							hidden={tab !== "agents"}
						>
							<GeneralSettingsTab />
							<GitIdentitySettings />
							<SkillsSettingsTab />
						</LazyPanel>

						<LazyPanel
							id="engine"
							visited={visited}
							hidden={tab !== "engine"}
						>
							<EngineIdleSettings />
                            <WorkspaceNetworkSettings />
							<SettingsCard className="px-3 py-2.5">
								<SettingsStatus
									active={engineRunning}
									pulse={engineRunning}
								>
									{engineRunning
										? `Engine running on port ${serverPort}`
										: "Engine stopped"}
								</SettingsStatus>
							</SettingsCard>
							<LocalApiSettings />
							<TerminalLog
								active={tab === "engine"}
								engineRunning={engineRunning}
								serverPort={serverPort}
								serverError={serverError}
							/>
						</LazyPanel>

						<LazyPanel
							id="storage"
							visited={visited}
							hidden={tab !== "storage"}
						>
							<DirectorySettings />
							<RecoveryStorageSettings />
							<RagSettings />
							<TokenHistory section="retention" />
						</LazyPanel>

						<LazyPanel
							id="usage-costs"
							visited={visited}
							hidden={tab !== "usage-costs"}
						>
							<UsageCostsDashboard />
						</LazyPanel>
					</div>
				</div>
			</div>
		</dialog>
	);
}

// The shell republishes the memory palace object whenever it publishes a new
// context reading. Memoizing on stable props keeps those updates from
// rebuilding the entire settings tree.
export default React.memo(MemorySettings);

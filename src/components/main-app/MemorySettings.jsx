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
import EngineIdleSettings from "../EngineIdleSettings";
import NotificationSettings from "../settings/NotificationSettings";
import SkillsSettingsTab from "../settings/SkillsSettingsTab";
import GeneralSettingsTab from "../settings/GeneralSettingsTab";
import BackgroundSettings from "../settings/BackgroundSettings";
import DirectorySettings from "../DirectorySettings";
import RecoveryStorageSettings from "../settings/RecoveryStorageSettings";
import ModelProfileSettings from "../ModelProfileSettings";
import { CheckboxField } from "../FormControls";
import { SettingsCard, SettingsHint, SettingsStatus } from "../settings/SettingsSection";
import {
	LuPalette,
	LuBell,
	LuCpu,
	LuBot,
	LuBrain,
	LuPlug,
	LuServer,
	LuHardDrive,
	LuChartNoAxesCombined,
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
		id: "appearance",
		group: "Preferences",
		label: "Appearance",
		icon: LuPalette,
		description: "Themes, backgrounds, and assistant identity.",
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
		description: "Memory defaults, model overrides, and saved memories.",
	},
	{
		id: "engine",
		group: "System",
		label: "Engine & API",
		icon: LuServer,
		description: "Local runtime and API server preferences.",
	},
	{
		id: "storage",
		group: "System",
		label: "Storage & Data",
		icon: LuHardDrive,
		description: "File locations and token-history retention.",
	},
	{
		id: "usage",
		group: "System",
		label: "Usage & Logs",
		icon: LuChartNoAxesCombined,
		description: "Token consumption and engine diagnostics.",
	},
	{
		id: "usage-costs",
		group: "System",
		label: "Usage & Costs",
		icon: LuWallet,
		description: "Cloud spending, provider charges, and pricing evidence.",
	},
];

function ProfileSettingsList({ models, section }) {
	return (
		<div className="space-y-3">
			<ModelProfileSettings section={section} />
			{models.map((model) => (
				<ModelProfileSettings
					key={model.id}
					modelPath={model.modelPath || model.path || model.id}
					heading={model.name || model.id}
					section={section}
				/>
			))}
		</div>
	);
}

const themeGroups = [
	{
		heading: "Default",
		themes: [
			{
				id: "light",
				label: "Light",
				description: "Clean white · neutral gray · blue",
				swatches: ["#ffffff", "#f0f0f0", "#2563eb"],
			},
			{
				id: "dark",
				label: "Dark",
				description: "Charcoal · neutral gray · blue",
				swatches: ["#1a1a1a", "#292929", "#5b9bff"],
			},
		],
	},
	{
		heading: "More looks",
		themes: [
			{
				id: "ember",
				label: "Ember Studio Light",
				description: "Parchment · mineral gray · burnt copper",
				swatches: ["#E9E8E0", "#F7F6F0", "#B85F3D"],
			},
			{
				id: "ember-dark",
				label: "Ember Studio Dark",
				description: "Charcoal slate · smoky plum · warm amber",
				swatches: ["#131725", "#3c3545", "#efa26f"],
			},
			{
				id: "gruvbox",
				label: "Gruvbox Light",
				description: "Cream paper · red · olive green · mustard",
				swatches: ["#f9f5d7", "#e8dc8e", "#b57614"],
			},
			{
				id: "gruvbox-dark",
				label: "Gruvbox Dark",
				description: "Near-black · red · banana green · mustard",
				swatches: ["#1d2021", "#43421a", "#fabd2f"],
			},
			{
				id: "lilac",
				label: "Lilac Lounge Light",
				description: "Soft lavender · airy lilac · violet",
				swatches: ["#faf7fe", "#eee0fb", "#956bd2"],
			},
			{
				id: "lilac-dark",
				label: "Lilac Lounge Dark",
				description: "Deep plum · dusk purple · soft lilac",
				swatches: ["#1d1925", "#463552", "#c5a1f3"],
			},
			{
				id: "matcha",
				label: "Matcha Notebook Light",
				description: "Sage cream · fresh mint · forest green",
				swatches: ["#f1f8f1", "#dff2e4", "#268c70"],
			},
			{
				id: "matcha-dark",
				label: "Matcha Notebook Dark",
				description: "Deep forest · moss green · mint",
				swatches: ["#14231f", "#32523e", "#8bdcb4"],
			},
			{
				id: "midnight-light",
				label: "Midnight Find Light",
				description: "Indigo paper · dark indigo text · rose & amber",
				swatches: ["#f6f6fb", "#d94b60", "#daa541"],
			},
			{
				id: "midnight-find",
				label: "Midnight Find",
				description: "Deep indigo · lavender text · rose & yellow",
				swatches: ["#15172a", "#eb5e73", "#f3df6e"],
			},
			{
				id: "mochi",
				label: "Mochi Light",
				description: "Warm ivory · soft rose",
				swatches: ["#F7F0F2", "#FFFAFB", "#D95F89"],
			},
			{
				id: "mochi-dark",
				label: "Mochi Dark",
				description: "Deep plum · muted mauve · rose",
				swatches: ["#211B23", "#2B222D", "#E982A3"],
			},
			{
				id: "onyx",
				label: "Onyx Light",
				description: "Crisp paper · graphite ink · petrol",
				swatches: ["#ffffff", "#0b0c0e", "#175a75"],
			},
			{
				id: "onyx-dark",
				label: "Onyx Dark",
				description: "True black · graphite · ice blue",
				swatches: ["#000000", "#0b0b0d", "#8ecdf7"],
			},
			{
				id: "papaya",
				label: "Papaya Punch Light",
				description: "Warm cream · papaya orange · deep teal",
				swatches: ["#fff7ef", "#c4470f", "#0f7a6c"],
			},
			{
				id: "papaya-dark",
				label: "Papaya Punch Dark",
				description: "Deep teal night · mango · hot pink",
				swatches: ["#0d1b19", "#ff8a3d", "#ff5c8a"],
			},
			{
				id: "solarized",
				label: "Solarized Light",
				description: "Cream paper · slate text · blue",
				swatches: ["#f7f0dc", "#c9e0e3", "#268bd2"],
			},
			{
				id: "solarized-dark",
				label: "Solarized Dark",
				description: "Deep teal · slate text · blue",
				swatches: ["#00212b", "#155060", "#268bd2"],
			},
			{
				id: "tokyo",
				label: "Tokyo Night Light",
				description: "Fog gray · cool blue · cyan",
				swatches: ["#e1e2e7", "#f7f8fb", "#2e7de9"],
			},
			{
				id: "tokyo-dark",
				label: "Tokyo Night Dark",
				description: "Midnight navy · periwinkle · violet",
				swatches: ["#1a1b26", "#2f3a63", "#7aa2f7"],
			},
		],
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
			{shouldMountPanel(visited, id) ? children : null}
		</section>
	);
}

function MemorySettings({
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
	const changing = useRef(false);
	const version = useRef(0);
	const [tab, setTab] = useState(DEFAULT_SETTINGS_TAB);
	// Tabs mount on first visit and stay mounted afterwards, so their local
	// form state survives a switch. Opening the modal therefore only pays for
	// the tab that is actually shown.
	const [visited, setVisited] = useState(() => new Set(DEFAULT_VISITED));
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
			className="palace-dialog m-auto overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/50"
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
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-5 py-4 sm:px-6">
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
						className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
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
						className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3 sm:w-56 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0 sm:px-3 sm:py-5"
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
									id={`settings-tab-${id}`}
									aria-controls={`settings-panel-${id}`}
									aria-selected={tab === id}
									tabIndex={tab === id ? 0 : -1}
									onKeyDown={(event) => onTabKey(event, index)}
									onClick={() => selectTab(id)}
									className={`flex shrink-0 items-center cursor-pointer gap-3 rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors sm:w-full ${tab === id ? "bg-[var(--active-chat)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"}`}
								>
									<span
										aria-hidden="true"
										className={`grid size-7 shrink-0 place-items-center rounded-lg text-base ${tab === id ? "bg-[var(--surface-raised)] text-[var(--accent)]" : "text-[var(--text-muted)]"}`}
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

					<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-secondary)]">
						<div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4 sm:px-6">
							<h3 className="text-sm font-semibold">{activeTab.label}</h3>
							<p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
								{activeTab.description}
							</p>
						</div>

						<LazyPanel id="appearance" visited={visited} hidden={tab !== "appearance"}>
							<SettingsCard
								icon={LuPalette}
								title="Color theme"
								description="Choose a palette for the whole app. The original dark theme is preserved."
							>
								<div className="space-y-4">
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
															aria-pressed={selected}
															disabled={!onChangeTheme}
															onClick={() => onChangeTheme?.(option.id)}
															className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-left shadow-[0_2px_4px_var(--window-shadow)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-[var(--accent)] bg-[var(--active-chat)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
														>
															<span
																aria-hidden="true"
																className="flex h-12 w-14 shrink-0 items-end gap-1 overflow-hidden rounded-lg border border-[var(--border)] p-1.5"
																style={{ backgroundColor: option.swatches[0] }}
															>
																<span
																	className="h-7 w-3 rounded-sm"
																	style={{ backgroundColor: option.swatches[1] }}
																/>
																<span
																	className="h-4 w-5 rounded-sm"
																	style={{ backgroundColor: option.swatches[2] }}
																/>
															</span>
															<span className="min-w-0 flex-1">
																<span className="block text-xs font-semibold">
																	{option.label}
																</span>
																<span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--text-muted)]">
																	{option.description}
																</span>
															</span>
															<span
																aria-hidden="true"
																className={`grid size-4 shrink-0 place-items-center rounded-full border text-[10px] ${selected ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]" : "border-[var(--control-border)]"}`}
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
										Pass an onChangeTheme handler from the app to enable theme selection.
									</SettingsHint>
								)}
							</SettingsCard>
							<BackgroundSettings />
							<AvatarSettings
								avatars={avatars}
								models={models}
							/>
						</LazyPanel>

						<LazyPanel id="memory" visited={visited} hidden={tab !== "memory"}>
							<CheckboxField
								label="Enable memory for this chat (facts & past chats)"
								checked={palace.enabled}
								onChange={() => palace.toggle()}
							/>
							<ProfileSettingsList
								models={models}
								section="memory"
							/>
							<MemoryTab palace={palace} />
						</LazyPanel>

						<LazyPanel id="integrations" visited={visited} hidden={tab !== "integrations"} aria-busy={busy}>
							{loading ? (
								<p role="status" className="text-[11px] text-[var(--text-muted)]">
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
										<p role="status" className="text-[11px] text-[var(--text-muted)]">
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

						<LazyPanel id="notifications" visited={visited} hidden={tab !== "notifications"}>
								<NotificationSettings />
						</LazyPanel>

						<LazyPanel id="models" visited={visited} hidden={tab !== "models"}>
							<CloudProviderSettings />
							<ProfileSettingsList
								models={models}
								section="generation"
							/>
						</LazyPanel>

						<LazyPanel id="agents" visited={visited} hidden={tab !== "agents"}>
							<GeneralSettingsTab />
							<SkillsSettingsTab />
						</LazyPanel>

						<LazyPanel id="engine" visited={visited} hidden={tab !== "engine"}>
							<EngineIdleSettings />
							<SettingsCard className="px-3 py-2.5">
								<SettingsStatus
									active={engineRunning}
									pulse={engineRunning}
								>
									{engineRunning ? `Engine running on port ${serverPort}` : "Engine stopped"}
								</SettingsStatus>
							</SettingsCard>
							<LocalApiSettings />
						</LazyPanel>

						<LazyPanel id="storage" visited={visited} hidden={tab !== "storage"}>
							<DirectorySettings />
							<RecoveryStorageSettings />
							<RagSettings />
							<TokenHistory section="retention" />
						</LazyPanel>

						<LazyPanel id="usage" visited={visited} hidden={tab !== "usage"}>
							<TokenHistory section="usage" />
							<TerminalLog
								active={tab === "usage"}
								engineRunning={engineRunning}
								serverPort={serverPort}
								serverError={serverError}
							/>
						</LazyPanel>

						<LazyPanel id="usage-costs" visited={visited} hidden={tab !== "usage-costs"}>
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

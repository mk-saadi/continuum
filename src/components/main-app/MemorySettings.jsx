import CloudProviderSettings from "../CloudProviderSettings";
import React, { useEffect, useRef, useState } from "react";
import TokenHistory from "../settings/TokenHistory";
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
	LuX,
} from "react-icons/lu";
import { GiStarSwirl } from "react-icons/gi";

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
];

function ProfileSettingsList({ models, section }) {
	return (
		<div className="space-y-4">
			<ModelProfileSettings section={section} />
			{models.map((model) => (
				<div
					key={model.id}
					className="space-y-2"
				>
					<h4 className="text-sm font-medium">{model.name || model.id}</h4>
					<ModelProfileSettings
						modelPath={model.modelPath || model.path || model.id}
						section={section}
					/>
				</div>
			))}
		</div>
	);
}

const themeGroups = [
	{
		heading: "Defaukt",
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
				id: "mochi",
				label: "Mochi",
				description: "Warm ivory · soft rose",
				swatches: ["#F7F0F2", "#FFFAFB", "#D95F89"],
			},
			{
				id: "mochi-dark",
				label: "Mochi",
				description: "Deep plum · muted mauve · rose",
				swatches: ["#211B23", "#2B222D", "#E982A3"],
			},
			{
				id: "lilac",
				label: "Lilac Lounge",
				description: "Soft lavender · airy lilac · violet",
				swatches: ["#faf7fe", "#eee0fb", "#956bd2"],
			},
			{
				id: "lilac-dark",
				label: "Lilac Lounge",
				description: "Deep plum · dusk purple · soft lilac",
				swatches: ["#1d1925", "#463552", "#c5a1f3"],
			},
			{
				id: "matcha",
				label: "Matcha Notebook",
				description: "Sage cream · fresh mint · forest green",
				swatches: ["#f1f8f1", "#dff2e4", "#268c70"],
			},
			{
				id: "matcha-dark",
				label: "Matcha Notebook",
				description: "Deep forest · moss green · mint",
				swatches: ["#14231f", "#32523e", "#8bdcb4"],
			},
			{
				id: "ember",
				label: "Ember Studio",
				description: "Parchment · mineral gray · burnt copper",
				swatches: ["#E9E8E0", "#F7F6F0", "#B85F3D"],
			},
			{
				id: "ember-dark",
				label: "Ember Studio",
				description: "Charcoal slate · smoky plum · warm amber",
				swatches: ["#131725", "#3c3545", "#efa26f"],
			},
			{
				id: "tokyo",
				label: "Tokyo Night",
				description: "Fog gray · cool blue · cyan",
				swatches: ["#e1e2e7", "#f7f8fb", "#2e7de9"],
			},
			{
				id: "tokyo-dark",
				label: "Tokyo Night",
				description: "Midnight navy · periwinkle · violet",
				swatches: ["#1a1b26", "#2f3a63", "#7aa2f7"],
			},
			{
				id: "gruvbox",
				label: "Gruvbox",
				description: "Cream paper · red · olive green · mustard",
				swatches: ["#f9f5d7", "#e8dc8e", "#b57614"],
			},
			{
				id: "gruvbox-dark",
				label: "Gruvbox",
				description: "Near-black · red · banana green · mustard",
				swatches: ["#1d2021", "#43421a", "#fabd2f"],
			},
			{
				id: "solarized",
				label: "Solarized",
				description: "Cream paper · slate text · blue",
				swatches: ["#f7f0dc", "#c9e0e3", "#268bd2"],
			},
			{
				id: "solarized-dark",
				label: "Solarized",
				description: "Deep teal · slate text · blue",
				swatches: ["#00212b", "#155060", "#268bd2"],
			},
		],
	},
];

const panelClass = "min-h-0 flex-1 overflow-y-auto px-5 py-6 text-sm sm:px-7";

export default function MemorySettings({
	palace,
	onClose,
	avatars,
	models,
	theme,
	onChangeTheme,
	terminalLog,
	engineRunning,
	serverPort,
	serverError,
}) {
	const dialog = useRef(null);
	const mcpForm = useRef(null);
	const tabButtons = useRef([]);
	const changing = useRef(false);
	const version = useRef(0);
	const [tab, setTab] = useState("appearance");
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

	useEffect(() => {
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
	}, []);

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
		setTab(tabs[next].id);
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
									onClick={() => setTab(id)}
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

					<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-primary)]">
						<div className="shrink-0 border-b border-[var(--border)] px-5 py-4 sm:px-7">
							<h3 className="text-base font-semibold">{activeTab.label}</h3>
							<p className="mt-1 text-xs text-[var(--text-muted)]">{activeTab.description}</p>
						</div>

						<section
							id="settings-panel-appearance"
							role="tabpanel"
							aria-labelledby="settings-tab-appearance"
							hidden={tab !== "appearance"}
							tabIndex={0}
							className={panelClass}
						>
							<div className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
								<h4 className="font-semibold">Color theme</h4>
								<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
									Choose a palette for the whole app. The original dark theme is preserved.
								</p>
							</div>
							{themeGroups.map((group) => (
								<fieldset
									key={group.heading}
									className="mb-6"
								>
									<legend className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
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
													className={`flex items-center gap-3 cursor-pointer rounded-xl border p-3 text-left transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-[var(--accent)] bg-[var(--active-chat)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
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
														<span className="mt-0.5 block text-[11px] text-[var(--text-muted)]">
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
							{!onChangeTheme && (
								<p className="rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
									Pass an onChangeTheme handler from the app to enable theme selection.
								</p>
							)}
							<BackgroundSettings />
							<AvatarSettings
								avatars={avatars}
								models={models}
							/>
						</section>

						<section
							id="settings-panel-memory"
							role="tabpanel"
							aria-labelledby="settings-tab-memory"
							hidden={tab !== "memory"}
							tabIndex={0}
							className={panelClass}
						>
							<label className="mb-5 flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs font-medium">
								<input
									type="checkbox"
									role="switch"
									checked={palace.enabled}
									onChange={palace.toggle}
									className="accent-[var(--accent)]"
								/>
								Enable memory for this chat (facts & past chats)
							</label>
							<div className="mb-5">
								<ProfileSettingsList
									models={models}
									section="memory"
								/>
							</div>
							<MemoryTab palace={palace} />
						</section>

						<section
							id="settings-panel-integrations"
							role="tabpanel"
							aria-labelledby="settings-tab-integrations"
							hidden={tab !== "integrations"}
							tabIndex={0}
							className={panelClass}
							aria-busy={busy}
						>
							{loading ? (
								<p role="status">Loading MCP servers…</p>
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
									className="palace-error"
								>
									{error}
								</p>
							)}
							<div
								ref={mcpForm}
								tabIndex={-1}
								className="mt-6"
							>
								{loading ? (
									<p role="status">Loading configuration…</p>
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
						</section>

						<section
							id="settings-panel-notifications"
							role="tabpanel"
							aria-labelledby="settings-tab-notifications"
							hidden={tab !== "notifications"}
							tabIndex={0}
							className={panelClass}
						>
							<NotificationSettings />
						</section>

						<section
							id="settings-panel-models"
							role="tabpanel"
							aria-labelledby="settings-tab-models"
							hidden={tab !== "models"}
							tabIndex={0}
							className={panelClass}
						>
							<CloudProviderSettings />
							<div className="mt-6 space-y-3">
								<h4 className="font-semibold">Generation profiles</h4>
								<ProfileSettingsList
									models={models}
									section="generation"
								/>
							</div>
						</section>

						<section
							id="settings-panel-agents"
							role="tabpanel"
							aria-labelledby="settings-tab-agents"
							hidden={tab !== "agents"}
							tabIndex={0}
							className={panelClass}
						>
							<GeneralSettingsTab />
							{tab === "agents" && <SkillsSettingsTab />}
						</section>

						<section
							id="settings-panel-engine"
							role="tabpanel"
							aria-labelledby="settings-tab-engine"
							hidden={tab !== "engine"}
							tabIndex={0}
							className={panelClass}
						>
							<EngineIdleSettings />
							<p className="mb-5 text-xs">
								{engineRunning ? `Engine running on port ${serverPort}` : "Engine stopped"}
							</p>
							<LocalApiSettings />
						</section>

						<section
							id="settings-panel-storage"
							role="tabpanel"
							aria-labelledby="settings-tab-storage"
							hidden={tab !== "storage"}
							tabIndex={0}
							className={panelClass}
						>
							<DirectorySettings />
							<RecoveryStorageSettings />
							<RagSettings />
							{tab === "storage" && <TokenHistory section="retention" />}
						</section>

						<section
							id="settings-panel-usage"
							role="tabpanel"
							aria-labelledby="settings-tab-usage"
							hidden={tab !== "usage"}
							tabIndex={0}
							className={panelClass}
						>
							<h4 className="mb-3 font-semibold">Token usage</h4>
							{tab === "usage" && <TokenHistory section="usage" />}
							<h4 className="mt-6 mb-3 font-semibold">Engine logs</h4>
							<TerminalLog
								log={terminalLog}
								engineRunning={engineRunning}
								serverPort={serverPort}
								serverError={serverError}
							/>
						</section>
					</div>
				</div>
			</div>
		</dialog>
	);
}

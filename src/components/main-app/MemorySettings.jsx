import React, { useEffect, useRef, useState } from "react";
import TerminalLog from "../TerminalLog";
import RagSettings from "../RagSettings";
import LocalApiSettings from "../LocalApiSettings";
import AvatarSettings from "../AvatarSettings";
import MemoryTab from "../MemoryTab";
import IntegrationsTab from "../IntegrationsTab";
import ServerConfigTab from "../ServerConfigTab";
import EngineIdleSettings from '../EngineIdleSettings';
import { LuPalette, LuTerminal, LuImage, LuBrain, LuPlug, LuSettings, LuX } from "react-icons/lu";
import { GiStarSwirl } from "react-icons/gi";

const tabs = [
	{ id: "general", label: "General", icon: LuPalette, description: "Appearance and engine preferences." },
	{ id: "terminal", label: "Terminal", icon: LuTerminal, description: "Engine activity and diagnostics." },
	{
		id: "avatars",
		label: "Avatars & Branding",
		icon: LuImage,
		description: "Give your models a familiar face.",
	},
	{
		id: "memory",
		label: "Memory Palace",
		icon: LuBrain,
		description: "Control what your assistant remembers.",
	},
	{
		id: "integrations",
		label: "MCP Integrations",
		icon: LuPlug,
		description: "Connect your local tools and servers.",
	},
	{
		id: "config",
		label: "Server Config",
		icon: LuSettings,
		description: "Manage the API, RAG, and server setup.",
	},
];

const themeGroups = [
	{
		heading: "Mochi & classic",
		themes: [
			{
				id: "light",
				label: "Mochi Light",
				description: "Warm ivory · rose",
				swatches: ["#fbf8f4", "#fffdfa", "#ed769b"],
			},
			{
				id: "dark",
				label: "Original Dark",
				description: "Your existing dark theme",
				swatches: ["#002b36", "#073642", "#268bd2"],
			},
		],
	},
	{
		heading: "More looks",
		themes: [
			{
				id: "lilac",
				label: "Lilac Lounge",
				description: "Light",
				swatches: ["#faf7fe", "#eee0fb", "#956bd2"],
			},
			{
				id: "lilac-dark",
				label: "Lilac Lounge",
				description: "Dark",
				swatches: ["#1d1925", "#463552", "#c5a1f3"],
			},
			{
				id: "matcha",
				label: "Matcha Notebook",
				description: "Light",
				swatches: ["#f1f8f1", "#dff2e4", "#268c70"],
			},
			{
				id: "matcha-dark",
				label: "Matcha Notebook",
				description: "Dark",
				swatches: ["#14231f", "#32523e", "#8bdcb4"],
			},
			{
				id: "ember",
				label: "Ember Studio",
				description: "Light",
				swatches: ["#f7f3ed", "#f8e6d9", "#cb754a"],
			},
			{
				id: "ember-dark",
				label: "Ember Studio",
				description: "Dark",
				swatches: ["#131725", "#3c3545", "#efa26f"],
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
	const tabButtons = useRef([]);
	const changing = useRef(false);
	const version = useRef(0);
	const [tab, setTab] = useState("general");
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
						<p className="hidden px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] sm:block">
							Preferences
						</p>
						{tabs.map(({ id, label, icon: Icon }, index) => (
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
							id="settings-panel-general"
							role="tabpanel"
							aria-labelledby="settings-tab-general"
							hidden={tab !== "general"}
							tabIndex={0}
							className={panelClass}
						>
							<EngineIdleSettings />
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
						</section>

						<section
							id="settings-panel-terminal"
							role="tabpanel"
							aria-labelledby="settings-tab-terminal"
							hidden={tab !== "terminal"}
							tabIndex={0}
							className={panelClass}
						>
							<TerminalLog
								log={terminalLog}
								engineRunning={engineRunning}
								serverPort={serverPort}
								serverError={serverError}
							/>
						</section>

						<section
							id="settings-panel-avatars"
							role="tabpanel"
							aria-labelledby="settings-tab-avatars"
							hidden={tab !== "avatars"}
							tabIndex={0}
							className={panelClass}
						>
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
								<IntegrationsTab
									config={config}
									status={palace.mcpStatus}
									busy={busy}
									error={error}
									onConfigure={() => setTab("config")}
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
						</section>

						<section
							id="settings-panel-config"
							role="tabpanel"
							aria-labelledby="settings-tab-config"
							hidden={tab !== "config"}
							tabIndex={0}
							className={panelClass}
							aria-busy={busy}
						>
							<LocalApiSettings />
							<RagSettings />
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
						</section>
					</div>
				</div>
			</div>
		</dialog>
	);
}

import useAppearance from "../hooks/useAppearance";
import React, { useContext } from "react";
import { FaAngleRight } from "react-icons/fa";
import { LuX, LuTriangleAlert, LuCircleCheck, LuLoaderCircle, LuCircleMinus } from "react-icons/lu";
import { IoIosCloseCircleOutline } from "react-icons/io";
import {
	SettingsMaterialContext,
	SettingsButton,
	SettingsCheckRow,
	SettingsIconButton,
	SettingsMessage,
} from "./settings/SettingsSection";

const errorBadge = {
	color: "var(--aero-status-error, var(--error-strong))",
	backgroundColor: "color-mix(in srgb, var(--error) 12%, transparent)",
};

const connectedBadge = {
	color: "var(--accent)",
	backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
};

const neutralBadge = {
	color: "var(--text-secondary)",
	backgroundColor: "var(--surface-hover)",
};

const serverCard =
	"overflow-hidden ui-radius-surface border border-[var(--border)] bg-[var(--surface)] shadow-[0_2px_4px_var(--window-shadow)]";

export default function IntegrationsTab({
	config,
	status,
	busy,
	error,
	onServerToggle,
	onToolToggle,
	onAllToolsToggle,
	onDelete,
	onConfigure,
}) {
	const aero = useContext(SettingsMaterialContext);
	const [appearance] = useAppearance();
	const isSkeu = appearance === "skeu";
	const servers = Object.entries(config?.mcpServers ?? {});

	return (
		<div className="space-y-3 text-[var(--text-primary)]">
			<SettingsMessage>{error || status?.error}</SettingsMessage>

			{!servers.length && (
				<div
					className={
						aero
							? "aero-empty sk-empty p-6 text-center"
							: "ui-radius-surface border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center"
					}
				>
					<p className="text-[11px] text-[var(--text-secondary)]">No MCP servers configured.</p>
					<div className="mt-3">
						<SettingsButton
							variant="primary"
							onClick={onConfigure}
						>
							Add a server
						</SettingsButton>
					</div>
				</div>
			)}

			{servers.map(([name, definition]) => {
				const server = status?.servers?.find((item) => item.name === name);
				const enabled =
					definition?.disabled !== true &&
					(definition?.uiEnabled === true ||
						(definition?.uiEnabled !== false && definition?.disabled === false));
				const tools = server?.tools || [];
				const disabledTools = new Set(definition?.disabledTools || []);
				const allEnabled = tools.length > 0 && tools.every((tool) => !disabledTools.has(tool.label));
				const failed = enabled && (server?.status === "error" || Boolean(server?.error));
				const connected = enabled && server?.status === "connected" && !failed;
				const badgeContent = !enabled ? (
					<>
						<LuCircleMinus
							size={12}
							className="shrink-0"
						/>
						<span>Disabled</span>
					</>
				) : failed ? (
					<>
						<LuTriangleAlert
							size={12}
							className="shrink-0"
						/>
						<span>Error: {server?.error || "Connection failed"}</span>
					</>
				) : connected ? (
					<>
						<LuCircleCheck
							size={12}
							className="shrink-0"
						/>
						<span>Connected</span>
					</>
				) : server?.status === "connecting" ? (
					<>
						<LuLoaderCircle
							size={12}
							className="shrink-0 animate-spin"
						/>
						<span>Connecting…</span>
					</>
				) : (
					<>
						<IoIosCloseCircleOutline
							size={12}
							className="shrink-0"
						/>
						<span>Disconnected</span>
					</>
				);

				const badgeStyle = failed ? errorBadge : connected ? connectedBadge : neutralBadge;

				return (
					<article
						key={name}
						className={aero ? "aero-panel sk-panel" : serverCard}
					>
						<div className="flex items-start gap-3 p-3">
							{isSkeu ? (
								<input type="checkbox" role="switch" className="sk-switch mt-0.5 shrink-0"
									aria-label={`Enable server ${name}`} checked={enabled} disabled={busy}
									onChange={event => onServerToggle(name, event.target.checked)} />
							) : (<button
								type="button"
								role="switch"
								aria-checked={enabled}
								aria-pressed={enabled}
								aria-label={`Enable server ${name}`}
								disabled={busy}
								onClick={() => onServerToggle(name, !enabled)}
								className={
									aero
										? "aero-control sk-button aero-fill sk-fill relative mt-0.5 h-5 w-9 shrink-0"
										: `relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer ui-radius-round transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 ${enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--control-border)]"}`
								}
							>
								<span
									className={`${aero ? "aero-orb sk-icon-button aero-fill sk-fill" : "ui-radius-round bg-[var(--surface-raised)] shadow-sm"} absolute top-0.5 left-0.5 h-3 w-3 transition-transform ${enabled ? "translate-x-4" : ""}`}
								/>
							</button>)}

							<div className="min-w-0 flex-1">
								<h4 className="break-words text-xs font-semibold">
									{name.startsWith("mcp/") ? name : `mcp/${name}`}
								</h4>
								<span
									role="status"
									style={badgeStyle}
									className="sk-badge mt-1 inline-flex max-w-full items-center gap-1.5 ui-radius-pill px-2 py-0.5 text-[10px] break-words"
								>
									{badgeContent}
								</span>
							</div>

							<SettingsIconButton
								label={`Delete MCP server: ${name}`}
								icon={LuX}
								disabled={busy}
								onClick={() => onDelete(name)}
								title={`Delete ${name}`}
							/>
						</div>

						<details className="group border-t border-[var(--border)]">
							<summary className="flex cursor-pointer list-none items-center px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] [&::-webkit-details-marker]:hidden ui-radius-bottom!">
								<FaAngleRight className="mr-2 transition-transform duration-200 group-open:rotate-90" />
								Tools <span className="ml-1 text-[var(--text-muted)]">{tools.length}</span>
							</summary>
							<div className="space-y-2 px-3 pb-3">
								<div className="flex items-center justify-between gap-2 text-[11px]">
									<span className="text-[var(--text-muted)]">
										{tools.filter((tool) => !disabledTools.has(tool.label)).length} of{" "}
										{tools.length} permitted
									</span>
									<SettingsButton
										variant="ghost"
										className="text-[var(--accent)]"
										disabled={busy || !tools.length}
										onClick={() => onAllToolsToggle(name, !allEnabled)}
									>
										{allEnabled ? "Disable All" : "Enable All"}
									</SettingsButton>
								</div>

								{!tools.length && (
									<p className="text-[11px] text-[var(--text-muted)]">
										{enabled
											? "No tools discovered."
											: "Enable this server to discover its tools."}
									</p>
								)}

								{tools.map((tool) => (
									<SettingsCheckRow
										key={tool.name}
										className="px-2 py-1"
										label={<span className="break-all font-mono">{tool.label}</span>}
										checked={!disabledTools.has(tool.label)}
										disabled={busy}
										onChange={(event) =>
											onToolToggle(name, tool.label, event.target.checked)
										}
									/>
								))}
							</div>
						</details>
					</article>
				);
			})}
		</div>
	);
}

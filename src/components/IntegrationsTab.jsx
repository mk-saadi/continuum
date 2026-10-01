import React from "react";
import { FaAngleRight } from "react-icons/fa";
import { LuX, LuTriangleAlert, LuCircleCheck, LuLoaderCircle, LuCircleMinus } from "react-icons/lu";
import { IoIosCloseCircleOutline } from "react-icons/io";

const errorBadge = {
	color: "var(--error-strong)",
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
	const servers = Object.entries(config?.mcpServers ?? {});

	return (
		<div className="space-y-4 text-[var(--text-primary)]">
			<div>
				<h3 className="text-sm font-semibold">MCP Integrations</h3>
				<p className="mt-1 text-xs text-[var(--text-secondary)]">
					Choose which servers and tools your assistant can use.
				</p>
			</div>

			{(error || status?.error) && (
				<p
					role="alert"
					className="palace-error"
				>
					{error || status.error}
				</p>
			)}

			{!servers.length && (
				<div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center">
					<p className="text-sm">No MCP servers configured.</p>
					<button
						type="button"
						className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
						onClick={onConfigure}
					>
						Add a server
					</button>
				</div>
			)}

			{servers.map(([name, definition]) => {
				const server = status?.servers?.find((item) => item.name === name);
				const enabled = definition?.disabled !== true &&
					(definition?.uiEnabled === true || (definition?.uiEnabled !== false && definition?.disabled === false));
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
						className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
					>
						<div className="flex items-start gap-3 p-3">
							<button
								type="button"
								role="switch"
								aria-checked={enabled}
								aria-label={`Enable server ${name}`}
								disabled={busy}
								onClick={() => onServerToggle(name, !enabled)}
								className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 ${enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--control-border)] cursor-pointer"}`}
							>
								<span
									className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-[var(--surface-raised)] shadow-sm transition-transform ${enabled ? "translate-x-4" : ""}`}
								/>
							</button>

							<div className="min-w-0 flex-1">
								<h4 className="break-words text-sm font-semibold">
									{name.startsWith("mcp/") ? name : `mcp/${name}`}
								</h4>
								<span
									role="status"
									style={badgeStyle}
									className="mt-1 inline-flex items-center gap-1.5 max-w-full rounded-md px-2 py-0.5 text-[11px] break-words"
								>
									{badgeContent}
								</span>
							</div>

							<button
								type="button"
								className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
								aria-label={`Delete MCP server: ${name}`}
								title={`Delete ${name}`}
								disabled={busy}
								onClick={() => onDelete(name)}
							>
								<LuX />
							</button>
						</div>

						<details className="group border-t border-[var(--border)]">
							<summary className="flex cursor-pointer items-center list-none px-3 py-2 text-xs font-medium hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] [&::-webkit-details-marker]:hidden">
								<FaAngleRight className="mr-2 transition-transform duration-200 group-open:rotate-90" />
								Tools{" "}
								<span className="ml-1 text-[var(--text-secondary)]">{tools.length}</span>
							</summary>
							<div className="space-y-2 px-3 pb-3">
								<div className="flex items-center justify-between gap-2 text-xs">
									<span className="text-[var(--text-secondary)]">
										{tools.filter((tool) => !disabledTools.has(tool.label)).length} of{" "}
										{tools.length} permitted
									</span>
									<button
										type="button"
										className="rounded px-2 py-1 text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
										disabled={busy || !tools.length}
										onClick={() => onAllToolsToggle(name, !allEnabled)}
									>
										{allEnabled ? "Disable All" : "Enable All"}
									</button>
								</div>

								{!tools.length && (
									<p className="text-xs text-[var(--text-secondary)]">
										{enabled
											? "No tools discovered."
											: "Enable this server to discover its tools."}
									</p>
								)}

								{tools.map((tool) => (
									<label
										key={tool.name}
										className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs hover:bg-[var(--surface-hover)]"
									>
										<input
											type="checkbox"
											className="accent-[var(--accent)]"
											checked={!disabledTools.has(tool.label)}
											disabled={busy}
											onChange={(event) =>
												onToolToggle(name, tool.label, event.target.checked)
											}
										/>
										<span className="break-all font-mono">{tool.label}</span>
									</label>
								))}
							</div>
						</details>
					</article>
				);
			})}
		</div>
	);
}

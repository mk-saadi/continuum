import React, { useEffect, useState } from "react";
import { LuServer } from "react-icons/lu";
import { TextField } from "./FormControls";
import {
	SettingsButton,
	SettingsCard,
	SettingsHint,
	SettingsMessage,
	SettingsStatus,
} from "./settings/SettingsSection";

export default function LocalApiSettings() {
	const [settings, setSettings] = useState(null);
	const [draft, setDraft] = useState("8080");
	const [activePort, setActivePort] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	useEffect(() => {
		let active = true,
			statusVersion = 0;
		const updateStatus = (status) => {
			if (!active) return;
			statusVersion++;
			setActivePort(status.running ? status.port : null);
		};
		const unsubscribe = window.terminalAPI?.onStatus(updateStatus);
		const initialVersion = statusVersion;
		window.terminalAPI
			?.status()
			.then((status) => {
				if (statusVersion === initialVersion) updateStatus(status);
			})
			.catch((err) => {
				if (active) setError(err.message);
			});
		(async () => {
			try {
				if (!window.api?.getAppSettings)
					throw new Error("Open the desktop app to configure the local API server.");
				const value = await window.api.getAppSettings();
				if (active) {
					setSettings(value);
					setDraft(value.apiServerPort === null ? "" : String(value.apiServerPort));
				}
			} catch (err) {
				if (active) setError(err.message);
			}
		})();
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, []);
	const port = activePort ?? settings?.apiServerPort;
	const endpoint = port ? `http://127.0.0.1:${port}/v1` : null;
	return (
		<SettingsCard
			icon={LuServer}
			title="Local API server"
			description="An OpenAI-compatible endpoint for local apps and scripts."
		>
			<form
				className="space-y-3"
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					setError("");
					setNotice("");
					try {
						const saved = await window.api.saveAppSettings({
							apiServerPort: draft.trim() === "" ? null : Number(draft),
						});
						setSettings(saved);
						setNotice("Saved. The port applies the next time you load the engine.");
					} catch (err) {
						setError(err.message);
					} finally {
						setBusy(false);
					}
				}}
			>
				<TextField
					label="Local API Server Port"
					type="number"
					min="1"
					max="65535"
					step="1"
					value={draft}
					disabled={busy || !settings}
					placeholder="Automatic"
					hint="Default: 8080. Leave blank to choose an available port automatically."
					onChange={(event) => {
						setDraft(event.target.value);
						setNotice("");
					}}
				/>
				<SettingsButton
					type="submit"
					variant="primary"
					disabled={busy || !settings}
				>
					{busy ? "Saving…" : "Save port"}
				</SettingsButton>
			</form>
			<div className="mt-3 space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
				<SettingsStatus active={Boolean(activePort)}>
					{activePort ? "Current engine endpoint" : "Configured endpoint (engine stopped)"}
				</SettingsStatus>
				<code className="block select-text break-all font-mono text-[11px] text-[var(--text-secondary)]">
					{endpoint || "Start the engine to get its automatic port."}
				</code>
				<SettingsButton
					disabled={!endpoint}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(endpoint);
							setError("");
							setNotice("OpenAI Base URL copied.");
						} catch (err) {
							setError(err.message);
						}
					}}
				>
					Copy OpenAI Base URL
				</SettingsButton>
			</div>
			<SettingsMessage tone="success">{notice}</SettingsMessage>
			<SettingsMessage>{error}</SettingsMessage>
			{!window.api?.getAppSettings && (
				<SettingsHint>Open the desktop app to configure the local API server.</SettingsHint>
			)}
		</SettingsCard>
	);
}

import React, { useEffect, useState } from "react";
import { LuHardDrive } from "react-icons/lu";
import { NumberField } from "../FormControls";
import { SettingsButton, SettingsCard, SettingsMessage } from "./SettingsSection";

// Global recovery-storage policy. This is app-wide configuration (retention
// window, disk cap, usage) — deliberately separate from the per-chat
// recovery history shown in the Activity tab.
function formatBytes(value) {
	if (!Number.isFinite(value) || value < 0) return "unavailable";
	const units = ["B", "KB", "MB", "GB"];
	const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
	return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default function RecoveryStorageSettings({ disabled = false }) {
	const [settings, setSettings] = useState(null);
	const [stats, setStats] = useState(null);
	const [drafts, setDrafts] = useState({ recoveryRetentionDays: "", recoveryStorageCapMB: "" });
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		try {
			const [value, usage] = await Promise.all([
				window.api.getAppSettings(),
				window.api.getRecoveryStats(),
			]);
			setSettings(value);
			setStats(usage);
			setDrafts({
				recoveryRetentionDays: String(value.recoveryRetentionDays),
				recoveryStorageCapMB: String(value.recoveryStorageCapMB),
			});
			setError("");
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		}
	};

	useEffect(() => {
		if (window.api?.getAppSettings) refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const commitNumber = async (key, raw) => {
		const text = raw.trim();
		if (text === "") {
			setError("Enter a whole number.");
			return;
		}
		const value = Number(text);
		if (!Number.isSafeInteger(value)) {
			setError("Budgets must be whole numbers.");
			return;
		}
		setError("");
		setNotice("");
		try {
			const saved = await window.api.saveAppSettings({ [key]: value });
			setSettings(saved);
			setDrafts((current) => ({ ...current, [key]: String(saved[key]) }));
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		}
	};

	const runPrune = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const report = await window.api.pruneRecoveryStore();
			setNotice(
				`Cleanup kept ${report.kept} checkpoint${report.kept === 1 ? "" : "s"}` +
					` and removed ${report.pruned.length + report.capEvicted.length}` +
					(report.capShortfallMB > 0 ? `; still ${report.capShortfallMB} MB over the cap (pinned and recent points are never forced out)` : "."),
			);
			setStats(await window.api.getRecoveryStats());
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsCard
			icon={LuHardDrive}
			title="Workspace recovery storage"
			description="File snapshots behind the per-chat recovery history. Oldest unpinned checkpoints are cleaned automatically; pinned checkpoints and each session's latest points are never forced out. Snapshot content lives outside your projects and is never synced anywhere."
		>
			<div className="grid grid-cols-2 gap-3">
				<NumberField
					label="Keep history (days)"
					min={1}
					max={365}
					value={drafts.recoveryRetentionDays}
					disabled={disabled || settings === null}
					onChange={(event) => setDrafts((current) => ({ ...current, recoveryRetentionDays: event.target.value }))}
					onBlur={(event) => commitNumber("recoveryRetentionDays", event.target.value)}
				/>
				<NumberField
					label="Storage cap (MB)"
					min={64}
					max={8192}
					value={drafts.recoveryStorageCapMB}
					disabled={disabled || settings === null}
					onChange={(event) => setDrafts((current) => ({ ...current, recoveryStorageCapMB: event.target.value }))}
					onBlur={(event) => commitNumber("recoveryStorageCapMB", event.target.value)}
				/>
			</div>
			<p className="mt-3 text-[11px] tabular-nums leading-relaxed text-[var(--text-secondary)]">
				Using {stats ? formatBytes(stats.physicalBytes) : "…"} on disk
				{stats ? ` (${stats.checkpointCount} checkpoints · ${formatBytes(stats.logicalBytes)} of history)` : ""}.
			</p>
			<div className="mt-2">
				<SettingsButton
					onClick={runPrune}
					disabled={disabled || busy}
				>
					{busy ? "Cleaning…" : "Clean up now"}
				</SettingsButton>
			</div>
			<SettingsMessage tone="success">{notice}</SettingsMessage>
			<SettingsMessage>{error}</SettingsMessage>
		</SettingsCard>
	);
}

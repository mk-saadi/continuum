import React, { useEffect, useState } from "react";
import { LuBell } from "react-icons/lu";
import { SettingsCard, SettingsCheckRow, SettingsMessage } from "./SettingsSection";

const eventChoices = [
	["completion", "Task completion"],
	["error", "Execution errors & failures"],
	["contextOverflow", "Context / token overflows"],
	["action_required", "Agent needs input"],
];

export default function NotificationSettings() {
	const [prefs, setPrefs] = useState(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			.getAppSettings()
			.then((settings) => {
				if (active) setPrefs(settings);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	async function update(patch) {
		if (saving || !prefs) return;
		setSaving(true);
		setError("");
		try {
			setPrefs(await window.api.setNotificationPrefs(patch));
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	const disabled = !prefs || saving;
	return (
		<SettingsCard
			icon={LuBell}
			title="Desktop notifications"
			description="Choose when Continuum should send an OS notification for agent work."
		>
			<div className="space-y-0.5">
				<SettingsCheckRow
					role="switch"
					label="Enable desktop notifications"
					checked={prefs?.notificationsEnabled ?? true}
					disabled={disabled}
					onChange={(event) => update({ notificationsEnabled: event.target.checked })}
				/>
				<SettingsCheckRow
					role="switch"
					label="Notify only when unfocused / backgrounded"
					checked={prefs?.notifyOnlyWhenBackgrounded ?? true}
					disabled={disabled || !prefs.notificationsEnabled}
					onChange={(event) => update({ notifyOnlyWhenBackgrounded: event.target.checked })}
				/>
			</div>
			<fieldset
				disabled={disabled || !prefs.notificationsEnabled}
				className="mt-3 border-t border-[var(--border)] pt-3 disabled:opacity-50"
			>
				<legend className="px-1 text-[11px] font-semibold text-[var(--text-secondary)]">
					Notify on events
				</legend>
				<div className="mt-1 space-y-0.5">
					{eventChoices.map(([key, label]) => (
						<SettingsCheckRow
							key={key}
							label={label}
							checked={prefs?.notificationEvents?.[key] ?? true}
							onChange={(event) =>
								update({ notificationEvents: { [key]: event.target.checked } })
							}
						/>
					))}
				</div>
			</fieldset>
			<SettingsMessage>{error}</SettingsMessage>
		</SettingsCard>
	);
}

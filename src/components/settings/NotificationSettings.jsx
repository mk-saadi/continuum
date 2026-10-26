import React, { useEffect, useState } from "react";
import { LuBell } from "react-icons/lu";
import { SettingsCard, SettingsCheckRow, SettingsMessage, SettingsButton } from "./SettingsSection";

import { notificationSounds, defaultSoundPrefs } from '../../lib/notificationSounds.mjs';

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
			const next = await window.api.setNotificationPrefs(patch);
            setPrefs(next);
            notificationSounds.setPrefs(next.notificationSounds);
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	const disabled = !prefs || saving;
	return (
		<>
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
        <SettingsCard icon={LuBell} title="Notification Sounds" description="Short, gentle chimes for agent work, including background tabs.">
            <SettingsCheckRow role="switch" label="Enable notification sounds" checked={prefs?.notificationSounds?.enabled ?? true} disabled={disabled}
                onChange={e => update({ notificationSounds: { enabled: e.target.checked } })} />
            <label className="mt-3 block text-xs">
                Volume — {prefs?.notificationSounds?.volume ?? defaultSoundPrefs.volume}%
                <input className="mt-2 w-full accent-[var(--accent)]" type="range" min="0" max="100" step="1"
                    aria-label="Notification sound volume" disabled={disabled}
                    value={prefs?.notificationSounds?.volume ?? defaultSoundPrefs.volume}
                    onChange={e => update({ notificationSounds: { volume: Number(e.target.value) } })} />
            </label>
            {[["completed", "Task completed"], ["interrupted", "Task interrupted"], ["inputRequired", "User input required"]].map(([key, label]) => (
                <div key={key} className="mt-2 flex items-center justify-between gap-2">
                    <SettingsCheckRow label={label} checked={prefs?.notificationSounds?.[key] ?? true} disabled={disabled}
                        onChange={e => update({ notificationSounds: { [key]: e.target.checked } })} />
                    <SettingsButton aria-label={`Preview ${label.toLowerCase()} sound`}
                        disabled={disabled || prefs?.notificationSounds?.enabled === false || prefs?.notificationSounds?.[key] === false || prefs?.notificationSounds?.volume === 0}
                        onClick={() => { notificationSounds.setPrefs(prefs.notificationSounds); void notificationSounds.play(key); }}>Preview</SettingsButton>
                </div>
            ))}
        </SettingsCard>
        </>
	);
}

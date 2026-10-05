import React, { useEffect, useState } from "react";

const eventChoices = [
	["completion", "Task Completion"],
	["error", "Execution Errors & Failures"],
	["contextOverflow", "Context / Token Overflows"],
	["action_required", "Agent Needs Input"],
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
		<section
			className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
			aria-labelledby="desktop-notifications-title"
		>
			<h4
				id="desktop-notifications-title"
				className="font-semibold"
			>
				Desktop Notifications
			</h4>
			<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
				Choose when Continuum should send an OS notification for agent work.
			</p>
			<div className="mt-4 space-y-3">
				<label className="flex items-center justify-between gap-4 text-sm">
					<span>Enable Desktop Notifications</span>
					<input
						type="checkbox"
						role="switch"
						checked={prefs?.notificationsEnabled ?? true}
						disabled={disabled}
						onChange={(event) => update({ notificationsEnabled: event.target.checked })}
						className="size-4 accent-[var(--accent)]"
					/>
				</label>
				<label className="flex items-center justify-between gap-4 text-sm">
					<span>Notify Only When Unfocused / Backgrounded</span>
					<input
						type="checkbox"
						role="switch"
						checked={prefs?.notifyOnlyWhenBackgrounded ?? true}
						disabled={disabled || !prefs.notificationsEnabled}
						onChange={(event) => update({ notifyOnlyWhenBackgrounded: event.target.checked })}
						className="size-4 accent-[var(--accent)]"
					/>
				</label>
				<fieldset
					disabled={disabled || !prefs.notificationsEnabled}
					className="border-t border-[var(--border)] pt-3 disabled:opacity-50"
				>
					<legend className="px-1 text-xs font-semibold text-[var(--text-muted)]">
						Notify On Events
					</legend>
					<div className="mt-2 space-y-2">
						{eventChoices.map(([key, label]) => (
							<label
								key={key}
								className="flex items-center gap-3 text-sm"
							>
								<input
									type="checkbox"
									checked={prefs?.notificationEvents?.[key] ?? true}
									onChange={(event) =>
										update({ notificationEvents: { [key]: event.target.checked } })
									}
									className="size-4 accent-[var(--accent)]"
								/>
								<span>{label}</span>
							</label>
						))}
					</div>
				</fieldset>
			</div>
			{error && (
				<p
					role="alert"
					className="mt-3 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
		</section>
	);
}

import React, { useEffect, useState } from "react";
import SubagentModelSelect from "../SubagentModelSelect";

const limits = [
	{
		key: "maxConsecutiveToolFailures",
		label: "Max Consecutive Tool Failures",
		min: 3,
		max: 10,
		fallback: 5,
	},
	{ key: "maxTotalToolFailures", label: "Max Total Tool Failures", min: 5, max: 25, fallback: 10 },
];

export default function GeneralSettingsTab() {
	const [settings, setSettings] = useState(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			.getAppSettings()
			.then((value) => {
				if (active) setSettings(value);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	async function update(key, value) {
		if (!settings || saving) return;
		setSaving(true);
		setError("");
		try {
			setSettings(await window.api.saveAppSettings({ [key]: value }));
			// App settings (memory, MCP) reshape the prepared prompt;
			// listeners refresh their context measurements.
			window.dispatchEvent(new Event("generation-settings-changed"));
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<section
				className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
				aria-labelledby="subagent-model-title"
			>
				<h4
					id="subagent-model-title"
					className="font-semibold"
				>
					Sub-Agent Model
				</h4>
				<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
					Model used by spawned sub-agents. "Follow the chat model" (default) runs children on
					whatever the current chat uses; choosing something else gives sub-agents their own model
					without changing this chat. Whichever model is chosen, sub-agents stay read-only.
				</p>
				<div className="mt-4">
					<SubagentModelSelect disabled={saving} />
				</div>
			</section>
			<section
				className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
				aria-labelledby="execution-guardrails-title"
			>
				<h4
					id="execution-guardrails-title"
					className="font-semibold"
				>
					Execution Guardrails
				</h4>
				<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
					Stop an agent run when tool failures reach either limit.
				</p>
				<div className="mt-4 space-y-4">
					{limits.map(({ key, label, min, max, fallback }) => (
						<label
							key={key}
							className="block text-sm"
						>
							<span className="flex items-center justify-between gap-3">
								<span>{label}</span>
								<output>{settings?.[key] ?? fallback}</output>
							</span>
							<input
								type="range"
								min={min}
								max={max}
								step="1"
								value={settings?.[key] ?? fallback}
								disabled={!settings || saving}
								onChange={(event) => update(key, Number(event.target.value))}
								className="mt-2 w-full accent-[var(--accent)]"
							/>
						</label>
					))}
				</div>
			</section>
			{error && (
				<p
					role="alert"
					className="mb-5 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
		</>
	);
}

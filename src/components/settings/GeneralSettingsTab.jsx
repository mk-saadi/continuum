import React, { useEffect, useState } from "react";
import { SliderField } from "../FormControls";
import SubagentModelSelect from "../SubagentModelSelect";
import SubagentBudgetSettings from "../SubagentBudgetSettings";
import { SettingsCard, SettingsMessage } from "./SettingsSection";
import { LuBot, LuShieldCheck } from "react-icons/lu";

import RememberedToolApprovals from "./RememberedToolApprovals";

const limits = [
	{
		key: "maxConsecutiveToolFailures",
		label: "Consecutive failures",
		min: 3,
		max: 10,
		fallback: 5,
	},
	{ key: "maxTotalToolFailures", label: "Total failures", min: 5, max: 25, fallback: 10 },
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
            <RememberedToolApprovals />
			<SettingsCard
				icon={LuBot}
				title="Sub-agents"
				description="Use the chat model or choose a separate model for delegated tasks. Sub-agents are always read-only."
			>
				<div className="space-y-3">
					<SubagentModelSelect disabled={saving} />
					<SubagentBudgetSettings disabled={saving} />
				</div>
			</SettingsCard>
			<SettingsCard
				icon={LuShieldCheck}
				title="Stop after tool failures"
				description="End a run when either limit is reached."
			>
				<div className="space-y-3">
					{limits.map(({ key, label, min, max, fallback }) => (
						<SliderField
							key={key}
							label={label}
							valueLabel={settings?.[key] ?? fallback}
							min={min}
							max={max}
							step={1}
							value={settings?.[key] ?? fallback}
							disabled={!settings || saving}
							onChange={(event) => {
								const value = Number(event.target.value);
								setSettings((previous) => ({ ...previous, [key]: value }));
							}}
							onCommit={(event) => update(key, Number(event.target.value))}
						/>
					))}
				</div>
			</SettingsCard>
			<SettingsMessage>{error}</SettingsMessage>
		</>
	);
}

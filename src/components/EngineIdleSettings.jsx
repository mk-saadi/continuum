import React, { useEffect, useState } from "react";
import { LuTimer } from "react-icons/lu";
import { SelectField } from "./FormControls";
import { SettingsCard, SettingsMessage } from "./settings/SettingsSection";

export default function EngineIdleSettings() {
	const [minutes, setMinutes] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		window.api
			.getConfig()
			.then((config) => {
				if (active) setMinutes(config.engineIdleTimeoutMinutes ?? -1);
			})
			.catch((error) => {
				if (active) setError(error.message);
			});
		return () => {
			active = false;
		};
	}, []);
	async function save(value) {
		setBusy(true);
		setError("");
		try {
			const config = await window.api.setEngineIdleTimeout(value);
			setMinutes(config.engineIdleTimeoutMinutes);
		} catch (error) {
			setError(error.message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<SettingsCard
			icon={LuTimer}
			title="Engine idle timeout"
			description="How long the loaded model stays in memory while idle. Active replies finish before the countdown starts."
		>
			<SelectField
				label="Keep in memory"
				value={minutes ?? -1}
				disabled={minutes === null || busy}
				onChange={(event) => save(Number(event.target.value))}
			>
				<option value={5}>5 minutes</option>
				<option value={15}>15 minutes</option>
				<option value={60}>60 minutes</option>
				<option value={-1}>Never unload</option>
			</SelectField>
			<SettingsMessage>{error}</SettingsMessage>
		</SettingsCard>
	);
}

import React from "react";
import { LuSparkles } from "react-icons/lu";
import useAppearance from "../../hooks/useAppearance";
import { CheckboxField } from "../FormControls";
import { SettingsCard } from "./SettingsSection";

export default function AppearanceSettings() {
	const [appearance, setAppearance] = useAppearance();
	return (
		<SettingsCard icon={LuSparkles} title="Visual effects">
			<CheckboxField
				label="Aero glass"
				role="switch"
				hint="Glossy glass surfaces and background blur throughout the app. Turn off for a simpler appearance and lower GPU usage."
				checked={appearance === "aero"}
				onChange={(event) => setAppearance(event.target.checked ? "aero" : "flat")}
			/>
		</SettingsCard>
	);
}

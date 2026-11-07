import React, { useId } from "react";
import { LuSparkles } from "react-icons/lu";
import useAppearance from "../../hooks/useAppearance";
import { SettingsCard } from "./SettingsSection";

const styles = [
	{ value: "flat", label: "Flat", hint: "Simple surfaces" },
	{ value: "aero", label: "Aero Glass", hint: "Reflective glass" },
	{ value: "skeu", label: "Skeu", hint: "Satin & texture" },
];

export default function AppearanceSettings() {
	const [appearance, setAppearance] = useAppearance();
	const name = useId();
	return (
		<SettingsCard icon={LuSparkles} title="Visual effects">
			<fieldset>
				<legend className="mb-2 text-xs font-medium">UI design style</legend>
				<div className="grid grid-cols-3 gap-2">
					{styles.map(({ value, label, hint }) => (
						<label key={value} data-selected={appearance === value}
							className="aero-control sk-button flex cursor-pointer items-start gap-2 px-2.5 py-2 text-xs">
							<input type="radio" name={name} value={value} checked={appearance === value}
								onChange={() => setAppearance(value)} className="appearance-radio sk-radio mt-0.5 shrink-0 accent-[var(--accent)]" />
							<span><span className="block font-semibold">{label}</span>
								<span className="mt-1 block text-[10px] leading-relaxed">{hint}</span></span>
						</label>
					))}
				</div>
			</fieldset>
		</SettingsCard>
	);
}

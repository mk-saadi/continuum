import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { KnobField } from "../../src/components/FormControls";
import ModelProfileSettings from "../../src/components/ModelProfileSettings";
import { applyTheme } from "../../src/lib/themes.mjs";
window.knobTheme = (theme) => applyTheme(document.documentElement, theme);
window.commits = [];
window.saved = [];
window.api = {
	getEffectiveSettings: async () => ({
		effective: {
			temperature: 1,
			topP: 0.95,
			topK: 20,
			repeatPenalty: 1,
			maxTokens: -1,
			systemPrompt: "",
		},
	}),
	saveProfileSettings: async (path, patch) => window.saved.push({ path, patch }),
};
function Fixture() {
	const [value, setValue] = useState(1);
	return (
		<main style={{ padding: 40, maxWidth: 700 }}>
			<div style={{ display: "flex", gap: 40 }}>
				<KnobField
					label="Small dial"
					hint="Drag or use arrow keys"
					size={48}
					min={0}
					max={2}
					step={0.05}
					value={value}
					valueLabel={value}
					onChange={(e) => setValue(Number(e.target.value))}
					onCommit={(e) => window.commits.push(Number(e.target.value))}
				/>
				<KnobField
					label="Large dial"
					hint="Same text size"
					size={112}
					min={0}
					max={2}
					step={0.05}
					value={value}
					valueLabel={value}
					onChange={(e) => setValue(Number(e.target.value))}
				/>
				<KnobField
					label="Disabled dial"
					disabled
					value={1}
				/>
			</div>
			<ModelProfileSettings
				modelPath="test-model"
				samplingControl="knob"
			/>
			<ModelProfileSettings section="generation" />
		</main>
	);
}
createRoot(document.getElementById("root")).render(<Fixture />);

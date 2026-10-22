import React from "react";
import { LuFileText } from "react-icons/lu";
import { SettingsCard, SettingsHint } from "./settings/SettingsSection";

export default function RagSettings() {
	return (
		<SettingsCard
			icon={LuFileText}
			title="Offline document chat"
			description="Documents are indexed locally using all-MiniLM-L6-v2. Document text stays on this computer."
		>
			<SettingsHint>
				The embedding model downloads on first use and is cached for offline use. PDFs need a text
				layer; OCR is not included.
			</SettingsHint>
		</SettingsCard>
	);
}

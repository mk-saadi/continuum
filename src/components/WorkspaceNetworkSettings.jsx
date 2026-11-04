import React, { useEffect, useState } from "react";
import { LuNetwork } from "react-icons/lu";
import { SelectField } from "./FormControls";
import { SettingsCard, SettingsMessage } from "./settings/SettingsSection";

export default function WorkspaceNetworkSettings() {
	const [policy, setPolicy] = useState("isolated");
	const [status, setStatus] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		Promise.all([window.api.getConfig(), window.api.getWorkspaceNetworkStatus()])
			.then(([config, readiness]) => {
				if (active) {
					setPolicy(config.workspaceNetwork.policy);
					setStatus(readiness);
				}
			})
			.catch((e) => {
				if (active) setError(e.message);
			});
		return () => {
			active = false;
		};
	}, []);
	async function save(value) {
		setBusy(true);
		setError("");
		try {
			const config = await window.api.setWorkspaceNetwork({ version: 2, policy: value });
			setPolicy(config.workspaceNetwork.policy);
		} catch (e) {
			setError(e.message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<SettingsCard
			icon={LuNetwork}
			title="Workspace Write Networking"
			description="Applies to all Workspace Write sessions. Filesystem restrictions and command approvals remain in effect."
		>
			<SelectField
				label="Terminal networking"
				value={policy}
				disabled={!status || busy}
				onChange={(e) => save(e.target.value)}
			>
				<option value="isolated">Isolated — No terminal internet access</option>
				<option
					value="trusted_development"
					disabled={!status?.available}
				>
					Trusted Development — May reach host and private services
				</option>
			</SelectField>
			<p className="text-xs mt-2!">{status?.disclosure}</p>
			{!status?.available && status && (
				<p className="text-xs mt-2!">Trusted Development unavailable: {status.blockers.join(" ")}</p>
			)}
			<SettingsMessage>{error}</SettingsMessage>
		</SettingsCard>
	);
}

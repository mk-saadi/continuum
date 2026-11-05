import React, { useEffect, useState } from "react";
import { LuNetwork } from "react-icons/lu";
import { SelectField } from "./FormControls";
import { SettingsCard, SettingsMessage } from "./settings/SettingsSection";

export default function WorkspaceNetworkSettings() {
	const [policy, setPolicy] = useState("standard_outbound");
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
				if (active) { console.error('Workspace networking status:', e); setError('Networking status could not be read. See developer diagnostics.'); }
			});
        const timer = setInterval(() => {
            window.api.getWorkspaceNetworkStatus().then(readiness => {
                if (!active) return;
                setStatus(readiness);
                if (readiness.effectivePolicy) setPolicy(readiness.effectivePolicy);
            }).catch(e => {
                if (active) {
                    console.error('Workspace networking status:', e);
                    setStatus({ available: false, code: 'NETWORK_STATUS_UNAVAILABLE', message: 'Networking status could not be read. See developer diagnostics.' });
                }
            });
        }, 2000);
		return () => {
            clearInterval(timer);
			active = false;
		};
	}, []);
	async function save(value) {
        if (value === 'trusted_development' && (!status?.available || status?.protectedConsentAvailable === false)) {
            setError(status?.protectedConsentAvailable === false ? 'OS-protected settings storage is required for elevated networking.' : status?.message || 'Elevated networking is unavailable in this build.');
            return;
        }
		setBusy(true);
		setError("");
		try {
			const config = await window.api.setWorkspaceNetwork({ version: 3, policy: value });
			setPolicy(config.workspaceNetwork.policy);
            setStatus(await window.api.getWorkspaceNetworkStatus());
		} catch (e) {
			console.error('Workspace networking:', e);
			setStatus(await window.api.getWorkspaceNetworkStatus());
			setError('Networking could not be changed. See the status below and developer diagnostics.');
		} finally {
			setBusy(false);
		}
	}
	const elevatedAvailable = status?.available && status?.protectedConsentAvailable !== false;
	return (
		<SettingsCard
			icon={LuNetwork}
			title="Workspace Write Networking"
			description="Applies to all Workspace Write sessions. Commands run autonomously within the sandbox. Filesystem and process restrictions remain in effect."
		>
			<SelectField
				label="Terminal networking"
				value={policy}
				disabled={!status || busy || status.code === 'NETWORK_STATUS_UNAVAILABLE'}
				onChange={(e) => save(e.target.value)}
			>
				<option value="standard_outbound">Standard outbound internet (default)</option>
				<option value="isolated">Isolated — no terminal internet access</option>
				<option
					value="trusted_development"
					disabled={!elevatedAvailable}
				>
					Elevated networking — may also reach host and private services
				</option>
			</SelectField>
			<p className="text-xs mt-2!">{status?.build}</p>
            {status?.protectedConsentAvailable === false && <p className="text-xs mt-2!">OS-protected settings storage is required before elevated networking can be enabled.</p>}
            {status && status.available === false && (
                <p className="text-xs mt-2!">
                    Networking unavailable: {status.message || 'This build has not been qualified for networking.'}
                </p>
            )}
            {status?.available && <p className="text-xs mt-2!">Networking resources are present and verified in this build.</p>}
            <p className="text-xs mt-2!">{status?.code === 'NETWORK_STATUS_UNAVAILABLE' ? 'Current terminal networking status is unknown.' : policy === 'isolated' ? 'Terminal internet access is disabled. Workspace commands can still operate on local files.' : policy === 'trusted_development' ? 'Elevated networking selected: commands may additionally reach host-local and private network services.' : 'Standard outbound internet is enabled: package installs, dependency downloads and public HTTPS requests work inside the sandbox. Host loopback and private LAN stay blocked.'}</p>
            <p className="text-xs mt-2!">{status?.disclosure}</p>
            {status?.available && <p className="text-xs mt-2!">Runtime prerequisites verified; containment is checked when commands start. Elevated networking requires a one-time consent dialog; standard outbound access does not.</p>}
            {status?.available && policy === 'trusted_development' && <p className="text-xs mt-2!">{status.operational ? 'Networking operational: an authorized sandbox owner is active.' : 'Elevated networking ready: no active sandbox owner.'}</p>}
			<SettingsMessage>{error}</SettingsMessage>
		</SettingsCard>
	);
}

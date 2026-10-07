import React, { useEffect, useState } from "react";
import { SelectField } from "./FormControls";

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
		<section className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
			<SelectField
				label="Engine Idle Timeout (Keep in Memory)"
				value={minutes ?? -1}
				disabled={minutes === null || busy}
				hint="Applies to every model. Active replies finish before the idle countdown starts."
				onChange={(event) => save(Number(event.target.value))}
			>
				<option value={5}>5m</option>
				<option value={15}>15m</option>
				<option value={60}>60m</option>
				<option value={-1}>Never</option>
			</SelectField>
			{error && (
				<p
					role="alert"
					className="mt-2 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
		</section>
	);
}

import React, { useEffect, useRef, useState } from "react";
import { NumberField, SliderField } from "./FormControls";

const controls = [
	{ key: "temperature", label: "Temperature", type: "range", min: 0, max: 2, step: 0.05 },
	{ key: "top_p", label: "Top-P", type: "range", min: 0, max: 1, step: 0.05 },
	{ key: "top_k", label: "Top-K", type: "number", min: 1, max: 100, step: 1 },
	{ key: "repeat_penalty", label: "Repeat Penalty", type: "range", min: 1, max: 1.5, step: 0.01 },
	{ key: "max_tokens", label: "Max Tokens", type: "number", min: -1, step: 1 },
];

const ChatTuning = ({ sessionId, modelId }) => {
	const [state, setState] = useState(null);
	const [error, setError] = useState("");
	const [status, setStatus] = useState("Loading…");
	const version = useRef(0);
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		(async () => {
			try {
				if (!window.api?.getSamplingParams)
					throw new Error("Open the desktop app to tune generation.");
				const result = await window.api.getSamplingParams(sessionId);
				if (alive.current) {
					setState(result);
					setStatus("");
				}
			} catch (err) {
				if (alive.current) {
					setError(err.message);
					setStatus("");
				}
			}
		})();
		return () => {
			alive.current = false;
		};
	}, [sessionId]);

	async function save(params) {
		const request = ++version.current;
		setError("");
		setStatus("Saving…");
		try {
			const result = await window.api.saveSamplingParams(sessionId, modelId, params);
			if (alive.current && request === version.current) {
				setState(result);
				setStatus("Saved");
			}
		} catch (err) {
			if (alive.current && request === version.current) {
				setError(err.message);
				setStatus("Not saved");
			}
		}
	}

	return (
		<div className="space-y-2">
			<p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
				Changes auto-save and apply to the next generation request. A response already streaming keeps
				its current settings.
			</p>

			{state &&
				controls.map((control) => {
					const commonProps = {
						key: control.key,
						label: control.label,
						min: control.min,
						max: control.max,
						step: control.step,
						value: state.params[control.key],
						disabled: !!sessionId && !modelId && !state.exists,
						onChange: (event) => {
							const raw = event.target.value;
							setState((previous) => ({
								...previous,
								params: { ...previous.params, [control.key]: raw },
							}));
							const value = Number(raw);
							if (
								raw === "" ||
								!Number.isFinite(value) ||
								value < control.min ||
								(control.max !== undefined && value > control.max) ||
								(control.type === "number" && !Number.isSafeInteger(value)) ||
								(control.key === "max_tokens" && value === 0)
							) {
								setError(
									"Enter a valid value. Max Tokens accepts -1 (unlimited) or a positive integer.",
								);
								return;
							}
							save({ [control.key]: value });
						},
					};

					if (control.type === "range") {
						return (
							<SliderField
								{...commonProps}
								valueLabel={state.params[control.key]}
							/>
						);
					}

					return (
						<NumberField
							{...commonProps}
							hint={
								control.key === "max_tokens"
									? "-1 means unlimited generation, subject to the model’s context window."
									: undefined
							}
						/>
					);
				})}

			{sessionId && state && (
				<div className="mt-6 space-y-3 pt-2 border-t border-[var(--border)]">
					<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
						{Object.keys(state.overrides).length
							? "This chat has custom overrides."
							: "This chat follows global defaults."}
					</p>
					<button
						type="button"
						className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
						disabled={!Object.keys(state.overrides).length || status === "Saving…"}
						onClick={() => save(null)}
					>
						Use global defaults
					</button>
				</div>
			)}

			{!modelId && sessionId && state && !state.exists && (
				<p className="text-[11px] text-[var(--text-secondary)]">
					Select a model to save tuning for this new chat.
				</p>
			)}

			{(status || error) && (
				<div className="flex items-center gap-2 mt-2">
					{status && (
						<p
							role="status"
							className="text-[11px] font-medium text-[var(--text-secondary)]"
						>
							{status}
						</p>
					)}
					{error && (
						<p
							role="alert"
							className="text-[11px] font-medium text-[var(--error)]"
						>
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
};

export default ChatTuning;

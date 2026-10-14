import React, { useEffect, useState } from "react";
import { NumberField, SelectField } from "./FormControls";

// Sub-agent task token budgets, next to Settings → General → Sub-Agent Model.
// Same standalone-settings pattern: window.api.getSubagentBudgets /
// saveSubagentBudgets persist one app-wide { mode, maxInputTokens,
// maxOutputTokens } record. Automatic (default) derives bounded per-task
// budgets from the task kind and the child context window; Custom sets independently enforced cumulative dispatch allowances.
export default function SubagentBudgetSettings({ disabled = false }) {
	const [settings, setSettings] = useState(undefined);
	const [policy, setPolicy] = useState(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [draftInput, setDraftInput] = useState("");
	const [draftOutput, setDraftOutput] = useState("");
	const [draftLimits, setDraftLimits] = useState({});

	useEffect(() => {
		let active = true;
		window.api
			.getSubagentBudgets()
			.then((value) => {
				if (!active) return;
				setSettings(value.settings);
				setPolicy(value.policy);
				setDraftInput(value.settings.maxInputTokens ?? "");
				setDraftOutput(value.settings.maxOutputTokens ?? "");
				setDraftLimits(Object.fromEntries(["maxToolCalls", "maxTurns", "maxAggregateToolCalls"].map(key => [key, value.settings[key] ?? ""])));
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	const commit = async (patch) => {
		if (saving || settings === undefined) return;
		setSaving(true);
		setError("");
		try {
			const value = await window.api.saveSubagentBudgets(patch);
			setSettings(value.settings);
			setPolicy(value.policy);
			setDraftInput(value.settings.maxInputTokens ?? "");
			setDraftOutput(value.settings.maxOutputTokens ?? "");
				setDraftLimits(Object.fromEntries(["maxToolCalls", "maxTurns", "maxAggregateToolCalls"].map(key => [key, value.settings[key] ?? ""])));
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	};

	const commitNumber = (key, raw, setter) => {
		const text = raw.trim();
		if (text === "") {
			setter("");
			commit({ [key]: null });
			return;
		}
		const value = Number(text);
		if (!Number.isSafeInteger(value)) {
			setError("Budgets must be whole numbers.");
			return;
		}
		setter(text);
		commit({ [key]: value });
	};

	const custom = settings?.mode === "custom";

	return (
		<>
			<SelectField
				label="Sub-agent execution budgets"
				value={settings?.mode ?? "auto"}
				disabled={disabled || saving || settings === undefined}
				onChange={(event) => commit({ mode: event.target.value })}
			>
				<option value="auto">Automatic (recommended)</option>
				<option value="custom">Custom hard limits</option>
			</SelectField>
			<p className="mt-2 text-xs text-[var(--text-muted)]">
				Automatic bounds each child across its entire lifetime
				{policy
					? ` (investigation up to ${policy.maxTurns.investigation} total model requests × ${policy.perRequestCeiling.investigation} output tokens; input ${policy.inputRule})`
					: ""}
				. Investigations default to 25 tool calls; the parent run shares 100 calls.
				The last investigation request is reserved for tool-free reporting; compaction and retries also consume requests. Custom overrides each limit independently; blank fields use Automatic. Changing settings affects new children. Inspect child activity for effective limits and measured, estimated, or reserved usage.
			</p>
			{custom && (
				<div className="mt-3 grid grid-cols-2 gap-3">
					{[
						["maxToolCalls", "Tool calls per child", 100],
						["maxTurns", "Model requests per child", 100],
						["maxAggregateToolCalls", "Tool calls per parent run", 10000],
					].map(([key, label, max]) => (
						<NumberField key={key} label={label} min={1} max={max}
							value={draftLimits[key] ?? ""} placeholder="Automatic"
							disabled={disabled || saving || settings === undefined}
							onChange={event => setDraftLimits(current => ({ ...current, [key]: event.target.value }))}
							onBlur={event => commitNumber(key, event.target.value, value => setDraftLimits(current => ({ ...current, [key]: value })))} />
					))}
					<NumberField
						label="Max input tokens"
						value={draftInput}
						min={512}
						max={1000000}
						placeholder="e.g. 200000"
						disabled={disabled || saving || settings === undefined}
						onChange={(event) => setDraftInput(event.target.value)}
						onBlur={(event) => commitNumber("maxInputTokens", event.target.value, setDraftInput)}
					/>
					<NumberField
						label="Max output tokens"
						value={draftOutput}
						min={256}
						max={500000}
						placeholder="e.g. 16000"
						disabled={disabled || saving || settings === undefined}
						onChange={(event) => setDraftOutput(event.target.value)}
						onBlur={(event) => commitNumber("maxOutputTokens", event.target.value, setDraftOutput)}
					/>
				</div>
			)}
			{custom && (
				<p className="mt-2 text-xs text-[var(--text-muted)]">
					Input counts every token sent across all requests (history re-sent each turn
					counts again); output counts every generated token, including reasoning.
					Retries and final reporting count as requests. Missing output usage reserves the request allowance.
					Exhausted children return an explicit stop reason and available evidence; the last request is reserved for tool-free reporting.
				</p>
			)}
			{error && (
				<p role="alert" className="mt-2 text-xs text-[var(--error)]">
					{error}
				</p>
			)}
		</>
	);
}

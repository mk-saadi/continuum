import React, { useEffect, useState } from "react";
import { NumberField, SelectField, CheckboxField } from "./FormControls";

// Sub-agent task token budgets, next to Settings → General → Sub-Agent Model.
// Same standalone-settings pattern: window.api.getSubagentBudgets /
// saveSubagentBudgets persist one app-wide { mode, maxInputTokens,
// maxOutputTokens, maxToolCalls, maxTurns, maxAggregateToolCalls } record.
// Automatic (default) derives a bounded long-horizon envelope from the task
// kind and the child context window; Custom sets each limit independently.
//
// Each Custom field is one of three explicit states, matching the backend
// contract (src/main/subagents/budgetSettings.js):
//   - blank            → Automatic for that field (saved as null)
//   - a whole number   → a finite, strictly enforced limit
//   - "No limit"       → the explicit UNBOUNDED sentinel (no numeric ceiling).
// Unbounded relaxes only the numeric budget; it never disables permissions,
// the model context window, cancellation, concurrency or provider limits.
// The finite bounds and the sentinel come from describeAutoPolicy().limits so
// the UI, the parser and the backend always agree.
const UNBOUNDED = "unbounded";
const FALLBACK_LIMITS = {
	maxToolCalls: { min: 1, max: 10000000 },
	maxTurns: { min: 1, max: 10000000 },
	maxAggregateToolCalls: { min: 1, max: 100000000 },
	maxInputTokens: { min: 512, max: 1000000000 },
	maxOutputTokens: { min: 256, max: 1000000000 },
	maxRuntimeMs: { min: 1000, max: 604800000 },
	requestTimeoutMs: { min: 1000, max: 86400000 },
	requestInactivityMs: { min: 1000, max: 3600000 },
};
const FIELDS = [
	["maxToolCalls", "Tool calls per child", "e.g. 400"],
	["maxTurns", "Model requests per child", "e.g. 200"],
	["maxAggregateToolCalls", "Tool calls per parent run", "e.g. 2000"],
	["maxInputTokens", "Max input tokens", "e.g. 200000"],
	["maxOutputTokens", "Max output tokens", "e.g. 16000"],
	["maxRuntimeMs", "Execution deadline (ms)", "e.g. 3600000"],
	["requestTimeoutMs", "Model request timeout (ms)", "e.g. 600000"],
	["requestInactivityMs", "Stream inactivity timeout (ms)", "e.g. 120000"],
];

export default function SubagentBudgetSettings({ disabled = false }) {
	const [settings, setSettings] = useState(undefined);
	const [policy, setPolicy] = useState(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [draft, setDraft] = useState({});

	const applyValue = (value) => {
		setSettings(value.settings);
		setPolicy(value.policy);
		setDraft(Object.fromEntries(FIELDS.map(([key]) => [
			key, value.settings[key] === UNBOUNDED ? "" : value.settings[key] ?? "",
		])));
	};

	useEffect(() => {
		let active = true;
		window.api
			.getSubagentBudgets()
			.then((value) => {
				if (!active) return;
				applyValue(value);
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
			applyValue(await window.api.saveSubagentBudgets(patch));
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	};

	const commitNumber = (key, raw) => {
		const text = raw.trim();
		if (text === "") {
			setDraft((current) => ({ ...current, [key]: "" }));
			commit({ [key]: null });
			return;
		}
		const value = Number(text);
		if (!Number.isSafeInteger(value)) {
			setError("Budgets must be whole numbers.");
			return;
		}
		setDraft((current) => ({ ...current, [key]: text }));
		commit({ [key]: value });
	};

	const commitUnbounded = (key, on) => {
		if (on) setDraft((current) => ({ ...current, [key]: "" }));
		commit({ [key]: on ? UNBOUNDED : null });
	};

	const bounds = (key) => policy?.limits?.[key] ?? FALLBACK_LIMITS[key];
	const custom = settings?.mode === "custom";
	const unboundedHint = policy?.inputRule ? ` Input budget rule: ${policy.inputRule}.` : "";

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
					? ` (investigation up to ${policy.maxTurns.investigation} total model requests × ${policy.perRequestCeiling.investigation} output tokens; up to ${policy.maxToolCalls.investigation} tool calls; input ${policy.inputRule})`
					: ""}
				. The parent run shares {policy ? policy.maxAggregateToolCalls : "a bounded"} calls across its children.
				The last investigation request is reserved for tool-free reporting; compaction and retries also consume requests. Custom overrides each limit independently; blank fields use Automatic, and "No limit" removes the numeric ceiling for that field.
				Unbounded still respects permissions, the model context window, cancellation, concurrency and provider limits. Changing settings affects new children. Inspect child activity for effective limits and measured, estimated, or reserved usage.
			</p>
			{custom && (
				<div className="mt-3 grid grid-cols-2 gap-3">
					{FIELDS.map(([key, label, placeholder]) => {
						const unbounded = settings?.[key] === UNBOUNDED;
						return (
							<React.Fragment key={key}>
								<NumberField
									label={label}
									value={unbounded ? "" : draft[key] ?? ""}
									min={bounds(key).min}
									max={bounds(key).max}
									placeholder={unbounded ? "No limit" : placeholder}
									disabled={disabled || saving || settings === undefined || unbounded}
									onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
									onBlur={(event) => commitNumber(key, event.target.value)}
								/>
								<CheckboxField
									label="No limit"
									checked={unbounded}
									disabled={disabled || saving || settings === undefined}
									onChange={(event) => commitUnbounded(key, event.target.checked)}
								/>
							</React.Fragment>
						);
					})}
				</div>
			)}
			{custom && (
				<p className="mt-2 text-xs text-[var(--text-muted)]">
					Input counts every token sent across all requests (history re-sent each turn
					counts again); output counts every generated token, including reasoning.
					Retries and final reporting count as requests. Missing output usage reserves the request allowance.
					Exhausted children return an explicit stop reason and available evidence; the last request is reserved for tool-free reporting.{unboundedHint}
				</p>
			)}
			{custom && (
				<p className="mt-2 text-xs text-[var(--text-muted)]">
					Time limits are in milliseconds and are independent of the token budgets. The execution
					deadline covers the whole child run (requests, tools, retries, compaction); the model-request
					timeout bounds one request end to end; the stream inactivity timeout fires only when a
					streamed response stops producing data. Blank fields use Automatic, which has no deadline and
					no request timeout, so long-horizon work is never cut off. A timed-out child stops at the next
					safe boundary, keeps any findings already gathered, and is reported as timed out — never as
					a success.
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

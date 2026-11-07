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
	["maxToolCalls", "Tool calls per sub-agent", "e.g. 400"],
	["maxTurns", "Model requests per sub-agent", "e.g. 200"],
	["maxAggregateToolCalls", "Shared tool calls (all sub-agents)", "e.g. 2000"],
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
		setDraft(
			Object.fromEntries(
				FIELDS.map(([key]) => [
					key,
					value.settings[key] === UNBOUNDED ? "" : (value.settings[key] ?? ""),
				]),
			),
		);
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

	return (
		<>
			<SelectField
				label="Execution limits"
				value={settings?.mode ?? "auto"}
				disabled={disabled || saving || settings === undefined}
				onChange={(event) => commit({ mode: event.target.value })}
			>
				<option value="auto">Automatic (recommended)</option>
				<option value="custom">Custom limits</option>
			</SelectField>
			<p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
				{custom ? 'Set your own limits. Leave a field blank for Automatic, or select “No limit”.'
					: 'Limits adjust to the task and model. Recommended for most work.'}
				<span className="mt-1 block">Changes apply to new sub-agents.</span>
			</p>
			{custom && (
				<div className="mt-3 grid grid-cols-2 gap-3">
					{FIELDS.map(([key, label, placeholder]) => {
						const unbounded = settings?.[key] === UNBOUNDED;
						return (
							<React.Fragment key={key}>
								<NumberField
									label={label}
									value={unbounded ? "" : (draft[key] ?? "")}
									min={bounds(key).min}
									max={bounds(key).max}
									placeholder={unbounded ? "No limit" : placeholder}
									disabled={disabled || saving || settings === undefined || unbounded}
									onChange={(event) =>
										setDraft((current) => ({ ...current, [key]: event.target.value }))
									}
									onBlur={(event) => commitNumber(key, event.target.value)}
								/>
								<div className="mt-3.5">
									<CheckboxField
										label="No limit"
										checked={unbounded}
										disabled={disabled || saving || settings === undefined}
										onChange={(event) => commitUnbounded(key, event.target.checked)}
									/>
								</div>
							</React.Fragment>
						);
					})}
				</div>
			)}
			<details className="mt-4 border-t border-[var(--subtle-border)] pt-3 text-xs text-[var(--text-muted)]">
				<summary className="w-fit cursor-pointer font-medium text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">How limits work</summary>
				<div className="mt-3 space-y-4 leading-relaxed">
					<section>
						<h4 className="font-medium text-[var(--text-primary)]">Automatic limits</h4>
						{policy ? <ul className="mt-1 list-disc space-y-1 pl-4">
							<li>Investigation: up to {policy.maxTurns.investigation} model requests, with {policy.perRequestCeiling.investigation} output tokens per request.</li>
							<li>Up to {policy.maxToolCalls.investigation} tool calls per sub-agent; {policy.maxAggregateToolCalls} shared across the parent run.</li>
							<li className="break-words">Input token allowance: {policy.inputRule}.</li>
						</ul> : <p className="mt-1">Automatic sets task-based limits for each sub-agent and its parent run.</p>}
					</section>
					<section>
						<h4 className="font-medium text-[var(--text-primary)]">What counts toward a limit?</h4>
						<ul className="mt-1 list-disc space-y-1 pl-4">
							<li>Limits cover the sub-agent’s entire run. Retries, compaction, and final reporting also use model requests.</li>
							<li>Input includes history sent again on later requests. Output includes reasoning; unavailable usage reserves the request allowance.</li>
							<li>The last investigation request is reserved for reporting without tools. A stopped sub-agent returns its reason and available findings.</li>
						</ul>
					</section>
					<section>
						<h4 className="font-medium text-[var(--text-primary)]">Custom and time limits</h4>
						<ul className="mt-1 list-disc space-y-1 pl-4">
							<li>Each field is independent: blank uses Automatic; “No limit” removes only that field’s numeric ceiling.</li>
							<li>Times are in milliseconds (1,000 ms = 1 second). The execution deadline covers the whole run; request timeout covers one request; inactivity timeout detects a stalled stream.</li>
							<li>Automatic has no execution deadline or request timeout. Timed-out sub-agents stop at a safe boundary and keep their findings.</li>
							<li>Permissions, context windows, cancellation, concurrency, and provider limits always apply.</li>
						</ul>
					</section>
					<p>See sub-agent activity for effective limits and measured, estimated, or reserved usage.</p>
				</div>
			</details>
			{error && (
				<p
					role="alert"
					className="mt-2 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
		</>
	);
}

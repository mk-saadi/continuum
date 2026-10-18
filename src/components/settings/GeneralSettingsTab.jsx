import React, { useEffect, useState } from "react";
import { SliderField } from "../FormControls";
import SubagentModelSelect from "../SubagentModelSelect";
import SubagentBudgetSettings from "../SubagentBudgetSettings";

const limits = [
	{
		key: "maxConsecutiveToolFailures",
		label: "Max Consecutive Tool Failures",
		min: 3,
		max: 10,
		fallback: 5,
	},
	{ key: "maxTotalToolFailures", label: "Max Total Tool Failures", min: 5, max: 25, fallback: 10 },
];

const SEARCH_PROVIDER_OPTIONS = [{ value: "brave", label: "Brave Search" }];
const searchInputClass = "mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--input)] p-2";

// Web Search provider settings. The renderer only ever sees the provider and
// whether a key is configured; the stored key never crosses IPC. Leaving the
// key field blank while saving keeps the existing key, so the provider can be
// re-saved without re-typing a secret the UI never displays.
function WebSearchSettings() {
	const [state, setState] = useState(null);
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			.getSearchSettings()
			.then((value) => {
				if (active) setState(value);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	async function save() {
		if (!state || saving) return;
		setSaving(true);
		setError("");
		setNotice("");
		try {
			const payload = { provider: state.provider };
			if (apiKey.trim()) payload.apiKey = apiKey.trim();
			const next = await window.api.saveSearchSettings(payload);
			setState(next);
			setApiKey("");
			setNotice("Saved.");
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	async function removeKey() {
		if (!state || saving) return;
		setSaving(true);
		setError("");
		setNotice("");
		try {
			setState(await window.api.saveSearchSettings({ provider: state.provider, apiKey: "" }));
			setApiKey("");
			setNotice("API key removed.");
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<section
			className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
			aria-labelledby="web-search-title"
		>
			<h4
				id="web-search-title"
				className="font-semibold"
			>
				Web Search
			</h4>
			<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
				Lets agents run the native <code>web_search</code> tool to discover result URLs. Search only
				returns titles, URLs and snippets — reading a page stays a separate fetch step. Only the search
				query is sent to the provider; nothing from this chat, your workspace or memory leaves the
				device. Agents and children that are not granted the tool never see it.
			</p>
			<div className="mt-4 flex flex-wrap items-end gap-3">
				<label className="text-xs font-semibold text-[var(--text-primary)]">
					Provider
					<select
						className={searchInputClass}
						value={state?.provider ?? "brave"}
						disabled={!state || saving}
						onChange={(event) => setState((previous) => ({ ...previous, provider: event.target.value }))}
					>
						{SEARCH_PROVIDER_OPTIONS.map((option) => (
							<option
								key={option.value}
								value={option.value}
							>
								{option.label}
							</option>
						))}
					</select>
				</label>
				<label className="min-w-[16rem] flex-1 text-xs font-semibold text-[var(--text-primary)]">
					API key
					<input
						type="password"
						className={searchInputClass}
						value={apiKey}
						autoComplete="off"
						disabled={!state || saving}
						placeholder={state?.configured ? "Configured — leave blank to keep" : "Paste provider API key"}
						onChange={(event) => setApiKey(event.target.value)}
					/>
				</label>
				<button
					type="button"
					className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-hover)] disabled:opacity-50"
					disabled={!state || saving}
					onClick={save}
				>
					Save
				</button>
				{state?.configured && (
					<button
						type="button"
						className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-hover)] disabled:opacity-50"
						disabled={saving}
						onClick={removeKey}
					>
						Remove key
					</button>
				)}
			</div>
			<p className="mt-3 text-xs text-[var(--text-muted)]">
				{state?.configured
					? `Configured provider: ${state.providerLabel}.`
					: "Not configured — the web_search tool will report that it is unconfigured until a key is saved."}
			</p>
			{notice && <p className="mt-2 text-xs text-[var(--accent)]">{notice}</p>}
			{error && <p className="mt-2 text-xs text-[var(--error)]">{error}</p>}
		</section>
	);
}

export default function GeneralSettingsTab() {
	const [settings, setSettings] = useState(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		window.api
			.getAppSettings()
			.then((value) => {
				if (active) setSettings(value);
			})
			.catch((cause) => {
				if (active) setError(cause.message);
			});
		return () => {
			active = false;
		};
	}, []);

	async function update(key, value) {
		if (!settings || saving) return;
		setSaving(true);
		setError("");
		try {
			setSettings(await window.api.saveAppSettings({ [key]: value }));
			// App settings (memory, MCP) reshape the prepared prompt;
			// listeners refresh their context measurements.
			window.dispatchEvent(new Event("generation-settings-changed"));
		} catch (cause) {
			setError(cause.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<section
				className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
				aria-labelledby="subagent-model-title"
			>
				<h4
					id="subagent-model-title"
					className="font-semibold"
				>
					Sub-Agent Model
				</h4>
				<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
					Model used by spawned sub-agents. "Follow the chat model" (default) runs children on
					whatever the current chat uses; choosing something else gives sub-agents their own model
					without changing this chat. Whichever model is chosen, sub-agents stay read-only.
				</p>
				<div className="mt-4">
					<SubagentModelSelect disabled={saving} />
				</div>
				<div className="mt-4">
					<SubagentBudgetSettings disabled={saving} />
				</div>
			</section>
			<WebSearchSettings />
			<section
				className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
				aria-labelledby="execution-guardrails-title"
			>
				<h4
					id="execution-guardrails-title"
					className="font-semibold"
				>
					Execution Guardrails
				</h4>
				<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
					Stop an agent run when tool failures reach either limit.
				</p>
				<div className="mt-4 space-y-4">
					{limits.map(({ key, label, min, max, fallback }) => (
                        <SliderField
                            key={key}
                            label={label}
                            valueLabel={settings?.[key] ?? fallback}
                            min={min}
                            max={max}
                            step={1}
                            value={settings?.[key] ?? fallback}
                            disabled={!settings || saving}
                            onChange={event => {
                                const value = Number(event.target.value);
                                setSettings(previous => ({ ...previous, [key]: value }));
                            }}
                            onCommit={event => update(key, Number(event.target.value))}
                        />
					))}
				</div>
			</section>
			{error && (
				<p
					role="alert"
					className="mb-5 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}
		</>
	);
}

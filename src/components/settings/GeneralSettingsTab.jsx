import React, { useEffect, useState } from 'react';

const limits = [
  { key: 'maxConsecutiveToolFailures', label: 'Max Consecutive Tool Failures', min: 3, max: 10, fallback: 5 },
  { key: 'maxTotalToolFailures', label: 'Max Total Tool Failures', min: 5, max: 25, fallback: 10 },
];

export default function GeneralSettingsTab() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // null/undefined while loading: null = "follow the chat model".
  const [subagentModel, setSubagentModel] = useState(undefined);
  const [cloudModels, setCloudModels] = useState([]);

  useEffect(() => {
    let active = true;
    window.api.getAppSettings()
      .then(value => { if (active) setSettings(value); })
      .catch(cause => { if (active) setError(cause.message); });
    window.api.getSubagentModel()
      .then(value => { if (active) setSubagentModel(value); })
      .catch(cause => { if (active) setError(cause.message); });
    window.api.getCloudProviders()
      .then(rows => {
        if (!active) return;
        setCloudModels(rows.filter(row => (row.category ?? 'text') === 'text' && row.configured && row.modelId?.trim()));
      })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, []);

  async function update(key, value) {
    if (!settings || saving) return;
    setSaving(true);
    setError('');
    try {
      setSettings(await window.api.saveAppSettings({ [key]: value }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  // Same encoding the rest of the app uses for a model choice: '' = follow the
  // chat, 'local' = the local model server, otherwise the saved provider id.
  const encodedSubagentModel = subagentModel == null ? ''
    : subagentModel.type === 'local' ? 'local'
    : `cloud:${subagentModel.provider}`;
  const storedCloudMissing = subagentModel?.type === 'cloud' &&
    !cloudModels.some(row => row.id === subagentModel.provider);

  async function updateSubagentModel(encoded) {
    if (saving || subagentModel === undefined) return;
    setSaving(true);
    setError('');
    try {
      const selection = encoded === '' ? null
        : encoded === 'local' ? { type: 'local' }
        : { type: 'cloud', provider: encoded, model: cloudModels.find(row => row.id === encoded)?.modelId };
      setSubagentModel(await window.api.saveSubagentModel(selection));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  return <>
    <section className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="subagent-model-title">
      <h4 id="subagent-model-title" className="font-semibold">Sub-Agent Model</h4>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
        Model used by spawned sub-agents. "Follow the chat model" (default) runs children on whatever
        the current chat uses; choosing something else gives sub-agents their own model without
        changing this chat. Whichever model is chosen, sub-agents stay read-only.
      </p>
      <label className="mt-4 block text-sm">
        <span className="flex items-center justify-between gap-3">Sub-agent model</span>
        <select
          value={encodedSubagentModel}
          disabled={saving || subagentModel === undefined}
          onChange={event => updateSubagentModel(event.target.value)}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm"
        >
          <option value="">Follow the chat model</option>
          <option value="local">Local model server (the loaded model)</option>
          {cloudModels.map(row => (
            <option key={row.id} value={row.id}>{row.name} — {row.modelId}</option>
          ))}
          {storedCloudMissing && (
            <option value={`cloud:${subagentModel.provider}`}>
              {subagentModel.provider} — {subagentModel.model} (unavailable)
            </option>
          )}
        </select>
      </label>
      {!cloudModels.length && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          No cloud providers configured. Add one in Settings → Cloud Providers to run sub-agents on a cloud model.
        </p>
      )}
    </section>
    <section className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="execution-guardrails-title">
      <h4 id="execution-guardrails-title" className="font-semibold">Execution Guardrails</h4>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">Stop an agent run when tool failures reach either limit.</p>
      <div className="mt-4 space-y-4">
        {limits.map(({ key, label, min, max, fallback }) => <label key={key} className="block text-sm">
          <span className="flex items-center justify-between gap-3"><span>{label}</span><output>{settings?.[key] ?? fallback}</output></span>
          <input type="range" min={min} max={max} step="1" value={settings?.[key] ?? fallback}
            disabled={!settings || saving} onChange={event => update(key, Number(event.target.value))}
            className="mt-2 w-full accent-[var(--accent)]" />
        </label>)}
      </div>
    </section>
    {error && <p role="alert" className="mb-5 text-xs text-[var(--error)]">{error}</p>}
  </>;
}

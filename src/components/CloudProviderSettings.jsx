import React, { useEffect, useRef, useState } from 'react';

export default function CloudProviderSettings() {
  const [configuredProviders, setConfiguredProviders] = useState([]);
  const [modelLists, setModelLists] = useState({});
  const modelRequests = useRef({});
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    window.api.getCloudProviders().then(rows => { if (active) setConfiguredProviders(rows); })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; modelRequests.current = {}; };
  }, []);
  function clearModels(id) {
    delete modelRequests.current[id];
    setModelLists(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }
  async function fetchModels(row) {
    const request = Symbol();
    modelRequests.current[row.id] = request;
    setModelLists(previous => ({ ...previous, [row.id]: { loading: true, models: [], error: '' } }));
    try {
      const result = await window.api.fetchCloudModels({ id: row.id, baseUrl: row.baseUrl, apiKey: row.apiKey });
      if (result.error) throw new Error(result.error);
      if (modelRequests.current[row.id] !== request) return;
      setModelLists(previous => ({ ...previous, [row.id]: { loading: false, models: result.models, error: '' } }));
    } catch (err) {
      if (modelRequests.current[row.id] !== request) return;
      setModelLists(previous => ({ ...previous, [row.id]: {
        loading: false, models: [], error: err.message?.startsWith('Failed to fetch models') ? err.message : 'Failed to fetch models. Check the base URL and API key, or enter a model ID manually.',
      } }));
    }
  }
  function update(id, field, value) {
    if (['baseUrl', 'apiKey', 'apiType'].includes(field)) clearModels(id);
    setConfiguredProviders(previous => previous.map(row => row.id === id ? { ...row, [field]: value } : row));
  }
  async function persist(row, remove = false) {
    setBusy(true); setMessage(''); setError('');
    try {
      const saved = remove ? await window.api.deleteCloudProvider(row.id) : await window.api.saveCloudProvider(row);
      setConfiguredProviders(previous => remove ? previous.filter(item => item.id !== row.id)
        : previous.map(item => item.id === row.id ? saved.find(value => value.id === row.id) : item));
      if (remove) clearModels(row.id);
      setMessage(`${row.name || 'Provider'} ${remove ? 'deleted' : 'saved'}.`);
      window.dispatchEvent(new Event('cloud-providers-changed'));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const inputClass = 'mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--input)] p-2';
  return <div className="space-y-4">
    <p className="text-sm text-[var(--text-secondary)]">Add an OpenAI-compatible provider or explicitly select the Anthropic API. Messages and enabled tool results are sent to the selected provider.</p>
    <p className="text-xs text-[var(--text-muted)]">Keys are stored locally, without encryption, in this app’s settings database. Leave a saved key blank to keep it.</p>
    <button type="button" disabled={busy} onClick={() => setConfiguredProviders(previous => [...previous, {
      id: crypto.randomUUID(), name: '', baseUrl: 'https://api.openai.com/v1', apiKey: '', modelId: '', apiType: 'openai',
    }])} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">+ Add Custom Provider</button>
    {configuredProviders.map(row => <form key={row.id} onSubmit={event => { event.preventDefault(); persist(row); }} className="space-y-3 rounded-xl border border-[var(--border)] p-4">
      <h3 className="font-semibold">{row.name || 'Custom Provider'} <span className="text-xs font-normal text-[var(--text-secondary)]">{row.configured ? 'Key saved' : 'Not configured'}</span></h3>
      <label className="block text-sm">Name
        <input required value={row.name} disabled={busy} placeholder="Kimi, Groq, My Local Server" onChange={event => update(row.id, 'name', event.target.value)} className={inputClass} />
      </label>
      <label className="block text-sm">API type
        <select value={row.apiType || 'openai'} disabled={busy} onChange={event => update(row.id, 'apiType', event.target.value)} className={inputClass}>
          <option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic API</option>
        </select>
      </label>
      <label className="block text-sm">Base URL
        <input required type="url" value={row.baseUrl} disabled={busy} onChange={event => update(row.id, 'baseUrl', event.target.value)} className={inputClass} />
      </label>
      <label className="block text-sm">API key
        <input required={!row.configured} type="password" autoComplete="off" spellCheck={false} value={row.apiKey || ''} disabled={busy}
          placeholder={row.configured ? 'Leave blank to keep saved key' : 'Enter API key'} onChange={event => update(row.id, 'apiKey', event.target.value)} className={inputClass} />
      </label>
      <div>
        <label htmlFor={`model-${row.id}`} className="block text-sm">Model ID</label>
        <div className="flex items-center gap-2">
          <input id={`model-${row.id}`} required list={`models-${row.id}`} value={row.modelId} disabled={busy}
            placeholder="Type a model ID or fetch suggestions" aria-describedby={`model-help-${row.id}`}
            onChange={event => update(row.id, 'modelId', event.target.value)} className={`${inputClass} min-w-0 flex-1`} />
          <button type="button" disabled={busy || modelLists[row.id]?.loading || !row.baseUrl.trim() || (!row.apiKey?.trim() && !row.configured)}
            onClick={() => fetchModels(row)} className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-50">
            {modelLists[row.id]?.loading ? 'Fetching…' : 'Fetch Models'}
          </button>
        </div>
        <datalist id={`models-${row.id}`}>
          {(modelLists[row.id]?.models || []).map(modelId => <option key={modelId} value={modelId} />)}
        </datalist>
        <p id={`model-help-${row.id}`} className="mt-1 text-xs text-[var(--text-muted)]">Choose a suggestion or type any model ID.</p>
        {modelLists[row.id]?.error && <p role="alert" className="mt-1 text-xs text-[var(--error)]">{modelLists[row.id].error}</p>}
        {modelLists[row.id] && !modelLists[row.id].loading && !modelLists[row.id].error && <p role="status" className="mt-1 text-xs text-[var(--text-secondary)]">
          {modelLists[row.id].models.length ? `${modelLists[row.id].models.length} models fetched.` : 'No models returned. Enter a model ID manually.'}
        </p>}
      </div>
      <div className="flex gap-3">
        <button disabled={busy} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-[var(--on-accent)] disabled:opacity-50">Save</button>
        <button type="button" disabled={busy} onClick={() => persist(row, true)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">Delete</button>
      </div>
    </form>)}
    {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}

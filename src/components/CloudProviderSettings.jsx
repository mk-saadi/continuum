import React, { useEffect, useMemo, useRef, useState } from 'react';

const inputClass = 'mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--input)] p-2';
const EMPTY_DEFAULTS = { defaultImageProviderId: '', defaultVideoProviderId: '' };

export default function CloudProviderSettings() {
  const [providers, setProviders] = useState([]);
  const [defaults, setDefaults] = useState(EMPTY_DEFAULTS);
  const [tab, setTab] = useState('text');
  const [modelLists, setModelLists] = useState({});
  const modelRequests = useRef({});
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([window.api.getCloudProviders(), window.api.getCloudProviderDefaults()])
      .then(([rows, savedDefaults]) => {
        if (!active) return;
        setProviders(rows);
        setDefaults(savedDefaults);
      })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; modelRequests.current = {}; };
  }, []);

  const visibleProviders = useMemo(() => providers.filter(row => tab === 'media'
    ? row.category === 'media' : row.category !== 'media'), [providers, tab]);
  const mediaOfType = type => providers.filter(row => row.category === 'media' && row.mediaType === type && row.configured);

  function clearModels(id) {
    delete modelRequests.current[id];
    setModelLists(previous => { const next = { ...previous }; delete next[id]; return next; });
  }
  function update(id, field, value) {
    if (['baseUrl', 'apiKey', 'apiType'].includes(field)) clearModels(id);
    setProviders(previous => previous.map(row => row.id === id ? { ...row, [field]: value } : row));
  }
  async function fetchModels(row) {
    const request = Symbol();
    modelRequests.current[row.id] = request;
    setModelLists(previous => ({ ...previous, [row.id]: { loading: true, models: [], error: '' } }));
    try {
      const result = await window.api.fetchCloudModels({ id: row.id, baseUrl: row.baseUrl, apiKey: row.apiKey, apiType: row.apiType });
      if (result.error) throw new Error(result.error);
      if (modelRequests.current[row.id] !== request) return;
      setModelLists(previous => ({ ...previous, [row.id]: { loading: false, models: result.models || [], error: '' } }));
    } catch (err) {
      if (modelRequests.current[row.id] !== request) return;
      setModelLists(previous => ({ ...previous, [row.id]: { loading: false, models: [], error: err.message || 'Connection test failed.' } }));
    }
  }
  async function persist(row, remove = false) {
    setBusy(true); setMessage(''); setError('');
    try {
      const saved = remove
        ? await window.api.deleteCloudProvider({ id: row.id, category: row.category })
        : await window.api.saveCloudProvider(row);
      setProviders(saved);
      setDefaults(await window.api.getCloudProviderDefaults());
      if (remove) clearModels(row.id);
      setMessage(`${row.name || 'Provider'} ${remove ? 'deleted' : 'saved'}.`);
      window.dispatchEvent(new Event('cloud-providers-changed'));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function updateDefaults(field, value) {
    const next = { ...defaults, [field]: value };
    setDefaults(next);
    setError(''); setMessage('');
    try {
      await window.api.saveCloudProviderDefaults({ [field]: value });
      setDefaults(next);
      setMessage('Default media model saved.');
    } catch (err) { setError(err.message); }
  }
  function addProvider(category, mediaType) {
    setProviders(previous => [...previous, {
      id: crypto.randomUUID(), category, ...(category === 'media' ? { mediaType } : {}),
      name: '', baseUrl: category === 'text' ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1',
      apiKey: '', modelId: '', apiType: category === 'text' ? 'openai' : 'openrouter', configured: false,
    }]);
  }

  return <div className="space-y-4">
    <div role="tablist" aria-label="Cloud provider categories" className="flex w-fit gap-1 rounded-lg border border-[var(--border)] p-1">
      {[['text', 'Text Models (LLMs)'], ['media', 'Media Models (Image & Video)']].map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setMessage(''); setError(''); }}
          className={`rounded-md px-3 py-2 text-sm ${tab === id ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'text-[var(--text-secondary)]'}`}>{label}</button>)}
    </div>

    {tab === 'text' ? <>
      <p className="text-sm text-[var(--text-secondary)]">Configure conversational cloud providers. Only Text Models appear in the chat model selector.</p>
      <p className="text-xs text-[var(--text-muted)]">API keys are stored locally in this app’s settings database. Leave a saved key blank to keep it.</p>
      <button type="button" disabled={busy} onClick={() => addProvider('text')} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">+ Add Text Provider</button>
    </> : <>
      <p className="text-sm text-[var(--text-secondary)]">Configure image and video generation APIs. Media providers never appear as conversational chat models.</p>
      <div className="grid gap-3 rounded-xl border border-[var(--border)] p-4 sm:grid-cols-2">
        <label className="block text-sm">Default Image Model for Tools
          <select value={defaults.defaultImageProviderId} disabled={busy} onChange={event => updateDefaults('defaultImageProviderId', event.target.value)} className={inputClass}>
            <option value="">No default selected</option>{mediaOfType('image').map(row => <option key={row.id} value={row.id}>{row.name} — {row.modelId}</option>)}
          </select>
        </label>
        <label className="block text-sm">Default Video Model for Tools
          <select value={defaults.defaultVideoProviderId} disabled={busy} onChange={event => updateDefaults('defaultVideoProviderId', event.target.value)} className={inputClass}>
            <option value="">No default selected</option>{mediaOfType('video').map(row => <option key={row.id} value={row.id}>{row.name} — {row.modelId}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-[var(--text-muted)]">Generation may incur provider charges. API keys are stored locally in this app’s settings database.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => addProvider('media', 'image')} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">+ Add Image Provider</button>
        <button type="button" disabled={busy} onClick={() => addProvider('media', 'video')} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">+ Add Video Provider</button>
      </div>
    </>}

    {visibleProviders.map(row => <form key={row.id} onSubmit={event => { event.preventDefault(); persist(row); }} className="space-y-3 rounded-xl border border-[var(--border)] p-4">
      <h3 className="font-semibold">{row.name || (row.category === 'media' ? 'Media Provider' : 'Text Provider')} <span className="text-xs font-normal text-[var(--text-secondary)]">{row.configured ? 'Key saved' : 'Not configured'}</span></h3>
      <label className="block text-sm">Name<input required value={row.name} disabled={busy} placeholder="OpenRouter, Stability, My API" onChange={event => update(row.id, 'name', event.target.value)} className={inputClass} /></label>
      {row.category === 'media' && <label className="block text-sm">Media Type
        <select value={row.mediaType || 'image'} disabled={busy} onChange={event => update(row.id, 'mediaType', event.target.value)} className={inputClass}>
          <option value="image">Image</option><option value="video">Video</option>
        </select>
      </label>}
      <label className="block text-sm">API Type
        <select value={row.apiType || 'openai'} disabled={busy} onChange={event => update(row.id, 'apiType', event.target.value)} className={inputClass}>
          {row.category === 'text' ? <><option value="openai">OpenAI-compatible Chat</option><option value="anthropic">Anthropic Messages</option></> : <>
            <option value="openrouter">OpenRouter Images</option><option value="openai-images">OpenAI-compatible Images</option><option value="stable-diffusion">Stable Diffusion Web API</option>
          </>}
        </select>
      </label>
      <label className="block text-sm">Base URL<input required type="url" value={row.baseUrl} disabled={busy} onChange={event => update(row.id, 'baseUrl', event.target.value)} className={inputClass} /></label>
      <label className="block text-sm">API Key<input required={!row.configured && !(row.category === 'media' && row.apiType === 'stable-diffusion')} type="password" autoComplete="off" spellCheck={false} value={row.apiKey || ''} disabled={busy}
        placeholder={row.configured ? 'Leave blank to keep saved key' : 'Enter API key'} onChange={event => update(row.id, 'apiKey', event.target.value)} className={inputClass} /></label>
      <div>
        <label htmlFor={`model-${row.id}`} className="block text-sm">Model ID</label>
        <div className="flex items-center gap-2">
          <input id={`model-${row.id}`} required list={`models-${row.id}`} value={row.modelId} disabled={busy} placeholder="Type a model ID or test the connection"
            onChange={event => update(row.id, 'modelId', event.target.value)} className={`${inputClass} min-w-0 flex-1`} />
          <button type="button" disabled={busy || modelLists[row.id]?.loading || !row.baseUrl.trim() || (!row.apiKey?.trim() && !row.configured && row.apiType !== 'stable-diffusion')} onClick={() => fetchModels(row)}
            className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-50">{modelLists[row.id]?.loading ? 'Testing…' : row.category === 'text' ? 'Fetch Models' : 'Test / Fetch Models'}</button>
        </div>
        <datalist id={`models-${row.id}`}>{(modelLists[row.id]?.models || []).map(modelId => <option key={modelId} value={modelId} />)}</datalist>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Choose a suggestion or type the provider’s model ID.</p>
        {modelLists[row.id]?.error && <p role="alert" className="mt-1 text-xs text-[var(--error)]">{modelLists[row.id].error}</p>}
        {modelLists[row.id] && !modelLists[row.id].loading && !modelLists[row.id].error && <p role="status" className="mt-1 text-xs text-[var(--text-secondary)]">
          {modelLists[row.id].models.length ? `${modelLists[row.id].models.length} models fetched.` : 'Connection succeeded. Enter a model ID manually.'}
        </p>}
      </div>
      <div className="flex gap-3">
        <button disabled={busy} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-[var(--on-accent)] disabled:opacity-50">Save</button>
        <button type="button" disabled={busy} onClick={() => persist(row, true)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">Delete</button>
      </div>
    </form>)}
    {!visibleProviders.length && <p className="rounded-xl border border-dashed border-[var(--border)] p-5 text-sm text-[var(--text-secondary)]">No {tab === 'text' ? 'text' : 'media'} providers configured.</p>}
    {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuCloud } from 'react-icons/lu';
import { NumberField, SelectField, TextField } from './FormControls';
import {
  SettingsButton,
  SettingsCard,
  SettingsEmpty,
  SettingsHint,
  SettingsMessage,
} from './settings/SettingsSection';

const EMPTY_DEFAULTS = { defaultImageProviderId: '', defaultVideoProviderId: '' };
function isLocalBaseUrlValue(value) {
  const host = (() => { try { return new URL(String(value || '').trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { return ''; } })();
  if (!host) return false;
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}
function needsApiKey(row) {
  if (row.category === 'media' && row.apiType === 'stable-diffusion') return false;
  if (row.category === 'text' && isLocalBaseUrlValue(row.baseUrl)) return false;
  return true;
}

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
      ...(category === 'text' ? { pricing: { input: '', output: '', cacheRead: '', cacheWrite: '' } } : {}),
    }]);
  }
  // Optional per-provider cost rates (USD per million tokens). Blank fields are
  // simply absent evidence; entering both input and output enables an estimate
  // for models the catalog does not know. Nothing here spends or fetches.
  function updatePricing(id, field, value) {
    setProviders(previous => previous.map(row => row.id === id
      ? { ...row, pricing: { ...(row.pricing ?? {}), [field]: value } } : row));
  }

  const categoryCopy = tab === 'text'
    ? 'Configure conversational cloud providers. Only text models appear in the chat model selector.'
    : 'Configure image and video generation APIs. Media providers never appear as conversational chat models.';

  return <div className="space-y-3">
    <SettingsCard icon={LuCloud} title="Cloud providers" description={categoryCopy}>
      <div role="tablist" aria-label="Cloud provider categories" className="flex w-fit gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1">
        {[['text', 'Text Models (LLMs)'], ['media', 'Media Models (Image & Video)']].map(([id, label]) =>
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setMessage(''); setError(''); }}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${tab === id ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'}`}>{label}</button>)}
      </div>

      {tab === 'text' ? <>
        <SettingsHint>API keys are stored locally in this app’s settings database. Leave a saved key blank to keep it.</SettingsHint>
        <div className="mt-3">
          <SettingsButton disabled={busy} onClick={() => addProvider('text')}>+ Add Text Provider</SettingsButton>
        </div>
      </> : <>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SelectField label="Default Image Model for Tools" value={defaults.defaultImageProviderId} disabled={busy}
            onChange={event => updateDefaults('defaultImageProviderId', event.target.value)}>
            <option value="">No default selected</option>{mediaOfType('image').map(row => <option key={row.id} value={row.id}>{row.name} — {row.modelId}</option>)}
          </SelectField>
          <SelectField label="Default Video Model for Tools" value={defaults.defaultVideoProviderId} disabled={busy}
            onChange={event => updateDefaults('defaultVideoProviderId', event.target.value)}>
            <option value="">No default selected</option>{mediaOfType('video').map(row => <option key={row.id} value={row.id}>{row.name} — {row.modelId}</option>)}
          </SelectField>
        </div>
        <SettingsHint>Generation may incur provider charges. API keys are stored locally in this app’s settings database.</SettingsHint>
        <div className="mt-3 flex flex-wrap gap-2">
          <SettingsButton disabled={busy} onClick={() => addProvider('media', 'image')}>+ Add Image Provider</SettingsButton>
          <SettingsButton disabled={busy} onClick={() => addProvider('media', 'video')}>+ Add Video Provider</SettingsButton>
        </div>
      </>}
    </SettingsCard>

    {visibleProviders.map(row => <SettingsCard
      as="form"
      key={row.id}
      onSubmit={event => { event.preventDefault(); persist(row); }}
      className="space-y-3"
      title={row.name || (row.category === 'media' ? 'Media Provider' : 'Text Provider')}
      action={
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${row.configured ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
          {row.configured ? (needsApiKey(row) ? 'Key saved' : 'Ready') : 'Not configured'}
        </span>
      }
    >
      <TextField label="Name" required value={row.name} disabled={busy} placeholder="OpenRouter, Stability, My API" onChange={event => update(row.id, 'name', event.target.value)} />
      {row.category === 'media' && <SelectField label="Media Type" value={row.mediaType || 'image'} disabled={busy} onChange={event => update(row.id, 'mediaType', event.target.value)}>
        <option value="image">Image</option><option value="video">Video</option>
      </SelectField>}
      <SelectField label="API Type" value={row.apiType || 'openai'} disabled={busy} onChange={event => update(row.id, 'apiType', event.target.value)}>
        {row.category === 'text' ? <><option value="openai">OpenAI-compatible Chat</option><option value="anthropic">Anthropic Messages</option></> : <>
          <option value="openrouter">OpenRouter Images</option><option value="openai-images">OpenAI-compatible Images</option><option value="stable-diffusion">Stable Diffusion Web API</option>
        </>}
      </SelectField>
      <TextField label="Base URL" required type="url" value={row.baseUrl} disabled={busy} onChange={event => update(row.id, 'baseUrl', event.target.value)} />
      <TextField
        label={<>API Key{!needsApiKey(row) && <span className="font-normal text-[var(--text-muted)]"> (optional for local servers)</span>}</>}
        required={!row.configured && needsApiKey(row)}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={row.apiKey || ''}
        disabled={busy}
        placeholder={row.configured ? 'Leave blank to keep saved key' : needsApiKey(row) ? 'Enter API key' : 'Empty — not needed for LM Studio / Ollama'}
        onChange={event => update(row.id, 'apiKey', event.target.value)}
      />
      {row.category === 'media' ? (
        <div>
          <div className="flex items-end gap-2">
            <TextField id={`model-${row.id}`} className="min-w-0 flex-1" label="Model ID" required list={`models-${row.id}`} value={row.modelId} disabled={busy} placeholder="Type a model ID or test the connection"
              onChange={event => update(row.id, 'modelId', event.target.value)} />
            <SettingsButton disabled={busy || modelLists[row.id]?.loading || !row.baseUrl.trim() || (!row.apiKey?.trim() && !row.configured && needsApiKey(row))} onClick={() => fetchModels(row)}>
              {modelLists[row.id]?.loading ? 'Testing…' : 'Test / Fetch Models'}
            </SettingsButton>
          </div>
          <datalist id={`models-${row.id}`}>{(modelLists[row.id]?.models || []).map(modelId => <option key={modelId} value={modelId} />)}</datalist>
          <SettingsHint>Choose a suggestion or type the provider’s model ID.</SettingsHint>
          <SettingsMessage>{modelLists[row.id]?.error}</SettingsMessage>
          {modelLists[row.id] && !modelLists[row.id].loading && !modelLists[row.id].error && <p role="status" className="mt-1 text-[11px] text-[var(--text-secondary)]">
            {modelLists[row.id].models.length ? `${modelLists[row.id].models.length} models fetched.` : 'Connection succeeded. Enter a model ID manually.'}
          </p>}
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <SettingsButton disabled={busy || modelLists[row.id]?.loading || !row.baseUrl.trim() || (!row.apiKey?.trim() && !row.configured && needsApiKey(row))} onClick={() => fetchModels(row)}>
              {modelLists[row.id]?.loading ? 'Testing…' : 'Test connection'}
            </SettingsButton>
            {modelLists[row.id] && !modelLists[row.id].loading && !modelLists[row.id].error && <p role="status" className="text-[11px] text-[var(--text-secondary)]">
              {modelLists[row.id].models.length ? `${modelLists[row.id].models.length} models available.` : 'Connection succeeded. No model list was returned.'}
            </p>}
          </div>
          <SettingsHint>Models are chosen per chat in the model selector, so one provider and key can serve any of its models.</SettingsHint>
          <SettingsMessage>{modelLists[row.id]?.error}</SettingsMessage>
        </div>
      )}
      {row.category === 'text' && <fieldset className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
        <legend className="px-1 text-[11px] text-[var(--text-muted)]">Cost rates (optional, USD per million tokens)</legend>
        <div className="grid gap-2 sm:grid-cols-4">
          <NumberField label="Input" min="0" step="any" value={row.pricing?.input ?? ''} disabled={busy} placeholder="e.g. 2" onChange={event => updatePricing(row.id, 'input', event.target.value)} />
          <NumberField label="Output" min="0" step="any" value={row.pricing?.output ?? ''} disabled={busy} placeholder="e.g. 10" onChange={event => updatePricing(row.id, 'output', event.target.value)} />
          <NumberField label="Cache read" min="0" step="any" value={row.pricing?.cacheRead ?? ''} disabled={busy} placeholder="optional" onChange={event => updatePricing(row.id, 'cacheRead', event.target.value)} />
          <NumberField label="Cache write" min="0" step="any" value={row.pricing?.cacheWrite ?? ''} disabled={busy} placeholder="optional" onChange={event => updatePricing(row.id, 'cacheWrite', event.target.value)} />
        </div>
        <SettingsHint>Used for cost estimates only. Enter both input and output to enable them; leave blank to rely on known provider pricing or a provider-reported charge.</SettingsHint>
      </fieldset>}
      <div className="flex items-center gap-2 border-t border-[var(--border)] pt-3">
        <SettingsButton type="submit" variant="primary" disabled={busy}>Save</SettingsButton>
        <SettingsButton disabled={busy} onClick={() => persist(row, true)}>Delete</SettingsButton>
      </div>
    </SettingsCard>)}
    {!visibleProviders.length && <SettingsEmpty>No {tab === 'text' ? 'text' : 'media'} providers configured.</SettingsEmpty>}
    <SettingsMessage>{error}</SettingsMessage>
    <SettingsMessage tone="success">{message}</SettingsMessage>
  </div>;
}

import React, { useState } from 'react';
import { optimizeImage } from '../utils/imageUtils.mjs';

export default function AvatarSettings({ avatars, models }) {
  const { settings, update } = avatars;
  const [selectedId, setSelectedId] = useState('');
  const modelId = models.some(model => model.id === selectedId) ? selectedId : models[0]?.id || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const buttonClass = 'rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40';
  function change(patch) {
    try { update(patch); setError(''); }
    catch { setError('Could not save avatar preferences. Local storage may be full or unavailable.'); }
  }
  async function upload(event, targetModelId = null) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    if (!(targetModelId ? /\.png$/i : /\.(png|jpe?g)$/i).test(file.name)) {
      setError(targetModelId ? 'Choose a PNG image.' : 'Choose a PNG or JPEG image.'); return;
    }
    if (file.size > 20 * 1024 * 1024) { setError('Choose an image smaller than 20 MB.'); return; }
    setBusy(true); setError('');
    try {
      const url = await optimizeImage(file, 128, 128);
      change(targetModelId
        ? previous => ({ modelAvatars: { ...previous.modelAvatars, [targetModelId]: url } })
        : { globalAvatarUrl: url });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const modelUrl = Object.hasOwn(settings.modelAvatars, modelId) ? settings.modelAvatars[modelId] : null;
  return <div className="space-y-4">
    <h3 className="font-semibold">Avatars &amp; Branding</h3>
    <label className="flex items-center gap-2">
      <input type="checkbox" role="switch" checked={settings.showAvatars}
        onChange={event => change({ showAvatars: event.target.checked })} /> Enable Avatars
    </label>
    <div className="space-y-2">
      <label className="block">Global LLM Avatar
        <input type="file" accept=".png,.jpg,.jpeg" disabled={busy} onChange={event => upload(event)}
          className="mt-2 block w-full file:mr-2 file:rounded file:border file:border-[var(--border)] file:bg-transparent file:p-2 file:text-inherit" />
      </label>
      {settings.globalAvatarUrl && <div className="flex items-center gap-2">
        <img src={settings.globalAvatarUrl} alt="Global avatar preview" className="size-12 rounded-lg object-cover" />
        <button type="button" className={buttonClass} disabled={busy} onClick={() => change({ globalAvatarUrl: null })}>Remove global avatar</button>
      </div>}
    </div>
    <div className="space-y-2">
      <label className="block">Model
        <select value={modelId} disabled={busy || !models.length} onChange={event => setSelectedId(event.target.value)}
          className="mt-2 block w-full rounded border border-[var(--border)] bg-[var(--input)] p-2">
          {!models.length && <option value="">No scanned models available</option>}
          {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
      </label>
      <label className="block">Per-model avatar (PNG)
        <input type="file" accept=".png" disabled={busy || !modelId} onChange={event => upload(event, modelId)} className="mt-2 block w-full" />
      </label>
      {modelUrl && <div className="flex items-center gap-2">
        <img src={modelUrl} alt="Model avatar preview" className="size-12 rounded-lg object-cover" />
        <button type="button" className={buttonClass} disabled={busy} onClick={() => change(previous => {
          const modelAvatars = { ...previous.modelAvatars }; delete modelAvatars[modelId]; return { modelAvatars };
        })}>Remove model avatar</button>
      </div>}
    </div>
    {busy && <p role="status">Preparing avatar…</p>}
    {error && <p role="alert" className="palace-error">{error}</p>}
  </div>;
}

import React, { useEffect, useRef, useState } from 'react';

const fields = [
  ['contextLength', 'Context length', 1, 'Total context tokens shared across concurrent predictions.'],
  ['threads', 'CPU threads', 1, 'CPU thread pool size.'],
  ['evalBatch', 'Evaluation batch size', 1, 'Maximum logical batch size.'],
  ['physicalBatch', 'Physical batch size', 1, 'Must not exceed the evaluation batch size.'],
  ['parallel', 'Concurrent predictions', 1, 'Maximum simultaneous predictions.'],
];
const control = 'w-full rounded-lg border border-[#8885] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-2 focus:outline-[var(--accent)]';

export default function ModelSettingsModal({ model, onClose, onLoaded }) {
  const dialog = useRef(null);
  const [config, setConfig] = useState(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current.showModal();
    let active = true;
    window.api.getModelLoadConfig(model.id).then(({ config, remembered }) => {
      if (active) { setConfig(config); setRemember(remembered); }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [model.id]);
  const update = (key, value) => setConfig(prev => ({ ...prev, [key]: value }));
  const submit = async event => {
    event.preventDefault();
    if (busy || !config) return;
    setBusy(true); setError('');
    try {
      const result = await window.api.launchEngine(model.id, { ...config, rememberSettings: remember });
      if (!result?.success) throw new Error(result?.error || 'Could not start the engine.');
      onLoaded(result);
      onClose();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} aria-labelledby="load-settings-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    className="fixed inset-0 m-auto max-h-[92vh] w-[calc(100%-24px)] max-w-xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60">
    <form onSubmit={submit}>
      <header className="border-b border-[var(--border)] p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="load-settings-title" className="text-lg font-semibold">Advanced load settings</h2>
          <button type="button" aria-label="Close settings" onClick={onClose} disabled={busy} className="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40">✕</button>
        </div>
        <p className="mt-1 break-all text-xs text-[var(--text-secondary)]">{model.name || model.id}</p>
        {model.isVision && <p className="mt-2 text-xs text-[var(--text-secondary)]">Vision projector: {model.mmprojPath?.split(/[\\/]/).pop()}</p>}
      </header>
      {error && <p role="alert" className="px-4 pt-3 text-sm text-[var(--error)]">{error}</p>}
      {!config && !error && <p className="p-4 text-sm">Loading saved settings…</p>}
      {config && <fieldset disabled={busy} className="grid gap-4 p-4 sm:grid-cols-2 disabled:opacity-60">
        {fields.map(([key, label, min, hint]) => <label key={key} className="grid content-start gap-1.5 text-xs font-medium">
          {label}<input required type="number" min={min} max={2147483647} step="1" value={config[key]} className={control}
            onChange={event => update(key, event.target.value === '' ? '' : Number(event.target.value))} />
          <span className="font-normal text-[var(--text-secondary)]">{hint}</span>
        </label>)}
        <div className="grid content-start gap-1.5 text-xs font-medium">
          <label htmlFor="gpu-layers">GPU offload layers</label>
          <label className="flex items-center gap-2 font-normal"><input type="checkbox" checked={config.gpuOffload === 'auto'} onChange={event => update('gpuOffload', event.target.checked ? 'auto' : 0)} />Automatic</label>
          <input id="gpu-layers" type="number" required min="0" max={2147483647} step="1" disabled={busy || config.gpuOffload === 'auto'} value={config.gpuOffload === 'auto' ? '' : config.gpuOffload} placeholder="Auto" className={control}
            onChange={event => update('gpuOffload', event.target.value === '' ? '' : Number(event.target.value))} />
          <span className="font-normal text-[var(--text-secondary)]">Set 0 for CPU-only inference.</span>
        </div>
        <label className="grid content-start gap-1.5 text-xs font-medium">Flash attention
          <select className={control} value={config.flashAttention} onChange={event => update('flashAttention', event.target.value)}>
            <option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option>
          </select>
        </label>
        <label className="grid content-start gap-1.5 text-xs font-medium">Memory load mode
          <select className={control} value={config.loadMode} onChange={event => update('loadMode', event.target.value)}>
            <option value="auto">Auto</option><option value="none">None — disable mmap</option><option value="mmap">Mmap — memory mapping</option>
            <option value="mlock">Mlock — lock in RAM</option><option value="mmap+mlock">Mmap + Mlock</option><option value="dio">Direct I/O</option>
          </select>
        </label>
        <label className="grid content-start gap-1.5 text-xs font-medium">Seed (optional)
          <input type="number" min="-1" max="4294967295" step="1" placeholder="Server default" value={config.seed ?? ''} className={control}
            onChange={event => update('seed', event.target.value === '' ? null : Number(event.target.value))} />
        </label>
        <label className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Remember settings for this model</label>
      </fieldset>}
      <footer className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
        <button type="button" disabled={busy} onClick={onClose} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40">Cancel</button>
        <button type="submit" disabled={busy || !config} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-40">{busy ? 'Starting…' : 'Load Model'}</button>
      </footer>
    </form>
  </dialog>;
}

import React, { useEffect, useRef, useState } from 'react';
import ModelSettingsModal from './ModelSettingsModal';

export default function ModelSelectorModal({ models, selectedModel, onSelectModel, scanning, onScan, engineRunning, onClose, onLoaded, serverError }) {
  const dialog = useRef(null);
  const [query, setQuery] = useState('');
  const [configuring, setConfiguring] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, [configuring]);
  if (configuring) return <ModelSettingsModal model={configuring} onClose={() => setConfiguring(null)} onLoaded={result => { onLoaded(result); onClose(); }} />;
  return <dialog ref={dialog} aria-labelledby="model-selector-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-24px)] max-w-2xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60">
    <header className="flex items-center justify-between border-b border-[var(--border)] p-4"><h2 id="model-selector-title" className="font-semibold">Select / Load Model</h2><button type="button" aria-label="Close model selector" disabled={busy} onClick={onClose}>×</button></header>
    <div className="space-y-3 p-4">
      <div className="flex gap-2"><input autoFocus aria-label="Search models" placeholder="Search local models…" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm" /><button type="button" disabled={scanning} onClick={onScan} className="rounded-lg border border-[var(--border)] px-3 text-xs">{scanning ? 'Scanning…' : 'Rescan'}</button></div>
      {engineRunning && <div className="flex items-center justify-between rounded-lg bg-[var(--surface-hover)] p-3 text-xs"><span>Unload the running engine before loading another model.</span><button type="button" disabled={busy} className="ml-3 rounded border border-[var(--border)] px-3 py-2" onClick={async () => {
        setBusy(true); setError('');
        try { const result = await window.terminalAPI.kill(); if (!result.success) throw new Error(result.error); }
        catch (err) { setError(err.message); } finally { setBusy(false); }
      }}>Unload</button></div>}
      {(error || serverError) && <p role="alert" className="text-xs text-[var(--error)]">{error || serverError}</p>}
      <div className="space-y-2">{models.filter(model => (model.name || model.id).toLowerCase().includes(query.toLowerCase())).map(model => <button key={model.id} type="button" disabled={engineRunning || busy} onClick={() => { onSelectModel(model.id); setConfiguring(model); }} className="flex w-full items-center justify-between gap-4 rounded-lg border border-[var(--border)] p-3 text-left hover:bg-[var(--surface-hover)] disabled:opacity-50">
        <span className="min-w-0"><span className="block break-all text-sm">{model.name || model.id}</span><span className="text-[11px] text-[var(--text-muted)]">{model.isVision ? 'Vision · ' : ''}{model.id === selectedModel ? 'Selected · ' : ''}Configure advanced load settings</span></span><span aria-hidden="true">→</span>
      </button>)}</div>
      {!models.length && <p className="text-sm text-[var(--text-muted)]">No local models found. Scan to refresh the list.</p>}
    </div>
  </dialog>;
}

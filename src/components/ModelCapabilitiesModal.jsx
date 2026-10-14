import React, { useEffect, useRef, useState } from 'react';
import { LuEye, LuVideo, LuAudioLines, LuX } from 'react-icons/lu';
export default function ModelCapabilitiesModal({ entry, overrides, onClose, onSaved }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState(overrides || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const previous = document.activeElement; const element = dialog.current; element.showModal(); return () => { element.close(); previous?.focus(); }; }, []);
  const target = entry.local ? { type: 'local', modelId: entry.model.modelPath || entry.model.path || entry.model.id } : { type: 'cloud', provider: entry.model.id, model: entry.model.modelId };
  return <dialog ref={dialog} aria-labelledby="capability-editor-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className="m-auto w-[calc(100%-24px)] max-w-md overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60">
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      if (!entry.local && draft.contextLength != null && (!Number.isSafeInteger(Number(draft.contextLength)) || Number(draft.contextLength) <= 0)) { setError('Enter a positive whole number of context tokens, or leave it blank for automatic detection.'); setBusy(false); return; }
      const payload = { ...draft, ...(!entry.local ? { contextLength: draft.contextLength == null || draft.contextLength === '' ? null : Number(draft.contextLength) } : {}) };
      try { const all = await window.api.saveCapabilityOverrides(target, payload); onSaved(all); window.dispatchEvent(new Event('model-capabilities-changed')); onClose(); }
      catch (error) { setError(error.message); } finally { setBusy(false); }
    }}>
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4"><div className="min-w-0"><h2 id="capability-editor-title" className="text-sm font-semibold">Model capabilities</h2><p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={entry.name}>{entry.name}</p></div><button type="button" aria-label="Close capability editor" disabled={busy} onClick={onClose} className="grid size-8 place-items-center rounded-lg hover:bg-[var(--surface-hover)]"><LuX /></button></header>
      <div className="px-5 py-4">
        <p className="mb-3 text-xs text-[var(--text-muted)]">Correct missing or inaccurate detection for this model. Your choices are saved and used by the attachment picker.</p>
        {[["image", "Images", LuEye], ["video", "Video", LuVideo], ["audio", "Audio", LuAudioLines]].map(([kind, label, Icon]) => <label key={kind} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-3 text-xs"><span className="flex items-center gap-2"><Icon size={16} className="text-[var(--accent)]" />{label}</span><select aria-label={`${label} capability`} disabled={busy} value={draft[kind] === true ? 'on' : draft[kind] === false ? 'off' : 'auto'} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, [kind]: value === 'auto' ? null : value === 'on' })); }} className="rounded-lg border border-[var(--control-border)] bg-[var(--input)] px-3 py-2 text-xs"><option value="auto">Automatic detection</option><option value="on">Enabled</option><option value="off">Disabled</option></select></label>)}
        {!entry.local && <label className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-3 text-xs"><span>Context window <span className="text-[var(--text-muted)]">(tokens)</span></span><input type="number" min="1" step="1" aria-label="Context window tokens" disabled={busy} value={draft.contextLength ?? ''} placeholder="Automatic" onChange={event => setDraft(previous => ({ ...previous, contextLength: event.target.value === '' ? null : event.target.value }))} className="w-40 rounded-lg border border-[var(--control-border)] bg-[var(--input)] px-3 py-2 text-xs" /></label>}
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">Overrides do not add support to the model or engine. A compatible projector may still be required.{!entry.local && entry.model.apiType === 'anthropic' ? ' The Anthropic adapter supports image input, but not native audio/video input.' : ''}</p>
        {error && <p role="alert" className="mt-3 text-xs text-[var(--error)]">{error}</p>}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-5 py-3"><button type="button" disabled={busy} onClick={() => setDraft({})} className="text-xs text-[var(--text-secondary)] hover:underline">Reset to automatic</button><button disabled={busy} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)]">{busy ? 'Saving…' : 'Save capabilities'}</button></footer>
    </form>
  </dialog>;
}

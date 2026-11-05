import React, { useEffect, useRef, useState } from 'react';
import { SelectField, NumberField } from './FormControls';
import { LuEye, LuVideo, LuAudioLines, LuX } from 'react-icons/lu';
export default function ModelCapabilitiesModal({ entry, overrides, onClose, onSaved }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState(overrides || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const previous = document.activeElement; const element = dialog.current; element.showModal(); return () => { element.close(); previous?.focus(); }; }, []);
  const target = entry.local ? { type: 'local', modelId: entry.model.modelPath || entry.model.path || entry.model.id } : { type: 'cloud', provider: entry.model.id, model: entry.model.modelId };
  return <dialog ref={dialog} aria-labelledby="capability-editor-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className="aero-dialog sk-window sk-dialog m-auto w-[calc(100%-24px)] max-w-md overflow-hidden p-0">
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      if (!entry.local && draft.contextLength != null && (!Number.isSafeInteger(Number(draft.contextLength)) || Number(draft.contextLength) <= 0)) { setError('Enter a positive whole number of context tokens, or leave it blank for automatic detection.'); setBusy(false); return; }
      const payload = { ...draft, ...(!entry.local ? { contextLength: draft.contextLength == null || draft.contextLength === '' ? null : Number(draft.contextLength) } : {}) };
      try { const all = await window.api.saveCapabilityOverrides(target, payload); onSaved(all); window.dispatchEvent(new Event('model-capabilities-changed')); onClose(); }
      catch (error) { setError(error.message); } finally { setBusy(false); }
    }}>
      <header className="aero-header sk-window-header sk-texture-grain flex items-center justify-between gap-3 px-5 py-4"><div className="min-w-0"><h2 id="capability-editor-title" className="text-sm font-semibold">Model capabilities</h2><p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={entry.name}>{entry.name}</p></div><button type="button" aria-label="Close capability editor" disabled={busy} onClick={onClose} className="aero-orb sk-icon-button aero-fill sk-fill grid size-8 place-items-center"><LuX /></button></header>
      <div className="px-5 py-4">
        <p className="mb-3 text-xs text-[var(--text-muted)]">Correct missing or inaccurate detection for this model. Your choices are saved and used by the attachment picker.</p>
        {[["image", "Images", LuEye], ["video", "Video", LuVideo], ["audio", "Audio", LuAudioLines]].map(([kind, label, Icon]) => <div key={kind} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-3 text-xs"><label htmlFor={`capability-${kind}`} className="flex items-center gap-2"><Icon size={16} className="text-[var(--accent)]" />{label}</label><SelectField id={`capability-${kind}`} className="w-48 min-w-0 shrink-0" aria-label={`${label} capability`} disabled={busy} value={draft[kind] === true ? 'on' : draft[kind] === false ? 'off' : 'auto'} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, [kind]: value === 'auto' ? null : value === 'on' })); }}><option value="auto">Automatic detection</option><option value="on">Enabled</option><option value="off">Disabled</option></SelectField></div>)}
        {!entry.local && <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-3 text-xs"><label htmlFor="capability-context">Context window <span className="text-[var(--text-muted)]">(tokens)</span></label><NumberField id="capability-context" min="1" step="1" aria-label="Context window tokens" disabled={busy} value={draft.contextLength ?? ''} placeholder="Automatic" onChange={event => setDraft(previous => ({ ...previous, contextLength: event.target.value === '' ? null : event.target.value }))} className="w-40" /></div>}
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">Overrides do not add support to the model or engine. A compatible projector may still be required.{!entry.local && entry.model.apiType === 'anthropic' ? ' The Anthropic adapter supports image input, but not native audio/video input.' : ''}</p>
        {error && <p role="alert" className="mt-3 text-xs text-[var(--error)]">{error}</p>}
      </div>
      <footer className="aero-footer sk-window-footer flex items-center justify-between gap-2 px-5 py-3"><button type="button" disabled={busy} onClick={() => setDraft({})} className="aero-list-item sk-list-row ui-radius-control px-2 py-2 text-xs text-[var(--text-secondary)]">Reset to automatic</button><button disabled={busy} className="aero-primary sk-button sk-primary aero-fill sk-fill px-3 py-2 text-xs font-semibold">{busy ? 'Saving…' : 'Save capabilities'}</button></footer>
    </form>
  </dialog>;
}

import React, { useEffect, useRef, useState } from 'react';
import { optimizeImage } from '../utils/imageUtils.mjs';

const emptyAgent = () => ({ name: '', description: '', system_prompt: '', avatar_url: null, model_id: '',
  sampling_params: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, max_tokens: -1 } });
const controls = [
  ['temperature', 'Temperature', 0, 2, 0.05], ['top_p', 'Top-P', 0, 1, 0.05],
  ['top_k', 'Top-K', 1, 100, 1], ['repeat_penalty', 'Repeat Penalty', 1, 1.5, 0.01],
];
export default function AgentModal({ agents, models, onChanged, onClose }) {
  const dialog = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyAgent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  function select(agent) {
    setEditingId(agent?.id || null);
    setDraft(agent ? { ...agent, model_id: agent.model_id || '', sampling_params: { ...emptyAgent().sampling_params, ...agent.sampling_params } } : emptyAgent());
    setError(''); setNotice(''); setConfirmDelete(false);
  }
  async function mutate(operation, deleted = false) {
    setBusy(true); setError('');
    try {
      const result = await operation();
      select(deleted ? null : result);
      await onChanged();
      setNotice(deleted ? 'Agent deleted. Existing chats retain their profile.' : 'Agent saved. Select it in chat to apply this version.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const button = 'rounded border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-40';
  return <dialog ref={dialog} className="palace-dialog" aria-labelledby="agent-library-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="flex items-center justify-between border-b border-[var(--border)] p-3">
      <h2 id="agent-library-title" className="font-semibold">Agent Presets</h2>
      <button type="button" className={button} aria-label="Close agent library" disabled={busy} onClick={onClose}>×</button>
    </header>
    <div className="min-h-0 overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 text-xs">Agent
          <select autoFocus value={editingId || ''} disabled={busy} onChange={event => select(agents.find(agent => agent.id === event.target.value))}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--input)] p-2">
            <option value="">Create new agent</option>
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <button type="button" className={button} disabled={busy} onClick={() => select(null)}>New</button>
        <button type="button" className={button} disabled={busy || !editingId} onClick={() => mutate(() => window.api.duplicateAgent(editingId))}>Duplicate</button>
        <button type="button" className={button} disabled={busy || !editingId} onClick={() => setConfirmDelete(true)}>Delete</button>
      </div>
      {confirmDelete && <div className="mb-3 rounded border border-[var(--border)] p-3 text-xs">
        <p>Delete this preset? Existing chats keep their profile.</p>
        <button type="button" className={button} disabled={busy} onClick={() => mutate(() => window.api.deleteAgent(editingId), true)}>Delete preset</button>
        <button type="button" className={button} disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
      </div>}
      <form className="palace-form" onSubmit={event => {
        event.preventDefault();
        mutate(() => editingId ? window.api.updateAgent(editingId, draft) : window.api.createAgent(draft));
      }}>
        <fieldset disabled={busy} className="space-y-3">
          <label>Name<input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>Description<textarea rows={2} maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
          <label>System Prompt<textarea required rows={6} maxLength={32000} value={draft.system_prompt} onChange={event => setDraft({ ...draft, system_prompt: event.target.value })} /></label>
          <label>Avatar Image<input type="file" accept=".png,.jpg,.jpeg,.webp" onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > 20 * 1024 * 1024) { setError('Choose a PNG, JPEG, or WebP image up to 20 MB.'); return; }
            setBusy(true); setError('');
            try { const url = await optimizeImage(file, 128, 128); setDraft(previous => ({ ...previous, avatar_url: url })); }
            catch (err) { setError(err.message); }
            finally { setBusy(false); }
          }} /></label>
          {draft.avatar_url && <div className="flex items-center gap-2">
            <img src={draft.avatar_url} alt="Agent avatar preview" className="size-12 rounded-lg object-cover" />
            <button type="button" className={button} onClick={() => setDraft({ ...draft, avatar_url: null })}>Remove avatar</button>
          </div>}
          <label>Default Model<select value={draft.model_id} onChange={event => setDraft({ ...draft, model_id: event.target.value })}>
            <option value="">Use current model</option>
            {draft.model_id && !models.some(model => model.id === draft.model_id) && <option value={draft.model_id}>{draft.model_id} (not scanned)</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
          </select></label>
          <h3 className="text-sm font-semibold">Default Sampling Parameters</h3>
          {controls.map(([key, label, min, max, step]) => <label key={key}>{label}: {draft.sampling_params[key]}
            <input type="range" min={min} max={max} step={step} value={draft.sampling_params[key]}
              onChange={event => setDraft({ ...draft, sampling_params: { ...draft.sampling_params, [key]: Number(event.target.value) } })} />
          </label>)}
          <label>Max Tokens (-1 for unlimited)<input type="number" required min={-1} step={1} value={draft.sampling_params.max_tokens}
            onChange={event => setDraft({ ...draft, sampling_params: { ...draft.sampling_params, max_tokens: event.target.value === '' ? '' : Number(event.target.value) } })} /></label>
          <button className="palace-add" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Create agent'}</button>
        </fieldset>
      </form>
      {error && <p role="alert" className="palace-error">{error}</p>}
      {notice && <p role="status" className="mt-3 text-xs">{notice}</p>}
    </div>
  </dialog>;
}

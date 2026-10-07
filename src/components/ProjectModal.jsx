import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './projects.css';

export default function ProjectModal({ onClose, onCreate }) {
  const ref = useRef(null);
  const [fields, setFields] = useState({ name: '', description: '', custom_instructions: '', root_path: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  async function pickFolder() {
    setBusy(true); setError('');
    try { const root_path = await window.api.pickDirectory(); if (root_path) setFields(previous => ({ ...previous, root_path })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onCreate(fields); } catch (err) { setError(err.message); setBusy(false); }
  }
  return createPortal(<dialog ref={ref} className="project-dialog" aria-labelledby="new-project-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}><div><h2 id="new-project-title" className="text-xl font-semibold">Create a project</h2><p className="projects-muted mt-2">Give your work a shared goal and a place to grow.</p></div>
      <fieldset disabled={busy} className="grid gap-4">
        <label className="project-field">Name<input autoFocus required maxLength={200} className="project-input" value={fields.name} onChange={event => setFields({ ...fields, name: event.target.value })} placeholder="e.g. Personal website" /></label>
        <label className="project-field">Goal / Description<textarea className="project-input" value={fields.description} onChange={event => setFields({ ...fields, description: event.target.value })} placeholder="What are you working toward? Markdown is supported." /></label>
        <label className="project-field">Custom Instructions<textarea className="project-input" value={fields.custom_instructions} onChange={event => setFields({ ...fields, custom_instructions: event.target.value })} placeholder="Preferences and rules for every chat in this project" /></label>
        <div className="project-field"><span>Root folder (optional)</span><span className="project-path" title={fields.root_path || ''}>{fields.root_path || 'No folder selected'}</span><button type="button" className="project-button" onClick={pickFolder}>Choose Folder</button></div>
      </fieldset>
      {error && <p role="alert" className="project-error">{error}</p>}
      <div className="project-actions"><button type="button" className="project-button" disabled={busy} onClick={onClose}>Cancel</button><button className="project-button primary" disabled={busy || !fields.name.trim()}>{busy ? 'Saving…' : 'Create Project'}</button></div>
    </form>
  </dialog>, document.body);
}

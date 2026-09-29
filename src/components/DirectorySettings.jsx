import React, { useEffect, useRef, useState } from 'react';

export default function DirectorySettings() {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [error, setError] = useState('');
  const overlay = useRef(null);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => window.api.getConfig()).then(value => { if (active) setConfig(value); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (migrating) overlay.current.showModal();
    else overlay.current.close();
  }, [migrating]);
  async function change(key) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const directory = await window.api.pickDirectory();
      if (!directory) return;
      if (key === 'modelDirectory') {
        const modelDirectory = await window.api.setModelDirectory(directory);
        setConfig(previous => ({ ...previous, modelDirectory }));
        window.dispatchEvent(new Event('model-directory-changed'));
      } else {
        setMigrating(true);
        const result = await window.api.migrateAppData(directory);
        if (!result.success) throw new Error(result.error || 'Migration failed.');
        setConfig(result.config);
        if (result.warning) window.alert(result.warning);
        // Reload cached session/attachment paths after the backend switches roots.
        window.location.reload();
      }
    } catch (err) { setError(err.message); }
    finally { setBusy(false); setMigrating(false); }
  }
  return <div className="space-y-4">
    {['modelDirectory', 'appDataDirectory'].map(key => <section key={key} className="space-y-2 rounded-lg border border-[var(--border)] p-4">
      <h3 className="font-semibold">{key === 'modelDirectory' ? 'Model Directory' : 'App Data Directory'}</h3>
      <p className="break-all text-xs text-[var(--text-secondary)]">{config?.[key] || 'Loading…'}</p>
      {key === 'appDataDirectory' && <p className="text-xs text-[var(--text-muted)]">SQLite, RAG vectors, attachments, embedding models, and avatars. Choose an empty folder. Settings will reload after migration.</p>}
      <button type="button" disabled={busy || !config} onClick={() => change(key)}
        className="rounded border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40">Change Directory</button>
    </section>)}
    {error && <p role="alert" className="palace-error">{error}</p>}
    <dialog ref={overlay} onCancel={event => event.preventDefault()}
      className="fixed inset-0 m-auto rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-8 text-[var(--text-primary)] backdrop:bg-black/70">
      <div role="status" aria-live="polite" className="flex items-center gap-3">
        <span aria-hidden="true" className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Migrating app data. Do not close the application...
      </div>
    </dialog>
  </div>;
}

import React, { useEffect, useState } from 'react';
export default function RagSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    window.api?.getRagSettings().then(value => { if (active) setSettings(value); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  return <div className="mb-4 space-y-2 rounded-lg border border-[var(--border)] p-3">
    <h3 className="font-semibold">Offline document chat</h3>
    <p>Run a separate local llama-server with an embedding model. Documents stay on this computer.</p>
    <code className="block select-text break-all">llama-server -m /path/to/embedding-model.gguf --embedding --pooling mean --host 127.0.0.1 --port 8081</code>
    <p className="palace-hint">Use the pooling mode required by your embedding model. PDFs need a text layer; OCR is not included.</p>
    {settings && <form className="palace-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); setSaved(false);
      try { await window.api.saveRagSettings(settings); setSaved(true); }
      catch (err) { setError(err.message); }
      finally { setBusy(false); }
    }}>
      <label>Local embeddings port<input type="number" min="1" max="65535" required value={settings.embeddingPort}
        onChange={event => { setSettings({ ...settings, embeddingPort: Number(event.target.value) }); setSaved(false); }} /></label>
      <label>Embedding model (blank to detect)<input value={settings.embeddingModel} onChange={event => { setSettings({ ...settings, embeddingModel: event.target.value }); setSaved(false); }} /></label>
      <label>Embedding API key (optional)<input type="password" autoComplete="off" value={settings.embeddingApiKey} onChange={event => { setSettings({ ...settings, embeddingApiKey: event.target.value }); setSaved(false); }} /></label>
      <button className="palace-add" disabled={busy}>{busy ? 'Saving…' : 'Save embedding settings'}</button>
    </form>}
    {error && <p role="alert" className="palace-error">{error}</p>}
    {saved && <p role="status">Embedding settings saved.</p>}
  </div>;
}

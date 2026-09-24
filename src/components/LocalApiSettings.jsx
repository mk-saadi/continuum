import React, { useEffect, useState } from 'react';

export default function LocalApiSettings() {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState('8080');
  const [activePort, setActivePort] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true, statusVersion = 0;
    const updateStatus = status => {
      if (!active) return;
      statusVersion++;
      setActivePort(status.running ? status.port : null);
    };
    const unsubscribe = window.terminalAPI?.onStatus(updateStatus);
    const initialVersion = statusVersion;
    window.terminalAPI?.status().then(status => {
      if (statusVersion === initialVersion) updateStatus(status);
    }).catch(err => { if (active) setError(err.message); });
    (async () => {
      try {
        if (!window.api?.getAppSettings) throw new Error('Open the desktop app to configure the local API server.');
        const value = await window.api.getAppSettings();
        if (active) { setSettings(value); setDraft(value.apiServerPort === null ? '' : String(value.apiServerPort)); }
      } catch (err) { if (active) setError(err.message); }
    })();
    return () => { active = false; unsubscribe?.(); };
  }, []);
  const port = activePort ?? settings?.apiServerPort;
  const endpoint = port ? `http://127.0.0.1:${port}/v1` : null;
  return <div className="mb-4 space-y-3 rounded-lg border border-[var(--border)] p-3">
    <h3 className="font-semibold">Local API Server</h3>
    <form className="palace-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); setNotice('');
      try {
        const saved = await window.api.saveAppSettings({ apiServerPort: draft.trim() === '' ? null : Number(draft) });
        setSettings(saved); setNotice('Saved. The port applies the next time you load the engine.');
      } catch (err) { setError(err.message); }
      finally { setBusy(false); }
    }}>
      <label>Local API Server Port
        <input type="number" min="1" max="65535" step="1" value={draft} disabled={busy || !settings}
          placeholder="Automatic" onChange={event => { setDraft(event.target.value); setNotice(''); }} />
      </label>
      <p className="palace-hint">Default: 8080. Leave blank to choose an available port automatically.</p>
      <button className="palace-add" disabled={busy || !settings}>{busy ? 'Saving…' : 'Save port'}</button>
    </form>
    <div className="space-y-2 rounded bg-[var(--input)] p-3">
      <p>{activePort ? 'Current engine endpoint' : 'Configured endpoint (engine stopped)'}</p>
      <code className="block select-text break-all">{endpoint || 'Start the engine to get its automatic port.'}</code>
      <button type="button" className="palace-add" disabled={!endpoint} onClick={async () => {
        try { await navigator.clipboard.writeText(endpoint); setError(''); setNotice('OpenAI Base URL copied.'); }
        catch (err) { setError(err.message); }
      }}>Copy OpenAI Base URL</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="palace-error">{error}</p>}
  </div>;
}

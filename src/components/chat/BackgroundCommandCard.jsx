import React, { useEffect, useState } from 'react';

function CommandPreview({ sessionId, record }) {
  const [preview, setPreview] = useState(null);
  const [port, setPort] = useState('5173');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    const poll = () => window.memoryPalace?.getCommandPreview?.(sessionId, record.command_id)
      .then(value => { if (!disposed) setPreview(value); })
      .catch(() => { if (!disposed) setPreview(null); });
    poll(); const timer = setInterval(poll, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [sessionId, record.command_id]);
  if (!preview?.available) return null;
  const act = async action => {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <div className="mt-2" aria-label="Development preview">
    <p>Preview · {preview.status.replaceAll('_', ' ')}</p>
    {preview.status === 'not_created' && <>
      <label>Guest port <input aria-label="Preview guest port" type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} /></label>
      <button type="button" disabled={busy || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={() => act(async () => {
        setPreview({ available: true, ...await window.memoryPalace.createCommandPreview(sessionId, record.command_id, Number(port)) });
      })}>Create Preview</button>
    </>}
    {preview.status === 'ready' && <>
      <button type="button" disabled={busy} onClick={() => act(() => window.memoryPalace.openCommandPreview(sessionId, record.command_id))}>Open Preview</button>
      <button type="button" disabled={busy} onClick={() => act(async () => {
        const current = await window.memoryPalace.getCommandPreview(sessionId, record.command_id);
        if (current.status !== 'ready' || !current.url) throw new Error('Preview is unavailable.');
        await navigator.clipboard.writeText(current.url);
      })}>Copy URL</button>
      <p>Open Preview authorizes your browser. Copied URLs work only in an already authorized browser profile.</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export default function BackgroundCommandCard({ sessionId }) {
  const [records, setRecords] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const api = window.memoryPalace;
    setRecords([]);
    // Subscribe before loading; merge so a slower snapshot cannot overwrite
    // completion events that arrived while the request was in flight.
    const updates = new Map();
    const unsubscribe = api?.onBackgroundCommand?.(event => {
      if (disposed || event.sessionId !== sessionId) return;
      updates.set(event.record.command_id, event.record);
      setRecords(previous => [...previous.filter(r => r.command_id !== event.record.command_id), event.record]);
    });
    api?.getBackgroundCommands?.(sessionId).then(rows => {
      if (!disposed) setRecords([...new Map([...rows, ...updates.values()].map(r => [r.command_id, r])).values()]);
    }).catch(() => {});
    const timer = setInterval(() => {
      setNow(Date.now());
      api?.getBackgroundCommands?.(sessionId).then(rows => { if (!disposed) setRecords(rows); }).catch(() => {});
    }, 1000);
    return () => { clearInterval(timer); disposed = true; unsubscribe?.(); };
  }, [sessionId]);
  if (!records.length) return null;
  const running = records.filter(r => ['starting', 'running'].includes(r.status)).length;
  return <section className="aero-panel p-3" aria-label="Background commands">
    <h3 className="text-xs font-semibold">Background commands · {running} running</h3>
    {error && <p role="alert">{error}</p>}
    {records.slice(-12).reverse().map(r => <details key={r.command_id} className="mt-2 text-[11px] break-words">
      <summary>{r.command_summary} · {r.status} · {r.notification_state === 'delivered' ? 'Agent informed' : `Notification: ${r.notification_state}`}</summary>
      <p>{r.command_id} · Started {r.started_at}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}{r.exitCode != null ? ` · Exit ${r.exitCode}` : ''}</p>
      <p>{r.survive_run_completion ? 'Persistent' : 'Run scoped'}{r.reason ? ` · ${r.reason.replaceAll('_', ' ')}` : ''}{['starting', 'running'].includes(r.status) && r.expires_at ? ` · ${Math.max(0, Math.ceil((Date.parse(r.expires_at) - now) / 1000))}s remaining` : ''}</p>
      {['starting', 'running'].includes(r.status) && <button type="button" onClick={async () => {
        try {
          const record = await window.memoryPalace.stopBackgroundCommand(sessionId, r.command_id);
          setRecords(rows => rows.map(row => row.command_id === record.command_id ? record : row)); setError('');
        } catch (failure) { setError(failure.message); }
      }}>Stop</button>}
      {r.survive_run_completion && ['starting', 'running'].includes(r.status) && <CommandPreview key={sessionId + r.command_id} sessionId={sessionId} record={r} />}
      {r.persistence_error && <p>{r.persistence_error}</p>}
      {r.output_truncated && <p>Output truncated</p>}
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap ui-radius-control bg-[var(--terminal)] p-2 text-[var(--terminal-text)]">{`${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-2000)}</pre>
    </details>)}
  </section>;
}

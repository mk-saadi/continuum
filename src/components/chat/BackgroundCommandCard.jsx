import React, { useEffect, useState } from 'react';

export default function BackgroundCommandCard({ sessionId }) {
  const [records, setRecords] = useState([]);
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
    return () => { disposed = true; unsubscribe?.(); };
  }, [sessionId]);
  if (!records.length) return null;
  const running = records.filter(r => ['starting', 'running'].includes(r.status)).length;
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3" aria-label="Background commands">
    <h3 className="text-xs font-semibold">Background commands · {running} running</h3>
    {records.slice(-12).reverse().map(r => <details key={r.command_id} className="mt-2 text-[11px] break-words">
      <summary>{r.command_summary} · {r.status} · {r.notification_state === 'delivered' ? 'Agent informed' : `Notification: ${r.notification_state}`}</summary>
      <p>{r.command_id} · Started {r.started_at}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}{r.exitCode != null ? ` · Exit ${r.exitCode}` : ''}</p>
      {r.persistence_error && <p>{r.persistence_error}</p>}
      {r.output_truncated && <p>Output truncated</p>}
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{`${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-2000)}</pre>
    </details>)}
  </section>;
}

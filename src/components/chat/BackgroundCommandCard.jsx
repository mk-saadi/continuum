import { useToastMessage } from "../../hooks/useAppToast.jsx";
import React, { useEffect, useState } from 'react';
import { FiTerminal, FiCheck, FiX, FiClock, FiLoader, FiMinusCircle, FiChevronRight } from 'react-icons/fi';
import './backgroundCommands.css';

const isActive = r => ['starting', 'running'].includes(r.status);
function outcome(r) {
  if (isActive(r)) return { key: 'running', label: r.status === 'starting' ? 'Starting' : 'Running', Icon: FiLoader };
  if (r.status === 'completed') return { key: 'completed', label: 'Completed', Icon: FiCheck };
  if (r.status === 'cancelled') return { key: 'stopped', label: 'Stopped', Icon: FiMinusCircle };
  if (['timed_out', 'agent_deadline_exceeded'].includes(r.status)) return { key: 'failed', label: 'Timed out', Icon: FiClock };
  return { key: 'failed', label: 'Failed', Icon: FiX };
}
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function delivery(r) {
  if (r.notification_state === 'delivered') return 'Agent informed';
  if (isActive(r)) return r.wait_for_completion === false ? 'Runs independently' : 'Agent continues when finished';
  if (['queued', 'included'].includes(r.notification_state)) return 'Sending result to agent…';
  if (r.notification_state === 'undelivered') return 'Result not delivered · agent run ended';
  if (r.notification_state === 'ambiguous') return 'Result delivery unconfirmed';
  return 'Result awaiting delivery';
}


function CommandPreview({ sessionId, record }) {
  const [preview, setPreview] = useState(null);
  const [port, setPort] = useState('5173');
  const [error, setError] = useState('');
  useToastMessage(error);
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

  </div>;
}

export default function BackgroundCommandCard({ sessionId }) {
  const [records, setRecords] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  useToastMessage(error);
  const [waiting, setWaiting] = useState(false);
  const [filter, setFilter] = useState('all');
  const [stopping, setStopping] = useState(null);
  useEffect(() => {
    let disposed = false;
    const api = window.memoryPalace;
    setRecords([]);
    setWaiting(false);
    const offStatus = window.chatAPI?.onStreamStatus?.(event => {
      if (!disposed && event.sessionId === sessionId) setWaiting(event.status === 'waiting_commands');
    });
    // Subscribe before loading; merge so a slower snapshot cannot overwrite
    // completion events that arrived while the request was in flight.
    const updates = new Map();
    const unsubscribe = api?.onBackgroundCommand?.(event => {
      if (disposed || event.sessionId !== sessionId) return;
      updates.set(event.record.command_id, event.record);
      setRecords(previous => [...previous.filter(r => r.command_id !== event.record.command_id), ...(event.record.background === false ? [] : [event.record])]);
    });
    api?.getBackgroundCommands?.(sessionId).then(rows => {
      if (!disposed) setRecords([...new Map([...rows, ...updates.values()].map(r => [r.command_id, r])).values()].filter(r => r.background !== false));
    }).catch(() => {});
    const timer = setInterval(() => {
      setNow(Date.now());
      api?.getBackgroundCommands?.(sessionId).then(rows => { if (!disposed) setRecords(rows); }).catch(() => {});
    }, 1000);
    return () => { clearInterval(timer); disposed = true; unsubscribe?.(); offStatus?.(); };
  }, [sessionId]);
  if (!records.length) return null;
  const counts = records.reduce((all, r) => { all[outcome(r).key]++; return all; }, { running: 0, completed: 0, failed: 0, stopped: 0 });
  const visible = records.filter(r => filter === 'all' || outcome(r).key === filter)
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || Date.parse(b.started_at) - Date.parse(a.started_at));
  return <section className="aero-panel sk-panel background-commands" aria-label="Background commands">
    <header className="bc-header"><FiTerminal aria-hidden="true" /><h3>Background commands</h3><span className={`bc-count ${counts.running ? 'bc-count-active' : ''}`}>{counts.running} running</span></header>
    <div className="bc-filters" role="group" aria-label="Filter commands">
      {[['all', 'All', records.length], ['running', 'Running', counts.running], ['completed', 'Done', counts.completed], ['failed', 'Failed', counts.failed], ['stopped', 'Stopped', counts.stopped]].map(([key, label, count]) =>
        <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{count}</span></button>)}
    </div>
    {waiting && <p role="status" className="bc-waiting"><FiClock aria-hidden="true" />Waiting for results. The agent will continue automatically.</p>}

    <div className="bc-list">
      {!visible.length && <p className="bc-empty">No {filter === 'all' ? '' : filter} commands.</p>}
      {visible.map(r => {
        const { key, label, Icon } = outcome(r);
        const elapsed = isActive(r) ? now - Date.parse(r.started_at) : r.duration_ms;
        const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-2000);
        return <details key={r.command_id} className={`bc-command bc-${key}`}>
          <summary className="bc-summary">
            <div className="bc-state-row"><span className="bc-state"><Icon aria-hidden="true" />{label}</span><span className="bc-time">{elapsed != null && duration(elapsed)}<FiChevronRight className="bc-chevron" aria-hidden="true" /></span></div>
            <code className="bc-command-name">{r.command_summary}</code>
            <span className={`bc-delivery ${!isActive(r) && r.notification_state === 'undelivered' ? 'bc-delivery-warning' : ''}`}>{delivery(r)}</span>
          </summary>
          <div className="bc-details">
            <dl className="bc-metadata"><div><dt>Started</dt><dd>{new Date(r.started_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd></div>
              {r.exitCode != null && <div><dt>Exit code</dt><dd>{r.exitCode}</dd></div>}
              <div><dt>Lifetime</dt><dd>{r.expires_at ? (isActive(r) ? `${duration(Math.max(0, Date.parse(r.expires_at) - now))} remaining` : `${duration(r.timeout_ms ?? 0)} limit`) : 'No time limit'}</dd></div>
            </dl>
            <p className="bc-command-id">{r.command_id}</p>
            {isActive(r) && <button className="bc-stop" type="button" disabled={stopping === r.command_id} onClick={async () => {
              setStopping(r.command_id);
              try {
                const record = await window.memoryPalace.stopBackgroundCommand(sessionId, r.command_id);
                setRecords(rows => rows.map(row => row.command_id === record.command_id ? record : row)); setError('');
              } catch (failure) { setError(failure.message); }
              finally { setStopping(null); }
            }}><FiX aria-hidden="true" />{stopping === r.command_id ? 'Stopping…' : 'Stop command'}</button>}
            {r.survive_run_completion && isActive(r) && <CommandPreview key={sessionId + r.command_id} sessionId={sessionId} record={r} />}
            {r.persistence_error && <p className="bc-error">{r.persistence_error}</p>}
            <div className="bc-output-heading">Output{r.output_truncated && <span>Latest excerpt</span>}</div>
            {output ? <pre className="bc-output">{output}</pre> : <p className="bc-no-output">{isActive(r) ? 'No output yet. Command is still running.' : 'No output captured.'}</p>}
          </div>
        </details>;
      })}
    </div>
  </section>;
}

import React, { useEffect, useState } from 'react';
import TokenChart from './TokenChart';

export default function TokenHistory() {
  const [groupBy, setGroupBy] = useState('month');
  const [projectId, setProjectId] = useState('');
  const [months, setMonths] = useState(12);
  const [retention, setRetention] = useState(12);
  const [projects, setProjects] = useState([]);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    window.api.listProjects().then(value => { if (active) setProjects(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    window.api.getTokenHistory({ groupBy, projectId: projectId || null, months }).then(value => {
      if (!active) return;
      setHistory(value); setRetention(value.retentionMonths);
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [groupBy, projectId, months, revision]);
  const saveRetention = async () => {
    setSaving(true); setError('');
    try { await window.api.setTokenRetention(retention); setMonths(Math.min(months, retention)); setRevision(value => value + 1); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  const totals = (history?.data || []).reduce((sum, row) => ({ prompt: sum.prompt + row.promptTokens, completion: sum.completion + row.completionTokens }), { prompt: 0, completion: 0 });
  const selectClass = 'mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--input)] p-2 text-[var(--text-primary)]';
  return <div className="space-y-5">
    <p className="text-sm text-[var(--text-muted)]">Reported token usage from new chat turns, including tool follow-ups. Missing server counts are not estimated. Totals remain after a chat is deleted.</p>
    <div className="flex flex-wrap gap-3 text-sm">
      <label className="min-w-36 flex-1">Project<select className={selectClass} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects & chats</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>Group by<select className={selectClass} value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="month">Month</option><option value="week">Week</option></select></label>
      <label>History window<select className={selectClass} value={months} onChange={event => setMonths(Number(event.target.value))}>{[1, 3, 6, 12].map(value => <option key={value} value={value}>{value} month{value > 1 ? 's' : ''}</option>)}</select></label>
      <button type="button" className="self-end rounded-lg border border-[var(--border)] p-2" onClick={() => setRevision(value => value + 1)}>Refresh</button>
    </div>
    {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
    {loading ? <p role="status">Loading token history…</p> : history && <>
      <div className="flex flex-wrap gap-6 rounded-xl bg-[var(--surface)] p-4 text-sm">
        <p>Prompt <strong className="block text-xl">{totals.prompt.toLocaleString()}</strong></p>
        <p>Completion <strong className="block text-xl">{totals.completion.toLocaleString()}</strong></p>
        <p>Total <strong className="block text-xl">{(totals.prompt + totals.completion).toLocaleString()}</strong></p>
      </div>
      <TokenChart data={history.data} groupBy={groupBy} />
      <p className="text-xs text-[var(--text-muted)]">Showing up to {history.months} months of retained history. First and current periods may be partial.</p>
    </>}
    <div className="rounded-xl border border-[var(--border)] p-4 text-sm">
      <label>Retain token history<select className={selectClass} value={retention} onChange={event => setRetention(Number(event.target.value))}>{[1, 3, 6, 12].map(value => <option key={value} value={value}>{value} month{value > 1 ? 's' : ''}</option>)}</select></label>
      <p className="my-2 text-xs text-[var(--text-muted)]">Applies globally. Saving deletes usage records older than this limit. Increasing it cannot restore deleted history.</p>
      <button type="button" disabled={saving || loading} onClick={saveRetention} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save retention'}</button>
    </div>
  </div>;
}

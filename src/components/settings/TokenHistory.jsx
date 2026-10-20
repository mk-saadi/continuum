import React, { useEffect, useState } from 'react';
import TokenChart from './TokenChart';
import { costCoverageLabel, formatSignedUsd, formatUsd } from '../../lib/costFormat.mjs';

const sumKnown = (left, right) => {
  const values = [left, right].filter(value => typeof value === 'number');
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
};
const coverageOf = (measured, turns) => !turns ? 'unavailable'
  : measured === turns ? 'measured' : measured > 0 ? 'partially_measured' : 'unavailable';
const knownLabel = (value, coverage) => coverage === 'measured' && typeof value === 'number'
  ? value.toLocaleString() : coverage === 'partially_measured' && typeof value === 'number'
    ? `≥ ${value.toLocaleString()}` : '—';

// Cost wording never implies precision the evidence does not have: a measured
// total is exact, a subtotal is "≥", an unknown price is "—", and a local model
// is "not applicable" rather than a $0.00 operating cost.
const costLabel = (value, coverage) => typeof value !== 'number' ? '—'
  : coverage === 'partially_measured' ? `≥ ${formatUsd(value)}` : formatUsd(value);

export default function TokenHistory({ section = 'all' }) {
  const [groupBy, setGroupBy] = useState('month');
  const [projectId, setProjectId] = useState('');
  const [modelId, setModelId] = useState('');
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
    window.api.getTokenHistory({ groupBy, projectId: projectId || null, modelId: modelId || null, months }).then(value => {
      if (!active) return;
      setHistory(value); setRetention(value.retentionMonths);
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [groupBy, projectId, modelId, months, revision]);
  const saveRetention = async () => {
    setSaving(true); setError('');
    try { await window.api.setTokenRetention(retention); setMonths(Math.min(months, retention)); setRevision(value => value + 1); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  const totals = (history?.data || []).reduce((sum, row) => ({
    prompt: sum.prompt + (row.promptTokens ?? 0),
    completion: sum.completion + (row.completionTokens ?? 0),
    turns: sum.turns + (row.turns ?? 0),
    cacheRead: sumKnown(sum.cacheRead, row.cacheReadTokens),
    cacheCreation: sumKnown(sum.cacheCreation, row.cacheCreationTokens),
    uncached: sumKnown(sum.uncached, row.uncachedInputTokens),
    reasoning: sumKnown(sum.reasoning, row.reasoningTokens),
    cacheReadMeasuredTurns: sum.cacheReadMeasuredTurns + (row.cacheReadMeasuredTurns ?? 0),
    cacheCreationMeasuredTurns: sum.cacheCreationMeasuredTurns + (row.cacheCreationMeasuredTurns ?? 0),
    uncachedMeasuredTurns: sum.uncachedMeasuredTurns + (row.uncachedMeasuredTurns ?? 0),
    reasoningMeasuredTurns: sum.reasoningMeasuredTurns + (row.reasoningMeasuredTurns ?? 0),
    costUncachedInput: sumKnown(sum.costUncachedInput, row.costUncachedInput),
    costCacheRead: sumKnown(sum.costCacheRead, row.costCacheRead),
    costCacheWrite: sumKnown(sum.costCacheWrite, row.costCacheWrite),
    costOutput: sumKnown(sum.costOutput, row.costOutput),
  }), { prompt: 0, completion: 0, turns: 0, cacheRead: null, cacheCreation: null, uncached: null,
    reasoning: null, cacheReadMeasuredTurns: 0, cacheCreationMeasuredTurns: 0, uncachedMeasuredTurns: 0,
    reasoningMeasuredTurns: 0, costUncachedInput: null, costCacheRead: null, costCacheWrite: null, costOutput: null });
  const cacheReadCoverage = coverageOf(totals.cacheReadMeasuredTurns, totals.turns);
  const cacheCreationCoverage = coverageOf(totals.cacheCreationMeasuredTurns, totals.turns);
  const uncachedCoverage = coverageOf(totals.uncachedMeasuredTurns, totals.turns);
  const reasoningCoverage = coverageOf(totals.reasoningMeasuredTurns, totals.turns);
  // Do not imply cached reads lower context occupancy: this ratio describes
  // provider billing/re-use only. It is withheld whenever any turn's cache
  // report is missing.
  const cacheRatio = cacheReadCoverage === 'measured' && totals.prompt > 0 && totals.cacheRead != null
    ? totals.cacheRead / totals.prompt * 100 : null;
  const costs = history?.costs ?? null;
  const showCosts = costs && (costs.billableTurns > 0 || costs.notApplicableTurns > 0);
  const modelCosts = (history?.models ?? []).filter(model => typeof model.costTotal === 'number' || (model.costMeasuredTurns ?? 0) > 0);
  const models = history?.models ?? [];
  const selectClass = 'mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--input)] p-2 text-[var(--text-primary)]';
  return <div className="space-y-5">
    {section !== 'retention' && <>
    <p className="text-sm text-[var(--text-muted)]">Reported token usage from new chat turns, including tool follow-ups. Missing server counts are not estimated. Totals remain after a chat is deleted.</p>
    <div className="flex flex-wrap gap-3 text-sm">
      <label className="min-w-36 flex-1">Project<select className={selectClass} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects & chats</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>Group by<select className={selectClass} value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="month">Month</option><option value="week">Week</option></select></label>
      <label>History window<select className={selectClass} value={months} onChange={event => setMonths(Number(event.target.value))}>{[1, 3, 6, 12].map(value => <option key={value} value={value}>{value} month{value > 1 ? 's' : ''}</option>)}</select></label>
      <button type="button" className="self-end rounded-lg border border-[var(--border)] p-2" onClick={() => setRevision(value => value + 1)}>Refresh</button>
      {models.length > 0 ? <label>Model<select className={selectClass} value={modelId} onChange={event => setModelId(event.target.value)}><option value="">All models</option>{models.map(model => <option key={`${model.provider ?? ''}:${model.modelId}`} value={model.modelId}>{model.modelId}{model.provider ? ` · ${model.provider}` : ''}</option>)}</select></label> : null}
    </div>
    {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
    {loading ? <p role="status">Loading token history…</p> : history && <>
      <div className="flex flex-wrap gap-x-6 gap-y-3 rounded-xl bg-[var(--surface)] p-4 text-sm">
        <p>Prompt (gross) <strong className="block text-xl">{totals.prompt.toLocaleString()}</strong></p>
        <p>Cached input <strong className="block text-xl">{knownLabel(totals.cacheRead, cacheReadCoverage)}</strong></p>
        <p>Uncached input <strong className="block text-xl">{knownLabel(totals.uncached, uncachedCoverage)}</strong></p>
        <p>Cache write <strong className="block text-xl">{knownLabel(totals.cacheCreation, cacheCreationCoverage)}</strong></p>
        <p>Completion <strong className="block text-xl">{totals.completion.toLocaleString()}</strong></p>
        {reasoningCoverage !== 'unavailable' ? <p>Reasoning <strong className="block text-xl">{knownLabel(totals.reasoning, reasoningCoverage)}</strong></p> : null}
        <p>Total <strong className="block text-xl">{(totals.prompt + totals.completion).toLocaleString()}</strong></p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-[var(--text-muted)]">
        <span>{cacheRatio == null
          ? 'Cache-hit ratio unavailable: cache reads were not reported for every turn.'
          : `Cache-hit ratio: ${cacheRatio.toFixed(1)}% of gross input.`}</span>
        <span>Cached reads may still occupy the context window; this ratio is not a context-occupancy measure.</span>
        {cacheReadCoverage === 'partially_measured' ? <span>Cache totals marked “≥” are known subtotals; unreported turns are excluded.</span> : null}
        {cacheReadCoverage === 'unavailable' && totals.turns > 0 ? <span>This history has no reported cache reads (legacy or non-cache provider). They are unknown, not zero.</span> : null}
      </div>
      {showCosts ? <section className="space-y-2 rounded-xl border border-[var(--border)] p-4 text-sm" aria-label="Estimated cloud cost">
        <h3 className="font-semibold">Estimated cloud cost ({costs.currency})</h3>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <p>Total <strong className="block text-xl">{costLabel(costs.total, costs.coverage)}</strong></p>
          <p>Cache savings <strong className="block text-xl">{costs.savings == null ? '—' : formatSignedUsd(costs.savings)}</strong></p>
          {costs.providerReported != null ? <p>Provider-reported <strong className="block text-xl">{formatUsd(costs.providerReported)}</strong></p> : null}
          <p>Uncached input <strong className="block text-base">{formatUsd(totals.costUncachedInput)}</strong></p>
          <p>Cache reads <strong className="block text-base">{formatUsd(totals.costCacheRead)}</strong></p>
          <p>Cache writes <strong className="block text-base">{formatUsd(totals.costCacheWrite)}</strong></p>
          <p>Output <strong className="block text-base">{formatUsd(totals.costOutput)}</strong></p>
        </div>
        <p className="text-xs text-[var(--text-muted)]">Cost coverage: {costCoverageLabel(costs.coverage)}{costs.coverage === 'partially_measured' ? ` — ${costs.measuredTurns} of ${costs.billableTurns} billable turns priced` : ''}.</p>
        {costs.notApplicableTurns > 0 ? <p className="text-xs text-[var(--text-muted)]">{costs.notApplicableTurns} turn{costs.notApplicableTurns === 1 ? '' : 's'} ran on a local model: cloud charges are not applicable, not $0.00.</p> : null}
        {costs.coverage === 'unavailable' && costs.billableTurns > 0 ? <p className="text-xs text-[var(--text-muted)]">No price evidence was available for these cloud turns; their cost is unknown, never zero.</p> : null}
        {modelCosts.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead><tr><th className="py-1 pr-4 font-medium">Model</th><th className="py-1 pr-4 font-medium">Provider</th><th className="py-1 pr-4 font-medium">Turns</th><th className="py-1 font-medium">Cost</th></tr></thead>
          <tbody>{modelCosts.map(model => <tr key={`${model.provider ?? ''}:${model.modelId}`}>
            <td className="py-1 pr-4">{model.modelId}</td>
            <td className="py-1 pr-4">{model.provider ?? '—'}</td>
            <td className="py-1 pr-4">{model.turns ?? 0}</td>
            <td className="py-1">{typeof model.costTotal === 'number' ? formatUsd(model.costTotal) : '—'}{(model.costMeasuredTurns ?? 0) < (model.turns ?? 0) ? ' (partial)' : ''}</td>
          </tr>)}</tbody>
        </table></div> : null}
      </section> : null}
      <TokenChart data={history.data} groupBy={groupBy} />
      <p className="text-xs text-[var(--text-muted)]">Showing up to {history.months} months of retained history. First and current periods may be partial.</p>
    </>}
    </>}
    {section === 'retention' && error && <p role="alert" className="text-[var(--error)]">{error}</p>}
    {section !== 'usage' && <div className="rounded-xl border border-[var(--border)] p-4 text-sm">
      <label>Retain token history<select className={selectClass} value={retention} onChange={event => setRetention(Number(event.target.value))}>{[1, 3, 6, 12].map(value => <option key={value} value={value}>{value} month{value > 1 ? 's' : ''}</option>)}</select></label>
      <p className="my-2 text-xs text-[var(--text-muted)]">Applies globally. Saving deletes usage records older than this period. Increasing it cannot restore deleted history.</p>
      <button type="button" disabled={saving || loading} onClick={saveRetention} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save retention'}</button>
    </div>}
  </div>;
}

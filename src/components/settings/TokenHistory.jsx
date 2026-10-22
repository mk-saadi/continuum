import React, { useEffect, useState } from 'react';
import TokenChart from './TokenChart';
import { SelectField } from '../FormControls';
import { costCoverageLabel, formatSignedUsd, formatUsd } from '../../lib/costFormat.mjs';
import {
  SettingsButton,
  SettingsCard,
  SettingsMessage,
} from './SettingsSection';

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

function Metric({ label, value, muted = false }) {
  return (
    <p className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5">
      <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <strong className={`mt-1 block text-sm font-semibold tabular-nums ${muted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
        {value}
      </strong>
    </p>
  );
}

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
  return <div className="space-y-3">
    {section !== 'retention' && <>
      <SettingsCard
        title="Token usage"
        description="Reported token usage from new chat turns, including tool follow-ups. Missing server counts are not estimated. Totals remain after a chat is deleted."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField label="Project" value={projectId} onChange={event => setProjectId(event.target.value)}>
            <option value="">All projects & chats</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </SelectField>
          <SelectField label="Group by" value={groupBy} onChange={event => setGroupBy(event.target.value)}>
            <option value="month">Month</option>
            <option value="week">Week</option>
          </SelectField>
          <SelectField label="History window" value={months} onChange={event => setMonths(Number(event.target.value))}>
            {[1, 3, 6, 12].map(value => <option key={value} value={value}>{value} month{value > 1 ? 's' : ''}</option>)}
          </SelectField>
          {models.length > 0 ? (
            <SelectField label="Model" value={modelId} onChange={event => setModelId(event.target.value)}>
              <option value="">All models</option>
              {models.map(model => <option key={`${model.provider ?? ''}:${model.modelId}`} value={model.modelId}>{model.modelId}{model.provider ? ` · ${model.provider}` : ''}</option>)}
            </SelectField>
          ) : null}
          <div className="flex items-end">
            <SettingsButton type="button" onClick={() => setRevision(value => value + 1)}>Refresh</SettingsButton>
          </div>
        </div>
        <SettingsMessage>{error}</SettingsMessage>
        {loading ? <p role="status" className="mt-2 text-[11px] text-[var(--text-muted)]">Loading token history…</p> : history && <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Prompt (gross)" value={totals.prompt.toLocaleString()} />
            <Metric label="Cached input" value={knownLabel(totals.cacheRead, cacheReadCoverage)} />
            <Metric label="Uncached input" value={knownLabel(totals.uncached, uncachedCoverage)} />
            <Metric label="Cache write" value={knownLabel(totals.cacheCreation, cacheCreationCoverage)} />
            <Metric label="Completion" value={totals.completion.toLocaleString()} />
            {reasoningCoverage !== 'unavailable' ? <Metric label="Reasoning" value={knownLabel(totals.reasoning, reasoningCoverage)} /> : null}
            <Metric label="Total" value={(totals.prompt + totals.completion).toLocaleString()} />
            <Metric label="Turns" value={totals.turns.toLocaleString()} />
          </div>
          <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            <p>{cacheRatio == null
              ? 'Cache-hit ratio unavailable: cache reads were not reported for every turn.'
              : `Cache-hit ratio: ${cacheRatio.toFixed(1)}% of gross input.`}</p>
            <p>Cached reads may still occupy the context window; this ratio is not a context-occupancy measure.</p>
            {cacheReadCoverage === 'partially_measured' ? <p>Cache totals marked “≥” are known subtotals; unreported turns are excluded.</p> : null}
            {cacheReadCoverage === 'unavailable' && totals.turns > 0 ? <p>This history has no reported cache reads (legacy or non-cache provider). They are unknown, not zero.</p> : null}
          </div>
          {showCosts ? <section className="mt-3 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3" aria-label="Estimated cloud cost">
            <h4 className="text-xs font-semibold">Estimated cloud cost ({costs.currency})</h4>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Total" value={costLabel(costs.total, costs.coverage)} />
              <Metric label="Cache savings" value={costs.savings == null ? '—' : formatSignedUsd(costs.savings)} />
              {costs.providerReported != null ? <Metric label="Provider-reported" value={formatUsd(costs.providerReported)} /> : null}
              <Metric label="Uncached input" value={formatUsd(totals.costUncachedInput)} muted />
              <Metric label="Cache reads" value={formatUsd(totals.costCacheRead)} muted />
              <Metric label="Cache writes" value={formatUsd(totals.costCacheWrite)} muted />
              <Metric label="Output" value={formatUsd(totals.costOutput)} muted />
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">Cost coverage: {costCoverageLabel(costs.coverage)}{costs.coverage === 'partially_measured' ? ` — ${costs.measuredTurns} of ${costs.billableTurns} billable turns priced` : ''}.</p>
            {costs.notApplicableTurns > 0 ? <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{costs.notApplicableTurns} turn{costs.notApplicableTurns === 1 ? '' : 's'} ran on a local model: cloud charges are not applicable, not $0.00.</p> : null}
            {costs.coverage === 'unavailable' && costs.billableTurns > 0 ? <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">No price evidence was available for these cloud turns; their cost is unknown, never zero.</p> : null}
            {modelCosts.length > 0 ? <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead><tr className="border-b border-[var(--border)] text-[var(--text-muted)]"><th className="py-1 pr-4 font-medium">Model</th><th className="py-1 pr-4 font-medium">Provider</th><th className="py-1 pr-4 font-medium">Turns</th><th className="py-1 font-medium">Cost</th></tr></thead>
                <tbody>{modelCosts.map(model => <tr key={`${model.provider ?? ''}:${model.modelId}`} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1 pr-4 break-all">{model.modelId}</td>
                  <td className="py-1 pr-4">{model.provider ?? '—'}</td>
                  <td className="py-1 pr-4 tabular-nums">{model.turns ?? 0}</td>
                  <td className="py-1 tabular-nums">{typeof model.costTotal === 'number' ? formatUsd(model.costTotal) : '—'}{(model.costMeasuredTurns ?? 0) < (model.turns ?? 0) ? ' (partial)' : ''}</td>
                </tr>)}</tbody>
              </table>
            </div> : null}
          </section> : null}
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">Showing up to {history.months} months of retained history. First and current periods may be partial.</p>
        </>}
      </SettingsCard>
      {history && !loading ? <TokenChart data={history.data} groupBy={groupBy} /> : null}
    </>}
    {section !== 'usage' && (
      <SettingsCard
        title="Token history retention"
        description="Applies globally. Saving deletes usage records older than this period. Increasing it cannot restore deleted history."
      >
        <SelectField className="max-w-xs" label="Retain token history" value={retention} onChange={event => setRetention(Number(event.target.value))}>
          {[1, 3, 6, 12].map(value => <option key={value} value={value}>{value} month{value > 1 ? 's' : ''}</option>)}
        </SelectField>
        <SettingsMessage>{error}</SettingsMessage>
        <div className="mt-3">
          <SettingsButton type="button" variant="primary" disabled={saving || loading} onClick={saveRetention}>
            {saving ? 'Saving…' : 'Save retention'}
          </SettingsButton>
        </div>
      </SettingsCard>
    )}
  </div>;
}

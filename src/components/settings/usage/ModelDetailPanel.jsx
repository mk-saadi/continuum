import React, { useEffect, useMemo, useState } from 'react';
import SpendingTimeline from './SpendingTimeline';
import { costValue, coverageLabel, savingsValue, sourceLabel, tokenValue } from './usageDashboardFormat.mjs';

function Metric({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="mt-0.5 text-[10px] text-[var(--text-muted)]">{hint}</dd> : null}
    </div>
  );
}

// Detail for one model inside one provider. Provider is part of the identity:
// the same model name routed through two providers is two separate rows.
export default function ModelDetailPanel({ model, filters, onClose }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);

  useEffect(() => {
    if (!model?.modelId) return undefined;
    let active = true;
    setLoading(true);
    setError('');
    window.api.getUsageModelDetail({
      ...filters,
      modelId: model.modelId,
      providerId: model.providerId,
      limit: 25,
    }).then(value => {
      if (active) setState(value);
    }).catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterKey, model?.key]);

  if (!model) return null;
  const local = model.providerFamily === 'local';
  const detail = state?.model ?? null;
  const row = detail ?? model;
  const pricing = state?.pricing ?? [];
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-model-detail-title" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="usage-model-detail-title" className="text-sm font-semibold">{model.modelId ?? 'Unknown model'}</h3>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{model.providerLabel} · {model.providerFamilyLabel}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface-hover)]">Close detail</button>
      </div>
      {error ? <p role="alert" className="mt-3 text-xs text-[var(--error)]">{error}</p> : null}
      {loading && !state ? <p role="status" className="mt-3 text-xs text-[var(--text-muted)]">Loading model detail…</p> : null}
      {!loading && !detail && !error ? (
        <p className="mt-3 rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--text-muted)]">
          This model has no rows under the current filters. Clear a filter to inspect it again.
        </p>
      ) : null}
      {detail ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Estimated spend" value={costValue(detail.estimatedSpend, detail.costCoverage, { local })} hint={`${coverageLabel(detail.costCoverage)} coverage`} />
            <Metric label="Provider-reported" value={costValue(detail.providerReportedSpend, detail.providerReportedCoverage, { local })} hint="Authoritative charges only" />
            <Metric label="Total priced" value={costValue(detail.combinedSpend, detail.costCoverage, { local })} hint="Mixed evidence, never fully verified" />
            <Metric label="Cache savings" value={savingsValue(detail.cacheSavings, detail.savingsCoverage, { local })} hint="Net of cache writes" />
            <Metric label="Input tokens" value={tokenValue(detail.inputTokens, detail.inputCoverage, { local })} />
            <Metric label="Cached input" value={tokenValue(detail.cachedInputTokens, detail.cacheReadCoverage, { local })} hint={detail.cacheHitRatio == null ? 'Coverage unavailable' : `${detail.cacheHitRatio.toFixed(1)}% cache read ratio`} />
            <Metric label="Cache writes" value={tokenValue(detail.cacheWriteTokens, detail.cacheWriteCoverage, { local })} />
            <Metric label="Output tokens" value={tokenValue(detail.outputTokens, detail.outputCoverage, { local })} />
            <Metric label="Turns" value={detail.turns ?? 0} hint={`${detail.billableTurns ?? 0} billable · ${detail.localTurns ?? 0} local`} />
            <Metric label="Unknown-cost turns" value={detail.unknownCostTurns ?? 0} hint={detail.unknownCostTurns ? 'Excluded from spend, not zero' : 'Every billable turn had price evidence'} />
            <Metric label="Reasoning tokens" value={tokenValue(detail.reasoningTokens, detail.reasoningCoverage, { local })} />
            <Metric label="Data completeness" value={coverageLabel(detail.dataCompleteness)} hint={`${detail.authoritativeTurns ?? 0} authoritative turns`} />
          </dl>
          <div className="mt-4">
            <SpendingTimeline data={state.timeline} groupBy={state.filters?.groupBy} title={`${model.modelId ?? 'Model'} spending over time`} />
          </div>
          <div className="mt-4">
            <h4 className="text-xs font-semibold">Rate snapshots recorded for this model</h4>
            {pricing.length === 0 ? (
              <p className="mt-2 rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--text-muted)]">
                No rate evidence recorded. Spend is unknown for this model, not $0.00.
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                      <th scope="col" className="py-1.5 pr-3 font-medium">Source</th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">Version</th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">Turns</th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">Recorded cost</th>
                      <th scope="col" className="py-1.5 font-medium">Last seen (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricing.map(rowItem => (
                      <tr key={rowItem.key} className="border-b border-[var(--border)]/60">
                        <td className="py-1.5 pr-3"><span className="capitalize">{sourceLabel(rowItem.source)}</span><span className="block text-[10px] text-[var(--text-muted)]">{rowItem.pricingKind}</span></td>
                        <td className="py-1.5 pr-3">{rowItem.version ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{rowItem.turns}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{costValue(rowItem.recordedCost, 'measured', { local })}</td>
                        <td className="py-1.5 text-[var(--text-secondary)]">{rowItem.lastSeen ? `${rowItem.lastSeen.slice(0, 16).replace('T', ' ')}Z` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="mt-3 text-[11px] text-[var(--text-muted)]">
            {local
              ? 'Local inference has no cloud charge: cost is not applicable, not $0.00. Token counts are shown for usage only.'
              : `Historical charges keep the rate that priced them. ${row.unknownCostTurns ? `${row.unknownCostTurns} billable turn${row.unknownCostTurns === 1 ? ' has' : 's have'} no price evidence and are excluded.` : 'No billable turn is missing price evidence.'} Effective date unavailable: the database records observation time, not a provider-announced effective date.`}
          </p>
        </>
      ) : null}
    </section>
  );
}

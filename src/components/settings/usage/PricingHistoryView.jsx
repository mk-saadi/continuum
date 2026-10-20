import React, { useEffect, useMemo, useState } from 'react';
import { costValue, rateValue, sourceLabel } from './usageDashboardFormat.mjs';

const PAGE_SIZE = 25;

function timestamp(value) {
  if (!value) return '—';
  return `${value.slice(0, 16).replace('T', ' ')}Z`;
}

function rateRow(label, value) {
  return (
    <tr key={label}>
      <th scope="row" className="py-1 pr-3 text-left font-normal text-[var(--text-muted)]">{label}</th>
      <td className="py-1 text-right tabular-nums">{rateValue(value)}</td>
    </tr>
  );
}

// Pricing history is a read-only view of the rate snapshots Phase 2.0C-3 stored
// on each priced row. A row is never re-priced with today's catalog: its source,
// version, rates, and the timestamps it was actually seen at are shown as
// recorded. "first seen"/"last seen" are observation times, not a provider's
// published effective date, so the UI says so.
export default function PricingHistoryView({ filters }) {
  const [state, setState] = useState({ rows: [], total: 0, hasMore: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);

  useEffect(() => {
    setPage(0);
    setExpanded(null);
  }, [filterKey]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    window.api.getPricingHistory({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then(value => {
      if (active) setState(value);
    }).catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterKey, page]);

  const rows = state.rows ?? [];
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-pricing-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="usage-pricing-title" className="text-sm font-semibold">Pricing history</h3>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            Rate snapshots recorded with each turn. Historical charges keep the rate that priced them.
          </p>
        </div>
        <span className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[10px] text-[var(--text-muted)]">Read-only evidence</span>
      </div>
      {error ? <p role="alert" className="mt-3 text-xs text-[var(--error)]">{error}</p> : null}
      {loading && !rows.length ? <p role="status" className="mt-3 text-xs text-[var(--text-muted)]">Loading pricing history…</p> : null}
      {!loading && !rows.length && !error ? (
        <p className="mt-4 rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
          No pricing evidence has been recorded for this selection. That is unknown, not a zero rate.
        </p>
      ) : null}
      {rows.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th scope="col" className="py-2 pr-3 font-medium">Provider</th>
                <th scope="col" className="py-2 pr-3 font-medium">Model</th>
                <th scope="col" className="py-2 pr-3 font-medium">Source</th>
                <th scope="col" className="py-2 pr-3 font-medium">Version</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Input / Mtok</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Output / Mtok</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Cache read</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Cache write</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Turns</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Recorded cost</th>
                <th scope="col" className="py-2 font-medium">First / last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const local = row.providerFamily === 'local';
                const open = expanded === row.key;
                return (
                  <React.Fragment key={row.key}>
                    <tr className="border-b border-[var(--border)]/60 align-top">
                      <td className="py-2 pr-3">
                        <span className="block font-medium">{row.providerLabel}</span>
                        <span className="text-[10px] text-[var(--text-muted)]">{row.providerFamilyLabel}</span>
                      </td>
                      <td className="max-w-48 truncate py-2 pr-3" title={row.modelLabel}>{row.modelLabel}</td>
                      <td className="py-2 pr-3">
                        <button type="button" className="text-left capitalize hover:underline" onClick={() => setExpanded(open ? null : row.key)} aria-expanded={open}>
                          {sourceLabel(row.source)}
                        </button>
                        <span className="block text-[10px] text-[var(--text-muted)]">{row.pricingKind}</span>
                      </td>
                      <td className="py-2 pr-3 text-[var(--text-secondary)]">{row.version ?? '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{rateValue(row.rates?.input)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{rateValue(row.rates?.output)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{rateValue(row.rates?.cacheRead)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {rateValue(row.rates?.cacheWrite)}
                        {row.rates?.cacheWrite1h != null ? <span className="block text-[10px] text-[var(--text-muted)]">1h {rateValue(row.rates.cacheWrite1h)}</span> : null}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.turns}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.recordedCost, 'measured', { local })}</td>
                      <td className="py-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
                        <span className="block">First {timestamp(row.firstSeen)}</span>
                        <span className="block">Last {timestamp(row.lastSeen)}</span>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="border-b border-[var(--border)]/60 bg-[var(--surface-raised)]">
                        <td colSpan={11} className="px-3 py-3 text-[11px] text-[var(--text-secondary)]">
                          <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
                            <table className="w-full text-[11px]">
                              <caption className="mb-1 text-left font-medium text-[var(--text-primary)]">USD per million tokens</caption>
                              <tbody>
                                {rateRow('Input', row.rates?.input)}
                                {rateRow('Output', row.rates?.output)}
                                {rateRow('Cache read', row.rates?.cacheRead)}
                                {rateRow('Cache write', row.rates?.cacheWrite)}
                                {rateRow('Cache write 1h', row.rates?.cacheWrite1h)}
                              </tbody>
                            </table>
                            <div>
                              <p>
                                {row.source === 'provider-reported'
                                  ? 'These charges came back from the provider. The provider amount remains authoritative even when a catalog rate also exists.'
                                  : 'This is a rate snapshot captured when the turn was priced. Changing today\'s catalog does not rewrite this row.'}
                              </p>
                              {row.missing?.length ? <p className="mt-1 text-[var(--warning,#b45309)]">Not priced: {row.missing.join(', ')}.</p> : null}
                              <p className="mt-1 text-[var(--text-muted)]">
                                Effective date unavailable: the database records observation time, not a provider-announced effective date.
                                {local ? ' Local inference has no cloud rate: not applicable.' : ''}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
        <span>Showing {rows.length === 0 ? 0 : state.offset + 1}–{(state.offset ?? 0) + rows.length} of {state.total ?? 0} rate snapshots.</span>
        <span className="flex gap-2">
          <button type="button" disabled={page === 0 || loading} onClick={() => setPage(value => Math.max(0, value - 1))} className="rounded-lg border border-[var(--border)] px-2.5 py-1 disabled:opacity-40">Previous</button>
          <button type="button" disabled={!state.hasMore || loading} onClick={() => setPage(value => value + 1)} className="rounded-lg border border-[var(--border)] px-2.5 py-1 disabled:opacity-40">Next</button>
        </span>
      </div>
    </section>
  );
}

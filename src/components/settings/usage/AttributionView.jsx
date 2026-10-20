import React, { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '../../../lib/costFormat.mjs';
import {
  costValue,
  coverageLabel,
  sourceLabel,
  tokenValue,
} from './usageDashboardFormat.mjs';

const GROUPS = [
  { id: 'chat', label: 'Conversation' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'agent', label: 'Main agent / subagent' },
  { id: 'provider', label: 'Provider' },
  { id: 'model', label: 'Model' },
];

const PAGE_SIZE = 25;

function recordCost(row) {
  if (row.providerFamily === 'local') return 'Not applicable';
  if (typeof row.cost_total !== 'number') return '—';
  return `${formatUsd(row.cost_total)}${row.cost_completeness === 'partial' ? ' (partial)' : ''}`;
}

export default function AttributionView({ filters }) {
  const [groupBy, setGroupBy] = useState('chat');
  const [attribution, setAttribution] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [records, setRecords] = useState(null);
  const [recordsError, setRecordsError] = useState('');
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [page, setPage] = useState(0);
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    window.api.getSpendingAttribution({ ...filters, groupBy }).then(value => {
      if (active) setAttribution(value);
    }).catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterKey, groupBy]);

  useEffect(() => {
    setPage(0);
  }, [filterKey, groupBy]);

  useEffect(() => {
    if (!recordsOpen) return undefined;
    let active = true;
    setRecordsLoading(true);
    setRecordsError('');
    window.api.getSpendingRecords({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then(value => {
      if (active) setRecords(value);
    }).catch(cause => { if (active) setRecordsError(cause.message); })
      .finally(() => { if (active) setRecordsLoading(false); });
    return () => { active = false; };
  }, [filterKey, recordsOpen, page]);

  const rows = attribution?.rows ?? [];
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-attribution-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="usage-attribution-title" className="text-sm font-semibold">Where usage originated</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Sub-agent cost is attributed to its parent conversation and counted once.</p>
          </div>
          <label className="text-xs text-[var(--text-secondary)]">
            Group by
            <select value={groupBy} onChange={event => setGroupBy(event.target.value)} className="ml-2 rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs text-[var(--text-primary)]">
              {GROUPS.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select>
          </label>
        </div>
        {error ? <p role="alert" className="mt-3 text-xs text-[var(--error)]">{error}</p> : null}
        {loading ? <p role="status" className="mt-3 text-xs text-[var(--text-muted)]">Loading attribution…</p> : rows.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">No usage to attribute for this selection.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Turns</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Tokens</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Estimated</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Reported</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Total priced</th>
                  <th scope="col" className="py-2 font-medium">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const local = row.providerFamily === 'local';
                  return (
                    <tr key={row.key} className="border-b border-[var(--border)]/60">
                      <td className="max-w-64 truncate py-2 pr-3" title={row.label}>{row.label}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.turns ?? 0}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{tokenValue(row.totalTokens, row.totalTokensCoverage, { local })}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.estimatedSpend, row.costCoverage, { local })}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.providerReportedSpend, row.providerReportedCoverage, { local })}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.combinedSpend, row.costCoverage, { local })}</td>
                      <td className="py-2">{coverageLabel(row.costCoverage)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">
          Missing or unknowable ownership is grouped as “Unattributed”. Deleted or renamed chats and workspaces keep their recorded IDs in the label; no relationship is guessed.
        </p>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-records-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="usage-records-title" className="text-sm font-semibold">Detailed usage records</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">One row per parent turn or completed sub-agent run. Message content is never loaded.</p>
          </div>
          <button type="button" className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)]" onClick={() => setRecordsOpen(open => !open)} aria-expanded={recordsOpen}>
            {recordsOpen ? 'Hide records' : 'Show records'}
          </button>
        </div>
        {recordsOpen ? <div className="mt-3">
          {recordsError ? <p role="alert" className="text-xs text-[var(--error)]">{recordsError}</p> : null}
          {recordsLoading && !records ? <p role="status" className="text-xs text-[var(--text-muted)]">Loading records…</p> : null}
          {records ? <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                    <th scope="col" className="py-2 pr-3 font-medium">Time (UTC)</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Kind</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Conversation</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Workspace</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Provider</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Model</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Tokens</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Cost</th>
                    <th scope="col" className="py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {records.rows.map((row, index) => (
                    <tr key={`${row.kind}:${row.occurred_at}:${index}`} className="border-b border-[var(--border)]/60">
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{row.occurred_at ? `${row.occurred_at.slice(0, 16).replace('T', ' ')}Z` : '—'}</td>
                      <td className="py-2 pr-3">{row.kind === 'subagent' ? 'Subagent' : 'Turn'}</td>
                      <td className="max-w-40 truncate py-2 pr-3" title={row.chatLabel}>{row.chatLabel}</td>
                      <td className="max-w-40 truncate py-2 pr-3" title={row.workspaceLabel}>{row.workspaceLabel}</td>
                      <td className="py-2 pr-3">{row.providerLabel}</td>
                      <td className="max-w-40 truncate py-2 pr-3" title={row.modelLabel}>{row.modelLabel}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{typeof row.total_tokens === 'number' ? row.total_tokens.toLocaleString() : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{recordCost(row)}</td>
                      <td className="py-2">{sourceLabel(row.cost_source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
              <span>Showing {records.rows.length === 0 ? 0 : records.offset + 1}–{records.offset + records.rows.length} of {records.total}.</span>
              <span className="flex gap-2">
                <button type="button" disabled={page === 0 || recordsLoading} onClick={() => setPage(value => Math.max(0, value - 1))} className="rounded-lg border border-[var(--border)] px-2.5 py-1 disabled:opacity-40">Previous</button>
                <button type="button" disabled={!records.hasMore || recordsLoading} onClick={() => setPage(value => value + 1)} className="rounded-lg border border-[var(--border)] px-2.5 py-1 disabled:opacity-40">Next</button>
              </span>
            </div>
          </> : null}
        </div> : null}
      </section>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import AttributionView from './AttributionView';
import ModelDetailPanel from './ModelDetailPanel';
import ModelSpendingTable from './ModelSpendingTable';
import PricingHistoryView from './PricingHistoryView';
import ProviderBreakdownTable from './ProviderBreakdownTable';
import SpendingTimeline from './SpendingTimeline';
import {
  costValue,
  coverageLabel,
  savingsValue,
  tokenValue,
} from './usageDashboardFormat.mjs';

const RANGES = [
  { id: '7d', label: 'Last 7 days', group: 'day' },
  { id: '30d', label: 'Last 30 days', group: 'day' },
  { id: '90d', label: 'Last 90 days', group: 'week' },
  { id: 'all', label: 'All recorded usage', group: 'month' },
  { id: 'custom', label: 'Custom range', group: 'day' },
];

const GROUPS = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly (Monday start)' },
  { id: 'month', label: 'Monthly' },
];

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'models', label: 'Models' },
  { id: 'providers', label: 'Providers' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'pricing', label: 'Pricing history' },
];

function MetricCard({ label, value, hint, warning = false, local = false }) {
  return (
    <div className={`rounded-xl border p-3 ${warning ? 'border-[var(--warning,#b45309)]/50' : 'border-[var(--border)]'} bg-[var(--surface)]`}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${local ? 'text-[var(--text-muted)]' : ''}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">{hint}</p> : null}
    </div>
  );
}

function AnalyticsRow({ label, value, hint }) {
  return (
    <tr className="border-b border-[var(--border)]/60">
      <th scope="row" className="py-1.5 pr-3 text-left font-medium">{label}</th>
      <td className="py-1.5 pr-3 text-right tabular-nums">{value}</td>
      <td className="py-1.5 text-[10px] text-[var(--text-muted)]">{hint}</td>
    </tr>
  );
}

function TokenAnalytics({ summary, local }) {
  const tokens = [
    ['Input tokens', summary.inputTokens, summary.inputCoverage, 'Prompt tokens including cached input'],
    ['Uncached input', summary.uncachedInputTokens, summary.uncachedInputCoverage, 'Input billed at the full input rate'],
    ['Cached input (read)', summary.cachedInputTokens, summary.cacheReadCoverage, 'Cache reads, usually billed at a discount'],
    ['Cache writes', summary.cacheWriteTokens, summary.cacheWriteCoverage, 'Tokens written into the prompt cache'],
    ['Output tokens', summary.outputTokens, summary.outputCoverage, 'Completion tokens recorded by the provider'],
    ['Reasoning tokens', summary.reasoningTokens, summary.reasoningCoverage, 'Shown only where the provider reports them'],
    ['Total tokens', summary.totalTokens, summary.totalTokensCoverage, 'Input + output; cache reads are already inside input'],
  ];
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-token-title">
      <h3 id="usage-token-title" className="text-sm font-semibold">Token &amp; cache analytics</h3>
      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
        Cloud tokens only. Partial coverage is prefixed with “≥”; unavailable evidence is “—”, never zero.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[460px] text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
              <th scope="col" className="py-2 pr-3 font-medium">Measure</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Value</th>
              <th scope="col" className="py-2 font-medium">Coverage / meaning</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map(([label, value, coverage, hint]) => (
              <AnalyticsRow
                key={label}
                label={label}
                value={tokenValue(value, coverage, { local })}
                hint={coverage === 'measured' ? hint : coverageLabel(coverage)}
              />
            ))}
            <AnalyticsRow
              label="Cache read ratio"
              value={summary.cacheHitRatio == null ? '—' : `${summary.cacheHitRatio.toFixed(1)}%`}
              hint={summary.cacheReadCoverage === 'measured' ? 'Cached input ÷ input tokens' : `Cache-read coverage: ${coverageLabel(summary.cacheReadCoverage)}`}
            />
            <AnalyticsRow
              label="Net cache savings"
              value={savingsValue(summary.cacheSavings, summary.savingsCoverage, { local })}
              hint={`Cache write cost ${costValue(summary.cacheWriteCost, summary.savingsCoverage, { local })} · ${coverageLabel(summary.savingsCoverage)} savings coverage`}
            />
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-[var(--text-muted)]">
        {local
          ? 'These are local inference tokens. There is no cloud charge, so cost is not applicable.'
          : `${summary.billableTurns ?? 0} billable turn${summary.billableTurns === 1 ? '' : 's'} and ${summary.localTurns ?? 0} local turn${summary.localTurns === 1 ? '' : 's'}. Local turns are excluded from cloud spend.`}
      </p>
    </section>
  );
}

function Overview({ dashboard, onSelectModel }) {
  const summary = dashboard.summary;
  const localOnly = summary.billableTurns === 0 && summary.turns > 0;
  const topModels = dashboard.models.slice(0, 5);
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total priced spend"
          value={costValue(summary.combinedSpend, summary.costCoverage, { local: localOnly })}
          hint="Estimated rates plus authoritative provider charges. Mixed evidence."
        />
        <MetricCard
          label="Rate-based estimate"
          value={costValue(summary.estimatedSpend, summary.estimatedCoverage, { local: localOnly })}
          hint={`${summary.estimatedTurns ?? 0} turn${summary.estimatedTurns === 1 ? '' : 's'} priced from a catalog or configured rate`}
        />
        <MetricCard
          label="Provider-reported"
          value={costValue(summary.providerReportedSpend, summary.providerReportedCoverage, { local: localOnly })}
          hint={`${summary.authoritativeTurns ?? 0} authoritative turn${summary.authoritativeTurns === 1 ? '' : 's'} · ${coverageLabel(summary.providerReportedCoverage)} coverage`}
        />
        <MetricCard
          label="Cloud tokens"
          value={tokenValue(summary.totalTokens, summary.totalTokensCoverage, { local: localOnly })}
          hint={`Input ${tokenValue(summary.inputTokens, summary.inputCoverage, { local: localOnly })} · output ${tokenValue(summary.outputTokens, summary.outputCoverage, { local: localOnly })}`}
        />
        <MetricCard
          label="Billable turns"
          value={(summary.billableTurns ?? 0).toLocaleString()}
          hint={`${summary.localTurns ?? 0} local turn${summary.localTurns === 1 ? '' : 's'} · ${summary.turns ?? 0} total`}
        />
        <MetricCard
          label="Net cache savings"
          value={savingsValue(summary.cacheSavings, summary.savingsCoverage, { local: localOnly })}
          hint="Savings are net of cache write cost; coverage is stated, never assumed."
        />
        <MetricCard
          label="Unknown-cost turns"
          value={(summary.unknownCostTurns ?? 0).toLocaleString()}
          warning={(summary.unknownCostTurns ?? 0) > 0}
          hint={summary.unknownCostTurns ? 'Excluded from spend. Unknown is not zero.' : 'Every billable turn has price evidence.'}
        />
        <MetricCard
          label="Data completeness"
          value={coverageLabel(summary.dataCompleteness)}
          hint={`${summary.modelsUsed ?? 0} provider/model combination${summary.modelsUsed === 1 ? '' : 's'}`}
        />
      </div>
      <SpendingTimeline data={dashboard.timeline} groupBy={dashboard.range.groupBy} />
      <TokenAnalytics summary={summary} local={localOnly} />
      {topModels.length ? (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-top-models-title">
          <h3 id="usage-top-models-title" className="text-sm font-semibold">Top models by priced spend</h3>
          <ul className="mt-2 divide-y divide-[var(--border)]/60">
            {topModels.map(row => {
              const local = row.providerFamily === 'local';
              return (
                <li key={row.key}>
                  <button type="button" onClick={() => onSelectModel(row)} className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left text-xs hover:text-[var(--accent)]">
                    <span className="font-medium">{row.modelId ?? 'Unknown model'}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">{row.providerLabel}</span>
                    <span className="ml-auto tabular-nums">{costValue(row.combinedSpend, row.costCoverage, { local })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function UsageCostsDashboard() {
  const [range, setRange] = useState('30d');
  const [groupBy, setGroupBy] = useState('day');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedModel, setSelectedModel] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const filters = useMemo(() => {
    const value = { range, groupBy };
    if (providerId) value.providerId = providerId;
    if (modelId) value.modelId = modelId;
    if (projectId) value.projectId = projectId;
    if (range === 'custom') {
      if (from) value.from = from;
      if (to) value.to = to;
    }
    return value;
  }, [range, groupBy, providerId, modelId, projectId, from, to]);
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);

  useEffect(() => {
    let active = true;
    if (!window.api?.getSpendingDashboard) {
      setError('Open the desktop app to view spending.');
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError('');
    window.api.getSpendingDashboard(filters).then(value => {
      if (active) setDashboard(value);
    }).catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterKey, refreshToken]);

  useEffect(() => {
    setSelectedModel(null);
  }, [filterKey]);

  const options = dashboard?.filterOptions ?? { providers: [], models: [], projects: [] };
  const changeRange = value => {
    setRange(value);
    setGroupBy(RANGES.find(item => item.id === value)?.group ?? 'day');
  };
  const resetFilters = () => {
    setRange('30d');
    setGroupBy('day');
    setProviderId('');
    setModelId('');
    setProjectId('');
    setFrom('');
    setTo('');
  };
  const selectProvider = value => {
    setProviderId(value);
    setTab('models');
  };
  const openModel = row => {
    setSelectedModel(row);
    setTab('models');
  };
  const hasFilters = Boolean(providerId || modelId || projectId || range !== '30d');

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-labelledby="usage-filters-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="usage-filters-title" className="text-sm font-semibold">Cloud spending &amp; usage</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              Read-only aggregation of recorded cost evidence. All timestamps and buckets are UTC.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setRefreshToken(value => value + 1)} disabled={loading} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-40">
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" onClick={resetFilters} disabled={!hasFilters} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-40">
              Reset filters
            </button>
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <label className="text-xs text-[var(--text-secondary)]">
            Date range
            <select value={range} onChange={event => changeRange(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]">
              {RANGES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Timeline grouping
            <select value={groupBy} onChange={event => setGroupBy(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]">
              {GROUPS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Provider
            <select value={providerId} onChange={event => setProviderId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]">
              <option value="">All providers</option>
              {options.providers.map(option => <option key={option.providerId} value={option.providerId}>{option.label} · {option.familyLabel}</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Model
            <select value={modelId} onChange={event => setModelId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]">
              <option value="">All models</option>
              {options.models.map(option => <option key={`${option.providerId}:${option.modelId}`} value={option.modelId}>{option.label} · {option.providerLabel}</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Workspace
            <select value={projectId} onChange={event => setProjectId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]">
              <option value="">All workspaces</option>
              {options.projects.map(option => <option key={option.projectId} value={option.projectId}>{option.name}</option>)}
            </select>
          </label>
          {range === 'custom' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-[var(--text-secondary)]">
                From (UTC)
                <input type="date" value={from} onChange={event => setFrom(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]" />
              </label>
              <label className="text-xs text-[var(--text-secondary)]">
                To (UTC)
                <input type="date" value={to} onChange={event => setTo(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)]" />
              </label>
            </div>
          ) : null}
        </div>
        {error ? <p role="alert" className="mt-3 rounded-lg border border-[var(--error)]/40 bg-[var(--surface-raised)] p-3 text-xs text-[var(--error)]">{error}</p> : null}
      </section>

      <div role="tablist" aria-label="Spending dashboard sections" className="flex flex-wrap gap-1 border-b border-[var(--border)]">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`usage-costs-tab-${item.id}`}
            aria-controls={`usage-costs-panel-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={event => {
              const index = TABS.findIndex(entry => entry.id === tab);
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index + TABS.length - 1) % TABS.length;
              setTab(TABS[next].id);
              document.getElementById(`usage-costs-tab-${TABS[next].id}`)?.focus();
            }}
            className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium ${tab === item.id ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {dashboard ? (
        <>
          <section id="usage-costs-panel-overview" role="tabpanel" aria-labelledby="usage-costs-tab-overview" hidden={tab !== 'overview'} tabIndex={0}>
            <Overview dashboard={dashboard} onSelectModel={openModel} />
          </section>
          <section id="usage-costs-panel-models" role="tabpanel" aria-labelledby="usage-costs-tab-models" hidden={tab !== 'models'} tabIndex={0} className="space-y-4">
            <ModelSpendingTable models={dashboard.models} selectedKey={selectedModel?.key ?? null} onSelect={setSelectedModel} />
            {selectedModel ? <ModelDetailPanel model={selectedModel} filters={filters} onClose={() => setSelectedModel(null)} /> : (
              <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-xs text-[var(--text-muted)]">
                Select a model row to inspect its timeline, token mix, coverage, and recorded rate snapshots.
              </p>
            )}
          </section>
          <section id="usage-costs-panel-providers" role="tabpanel" aria-labelledby="usage-costs-tab-providers" hidden={tab !== 'providers'} tabIndex={0}>
            <ProviderBreakdownTable providers={dashboard.providers} onSelectProvider={selectProvider} />
          </section>
          <section id="usage-costs-panel-conversations" role="tabpanel" aria-labelledby="usage-costs-tab-conversations" hidden={tab !== 'conversations'} tabIndex={0}>
            {tab === 'conversations' ? <AttributionView filters={filters} /> : null}
          </section>
          <section id="usage-costs-panel-pricing" role="tabpanel" aria-labelledby="usage-costs-tab-pricing" hidden={tab !== 'pricing'} tabIndex={0}>
            {tab === 'pricing' ? <PricingHistoryView filters={filters} /> : null}
          </section>
        </>
      ) : loading ? (
        <p role="status" className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">Loading spending dashboard…</p>
      ) : null}
      {loading && dashboard ? <p role="status" className="text-[11px] text-[var(--text-muted)]">Updating dashboard…</p> : null}
      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Costs are aggregations of the evidence stored with each turn. Historical rows are never re-priced with the newest catalog.
        “—” means unavailable, and local inference is “Not applicable”, never $0.00.
      </p>
    </div>
  );
}

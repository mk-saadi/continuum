import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatSignedUsd, formatUsd } from '../../../lib/costFormat.mjs';
import { axisCost, periodLabel, shortPeriodLabel } from './usageDashboardFormat.mjs';

function TimelineTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const turnText = row.turns === 1 ? '1 turn' : `${row.turns ?? 0} turns`;
  return (
    <div className="max-w-64 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-2.5 text-xs text-[var(--text-primary)] shadow-lg">
      <p className="font-semibold">{row.period}</p>
      <p className="mt-1 text-[var(--text-muted)]">{turnText} · {row.billableTurns ?? 0} billable</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt>Estimated</dt><dd className="text-right tabular-nums">{formatUsd(row.estimatedCost)}</dd>
        <dt>Provider-reported</dt><dd className="text-right tabular-nums">{formatUsd(row.providerReported)}</dd>
        <dt className="font-medium">Total priced</dt><dd className="text-right font-medium tabular-nums">{formatUsd(row.totalCost)}</dd>
        <dt>Input tokens</dt><dd className="text-right tabular-nums">{(row.inputTokens ?? 0).toLocaleString()}</dd>
        <dt>Cached input</dt><dd className="text-right tabular-nums">{typeof row.cachedInputTokens === 'number' ? row.cachedInputTokens.toLocaleString() : '—'}</dd>
        <dt>Output tokens</dt><dd className="text-right tabular-nums">{(row.outputTokens ?? 0).toLocaleString()}</dd>
        <dt>Net cache savings</dt><dd className="text-right tabular-nums">{typeof row.cacheSavings === 'number' ? formatSignedUsd(row.cacheSavings) : '—'}</dd>
      </dl>
      {row.unknownCostTurns > 0 ? <p className="mt-2 text-[var(--warning,#b45309)]">{row.unknownCostTurns} billable turn{row.unknownCostTurns === 1 ? '' : 's'} could not be priced.</p> : null}
    </div>
  );
}

// Spending timeline. Values are already aggregated by SQLite; the chart only
// splits rate-based estimates from authoritative provider charges so the two
// evidence classes are never visually merged into one verified total.
export default function SpendingTimeline({ data = [], groupBy = 'day', title = 'Spending over time' }) {
  const chartData = data.map(row => ({
    ...row,
    estimatedCost: typeof row.estimatedCost === 'number' ? row.estimatedCost : 0,
    providerReported: typeof row.providerReported === 'number' ? row.providerReported : 0,
  }));
  const hasActivity = chartData.some(row => row.turns > 0);
  const hasPriced = chartData.some(row => row.estimatedCost > 0 || row.providerReported > 0);
  if (!chartData.length || !hasActivity) {
    return (
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
        <h3 className="text-xs font-semibold">{title}</h3>
        <p className="mt-3 rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-[11px] text-[var(--text-muted)]">
          No cloud usage recorded for this period.
        </p>
      </section>
    );
  }
  return (
    <figure className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]" aria-label={`${title}, grouped by ${groupBy} in UTC`}>
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold">{title}</h3>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">USD · UTC · {groupBy === 'week' ? 'weeks start Monday' : groupBy === 'month' ? 'monthly buckets' : 'daily buckets'}</p>
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-secondary)]">
          <span><span className="mr-1 inline-block size-2.5 rounded-sm bg-[#5b9bff]" />Rate-based estimate</span>
          <span><span className="mr-1 inline-block size-2.5 rounded-sm bg-[#34b27b]" />Provider-reported</span>
        </div>
      </figcaption>
      <div className="h-56 w-full" role="img" aria-label={`Spending chart. ${hasPriced ? 'Priced spend is shown.' : 'No turn in this period has price evidence.'}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="period"
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={shortPeriodLabel}
              interval="preserveStartEnd"
              minTickGap={16}
              axisLine={{ stroke: 'var(--border)' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={axisCost}
              width={58}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<TimelineTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
            <Legend wrapperStyle={{ display: 'none' }} />
            <Bar dataKey="estimatedCost" name="Estimated" stackId="spend" fill="#5b9bff" isAnimationActive={false} radius={[2, 2, 0, 0]} />
            <Bar dataKey="providerReported" name="Provider-reported" stackId="spend" fill="#34b27b" isAnimationActive={false} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {!hasPriced ? <p className="mt-2 text-[11px] text-[var(--text-muted)]">This period has usage but no price evidence. Its cost is unknown, not zero.</p> : null}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th>Period</th><th>Estimated</th><th>Provider-reported</th><th>Total tokens</th></tr></thead>
        <tbody>
          {chartData.map(row => (
            <tr key={row.period}>
              <th scope="row">{periodLabel(row.period, groupBy)}</th>
              <td>{formatUsd(row.estimatedCost)}</td>
              <td>{formatUsd(row.providerReported)}</td>
              <td>{(row.totalTokens ?? 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

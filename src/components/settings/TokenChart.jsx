import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatUsd } from '../../lib/costFormat.mjs';

const number = value => Number(value ?? 0).toLocaleString();
// A period's cost is shown only when at least one turn was priced. A local-only
// period has no cloud charge at all and says so rather than "$0.00".
const periodCost = row => typeof row.costTotal === 'number' ? formatUsd(row.costTotal)
  : row.costCoverage === 'not_applicable' ? 'n/a' : null;
const known = (value, coverage) => coverage === 'measured' && typeof value === 'number'
  ? number(value) : coverage === 'partially_measured' && typeof value === 'number' ? `≥ ${number(value)}` : 'not reported';
// Only a complete, measured pair may produce a ratio; a partial subtotal would
// overstate re-use and a legacy row would look like a measured zero.
const hitRatio = row => row.cacheReadCoverage === 'measured' && row.cacheReadTokens != null
  && row.uncachedInputTokens != null && row.promptTokens > 0
  ? row.cacheReadTokens / row.promptTokens * 100 : null;

function TokenTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const ratio = hitRatio(row);
  const cost = periodCost(row);
  return (
    <div role="tooltip" className="material-inset sk-well max-w-64 p-2.5 text-xs text-[var(--text-primary)]">
      <p>{row.label}</p>
      <p>Gross input: {number(row.promptTokens)}</p>
      <p>Cached input: {known(row.cacheReadTokens, row.cacheReadCoverage)}</p>
      <p>Uncached input: {known(row.uncachedInputTokens, row.uncachedInputCoverage)}</p>
      {row.cacheCreationTokens != null ? <p>Cache write: {number(row.cacheCreationTokens)}</p> : null}
      <p>Completion: {number(row.completionTokens)}</p>
      {row.reasoningTokens != null ? <p>Reasoning: {number(row.reasoningTokens)}</p> : null}
      <p>Total: {number(row.promptTokens + row.completionTokens)}</p>
      {ratio != null ? <p>Cache hit: {ratio.toFixed(1)}% of gross input</p> : null}
      {cost != null ? <p>Est. cloud cost: {cost}</p> : null}
    </div>
  );
}

export default function TokenChart({ data = [], groupBy = 'month' }) {
  const maximum = Math.max(1, ...data.map(row => row.promptTokens + row.completionTokens));
  if (!data.some(row => row.turns || row.promptTokens || row.completionTokens)) {
    return <p className="material-panel sk-panel p-8 text-center text-[11px] text-[var(--text-muted)]">No token usage recorded for this period.</p>;
  }
  const chartData = data.map(row => {
    // Split only when this bucket's cache read is fully measured; a
    // legacy/partial bucket keeps the whole gross prompt in blue.
    const split = row.cacheReadCoverage === 'measured' && row.cacheReadTokens != null
      && row.uncachedInputCoverage === 'measured' && row.uncachedInputTokens != null;
    return {
      ...row,
      label: groupBy === 'month' ? row.period.slice(0, 7) : row.period,
      cachedInput: split ? row.cacheReadTokens : 0,
      uncachedInput: split ? row.uncachedInputTokens : row.promptTokens,
      cacheWrite: row.cacheCreationCoverage === 'measured' && typeof row.cacheCreationTokens === 'number' ? row.cacheCreationTokens : 0,
    };
  });
  return <figure
    aria-label="Token consumption history"
    className="material-panel sk-panel p-3"
  >
    <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-xs font-semibold">Token usage over time</h3>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">Tokens · UTC · {groupBy === 'week' ? 'weeks start Monday' : 'monthly buckets'}</p>
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-secondary)]">
        <span><span className="mr-1 inline-block size-2.5 ui-radius-small bg-[#5b9bff]" />Input tokens (gross)</span>
        <span><span className="mr-1 inline-block size-2.5 ui-radius-small bg-[#818cf8]" />Cached input</span>
        <span><span className="mr-1 inline-block size-2.5 ui-radius-small bg-[#34b27b]" />Cache write</span>
        <span><span className="mr-1 inline-block size-2.5 ui-radius-small bg-[#f59e0b]" />Completion tokens</span>
      </div>
    </figcaption>
    <div className="material-flat sk-list h-56 w-full p-2" role="img" aria-label={`Token usage chart. Scale: ${number(maximum)} tokens.`}>
      <ResponsiveContainer width="100%" height="100%">
        {/* throttleDelay: a numeric value makes Recharts use setTimeout instead of its
            default requestAnimationFrame throttling, which never fires in hidden
            (headless) windows. 16ms keeps the same per-frame cadence in normal use. */}
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%" throttleDelay={16}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
            tickFormatter={value => groupBy === 'month' ? String(value).slice(0, 7) : value}
            interval="preserveStartEnd"
            minTickGap={16}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
            tickFormatter={value => value >= 1e6 ? `${(value / 1e6).toLocaleString()}M` : value >= 1e3 ? `${(value / 1e3).toLocaleString()}k` : String(value)}
            width={58}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<TokenTooltip />} cursor={{ fill: 'var(--surface-hover)' }} />
          <Bar dataKey="cachedInput" name="Cached input" stackId="tokens" fill="#818cf8" isAnimationActive={false} radius={[2, 2, 0, 0]} />
          <Bar dataKey="uncachedInput" name="Input tokens (gross)" stackId="tokens" fill="#5b9bff" isAnimationActive={false} radius={[2, 2, 0, 0]} />
          <Bar dataKey="cacheWrite" name="Cache write" stackId="tokens" fill="#34b27b" isAnimationActive={false} radius={[2, 2, 0, 0]} />
          <Bar dataKey="completionTokens" name="Completion tokens" stackId="tokens" fill="#f59e0b" isAnimationActive={false} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <table className="sr-only">
      <caption>Token usage over time</caption>
      <thead><tr><th scope="col">Period</th><th scope="col">Gross input</th><th scope="col">Cached input</th><th scope="col">Uncached input</th><th scope="col">Cache write</th><th scope="col">Completion</th><th scope="col">Total</th></tr></thead>
      <tbody>
        {chartData.map(row => (
          <tr key={row.period}>
            <th scope="row">{row.label}</th>
            <td>{number(row.promptTokens)}</td>
            <td>{known(row.cacheReadTokens, row.cacheReadCoverage)}</td>
            <td>{known(row.uncachedInputTokens, row.uncachedInputCoverage)}</td>
            <td>{known(row.cacheCreationTokens, row.cacheCreationCoverage)}</td>
            <td>{number(row.completionTokens)}</td>
            <td>{number(row.promptTokens + row.completionTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </figure>;
}

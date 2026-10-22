import React from 'react';
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

export default function TokenChart({ data = [], groupBy = 'month' }) {
  const maximum = Math.max(1, ...data.map(row => row.promptTokens + row.completionTokens));
  if (!data.some(row => row.turns || row.promptTokens || row.completionTokens)) {
    return <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[11px] text-[var(--text-muted)]">No token usage recorded for this period.</p>;
  }
  return <figure
    aria-label="Token consumption history"
    className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
  >
    <h3 className="text-xs font-semibold text-[var(--text-primary)]">Token usage over time</h3>
    <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]">
      <span><span className="mr-1 inline-block size-3 rounded-sm bg-blue-500" />Input tokens (gross)</span>
      <span><span className="mr-1 inline-block size-3 rounded-sm bg-indigo-400" />Cached input</span>
      <span><span className="mr-1 inline-block size-3 rounded-sm bg-emerald-500" />Cache write</span>
      <span><span className="mr-1 inline-block size-3 rounded-sm bg-amber-500" />Completion tokens</span>
      <span>Scale: {number(maximum)} tokens · UTC{groupBy === 'week' ? ' · Weeks start Monday' : ''}</span>
    </figcaption>
    <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-end gap-3 pt-24" style={{ minWidth: Math.max(280, data.length * 56) }}>
        {data.map((row, index) => {
          const label = groupBy === 'month' ? row.period.slice(0, 7) : row.period;
          const split = row.cacheReadCoverage === 'measured' && row.cacheReadTokens != null
            && row.uncachedInputCoverage === 'measured' && row.uncachedInputTokens != null;
          const cacheWrite = row.cacheWriteCoverage === 'measured' && typeof row.cacheCreationTokens === 'number'
            ? row.cacheCreationTokens : 0;
          const ratio = hitRatio(row);
          const cost = periodCost(row);
          const description = `${label}: Gross input ${number(row.promptTokens)}, Cached input ${known(row.cacheReadTokens, row.cacheReadCoverage)}, Uncached input ${known(row.uncachedInputTokens, row.uncachedInputCoverage)}, Cache write ${known(row.cacheCreationTokens, row.cacheWriteCoverage)}, Completion ${number(row.completionTokens)}, Total ${number(row.promptTokens + row.completionTokens)}${ratio == null ? ', cache hit ratio not available' : `, cache hit ratio ${ratio.toFixed(1)}%`}${cost == null ? '' : `, estimated cloud cost ${cost}`}`;
          return <div key={row.period} className="group relative flex min-w-10 flex-1 flex-col items-center outline-offset-4" tabIndex={0} aria-label={description}>
            <div role="tooltip" style={index >= data.length / 2 ? { right: 0 } : { left: 0 }} className="pointer-events-none absolute bottom-full z-10 mb-2 hidden whitespace-nowrap rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-xs shadow-lg group-hover:block group-focus:block">
              <p>{label}</p><p>Gross input: {number(row.promptTokens)}</p>
              <p>Cached input: {known(row.cacheReadTokens, row.cacheReadCoverage)}</p>
              <p>Uncached input: {known(row.uncachedInputTokens, row.uncachedInputCoverage)}</p>
              {row.cacheCreationTokens != null ? <p>Cache write: {number(row.cacheCreationTokens)}</p> : null}
              <p>Completion: {number(row.completionTokens)}</p>
              {row.reasoningTokens != null ? <p>Reasoning: {number(row.reasoningTokens)}</p> : null}
              <p>Total: {number(row.promptTokens + row.completionTokens)}</p>
              {ratio != null ? <p>Cache hit: {ratio.toFixed(1)}% of gross input</p> : null}
              {cost != null ? <p>Est. cloud cost: {cost}</p> : null}
            </div>
            <div className="flex h-52 w-full max-w-12 flex-col justify-end" aria-hidden="true">
              <div className="w-full bg-amber-500" style={{ height: `${row.completionTokens / maximum * 100}%` }} />
              {/* Split only when this bucket's cache read is fully measured; a
                  legacy/partial bucket keeps the whole gross prompt in blue. */}
              {split ? <>
                <div className="w-full bg-emerald-500" style={{ height: `${cacheWrite / maximum * 100}%` }} />
                <div className="w-full bg-blue-500" style={{ height: `${row.uncachedInputTokens / maximum * 100}%` }} />
                <div className="w-full bg-indigo-400" style={{ height: `${row.cacheReadTokens / maximum * 100}%` }} />
              </> : <div className="w-full bg-blue-500" style={{ height: `${row.promptTokens / maximum * 100}%` }} />}
            </div>
            <span className="mt-2 whitespace-nowrap text-[10px] text-[var(--text-muted)]">{label}</span>
          </div>;
        })}
      </div>
    </div>
  </figure>;
}

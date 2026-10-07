import React from 'react';

const number = value => value.toLocaleString();
export default function TokenChart({ data = [], groupBy = 'month' }) {
  const maximum = Math.max(1, ...data.map(row => row.promptTokens + row.completionTokens));
  if (!data.some(row => row.turns || row.promptTokens || row.completionTokens)) {
    return <p className="rounded-xl border border-[var(--border)] p-8 text-center text-[var(--text-muted)]">No token usage recorded for this period.</p>;
  }
  return <figure aria-label="Token consumption history" className="space-y-3">
    <figcaption className="flex flex-wrap gap-4 text-xs text-[var(--text-secondary)]">
      <span><span className="mr-1 inline-block size-3 rounded-sm bg-blue-500" />Prompt tokens</span>
      <span><span className="mr-1 inline-block size-3 rounded-sm bg-amber-500" />Completion tokens</span>
      <span>Scale: {number(maximum)} tokens · UTC{groupBy === 'week' ? ' · Weeks start Monday' : ''}</span>
    </figcaption>
    <div className="overflow-x-auto rounded-xl border border-[var(--border)] p-4">
      <div className="flex items-end gap-3 pt-16" style={{ minWidth: Math.max(280, data.length * 56) }}>
        {data.map((row, index) => {
          const label = groupBy === 'month' ? row.period.slice(0, 7) : row.period;
          const description = `${label}: Prompt ${number(row.promptTokens)}, Completion ${number(row.completionTokens)}, Total ${number(row.promptTokens + row.completionTokens)}`;
          return <div key={row.period} className="group relative flex min-w-10 flex-1 flex-col items-center outline-offset-4" tabIndex={0} aria-label={description}>
            <div role="tooltip" style={index >= data.length / 2 ? { right: 0 } : { left: 0 }} className="pointer-events-none absolute bottom-full z-10 mb-2 hidden whitespace-nowrap rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-xs shadow-lg group-hover:block group-focus:block">
              <p>{label}</p><p>Prompt: {number(row.promptTokens)}</p><p>Completion: {number(row.completionTokens)}</p>
            </div>
            <div className="flex h-52 w-full max-w-12 flex-col justify-end" aria-hidden="true">
              <div className="w-full bg-amber-500" style={{ height: `${row.completionTokens / maximum * 100}%` }} />
              <div className="w-full bg-blue-500" style={{ height: `${row.promptTokens / maximum * 100}%` }} />
            </div>
            <span className="mt-2 whitespace-nowrap text-[10px] text-[var(--text-muted)]">{label}</span>
          </div>;
        })}
      </div>
    </div>
  </figure>;
}

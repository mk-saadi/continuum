import React from 'react';
import { costValue, coverageLabel, tokenValue } from './usageDashboardFormat.mjs';

export default function ProviderBreakdownTable({ providers = [], onSelectProvider }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]" aria-labelledby="usage-provider-title">
      <h3 id="usage-provider-title" className="text-xs font-semibold">Spending by provider</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Direct Anthropic and OpenRouter remain distinct billing identities. Local inference is listed for usage only.
      </p>
      {providers.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-[11px] text-[var(--text-muted)]">No provider usage recorded for this selection.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th scope="col" className="py-2 pr-3 font-medium">Provider</th>
                <th scope="col" className="py-2 pr-3 font-medium">Route</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Tokens</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Estimated</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Reported</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Total priced</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Models</th>
                <th scope="col" className="py-2 font-medium">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {providers.map(row => {
                const local = row.providerFamily === 'local';
                return (
                  <tr key={row.providerId} className="border-b border-[var(--border)]/60">
                    <td className="py-2 pr-3 font-medium">
                      {onSelectProvider && row.providerId !== 'local' ? (
                        <button type="button" className="text-left hover:underline" onClick={() => onSelectProvider(row.providerId)}>{row.providerLabel}</button>
                      ) : row.providerLabel}
                    </td>
                    <td className="py-2 pr-3 text-[var(--text-secondary)]">{row.providerFamilyLabel}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{tokenValue(row.totalTokens, row.totalTokensCoverage, { local })}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.estimatedSpend, row.costCoverage, { local })}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.providerReportedSpend, row.providerReportedCoverage, { local })}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{costValue(row.combinedSpend, row.costCoverage, { local })}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.modelsUsed ?? 0}</td>
                    <td className="py-2">{coverageLabel(row.costCoverage)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-[var(--text-muted)]">
        A provider row with unknown pricing reports “—”, never a guess. Local rows are usage-only and are excluded from cloud spend.
      </p>
    </section>
  );
}

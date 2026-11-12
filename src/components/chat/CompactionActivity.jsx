import React from 'react';
import ReactMarkdown from 'react-markdown';
import { activityLabel, activityReason, measurementLabel } from '../../lib/compactionActivity.mjs';
export default function CompactionActivity({ event }) {
  const m = event.metadata ?? {}, usage = m.compactionUsage;
  const complete = event.status === 'completed';
  const terminal = ['completed', 'failed', 'deferred', 'cancelled', 'continued'].includes(event.status);
  const counts = complete && Number.isFinite(m.beforeTokens) && Number.isFinite(m.afterTokens);
  const comparable = !!m.measurementMethod && m.measurementMethod === (m.afterMeasurementMethod ?? m.measurementMethod);
  return <section className="my-3 min-w-0 border-y border-[var(--subtle-border)] py-3 text-xs text-[var(--text-secondary)]" data-compaction-id={event.id} aria-label="Conversation compaction">
    <div className="flex items-center gap-3 text-[var(--text-muted)]"><span className="h-px flex-1 bg-[var(--subtle-border)]"/><span>Compaction started</span><span className="h-px flex-1 bg-[var(--subtle-border)]"/></div>
    <div className="my-3 min-w-0" aria-label="Compaction summary">
      {m.compactionSummary ? <div className="prose prose-sm max-w-none break-words text-[var(--text-secondary)]"><ReactMarkdown skipHtml>{m.compactionSummary}</ReactMarkdown></div>
        : <p>{complete ? 'Summary unavailable for this older compaction.' : terminal ? 'No replacement summary was saved.' : activityLabel(event)}</p>}
    </div>
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--subtle-border)] pt-2">
      <span className={event.status === 'failed' ? 'text-[var(--error)]' : 'text-[var(--text-primary)]'}>{complete ? 'Compaction ended' : terminal ? activityLabel(event) : 'Compacting conversation…'}</span>
      {complete && usage && <span className="tabular-nums" title="Total across compaction summary generations; system instructions excluded">Input: {usage.inputTokens.toLocaleString()} tokens{usage.inputMethod !== 'server-template-tokenizer' ? ' (estimated)' : ''} · Output: {usage.outputTokens.toLocaleString()} tokens{usage.outputMethod !== 'provider-usage' ? ' (estimated)' : ''} · excludes system tokens</span>}
      {complete && !usage && <span>Input/output counts unavailable for this older compaction.</span>}
    </div>
    {m.conversationTokens != null && <p className="mt-2 tabular-nums">Summary + recent conversation: {m.conversationTokens.toLocaleString()} tokens · excludes system context and tools</p>}
    {event.code && <p className="mt-2">{activityReason(event.code)}</p>}
    <details className="mt-2 text-[var(--text-muted)]">
      <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--accent)]">Compaction details</summary>
      {counts && <p>{measurementLabel(m.measurementMethod)}: {m.beforeTokens.toLocaleString()} → {m.afterMeasurementMethod && measurementLabel(m.afterMeasurementMethod) !== measurementLabel(m.measurementMethod) ? `${measurementLabel(m.afterMeasurementMethod)}: ` : ''}{m.afterTokens.toLocaleString()} tokens{comparable && m.beforeTokens > 0 && ` · ${Math.abs((m.beforeTokens - m.afterTokens) / m.beforeTokens * 100).toFixed(1)}% ${m.afterTokens > m.beforeTokens ? 'more' : 'less'}`} (complete request, including system context)</p>}
      {counts && !comparable && <p>Counting method changed; percentage reduction unavailable.</p>}
      {m.summaryTokens != null && <p>Compaction summary: {m.summaryTokens.toLocaleString()} tokens · {measurementLabel(m.summaryTokenMethod)}</p>}
      {m.continued && <p>Agent continued working</p>}
      <p>Complete request measurement: {m.measurementMethod ?? 'Unavailable'}{m.afterMeasurementMethod && ` → ${m.afterMeasurementMethod}`}</p>
      {m.generationStages != null && <p>Generation stages: {m.generationStages}</p>}
      <time dateTime={event.started_at}>{event.started_at}</time>
    </details>
  </section>;
}

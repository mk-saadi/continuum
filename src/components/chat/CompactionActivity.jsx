import React from 'react';
import { activityLabel, activityReason, measurementLabel } from '../../lib/compactionActivity.mjs';
export default function CompactionActivity({ event }) {
  const m = event.metadata ?? {};
  const complete = event.status === 'completed';
  const counts = complete && Number.isFinite(m.beforeTokens) && Number.isFinite(m.afterTokens);
  const tone = event.status === 'failed' ? 'var(--error)' : complete ? 'var(--text-primary)' : event.status === 'deferred' ? 'var(--text-primary)' : 'var(--text-secondary)';
  return <details className="min-w-0 rounded border-l-2 border-[var(--subtle-border)] px-3 py-1.5 text-xs text-[var(--text-secondary)]" data-compaction-id={event.id}>
    <summary className="cursor-pointer break-words rounded focus-visible:outline-2 focus-visible:outline-[var(--accent)]" style={{ color: tone }}>
      <span role="status" aria-live="polite">{activityLabel(event)}</span>
      {counts && <span className="mt-1 block tabular-nums text-[var(--text-secondary)]">{measurementLabel(m.measurementMethod)}: {m.beforeTokens.toLocaleString()} → {m.afterMeasurementMethod && measurementLabel(m.afterMeasurementMethod) !== measurementLabel(m.measurementMethod) ? `${measurementLabel(m.afterMeasurementMethod)}: ` : ''}{m.afterTokens.toLocaleString()} tokens{m.beforeTokens > 0 && ` · ${((m.beforeTokens - m.afterTokens) / m.beforeTokens * 100).toFixed(1)}% less`}</span>}
      {m.continued && <span className="mt-1 block text-[var(--text-secondary)]">Agent continued working</span>}
    </summary>
    <div className="mt-2 break-words space-y-1">
      {event.code && <p>{activityReason(event.code)} <span className="font-mono">({event.code})</span></p>}
      <p>Complete request measurement: {m.measurementMethod ?? 'Unavailable'}{m.afterMeasurementMethod && ` → ${m.afterMeasurementMethod}`}</p>
      {m.usableInputTokens != null && <p>Usable input capacity: {m.usableInputTokens.toLocaleString()} tokens</p>}
      {m.triggerTokens != null && <p>Trigger: {m.triggerTokens.toLocaleString()} tokens</p>}
      {m.generationStages != null && <p>Generation stages: {m.generationStages}</p>}
      <p><time dateTime={event.started_at}>{event.started_at}</time></p>
    </div>
  </details>;
}

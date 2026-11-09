import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompressionEvents } from '../context/CompressionEventsContext.jsx';

const cardClass = 'aero-panel sk-panel p-3';
const headingClass = 'text-xs font-semibold mb-2!';
const bodyClass = 'text-[11px] leading-relaxed text-[var(--text-muted)]';
const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';

export default function ContextPanel({ sessionId, modelId = null, active = false, measurement = null, liveTelemetry = null, runTelemetry = null }) {
  const api = typeof window !== 'undefined' ? window.memoryPalace : null;
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState(null);
  const owner = useRef({ sessionId, sequence: 0 });
  if (owner.current.sessionId !== sessionId) owner.current = { sessionId, sequence: owner.current.sequence + 1 };
  const refresh = useCallback(async () => {
    if (!api || !sessionId) return;
    const sequence = ++owner.current.sequence;
    const current = () => owner.current.sessionId === sessionId && owner.current.sequence === sequence;
    setLoading(true);
    try {
      const [context, counts] = await Promise.all([api.getSessionSummary(sessionId), modelId && api.getContextUsage ? api.getContextUsage(sessionId, modelId) : Promise.resolve(null)]);
      if (!current()) return;
      setSummary(typeof context === 'string' ? context : context?.text ?? null);
      setStatus(context?.status ?? null);
      setUsage(counts);
      setError('');
    } catch (failure) { if (current()) setError(failure.message); }
    finally { if (current()) setLoading(false); }
  }, [api, sessionId, modelId]);
  useEffect(() => { setSummary(null); setStatus(null); if (active) void refresh(); }, [active, refresh]);
  useCompressionEvents(sessionId, result => {
    setStatus(result.status ?? (result.compressed ? 'completed' : result.deferred ? 'deferred' : result.error ? 'failed' : null));
    if (result.error) setError(result.error);
    if (result.compressed) void refresh();
  });
  const current = measurement?.sessionId === sessionId && measurement?.modelId === modelId ? measurement : null;
  const live = liveTelemetry && (!liveTelemetry.sessionId || liveTelemetry.sessionId === sessionId) &&
    (!liveTelemetry.modelId || liveTelemetry.modelId === modelId) ? liveTelemetry : null;
  const contract = live?.budgetContract ?? current?.budgetContract;
  const input = live?.promptTokens ?? current?.tokens ?? runTelemetry?.lastPromptTokens ?? usage?.telemetry?.lastPromptTokens;
  const estimated = live ? live.isEstimate : current ? current.method !== 'server-template-tokenizer' : null;
  const contextLabel = live ? 'Current context:' : current ? 'Prepared context:' : 'Last request context:';
  if (!api) return <div className={cardClass}><p className={bodyClass}>Context inspection is available in the desktop app.</p></div>;
  return <div className="space-y-3">
    <div className={cardClass}>
      <h3 className={headingClass}>Request context budget</h3>
      <div className={bodyClass}>
        <p>{contextLabel} {number(input)} / {number(contract?.capacityTokens)} tokens{input != null && ` · ${estimated ? 'estimated' : 'measured'}`}</p>
        <p>Usable input: {number(contract?.usableInputTokens)} · output reserve: {number(contract?.reservedOutputTokens)}</p>
        {contract ? <p>Compaction trigger: {number(contract.autoCompactionTriggerTokens)} tokens</p> : <p>Current request budget pending.</p>}
        {current?.imageCount > 0 && <p>Image allowance: {number(current.imageAllowanceTokens)} estimated tokens</p>}
        <p>Compaction starts at 90% of usable input, with 5% extra headroom for estimates.</p>
        <p>Cached input still occupies context. Cumulative usage is separate from context occupancy.</p>
      </div>
    </div>
    <div className={cardClass}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className={headingClass}>Compaction summary</h3>
        <button type="button" onClick={() => void refresh()} disabled={loading}
          className="aero-control sk-button aero-fill sk-fill px-2.5 py-1 text-[11px]">Refresh</button>
      </div>
      {status && <p role="status" className={bodyClass}>{({ compacting: 'Compacting…', completed: 'Completed', deferred: 'Deferred', failed: 'Failed' })[status] ?? status}</p>}
      {error && <p role="alert" className={`${bodyClass} text-[var(--error)]`}>{error}</p>}
      {loading ? <p role="status" className={bodyClass}>Loading summary…</p> : summary
        ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">{summary}</pre>
        : <p className={bodyClass}>No compaction summary yet.</p>}
      <p className={`${bodyClass} mt-2`}>Original messages and tool results remain in chat history.</p>
    </div>
  </div>;
}

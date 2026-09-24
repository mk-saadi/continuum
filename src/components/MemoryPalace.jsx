import MemorySettings from './MemorySettings';
import React, { useCallback, useEffect, useRef, useState } from 'react';

const tokens = (text) => Math.ceil(text.length / 4);
const compact = (value) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export function useMemoryPalace(modelId, activeModelConfig) {
  const api = window.memoryPalace;
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [enabled, setEnabled] = useState(() => localStorage.getItem('memory-injection') !== 'off');
  const contextLength = activeModelConfig?.contextLength;
  const limit = Number.isSafeInteger(contextLength) && contextLength > 0 ? contextLength : null;
  const [usage, setUsage] = useState(null);
  const [coreTokens, setCoreTokens] = useState(0);
  const [pluginTokens, setPluginTokens] = useState(0);
  const [toolTokens, setToolTokens] = useState(0);
  const [mcpStatus, setMcpStatus] = useState({ servers: [] });
  useEffect(() => {
    let active = true;
    const update = status => {
      if (!active) return;
      setPluginTokens(status.pluginTokens);
      setToolTokens(status.toolTokens);
      setMcpStatus(status);
    };
    const unsubscribe = window.mcpAPI?.onChanged(update);
    window.mcpAPI?.getStatus().then(update).catch(err => { if (active) setError(err.message); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  const [draftTokens, setDraftTokens] = useState(0);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const generation = useRef(0);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    if (!api || !modelId) return;
    const version = generation.current;
    const requestId = ++request.current;
    try {
      const [next, core] = await Promise.all([
        api.getContextUsage(sessionId, modelId), api.getCoreMemories(modelId),
      ]);
      if (version !== generation.current || requestId !== request.current) return;
      setUsage(next);
      setCoreTokens(core.reduce((sum, memory) => sum + tokens(memory.content), 0));
      setError('');
    } catch (err) {
      if (version === generation.current) setError(err.message);
    }
  }, [api, sessionId, modelId]);

  useEffect(() => {
    generation.current += 1;
    setUsage(null);
    if (!api || !modelId) return;
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => { generation.current += 1; clearInterval(interval); };
  }, [api, modelId, refresh]);

  useEffect(() => api?.onCompressionComplete((result) => {
    if (result.sessionId !== sessionId) return;
    setToast(`Summarized ${result.archivedCount} earlier messages to free memory`);
    refresh();
  }), [api, sessionId, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const schedule = useCallback(() => {
    if (!api || !modelId || limit === null) return;
    api.scheduleIdleCompression(sessionId, modelId, limit).catch((err) => setError(err.message));
  }, [api, modelId, sessionId, limit]);

  async function prepareMessages(text, regenerate = false, attachments = []) {
    if (!api) throw new Error('Memory Palace is available in the desktop app.');
    if (!modelId) throw new Error('Select a model first.');
    const payload = await api.prepareChatMessages(sessionId, modelId, text, enabled, regenerate, attachments);
    setDraftTokens(0);
    await refresh();
    return payload;
  }

  async function finishMessage(text, stats = null, toolCalls = null, thinking = null) {
    const saved = text || stats || toolCalls?.length || thinking?.text
      ? await api.saveMessage(sessionId, 'assistant', text, [], stats, toolCalls, thinking) : null;
    setDraftTokens(0);
    await refresh();
    schedule();
    return saved;
  }

  return {
    api, sessionId, setSessionId, enabled, limit, usage, error, toast, refresh, schedule, prepareMessages, finishMessage, toolTokens, pluginTokens, mcpStatus,
    setDraftTokens,
    totalTokens: usage ? Math.max(0, usage.totalTokens - (enabled ? 0 : coreTokens)) + draftTokens + Math.max(0, toolTokens - pluginTokens) : null,
    toggle: () => setEnabled((value) => {
      localStorage.setItem('memory-injection', value ? 'off' : 'on');
      return !value;
    }),
  };
}

function Icon({ name }) {
  const paths = {
    memory: 'M4 20V9l8-5 8 5v11M2 20h20M8 20v-7h8v7M8 9h8',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    close: 'M6 6l12 12M18 6L6 18',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function MemoryPalaceHeader({ palace, pluginTokens = 0, avatars, models }) {
  const [open, setOpen] = useState(false);
  const cost = Number.isFinite(pluginTokens) ? Math.max(0, pluginTokens) : 0;
  const total = palace.totalTokens === null ? null : palace.totalTokens + cost;
  const percent = total === null || palace.limit === null ? null : (total / palace.limit) * 100;
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'medium' : 'low';

  return <>
    <section className={`palace-header palace-${level}`} aria-label="Context and memory">
      <div className="palace-meter-label">
        <span title={palace.error || 'Estimated tokens, including current draft. Context size comes from the active engine.'}>
          {palace.limit === null ? 'Context: Not Loaded' : palace.error ? 'Context unavailable' : `${percent === null ? 'Context —' : `${Math.floor(percent)}%`} / ${compact(palace.limit)} tokens`}
        </span>
        <span className="palace-plugin" title="Estimated token cost of enabled plugin definitions">Plugins +{compact(cost)}</span>
        <button className="palace-icon" aria-label={`Memory injection ${palace.enabled ? 'on' : 'off'}`} aria-pressed={palace.enabled}
          title={`Memory injection ${palace.enabled ? 'ON' : 'OFF'}`} onClick={palace.toggle}><Icon name="memory" /></button>
        <button className="palace-icon" aria-label="Memory settings" title="Memory settings" onClick={() => setOpen(true)}><Icon name="settings" /></button>
      </div>
      <div className="palace-meter" role="progressbar" aria-label="Estimated context usage"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, Math.floor(percent))}
        aria-valuetext={percent === null ? 'Waiting for model' : `${total} of ${palace.limit} estimated tokens`}>
        <span style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </div>
    </section>
    <div className={`palace-toast ${palace.toast ? 'visible' : ''}`} role="status" aria-live="polite" aria-atomic="true">{palace.toast}</div>
    {open && <MemorySettings avatars={avatars} models={models} palace={palace} onClose={() => setOpen(false)} />}
  </>;
}

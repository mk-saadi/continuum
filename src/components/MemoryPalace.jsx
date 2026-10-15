import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PALACE_POLL_INTERVAL_MS, isDocumentHidden, shouldPollTick, usageEqual } from '../lib/palacePolling.mjs';

const tokens = (text) => Math.ceil(text.length / 4);

export function useMemoryPalace(modelId, activeModelConfig, initialSessionId, onSessionChange, options = {}) {
  const { isCloud = false, permissionMode = undefined, engineReady = false, enginePort = null,
    // Inactive panes must not poll: every mounted tab owns a hook instance,
    // so an ungated interval would multiply IPC/DB work by the tab count.
    // Defaults preserve behavior for callers that do not pass tab state.
    isActive = true, pollIntervalMs = PALACE_POLL_INTERVAL_MS } = options;
  const api = window.memoryPalace;
  const [sessionId, setCurrentSessionId] = useState(() => initialSessionId || crypto.randomUUID());
  const setSessionId = useCallback(id => {
    setCurrentSessionId(id);
    onSessionChange?.(id);
  }, [onSessionChange]);
  const [enabled, setEnabled] = useState(true);
  const contextLength = activeModelConfig?.contextLength;
  const limit = Number.isSafeInteger(contextLength) && contextLength > 0 ? contextLength : null;
  const [usage, setUsage] = useState(null);
  const [coreTokens, setCoreTokens] = useState(0);
  const [pluginTokens, setPluginTokens] = useState(0);
  const [toolTokens, setToolTokens] = useState(0);
  const [mcpStatus, setMcpStatus] = useState({ servers: [] });
  // Tokenizer-measured prepared prompt (event-driven, never polled).
  const [measured, setMeasured] = useState(null);
  const [measureError, setMeasureError] = useState('');
  // Live per-request telemetry for the active turn (cleared on turn end).
  const [liveTelemetry, setLiveTelemetry] = useState(null);
  const measureGeneration = useRef(0);

  const measure = useCallback(async () => {
    if (!api?.measureContext || !modelId) return;
    const version = measureGeneration.current;
    try {
      const result = await api.measureContext(sessionId, modelId, { cloud: isCloud, permissionMode });
      if (version !== measureGeneration.current) return;
      setMeasured(result);
      setMeasureError('');
    } catch (err) {
      if (version === measureGeneration.current) setMeasureError(err?.message ?? String(err));
    }
  }, [api, sessionId, modelId, isCloud, permissionMode]);

  const noteLivePhase = useCallback((event) => {
    if (!event || event.sessionId !== sessionId) return;
    setLiveTelemetry({ round: event.round ?? null, promptTokens: event.promptTokens ?? null,
      telemetry: event.telemetry ?? null });
  }, [sessionId]);

  const clearLiveTelemetry = useCallback(() => {
    setLiveTelemetry(null);
  }, []);

  useEffect(() => {
    let active = true;
    let lastToolTokens = null, lastPluginTokens = null;
    const update = status => {
      if (!active) return;
      setPluginTokens(status.pluginTokens);
      setToolTokens(status.toolTokens);
      setMcpStatus(status);
      // Tool schemas changed: the measured prompt is stale. The initial
      // status fetch only establishes baselines without re-measuring
      // (the session effect below already measures on mount/switch).
      if (lastToolTokens !== null && (status.toolTokens !== lastToolTokens || status.pluginTokens !== lastPluginTokens)) {
        measure();
      }
      lastToolTokens = status.toolTokens;
      lastPluginTokens = status.pluginTokens;
    };
    const unsubscribe = window.mcpAPI?.onChanged(update);
    window.mcpAPI?.getStatus().then(update).catch(err => { if (active) setError(err.message); });
    return () => { active = false; unsubscribe?.(); };
  }, [measure]);
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
      const [next, core, settings] = await Promise.all([
        api.getContextUsage(sessionId, modelId), api.getCoreMemories(modelId), window.api.getEffectiveSettings(sessionId, modelId),
      ]);
      if (version !== generation.current || requestId !== request.current) return;
      // Identical polls must not churn state: usage is a fresh object per IPC
      // round-trip, and storing it unconditionally re-renders the pane subtree
      // every interval even when nothing changed.
      setUsage((previous) => (usageEqual(previous, next) ? previous : next));
      setEnabled(settings.effective.memoryEnabled);
      setCoreTokens(core.reduce((sum, memory) => sum + tokens(memory.content), 0));
      setError('');
    } catch (err) {
      if (version === generation.current) setError(err.message);
    }
  }, [api, sessionId, modelId]);

  useEffect(() => {
    generation.current += 1;
    measureGeneration.current += 1;
    setUsage(null);
    setMeasured(null);
    setMeasureError('');
    setLiveTelemetry(null);
    if (!api || !modelId || !isActive) return;
    refresh();
    measure();
    const intervalMs = Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0
      ? pollIntervalMs
      : PALACE_POLL_INTERVAL_MS;
    const interval = setInterval(() => {
      if (!shouldPollTick({ isActive, hidden: isDocumentHidden() })) return;
      refresh();
    }, intervalMs);
    return () => { generation.current += 1; measureGeneration.current += 1; clearInterval(interval); };
  }, [api, modelId, refresh, measure, isActive, pollIntervalMs]);

  useEffect(() => api?.onCompressionComplete((result) => {
    if (result.sessionId !== sessionId) return;
    if (!result.compressed) return;
    setToast(`Summarized ${result.archivedCount} earlier messages to free memory`);
    refresh();
    measure();
  }), [api, sessionId, refresh, measure]);

  // Engine transitions (offline → ready, port change, restart) change what
  // the tokenizer backend can measure, but no session/model prop changes.
  // Re-measure on the transition itself, not on a poll.
  const engineIdentity = useRef({ ready: false, port: null });
  useEffect(() => {
    const prev = engineIdentity.current;
    engineIdentity.current = { ready: engineReady, port: enginePort };
    if (!engineReady) return;
    // First ready transition, or a port change while ready (restart with a
    // new backend identity): the cached offline/previous-backend reading is stale.
    if (!prev.ready || prev.port !== enginePort) measure();
  }, [engineReady, enginePort, measure]);

  // Global settings (memory profiles, MCP mode, sampling) and session memory
  // toggles elsewhere in the UI change the prepared prompt without touching
  // this hook's props. Settings screens broadcast 'generation-settings-changed'
  // (see ModelProfileSettings); honor it here with a trailing debounce so a
  // burst of saves measures once.
  const settingsTimer = useRef(null);
  useEffect(() => {
    const onSettingsChanged = () => {
      if (settingsTimer.current !== null) clearTimeout(settingsTimer.current);
      settingsTimer.current = setTimeout(() => {
        settingsTimer.current = null;
        refresh();
        measure();
      }, 300);
    };
    window.addEventListener('generation-settings-changed', onSettingsChanged);
    return () => {
      window.removeEventListener('generation-settings-changed', onSettingsChanged);
      if (settingsTimer.current !== null) { clearTimeout(settingsTimer.current); settingsTimer.current = null; }
    };
  }, [refresh, measure]);

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
    // Prompt state changed (new user message saved): re-measure once.
    measure();
    return payload;
  }

  async function finishMessage(text, stats = null, toolCalls = null, thinking = null, identity = null, executionSteps = null, messageId = null) {
    const saved = messageId || text || stats || toolCalls?.length || thinking?.text || executionSteps?.length
      ? await api.saveMessage(sessionId, 'assistant', text, [], stats, toolCalls, thinking, messageId, identity, executionSteps) : null;
    setDraftTokens(0);
    await refresh();
    // Turn completed: persisted telemetry is now in usage; refresh measurement.
    measure();
    schedule();
    return saved;
  }

  // Legacy DB estimate (chars/4 over saved messages). Kept as the labeled
  // fallback when tokenizer measurement is unavailable; compression and
  // overflow logic continue to use this same estimate unchanged.
  const fallbackTokens = usage
    ? Math.max(0, usage.totalTokens - (enabled ? 0 : coreTokens)) + draftTokens + Math.max(0, toolTokens - pluginTokens)
    : null;
  // Primary context figure: measured prepared prompt when fresh for this
  // session/model, otherwise the labeled estimate. Draft text is counted via
  // the cheap estimate in both cases and disclosed in the tooltip.
  const measuredFresh = measured && measured.sessionId === sessionId && measured.modelId === modelId;
  // contextTokens is all-inclusive in both branches: the measured payload
  // already contains every tool schema, while the legacy fallback adds the
  // live MCP plugin tokens on top (matching the previous header behavior).
  const contextTokens = measuredFresh
    ? measured.tokens + draftTokens
    : fallbackTokens === null ? null : fallbackTokens + (pluginTokens || 0);
  const contextMethod = measuredFresh ? measured.method : 'legacy-estimate';
  const contextConfidence = measuredFresh ? measured.confidence : 'estimated';

  return {
    api, sessionId, setSessionId, enabled, limit, usage, error, toast, refresh, schedule, prepareMessages, finishMessage, toolTokens, pluginTokens, mcpStatus,
    setDraftTokens,
    measure, measured: measuredFresh ? measured : null, measureError,
    noteLivePhase, clearLiveTelemetry, liveTelemetry,
    // Persisted per-turn server telemetry for this session (latest completed turn).
    turnTelemetry: usage?.telemetry ?? null,
    contextTokens, contextMethod, contextConfidence, fallbackTokens,
    totalTokens: fallbackTokens,
    toggle: async () => {
      try {
        await window.api.saveSessionMemorySettings(sessionId, modelId, { memoryEnabled: !enabled });
        await refresh();
        measure();
        window.dispatchEvent(new Event('generation-settings-changed'));
      } catch (err) { setError(err.message); }
    },
  };
}

import React, { useCallback, useEffect, useRef, useState } from 'react';

const tokens = (text) => Math.ceil(text.length / 4);

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

  async function finishMessage(text, stats = null, toolCalls = null, thinking = null, identity = null, executionSteps = null) {
    const saved = text || stats || toolCalls?.length || thinking?.text || executionSteps?.length
      ? await api.saveMessage(sessionId, 'assistant', text, [], stats, toolCalls, thinking, null, identity, executionSteps) : null;
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

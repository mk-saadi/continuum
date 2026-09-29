// Keep Electron events scoped to this request and remove listeners on every exit.
export async function runDesktopChat({ modelId, modelName, displayName, messages, reasoningEffort, signal, onText, onStats, onTool, onThinking, onIndexing, onExecutionSteps, messageId, sessionId, regenerate = false, memoryEnabled = true }) {
  onIndexing?.(null);
  const api = window.chatAPI;
  if (!api) throw new Error('Chat is available in the desktop app.');
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  // Batch text and reasoning together: both can arrive once per token. A trailing
  // timer also publishes short bursts when no further token arrives.
  let timer = null;
  let textBuffer = '';
  let thinking, stats, indexing, executionSteps;
  const toolEvents = new Map();
  let liveSteps = [];
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const text = textBuffer, nextThinking = thinking, nextStats = stats, nextIndexing = indexing;
    const tools = [...toolEvents.values()];
    const nextSteps = executionSteps;
    executionSteps = undefined;
    textBuffer = '';
    thinking = stats = indexing = undefined;
    toolEvents.clear();
    if (text) onText?.(text);
    if (nextSteps !== undefined) onExecutionSteps?.(nextSteps);
    if (nextThinking !== undefined) onThinking?.(nextThinking);
    if (nextStats !== undefined) onStats?.(nextStats);
    if (nextIndexing !== undefined) onIndexing?.(nextIndexing);
    for (const tool of tools) onTool?.(tool);
  };
  const unsubscribe = api.onEvent(event => {
    if (event.requestId !== requestId || (signal?.aborted && event.type !== 'step-update')) return;
    if (event.type === 'step-update') executionSteps = liveSteps = event.executionSteps;
    else if (event.type === 'tool_start') {
      liveSteps = [...liveSteps.filter(step => step.id !== event.id), {
        id: event.id, type: 'tool_call', toolName: event.functionName, status: 'preparing', streamingArguments: '',
      }];
      executionSteps = liveSteps;
    } else if (event.type === 'tool_chunk') {
      liveSteps = liveSteps.map(step => step.id === event.id && step.status === 'preparing' ? {
        ...step, streamingParameter: event.parameter,
        streamingArguments: step.streamingArguments + (step.streamingParameter !== event.parameter
          ? `${step.streamingArguments ? '\n\n' : ''}${event.parameter}:\n` : '') + event.content,
      } : step);
      executionSteps = liveSteps;
    }
    else if (event.type === 'text') textBuffer += event.delta;
    else if (event.type === 'thinking') thinking = event.thinking;
    else if (event.type === 'stats') stats = event.stats;
    else if (event.type === 'indexing') {
      if (event.progress === null) {
        // A reset supersedes any progress still waiting in the batching timer.
        indexing = undefined;
        onIndexing?.(null);
        return;
      }
      indexing = event;
    }
    else if (event.type === 'tool') toolEvents.set(event.id, event);
    else return;
    if (timer === null) timer = setTimeout(flush, 50);
  });
  const abort = () => {
    flush();
    api.cancel(requestId).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await (regenerate ? window.memoryPalace.regenerateLast : api.run)({ requestId, messageId: messageId ?? requestId, modelId, modelName, displayName, messages, memoryEnabled, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}), ...(sessionId ? { sessionId } : {}) });
    // The invoke result is authoritative even if the final event was delayed.
    if (result.stats) stats = result.stats;
    if (result.executionSteps) executionSteps = result.executionSteps;
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', abort);
    flush();
    onIndexing?.(null);
  }
}

export async function indexDesktopDocuments(attachments, { signal, onProgress = () => {} } = {}) {
  onProgress(null);
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const unsubscribe = window.chatAPI.onEvent(event => {
    if (event.requestId === requestId && !signal?.aborted && event.type === 'indexing') onProgress(event.progress === null ? null : event);
  });
  const abort = () => { window.chatAPI.cancel(requestId).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await window.api.indexDocuments({ requestId, attachments });
    signal?.throwIfAborted();
    return result;
  } catch (error) { signal?.throwIfAborted(); throw error; }
  finally { unsubscribe(); signal?.removeEventListener('abort', abort); onProgress(null); }
}

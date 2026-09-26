// Keep Electron events scoped to this request and remove listeners on every exit.
export async function runDesktopChat({ modelId, modelName, messages, signal, onText, onStats, onTool, onThinking, onIndexing, onExecutionSteps, messageId, sessionId, regenerate = false, memoryEnabled = true }) {
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
    if (event.type === 'step-update') executionSteps = event.executionSteps;
    else if (event.type === 'text') textBuffer += event.delta;
    else if (event.type === 'thinking') thinking = event.thinking;
    else if (event.type === 'stats') stats = event.stats;
    else if (event.type === 'indexing') indexing = event;
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
    const result = await (regenerate ? window.memoryPalace.regenerateLast : api.run)({ requestId, messageId: messageId ?? requestId, modelId, modelName, messages, memoryEnabled, ...(sessionId ? { sessionId } : {}) });
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
  }
}

export async function indexDesktopDocuments(attachments, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const unsubscribe = window.chatAPI.onEvent(event => {
    if (event.requestId === requestId && event.type === 'indexing') onProgress(event);
  });
  const abort = () => { window.chatAPI.cancel(requestId).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await window.api.indexDocuments({ requestId, attachments });
    signal?.throwIfAborted();
    return result;
  } catch (error) { signal?.throwIfAborted(); throw error; }
  finally { unsubscribe(); signal?.removeEventListener('abort', abort); }
}

// Keep Electron events scoped to this request and remove listeners on every exit.
export async function runDesktopChat({ modelId, messages, signal, onText, onStats, onTool, onThinking }) {
  const api = window.chatAPI;
  if (!api) throw new Error('Chat is available in the desktop app.');
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const unsubscribe = api.onEvent(event => {
    if (event.requestId !== requestId) return;
    if (event.type === 'text') onText?.(event.delta);
    if (event.type === 'stats') onStats?.(event.stats);
    if (event.type === 'tool') onTool?.(event);
    if (event.type === 'thinking') onThinking?.(event.thinking);
  });
  const abort = () => { api.cancel(requestId).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await api.run({ requestId, modelId, messages });
    // The invoke result is authoritative even if the final event was delayed.
    if (result.stats) onStats?.(result.stats);
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', abort);
  }
}

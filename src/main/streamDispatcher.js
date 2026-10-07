// One dispatcher per invoke. Keep token traffic off the IPC bridge until a
// bounded frame, and always drain it before the invoke settles.
function createStreamDispatcher(sender, requestId, sessionId, isTrustedSender, intervalMs = 40) {
  const chunks = [];
  let timer = null;
  const send = (result) => {
    if (sender.isDestroyed() || !isTrustedSender()) return;
    if (result.type === 'step-update') sender.send('stream:step-update', { requestId, sessionId, ...result });
    if (result.type === 'text') sender.send('engine:stream-chunk', { sessionId, content: result.delta });
    sender.send('engine:chat-event', { requestId, sessionId, ...result });
  };
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!chunks.length) return;
    const delta = chunks.join('');
    chunks.length = 0;
    send({ type: 'text', delta });
  };
  return {
    dispatch(result) {
      // The throttled step snapshot already contains live tool arguments.
      if (result.type === 'tool_chunk') return;
      if (result.type === 'text') {
        if (result.delta) chunks.push(result.delta);
        if (timer === null) timer = setTimeout(flush, intervalMs);
        return;
      }
      flush(); // Preserve ordering around tool and completion events.
      send(result);
    },
    close() { flush(); },
  };
}

module.exports = { createStreamDispatcher };

// Separate model-provided reasoning fields and <think> blocks from visible text.
// Durations are seconds spent receiving reasoning; tool execution is excluded.
export function createThinkingStream({ onText, onThinking, now = () => performance.now() }) {
  let buffer = '', inside = false, thinkingText = '', duration = 0, started = null;
  const publish = elapsed => onThinking({ text: thinkingText, duration: duration + elapsed });
  function reasoning(delta) {
    if (!delta) return;
    const time = now();
    started ??= time;
    thinkingText += delta;
    publish(Math.max(0, time - started) / 1000);
  }
  function endReasoning() {
    if (started === null) return;
    duration += Math.max(0, now() - started) / 1000;
    started = null;
    publish(0);
  }
  function emit(value) {
    if (!value) return;
    if (inside) reasoning(value);
    else { endReasoning(); onText(value); }
  }
  function text(delta) {
    buffer += delta;
    while (buffer) {
      const tag = inside ? '</think>' : '<think>';
      const index = buffer.indexOf(tag);
      if (index >= 0) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + tag.length);
        if (inside) endReasoning();
        inside = !inside;
        continue;
      }
      // Hold only a possible tag prefix until the next chunk arrives.
      let retained = Math.min(buffer.length, tag.length - 1);
      while (retained && !tag.startsWith(buffer.slice(-retained))) retained--;
      emit(buffer.slice(0, buffer.length - retained));
      buffer = retained ? buffer.slice(-retained) : '';
      break;
    }
  }
  return { text, reasoning, finish() { emit(buffer); buffer = ''; endReasoning(); } };
}

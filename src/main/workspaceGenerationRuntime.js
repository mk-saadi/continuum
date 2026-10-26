'use strict';
const abortCodes = new Set(['user-cancelled', 'deleted-conversation', 'renderer-destroyed', 'ipc-disposed', 'generation-inactivity-timeout']);
const reason = code => Object.assign(new Error(code), { code });
function abortCode(signal) {
  return abortCodes.has(signal?.reason?.code) ? signal.reason.code : 'unexpected-abort';
}
// Progress, including hidden reasoning, renews this lease. No wall-clock limit
// across stages: stage count, output reservations and source guards bound work.
function createGenerationRuntime(parent, { setTimer = setTimeout, clearTimer = clearTimeout, inactivityMs = 600000 } = {}) {
  const controller = new AbortController();
  let timer;
  const forward = () => controller.abort(reason(abortCode(parent)));
  parent?.addEventListener('abort', forward, { once: true });
  if (parent?.aborted) forward();
  const progress = () => {
    clearTimer(timer);
    timer = setTimer(() => controller.abort(reason('generation-inactivity-timeout')), inactivityMs);
    timer?.unref?.();
  };
  progress();
  return { controller, signal: controller.signal, progress,
    dispose() { clearTimer(timer); parent?.removeEventListener('abort', forward); } };
}
async function generateLocalCandidate(fetchImpl, url, request, { signal, onProgress = () => {} }) {
  const started = performance.now();
  let firstTokenMs = null, backendTimings = null;
  const send = payload => fetchImpl(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }) });
  let response = await send(request), structuredOutput = request.response_format ? 'schema-requested' : 'prompt-only';
  if (response.status === 400 && request.response_format) {
    // Explicit pre-generation incompatibility only. No retry after a generated
    // or interrupted response; schema validation is still mandatory below.
    const detail = await response.clone().text();
    if (/(?:unsupported|not supported|not compatible|cannot use|not allowed|failed to parse)[^\n]{0,120}(?:response_format|json.schema|grammar)|(?:response_format|json.schema|grammar)[^\n]{0,120}(?:unsupported|not supported|not compatible|cannot use|not allowed|failed to parse)/i.test(detail)) {
      await response.body?.cancel(); signal?.throwIfAborted();
      const { response_format, ...fallback } = request;
      response = await send(fallback); structuredOutput = 'prompt-fallback';
    }
  }
  if (!response.ok) throw reason('provider-error');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', content = '', finish = null, usage, doneMarker = false, invalid = false, reasoningCharacters = 0, visibleCharacters = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { doneMarker = true; continue; }
        const event = JSON.parse(data);
        if (event.error) throw reason('provider-error');
        const choice = event.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content || delta?.reasoning_content || delta?.reasoning) {
          firstTokenMs ??= performance.now() - started; onProgress();
        }
        if (event.timings) backendTimings = Object.fromEntries(['prompt_n', 'prompt_ms', 'predicted_n', 'predicted_ms', 'predicted_per_second'].filter(key => Number.isFinite(event.timings[key])).map(key => [key, event.timings[key]]));
        if (delta?.tool_calls?.length) invalid = true;
        reasoningCharacters += (delta?.reasoning_content ?? delta?.reasoning ?? '').length;
        visibleCharacters += (delta?.content ?? '').length;
        content += delta?.content ?? '';
        finish = choice?.finish_reason ?? finish;
        usage = event.usage ?? usage;
      }
    }
    if (!doneMarker || pending.trim() || invalid) throw reason('incomplete-response');
    return { choices: [{ finish_reason: finish, message: { content } }], usage, structuredOutput, compactionStreamDiagnostics: { reasoningCharacters, visibleCharacters, doneMarker }, compactionPerformance: { timeToFirstTokenMs: firstTokenMs,
      durationMs: performance.now() - started, backendTimings,
      reasoningControlStatus: reasoningCharacters > 0 && request.chat_template_kwargs?.enable_thinking === false ? 'disable-request-ignored-or-partial' : 'not-verified' } };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
module.exports = { reason, abortCode, createGenerationRuntime, generateLocalCandidate };

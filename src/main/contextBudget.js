'use strict';
const { createHash } = require('node:crypto');

class ContextBudgetError extends Error {
  constructor(detail = '') {
    super(`This request cannot fit the model context${detail ? ` (${detail})` : ''}. Required instructions, tools, attachments or protected recent turns may be too large. Reduce the attachment/tool set or continue in a fresh session; your saved history is preserved.`);
    this.name = 'ContextBudgetError';
    this.code = 'CONTEXT_BUDGET_EXCEEDED';
  }
}
function isContextOverflow(error) {
  if (error?.name === 'AbortError') return false;
  if (error?.code === 'CONTEXT_BUDGET_EXCEEDED') return true;
  if (error?.status !== 400) return false;
  let body;
  try { body = JSON.parse(error.responseBody); } catch { return false; }
  const detail = body?.error ?? body;
  return detail?.type === 'exceed_context_size_error' || detail?.code === 'exceed_context_size_error' ||
    (Number.isFinite(detail?.n_prompt_tokens) && Number.isFinite(detail?.n_ctx) && detail.n_prompt_tokens > detail.n_ctx);
}
function reserveTokens(payload, limit) {
  const output = payload.max_tokens > 0 ? payload.max_tokens : Math.min(1024, Math.floor(limit / 4));
  const thinking = Math.max(0, payload.max_thinking_tokens ?? payload.thinking_budget ?? payload.reasoning_budget ?? 0);
  // Thinking is part of generated output, not a second independent allowance.
  return Math.max(output, thinking) + Math.min(128, Math.ceil(limit / 100));
}
function approximateTokens(payload) {
  let images = 0;
  const text = JSON.stringify(payload, (key, value) => {
    if (key === 'image_url' && value) { images++; return '[image tokens unknown]'; }
    return value;
  });
  // Fallback only: full serialized request, conservative text/role allowance.
  // Image patch counts and model templates are unknown. Reactive recovery is
  // still required; this number is deliberately never labeled exact.
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3) + (payload.messages?.length ?? 0) * 32 + images * 4096;
}
function createContextGuardedFetch(fetchImpl) {
  const counts = new Map();
  async function measure(url, payload, options, knownLimit) {
    const signal = options.signal;
    signal?.throwIfAborted();
    let limit = knownLimit ?? options.contextWindowLimit;
    let props;
    const probeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500);
    const probe = async (route, body) => {
      const response = await fetchImpl(new URL(route, url).href, {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: probeSignal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Counting endpoint unavailable'); }
      return response.json();
    };
    try {
      props = await probe('/props');
      const reported = props?.default_generation_settings?.n_ctx;
      if (Number.isSafeInteger(reported) && reported > 0) limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, reported) : reported;
    } catch { signal?.throwIfAborted(); }
    if (!Number.isSafeInteger(limit) || limit <= 0) limit = 8192;
    let tokens, method = 'approximate-full-request';
    const multimodal = payload.messages.some(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url'));
    // Reuse only after verifying the same server model/template/context through
    // props. Cache is bounded; unavailable props and images are never cached.
    const identity = typeof props?.model_path === 'string' && typeof props?.chat_template === 'string' && JSON.stringify([props.model_path, props.chat_template, props.default_generation_settings?.n_ctx]);
    const key = !multimodal && identity && createHash('sha256').update(url + identity + JSON.stringify(payload)).digest('hex');
    if (!multimodal && key && counts.has(key)) { tokens = counts.get(key); method = 'server-template-tokenizer'; }
    else if (!multimodal) {
      try {
        const rendered = await probe('/apply-template', { ...payload, stream: false });
        if (typeof rendered.prompt !== 'string' || !rendered.prompt.length) throw new Error('Missing template');
        // Old servers may ignore tools in /apply-template. Never claim their
        // message-only template measures a tool-bearing request.
        if ((payload.tools ?? []).some(tool => !rendered.prompt.includes(tool.function?.name) || (tool.function?.description &&
          !rendered.prompt.includes(tool.function.description) && !rendered.prompt.includes(JSON.stringify(tool.function.description).slice(1, -1))))) throw new Error('Tools absent from template');
        const counted = await probe('/tokenize', { content: rendered.prompt, add_special: true, parse_special: true });
        if (!Array.isArray(counted.tokens)) throw new Error('Missing token count');
        tokens = counted.tokens.length; method = 'server-template-tokenizer';
        if (key) { if (counts.size >= 64) counts.delete(counts.keys().next().value); counts.set(key, tokens); }
      } catch { signal?.throwIfAborted(); }
    }
    tokens ??= approximateTokens(payload);
    return { tokens, method, limit, budget: limit - reserveTokens(payload, limit) };
  }
  return async function guardedFetch(url, options = {}) {
    if ((options.method ?? 'GET').toUpperCase() !== 'POST' || new URL(url).pathname !== '/v1/chat/completions') return fetchImpl(url, options);
    let payload;
    try { payload = JSON.parse(options.body); } catch { return fetchImpl(url, options); }
    if (!Array.isArray(payload.messages)) return fetchImpl(url, options);
    const normalize = value => {
      const system = value.messages.filter(message => message.role === 'system');
      return system.length > 1 ? { ...value, messages: [{ role: 'system', content: system.map(message => message.content ?? '').join('\n\n') }, ...value.messages.filter(message => message.role !== 'system')] } : value;
    };
    payload = normalize(payload);
    const { contextWindowLimit, contextRecovery, ...wireOptions } = options;
    let recovered = false, knownLimit;
    const recover = async (reason) => {
      options.signal?.throwIfAborted();
      if (recovered || typeof contextRecovery !== 'function') throw new ContextBudgetError(reason);
      recovered = true;
      const previous = JSON.stringify({ messages: payload.messages, tools: payload.tools, chat_template_kwargs: payload.chat_template_kwargs });
      let rebuilt;
      try { rebuilt = await contextRecovery({ payload, contextWindowLimit: knownLimit ?? contextWindowLimit ?? 8192, reason }); }
      catch (error) {
        options.signal?.throwIfAborted();
        if (error?.name === 'AbortError' || error?.code === 'CONTEXT_BUDGET_EXCEEDED') throw error;
        throw new ContextBudgetError(`summarization/rebuild failed: ${error.message}`);
      }
      options.signal?.throwIfAborted();
      if (!rebuilt || !Array.isArray(rebuilt.messages)) throw new ContextBudgetError(reason);
      if (previous === JSON.stringify({ messages: rebuilt.messages, tools: rebuilt.tools, chat_template_kwargs: rebuilt.chat_template_kwargs })) throw new ContextBudgetError('compression did not reduce or rebuild the request');
      payload = normalize(rebuilt);
    };
    const check = async () => {
      let usage = await measure(url, payload, options, knownLimit);
      knownLimit = usage.limit;
      if (usage.tokens > usage.budget) {
        await recover(`${usage.tokens} ${usage.method} input tokens; budget ${usage.budget}`);
        usage = await measure(url, payload, options, knownLimit);
        if (usage.tokens > usage.budget) throw new ContextBudgetError(`${usage.tokens} ${usage.method} input tokens; budget ${usage.budget}`);
      }
    };
    await check();
    options.signal?.throwIfAborted();
    let response = await fetchImpl(url, { ...wireOptions, body: JSON.stringify(payload) });
    if (response.status !== 400) return response;
    const body = await response.clone().text();
    if (!isContextOverflow({ status: 400, responseBody: body })) return response;
    await response.body?.cancel();
    let detail; try { detail = JSON.parse(body).error ?? JSON.parse(body); } catch { /* classification already checked */ }
    if (Number.isSafeInteger(detail?.n_ctx) && detail.n_ctx > 0) knownLimit = Math.min(knownLimit, detail.n_ctx);
    await recover(`backend reported ${detail?.n_prompt_tokens ?? 'too many'} input tokens`);
    await check();
    options.signal?.throwIfAborted();
    response = await fetchImpl(url, { ...wireOptions, body: JSON.stringify(payload) });
    if (response.status === 400 && isContextOverflow({ status: 400, responseBody: await response.clone().text() })) {
      await response.body?.cancel();
      throw new ContextBudgetError('the single recovery retry also exceeded context');
    }
    return response;
  };
}
module.exports = { createContextGuardedFetch, ContextBudgetError, isContextOverflow, approximateTokens };

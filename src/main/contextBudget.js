'use strict';
const { createHash } = require('node:crypto');
const { mergeSystemMessages } = require('../lib/systemMessages.cjs');

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
  return ['context_length_exceeded', 'prompt_too_long'].includes(detail?.code) ||
    (detail?.type === 'invalid_request_error' && /prompt is too long|input length.*exceeds.*context/i.test(detail?.message ?? '')) ||
    detail?.type === 'exceed_context_size_error' || detail?.code === 'exceed_context_size_error' ||
    (Number.isFinite(detail?.n_prompt_tokens) && Number.isFinite(detail?.n_ctx) && detail.n_prompt_tokens > detail.n_ctx);
}
let runtimeProvider = () => null;
function setContextRuntimeProvider(provider) { runtimeProvider = provider; }
function runtimeIdentityFor(url) {
  const runtime = runtimeProvider();
  return runtime && Number(new URL(url).port) === runtime.port ? runtime.runtimeIdentity ?? null : null;
}
function reserveTokens(payload, limit) {
  const output = payload.max_tokens > 0 ? payload.max_tokens : Math.min(1024, Math.floor(limit / 4));
  // `reasoning_budget_tokens` is the installed local runtime's field; the
  // others are legacy aliases that old callers/tests may still pass.
  const thinking = Math.max(0, payload.reasoning_budget_tokens ?? payload.max_thinking_tokens
    ?? payload.thinking_budget ?? payload.reasoning_budget ?? 0);
  // Thinking is part of generated output, not a second independent allowance.
  return Math.max(output, thinking) + Math.min(128, Math.ceil(limit / 100));
}
// Capacity and occupancy are independent: cached input still occupies context.
function createRuntimeBudget({ provider = 'local', modelId = null, runtimeIdentity = null,
  configuredContextTokens = null, runtimeContextTokens = null, fallbackCeilingTokens = 8192, payload = {},
  currentInputTokens = null, measurementMethod = 'approximate-full-request' } = {}) {
  const valid = n => Number.isSafeInteger(n) && n > 0;
  const verified = valid(runtimeContextTokens);
  // Offline local totals may be shared by unknown slots. Bound the fallback;
  // never divide configured totals and present the quotient as measured.
  const limit = verified ? runtimeContextTokens : Math.min(valid(configuredContextTokens) ? configuredContextTokens : 8192, valid(fallbackCeilingTokens) ? Math.min(8192, fallbackCeilingTokens) : 8192);
  const reserve = reserveTokens(payload, limit);
  if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve >= limit)
    throw new ContextBudgetError('invalid output/reasoning reservation');
  const safety = Math.min(128, Math.ceil(limit / 100));
  const usableInputTokens = limit - reserve;
  return { provider, modelId, runtimeIdentity, configuredContextTokens,
    runtimeContextTokens: verified && provider === 'local' ? runtimeContextTokens : null,
    advertisedContextTokens: verified && provider !== 'local' ? runtimeContextTokens : null,
    capacityTokens: limit, reservedOutputTokens: reserve - safety, reservedSafetyTokens: safety,
    usableInputTokens, autoCompactionThresholdRatio: 0.90,
    autoCompactionTriggerTokens: Math.floor(usableInputTokens * 0.90),
    currentInputTokens, measurementMethod,
    capacityMethod: verified ? (provider === 'local' ? 'runtime-reported' : 'provider-advertised') : 'conservative-fallback',
    capacityConfidence: verified && provider === 'local' ? 'verified' : 'unverified',
    measurementConfidence: measurementMethod === 'server-template-tokenizer' ? 'measured' : 'estimated' };
}
function atCompactionPressure(budget) {
  return budget.currentInputTokens >= budget.autoCompactionTriggerTokens;
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
// Templates may reformat JSON, so check schema keys/string values rather than
// byte-for-byte JSON. Missing schema material invalidates the exact-count claim;
// the full-request estimate and bounded backend recovery remain the fallback.
function templateIncludesSchema(prompt, schema) {
  const contains = value => prompt.includes(value) || prompt.includes(JSON.stringify(value).slice(1, -1));
  if (typeof schema === 'string') return contains(schema);
  if (Array.isArray(schema)) return schema.every(value => templateIncludesSchema(prompt, value));
  if (schema && typeof schema === 'object') return Object.entries(schema).every(([key, value]) =>
    contains(key) && templateIncludesSchema(prompt, value));
  return schema == null || prompt.includes(String(schema));
}
// Standalone measurer over the same server-template/tokenizer path the guard
// uses: /props capability check, /apply-template rendering, /tokenize count,
// SHA-256 cache keyed on model/template/context/payload, and the documented
// approximate fallback (explicitly labeled, never exact). Lets pre-commit
// verification measure a prospective prompt without sending it.
function createPromptMeasurer(fetchImpl) {
  const counts = new Map();
  async function measure(url, payload, options = {}, knownLimit) {
    const runtimeAtStart = runtimeIdentityFor(url);
    const signal = options.signal;
    signal?.throwIfAborted();
    let limit = knownLimit ?? options.contextWindowLimit;
    let props, runtimeContextTokens = null;
    const probeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500);
    const probe = async (route, body) => {
      const response = await fetchImpl(new URL(route, url).href, {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: probeSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const detail = await response.text().catch(() => '');
        const error = new Error(`Counting endpoint ${route} failed (HTTP ${response.status})`);
        error.status = response.status;
        error.responseBody = detail.slice(0, 300);
        throw error;
      }
      return response.json();
    };
    try {
      props = await probe('/props');
      const reported = props?.default_generation_settings?.n_ctx;
      if (Number.isSafeInteger(reported) && reported > 0) {
        runtimeContextTokens = knownLimit ? Math.min(knownLimit, reported) : reported;
        limit = runtimeContextTokens;
      }
    } catch { signal?.throwIfAborted(); }
    if (!Number.isSafeInteger(limit) || limit <= 0) limit = 8192;
    let tokens, method = 'approximate-full-request', note = null;
    const multimodal = payload.messages.some(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url'));
    // Reuse only after verifying the same server model/template/context through
    // props. Cache is bounded; unavailable props and images are never cached.
    const identity = typeof props?.model_path === 'string' && typeof props?.chat_template === 'string' && JSON.stringify([props.model_path, props.chat_template, props.default_generation_settings?.n_ctx]);
    const key = !multimodal && identity && createHash('sha256').update(url + (options.runtimeIdentity ?? runtimeAtStart ?? '') + identity + JSON.stringify(payload)).digest('hex');
    if (!multimodal && key && counts.has(key)) { ({ tokens, method, note } = counts.get(key)); }
    else if (!multimodal) {
      try {
        // Strict templates (e.g. Qwen) accept a single leading system turn
        // and require a user message. Measure the merged wire shape, exactly
        // as inference sends it, so template-capable backends count exactly.
        const merged = mergeSystemMessages(payload.messages);
        const rendered = await probe('/apply-template', { ...payload, messages: merged, stream: false });
        if (typeof rendered.prompt !== 'string' || !rendered.prompt.length) throw new Error('Missing template');
        // Old servers may ignore tools in /apply-template. Never claim their
        // message-only template measures a tool-bearing request.
        if ((payload.tools ?? []).some(tool => !rendered.prompt.includes(tool.function?.name) || (tool.function?.description &&
          !rendered.prompt.includes(tool.function.description) && !rendered.prompt.includes(JSON.stringify(tool.function.description).slice(1, -1))) ||
          !templateIncludesSchema(rendered.prompt, tool.function?.parameters))) throw new Error('Tools absent from template');
        const counted = await probe('/tokenize', { content: rendered.prompt, add_special: true, parse_special: true });
        if (!Array.isArray(counted.tokens)) throw new Error('Missing token count');
        tokens = counted.tokens.length; method = 'server-template-tokenizer';
        if (key) { if (counts.size >= 64) counts.delete(counts.keys().next().value); counts.set(key, { tokens, method, note }); }
      } catch (error) {
        signal?.throwIfAborted();
        // A template rejection must stay a labeled fallback, never the silent
        // normal path. Empty initial chats carry no user turn yet, which
        // strict templates reject outright; record why instead of pretending.
        if (!payload.messages.some(message => message.role === 'user')) note = 'no-user-message';
        else if (error?.status === 500 && /no user query|system message must be/i.test(error?.responseBody ?? '')) note = 'template-rejected-prompt-shape';
        else if (/tools absent from template/i.test(error?.message ?? '')) note = 'tools-absent-from-template';
        else note = 'tokenizer-measurement-failed';
      }
    }
    tokens ??= approximateTokens(payload);
    if (!multimodal && key && !counts.has(key)) {
      if (counts.size >= 64) counts.delete(counts.keys().next().value);
      counts.set(key, { tokens, method, note });
    }
    if (runtimeAtStart !== runtimeIdentityFor(url)) throw new ContextBudgetError('backend changed during measurement');
    const budgetContract = createRuntimeBudget({ modelId: payload.model,
      runtimeIdentity: options.runtimeIdentity ?? runtimeAtStart ?? identity ?? url,
      configuredContextTokens: options.contextWindowLimit ?? null,
      runtimeContextTokens, fallbackCeilingTokens: knownLimit ?? 8192, payload, currentInputTokens: tokens, measurementMethod: method });
    const imageCount = payload.messages.reduce((n, message) => n + (Array.isArray(message.content)
      ? message.content.filter(part => part?.type === 'image_url').length : 0), 0);
    return { tokens, method, limit: budgetContract.capacityTokens, budget: budgetContract.usableInputTokens,
      budgetContract, imageCount, imageAllowanceTokens: imageCount * 4096,
      ...(multimodal ? { note: 'image-tokens-estimated' } : note ? { note } : {}) };
  }
  return measure;
}
function createContextGuardedFetch(fetchImpl) {
  const measure = createPromptMeasurer(fetchImpl);
  const guardedFetch = async function guardedFetch(url, options = {}) {
    if ((options.method ?? 'GET').toUpperCase() !== 'POST' || new URL(url).pathname !== '/v1/chat/completions') return fetchImpl(url, options);
    let payload;
    try { payload = JSON.parse(options.body); } catch { return fetchImpl(url, options); }
    if (!Array.isArray(payload.messages)) return fetchImpl(url, options);
    const normalize = value => ({ ...value, messages: mergeSystemMessages(value.messages) });
    payload = normalize(payload);
    const { contextWindowLimit, contextRecovery, modelRequestBudget, ...wireOptions } = options;
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
        if (error?.name === 'AbortError' || error?.code === 'CONTEXT_BUDGET_EXCEEDED' || error?.code === 'SUBAGENT_BUDGET_EXCEEDED') throw error;
        throw new ContextBudgetError(`summarization/rebuild failed: ${error.message}`);
      }
      options.signal?.throwIfAborted();
      if (!rebuilt || !Array.isArray(rebuilt.messages)) throw new ContextBudgetError(reason);
      if (previous === JSON.stringify({ messages: rebuilt.messages, tools: rebuilt.tools, chat_template_kwargs: rebuilt.chat_template_kwargs })) throw new ContextBudgetError('compression did not reduce or rebuild the request');
      payload = normalize(rebuilt);
    };
    const check = async () => {
      if (modelRequestBudget) payload = normalize(modelRequestBudget.prepare(payload));
      let usage = await measure(url, payload, options, knownLimit);
      knownLimit = usage.limit;
      if (usage.tokens > usage.budget) {
        await recover(`${usage.tokens} ${usage.method} input tokens; budget ${usage.budget}`);
        usage = await measure(url, payload, options, knownLimit);
        if (usage.tokens > usage.budget) throw new ContextBudgetError(`${usage.tokens} ${usage.method} input tokens; budget ${usage.budget}`);
      }
      return usage;
    };
    const send = async (measured) => {
      const reservation = modelRequestBudget?.beforeRequest(payload, measured);
      if (reservation) payload = normalize(reservation.payload);
      const response = await fetchImpl(url, { ...wireOptions, body: JSON.stringify(payload) });
      if (reservation) modelRequestBudget.trackResponse(response, reservation);
      return response;
    };
    let measured = await check();
    options.signal?.throwIfAborted();
    let response = await send(measured);
    if (response.status !== 400) return response;
    const body = await response.clone().text();
    if (!isContextOverflow({ status: 400, responseBody: body })) return response;
    await response.body?.cancel();
    let detail; try { detail = JSON.parse(body).error ?? JSON.parse(body); } catch { /* classification already checked */ }
    if (Number.isSafeInteger(detail?.n_ctx) && detail.n_ctx > 0) knownLimit = Math.min(knownLimit, detail.n_ctx);
    try { await recover(`backend reported ${detail?.n_prompt_tokens ?? 'too many'} input tokens`); }
    catch (error) { error.confirmedOverflow = true; error.contextWindowLimit = knownLimit; throw error; }
    measured = await check();
    options.signal?.throwIfAborted();
    response = await send(measured);
    if (response.status === 400 && isContextOverflow({ status: 400, responseBody: await response.clone().text() })) {
      await response.body?.cancel();
      const error = new ContextBudgetError('the single recovery retry also exceeded context');
      error.confirmedOverflow = true; error.contextWindowLimit = knownLimit; throw error;
    }
    return response;
  };
  guardedFetch.contextGuarded = true;
  return guardedFetch;
}
module.exports = { setContextRuntimeProvider, createRuntimeBudget, atCompactionPressure, createContextGuardedFetch, createPromptMeasurer, ContextBudgetError, isContextOverflow, approximateTokens, reserveTokens };

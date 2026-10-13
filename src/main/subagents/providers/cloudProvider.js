'use strict';

const { readCompletion } = require('./streamCompletion');

// Inference provider for a saved cloud provider + model (the same
// { type: 'cloud', provider, model } target the main chat uses through
// ../cloudProviders.js createCloudFetch). Registered next to the local
// provider, so an engine descriptor with `provider: 'cloud'` reaches it
// through the normal resolveProvider() path — no scheduling code knows
// anything about cloud vs local.
//
// Transport is a provider decision: this provider always builds its own cloud
// fetch from the saved provider and deliberately ignores a caller-supplied
// `fetchImpl`. The forwarded fetch is the local server's (tests and the legacy
// runner pass it), and a local POST must never ride a cloud lane.
//
// Stream when an activity observer is supplied; JSON-only providers still
// return their original completion shape through readCompletion.
const cloudProviders = require('../../cloudProviders');

const PROVIDER_ID = 'cloud';
// How many generations one cloud provider/model lane may run at once. Like the
// local default, this is a scheduling slot count declared by the provider, not
// a hardware fact — a cloud lane has no local server's single-slot constraint,
// and an engine descriptor may still override it with `maxConcurrency`.
const DEFAULT_MAX_CONCURRENCY = 4;
// Placeholder endpoint: the cloud transport builds the real URL from the saved
// provider and ignores this one (the same convention as the chat's cloud base
// URL). It only has to be a well-formed absolute URL.
const REQUEST_URL = 'https://cloud.invalid/v1/chat/completions';

async function chatCompletion({ engine, payload, signal, allowTools = false, onProgress, budgetState }) {
  // Fail closed: an allowTools caller without tool schemas gets a tool-free
  // request, mirroring the local provider's invariant.
  const toolsAllowed = allowTools === true && Array.isArray(payload.tools) && payload.tools.length > 0;
  // createCloudFetch validates the target (saved provider, stored model) and
  // throws a clean, credential-safe error when it is gone or has no API key.
  let fetchImpl = cloudProviders.createCloudFetch(engine.chatTarget, { stream: typeof onProgress === 'function',
    onErrorResponse: async response => {
      if (response.status !== 400) return;
      const body = await response.clone().text();
      const context = require('../../contextBudget');
      if (context.isContextOverflow({ status: 400, responseBody: body })) {
        const error = new context.ContextBudgetError('provider context overflow');
        error.confirmedOverflow = true; throw error;
      }
    } });
  if (budgetState) fetchImpl = require('../executionBudget').budgetedFetch(fetchImpl, budgetState);
  const response = await fetchImpl(REQUEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      ...payload,
      stream: typeof onProgress === 'function',
      ...(toolsAllowed
        ? { tool_choice: payload.tool_choice ?? 'auto' }
        : { tools: [], tool_choice: 'none' }),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, status: response.status };
  }
  const result = await readCompletion(response, onProgress);
  if (budgetState) require('../executionBudget').settleResponse(response, result?.usage);
  return { ok: true, result };
}

// The capability the scheduler gates on: which provider, which model, and how
// many simultaneous generations that provider/model allows. The lane's model
// key includes the saved provider id, so two providers that happen to offer
// the same model id never share a queue.
function capability(engine) {
  if (typeof engine?.modelId !== 'string' || !engine.modelId.trim()) {
    throw new Error('Inference capability requires a model id.');
  }
  const target = engine.chatTarget;
  if (target?.type !== 'cloud' || typeof target.provider !== 'string' || !target.provider.trim() ||
      typeof target.model !== 'string' || !target.model.trim()) {
    throw new Error('Inference capability requires a saved cloud provider target.');
  }
  const requested = engine.maxConcurrency;
  return {
    provider: PROVIDER_ID,
    model: `${target.provider}/${engine.modelId}`,
    maxConcurrency: Number.isSafeInteger(requested) && requested >= 1
      ? requested : DEFAULT_MAX_CONCURRENCY,
  };
}

module.exports = { chatCompletion, PROVIDER_ID, DEFAULT_MAX_CONCURRENCY, capability };

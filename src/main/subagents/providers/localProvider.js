'use strict';

const { localEngineFetch } = require('../../localEngineFetch');

// Inference provider for the already-running local model server. The runtime
// depends on this contract instead of the HTTP transport, so other providers can
// be added later without touching session or execution logic.
//
// Every sub-agent request is a single non-streaming POST that never carries
// tools; the no-tool invariant is enforced here so no execution can opt back in.
// Returns { ok: true, result } on a parsed response, or { ok: false, status }
// after cancelling an error body — the execution layer owns the error messages.
async function chatCompletion({ engine, payload, signal, fetchImpl = localEngineFetch }) {
  const response = await fetchImpl(`http://127.0.0.1:${engine.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ ...payload, stream: false, tools: [], tool_choice: 'none' }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, status: response.status };
  }
  return { ok: true, result: await response.json() };
}

const PROVIDER_ID = 'local';
// How many generations one local provider/model lane may run at once. This is a
// scheduling slot count, not a hardware fact: nothing here names GPUs, VRAM, or
// device memory. The default is one — a single model server serving one
// generation — and an engine descriptor may raise it explicitly for its model
// (see capability() below).
const DEFAULT_MAX_CONCURRENCY = 1;

// The capability the scheduler gates on: which provider, which model, and how
// many simultaneous generations that provider/model allows. It is the only
// thing the scheduler reads about a provider; transport stays in chatCompletion.
function capability(engine) {
  if (typeof engine?.modelId !== 'string' || !engine.modelId.trim()) {
    throw new Error('Inference capability requires a model id.');
  }
  const requested = engine.maxConcurrency;
  return {
    provider: PROVIDER_ID,
    model: engine.modelId,
    maxConcurrency: Number.isSafeInteger(requested) && requested >= 1
      ? requested : DEFAULT_MAX_CONCURRENCY,
  };
}

module.exports = { chatCompletion, PROVIDER_ID, DEFAULT_MAX_CONCURRENCY, capability };

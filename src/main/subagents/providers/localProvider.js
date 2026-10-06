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

module.exports = { chatCompletion };

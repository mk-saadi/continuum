const assert = require('node:assert/strict');
const { createContextGuardedFetch } = require('../../src/main/contextBudget');
const overflow = () => new Response(JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 8619, n_ctx: 8192 } }), { status: 400 });
function backend({ tokens = 100, infer = () => new Response('{}'), available = true, context = 8192, omitTools = false } = {}) {
  const calls = [], probes = [];
  let template = 'template';
  const raw = async (url, options) => {
    const route = new URL(url).pathname;
const payload = options.body && JSON.parse(options.body);
    if (route === '/v1/chat/completions') { calls.push(payload); return infer(payload, calls.length, options); }
    probes.push(route);
    if (!available) return new Response('', { status: 404 });
    if (route === '/props') return Response.json({ model_path: 'loaded', chat_template: template, default_generation_settings: { n_ctx: context } });
    if (route === '/apply-template') return Response.json({ prompt: JSON.stringify(omitTools ? payload.messages : payload) });
    if (route === '/tokenize') return Response.json({ tokens: Array(typeof tokens === 'function' ? tokens(payload.content) : tokens).fill(1) });
    assert.fail(route);
  };
  return { fetch: createContextGuardedFetch(raw), calls, probes, setTemplate: value => { template = value; } };
}
module.exports = { backend, overflow };

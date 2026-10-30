'use strict';
// A deterministic TEST tokenizer reached through the production template/tokenize
// path. This is not Qwen or real-model tokenization. Only summary probes use it;
// the existing suites retain their original full-request measurements.
const { createPromptMeasurer, approximateTokens } = require('../../src/main/contextBudget');
const count = createPromptMeasurer(async (url, options) => {
  if (url.endsWith('/props')) return Response.json({ default_generation_settings: { n_ctx: 131072 } });
  if (url.endsWith('/apply-template')) return Response.json({ prompt: JSON.stringify(JSON.parse(options.body).messages) });
  if (url.endsWith('/tokenize')) return Response.json({ tokens: Array(approximateTokens({ messages: JSON.parse(JSON.parse(options.body).content) })).fill(1) });
  throw new Error('Unexpected fixture endpoint');
});
const isSummary = request => request.messages?.[0]?.content?.startsWith?.('# Working Summary');
const summaryMeasurement = request => count('http://c9-tokenizer.invalid/v1/chat/completions', request, { contextWindowLimit: 131072 });
// Synthetic authoritative adapter for tests that previously omitted request
// counting. Explicit null/estimated results from a supplied adapter stay intact.
const withSummaryTokenizer = (measure, summaryOverride) => async (request, ...args) => isSummary(request) ? (summaryOverride ?? summaryMeasurement)(request) : measure ? measure(request, ...args) : { tokens: approximateTokens(request), limit: 131072, method: 'server-template-tokenizer' };
module.exports = { withSummaryTokenizer, summaryMeasurement, isSummary };

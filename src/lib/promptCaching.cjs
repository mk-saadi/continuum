'use strict';

// Provider-aware prompt-cache request fields (Phase 2.0C-2, corrected in
// Phase 2.0C-2A for direct Anthropic stable-prefix reuse).
//
// Prompt caching is a *provider capability*, not a client-wide switch. This
// module turns the actual request target (API type, base URL and model ID) into
// the cache-control fields that provider documents, and nothing more:
//
//   - Direct Anthropic Messages API: a single explicit `cache_control` marker
//     on the first (stable) system block. The marker caches tools + that system
//     block, so changing user turns and later per-turn system blocks cannot
//     invalidate it. Automatic top-level caching is used only when no eligible
//     stable boundary exists (it would otherwise land on the changing tail).
//     https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   - OpenRouter: OpenAI, DeepSeek, Google (implicit), Grok, Moonshot, Groq and
//     Z.AI cache automatically with no request field at all. Anthropic models
//     routed through OpenRouter use the top-level ephemeral field. Every other
//     OpenRouter family must NOT receive Anthropic-only fields, so an unknown
//     vendor gets no cache field (safe fallback).
//     https://openrouter.ai/docs/features/prompt-caching
//   - Any other OpenAI-compatible endpoint keeps its existing behavior; no
//     cache field is invented for it.
//
// The 5-minute ephemeral TTL is the only cache policy used. No 1-hour TTL and
// no second breakpoint are introduced.

const { providerFamily } = require('./reasoningControls.cjs');

// OpenRouter IDs for Claude are `anthropic/<model>` (and the `~anthropic/`
// newest-alias form). Aliases are matched by prefix, never by a hard-coded
// model list, so new Claude versions keep working without a code change.
const OPENROUTER_ANTHROPIC = /^(?:~)?anthropic\//i;

const EPHEMERAL = Object.freeze({ type: 'ephemeral' });

function openRouterAnthropic(modelId) {
  return OPENROUTER_ANTHROPIC.test(String(modelId || '').trim());
}

// Anthropic's minimum cacheable prefix depends on the model family. A
// breakpoint below the minimum is harmless (the request is processed without
// caching and no error is returned), but skipping it avoids an ineffective
// write. Unknown models use the conservative Sonnet 5 floor.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
const MIN_CACHEABLE_TOKENS_DEFAULT = 1024;

function minimumCacheableTokens(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/sonnet-5\.5/.test(id)) return 512;
  if (/sonnet-5(?!\.\d)/.test(id)) return 1024;
  if (/opus-5|fable-5|mythos-5|haiku-5\.5/.test(id)) return 512;
  if (/opus-4\.8/.test(id)) return 1024;
  if (/opus-4\.[56]/.test(id)) return 4096;
  if (/opus-4\.7/.test(id)) return 2048;
  if (/haiku-4\.5/.test(id)) return 4096;
  if (/haiku-3\.5/.test(id)) return 2048;
  return MIN_CACHEABLE_TOKENS_DEFAULT;
}

// Four characters per token is a deliberately rough estimate. It is only used
// to decide whether a stable boundary is plausibly cacheable; an underestimate
// skips an eligible breakpoint, which is safer than claiming a cache that will
// not happen. Tools are included because Anthropic orders the cache prefix as
// tools -> system -> messages.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function asSystemBlocks(system) {
  if (typeof system === 'string') return system ? [{ type: 'text', text: system }] : [];
  return Array.isArray(system) ? system : [];
}

function firstStableSystemIndex(blocks) {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return index;
    }
  }
  return -1;
}

function countExplicitBreakpoints(body) {
  let count = 0;
  for (const block of asSystemBlocks(body?.system)) if (block?.cache_control) count++;
  for (const tool of body?.tools || []) if (tool?.cache_control) count++;
  return count;
}

function prefixText(body, boundary) {
  const tools = Array.isArray(body.tools) ? JSON.stringify(body.tools) : '';
  if (boundary.kind === 'tools') return tools;
  const blocks = asSystemBlocks(body.system).slice(0, boundary.index + 1);
  return tools + blocks.map((block) => block.text || '').join('');
}

/**
 * Decide how a direct Anthropic request should be cached.
 *
 * Continuum's prompt builder guarantees that the *first* system block is the
 * stable base instruction prefix (temporal anchor + base prompt). Later system
 * blocks carry per-turn context (briefs, checkpoints, summaries, work log,
 * plans, skills) that may change between requests. A breakpoint is therefore
 * placed on the first system block, not the last: the last system block is the
 * one most likely to change, and a cache write at a changing boundary is never
 * read back.
 *
 * If there is no usable system block, the last tool definition is the stable
 * boundary (tools precede system in Anthropic's cache hierarchy). If neither
 * exists, caching falls back to Anthropic's automatic top-level field.
 *
 * @returns {{ strategy: 'explicit'|'automatic'|'preserve', kind: string|null,
 *   index: number, tokens: number, minimum: number }}
 */
function anthropicCachePlan(body, { modelId } = {}) {
  const minimum = minimumCacheableTokens(modelId);
  const automatic = { strategy: 'automatic', kind: null, index: -1, tokens: 0, minimum };
  if (!body || typeof body !== 'object') return automatic;

  // Never add a second strategy on top of caller-provided explicit markers.
  if (countExplicitBreakpoints(body) > 0) return { ...automatic, strategy: 'preserve' };

  const systemIndex = firstStableSystemIndex(asSystemBlocks(body.system));
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const boundary = systemIndex >= 0
    ? { kind: 'system', index: systemIndex }
    : hasTools ? { kind: 'tools', index: body.tools.length - 1 } : null;
  if (!boundary) return automatic;

  const tokens = estimateTokens(prefixText(body, boundary));
  if (tokens < minimum) {
    // Too short to cache at a stable boundary. Automatic remains a safe
    // fallback: it is a no-op below the minimum and can still help a long,
    // growing message history.
    return { ...automatic, kind: boundary.kind, index: boundary.index, tokens };
  }
  return { strategy: 'explicit', ...boundary, tokens, minimum };
}

/**
 * Apply the direct-Anthropic cache strategy to an already-built Messages body.
 *
 * Exactly one strategy is emitted: an explicit breakpoint on the stable prefix,
 * or the top-level automatic field, or (when the caller already marked blocks)
 * nothing at all. The top-level field is always removed first so a previous
 * automatic decision can never coexist with an explicit one.
 *
 * @param {object} body Anthropic Messages request body
 * @param {{ modelId?: string }} [options]
 * @returns {object} a shallow copy with cache fields applied
 */
function applyAnthropicCaching(body, { modelId } = {}) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  delete next.cache_control;

  const plan = anthropicCachePlan(body, { modelId });
  if (plan.strategy === 'preserve') return next;

  if (plan.strategy === 'explicit') {
    if (plan.kind === 'system') {
      next.system = asSystemBlocks(body.system).map((block, index) =>
        index === plan.index ? { ...block, cache_control: { ...EPHEMERAL } } : block);
    } else {
      next.tools = body.tools.map((tool, index) =>
        index === plan.index ? { ...tool, cache_control: { ...EPHEMERAL } } : tool);
    }
    return next;
  }

  next.cache_control = { ...EPHEMERAL };
  return next;
}

/**
 * The cache-control fields a request to `target` should carry, or an empty
 * object when caching is automatic server-side, unsupported, or handled by the
 * explicit Anthropic strategy (`applyAnthropicCaching`).
 *
 * @param {{ apiType?: string, baseUrl?: string, modelId?: string }} target
 * @returns {{ cache_control?: { type: 'ephemeral' } }}
 */
function cacheRequestFields({ apiType, baseUrl, modelId } = {}) {
  const family = providerFamily({ apiType, baseUrl });
  // Direct Anthropic uses block-scoped explicit breakpoints so the cache
  // boundary stays on the stable prefix instead of the changing tail.
  if (family === 'anthropic') return {};
  if (family === 'openrouter' && openRouterAnthropic(modelId)) {
    return { cache_control: { ...EPHEMERAL } };
  }
  return {};
}

/**
 * Descriptive capability view for reporting and tests. It never adds wire
 * fields; `cacheRequestFields` is the single source of request behavior.
 *
 * `mode`:
 *   - 'explicit': the provider accepts block-level breakpoints; direct
 *      Anthropic places one on the stable base system block.
 *   - 'automatic': the provider caches automatically. OpenRouter-Anthropic
 *      accepts the top-level `cache_control` field.
 *   - 'server-side': the provider caches implicitly and accepts no cache field.
 *   - 'unknown': caching support is not established for this target.
 */
function cacheCapability({ apiType, baseUrl, modelId } = {}) {
  const family = providerFamily({ apiType, baseUrl });
  if (family === 'anthropic') {
    return {
      family, transport: 'anthropic', mode: 'explicit',
      requestFields: {},
      // The stable boundary is the first system block; tools are the fallback
      // when no system block exists. Automatic is the fallback when there is
      // no eligible stable prefix at all.
      explicitBreakpoints: true,
      breakpoint: 'first-system-block',
      automaticFallback: true,
      minCacheableTokens: minimumCacheableTokens(modelId),
      reportsReads: true, reportsWrites: true,
      readFields: ['cache_read_input_tokens'],
      writeFields: ['cache_creation_input_tokens'],
    };
  }
  if (family === 'openrouter') {
    const anthropic = openRouterAnthropic(modelId);
    return {
      family, transport: anthropic ? 'anthropic' : 'openrouter',
      mode: 'automatic',
      requestFields: cacheRequestFields({ apiType, baseUrl, modelId }),
      explicitBreakpoints: false,
      reportsReads: true,
      reportsWrites: anthropic,
      readFields: anthropic
        ? ['prompt_tokens_details.cached_tokens', 'cache_read_input_tokens']
        : ['prompt_tokens_details.cached_tokens', 'prompt_cache_hit_tokens'],
      writeFields: anthropic ? ['prompt_tokens_details.cache_write_tokens'] : [],
    };
  }
  if (family === 'openai' || family === 'deepseek' || family === 'gemini') {
    return {
      family, transport: family, mode: 'server-side',
      requestFields: {},
      explicitBreakpoints: false,
      reportsReads: true, reportsWrites: family === 'openai',
      readFields: family === 'gemini'
        ? ['usageMetadata.cachedContentTokenCount', 'prompt_tokens_details.cached_tokens']
        : ['prompt_tokens_details.cached_tokens'],
      writeFields: family === 'openai' ? ['prompt_tokens_details.cache_write_tokens'] : [],
    };
  }
  return {
    family, transport: 'compatible', mode: 'unknown',
    requestFields: {}, explicitBreakpoints: false,
    reportsReads: null, reportsWrites: null, readFields: [], writeFields: [],
  };
}

module.exports = {
  cacheRequestFields, cacheCapability, openRouterAnthropic,
  applyAnthropicCaching, anthropicCachePlan, minimumCacheableTokens,
};

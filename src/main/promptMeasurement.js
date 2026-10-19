'use strict';
// Tokenizer-based measurement of the *prepared* prompt for the next request.
//
// This reuses the exact prompt-building pipeline the inference path uses
// (rebuildChatMessages + getToolContext + sampling params) and measures the
// resulting payload with the existing server-template/tokenizer measurer from
// contextBudget.js. It never invents its own prompt approximation.
//
// Expensive server measurement runs only when explicitly asked (never on a
// UI poll timer). Results are cached per session/model/backend and reused
// while the effective payload hash is unchanged.

const { createHash } = require('node:crypto');

const MAX_ENTRIES = 32;
const cache = new Map();

function cacheKey({ sessionId, modelId, backendId }) {
  return `${sessionId}::${modelId}::${backendId}`;
}

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clearCache() {
  cache.clear();
}

function invalidateMeasuredContext(sessionId, modelId = null) {
  const prefix = modelId === null ? `${sessionId}::` : `${sessionId}::${modelId}::`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// Mirrors the provider tool filtering in the engine:chat request path so the
// measured schema set matches what the model actually receives.
function filterToolsForProvider(tools, { cloud, commandAvailable }) {
  return tools.filter(tool => {
    const name = tool.function?.name;
    if (cloud && ['delegate_task', 'extract_web_page_data'].includes(name)) return false;
    if (commandAvailable && name === 'delegate_task') return false;
    return true;
  });
}

function samplingCaps(sessionId, modelId) {
  try {
    const profiles = require('./profileSettings');
    const params = profiles.getSessionSettings(sessionId, modelId).params ?? {};
    const maxTokens = Number.isSafeInteger(params.max_tokens) && params.max_tokens > 0 ? params.max_tokens : null;
    // Reserve only an explicit numeric budget. Effort is provider-managed and
    // has no token count we may invent; Automatic/off reserve nothing extra.
    const intent = require('../lib/reasoningControls.cjs').normalizeIntent({
      thinkingBudget: params.thinking_budget, reasoningEffort: params.reasoning_effort,
    });
    const reasoningBudget = intent.mode === 'budget' ? intent.budget : null;
    return { maxTokens, reasoningBudget };
  } catch {
    return { maxTokens: null, reasoningBudget: null };
  }
}

async function measurePreparedContext({
  sessionId,
  modelId,
  cloud = false,
  permissionMode = undefined,
  userText = '',
  engine = null,
  fetchImpl = null,
  contextWindowLimit = null,
  mcpToolsOverride = null,
} = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) {
    throw new TypeError('sessionId must be a non-empty string without null characters.');
  }
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.includes('\0')) {
    throw new TypeError('modelId must be a non-empty string without null characters.');
  }
  const { rebuildChatMessages, getToolContext } = require('./promptBuilder');
  const { effectiveMode, sessionProject } = require('./toolPermissions');
  const { approximateTokens, createPromptMeasurer } = require('./contextBudget');

  const project = sessionProject(sessionId);
  const mode = effectiveMode(permissionMode, project);
  const profiles = require('./profileSettings');
  let memoryEnabled = true;
  try {
    memoryEnabled = profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled;
  } catch { /* Session may not exist yet; builders handle that. */ }

  const mcpManager = require('./mcpManager');
  const mcpTools = mcpToolsOverride ?? mcpManager.getTools(sessionId);
  const { tools: availableTools } = getToolContext(mcpTools, memoryEnabled, sessionId, mode, modelId);
  const commandAvailable = availableTools.some(tool => tool.function?.name === 'execute_command');
  const tools = filterToolsForProvider(availableTools, { cloud, commandAvailable });

  // Same builder the context-recovery path uses for the current history.
  const messages = rebuildChatMessages({ sessionId, modelId, userText:
    typeof userText === 'string' ? userText : '' });
  const { maxTokens, reasoningBudget } = samplingCaps(sessionId, modelId);
  const payload = { model: modelId, messages, tools,
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    ...(reasoningBudget != null ? { reasoning_budget_tokens: reasoningBudget } : {}) };

  const backendId = cloud ? 'cloud' : engine && engine.port != null ? `${engine.port}::${engine.modelPath ?? ''}` : 'offline';
  const key = cacheKey({ sessionId, modelId, backendId });
  const hash = payloadHash({ payload, cloud });
  const cached = cache.get(key);
  if (cached && cached.hash === hash) return cached.result;

  const measuredAt = new Date().toISOString();
  const base = { sessionId, modelId, measuredAt,
    messageCount: messages.length, toolCount: tools.length, memoryEnabled };
  let result;
  const backendUsable = !cloud && engine && engine.port != null &&
    (engine.modelPath == null || engine.modelPath === modelId);
  if (backendUsable) {
    const measurer = createPromptMeasurer(fetchImpl ?? require('./localEngineFetch').localEngineFetch);
    try {
      const measured = await measurer(`http://127.0.0.1:${engine.port}/v1/chat/completions`,
        payload, { contextWindowLimit: contextWindowLimit ?? engine.contextLength ?? 8192 });
      result = { ...base, tokens: measured.tokens, method: measured.method,
        limit: measured.limit, budget: measured.budget,
        ...(measured.note ? { note: measured.note } : {}),
        confidence: measured.method === 'server-template-tokenizer' ? 'measured' : 'estimated' };
    } catch {
      const tokens = approximateTokens(payload);
      result = { ...base, tokens, method: 'approximate-full-request', confidence: 'estimated',
        note: 'tokenizer-measurement-failed' };
    }
  } else {
    // Cloud providers have no compatible local template/tokenizer, and an
    // offline engine has nothing to measure with. A ready engine serving a
    // different model is also unusable: its template/tokenizer belong to
    // another model. Report the documented fallback explicitly as an
    // estimate, never as an exact count.
    const modelMismatch = !cloud && engine && engine.port != null && engine.modelPath != null && engine.modelPath !== modelId;
    result = { ...base, tokens: approximateTokens(payload), method: 'approximate-full-request',
      confidence: 'estimated',
      note: cloud ? 'cloud-backend-no-local-tokenizer' : modelMismatch ? 'model-mismatch' : 'engine-not-ready' };
  }

  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { hash, result });
  return result;
}

module.exports = { measurePreparedContext, invalidateMeasuredContext, filterToolsForProvider, clearCache };

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
let measurers = new WeakMap();

function cacheKey({ sessionId, modelId, backendId }) {
  return `${sessionId}::${modelId}::${backendId}`;
}

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clearCache() {
  cache.clear();
  measurers = new WeakMap();
}

function invalidateMeasuredContext(sessionId, modelId = null) {
  measurers = new WeakMap();
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

  const stateIdentity = preparedStateIdentity(sessionId, modelId, mcpToolsOverride);
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
  const activeMessages = require('./sessionManager').getActiveMessages(sessionId);
  const lastUser = activeMessages.findLast(message => message.role === 'user')?.content;
  const currentUserText = userText || (typeof lastUser === 'string' ? lastUser : Array.isArray(lastUser)
    ? lastUser.filter(part => part.type === 'text').map(part => part.text).join('\n') : '');
  const messages = rebuildChatMessages({ sessionId, modelId,
    delegationAvailable: tools.some(tool => tool.function?.name === 'spawn_sub_agent'),
    userText: currentUserText });
  let { maxTokens, reasoningBudget } = samplingCaps(sessionId, modelId);
  let reasoningFields = {};
  try {
    const target = cloud ? { type: 'cloud', provider: modelId.split(':')[1], model: modelId.split(':').slice(2).join(':') } : { type: 'local' };
    const resolution = await require('./reasoningRuntime').resolveChatReasoning({ sessionId, modelId, target,
      localModel: engine?.localModel, contextSize: contextWindowLimit ?? engine?.contextLength });
    const controls = require('../lib/reasoningControls.cjs');
    if (cloud) {
      const mapped = controls.cloudRequestFields(resolution, { modelId: target.model, maxTokens });
      if (mapped.maxTokens > 0) maxTokens = mapped.maxTokens;
      if (resolution.capabilities?.family === 'anthropic') maxTokens ??= 4096;
    } else reasoningFields = controls.localRequestFields(resolution);
    reasoningBudget = resolution.effective?.mode === 'budget' ? resolution.effective.budget : null;
  } catch { /* Explicit sampling reservations remain conservative if resolution is unavailable. */ }
  const payload = { model: modelId, messages, tools, tool_choice: 'auto', cache_prompt: true,
    stream: true, stream_options: { include_usage: true },
    temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, ...reasoningFields,
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    ...(reasoningBudget != null ? { reasoning_budget_tokens: reasoningBudget } : {}) };

  const historyIdentity = payloadHash(activeMessages);
  const backendId = cloud ? 'cloud' : engine && engine.port != null ? `${engine.port}::${engine.modelPath ?? ''}::${engine.runtimeIdentity ?? ''}::${engine.contextLength ?? ''}::${engine.parallelSlots ?? ''}` : 'offline';
  const key = cacheKey({ sessionId, modelId, backendId });
  const hash = payloadHash({ payload, cloud });
  const cached = cache.get(key);
  // Local event-driven measurements always refresh /props before trusting a
  // cached capacity. Tokenizer counts remain bounded and reusable below.
  // Capacity is refreshed on each explicit measurement, including provider metadata.

  const measuredAt = new Date().toISOString();
  const base = { sessionId, modelId, measuredAt,
    representation: 'prepared-request-projection',
    messageCount: messages.length, toolCount: tools.length, memoryEnabled };
  let result;
  const backendUsable = !cloud && engine && engine.port != null &&
    (engine.modelPath == null || engine.modelPath === modelId);
  if (backendUsable) {
    const fetcher = fetchImpl ?? require('./localEngineFetch').localEngineFetch;
    let measurer = measurers.get(fetcher);
    if (!measurer) { measurer = createPromptMeasurer(fetcher); measurers.set(fetcher, measurer); }
    try {
      const measured = await measurer(`http://127.0.0.1:${engine.port}/v1/chat/completions`,
        payload, { contextWindowLimit: contextWindowLimit ?? engine.contextLength ?? 8192, runtimeIdentity: backendId });
      result = { ...base, tokens: measured.tokens, method: measured.method,
        limit: measured.limit, budget: measured.budget, budgetContract: measured.budgetContract,
        imageCount: measured.imageCount, imageAllowanceTokens: measured.imageAllowanceTokens,
        ...(measured.note ? { note: measured.note } : {}),
        confidence: measured.method === 'server-template-tokenizer' ? 'measured' : 'estimated' };
    } catch (error) {
      if (error?.code === 'CONTEXT_BUDGET_EXCEEDED') throw error;
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

  if (!result.budgetContract) {
    let advertised = null;
    if (cloud) {
      try {
        const [, providerId, ...parts] = modelId.split(':');
        const rows = await require('./cloudProviders').getCloudModelMetadata();
        advertised = rows.find(row => row.providerId === providerId && row.modelId === parts.join(':'))?.contextLength ?? null;
      } catch { /* Explicit unverified fallback. */ }
    }
    result.budgetContract = require('./contextBudget').createRuntimeBudget({
      provider: cloud ? 'cloud' : 'local', modelId, runtimeIdentity: backendId,
      configuredContextTokens: contextWindowLimit ?? engine?.contextLength ?? advertised,
      runtimeContextTokens: advertised, payload, currentInputTokens: result.tokens, measurementMethod: result.method });
    result.limit = result.budgetContract.capacityTokens;
    result.budget = result.budgetContract.usableInputTokens;
  }
  if (stateIdentity !== preparedStateIdentity(sessionId, modelId, mcpToolsOverride) || historyIdentity !== payloadHash(require('./sessionManager').getActiveMessages(sessionId)))
    throw new Error('Prompt history changed during measurement; refresh the current request.');
  result.historyIdentity = historyIdentity;
  result.stateIdentity = stateIdentity;
  result.promptIdentity = payloadHash({ hash, budget: result.budgetContract });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  if (cached?.hash === hash && JSON.stringify({ ...cached.result, measuredAt: null }) === JSON.stringify({ ...result, measuredAt: null })) return cached.result;
  cache.set(key, { hash, result });
  return result;
}

function preparedStateIdentity(sessionId, modelId, toolsOverride = null) {
  return payloadHash({ messages: require('./sessionManager').getActiveMessages(sessionId),
    settings: require('./profileSettings').getSessionSettings(sessionId, modelId),
    tools: toolsOverride ?? require('./mcpManager').getTools(sessionId) });
}
function isPreparedContextCurrent(sessionId, modelId, identity) {
  return preparedStateIdentity(sessionId, modelId) === identity;
}

module.exports = { isPreparedContextCurrent, measurePreparedContext, invalidateMeasuredContext, filterToolsForProvider, clearCache };

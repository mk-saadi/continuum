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
  for (const entry of pendingMeasurements.values())
    entry.controller.abort(Object.assign(new Error('Measurement backend changed.'), { code: 'stale-measurement' }));
}

function invalidateMeasuredContext(sessionId, modelId = null) {
  measurers = new WeakMap();
  for (const entry of pendingMeasurements.values()) {
    if (entry.sessionId === sessionId && (modelId === null || entry.modelId === modelId))
      entry.controller.abort(Object.assign(new Error('Context measurement invalidated.'), { code: 'stale-measurement' }));
  }
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

async function measurePreparedContextOnce({
  sessionId,
  modelId,
  cloud = false,
  permissionMode = undefined,
  userText = '',
  engine = null,
  fetchImpl = null,
  contextWindowLimit = null,
  mcpToolsOverride = null,
  signal = null,
} = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) {
    throw new TypeError('sessionId must be a non-empty string without null characters.');
  }
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.includes('\0')) {
    throw new TypeError('modelId must be a non-empty string without null characters.');
  }
  signal?.throwIfAborted();
  require('./sessionDeletion').assertAvailable(sessionId);
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
    messageCount: messages.length, toolCount: tools.length, memoryEnabled,
    ...require('./nativeToolActivation').snapshot(sessionId) };
  let result;
  const backendUsable = !cloud && engine && engine.port != null &&
    (engine.modelPath == null || engine.modelPath === modelId);
  if (backendUsable) {
    const fetcher = fetchImpl ?? require('./localEngineFetch').localEngineFetch;
    let measurer = measurers.get(fetcher);
    if (!measurer) { measurer = createPromptMeasurer(fetcher); measurers.set(fetcher, measurer); }
    try {
      const measured = await measurer(`http://127.0.0.1:${engine.port}/v1/chat/completions`,
        payload, { signal, contextWindowLimit: contextWindowLimit ?? engine.contextLength ?? 8192, runtimeIdentity: backendId });
      result = { ...base, tokens: measured.tokens, method: measured.method,
        limit: measured.limit, budget: measured.budget, budgetContract: measured.budgetContract,
        imageCount: measured.imageCount, imageAllowanceTokens: measured.imageAllowanceTokens,
        ...(measured.note ? { note: measured.note } : {}),
        confidence: measured.method === 'server-template-tokenizer' ? 'measured' : 'estimated' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
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
  signal?.throwIfAborted();
  if (stateIdentity !== preparedStateIdentity(sessionId, modelId, mcpToolsOverride) || historyIdentity !== payloadHash(require('./sessionManager').getActiveMessages(sessionId)))
    throw Object.assign(new Error('Prompt history changed during measurement; refresh the current request.'), { code: 'stale-measurement' });
  // Full-request total comes from the established measurer. Components are
  // explicitly estimates and overlap; they must never be summed as exact tokens.
  const component = value => value.length ? Math.ceil(JSON.stringify(value).length / 4) : 0;
  const taskMessages = messages.filter(message => message.role === 'system' && /WORKSPACE TASK BRIEF|CHECKPOINT|WORK LOG|WORKSPACE PLAN|EARLIER CONVERSATION SUMMARY/.test(message.content));
  Object.assign(result, {
    chatMode: project ? 'workspace' : 'casual', provider: cloud ? modelId.split(':')[1] : 'local', model: modelId,
    measurementMethod: result.method, measurementConfidence: result.confidence,
    initialRequestInputTokens: activeMessages.length === 1 && activeMessages[0].role === 'user' && !base.dynamicToolActivationCount ? result.tokens : null,
    postActivationRequestInputTokens: base.dynamicToolActivationCount ? result.tokens : null,
    nativeToolSchemaTokens: component(tools.filter(tool => !mcpTools.some(mcp => mcp.function?.name === tool.function?.name))),
    systemInstructionTokens: component(messages.filter(message => message.role === 'system' || message.role === 'developer')),
    projectContextTokens: component(require('./promptBuilder').buildProjectContext(sessionId)),
    taskStateTokens: component(taskMessages), componentMeasurementMethod: 'serialized-characters/4-estimate-overlapping',
  });
  result.historyIdentity = historyIdentity;
  result.stateIdentity = stateIdentity;
  result.promptIdentity = payloadHash({ hash, budget: result.budgetContract });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  if (cached?.hash === hash && JSON.stringify({ ...cached.result, measuredAt: null }) === JSON.stringify({ ...result, measuredAt: null })) return cached.result;
  require('./sessionDeletion').assertAvailable(sessionId);
  cache.set(key, { hash, result });
  return result;
}

// Share only identical snapshots/configurations. A changed history gets its own
// measurement; the obsolete one still has to pass the final source check.
const pendingMeasurements = new Map();
const measurementOwners = new WeakMap();
let nextOwner = 0;
function ownerId(value) {
  if (!value) return null;
  if (!measurementOwners.has(value)) measurementOwners.set(value, ++nextOwner);
  return measurementOwners.get(value);
}
function measurePreparedContext(options = {}) {
  const { fetchImpl, signal, ...serializable } = options;
  let key;
  try {
    key = payloadHash({ ...serializable, fetchOwner: ownerId(fetchImpl), signalOwner: ownerId(signal), state: preparedStateIdentity(options.sessionId, options.modelId, options.mcpToolsOverride) });
  } catch (error) { return Promise.reject(error); }
  const pending = pendingMeasurements.get(key);
  if (pending && pending.fetchImpl === fetchImpl) return pending.promise;
  const entry = { fetchImpl, sessionId: options.sessionId, modelId: options.modelId, controller: new AbortController() };
  entry.promise = measurePreparedContextOnce({ ...options, signal: signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal }).finally(() => {
    if (pendingMeasurements.get(key) === entry) pendingMeasurements.delete(key);
  });
  pendingMeasurements.set(key, entry);
  return entry.promise;
}

function preparedConfigurationIdentity(sessionId, modelId) {
  return payloadHash({ settings: require('./profileSettings').getSessionSettings(sessionId, modelId),
    nativeActivation: require('./nativeToolActivation').snapshot(sessionId), tools: require('./mcpManager').getTools(sessionId),
    mcpPolicy: { mode: require('./mcpManager').getMcpMode?.(),
      servers: [...(require('./mcpManager').servers ?? [])].map(([name, server]) => [name, server.definition, server.enabled, [...(server.disabledTools ?? [])]]) },
    project: require('./promptBuilder').buildProjectContext(sessionId) });
}
function preparedStateIdentity(sessionId, modelId, toolsOverride = null) {
  return payloadHash({ messages: require('./sessionManager').getActiveMessages(sessionId),
    settings: require('./profileSettings').getSessionSettings(sessionId, modelId),
    nativeActivation: require('./nativeToolActivation').snapshot(sessionId),
    tools: toolsOverride ?? require('./mcpManager').getTools(sessionId) });
}
function isPreparedContextCurrent(sessionId, modelId, identity) {
  return preparedStateIdentity(sessionId, modelId) === identity;
}

// Uses the transport's actual serializer; never the local GGUF tokenizer.
function createCloudWorkspaceMeasurer(target, { getMetadata, getProvider } = {}) {
  const providers = require('./cloudProviders');
  getMetadata ??= providers.getCloudModelMetadata;
  getProvider ??= providers.getStoredProvider;
  return async payload => {
    const provider = getProvider(target.provider);
    const metadata = (await getMetadata()).find(row => row.providerId === target.provider && row.modelId === target.model);
    const capacity = metadata?.contextLength;
    if (!Number.isSafeInteger(capacity) || capacity < 1024) throw Object.assign(new Error('Unknown cloud model context capacity'), { code: 'unknown-cloud-capacity' });
    const body = providers.prepareCloudPayload(payload, target, provider, payload.stream !== false);
    const { approximateTokens, createRuntimeBudget } = require('./contextBudget');
    const tokens = approximateTokens(body);
    const method = 'provider-serialized-full-request-estimate';
    const budgetContract = createRuntimeBudget({ provider: target.provider, modelId: target.model,
      runtimeIdentity: payloadHash({ target, provider }), runtimeContextTokens: capacity,
      payload: body, currentInputTokens: tokens, measurementMethod: method });
    return { tokens, method, limit: capacity, budget: budgetContract.usableInputTokens, budgetContract };
  };
}

module.exports = { createCloudWorkspaceMeasurer, preparedConfigurationIdentity, preparedStateIdentity, isPreparedContextCurrent, measurePreparedContext, invalidateMeasuredContext, filterToolsForProvider, clearCache };

'use strict';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
// Used only to migrate existing saved settings, never to populate provider cards.
const LEGACY_DEFAULTS = {
  openai: { name: 'OpenAI', baseUrl: DEFAULT_BASE_URL },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiType: 'anthropic' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
};
function readSettings() {
  const row = require('./db').db.prepare("SELECT value_json FROM app_settings WHERE key = 'cloud-providers'").get();
  const saved = row ? JSON.parse(row.value_json) : [];
  if (Array.isArray(saved)) return saved;
  return Object.entries(saved).map(([id, value]) => ({
    id, ...LEGACY_DEFAULTS[id], name: LEGACY_DEFAULTS[id]?.name || id,
    baseUrl: LEGACY_DEFAULTS[id]?.baseUrl || DEFAULT_BASE_URL,
    apiType: LEGACY_DEFAULTS[id]?.apiType || 'openai', apiKey: value.apiKey || '', modelId: value.model || '',
  }));
}
function getCloudProviders() {
  // The renderer gets key presence, never the stored secret.
  return readSettings().map(({ apiKey, ...row }) => ({ ...row, apiKey: '', configured: !!apiKey?.trim() }));
}
function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an HTTP or HTTPS base URL without credentials, query parameters or fragments.');
  }
  return url.href.replace(/\/+$/, '');
}
function writeSettings(settings) {
  require('./db').db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('cloud-providers', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(settings));
  return getCloudProviders();
}
function saveCloudProvider({ id, name, baseUrl = DEFAULT_BASE_URL, modelId, apiKey, apiType = 'openai' }) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid provider ID.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Enter a provider name.');
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200 || /[\r\n\0]/.test(modelId)) throw new Error('Enter a valid model ID.');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || /[\r\n\0]/.test(apiKey) || apiKey.length > 4096)) throw new Error('Invalid API key.');
  if (!['openai', 'anthropic'].includes(apiType)) throw new Error('Invalid API type.');
  const settings = readSettings();
  const index = settings.findIndex(row => row.id === id);
  const row = { id, name: name.trim(), baseUrl: normalizeBaseUrl(baseUrl), modelId: modelId.trim(),
    apiType, apiKey: apiKey?.trim() || settings[index]?.apiKey || '' };
  if (!row.apiKey.trim()) throw new Error('Enter an API key.');
  if (index < 0) settings.push(row);
  else settings[index] = row;
  return writeSettings(settings);
}
function deleteCloudProvider(id) {
  if (typeof id !== 'string') throw new Error('Invalid provider ID.');
  return writeSettings(readSettings().filter(row => row.id !== id));
}
async function fetchCloudModels({ id, baseUrl, apiKey }, { fetchImpl = fetch } = {}) {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/models`;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || /[\r\n\0]/.test(apiKey) || apiKey.length > 4096)) throw new Error('Invalid API key.');
  const key = apiKey?.trim() || readSettings().find(row => row.id === id)?.apiKey?.trim();
  if (!key) throw new Error('Enter an API key before fetching models.');
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { error: `Failed to fetch models (HTTP ${response.status}). Check the base URL and API key, or enter a model ID manually.` };
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) throw new Error('Invalid model list.');
    return { models: [...new Set(payload.data.map(model => model?.id).filter(id => typeof id === 'string' && id.trim()))].sort() };
  } catch {
    // Never expose a remote response body or credentials in an IPC error.
    return { error: 'Failed to fetch models. Check the base URL and API key, or enter a model ID manually.' };
  }
}
function validateChatProvider(target = { type: 'local' }) {
  if (target?.type === 'local') return { type: 'local' };
  if (target?.type !== 'cloud' || typeof target.provider !== 'string' || typeof target.model !== 'string' ||
      !readSettings().some(row => row.id === target.provider && row.modelId === target.model)) throw new Error('Invalid chat provider. Select a saved provider and model.');
  return { type: 'cloud', provider: target.provider, model: target.model };
}
function anthropicBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content || []).map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image_url') {
      const url = block.image_url.url;
      const match = /^data:(image\/[^;]+);base64,(.+)$/s.exec(url);
      return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
    }
    throw new Error(`Unsupported cloud content type: ${block.type}`);
  });
}
function anthropicPayload(payload, model) {
  const messages = [], system = [];
  for (const message of payload.messages) {
    if (message.role === 'system' || message.role === 'developer') { system.push(...anthropicBlocks(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: anthropicBlocks(message.content) }]
      : anthropicBlocks(message.content);
    for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') });
    if (!content.length) continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  return { model, system, messages, stream: false,
    max_tokens: payload.max_tokens > 0 ? payload.max_tokens : 4096,
    ...(payload.tools?.length ? { tools: payload.tools.map(({ function: tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
  };
}
function createCloudFetch(target, { fetchImpl = fetch } = {}) {
  target = validateChatProvider(target);
  if (target.type !== 'cloud') throw new Error('Cloud provider required.');
  const provider = readSettings().find(row => row.id === target.provider);
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) throw new Error(`Add your ${provider.name} API key in Settings → Cloud Providers.`);
  return async (_url, options) => {
    const original = JSON.parse(options.body);
    const anthropic = provider.apiType === 'anthropic';
    // Whitelist portable fields: llama.cpp sampling/cache parameters are not cloud API fields.
    const body = anthropic ? anthropicPayload(original, target.model) : {
      model: target.model, messages: original.messages, stream: true, stream_options: { include_usage: true },
      ...(original.tools?.length ? { tools: original.tools, tool_choice: 'auto' } : {}),
      ...(original.max_tokens > 0 ? { max_tokens: original.max_tokens } : {}),
    };
    const response = await fetchImpl(`${normalizeBaseUrl(provider.baseUrl)}/${anthropic ? 'messages' : 'chat/completions'}`, {
      method: 'POST', signal: options.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(anthropic
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // Do not echo remote bodies, credentials or conversation text into logs.
      await response.body?.cancel();
      throw new Error(`${provider.name} request failed (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? 'Check your API key and model access.' : response.status === 429 ? 'Check your quota or retry later.' : 'Check the model ID and provider availability.'}`);
    }
    if (!anthropic) return response;
    const data = await response.json();
    if (data.stop_reason === 'max_tokens' && data.content?.some(block => block.type === 'tool_use')) {
      throw new Error('Anthropic returned an incomplete tool call. Increase the output token limit.');
    }
    const tool_calls = (data.content || []).filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: (data.content || []).filter(block => block.type === 'text').map(block => block.text).join(''), ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: tool_calls.length ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
      usage: { prompt_tokens: (data.usage?.input_tokens || 0) + (data.usage?.cache_read_input_tokens || 0) + (data.usage?.cache_creation_input_tokens || 0), completion_tokens: data.usage?.output_tokens || 0 } }), { headers: { 'Content-Type': 'application/json' } });
  };
}
module.exports = { fetchCloudModels, getCloudProviders, saveCloudProvider, deleteCloudProvider, validateChatProvider, createCloudFetch, anthropicPayload };

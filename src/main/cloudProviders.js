"use strict";

// Cloud chat requests POST, so they must never ride on global.fetch: the
// sub-agent module overrides it with a GET-only transport. Bind this module's
// default to the shared Node HTTP transport directly instead.
const { nodeHttpFetch } = require("./nodeHttpFetch");
const reasoningControls = require("../lib/reasoningControls.cjs");
const promptCaching = require("../lib/promptCaching.cjs");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MEDIA_SETTINGS = Object.freeze({ default_image_provider_id: "", default_video_provider_id: "" });
const CATEGORIES = new Set(["text", "media"]);
// Local loopback / LAN hosts (LM Studio, Ollama, llama.cpp server, etc.) expose an
// OpenAI-compatible API without an API key. These providers may be saved and used
// with an empty key; remote providers still require one.
function isLocalBaseUrl(value) {
	if (typeof value !== "string" || !value.trim()) return false;
	let hostname = "";
	try {
		hostname = new URL(value.trim()).hostname.toLowerCase();
	} catch {
		return false;
	}
	hostname = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname)) return true;
	if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
	if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
	if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
	if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
	const m = /^172\.(\d+)\.\d+\.\d+$/.exec(hostname);
	if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
	return false;
}
function providerNeedsKey(provider = {}) {
	// Stable Diffusion manages its own keyless case; local text endpoints
	// (LM Studio at http://127.0.0.1:1234/v1, Ollama, etc.) never need one.
	if (provider.category === "media" && provider.apiType === "stable-diffusion") return false;
	if (provider.category === "text" && isLocalBaseUrl(provider.baseUrl)) return false;
	return true;
}
const MEDIA_TYPES = new Set(["image", "video"]);
// Used only to migrate existing saved settings, never to populate provider cards.
const LEGACY_DEFAULTS = {
	openai: { name: "OpenAI", baseUrl: DEFAULT_BASE_URL },
	anthropic: { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic" },
	deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
};
function readSettings() {
	const row = require("./db")
		.db.prepare("SELECT value_json FROM app_settings WHERE key = 'cloud-providers'")
		.get();
	const saved = row ? JSON.parse(row.value_json) : [];
	if (Array.isArray(saved)) return saved.map(provider => ({ ...provider, category: provider.category === "media" ? "media" : "text" }));
	return Object.entries(saved).map(([id, value]) => ({
		id,
		category: "text",
		...LEGACY_DEFAULTS[id],
		name: LEGACY_DEFAULTS[id]?.name || id,
		baseUrl: LEGACY_DEFAULTS[id]?.baseUrl || DEFAULT_BASE_URL,
		apiType: LEGACY_DEFAULTS[id]?.apiType || "openai",
		apiKey: value.apiKey || "",
		modelId: value.model || "",
	}));
}
function getCloudProviders(category) {
	if (category !== undefined && !CATEGORIES.has(category)) throw new Error("Invalid provider category.");
	// The renderer gets key presence, never the stored secret.
	return readSettings().filter(row => !category || row.category === category)
		.map(({ apiKey, ...row }) => ({ ...row, apiKey: "", configured: !!apiKey?.trim() || !providerNeedsKey({ ...row, apiKey }) }));
}
// Optional user-configured rates for a provider, in USD per million tokens.
// Only input and output are required for the override to be usable; the cache
// rates are optional and fall back to the ordinary input rate when absent.
// Raw saved provider row for internal (main-process) callers that need the
// transport identity — apiType, base URL, configured rates. Never crosses IPC.
function getStoredProvider(id) {
	if (typeof id !== 'string' || !id) return null;
	return readSettings().find(row => row.id === id) ?? null;
}
function normalizeProviderPricing(input) {
	if (input == null) return null;
	if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid provider pricing.');
	const rate = value => {
		if (value == null || value === '') return null;
		const number = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw new Error('Enter non-negative USD rates per million tokens.');
		return number;
	};
	const pricing = { input: rate(input.input), output: rate(input.output), cacheRead: rate(input.cacheRead), cacheWrite: rate(input.cacheWrite1h ?? input.cacheWrite) };
	if (pricing.input === null && pricing.output === null && pricing.cacheRead === null && pricing.cacheWrite === null) return null;
	if (pricing.input === null || pricing.output === null) throw new Error('Enter both an input and an output rate (or leave them blank).');
	return { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, cacheWrite: pricing.cacheWrite };
}
function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
	const url = new URL(value.trim());
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Enter an HTTP or HTTPS base URL without credentials, query parameters or fragments.",
		);
	}
	return url.href.replace(/\/+$/, "");
}
function writeSettings(settings) {
	require("./db")
		.db.prepare(
			"INSERT INTO app_settings(key, value_json) VALUES ('cloud-providers', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
		)
		.run(JSON.stringify(settings));
	return getCloudProviders();
}
function saveCloudProvider({ id, name, baseUrl = DEFAULT_BASE_URL, modelId, apiKey, apiType = "openai", category = "text", mediaType = "image", pricing }) {
	if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid provider ID.");
	if (typeof name !== "string" || !name.trim() || name.length > 200)
		throw new Error("Enter a provider name.");
	// Text providers are model-agnostic: the model is chosen per chat in the
	// model selector. Media providers still store the single generation model.
	const normalizedModelId =
		typeof modelId === "string" ? modelId.trim() : modelId === undefined ? "" : null;
	if (
		normalizedModelId === null ||
		normalizedModelId.length > 200 ||
		/[\r\n\0]/.test(normalizedModelId)
	)
		throw new Error("Enter a valid model ID.");
	if (category === "media" && !normalizedModelId) throw new Error("Enter a valid model ID.");
	if (
		apiKey !== undefined &&
		(typeof apiKey !== "string" || /[\r\n\0]/.test(apiKey) || apiKey.length > 4096)
	)
		throw new Error("Invalid API key.");
	if (!CATEGORIES.has(category)) throw new Error("Invalid provider category.");
	if (category === "text" && !["openai", "anthropic"].includes(apiType)) throw new Error("Invalid text API type.");
	if (category === "media" && !["openrouter", "openai-images", "stable-diffusion"].includes(apiType)) throw new Error("Invalid media API type.");
	if (category === "media" && !MEDIA_TYPES.has(mediaType)) throw new Error("Invalid media type.");
	const settings = readSettings();
	const index = settings.findIndex((row) => row.id === id);
	if (index >= 0 && settings[index].category !== category) throw new Error("Provider category cannot be changed after saving.");
	const row = {
		id,
		category,
		name: name.trim(),
		baseUrl: normalizeBaseUrl(baseUrl),
		modelId: normalizedModelId,
		apiType,
		...(category === "media" ? { mediaType } : {}),
		// Rates are optional cost evidence, never a requirement to save a
		// provider. `undefined` keeps whatever was saved; an explicit value
		// (including null/blank) replaces it, so clearing is possible.
		pricing: pricing === undefined ? (settings[index]?.pricing ?? null) : normalizeProviderPricing(pricing),
		apiKey: apiKey?.trim() || settings[index]?.apiKey || "",
	};
	if (!row.apiKey.trim() && providerNeedsKey(row)) throw new Error("Enter an API key.");
	if (index < 0) settings.push(row);
	else settings[index] = row;
	const result = writeSettings(settings);
	if (category === "media") {
		const defaults = getCloudProviderDefaults();
		const patch = {};
		if (defaults.default_image_provider_id === id && mediaType !== "image") patch.default_image_provider_id = "";
		if (defaults.default_video_provider_id === id && mediaType !== "video") patch.default_video_provider_id = "";
		if (Object.keys(patch).length) saveCloudProviderDefaults(patch);
	}
	return result;
}

function getCloudProviderDefaults() {
	const row = require("./db").db.prepare("SELECT value_json FROM app_settings WHERE key = 'cloud-provider-defaults'").get();
	const stored = row ? JSON.parse(row.value_json) : {};
	return { ...DEFAULT_MEDIA_SETTINGS, ...stored };
}

function saveCloudProviderDefaults(input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid media provider defaults.");
	if (Object.keys(input).some(key => !["default_image_provider_id", "default_video_provider_id"].includes(key))) throw new Error("Invalid media provider defaults.");
	const providers = readSettings();
	const defaults = { ...getCloudProviderDefaults() };
	for (const [key, type] of [["default_image_provider_id", "image"], ["default_video_provider_id", "video"]]) {
		if (!Object.hasOwn(input, key)) continue;
		const id = input[key];
		if (id !== "" && (typeof id !== "string" || !providers.some(row => row.id === id && row.category === "media" && row.mediaType === type))) {
			throw new Error(`Select a saved ${type} provider.`);
		}
		defaults[key] = id;
	}
	require("./db").db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('cloud-provider-defaults', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
		.run(JSON.stringify(defaults));
	return defaults;
}

function getActiveMediaModel(mediaType = "image") {
	if (!MEDIA_TYPES.has(mediaType)) throw new Error("Media type must be image or video.");
	const key = mediaType === "image" ? "default_image_provider_id" : "default_video_provider_id";
	const id = getCloudProviderDefaults()[key];
	const provider = readSettings().find(row => row.id === id && row.category === "media" && row.mediaType === mediaType);
	if (!provider || (!provider.apiKey?.trim() && provider.apiType !== "stable-diffusion")) return null;
	return { id: provider.id, name: provider.name, category: provider.category, mediaType,
		apiType: provider.apiType, baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId: provider.modelId };
}

function deleteCloudProvider(input) {
	const id = typeof input === "string" ? input : input?.id;
	const category = typeof input === "object" && input ? input.category : undefined;
	if (typeof id !== "string") throw new Error("Invalid provider ID.");
	if (category !== undefined && !CATEGORIES.has(category)) throw new Error("Invalid provider category.");
	const providers = readSettings();
	const removed = providers.find(row => row.id === id);
	if (removed && category && removed.category !== category) throw new Error("Provider category does not match.");
	const result = writeSettings(providers.filter((row) => row.id !== id));
	if (removed?.category === "media") {
		const defaults = getCloudProviderDefaults();
		const patch = {};
		if (defaults.default_image_provider_id === id) patch.default_image_provider_id = "";
		if (defaults.default_video_provider_id === id) patch.default_video_provider_id = "";
		if (Object.keys(patch).length) saveCloudProviderDefaults(patch);
	}
	return result;
}
async function fetchCloudModels({ id, baseUrl, apiKey, apiType, includeMetadata = false }, { fetchImpl = nodeHttpFetch } = {}) {
	const saved = id ? readSettings().find(row => row.id === id) : null;
    baseUrl ??= saved?.baseUrl;
    apiType ??= saved?.apiType;
	let endpoint = apiType === "stable-diffusion"
		? `${normalizeBaseUrl(baseUrl)}/sdapi/v1/options`
		: `${normalizeBaseUrl(baseUrl)}/models`;

	if (new URL(endpoint).hostname === "openrouter.ai") {
		endpoint += endpoint.includes("?") ? "&output_modalities=all" : "?output_modalities=all";
	}

	if (
		apiKey !== undefined &&
		(typeof apiKey !== "string" || /[\r\n\0]/.test(apiKey) || apiKey.length > 4096)
	)
		throw new Error("Invalid API key.");
	const key =
		apiKey?.trim() ||
		readSettings()
			.find((row) => row.id === id)
			?.apiKey?.trim();
	if (!key && providerNeedsKey({ category: "text", baseUrl, apiType }) && apiType !== "stable-diffusion") throw new Error("Enter an API key before fetching models.");
	try {
		const response = await fetchImpl(endpoint, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(15000),
			headers: { ...(key ? apiType === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` } : {}), Accept: "application/json" },
		});
		if (!response.ok) {
			await response.body?.cancel();
			return {
				error: `Failed to fetch models (HTTP ${response.status}). Check the base URL and API key, or enter a model ID manually.`,
			};
		}
		const payload = await response.json();
		if (apiType === "stable-diffusion") return { models: payload?.sd_model_checkpoint ? [payload.sd_model_checkpoint] : [] };
		if (!Array.isArray(payload?.data)) throw new Error("Invalid model list.");
        // Anthropic lists are paginated. Preserve metadata from every page.
        let page = payload;
        for (let count = 0; apiType === 'anthropic' && page.has_more && count < 100; count++) {
            if (typeof page.last_id !== 'string' || !page.last_id) throw new Error('Invalid model cursor.');
            const next = new URL(endpoint); next.searchParams.set('after_id', page.last_id);
            const response = await fetchImpl(next.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01', Accept: 'application/json' } });
            if (!response.ok) throw new Error('Model pagination failed.');
            page = await response.json();
            if (!Array.isArray(page.data)) throw new Error('Invalid model page.');
            payload.data.push(...page.data);
        }
		return {
            ...(includeMetadata ? { metadata: payload.data.filter(model => typeof model?.id === 'string' && model.id.trim()).map(model => require('./cloudModelMetadata').normalizeCloudModel(model, normalizeBaseUrl(baseUrl), apiType)) } : {}),
			models: [
				...new Set(
					payload.data
						.map((model) => model?.id)
						.filter((id) => typeof id === "string" && id.trim()),
				),
			].sort(),
		};
	} catch {
		// Never expose a remote response body or credentials in an IPC error.
		return {
			error: "Failed to fetch models. Check the base URL and API key, or enter a model ID manually.",
		};
	}
}
const metadataCache = new Map();
// Last successfully resolved metadata per provider/model, readable
// synchronously by the cost estimator when a turn settles. Populated as a side
// effect of the normal metadata read; never fetched on its own, so no cost path
// can introduce a network call.
const knownMetadata = new Map();
function knownKey(providerId, modelId) { return `${providerId}\u0000${modelId}`; }
function getKnownModelMetadata(providerId, modelId) {
    return knownMetadata.get(knownKey(providerId, modelId)) ?? null;
}
async function getCloudModelMetadata({ fetchImpl = nodeHttpFetch, refresh = false } = {}) {
    const providers = readSettings().filter(row => row.category === 'text' && (row.apiKey?.trim() || !providerNeedsKey(row)));
    const results = await Promise.all(providers.map(async row => {
        const hash = require('node:crypto').createHash('sha256').update(row.apiKey || "").digest('hex');
        const cacheKey = `${row.baseUrl}:${row.apiType}:${hash}`;
        let cached = metadataCache.get(cacheKey);
        if (!cached || refresh || Date.now() - cached.time > 5 * 60 * 1000) {
            const promise = fetchCloudModels({ id: row.id, baseUrl: row.baseUrl, apiType: row.apiType, includeMetadata: true }, { fetchImpl });
            cached = { promise, time: Date.now() }; metadataCache.set(cacheKey, cached);
            if (metadataCache.size > 100) metadataCache.delete(metadataCache.keys().next().value);
        }
        const result = await cached.promise;
        if (result.error) {
            metadataCache.delete(cacheKey);
            return [{ providerId: row.id, providerName: row.name, modelId: '', error: result.error }];
        }
        const models = result.metadata || [];
        if (!models.length) {
            return [{ providerId: row.id, providerName: row.name, modelId: '', error: 'No models reported by this provider.' }];
        }
        // Every model the provider offers is returned, so a chat can use any of
        // them without saving one on the provider row first.
        return models.map(model => {
            const overrides = require('./capabilityOverrides').getOverrides({ type: 'cloud', provider: row.id, model: model.id });
            const entry = {
                providerId: row.id,
                providerName: model.providerName || row.name,
                modelId: model.id,
                ...model,
                ...(overrides.contextLength ? { contextLength: overrides.contextLength, contextSource: 'user' } : {}),
                error: null,
            };
            knownMetadata.set(knownKey(row.id, model.id), entry);
            return entry;
        });
    }));
    return results.flat();
}

function validateChatProvider(target = { type: "local" }) {
	if (target?.type === "local") return { type: "local" };
	const model = typeof target?.model === "string" ? target.model.trim() : "";
	if (
		target?.type !== "cloud" ||
		typeof target.provider !== "string" ||
		!model ||
		model.length > 300 ||
		/[\r\n\0]/.test(model) ||
		!readSettings().some((row) => row.id === target.provider && row.category === "text")
	)
		throw new Error("Invalid chat provider. Select a saved provider and model.");
	return { type: "cloud", provider: target.provider, model };
}
function anthropicBlocks(content) {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return (content || []).map((block) => {
		if (block.type === "text") return { type: "text", text: block.text };
		if (block.type === "image_url") {
			const url = block.image_url.url;
			const match = /^data:(image\/[^;]+);base64,(.+)$/s.exec(url);
			return {
				type: "image",
				source: match
					? { type: "base64", media_type: match[1], data: match[2] }
					: { type: "url", url },
			};
		}
		throw new Error(`Unsupported cloud content type: ${block.type}`);
	});
}
function anthropicPayload(payload, model) {
	// The transport owns the Anthropic wire shape: the shared resolver decides
	// which documented control (adaptive effort vs. legacy budget) applies.
	const mapped = reasoningControls.cloudRequestFields(payload.reasoning, {
		modelId: model, maxTokens: payload.max_tokens,
	});
	const messages = [],
		system = [];
	for (const message of payload.messages) {
		if (message.role === "system" || message.role === "developer") {
			system.push(...anthropicBlocks(message.content));
			continue;
		}
		const role = message.role === "assistant" ? "assistant" : "user";
		const content =
			message.role === "tool"
				? [
						{
							type: "tool_result",
							tool_use_id: message.tool_call_id,
							content: anthropicBlocks(message.content),
						},
					]
				: anthropicBlocks(message.content);
		for (const call of message.tool_calls || [])
			content.push({
				type: "tool_use",
				id: call.id,
				name: call.function.name,
				input: JSON.parse(call.function.arguments || "{}"),
			});
		if (!content.length) continue;
		if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
		else messages.push({ role, content });
	}
	return {
		model,
		system,
		messages,
		stream: false,
		max_tokens: mapped.maxTokens ?? 4096,
		...mapped.fields,
		...(payload.tools?.length
			? {
					tools: payload.tools.map(({ function: tool }) => ({
						name: tool.name,
						description: tool.description,
						input_schema: tool.parameters,
					})),
				}
			: {}),
	};
}
// `stream` selects the response shape: the main chat consumes the OpenAI-style
// SSE stream as it arrives, while sub-agent requests are single non-streaming
// POSTs (see ./subagents/providers/cloudProvider.js) and need one JSON body.
// The Anthropic path is non-streaming either way — it is converted to an
// OpenAI-shaped JSON response below.
function prepareCloudPayload(original, target, provider, stream = true) {
		const anthropic = provider.apiType === "anthropic";
		// Provider-aware prompt caching. Resolved from the *actual* target so a
		// child agent never inherits another provider's cache parameters.
		//
		// Direct Anthropic uses an explicit breakpoint on the stable base system
		// block: a top-level automatic field would land on the changing final
		// message and never be read back. OpenRouter Anthropic keeps the
		// top-level ephemeral field; every other OpenRouter family caches
		// automatically server-side and receives no cache field.
		const cacheFields = promptCaching.cacheRequestFields({
			apiType: provider.apiType, baseUrl: provider.baseUrl, modelId: target.model,
		});
		// Whitelist portable fields: llama.cpp sampling/cache parameters are not cloud API fields.
		const mapped = anthropic ? null : reasoningControls.cloudRequestFields(original.reasoning, {
			modelId: target.model, maxTokens: original.max_tokens,
		});
		const body = anthropic
			? promptCaching.applyAnthropicCaching(anthropicPayload(original, target.model), { modelId: target.model })
			: {
					model: target.model,
					messages: original.messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map(part => part.type === 'input_video' ? { type: 'video_url', video_url: { url: `data:${part.input_video.format === 'video/quicktime' ? 'video/mov' : part.input_video.format};base64,${part.input_video.data}` } } : part) : message.content })),
					...(stream ? { stream: true, stream_options: { include_usage: true } } : { stream: false }),
					...(original.tools?.length ? { tools: original.tools, tool_choice: "auto" } : {}),
					...(mapped.maxTokens > 0 ? { max_tokens: mapped.maxTokens } : {}),
					...mapped.fields,
					...cacheFields,
				};
  return body;
}
function createCloudFetch(target, { fetchImpl = nodeHttpFetch, stream = true, getMetadata = getCloudModelMetadata, onErrorResponse = null } = {}) {
	target = validateChatProvider(target);
	if (target.type !== "cloud") throw new Error("Cloud provider required.");
	const provider = readSettings().find((row) => row.id === target.provider);
	const apiKey = provider.apiKey?.trim();
	if (!apiKey && providerNeedsKey(provider)) throw new Error(`Add your ${provider.name} API key in Settings → Cloud Providers.`);
	return async (_url, options) => {
		const original = JSON.parse(options.body);
        const { requiredModalities, assertCapabilities } = require('./modelCapabilities');
        const required = requiredModalities(original.messages);
        if (required.length) {
            const metadata = (await getMetadata()).find(row => row.providerId === target.provider && row.modelId === target.model);
            const { attachmentPolicy } = await import('../lib/attachmentPolicy.mjs');
            const { getOverrides, applyOverrides } = require('./capabilityOverrides');
            const overrides = getOverrides(target);
            const policy = attachmentPolicy(applyOverrides(metadata?.capabilities, overrides), { apiType: provider.apiType, service: metadata?.providerName, overrides });
            assertCapabilities(policy.enabled, required);
        }
		const anthropic = provider.apiType === "anthropic";
		const body = prepareCloudPayload(original, target, provider, stream);
        options.signal?.throwIfAborted();
        options.onRequestMeasurement?.({ tokens: require('./contextBudget').approximateTokens(body),
            method: 'approximate-full-request', timestamp: new Date().toISOString() });
		const response = await fetchImpl(
			`${normalizeBaseUrl(provider.baseUrl)}/${anthropic ? "messages" : "chat/completions"}`,
			{
				method: "POST",
				signal: options.signal,
				redirect: "error",
				headers: {
					"Content-Type": "application/json",
					...(anthropic
						? { ...(apiKey ? { "x-api-key": apiKey } : {}), "anthropic-version": "2023-06-01" }
						: (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})),
				},
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) {
			// Child recovery classifies only known overflow shapes; no remote body
			// is logged or attached to the resulting error. Other callers unchanged.
			if (onErrorResponse) {
				try { await onErrorResponse(response); } catch (error) { await response.body?.cancel(); throw error; }
			}
			// Do not echo remote bodies, credentials or conversation text into logs.
			await response.body?.cancel();
			throw new Error(
				`${provider.name} request failed (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? "Check your API key and model access." : response.status === 429 ? "Check your quota or retry later." : "Check the model ID and provider availability."}`,
			);
		}
		// OpenAI-compatible SSE (including Gemini/DeepSeek) is accumulated and
		// validated by readCompletion in ../lib/memoryChat.mjs.
		if (!anthropic) return response;
		const data = await response.json();
		if (data.stop_reason === "max_tokens" && data.content?.some((block) => block.type === "tool_use")) {
			throw new Error("Anthropic returned an incomplete tool call. Increase the output token limit.");
		}
		const tool_calls = (data.content || [])
			.filter((block) => block.type === "tool_use")
			.map((block) => ({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: JSON.stringify(block.input) },
			}));
		return new Response(
			JSON.stringify({
				// Preserve raw completion metadata for strict candidate validation.
				provider_stop_reason: data.stop_reason ?? null,
				choices: [
					{
						message: {
							role: "assistant",
							content: (data.content || [])
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join(""),
							...(tool_calls.length ? { tool_calls } : {}),
						},
						finish_reason: tool_calls.length
							? "tool_calls"
							: data.stop_reason === "max_tokens"
								? "length"
								: "stop",
					},
				],
				usage: {
					// Anthropic reports uncached input separately from cache reads and
					// writes. The existing tool loop consumes the OpenAI-shaped gross
					// prompt, so add all three exactly once. Cache counters stay absent
					// when the provider did not report them (never a measured zero).
					prompt_tokens:
						(data.usage?.input_tokens || 0) +
						(data.usage?.cache_read_input_tokens || 0) +
						(data.usage?.cache_creation_input_tokens || 0),
					completion_tokens: data.usage?.output_tokens || 0,
					...(Number.isSafeInteger(data.usage?.cache_read_input_tokens)
						? { cache_read_input_tokens: data.usage.cache_read_input_tokens } : {}),
					...(Number.isSafeInteger(data.usage?.cache_creation_input_tokens)
						? { cache_creation_input_tokens: data.usage.cache_creation_input_tokens } : {}),
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	};
}
module.exports = {
	fetchCloudModels,
    getCloudModelMetadata,
    getKnownModelMetadata,
    getStoredProvider,
	getCloudProviders,
	getCloudProviderDefaults,
	saveCloudProviderDefaults,
	getActiveMediaModel,
	saveCloudProvider,
	deleteCloudProvider,
	validateChatProvider,
	createCloudFetch,
    prepareCloudPayload,
	anthropicPayload,
	isLocalBaseUrl,
	providerNeedsKey,
};

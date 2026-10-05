"use strict";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MEDIA_SETTINGS = Object.freeze({ default_image_provider_id: "", default_video_provider_id: "" });
const CATEGORIES = new Set(["text", "media"]);
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
		.map(({ apiKey, ...row }) => ({ ...row, apiKey: "", configured: !!apiKey?.trim() || row.category === "media" && row.apiType === "stable-diffusion" }));
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
function saveCloudProvider({ id, name, baseUrl = DEFAULT_BASE_URL, modelId, apiKey, apiType = "openai", category = "text", mediaType = "image" }) {
	if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid provider ID.");
	if (typeof name !== "string" || !name.trim() || name.length > 200)
		throw new Error("Enter a provider name.");
	if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 200 || /[\r\n\0]/.test(modelId))
		throw new Error("Enter a valid model ID.");
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
		modelId: modelId.trim(),
		apiType,
		...(category === "media" ? { mediaType } : {}),
		apiKey: apiKey?.trim() || settings[index]?.apiKey || "",
	};
	if (!row.apiKey.trim() && !(category === "media" && apiType === "stable-diffusion")) throw new Error("Enter an API key.");
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
async function fetchCloudModels({ id, baseUrl, apiKey, apiType }, { fetchImpl = fetch } = {}) {
	let endpoint = apiType === "stable-diffusion"
		? `${normalizeBaseUrl(baseUrl)}/sdapi/v1/options`
		: `${normalizeBaseUrl(baseUrl)}/models`;

	if (endpoint.includes("openrouter.ai")) {
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
	if (!key && apiType !== "stable-diffusion") throw new Error("Enter an API key before fetching models.");
	try {
		const response = await fetchImpl(endpoint, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(15000),
			headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), Accept: "application/json" },
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
		return {
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
function validateChatProvider(target = { type: "local" }) {
	if (target?.type === "local") return { type: "local" };
	if (
		target?.type !== "cloud" ||
		typeof target.provider !== "string" ||
		typeof target.model !== "string" ||
		!readSettings().some((row) => row.id === target.provider && row.category === "text" && row.modelId === target.model)
	)
		throw new Error("Invalid chat provider. Select a saved provider and model.");
	return { type: "cloud", provider: target.provider, model: target.model };
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
		max_tokens: Math.max(
			payload.max_tokens > 0 ? payload.max_tokens : 4096,
			payload.thinking_budget >= 1024 ? payload.thinking_budget + 1 : 0,
		),
		...(payload.thinking_budget >= 1024
			? { thinking: { type: "enabled", budget_tokens: payload.thinking_budget } }
			: {}),
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
function createCloudFetch(target, { fetchImpl = fetch } = {}) {
	target = validateChatProvider(target);
	if (target.type !== "cloud") throw new Error("Cloud provider required.");
	const provider = readSettings().find((row) => row.id === target.provider);
	const apiKey = provider.apiKey?.trim();
	if (!apiKey) throw new Error(`Add your ${provider.name} API key in Settings → Cloud Providers.`);
	return async (_url, options) => {
		const original = JSON.parse(options.body);
		const anthropic = provider.apiType === "anthropic";
		// Whitelist portable fields: llama.cpp sampling/cache parameters are not cloud API fields.
		const body = anthropic
			? anthropicPayload(original, target.model)
			: {
					model: target.model,
					messages: original.messages,
					stream: true,
					stream_options: { include_usage: true },
					...(original.tools?.length ? { tools: original.tools, tool_choice: "auto" } : {}),
					...(original.max_tokens > 0 ? { max_tokens: original.max_tokens } : {}),
					...(original.reasoning_budget >= 0
						? { reasoning_budget: original.reasoning_budget }
						: {}),
				};
		const response = await fetchImpl(
			`${normalizeBaseUrl(provider.baseUrl)}/${anthropic ? "messages" : "chat/completions"}`,
			{
				method: "POST",
				signal: options.signal,
				redirect: "error",
				headers: {
					"Content-Type": "application/json",
					...(anthropic
						? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
						: { Authorization: `Bearer ${apiKey}` }),
				},
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) {
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
					prompt_tokens:
						(data.usage?.input_tokens || 0) +
						(data.usage?.cache_read_input_tokens || 0) +
						(data.usage?.cache_creation_input_tokens || 0),
					completion_tokens: data.usage?.output_tokens || 0,
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	};
}
module.exports = {
	fetchCloudModels,
	getCloudProviders,
	getCloudProviderDefaults,
	saveCloudProviderDefaults,
	getActiveMediaModel,
	saveCloudProvider,
	deleteCloudProvider,
	validateChatProvider,
	createCloudFetch,
	anthropicPayload,
};

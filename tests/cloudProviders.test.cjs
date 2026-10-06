const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
let stored = [];
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	if (name === "./db")
		return {
			db: {
				prepare: () => ({
					get: () => ({ value_json: JSON.stringify(stored) }),
					run: (value) => {
						stored = JSON.parse(value);
					},
				}),
			},
		};
	return originalLoad.call(this, name, ...args);
};
const {
	fetchCloudModels,
	getCloudProviders,
	saveCloudProvider,
	deleteCloudProvider,
	createCloudFetch,
	anthropicPayload,
	validateChatProvider,
} = require("../src/main/cloudProviders");

for (const provider of ["kimi", "groq", "local-server"])
	test(`${provider} routes to a custom endpoint with credentials and portable parameters`, async () => {
		const baseUrl =
			provider === "local-server" ? "http://localhost:8787/v1" : `https://${provider}.example/v1`;
		saveCloudProvider({
			id: provider,
			name: provider,
			baseUrl: baseUrl + "/",
			modelId: "chosen-model",
			apiKey: "test-key",
		});
		const signal = new AbortController().signal;
		const adapter = createCloudFetch(
			{ type: "cloud", provider, model: "chosen-model" },
			{
				apiKey: "test-key",
				fetchImpl: async (url, options) => {
					assert.equal(url, baseUrl + "/chat/completions");
					assert.equal(options.headers.Authorization, "Bearer test-key");
					assert.equal(options.signal, signal);
					const body = JSON.parse(options.body);
					assert.equal(body.model, "chosen-model");
					assert.equal(body.stream, true);
					for (const key of [
						"cache_prompt",
						"top_k",
						"repeat_penalty",
						"thinking_budget",
						"max_tokens",
					])
						assert.equal(key in body, false);
					assert.equal("tools" in body, false);
					return new Response("data: [DONE]\n\n", {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		);
		const response = await adapter("http://localhost:1234", {
			signal,
			body: JSON.stringify({
				model: "/local.gguf",
				messages: [{ role: "user", content: "Hi" }],
				tools: [],
				top_k: 40,
				max_tokens: -1,
				cache_prompt: true,
			}),
		});
		assert.equal(await response.text(), "data: [DONE]\n\n");
	});

test("OpenAI-compatible cloud requests carry an explicit reasoning budget", async () => {
	saveCloudProvider({
		id: "budget",
		name: "Budget API",
		baseUrl: "https://budget.example/v1",
		modelId: "reasoner",
		apiKey: "test-key",
	});
	const adapter = createCloudFetch(
		{ type: "cloud", provider: "budget", model: "reasoner" },
		{
			fetchImpl: async (_url, options) => {
				assert.equal(JSON.parse(options.body).reasoning_budget, 2500);
				return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			},
		},
	);
	await adapter("", {
		body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }], reasoning_budget: 2500 }),
	});
});

test("Anthropic translates system, tools, multiple tool results and images", () => {
	const payload = anthropicPayload(
		{
			messages: [
				{ role: "system", content: "instructions" },
				{ role: "user", content: "look" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "a", function: { name: "screen", arguments: "{}" } },
						{ id: "b", function: { name: "read", arguments: '{"path":"x"}' } },
					],
				},
				{
					role: "tool",
					tool_call_id: "a",
					content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
				},
				{ role: "tool", tool_call_id: "b", content: "hello" },
			],
			tools: [
				{
					type: "function",
					function: { name: "read", description: "Read", parameters: { type: "object" } },
				},
			],
			max_tokens: -1,
		},
		"claude-test",
	);
	assert.equal(payload.system[0].text, "instructions");
	assert.equal(payload.max_tokens, 4096);
	assert.deepEqual(
		payload.messages.map((message) => message.role),
		["user", "assistant", "user"],
	);
	assert.equal(payload.messages[1].content[0].type, "tool_use");
	assert.equal(payload.messages[2].content.length, 2);
	assert.equal(payload.messages[2].content[0].content[0].source.media_type, "image/png");
	assert.deepEqual(payload.tools[0].input_schema, { type: "object" });
	const withThinking = anthropicPayload(
		{ messages: [{ role: "user", content: "Hi" }], thinking_budget: 2500 },
		"claude-test",
	);
	assert.deepEqual(withThinking.thinking, { type: "enabled", budget_tokens: 2500 });
	assert.ok(withThinking.max_tokens > 2500);
});

test("Anthropic normalizes replies and usage for the existing tool loop", async () => {
	saveCloudProvider({
		id: "anthropic",
		name: "Claude",
		modelId: "claude-test",
		apiKey: "test-key",
		baseUrl: "https://api.anthropic.com/v1",
		apiType: "anthropic",
	});
	const adapter = createCloudFetch(
		{ type: "cloud", provider: "anthropic", model: "claude-test" },
		{
			apiKey: "test-key",
			fetchImpl: async (url, options) => {
				assert.equal(url, "https://api.anthropic.com/v1/messages");
				assert.equal(options.headers["x-api-key"], "test-key");
				assert.equal(options.headers["anthropic-version"], "2023-06-01");
				return Response.json({
					content: [
						{ type: "text", text: "Checking" },
						{ type: "tool_use", id: "tool1", name: "read", input: { path: "x" } },
					],
					usage: { input_tokens: 12, output_tokens: 3 },
				});
			},
		},
	);
	const response = await adapter("", {
		body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
	});
	const data = await response.json();
	assert.equal(data.choices[0].message.content, "Checking");
	assert.equal(data.choices[0].message.tool_calls[0].function.arguments, '{"path":"x"}');
	assert.deepEqual(data.usage, { prompt_tokens: 12, completion_tokens: 3 });
});

test("invalid providers fail closed and remote errors never expose credentials", async () => {
	assert.throws(() => validateChatProvider({ type: "cloud", provider: "evil", model: "x" }), /Invalid/);
	assert.deepEqual(validateChatProvider(), { type: "local" });
	saveCloudProvider({ id: "openai", name: "OpenAI", modelId: "x", apiKey: "secret" });
	const adapter = createCloudFetch(
		{ type: "cloud", provider: "openai", model: "x" },
		{ apiKey: "secret", fetchImpl: async () => new Response("secret", { status: 401 }) },
	);
	await assert.rejects(
		adapter("", { body: '{"messages":[]}' }),
		(error) => error.message.includes("HTTP 401") && !error.message.includes("secret"),
	);
});

test("cancellation propagates to the provider request", async () => {
	saveCloudProvider({ id: "anthropic", name: "Claude", modelId: "x", apiKey: "key", apiType: "anthropic" });
	const controller = new AbortController();
	const adapter = createCloudFetch(
		{ type: "cloud", provider: "anthropic", model: "x" },
		{
			apiKey: "key",
			fetchImpl: async (_url, { signal }) => {
				controller.abort();
				signal.throwIfAborted();
			},
		},
	);
	await assert.rejects(adapter("", { signal: controller.signal, body: '{"messages":[]}' }), {
		name: "AbortError",
	});
});

test("provider CRUD keeps secrets private, preserves blank keys and rejects stale selections", () => {
	stored = [];
	assert.deepEqual(getCloudProviders(), []);
	const input = {
		id: "custom-1",
		name: " My Server ",
		baseUrl: "http://localhost:9000/v1/",
		modelId: " model-x ",
		apiKey: " secret ",
	};
	const rows = saveCloudProvider(input);
	assert.equal(rows[0].name, "My Server");
	assert.equal(rows[0].baseUrl, "http://localhost:9000/v1");
	assert.equal(rows[0].configured, true);
	assert.ok(!JSON.stringify(rows).includes("secret"));
	saveCloudProvider({ ...input, apiKey: "", modelId: "model-y" });
	assert.equal(stored[0].apiKey, "secret");
	assert.throws(
		() => validateChatProvider({ type: "cloud", provider: input.id, model: "model-x" }),
		/Invalid/,
	);
	assert.deepEqual(deleteCloudProvider(input.id), []);
	assert.throws(() => createCloudFetch({ type: "cloud", provider: input.id, model: "model-y" }), /Invalid/);
	for (const baseUrl of [
		"file:///tmp/key",
		"https://user:secret@example.com",
		"https://example.com?key=secret",
	]) {
		assert.throws(() => saveCloudProvider({ ...input, baseUrl }));
	}
	assert.throws(() => saveCloudProvider({ ...input, apiKey: "  " }), /API key/);
});

test("legacy migration includes only stored providers and keeps Anthropic API selection", () => {
	stored = { anthropic: { model: "claude-test", apiKey: "old-secret" } };
	const rows = getCloudProviders();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].apiType, "anthropic");
	saveCloudProvider({ ...rows[0], name: "Renamed" });
	assert.ok(Array.isArray(stored));
	assert.equal(stored[0].apiKey, "old-secret");
});

test("a provider named Anthropic still defaults to OpenAI-compatible requests", async () => {
	saveCloudProvider({
		id: "anthropic",
		name: "Anthropic",
		modelId: "custom-model",
		apiKey: "key",
		baseUrl: "https://proxy.example/v1",
	});
	const adapter = createCloudFetch(
		{ type: "cloud", provider: "anthropic", model: "custom-model" },
		{
			fetchImpl: async (url, options) => {
				assert.equal(url, "https://proxy.example/v1/chat/completions");
				assert.equal(options.headers.Authorization, "Bearer key");
				const body = JSON.parse(options.body);
				assert.equal(body.max_tokens, 20);
				assert.equal(body.tools[0].function.name, "read");
				return Response.json({ choices: [] });
			},
		},
	);
	await adapter("", {
		body: JSON.stringify({
			messages: [],
			max_tokens: 20,
			tools: [{ type: "function", function: { name: "read", parameters: {} } }],
		}),
	});
});

test("model discovery supports unsaved providers and normalizes model IDs", async () => {
	const result = await fetchCloudModels(
		{ id: "new", baseUrl: "https://custom.example/v1/", apiKey: " new-key " },
		{
			fetchImpl: async (url, options) => {
				assert.equal(url, "https://custom.example/v1/models");
				assert.equal(options.method, "GET");
				assert.equal(options.headers.Authorization, "Bearer new-key");
				assert.equal(options.redirect, "error");
				assert.ok(options.signal);
				return Response.json({
					data: [{ id: "z" }, { id: "a" }, { id: "z" }, {}, null, { id: 3 }, { id: " " }],
				});
			},
		},
	);
	assert.deepEqual(result, { models: ["a", "z"] });
});

test("model discovery uses saved keys without requiring a model selection", async () => {
	saveCloudProvider({ id: "saved", name: "Saved", modelId: "existing", apiKey: "saved-secret" });
	const result = await fetchCloudModels(
		{ id: "saved", baseUrl: "http://localhost:9999/v1", apiKey: "" },
		{
			fetchImpl: async (_url, options) => {
				assert.equal(options.headers.Authorization, "Bearer saved-secret");
				return Response.json({ data: [] });
			},
		},
	);
	assert.deepEqual(result, { models: [] });
});

test("model discovery failures are safe and keep manual entry available", async () => {
	const input = { baseUrl: "https://custom.example", apiKey: "secret" };
	for (const fetchImpl of [
		async () => new Response("secret", { status: 401 }),
		async () => Response.json({ wrong: [] }),
		async () => new Response("invalid json"),
		async () => {
			throw new Error("secret");
		},
	]) {
		const result = await fetchCloudModels(input, { fetchImpl });
		assert.match(result.error, /Failed to fetch models/);
		assert.ok(!result.error.includes("secret"));
	}
	await assert.rejects(fetchCloudModels({ ...input, apiKey: "" }), /API key/);
});

test("cloud chat POST survives a GET-only global.fetch override (sub-agent shim)", async () => {
	const http = require("node:http");
	const server = http.createServer((req, res) => {
		assert.equal(req.method, "POST");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
	});
	server.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

	saveCloudProvider({ id: "shim-guard", name: "Shim Guard", modelId: "m", apiKey: "k", baseUrl });
	// Reproduce the production collision: subAgentRunner installs a GET-only global.fetch.
	const originalGlobalFetch = globalThis.fetch;
	globalThis.fetch = (url, options) => {
		if (options?.method && String(options.method).toUpperCase() !== "GET") {
			return Promise.reject(new TypeError("Sub-agent fetch only supports GET requests."));
		}
		return originalGlobalFetch(url, options);
	};
	try {
		const adapter = createCloudFetch({ type: "cloud", provider: "shim-guard", model: "m" });
		const response = await adapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
		assert.equal(response.status, 200);
		const data = await response.json();
		assert.equal(data.choices[0].message.content, "ok");
	} finally {
		globalThis.fetch = originalGlobalFetch;
		server.close();
	}
});

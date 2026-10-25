// Phase 2.0C-2 deterministic coverage for provider-aware cloud prompt caching.
//
// Every test here uses a mocked transport: no live provider traffic and no
// paid API calls. The suite mirrors the scenario list in the phase brief:
// serialization, per-provider compatibility, streaming/non-streaming,
// multi-turn and tool loops, prefix stability, reasoning coupling, subagent
// model independence, concurrent agents, cache-metric normalization, safe
// fallback, cancellation, and Phase 2.0C-1 analytics compatibility.
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
					run: (value) => { stored = JSON.parse(value); },
				}),
			},
		};
	return originalLoad.call(this, name, ...args);
};

const cloudProviders = require("../src/main/cloudProviders");
const { createCloudFetch } = cloudProviders;
const promptCaching = require("../src/lib/promptCaching.cjs");
const { phaseStats, mergePhaseStats, cacheHitRatio, extractCacheTokens } =
	require("../src/lib/completionStats.mjs");

const ANTHROPIC = { id: "direct-claude", name: "Claude", baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic" };
const OPENROUTER = { id: "router", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiType: "openai" };

function save(provider, modelId) {
	cloudProviders.saveCloudProvider({ ...provider, modelId, apiKey: "test-key" });
}

// Capture the JSON body each adapter would POST, with a canned JSON response.
function captureBody(target, { json = true, message = { role: "assistant", content: "ok" } } = {}) {
	const bodies = [];
	const adapter = createCloudFetch(target, {
		fetchImpl: async (_url, options) => {
			bodies.push(JSON.parse(options.body));
			return Response.json(
				target.model && target.model.includes("anthropic/")
					? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }
					: { choices: [{ message, finish_reason: "stop" }] },
			);
		},
	});
	return { adapter, bodies };
}

const EPHEMERAL = { type: "ephemeral" };
const CACHE_FIELDS = { cache_control: EPHEMERAL };

// Above the 1,024-token minimum for claude-sonnet-5 (~4 chars/token). Real
// prompts are far larger; tests need only cross the eligibility floor.
const LONG_SYSTEM = "You are a stable test assistant. " + "Synthetic stable instruction block. ".repeat(160);

// ---------------------------------------------------------------------------
// 1. Direct Anthropic cache-control serialization
// ---------------------------------------------------------------------------

test("direct Anthropic caches the stable first system block with an explicit breakpoint", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" });
	await adapter("", { body: JSON.stringify({
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "user", content: "Hello" },
		],
		tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }],
		max_tokens: 128,
	}) });
	const body = bodies[0];
	// Explicit block breakpoint, never the top-level automatic field.
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(body.stream, false);
	assert.equal(body.system[0].text, LONG_SYSTEM);
	// Tools precede the system breakpoint in the cache hierarchy; they are not
	// marked separately, and the message order is untouched.
	assert.equal(Object.hasOwn(body.tools[0], "cache_control"), false);
	assert.equal(body.messages.length, 1);
	assert.equal(body.tools[0].name, "read");
	// llama.cpp-only fields never leak into the Anthropic body.
	for (const key of ["cache_prompt", "stream_options", "top_k", "repeat_penalty"])
		assert.equal(Object.hasOwn(body, key), false);
});

test("Anthropic tool-use and tool-result compatibility survives the cache field", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" });
	await adapter("", { body: JSON.stringify({
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "user", content: "use the tool" },
			{ role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "read", arguments: '{"path":"x"}' } }] },
			{ role: "tool", tool_call_id: "a", content: "file text" },
		],
		tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }],
	}) });
	const body = bodies[0];
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	const roles = body.messages.map((message) => message.role);
	assert.deepEqual(roles, ["user", "assistant", "user"]);
	assert.equal(body.messages[1].content[0].type, "tool_use");
	assert.equal(body.messages[2].content[0].type, "tool_result");
	assert.equal(body.messages[2].content[0].tool_use_id, "a");
});

// ---------------------------------------------------------------------------
// 2. OpenRouter Claude caching (and no Anthropic fields for other families)
// ---------------------------------------------------------------------------

test("Anthropic models on OpenRouter receive the top-level ephemeral field", async () => {
	save(OPENROUTER, "anthropic/claude-sonnet-5");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "router", model: "anthropic/claude-sonnet-5" });
	await adapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) });
	assert.deepEqual(bodies[0].cache_control, { type: "ephemeral" });
	assert.equal(bodies[0].stream, true);
	assert.equal(bodies[0].stream_options.include_usage, true);
});

test("the ~anthropic alias is treated as Anthropic on OpenRouter", () => {
	assert.deepEqual(
		promptCaching.cacheRequestFields({ apiType: "openai", baseUrl: OPENROUTER.baseUrl, modelId: "~anthropic/claude-sonnet-latest" }),
		{ cache_control: { type: "ephemeral" } },
	);
});

// ---------------------------------------------------------------------------
// 3 & 4. MiMo and DeepSeek request compatibility
// ---------------------------------------------------------------------------

test("MiMo requests stay compatible and rely on automatic provider caching", async () => {
	save(OPENROUTER, "xiaomi/mimo-v2.6-flash");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "router", model: "xiaomi/mimo-v2.6-flash" });
	await adapter("", { body: JSON.stringify({
		messages: [{ role: "user", content: "Hi" }],
		tools: [{ type: "function", function: { name: "read", parameters: {} } }],
		reasoning: { effective: { mode: "auto", effort: null, budget: null } },
	}) });
	const body = bodies[0];
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	assert.equal(body.model, "xiaomi/mimo-v2.6-flash");
	assert.equal(body.stream, true);
	assert.equal(body.tools[0].function.name, "read");
});

test("DeepSeek requests stay compatible and rely on automatic provider caching", async () => {
	save(OPENROUTER, "deepseek/deepseek-v4.1-flash");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "router", model: "deepseek/deepseek-v4.1-flash" });
	await adapter("", { body: JSON.stringify({
		messages: [{ role: "user", content: "Hi" }],
		reasoning: { effective: { mode: "effort", effort: "low", budget: null },
			capabilities: { family: "openrouter", metadata: { supportedParameters: ["reasoning", "reasoning_effort"] } } },
	}) });
	const body = bodies[0];
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	assert.deepEqual(body.reasoning, { effort: "low" });
	// A numeric budget is not fabricated from the effort intent.
	assert.equal(Object.hasOwn(body, "reasoning_budget"), false);
});

// ---------------------------------------------------------------------------
// 5 & 6. Provider-specific capabilities and unsupported models
// ---------------------------------------------------------------------------

test("cache capabilities resolve per provider family and model route", () => {
	const direct = promptCaching.cacheCapability({ apiType: "anthropic", baseUrl: ANTHROPIC.baseUrl, modelId: "claude-sonnet-5" });
	assert.equal(direct.family, "anthropic");
	assert.equal(direct.mode, "explicit");
	assert.equal(direct.explicitBreakpoints, true);
	assert.equal(direct.breakpoint, "first-system-block");
	assert.deepEqual(direct.requestFields, {});
	assert.equal(direct.reportsWrites, true);

	const orClaude = promptCaching.cacheCapability({ apiType: "openai", baseUrl: OPENROUTER.baseUrl, modelId: "anthropic/claude-sonnet-5" });
	assert.equal(orClaude.family, "openrouter");
	assert.equal(orClaude.transport, "anthropic");
	assert.deepEqual(orClaude.requestFields, CACHE_FIELDS);

	const mimo = promptCaching.cacheCapability({ apiType: "openai", baseUrl: OPENROUTER.baseUrl, modelId: "xiaomi/mimo-v2.6-flash" });
	assert.equal(mimo.transport, "openrouter");
	assert.deepEqual(mimo.requestFields, {});
	assert.equal(mimo.reportsWrites, false);

	const deepseekDirect = promptCaching.cacheCapability({ apiType: "openai", baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat" });
	assert.equal(deepseekDirect.mode, "server-side");

	const unknown = promptCaching.cacheCapability({ apiType: "openai", baseUrl: "https://custom.example/v1", modelId: "mystery" });
	assert.equal(unknown.mode, "unknown");
	assert.deepEqual(unknown.requestFields, {});
});

test("unsupported and unknown models never receive an invented cache field", async () => {
	save({ id: "custom", name: "Custom", baseUrl: "https://custom.example/v1", apiType: "openai" }, "mystery-model");
	const custom = captureBody({ type: "cloud", provider: "custom", model: "mystery-model" });
	await custom.adapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) });
	assert.equal(Object.hasOwn(custom.bodies[0], "cache_control"), false);

	// An OpenRouter model from a vendor with no documented Anthropic-style
	// control also gets no field.
	save(OPENROUTER, "meta-llama/llama-4-70b");
	const or = captureBody({ type: "cloud", provider: "router", model: "meta-llama/llama-4-70b" });
	await or.adapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) });
	assert.equal(Object.hasOwn(or.bodies[0], "cache_control"), false);
});

// ---------------------------------------------------------------------------
// 7. Streaming and non-streaming
// ---------------------------------------------------------------------------

test("cache control is independent of streaming and JSON transports", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	// Non-streaming sub-agent shape (createCloudFetch default stream=false).
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" });
	await adapter("", { body: JSON.stringify({ messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "Hi" }] }) });
	assert.deepEqual(bodies[0].system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(bodies[0], "cache_control"), false);
	assert.equal(bodies[0].stream, false);

	// Streaming main-chat shape is opted in by the caller's stream flag, but the
	// direct Anthropic adapter always returns one JSON body with the same stable
	// block breakpoint.
	const streaming = createCloudFetch({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" }, {
		stream: true,
		fetchImpl: async (_url, options) => {
			const body = JSON.parse(options.body);
			assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
			assert.equal(Object.hasOwn(body, "cache_control"), false);
			return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
		},
	});
	await streaming("", { body: JSON.stringify({ messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "Hi" }] }) });
});

// ---------------------------------------------------------------------------
// 8 & 9. Multi-turn growth and tool-use continuation
// ---------------------------------------------------------------------------

test("multi-turn growth keeps a stable prefix and caches the whole prefix", async () => {
	save(OPENROUTER, "anthropic/claude-sonnet-5");
	const base = { role: "system", content: "stable system prefix" };
	const bodies = [];
	const adapter = createCloudFetch({ type: "cloud", provider: "router", model: "anthropic/claude-sonnet-5" }, {
		fetchImpl: async (_url, options) => {
			bodies.push(JSON.parse(options.body));
			return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
		},
	});
	await adapter("", { body: JSON.stringify({ messages: [base, { role: "user", content: "one" }] }) });
	await adapter("", { body: JSON.stringify({ messages: [base, { role: "user", content: "one" },
		{ role: "assistant", content: "reply" }, { role: "user", content: "two" }] }) });
	assert.deepEqual(bodies[0].cache_control, EPHEMERAL);
	assert.deepEqual(bodies[1].cache_control, EPHEMERAL);
	// The first two message entries are identical across turns (append-only).
	assert.deepEqual(bodies[1].messages.slice(0, 2), bodies[0].messages.slice(0, 2));
	assert.equal(bodies[1].messages.length, 4);
});

// ---------------------------------------------------------------------------
// 10. Stable prompt prefixes
// ---------------------------------------------------------------------------

test("the adapter adds no per-request dynamic content to the prompt", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" });
	const payload = JSON.stringify({
		messages: [ { role: "system", content: "sys" }, { role: "user", content: "hi" } ],
		tools: [{ type: "function", function: { name: "z", parameters: {} } }, { type: "function", function: { name: "a", parameters: {} } }],
	});
	await adapter("", { body: payload });
	await adapter("", { body: payload });
	// Byte-identical request bodies for identical inputs: no timestamp, id, or
	// reordered tool list is injected at the transport boundary.
	assert.equal(JSON.stringify(bodies[0]), JSON.stringify(bodies[1]));
	assert.deepEqual(bodies[0].tools.map((tool) => tool.name), ["z", "a"]);
});

// ---------------------------------------------------------------------------
// 11. Reasoning controls
// ---------------------------------------------------------------------------

test("Anthropic thinking and cache control coexist without duplication", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" });
	await adapter("", { body: JSON.stringify({
		messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "Think" }],
		reasoning: { effective: { mode: "budget", effort: null, budget: 2048 },
			capabilities: { family: "anthropic", metadata: { supportedParameters: [] } } },
		max_tokens: 100,
	}) });
	const body = bodies[0];
	assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	assert.ok(body.max_tokens > 2048);
	// Exactly one cache_control in the whole body, on the stable system block.
	assert.equal(JSON.stringify(body).split('"cache_control"').length - 1, 1);
});

test("OpenRouter reasoning is preserved while automatic caching adds no field", async () => {
	save(OPENROUTER, "xiaomi/mimo-v2.6-flash");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "router", model: "xiaomi/mimo-v2.6-flash" });
	await adapter("", { body: JSON.stringify({
		messages: [{ role: "user", content: "Think" }],
		reasoning: { effective: { mode: "effort", effort: "medium", budget: null },
			capabilities: { family: "openrouter", metadata: { supportedParameters: ["reasoning"] } } },
	}) });
	assert.deepEqual(bodies[0].reasoning, { effort: "medium" });
	assert.equal(Object.hasOwn(bodies[0], "cache_control"), false);
});

// ---------------------------------------------------------------------------
// 12. Context compaction
// ---------------------------------------------------------------------------

test("a compacted conversation still receives the cache field with stable ordering", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { adapter, bodies } = captureBody({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" });
	await adapter("", { body: JSON.stringify({
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "system", content: "[EARLIER CONVERSATION SUMMARY]:\nshort summary" },
			{ role: "user", content: "continue" },
		],
	}) });
	const body = bodies[0];
	// The breakpoint stays on the stable base block; a summary appended after
	// it cannot invalidate the cached prefix.
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body.system[1], "cache_control"), false);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	assert.equal(body.system.some((block) => block.text.startsWith("[EARLIER CONVERSATION SUMMARY]")), true);
	// Ordering is preserved: the base instruction block stays first.
	assert.equal(body.system[0].text, LONG_SYSTEM);
	assert.equal(body.messages.length, 1);
});

// ---------------------------------------------------------------------------
// 13. Subagent model independence
// ---------------------------------------------------------------------------

test("a child cloud provider resolves caching from its own target, not the parent", async () => {
	const cloudProvider = require("../src/main/subagents/providers/cloudProvider");
	const childTarget = { type: "cloud", provider: "router", model: "xiaomi/mimo-v2.6-flash" };
	save(OPENROUTER, "xiaomi/mimo-v2.6-flash");
	const original = cloudProviders.createCloudFetch;
	let seenTarget = null;
	cloudProviders.createCloudFetch = (target, options) => {
		seenTarget = target;
		return async () => Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
	};
	try {
		await cloudProvider.chatCompletion({
			engine: { provider: "cloud", modelId: "xiaomi/mimo-v2.6-flash", chatTarget: childTarget },
			// The parent is an Anthropic chat; its descriptor must not leak.
			payload: { model: "xiaomi/mimo-v2.6-flash", messages: [{ role: "user", content: "hi" }],
				reasoning: { effective: { mode: "effort", effort: "high", budget: null },
					capabilities: { family: "anthropic", metadata: { supportedParameters: [] } } } },
			signal: new AbortController().signal,
		});
		assert.deepEqual(seenTarget, childTarget);
	} finally {
		cloudProviders.createCloudFetch = original;
	}
	// Independently, the real adapter for the child target adds no cache field.
	const child = captureBody(childTarget);
	await child.adapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
	assert.equal(Object.hasOwn(child.bodies[0], "cache_control"), false);
});

// ---------------------------------------------------------------------------
// 14. Concurrent cloud agents
// ---------------------------------------------------------------------------

test("concurrent Anthropic and OpenRouter agents keep independent cache fields", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	save(OPENROUTER, "xiaomi/mimo-v2.6-flash");
	const bodies = { anthropic: null, mimo: null };
	const anthropicAdapter = createCloudFetch({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" }, {
		fetchImpl: async (_url, options) => { bodies.anthropic = JSON.parse(options.body);
			return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }); },
	});
	const mimoAdapter = createCloudFetch({ type: "cloud", provider: "router", model: "xiaomi/mimo-v2.6-flash" }, {
		fetchImpl: async (_url, options) => { bodies.mimo = JSON.parse(options.body);
			return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }); },
	});
	await Promise.all([
		anthropicAdapter("", { body: JSON.stringify({ messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "a" }] }) }),
		mimoAdapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "b" }] }) }),
	]);
	assert.deepEqual(bodies.anthropic.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(bodies.anthropic, "cache_control"), false);
	assert.equal(Object.hasOwn(bodies.mimo, "cache_control"), false);
});

// ---------------------------------------------------------------------------
// 15 & 16. Cache-read and cache-creation usage normalization
// ---------------------------------------------------------------------------

test("OpenRouter cache reads and writes normalize into phase stats", () => {
	const phase = phaseStats({
		usage: {
			prompt_tokens: 1000, completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 },
		},
		startTime: 0, endTime: 1,
	});
	assert.equal(phase.cacheReadTokens, 800);
	assert.equal(phase.cacheWriteTokens, 150);
	assert.equal(phase.uncachedInputTokens, 50); // 1000 - 800 - 150
	assert.equal(phase.cacheReadCoverage, "measured");
	assert.equal(phase.cacheWriteCoverage, "measured");
});

test("Anthropic cache reads and writes stay distinct and are not double counted", () => {
	const { cached, created } = extractCacheTokens({ cache_read_input_tokens: 40, cache_creation_input_tokens: 60 });
	assert.equal(cached, 40);
	assert.equal(created, 60);
});

// ---------------------------------------------------------------------------
// 17 & 18. Missing metrics and safe fallback
// ---------------------------------------------------------------------------

test("a provider that reports no cache metrics stays unknown, not zero", async () => {
	const phase = phaseStats({ usage: { prompt_tokens: 100, completion_tokens: 5 }, startTime: 0, endTime: 1 });
	assert.equal(phase.cacheReadTokens, null);
	assert.equal(phase.cacheWriteTokens, null);
	assert.equal(phase.uncachedInputTokens, null);
	assert.equal(phase.cacheReadCoverage, "unavailable");
	assert.equal(cacheHitRatio(phase), null);
	const turn = mergePhaseStats([phase], 0);
	assert.equal(turn.cacheReadCoverage, "unavailable");
	assert.equal(cacheHitRatio(turn), null);
});

test("a provider rejecting the request surfaces a clean error with no retry", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	let calls = 0;
	const adapter = createCloudFetch({ type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" }, {
		fetchImpl: async () => { calls++; return new Response("bad request body", { status: 400 }); },
	});
	await assert.rejects(adapter("", { body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) }),
		(error) => error.message.includes("HTTP 400") && !error.message.includes("bad request body"));
	assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// 19. Cancellation and timeout
// ---------------------------------------------------------------------------

test("cancellation propagates before any cache field is sent", async () => {
	save(OPENROUTER, "deepseek/deepseek-v4.1-flash");
	const controller = new AbortController();
	const adapter = createCloudFetch({ type: "cloud", provider: "router", model: "deepseek/deepseek-v4.1-flash" }, {
		fetchImpl: async (_url, { signal, options }) => { controller.abort(); signal.throwIfAborted(); },
	});
	await assert.rejects(
		adapter("", { signal: controller.signal, body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) }),
		{ name: "AbortError" },
	);
});

// ---------------------------------------------------------------------------
// 20. Phase 2.0C-1 analytics compatibility
// ---------------------------------------------------------------------------

test("normalized cache metrics feed Phase 2.0C-1 turn aggregation and ratio", () => {
	const first = phaseStats({ usage: { prompt_tokens: 1200, completion_tokens: 20,
		prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 } }, startTime: 0, endTime: 1 });
	const second = phaseStats({ usage: { prompt_tokens: 1400, completion_tokens: 25,
		prompt_tokens_details: { cached_tokens: 1300, cache_write_tokens: 50 } }, startTime: 1, endTime: 2 });
	const turn = mergePhaseStats([first, second], 0);
	assert.equal(turn.grossInputTokens, 2600);
	assert.equal(turn.cacheReadTokens, 2200);
	assert.equal(turn.cacheWriteTokens, 250);
	assert.equal(turn.cacheReadCoverage, "measured");
	assert.equal(cacheHitRatio(turn), 2200 / 2600 * 100);
	assert.equal(turn.outputTokens, 45);
});

// ---------------------------------------------------------------------------
// Prompt-stability regression guard for the real prompt builder
// ---------------------------------------------------------------------------

test("the temporal anchor is stable within a day and does not change per call", () => {
	const { buildTemporalAnchor } = require("../src/main/baseSystemPrompt");
	const first = buildTemporalAnchor();
	const second = buildTemporalAnchor();
	assert.equal(first, second);
	assert.match(first, /^\[TEMPORAL CONTEXT\]\nToday's Date: .+\(\d{4}-\d{2}-\d{2}\)\nUser Timezone Offset: -?\d+ mins\n/);
	// The anchor also carries the ground-truth policy line.
	assert.match(first, /factual ground truth for this session — not fictional or roleplay/);
});

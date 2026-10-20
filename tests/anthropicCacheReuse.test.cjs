// Phase 2.0C-2A deterministic coverage for direct-Anthropic stable-prefix
// caching. Every test uses a mocked transport: no live traffic, no paid calls.
//
// The suite deliberately compares serialized request bodies. A serialization
// test proves what Continuum sends, not that Anthropic reused a cache; live
// reuse is reported separately in docs/anthropic-cache-reuse-verification.md.
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
const { prependBaseSystemPrompt } = require("../src/main/baseSystemPrompt");
const { phaseStats } = require("../src/lib/completionStats.mjs");

const ANTHROPIC = { id: "direct-claude", name: "Claude", baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic" };
const OPENROUTER = { id: "router", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiType: "openai" };
const OR_CLAUDE = { ...OPENROUTER, id: "or-claude" };
const MIMO = { ...OPENROUTER, id: "or-mimo" };
const DEEPSEEK = { ...OPENROUTER, id: "or-deepseek" };
const CUSTOM = { id: "custom", name: "Custom", baseUrl: "https://custom.example/v1", apiType: "openai" };

// ~5,400 characters, comfortably above the 1,024-token Sonnet 5 minimum.
const LONG_SYSTEM = "You are a stable test assistant. " + "Synthetic stable instruction block. ".repeat(160);
const SHORT_SYSTEM = "You are brief.";
const EPHEMERAL = { type: "ephemeral" };

function save(provider, modelId) {
	cloudProviders.saveCloudProvider({ ...provider, modelId, apiKey: "test-key" });
}

function isAnthropicTarget(target) {
	return stored.find((row) => row.id === target.provider)?.apiType === "anthropic";
}

function cannedResponse(target, usage = {}) {
	if (isAnthropicTarget(target))
		return Response.json({
			content: [{ type: "text", text: "ok" }],
			usage: { input_tokens: 2, output_tokens: 3, ...usage },
		});
	return Response.json({
		choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
		usage,
	});
}

async function post(target, payload, { stream = false, usage = {} } = {}) {
	const bodies = [];
	const adapter = createCloudFetch(target, {
		stream,
		fetchImpl: async (_url, options) => {
			bodies.push(JSON.parse(options.body));
			return cannedResponse(target, usage);
		},
	});
	const response = await adapter("", { body: JSON.stringify(payload) });
	return { body: bodies[0], response };
}

function countCacheControls(body) {
	return JSON.stringify(body).split('"cache_control"').length - 1;
}

function cacheControlPositions(body) {
	const positions = [];
	(body.system || []).forEach((block, index) => {
		if (block && block.cache_control) positions.push(`system:${index}`);
	});
	(body.tools || []).forEach((tool, index) => {
		if (tool && tool.cache_control) positions.push(`tool:${index}`);
	});
	if (body.cache_control) positions.push("automatic");
	return positions;
}

const TARGET = { type: "cloud", provider: "direct-claude", model: "claude-sonnet-5" };

// ---------------------------------------------------------------------------
// 1 & 2. Stable prefix across two requests with different user suffixes
// ---------------------------------------------------------------------------

test("identical stable system prefixes serialize identically across two requests", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const tools = [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }];
	const first = await post(TARGET, {
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "user", content: "first turn" },
			{ role: "assistant", content: "ack" },
			{ role: "user", content: "Reply with ALPHA." },
		],
		tools,
	});
	const second = await post(TARGET, {
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "user", content: "first turn" },
			{ role: "assistant", content: "ack" },
			{ role: "user", content: "Reply with BETA." },
		],
		tools,
	});

	assert.deepEqual(first.body.system, second.body.system);
	assert.deepEqual(first.body.tools, second.body.tools);
	assert.deepEqual(first.body.messages.slice(0, -1), second.body.messages.slice(0, -1));
	assert.notDeepEqual(first.body.messages.at(-1), second.body.messages.at(-1));
	assert.deepEqual(cacheControlPositions(first.body), ["system:0"]);
	assert.deepEqual(cacheControlPositions(second.body), ["system:0"]);
});

test("different final user messages keep the same stable breakpoint", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const a = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "one" }] });
	const b = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "two" }] });
	assert.equal(a.body.system[0].text, b.body.system[0].text);
	assert.deepEqual(a.body.system[0].cache_control, b.body.system[0].cache_control);
	assert.equal(a.body.messages.at(-1).content[0].text, "one");
	assert.equal(b.body.messages.at(-1).content[0].text, "two");
});

// ---------------------------------------------------------------------------
// 3-6. Breakpoint placement and system-block shapes
// ---------------------------------------------------------------------------

test("the explicit breakpoint is on the first system block, not the changing tail", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, {
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "system", content: "[PROJECT BRIEF]\nThis changes between turns." },
			{ role: "system", content: "[SESSION INSTRUCTIONS]\nAlso per-session." },
			{ role: "user", content: "go" },
		],
	});
	assert.equal(body.system[0].text, LONG_SYSTEM);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body.system[1], "cache_control"), false);
	assert.equal(Object.hasOwn(body.system[2], "cache_control"), false);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
});

test("Anthropic system blocks serialize as text blocks with the breakpoint attached", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] });
	assert.ok(Array.isArray(body.system));
	assert.equal(body.system.length, 1);
	assert.equal(body.system[0].type, "text");
	assert.equal(body.system[0].text, LONG_SYSTEM);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
});

test("a string-form system prompt is normalized to a cacheable block", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] });
	assert.equal(Array.isArray(body.system), true);
	assert.equal(body.system[0].text, LONG_SYSTEM);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
});

test("an array-form system prompt keeps its shape and caches the stable block", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, {
		messages: [{ role: "system", content: [{ type: "text", text: LONG_SYSTEM }] }, { role: "user", content: "hi" }],
	});
	assert.equal(body.system[0].type, "text");
	assert.equal(body.system[0].text, LONG_SYSTEM);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(countCacheControls(body), 1);
});

// ---------------------------------------------------------------------------
// 7 & 8. Tools precede the breakpoint; tool changes invalidate as expected
// ---------------------------------------------------------------------------

test("tool definitions precede the breakpoint and are not marked separately", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const tools = [
		{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } },
		{ type: "function", function: { name: "write", description: "Write", parameters: { type: "object" } } },
	];
	const { body } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "go" }], tools });
	assert.deepEqual(body.tools.map((tool) => tool.name), ["read", "write"]);
	assert.equal(body.tools.some((tool) => tool.cache_control), false);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
});

test("a tool-definition change keeps the same boundary but changes the cached prefix", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const base = { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "go" }] };
	const a = await post(TARGET, { ...base, tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }] });
	const b = await post(TARGET, { ...base, tools: [{ type: "function", function: { name: "read", description: "Read v2", parameters: { type: "object" } } }] });
	// Placement is deterministic; the content difference is what invalidates
	// the provider cache, which is expected Anthropic behavior.
	assert.deepEqual(cacheControlPositions(a.body), ["system:0"]);
	assert.deepEqual(cacheControlPositions(b.body), ["system:0"]);
	assert.notDeepEqual(a.body.tools, b.body.tools);
});

// ---------------------------------------------------------------------------
// 9-11. Reasoning, streaming, non-streaming
// ---------------------------------------------------------------------------

test("reasoning settings are preserved and do not duplicate cache controls", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, {
		messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "think" }],
		reasoning: { effective: { mode: "budget", effort: null, budget: 2048 },
			capabilities: { family: "anthropic", metadata: { supportedParameters: [] } } },
		max_tokens: 100,
	});
	assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(countCacheControls(body), 1);
	assert.ok(body.max_tokens > 2048);
});

test("streaming requests carry the same stable explicit breakpoint", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] }, { stream: true });
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
	assert.equal(body.stream, false); // Anthropic transport is JSON either way.
});

test("non-streaming requests carry the same stable explicit breakpoint", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { body } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] }, { stream: false });
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
});

// ---------------------------------------------------------------------------
// 12 & 13. Main-chat and workspace prompt shapes
// ---------------------------------------------------------------------------

test("a casual main-chat prompt keeps the base system block as the boundary", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const messages = prependBaseSystemPrompt([{ role: "user", content: "hello" }], true, true, "off");
	const tools = [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }];
	const { body } = await post(TARGET, { messages, tools });
	assert.match(body.system[0].text, /^\[TEMPORAL CONTEXT\]/);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	assert.equal(body.system.length, 1);
});

test("a workspace prompt caches the base block and leaves briefs and plans uncached", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const messages = prependBaseSystemPrompt([
		{ role: "system", content: "[PROJECT BRIEF]\nWork on the synthetic task." },
		{ role: "system", content: "[ACTIVE AGENT]\nSynthetic agent instructions." },
		{ role: "user", content: "do the work" },
		{ role: "system", content: "[WORK LOG]\nTurn 1 digest." },
		{ role: "system", content: "[CURRENT PLAN]\n1. synthetic step" },
	], true, true, "off");
	const tools = [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }];
	const { body } = await post(TARGET, { messages, tools });
	assert.match(body.system[0].text, /^\[TEMPORAL CONTEXT\]/);
	assert.deepEqual(body.system[0].cache_control, EPHEMERAL);
	// Dynamic workspace blocks are preserved in order but never marked.
	for (const block of body.system.slice(1)) assert.equal(Object.hasOwn(block, "cache_control"), false);
	assert.equal(body.system.length, 5);
});

// ---------------------------------------------------------------------------
// 14 & 15. Subagents and parent/child independence
// ---------------------------------------------------------------------------

test("a direct-Claude subagent resolves its own explicit cache boundary", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const cloudProvider = require("../src/main/subagents/providers/cloudProvider");
	const original = cloudProviders.createCloudFetch;
	let captured = null;
	cloudProviders.createCloudFetch = (target, options = {}) =>
		original(target, {
			...options,
			fetchImpl: async (_url, request) => {
				captured = JSON.parse(request.body);
				return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2, output_tokens: 3 } });
			},
		});
	try {
		const result = await cloudProvider.chatCompletion({
			engine: { provider: "cloud", modelId: "claude-sonnet-5", chatTarget: TARGET },
			payload: { model: "claude-sonnet-5", messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "investigate" }], max_tokens: 64 },
			signal: new AbortController().signal,
		});
		assert.equal(result.ok, true);
	} finally {
		cloudProviders.createCloudFetch = original;
	}
	assert.deepEqual(captured.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(captured, "cache_control"), false);
});

test("parent and child prompts cache independently, never by inheritance", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	save(MIMO, "xiaomi/mimo-v2.6-flash");
	const parent = await post(TARGET, { messages: [{ role: "system", content: `PARENT\n${LONG_SYSTEM}` }, { role: "user", content: "parent" }] });
	const child = await post({ type: "cloud", provider: "or-mimo", model: "xiaomi/mimo-v2.6-flash" },
		{ messages: [{ role: "system", content: "CHILD\nsynthetic child prompt" }, { role: "user", content: "child" }] });
	assert.deepEqual(parent.body.system[0].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(child.body, "cache_control"), false);
	assert.equal(JSON.stringify(child.body).includes("cache_control"), false);
	assert.notEqual(parent.body.system[0].text, child.body.messages[0].content);
});

// ---------------------------------------------------------------------------
// 16-18. Short prefixes, missing system prompts, automatic fallback
// ---------------------------------------------------------------------------

test("a short stable prefix does not get an ineffective block breakpoint", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const plan = promptCaching.anthropicCachePlan({ system: [{ type: "text", text: SHORT_SYSTEM }] }, { modelId: "claude-sonnet-5" });
	assert.equal(plan.strategy, "automatic");
	const { body } = await post(TARGET, { messages: [{ role: "system", content: SHORT_SYSTEM }, { role: "user", content: "hi" }] });
	assert.equal(Object.hasOwn(body.system[0], "cache_control"), false);
	assert.deepEqual(body.cache_control, EPHEMERAL);
});

test("without a system prompt the last tool definition is the stable boundary", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const tools = [
		{ type: "function", function: { name: "one", description: "x".repeat(4500), parameters: { type: "object" } } },
		{ type: "function", function: { name: "two", description: "Read", parameters: { type: "object" } } },
	];
	const { body } = await post(TARGET, { messages: [{ role: "user", content: "hi" }], tools });
	assert.deepEqual(body.tools[1].cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(body.tools[0], "cache_control"), false);
	assert.equal(Object.hasOwn(body, "cache_control"), false);
});

test("without any stable prefix, automatic caching remains the fallback", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const plan = promptCaching.anthropicCachePlan({ system: [], messages: [] }, { modelId: "claude-sonnet-5" });
	assert.equal(plan.strategy, "automatic");
	const { body } = await post(TARGET, { messages: [{ role: "user", content: "hi" }] });
	assert.deepEqual(body.cache_control, EPHEMERAL);
	assert.equal(body.system.length, 0);
});

// ---------------------------------------------------------------------------
// 19 & 20. Unsupported models and duplicate-protection
// ---------------------------------------------------------------------------

test("unsupported and non-Anthropic providers never receive Anthropic cache fields", async () => {
	save(MIMO, "xiaomi/mimo-v2.6-flash");
	save(DEEPSEEK, "deepseek/deepseek-v4.1-flash");
	save(CUSTOM, "mystery-model");
	for (const [target, label] of [
		[{ type: "cloud", provider: "or-mimo", model: "xiaomi/mimo-v2.6-flash" }, "MiMo"],
		[{ type: "cloud", provider: "or-deepseek", model: "deepseek/deepseek-v4.1-flash" }, "DeepSeek"],
		[{ type: "cloud", provider: "custom", model: "mystery-model" }, "custom"],
	]) {
		const { body } = await post(target, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] });
		assert.equal(JSON.stringify(body).includes("cache_control"), false, `${label} must not receive cache_control`);
	}
});

test("existing explicit markers are preserved without adding a second strategy", () => {
	const body = {
		system: [{ type: "text", text: LONG_SYSTEM, cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: "hi" }],
		cache_control: { type: "ephemeral" },
	};
	const out = promptCaching.applyAnthropicCaching(body, { modelId: "claude-sonnet-5" });
	assert.equal(countCacheControls(out), 1);
	assert.equal(Object.hasOwn(out, "cache_control"), false);
	assert.deepEqual(cacheControlPositions(out), ["system:0"]);
});

// ---------------------------------------------------------------------------
// 21. Context compaction
// ---------------------------------------------------------------------------

test("context compaction appends a summary without moving the breakpoint", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const before = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "continue" }] });
	const after = await post(TARGET, {
		messages: [
			{ role: "system", content: LONG_SYSTEM },
			{ role: "system", content: "[EARLIER CONVERSATION SUMMARY]:\nnew summary" },
			{ role: "user", content: "continue" },
		],
	});
	assert.equal(before.body.system[0].text, after.body.system[0].text);
	assert.deepEqual(before.body.system[0].cache_control, after.body.system[0].cache_control);
	assert.equal(Object.hasOwn(after.body.system[1], "cache_control"), false);
});

// ---------------------------------------------------------------------------
// 22 & 23. Usage normalization
// ---------------------------------------------------------------------------

test("Anthropic cache-creation usage normalizes into gross input without double counting", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { response } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] },
		{ usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0 } });
	const json = await response.json();
	assert.equal(json.usage.cache_creation_input_tokens, 1500);
	assert.equal(json.usage.cache_read_input_tokens, 0);
	assert.equal(json.usage.prompt_tokens, 1520); // 20 + 1500 + 0
	const phase = phaseStats({ usage: json.usage, startTime: 0, endTime: 1 });
	assert.equal(phase.cacheWriteTokens, 1500);
	assert.equal(phase.cacheReadTokens, 0);
	assert.equal(phase.uncachedInputTokens, 20);
});

test("Anthropic cache-read usage normalizes and stays distinct from creation", async () => {
	save(ANTHROPIC, "claude-sonnet-5");
	const { response } = await post(TARGET, { messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] },
		{ usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 4800, cache_creation_input_tokens: 0 } });
	const json = await response.json();
	assert.equal(json.usage.cache_read_input_tokens, 4800);
	assert.equal(json.usage.cache_creation_input_tokens, 0);
	assert.equal(json.usage.prompt_tokens, 4812);
	const phase = phaseStats({ usage: json.usage, startTime: 0, endTime: 1 });
	assert.equal(phase.cacheReadTokens, 4800);
	assert.equal(phase.cacheWriteTokens, 0);
	assert.equal(phase.uncachedInputTokens, 12);
});

// ---------------------------------------------------------------------------
// 24 & 25. No leakage; Phase 2.0C-2 behavior preserved
// ---------------------------------------------------------------------------

test("OpenRouter Claude keeps its automatic field while other families stay untouched", async () => {
	save(OR_CLAUDE, "anthropic/claude-sonnet-5");
	save(MIMO, "xiaomi/mimo-v2.6-flash");
	const claude = await post({ type: "cloud", provider: "or-claude", model: "anthropic/claude-sonnet-5" },
		{ messages: [{ role: "system", content: LONG_SYSTEM }, { role: "user", content: "hi" }] });
	const mimo = await post({ type: "cloud", provider: "or-mimo", model: "xiaomi/mimo-v2.6-flash" },
		{ messages: [{ role: "user", content: "hi" }] });
	assert.deepEqual(claude.body.cache_control, EPHEMERAL);
	assert.equal(Object.hasOwn(mimo.body, "cache_control"), false);
});

test("MiMo and DeepSeek automatic caching and reasoning payloads are unchanged", async () => {
	save(MIMO, "xiaomi/mimo-v2.6-flash");
	save(DEEPSEEK, "deepseek/deepseek-v4.1-flash");
	const mimo = await post({ type: "cloud", provider: "or-mimo", model: "xiaomi/mimo-v2.6-flash" }, {
		messages: [{ role: "user", content: "hi" }],
		reasoning: { effective: { mode: "effort", effort: "medium", budget: null },
			capabilities: { family: "openrouter", metadata: { supportedParameters: ["reasoning"] } } },
	});
	const deepseek = await post({ type: "cloud", provider: "or-deepseek", model: "deepseek/deepseek-v4.1-flash" }, {
		messages: [{ role: "user", content: "hi" }],
		reasoning: { effective: { mode: "effort", effort: "low", budget: null },
			capabilities: { family: "openrouter", metadata: { supportedParameters: ["reasoning", "reasoning_effort"] } } },
	});
	assert.deepEqual(mimo.body.reasoning, { effort: "medium" });
	assert.equal(Object.hasOwn(mimo.body, "cache_control"), false);
	assert.equal(Object.hasOwn(deepseek.body, "cache_control"), false);
});

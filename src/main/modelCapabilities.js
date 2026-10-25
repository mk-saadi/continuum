"use strict";

function normalizeCapabilities(props = {}) {
	const modalities = props.modalities || {};
	const boolean = (value) => (typeof value === "boolean" ? value : null);
	const context = props.default_generation_settings?.n_ctx;
	const templateCaps =
		props.chat_template_caps || props.default_generation_settings?.chat_template_caps || {};
	return {
		source: "runtime",
		image: boolean(modalities.vision),
		audio: boolean(modalities.audio),
		video: boolean(modalities.video),
		contextLength: Number.isSafeInteger(context) && context > 0 ? context : null,
		build: typeof props.build_info === "string" ? props.build_info : null,
		modelPath: typeof props.model_path === "string" ? props.model_path : null,
		// The server reports template-driven reasoning controls when available.
		// Unknown values stay null; they are never guessed from the model name.
		reasoning: {
			supportsEffort: boolean(
				templateCaps.supports_reasoning_effort ?? templateCaps.supportsReasoningEffort,
			),
			supportsBudget: boolean(
				templateCaps.supports_reasoning_budget ?? templateCaps.supportsReasoningBudget,
			),
			supportsDisable: boolean(
				templateCaps.supports_enable_thinking ?? templateCaps.supportsDisableReasoning,
			),
			controlling: boolean(templateCaps.controlling_reasoning ?? templateCaps.controllingReasoning),
		},
	};
}
async function queryCapabilities(port, fetchImpl = fetch, signal) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid engine port.");
	const response = await fetchImpl(`http://127.0.0.1:${port}/props`, {
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error(`Cannot verify model capabilities (HTTP ${response.status}).`);
	return normalizeCapabilities(await response.json());
}
function requiredModalities(messages = []) {
	const required = new Set();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image_url") required.add("image");
			if (part.type === "input_audio" || part.type === "audio_url") required.add("audio");
			if (part.type === "video_url" || part.type === "input_video") required.add("video");
		}
	}
	return [...required];
}
function assertCapabilities(capabilities, required) {
	for (const kind of required) {
		if (capabilities?.[kind] !== true)
			throw new Error(
				capabilities?.[kind] === false
					? `The loaded model does not support ${kind} input.`
					: `${kind[0].toUpperCase() + kind.slice(1)} input has not been verified. Load a compatible model and projector with an engine that reports media capabilities.`,
			);
	}
}
function createMediaGuardedFetch(fetchImpl, getOverrides = () => ({})) {
	return async (url, options = {}) => {
		const endpoint = new URL(url);
		if (endpoint.pathname === "/v1/chat/completions" && typeof options.body === "string") {
			const required = requiredModalities(JSON.parse(options.body).messages);
			if (required.length) {
				const overrides = await getOverrides(endpoint);
				let detected;
				try {
					detected = await queryCapabilities(Number(endpoint.port), fetchImpl, options.signal);
				} catch (error) {
					if (!required.every((kind) => typeof overrides[kind] === "boolean")) throw error;
					detected = {};
				}
				assertCapabilities({ ...detected, ...overrides }, required);
			}
		}
		return fetchImpl(url, options);
	};
}
module.exports = {
	normalizeCapabilities,
	queryCapabilities,
	requiredModalities,
	assertCapabilities,
	createMediaGuardedFetch,
};

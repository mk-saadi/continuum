"use strict";
async function getAttachmentPolicy({ modelId, activeChatProvider = { type: "local" } }, getEngineConfig) {
	const { getOverrides, applyOverrides } = require("./capabilityOverrides");
	const { attachmentPolicy } = await import("../lib/attachmentPolicy.mjs");
	if (activeChatProvider.type === "cloud") {
		const clouds = require("./cloudProviders");
		const target = clouds.validateChatProvider(activeChatProvider);
		const provider = clouds.getCloudProviders().find((row) => row.id === target.provider);
		const row = (await clouds.getCloudModelMetadata()).find(
			(row) => row.providerId === target.provider && row.modelId === target.model,
		);
		const overrides = getOverrides(target);
		return attachmentPolicy(applyOverrides(row?.capabilities, overrides), {
			apiType: provider.apiType,
			service: row?.providerName,
			overrides,
		});
	}
	if (activeChatProvider.type !== "local") throw new Error("Invalid chat provider.");
	const engine = getEngineConfig?.();
	let capabilities = {};
	if (engine && engine.modelPath === modelId) {
		try {
			capabilities = await require("./modelCapabilities").queryCapabilities(engine.port);
		} catch {
			/* Unknown media support stays disabled; documents still work. */
		}
		const current = getEngineConfig?.();
		if (!current || current.modelPath !== modelId || current.port !== engine.port)
			throw new Error("The loaded model changed. Retry attaching the file.");
	}
	const overrides =
		typeof modelId === "string" && require("node:path").isAbsolute(modelId)
			? getOverrides({ type: "local", modelId })
			: {};
	return attachmentPolicy(applyOverrides(capabilities, overrides), { local: true });
}
module.exports = { getAttachmentPolicy };

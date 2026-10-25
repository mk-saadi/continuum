"use strict";
const { createHash, randomUUID } = require("node:crypto");
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Run-owned, bounded state. No grants are inferred from this manifest: the
// existing permission guard and dispatcher still authorize every operation.
function createManifestStore({ sessionId, runId, epoch, resolve }) {
	const requests = new Map();
	return {
		validateEpoch(request) {
			if (
				!request ||
				request.sessionId !== sessionId ||
				request.runId !== runId ||
				fingerprint(request.epoch) !== fingerprint(epoch())
			)
				throw new Error("TOOL_NOT_ADVERTISED: Request authorization or configuration changed.");
		},
		record(tools) {
			const requestId = randomUUID();
			const names = new Set();
			const entries = new Map(
				tools.map((tool) => {
					if (names.has(tool.function.name))
						throw new Error("TOOL_NAME_CONFLICT: Duplicate advertised tool name.");
					names.add(tool.function.name);
					const identity = resolve(tool.function.name);
					return [
						tool.function.name,
						{ ...identity, schema: fingerprint(tool.function.parameters) },
					];
				}),
			);
			requests.set(requestId, { sessionId, runId, epoch: epoch(), entries });
			// Calls are accepted before the next inference boundary. Pending
			// operations own their accepted execution and never consult this cache.
			if (requests.size > 4) requests.delete(requests.keys().next().value);
			return requestId;
		},
		accept(requestId, name, schema, identity) {
			const request = requests.get(requestId),
				entry = request?.entries.get(name);
			if (!entry || request.sessionId !== sessionId || request.runId !== runId)
				throw new Error("TOOL_NOT_ADVERTISED: Tool does not belong to the originating request.");
			if (fingerprint(request.epoch) !== fingerprint(epoch()))
				throw new Error("TOOL_NOT_ADVERTISED: Request authorization or configuration changed.");
			if (
				entry.schema !== fingerprint(schema) ||
				entry.serverName !== identity.serverName ||
				entry.toolName !== identity.toolName
			)
				throw new Error(
					"TOOL_SCHEMA_CHANGED: Tool identity or schema changed; request refreshed tools.",
				);
			return request;
		},
	};
}
module.exports = { createManifestStore, fingerprint };

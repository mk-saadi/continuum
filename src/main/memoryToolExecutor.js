"use strict";

const { db } = require("./db");
const { addPermanentMemory, normalizeMemoryContent } = require("./memoryManager");
const { saveMemoryTool } = require('./tools/saveMemory');

function executeMemoryTool({ name, arguments: rawArguments, modelId, sessionId, signal }) {
	try {
		if (!["search_memory", "save_memory"].includes(name)) {
			throw new Error("Unknown memory tool.");
		}
		const args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw new TypeError("Tool arguments must be a JSON object.");
		}
		const allowed = name === "save_memory" ? ["category", "content", "always_inject"] :
			["query", "target", "cursor", "order", "limit", "session_id", "project_id", "role", "since", "until"];
		if (Object.keys(args).some((key) => !allowed.includes(key))) {
			throw new TypeError("Unexpected tool argument.");
		}
		const projectId = sessionId
			? db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id ?? null
			: null;
		if (name === "search_memory") {
			return require('./memorySearchRuntime').searchMemoryInWorker({ ...args, modelId, projectId }, signal)
				.catch(error => ({ success: false, error: error.message }));
		}
		if (!saveMemoryTool.input_schema.properties.category.enum.includes(args.category)) {
			throw new TypeError('Invalid memory category.');
		}
		const content = normalizeMemoryContent(args.content);
		if (content.length > 150) throw new TypeError('Memory content must be at most 150 characters.');
		if (/```|\n|^(?:done|working on|currently fixing|task complete)\b/i.test(args.content)) {
			throw new TypeError('Transient task progress and code snippets cannot be saved as permanent memory.');
		}
		if (args.always_inject !== undefined && typeof args.always_inject !== "boolean") {
			throw new TypeError("always_inject must be a boolean.");
		}

		const alwaysInject = args.always_inject ?? false;
		return db
			.transaction(() => {
				const id = addPermanentMemory({
					category: args.category,
					content,
					scope: projectId && args.category !== 'preference' ? projectId : 'global',
					alwaysInject,
				});
				// Promote an existing identical fact if the model marks it as critical.
				if (alwaysInject) {
					db.prepare(
						`UPDATE permanent_memories
          SET always_inject = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND always_inject = 0`,
					).run(id);
				}
				return { success: true, message: "Memory saved" };
			})
			.immediate();
	} catch (error) {
		// Return structured failures so the model can correct malformed arguments.
		console.error("Memory tool failed:", error);
		return {
			success: false,
			error:
				error instanceof TypeError || error instanceof SyntaxError
					? error.message
					: "Memory operation failed.",
		};
	}
}

module.exports = { executeMemoryTool };

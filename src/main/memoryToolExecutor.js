"use strict";

const { db, searchMemory } = require("./db");
const { addPermanentMemory } = require("./memoryManager");

function executeMemoryTool({ name, arguments: rawArguments, modelId }) {
	try {
		if (!["search_memory", "save_memory"].includes(name)) {
			throw new Error("Unknown memory tool.");
		}
		const args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw new TypeError("Tool arguments must be a JSON object.");
		}
		const allowed = name === "save_memory" ? ["category", "content", "always_inject"] : ["query"];
		if (Object.keys(args).some((key) => !allowed.includes(key))) {
			throw new TypeError("Unexpected tool argument.");
		}
		if (name === "search_memory") {
			return searchMemory(args.query, modelId);
		}
		if (args.always_inject !== undefined && typeof args.always_inject !== "boolean") {
			throw new TypeError("always_inject must be a boolean.");
		}

		const alwaysInject = args.always_inject ?? true;
		return db
			.transaction(() => {
				const id = addPermanentMemory({
					category: args.category,
					content: args.content,
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

"use strict";

const {
	getLoadConfig,
	getAppSettings,
	saveAppSettings,
	getRagSettings,
	saveRagSettings,
} = require("./configManager");
const { getGlobalSamplingParams, saveGlobalSamplingParams } = require("./samplingManager");
const agents = require("./agentManager");
const { app, ipcMain } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
	getCoreMemories,
	searchPermanentMemories,
	addPermanentMemory,
	getAllActiveMemories,
	deleteMemory,
} = require("./memoryManager");
const {
	getRegenerationTarget, setActiveVariant, appendReplyVariant,
	getOrCreateSession,
	saveMessage,
	getContextUsage,
	getActiveMessages,
	getSessionSummary,
} = require("./sessionManager");
const {
	loadSession,
	getAllSessions,
	createFolder,
	updateSession,
	deleteSession,
	editMessage,
	deleteMessage,
	branchChat,
	getSessionSamplingParams,
	saveSessionSamplingParams,
} = require("./sessionManager");
const { scheduleIdleCompression } = require("./compressionEngine");
const mcpManager = require("./mcpManager");
const { prepareChatMessages, memoryTools, getToolContext } = require("./promptBuilder");
const { indexDocuments, retrieveContext } = require("./ragManager");
const { processUploads } = require("./fileUploads");
const { prependBaseSystemPrompt } = require("./baseSystemPrompt");
const { executeMemoryTool } = require("./memoryToolExecutor");

function defaultTrustedSender(event) {
	if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
	const url = new URL(event.senderFrame.url);
	url.search = "";
	url.hash = "";
	const expected =
		process.env.NODE_ENV === "development"
			? "http://localhost:5173/"
			: pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href;
	return url.href === expected;
}

function registerIpcHandlers({
	isTrustedSender = defaultTrustedSender,
	llmSummarizeCallback,
	launchEngine,
	getEngineConfig,
} = {}) {
	if (typeof isTrustedSender !== "function") {
		throw new TypeError("isTrustedSender must be a function.");
	}

	const requests = new Map();
	const subscribers = new Set();
	const context = () => ({ ...mcpManager.getStatus(), ...getToolContext(mcpManager.getTools()) });
	const broadcast = () => {
		for (const sender of subscribers) {
			if (sender.isDestroyed()) subscribers.delete(sender);
			else sender.send("mcp:changed", context());
		}
	};
	mcpManager.on("changed", broadcast);
	const handlers = {
		"agents:save-session-prompt": ({ sessionId, prompt, modelId }) =>
			agents.saveSessionPrompt(sessionId, prompt, modelId),
		"agents:list": () => agents.listAgents(),
		"agents:create": (input) => agents.createAgent(input),
		"agents:update": ({ id, agent }) => agents.updateAgent(id, agent),
		"agents:duplicate": ({ id }) => agents.duplicateAgent(id),
		"agents:delete": ({ id }) => agents.deleteAgent(id),
		"agents:session": ({ sessionId }) => agents.getSessionAgent(sessionId),
		"agents:apply": ({ sessionId, agentId, modelId }) => agents.applyAgent(sessionId, agentId, modelId),
		"sampling:get": ({ sessionId }) =>
			sessionId ? getSessionSamplingParams(sessionId) : { params: getGlobalSamplingParams() },
		"sampling:save": ({ sessionId, modelId, params }) =>
			sessionId
				? saveSessionSamplingParams(sessionId, modelId, params)
				: { params: saveGlobalSamplingParams(params) },
		"rag:get-settings": () => getRagSettings(),
		"rag:save-settings": (settings) => saveRagSettings(settings),
		"rag:index": async ({ requestId, attachments }, notify, sender) => {
			if (typeof requestId !== "string" || !requestId || !Array.isArray(attachments))
				throw new Error("Invalid indexing request.");
			if (requests.get(sender)?.size)
				throw new Error("Wait for the current chat or indexing operation.");
			const controller = new AbortController();
			requests.set(sender, new Map([[requestId, controller]]));
			const abort = () => controller.abort();
			sender.once("destroyed", abort);
			try {
				return await indexDocuments(attachments, {
					signal: controller.signal,
					onProgress: (progress) => notify({ type: "indexing", ...progress }),
				});
			} finally {
				sender.removeListener("destroyed", abort);
				requests.delete(sender);
			}
		},
		"app:get-settings": () => getAppSettings(),
		"app:save-settings": (settings) => saveAppSettings(settings),
		"mcp:get-config": () => mcpManager.getConfig(),
		"mcp:save-config": (config) => mcpManager.saveConfig(config),
		"mcp:get-status": async () => {
			await mcpManager.init();
			return context();
		},
		"mcp:get-tools": async () => {
			await mcpManager.init();
			return getToolContext(mcpManager.getTools());
		},
		"mcp:set-server-enabled": async ({ serverName, enabled }) => {
			const config = await mcpManager.setServerEnabled(serverName, enabled);
			return { ...context(), config };
		},
		"mcp:set-tool-enabled": async ({ name, toolName, serverName, enabled }) => {
			const config = await mcpManager.setToolEnabled(toolName ?? name, enabled, serverName);
			return { ...context(), config };
		},
		"mcp:set-all-tools-enabled": async ({ serverName, enabled }) => {
			const config = await mcpManager.setAllToolsEnabled(serverName, enabled);
			return { ...context(), config };
		},
		"engine:cancel-chat": ({ requestId }, _notify, sender) => {
			requests.get(sender)?.get(requestId)?.abort();
		},
		"engine:chat": async ({ requestId, modelId, messages, sessionId, messageId = requestId }, notify, sender) => {
			let executionSteps = [];
            let content = "";
            if (!(typeof messageId === "string" && messageId.length > 0) && !Number.isSafeInteger(messageId)) throw new Error("Invalid message ID.");
			let currentStats = null; // Never reuse a previous turn's final stats.
			if (
				typeof requestId !== "string" ||
				!requestId ||
				typeof modelId !== "string" ||
				!Array.isArray(messages)
			)
				throw new Error("Invalid chat request.");
			if (requests.get(sender)?.size) throw new Error("A chat is already running.");
			const controller = new AbortController();
			const active = new Map([[requestId, controller]]);
			requests.set(sender, active);
			const abort = () => controller.abort();
			sender.once("destroyed", abort);
			try {
				await mcpManager.init();
				controller.signal.throwIfAborted();
				const config = getEngineConfig?.();
				if (!config) throw new Error("Start the local model server first.");
				const { runMemoryChat } = await import("../lib/memoryChat.mjs");
				const { tools, pluginTokens, toolTokens } = getToolContext(mcpManager.getTools());
				notify({ type: "context", pluginTokens, toolTokens });
				const text = await runMemoryChat({
					baseUrl: `http://127.0.0.1:${config.port}`,
					apiKey: config.apiKey,
					modelId,
					messages: prependBaseSystemPrompt(messages),
					chatTools: tools,
					signal: controller.signal,
					getSamplingParams: () =>
						sessionId ? getSessionSamplingParams(sessionId).params : getGlobalSamplingParams(),
					retrieveDocuments: sessionId
						? (question) =>
								retrieveContext(sessionId, question, {
									signal: controller.signal,
									onProgress: (progress) => notify({ type: "indexing", ...progress }),
								})
						: undefined,
					onText: (delta) => { content += delta; notify({ type: "text", delta }); },
                    resolveTool: name => memoryTools.some(tool => tool.name === name)
                        ? { serverName: "memory", toolName: name } : mcpManager.resolveTool(name),
                    onExecutionSteps: steps => {
                        executionSteps = steps;
                        notify({ type: "step-update", messageId, executionSteps, content });
                    },
					onStats: (stats) => {
						currentStats = stats;
						notify({ type: "stats", stats });
					},
					onThinking: (thinking) => notify({ type: "thinking", thinking }),
					executeTool: async (call) => {
						controller.signal.throwIfAborted();
						const id = require("node:crypto").randomUUID();
						let target;
						try {
							const isMemory = memoryTools.some((t) => t.name === call.name);
							target = isMemory
								? { serverName: "memory", toolName: call.name }
								: mcpManager.resolveTool(call.name);
							notify({ type: "tool", id, ...target, status: "pending" });
							const args = JSON.parse(call.arguments || "{}");
							const output = isMemory
								? await executeMemoryTool({ ...call, modelId })
								: await mcpManager.callTool(target.serverName, target.toolName, args, {
										signal: controller.signal,
									});
							controller.signal.throwIfAborted();
							let result = output;
							if (typeof output === "string") {
								try {
									result = JSON.parse(output);
								} catch {
									/* Tools may return plain text. */
								}
							}
							notify({
								type: "tool",
								id,
								...target,
								status: result?.isError || result?.success === false ? "error" : "complete",
								result,
							});
							return output;
						} catch (error) {
							notify({
								type: "tool",
								id,
								...target,
								status: controller.signal.aborted ? "cancelled" : "error",
								error: error.message,
							});
							controller.signal.throwIfAborted();
							return { isError: true, error: error.message };
						}
					},
				});
				return { text, stats: currentStats, executionSteps, message: { id: messageId, role: "assistant", content: text, executionSteps } };
			} finally {
				sender.removeListener("destroyed", abort);
				requests.delete(sender);
			}
		},
		"session:regenerate-last": async (data, notify, sender) => {
			const target = getRegenerationTarget(data.sessionId);
			const messages = prepareChatMessages({ ...data, userText: '', regenerate: true, regenerateLast: true });
            const agent = agents.getSessionAgent(data.sessionId);
            const result = await handlers["engine:chat"]({ ...data, messages, messageId: target.id }, notify, sender);
            const variant = {
                content: result.text, executionSteps: result.executionSteps,
                model_name: typeof data.modelName === 'string' && data.modelName.trim() ? data.modelName : data.modelId,
                model_id: data.modelId, agent_name: agent?.name ?? null,
                stats: result.stats ? { ...result.stats, tokens_per_sec: result.stats.tokensPerSecond,
                    total_tokens: result.stats.totalTokens, duration: result.stats.time } : null,
                created_at: new Date().toISOString(),
            };
            return { ...result, message: appendReplyVariant(data.sessionId, target, variant) };
		},
		"session:set-active-variant": ({ sessionId, messageId, index }) => setActiveVariant(sessionId, messageId, index),
		"engine:get-load-config": ({ modelId }) => getLoadConfig(modelId),
		"engine:launch": ({ modelId, config }) => launchEngine(modelId, config),
		"file:process-uploads": (filePaths) => processUploads(filePaths),
		"session:get-all": () => getAllSessions(),
		"session:create-folder": ({ folderName }) => createFolder(folderName),
		"session:load": ({ sessionId }) => loadSession(sessionId),
		"session:rename": ({ sessionId, title }) => updateSession(sessionId, "title", title),
		"session:move-to-folder": ({ sessionId, folderName }) =>
			updateSession(sessionId, "folder_name", folderName),
		"session:delete": ({ sessionId }) => deleteSession(sessionId),
		"session:delete-message": ({ sessionId, messageId }) => deleteMessage(sessionId, messageId),
		"session:branch-chat": ({ sourceSessionId, targetMessageId }) =>
			branchChat(sourceSessionId, targetMessageId),
		"session:edit-message": ({ messageId, newContent }) => editMessage(messageId, newContent),
		"memory:get-tools": () => memoryTools,
		"memory:execute-tool": (data) => executeMemoryTool(data),
		"session:prepare-messages": (data) => prepareChatMessages(data),
		"memory:get-core": ({ modelId }) => getCoreMemories(modelId),
		"memory:search": ({ query, modelId }) => searchPermanentMemories(query, modelId),
		"memory:add": (data) => {
			if (!data || typeof data !== "object" || Array.isArray(data)) {
				throw new TypeError("Memory data must be an object.");
			}
			const { category, content, scope, alwaysInject } = data;
			return addPermanentMemory({ category, content, scope, alwaysInject });
		},
		"memory:all": () => getAllActiveMemories(),
		"memory:delete": (id) => deleteMemory(id),
		"session:get-or-create": ({ sessionId, modelId }) => getOrCreateSession(sessionId, modelId),
		"session:save-message": ({
			sessionId,
			role,
			content,
			attachments = [],
			stats = null,
			toolCalls = null,
			thinking = null,
			messageId = null,
			identity = null,
            executionSteps = null,
		}) => {
			// Persist this generation's captured display names, never live UI selections.
			return saveMessage(
				sessionId,
				role,
				content,
				attachments,
				stats,
				toolCalls,
				thinking,
				messageId,
				identity,
                executionSteps,
			);
		},
		"session:get-usage": ({ sessionId, modelId }) => getContextUsage(sessionId, modelId),
		"session:get-messages": ({ sessionId }) => getActiveMessages(sessionId),
		"session:get-summary": ({ sessionId }) => getSessionSummary(sessionId),
		"session:trigger-compression": ({ sessionId, modelId, contextWindowLimit }, notify) => {
			if (typeof llmSummarizeCallback !== "function") {
				throw new Error("Configure a main-process summarizer before scheduling compression.");
			}
			scheduleIdleCompression(
				sessionId,
				modelId,
				contextWindowLimit,
				(oldSummary, messageBatch) => llmSummarizeCallback(oldSummary, messageBatch, modelId),
				notify,
			);
			return { scheduled: true };
		},
	};

	const registered = [];
	const dispose = () => {
		mcpManager.off("changed", broadcast);
		subscribers.clear();
		for (const active of requests.values()) for (const controller of active.values()) controller.abort();
		for (const channel of registered.splice(0)) ipcMain.removeHandler(channel);
	};
	try {
		for (const [channel, handler] of Object.entries(handlers)) {
			ipcMain.handle(channel, async (event, payload) => {
				if (!isTrustedSender(event)) throw new Error("Unauthorized IPC sender.");
				if (channel.startsWith("mcp:")) subscribers.add(event.sender);
				if (
					channel === "engine:chat" ||
					channel === "session:regenerate-last" ||
					channel === "engine:cancel-chat" ||
					channel === "rag:index"
				) {
					return handler(
						payload,
						(result) => {
							if (!event.sender.isDestroyed() && isTrustedSender(event)) {
                                if (result.type === "step-update") event.sender.send("stream:step-update", { requestId: payload.requestId, ...result });
								event.sender.send("engine:chat-event", {
									requestId: payload.requestId,
									...result,
								});
                            }
						},
						event.sender,
					);
				}
				if (channel === "session:trigger-compression") {
					return handler(payload, (result) => {
						if (!event.sender.isDestroyed() && isTrustedSender(event)) {
							event.sender.send("session:compression-complete", result);
						}
					});
				}
				return handler(payload);
			});
			registered.push(channel);
		}
	} catch (error) {
		dispose();
		throw error;
	}
	return dispose;
}

module.exports = { registerIpcHandlers, registerMemoryPalaceHandlers: registerIpcHandlers };

"use strict";

const { localEngineFetch } = require("./localEngineFetch");

const {
	getLoadConfig,
	getAppSettings,
	saveAppSettings,
	getRagSettings,
	saveRagSettings,
} = require("./configManager");
const { saveGlobalSamplingParams } = require("./samplingManager");
const profiles = require("./profileSettings");
const agents = require("./agentManager");
const projects = require("./projectManager");
const { agentTools, executeAgentTool } = require("./tools/agentTools");
const { app, ipcMain, dialog, shell, nativeImage } = require("electron");
const { validateLocalPath } = require('./localMedia');
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
const { prepareChatMessages, memoryTools, getToolContext, buildSessionSystemPrompt } = require("./promptBuilder");
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
	beginEngineRequest,
	onIdleTimeoutChanged,
	getReasoningEfforts = () => [],
	getEngineConfig,
} = {}) {
	if (typeof isTrustedSender !== "function") {
		throw new TypeError("isTrustedSender must be a function.");
	}

	const requests = new Map();
    let standaloneDelegation = false;
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
        "tokens:history": input => require('./tokenUsage').getTokenHistory(input),
        "tokens:retention": ({ months }) => require('./tokenUsage').setRetention(months),
        "project:create": input => projects.createProject(input),
        "project:update": ({ id, ...patch }) => projects.updateProject(id, patch),
        "project:delete": ({ id }) => projects.deleteProject(id),
        "project:list": () => projects.listProjects(),
        "project:get_by_id": ({ id }) => projects.getProject(id),
        "project:import_files": ({ project_id, file_paths }) => projects.importProjectFiles(project_id, file_paths),
        "project:add_file": ({ project_id, ...file }) => projects.addProjectFile(project_id, file),
        "project:remove_file": ({ id }) => projects.removeProjectFile(id),
        "project:set_pinned": ({ id, is_pinned }) => projects.setProjectPinned(id, is_pinned),
        "chat:export": payload => require('./exportService').exportChat(payload, { dialog }),
        "shell:open-path": async filePath => {
            validateLocalPath(filePath);
            const error = await shell.openPath(filePath);
            if (error) throw new Error(error);
        },
        "config:get": () => require('./configStore').getConfig(),
        "config:set-idle-timeout": minutes => {
            const config = require('./configStore').saveConfig({ engineIdleTimeoutMinutes: minutes });
            onIdleTimeoutChanged?.();
            return config;
        },
        "config:pick-directory": async () => {
            const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
            return result.canceled ? null : result.filePaths[0] ?? null;
        },
        "config:set-model-directory": ({ directory }) => require('./configStore').setModelDirectory(directory),
        "config:migrate-app-data": ({ directory }) => require('./dataMigration').migrateAppData(directory),
        "avatars:get": () => {
            const row = require('./db').db.prepare("SELECT value_json FROM app_settings WHERE key = 'avatar-settings'").get();
            return row ? JSON.parse(row.value_json) : null;
        },
        "avatars:save": settings => {
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid avatar settings.');
            const json = JSON.stringify(settings);
            if (json.length > 20 * 1024 * 1024) throw new Error('Avatar settings are too large.');
            require('./db').db.prepare("INSERT INTO app_settings(key, value_json) VALUES ('avatar-settings', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(json);
            return settings;
        },
        "settings:profiles": () => profiles.getProfileSettings(),
        "settings:save-profile": ({ modelPath, patch }) => profiles.saveProfileSettings(modelPath, patch),
        "settings:save-memory": ({ sessionId, modelId, patch }) => profiles.saveSessionMemorySettings(sessionId, modelId, patch),
        "settings:effective": ({ sessionId, modelPath }) => profiles.getSessionSettings(sessionId, modelPath),
		"agents:save-session-prompt": ({ sessionId, prompt, modelId }) =>
			agents.saveSessionPrompt(sessionId, prompt, modelId),
		"agents:list": () => agents.listAgents(),
		"agents:create": (input) => agents.createAgent(input),
		"agents:update": ({ id, agent }) => agents.updateAgent(id, agent),
		"agents:duplicate": ({ id }) => agents.duplicateAgent(id),
		"agents:delete": ({ id }) => agents.deleteAgent(id),
		"agents:session": ({ sessionId }) => agents.getSessionAgent(sessionId),
		"agents:apply": ({ sessionId, agentId, modelId } = {}) => {
            // Draft selection is returned to the renderer without a DB transaction.
            if (sessionId == null || sessionId === '') return agents.applyAgent(null, agentId, modelId);
            return agents.applyAgent(sessionId, agentId, modelId);
        },
		"sampling:get": ({ sessionId, modelId }) =>
			sessionId ? getSessionSamplingParams(sessionId, modelId) : { ...profiles.getSessionSettings(null, modelId), overrides: {} },
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
                notify({ type: "indexing", progress: null });
				return await indexDocuments(attachments, {
					signal: controller.signal,
					onProgress: (progress) => notify({ type: "indexing", ...progress }),
				});
			} finally {
                notify({ type: "indexing", progress: null });
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
        "loop:respond": ({ requestId, action }, _notify, sender) => {
            if (!['continue', 'stop'].includes(action)) throw new Error('Invalid loop action.');
            requests.get(sender)?.get(requestId)?.resumeLoop?.(action === 'continue');
        },
		"engine:cancel-chat": ({ requestId }, _notify, sender) => {
			requests.get(sender)?.get(requestId)?.abort();
		},
		"engine:chat": async ({ requestId, modelId, messages, sessionId, displayName, modelName, reasoningEffort, messageId = requestId }, notify, sender) => {
			if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !getReasoningEfforts(modelId).includes(reasoningEffort)))
				throw new Error('Unsupported reasoning effort for the active model.');
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
			if (displayName != null && (typeof displayName !== "string" || !displayName.trim() || displayName.includes("\0"))) throw new Error("Invalid display name.");
            const capturedDisplayName = displayName ?? (typeof modelName === "string" && modelName.trim() ? modelName : modelId).split(/[\\/]/).pop().replace(/\.gguf$/i, "");
            if (standaloneDelegation || requests.get(sender)?.size) throw new Error("A chat is already running.");
			const controller = new AbortController();
			const active = new Map([[requestId, controller]]);
			requests.set(sender, active);
			const abort = () => controller.abort();
			sender.once("destroyed", abort);
            const finishEngineRequest = beginEngineRequest?.();
			try {
                notify({ type: "indexing", progress: null });
				await mcpManager.init();
				controller.signal.throwIfAborted();
				const config = getEngineConfig?.();
				if (!config) throw new Error("Start the local model server first.");
				const { runMemoryChat } = await import("../lib/memoryChat.mjs");
                const { phaseStats } = await import('../lib/completionStats.mjs');
                const usageTurnId = require('node:crypto').randomUUID();
                const usageTimestamp = new Date().toISOString();
                const usageProjectId = sessionId ? require('./db').db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id ?? null : null;
				const memoryEnabled = profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled;
                    const { tools, pluginTokens, toolTokens } = getToolContext(mcpManager.getTools(), memoryEnabled, sessionId);
                    messages = messages.filter(message => !message.memoryContext);
                    const summaryIndex = messages.findIndex(message => message.role === 'system' && message.content?.startsWith('[EARLIER CONVERSATION SUMMARY]:'));
                    messages.splice(summaryIndex < 0 ? 1 : summaryIndex + 1, 0, buildSessionSystemPrompt({ sessionId, modelId }));
				notify({ type: "context", pluginTokens, toolTokens });
				const text = await runMemoryChat({
                        onPaused: state => new Promise(resolve => {
                            const finish = resume => {
                                controller.signal.removeEventListener('abort', stop);
                                delete controller.resumeLoop;
                                if (!sender.isDestroyed()) sender.send('loop:paused', { requestId, sessionId, ...state, executionState: resume ? 'running' : 'stopped' });
                                resolve(resume);
                            };
                            const stop = () => finish(false);
                            controller.resumeLoop = finish;
                            controller.signal.addEventListener('abort', stop, { once: true });
                            if (controller.signal.aborted) { stop(); return; }
                            sender.send('loop:paused', { requestId, sessionId, ...state });
                        }),
                        fetchImpl: localEngineFetch,
                        decodeImage: bytes => !nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty(),
                        loadedContextSize: config.activeModelConfig?.contextLength ?? 32768,
					baseUrl: `http://127.0.0.1:${config.port}`,
					modelId,
					reasoningEffort,
					messages: prependBaseSystemPrompt(messages, memoryEnabled),
					chatTools: tools,
                    getChatTools: async () => {
                        await mcpManager.reload();
                        const context = getToolContext(mcpManager.getTools(), memoryEnabled, sessionId);
                        notify({ type: "context", pluginTokens: context.pluginTokens, toolTokens: context.toolTokens });
                        return context.tools;
                    },
					signal: controller.signal,
					getSamplingParams: () =>
						profiles.getSessionSettings(sessionId, modelId).params,
					retrieveDocuments: sessionId
						? (question) =>
								retrieveContext(sessionId, question, {
									signal: controller.signal,
									onProgress: (progress) => notify({ type: "indexing", ...progress }),
								}).finally(() => notify({ type: "indexing", progress: null }))
						: undefined,
					onText: (delta) => { content += delta; notify({ type: "text", delta }); },
                    resolveTool: name => memoryTools.some(tool => tool.name === name)
                        ? { serverName: "memory", toolName: name } : agentTools.some(tool => tool.function.name === name)
                        ? { serverName: "native", toolName: name } : mcpManager.resolveTool(name),
                    onToolStream: event => notify({ ...event, messageId }),
                    onExecutionSteps: steps => {
                        executionSteps = steps;
                        notify({ type: "step-update", messageId, executionSteps, content });
                    },
					onStats: (stats) => {
						currentStats = stats;
                        const reported = stats.raw?.length ? stats.raw.map(phase => phaseStats({ ...phase, startTime: 0, endTime: 0 })) : [stats];
                        if (reported.some(phase => phase.promptTokens != null || phase.completionTokens != null)) {
                            require('./tokenUsage').logTokenUsage({ turnId: usageTurnId, chatId: sessionId ?? null, projectId: usageProjectId,
                                timestamp: usageTimestamp,
                                promptTokens: reported.reduce((sum, phase) => sum + (phase.promptTokens ?? 0), 0),
                                completionTokens: reported.reduce((sum, phase) => sum + (phase.completionTokens ?? 0), 0) });
                        }
						notify({ type: "stats", stats });
					},
					onThinking: (thinking) => notify({ type: "thinking", thinking }),
					executeTool: async (call) => {
						controller.signal.throwIfAborted();
						const id = require("node:crypto").randomUUID();
						let target;
						try {
							const isMemory = memoryTools.some((t) => t.name === call.name);
                            const isAgent = agentTools.some(t => t.function.name === call.name);
							target = isMemory
								? { serverName: "memory", toolName: call.name }
								: isAgent ? { serverName: "native", toolName: call.name } : mcpManager.resolveTool(call.name);
							notify({ type: "tool", id, ...target, status: "pending" });
							const args = JSON.parse(call.arguments || "{}");
							if (isMemory && !profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled) throw new Error('Memory is disabled for this chat.');
                            const output = isMemory
								? await executeMemoryTool({ ...call, modelId })
								: isAgent ? await executeAgentTool({ ...call, sessionId, signal: controller.signal,
                                    engine: { port: config.port, modelId, contextLength: config.activeModelConfig?.contextLength } })
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
                            result = (await import('../lib/toolResultFormatter.mjs')).formatToolResult(result, call.name).displayResult;
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
				return { text, stats: currentStats, executionSteps, message: { id: messageId, role: "assistant", displayName: capturedDisplayName, content: text, executionSteps } };
			} finally {
                finishEngineRequest?.();
                notify({ type: "indexing", progress: null });
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
                content: result.text, executionSteps: result.executionSteps, displayName: result.message.displayName,
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
		"agent:get-tools": () => agentTools,
        "agent:execute-tool": async ({ name, arguments: args, sessionId }, _notify, sender) => {
            if (name !== 'delegate_task') return executeAgentTool({ name, arguments: args, sessionId });
            if (requests.size || standaloneDelegation) throw new Error('Wait for the active chat before delegating a standalone task.');
            standaloneDelegation = true;
            const controller = new AbortController();
            const abort = () => controller.abort();
            let finish;
            try {
                sender.once('destroyed', abort);
                finish = beginEngineRequest?.();
                const config = getEngineConfig?.();
                return await executeAgentTool({ name, arguments: args, sessionId, signal: controller.signal,
                    engine: { port: config?.port, modelId: config?.modelPath, contextLength: config?.activeModelConfig?.contextLength } });
            } finally {
                finish?.(); sender.removeListener('destroyed', abort); standaloneDelegation = false;
            }
        },
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
		"session:get-or-create": ({ sessionId, modelId, projectId }) => getOrCreateSession(sessionId, modelId, projectId),
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
            displayName = identity?.displayName,
            executionSteps = null,
		}) => {
			// Accept the captured name on the message payload as well as legacy identity.
            const savedIdentity = displayName == null ? identity : { ...identity, displayName };
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
				 savedIdentity,
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
				if (channel === 'config:migrate-app-data') return handler(payload);
                return require('./dataAccess').withDataAccess(async () => {
                if (channel.startsWith("mcp:")) subscribers.add(event.sender);
				if (
					channel === "engine:chat" ||
                    channel === "agent:execute-tool" ||
					channel === "session:regenerate-last" ||
					channel === "engine:cancel-chat" ||
                    channel === "loop:respond" ||
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

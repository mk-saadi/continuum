const { effectiveMode, sessionProject, guardTool, requestToolApproval } = require('./toolPermissions');
"use strict";

const { fetchCloudModels, getCloudProviders, getCloudProviderDefaults, saveCloudProviderDefaults,
    saveCloudProvider, deleteCloudProvider, validateChatProvider, createCloudFetch } = require("./cloudProviders");

const { localEngineFetch } = require("./localEngineFetch");

const {
	getLoadConfig,
	getAppSettings,
	saveAppSettings,
	saveNotificationPrefs,
	getRagSettings,
	saveRagSettings,
} = require("./configManager");
const { saveGlobalSamplingParams } = require("./samplingManager");
const profiles = require("./profileSettings");
const agents = require("./agentManager");
const projects = require("./projectManager");
const skills = require('./skillsManager');
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
	getSessionTitle,
	applyGeneratedTitle,
	deleteSession,
	editMessage,
	deleteMessage,
	branchChat,
	selectMessageBranch,
	getSessionSamplingParams,
	saveSessionSamplingParams,
} = require("./sessionManager");
const { scheduleIdleCompression } = require("./compressionEngine");
const mcpManager = require("./mcpManager");
const { prepareChatMessages, memoryTools, getToolContext, buildSessionSystemPrompt, rebuildChatMessages } = require("./promptBuilder");
const { indexDocuments, retrieveContext } = require("./ragManager");
const { processUploads } = require("./fileUploads");
const { prependBaseSystemPrompt } = require("./baseSystemPrompt");
const { executeMemoryTool } = require("./memoryToolExecutor");
const { activeStreams, truncateToolOutput } = require('./engineManager');
const { sanitizeWebToolResult } = require('./tools/webSearch');
const { createStreamDispatcher } = require('./streamDispatcher');

const displayValue = value => {
	if (value == null) return value;
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length <= 10_000 ? value : `${text.slice(0, 10_000)}\n… [output truncated in chat; full result saved in session]`;
};
// Truncate only display-oriented text. `args` must stay structured: the
// renderer's SkillProposalCard and normalizeExecutionSteps/finishMessage read
// it as an object (a stringified/truncated args corrupts propose_skill
// registration and breaks save on aborted turns). Display bounds for args are
// applied at render time by ToolCallBlock's formatValue/preview caps.
const displaySteps = steps => steps.map(step => ({ ...step,
	result: displayValue(step.result),
	error: displayValue(step.error),
	streamingArguments: displayValue(step.streamingArguments),
}));

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

	// Step 7 wiring: the sub-agent model resolver needs the running engine's
	// config (port + loaded model) when the configured child model is the local
	// server. The app hands that accessor to this composition root, so the
	// subagent runtime never reaches for Electron state on its own.
	require("./subagents/modelSelection").setEngineConfigProvider(() => getEngineConfig?.() ?? null);

	const requests = new Map();
    let standaloneDelegation = false;
	const subscribers = new Set();
	const context = () => ({ ...mcpManager.getStatus(), ...getToolContext(mcpManager.getTools(null)) });
	const broadcast = () => {
		for (const sender of subscribers) {
			if (sender.isDestroyed()) subscribers.delete(sender);
			else sender.send("mcp:changed", context());
		}
	};
	mcpManager.on("changed", broadcast);
	const selectDirectory = async () => {
		const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
		if (canceled || !filePaths?.length) return null;
		return filePaths[0];
	};
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
        "skills:list": () => skills.listSkills(),
        "skills:save": input => skills.saveSkill(input),
        "skills:delete": ({ id }) => skills.removeSkill(id),
        // Electron's native picker cannot be a file and a directory selector at
        // the same time: on Linux, listing both properties opens a folder picker,
        // so .md/.zip files cannot be chosen. File and folder imports are
        // therefore separate picker modes over the same skills.importSkill path.
        "skills:import": ({ projectId = null, kind = 'file' }, _notify, sender) => {
            const options = kind === 'folder'
                ? { properties: ['openDirectory'] }
                : { properties: ['openFile'], filters: [{ name: 'Skills', extensions: ['md', 'zip'] }] };
            const result = dialog.showOpenDialogSync(options);
            return result?.[0] ? skills.importSkill(result[0], projectId) : null;
        },
        "chat:export": payload => require('./exportService').exportChat(payload, { dialog }),
        "shell:open-path": async filePath => {
            validateLocalPath(filePath);
            const error = await shell.openPath(filePath);
            if (error) throw new Error(error);
        },
        "cloud:get": () => getCloudProviders(),
        "cloud:defaults:get": () => {
            const defaults = getCloudProviderDefaults();
            return { defaultImageProviderId: defaults.default_image_provider_id || '',
                defaultVideoProviderId: defaults.default_video_provider_id || '' };
        },
        "cloud:defaults:save": input => {
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid media provider defaults.');
            const patch = {};
            if (Object.hasOwn(input, 'defaultImageProviderId')) patch.default_image_provider_id = input.defaultImageProviderId;
            if (Object.hasOwn(input, 'defaultVideoProviderId')) patch.default_video_provider_id = input.defaultVideoProviderId;
            saveCloudProviderDefaults(patch);
            return { success: true };
        },
        "cloud:models": input => fetchCloudModels(input),
        "cloud:save": input => saveCloudProvider(input),
        "cloud:delete": id => deleteCloudProvider(id),
        "config:get": () => require('./configStore').getConfig(),
        "config:set-idle-timeout": minutes => {
            const config = require('./configStore').saveConfig({ engineIdleTimeoutMinutes: minutes });
            onIdleTimeoutChanged?.();
            return config;
        },
        "dialog:selectDirectory": selectDirectory,
        "config:pick-directory": selectDirectory,
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
		// The sub-agent model is its own setting (not part of app:get-settings):
		// it is a model selection, validated against the saved cloud providers,
		// and it decides what a spawned child runs on (see
		// ./subagents/modelSelection.js). null = follow the chat's model.
		"subagent:get-model": () => require("./subagents/modelSelection").getSubagentModel(),
		"subagent:save-model": (selection) => require("./subagents/modelSelection").saveSubagentModel(selection),
		"settings:set-notification-prefs": prefs => saveNotificationPrefs(prefs),
		"app:save-settings": (settings) => {
			const previousMode = getAppSettings().mcpMode;
			const saved = saveAppSettings(settings);
			if (saved.mcpMode !== previousMode) broadcast();
			return saved;
		},
		"mcp:get-config": () => mcpManager.getConfig(),
		"mcp:save-config": (config) => mcpManager.saveConfig(config),
		"mcp:get-status": async () => {
			await mcpManager.init();
			return context();
		},
		"mcp:get-tools": async () => {
			await mcpManager.init();
			return getToolContext(mcpManager.getTools(null));
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
        "engine:tool-approval-response": ({ requestId, approvalId, action }, _notify, sender) => {
            if (!['allow', 'deny'].includes(action)) throw new Error('Invalid tool approval action.');
            const finish = requests.get(sender)?.get(requestId)?.toolApprovals?.get(approvalId);
            if (!finish) throw new Error('Tool approval is no longer pending.');
            finish(action === 'allow');
        },
        "engine:ask-user-response": ({ requestId, questionId, answer }, _notify, sender) => {
            if (typeof requestId !== 'string' || typeof questionId !== 'string' ||
                typeof answer !== 'string' || !answer.trim() || answer.length > 10000 || answer.includes('\0'))
                throw new Error('Invalid answer.');
            const finish = requests.get(sender)?.get(requestId)?.pendingQuestions?.get(questionId);
            if (!finish) throw new Error('Question is no longer pending.');
            finish(answer.trim());
            return { accepted: true };
        },
        "engine:tool-limit-response": ({ requestId, action }, _notify, sender) => {
            if (!['allow', 'deny'].includes(action)) throw new Error('Invalid tool limit action.');
            requests.get(sender)?.get(requestId)?.resolveToolLimit?.(action === 'allow');
        },
		"engine:cancel-chat": ({ requestId }, _notify, sender) => {
			requests.get(sender)?.get(requestId)?.abort();
		},
		"engine:cancel-session": ({ sessionId }, _notify, sender) => {
			const controller = activeStreams.get(sessionId);
			if (controller && [...(requests.get(sender)?.values() ?? [])].includes(controller)) controller.abort();
		},
		"engine:chat": async ({ requestId, modelId, messages, sessionId, displayName, modelName, activeChatProvider, reasoningEffort, thinkingBudget, permissionMode, messageId = requestId }, notify, sender) => {
            const project = sessionProject(sessionId);
            permissionMode = effectiveMode(permissionMode, project);
            const target = validateChatProvider(activeChatProvider);
            const cloud = target.type === "cloud";
            const fetchImpl = cloud ? createCloudFetch(target) : localEngineFetch;
			if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !getReasoningEfforts(modelId).includes(reasoningEffort)))
				throw new Error('Unsupported reasoning effort for the active model.');
            const { generationSamplingParams } = require('./engineManager');
            generationSamplingParams({}, thinkingBudget);
			let executionSteps = [];
            let content = "";
            const contentChunks = [];
            const materializeContent = () => {
                if (contentChunks.length) {
                    content += contentChunks.join('');
                    contentChunks.length = 0;
                }
                return content;
            };
            if (!(typeof messageId === "string" && messageId.length > 0) && !Number.isSafeInteger(messageId)) throw new Error("Invalid message ID.");
			let currentStats = null; // Never reuse a previous turn's final stats.
			let stoppedByLimit = false;
			let stoppedByCircuitBreak = false;
			if (
				typeof requestId !== "string" ||
				!requestId ||
				typeof modelId !== "string" ||
				!Array.isArray(messages)
			)
				throw new Error("Invalid chat request.");
			if (displayName != null && (typeof displayName !== "string" || !displayName.trim() || displayName.includes("\0"))) throw new Error("Invalid display name.");
            const capturedDisplayName = displayName ?? (typeof modelName === "string" && modelName.trim() ? modelName : modelId).split(/[\\/]/).pop().replace(/\.gguf$/i, "");
			const streamKey = sessionId || `request:${requestId}`;
			if (standaloneDelegation || activeStreams.has(streamKey) || requests.get(sender)?.has(requestId))
				throw new Error('This session is already running.');
			const controller = new AbortController();
			const active = requests.get(sender) ?? new Map();
			active.set(requestId, controller);
			requests.set(sender, active);
			activeStreams.set(streamKey, controller);
			if (sessionId) sender.send('engine:stream-status', { sessionId, status: 'generating' });
			const abort = () => controller.abort();
			sender.once("destroyed", abort);
            let persistence;
			let persistTimer = null;
			const persist = (status = "in_progress") => {
                // An overflow before any generated data must not leave a blank
                // assistant row on every attempt. Existing real output persists.
                if (!persistence && sessionId && (materializeContent() || executionSteps.length || currentStats)) {
                    persistence = require('./engineManager').createMessagePersistence({ sessionId, modelId, modelName,
                        displayName: capturedDisplayName, agentName: agents.getSessionAgent(sessionId)?.name });
                    notify({ type: 'message-created', messageId: persistence.messageId });
                }

				if (status === "in_progress") {
					if (persistTimer === null) persistTimer = setTimeout(() => {
						persistTimer = null;
						persistence?.update({ content: materializeContent(), executionSteps, stats: currentStats, status: "in_progress" });
					}, 250);
					return;
				}
				if (persistTimer !== null) clearTimeout(persistTimer);
				persistTimer = null;
				persistence?.update({ content: materializeContent(), executionSteps, stats: currentStats, status });
			};
            const finishEngineRequest = cloud ? undefined : beginEngineRequest?.();
			try {
                notify({ type: "indexing", progress: null });
				await mcpManager.init();
				controller.signal.throwIfAborted();
				const config = getEngineConfig?.();
				if (!cloud && !config) throw new Error("Start the local model server first.");
                if (!cloud && config.modelPath && config.modelPath !== modelId) throw new Error("The selected local model is no longer loaded.");
				// What a delegated child inherits as its model: this chat's own
				// selection. A cloud chat now carries a cloud descriptor as well, so
				// spawn_sub_agent stays usable for it; the sub-agent model setting may
				// override either shape at the runtime boundary (see
				// ./subagents/modelSelection.js) without changing anything here.
				const chatEngine = require("./subagents/modelSelection")
					.buildChatEngine({ cloud, target, config, modelId });
				const { runMemoryChat } = await import("../lib/memoryChat.mjs");
                const { rewindFailedTurnRange, failedToolReason, createProjectToolLoopGuard, createToolFailureCircuitBreaker } = require('./engineManager');
                const { maxConsecutiveToolFailures, maxTotalToolFailures } = getAppSettings();
                const { phaseStats } = await import('../lib/completionStats.mjs');
                const usageTurnId = require('node:crypto').randomUUID();
                const usageTimestamp = new Date().toISOString();
                const usageProjectId = sessionId ? require('./db').db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id ?? null : null;
				const memoryEnabled = profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled;
					const { tools: availableTools, pluginTokens, toolTokens } = getToolContext(mcpManager.getTools(sessionId), memoryEnabled, sessionId, permissionMode);
                    messages = messages.filter(message => !message.memoryContext);
                    const summaryIndex = messages.findIndex(message => message.role === 'system' && message.content?.startsWith('[EARLIER CONVERSATION SUMMARY]:'));
                    const currentUserContent = [...messages].reverse().find(message => message.role === 'user')?.content;
                    const currentUserText = typeof currentUserContent === 'string' ? currentUserContent
                        : Array.isArray(currentUserContent) ? currentUserContent.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
                    const commandAvailable = availableTools.some(tool => tool.function.name === 'execute_command');
                    const filterTools = toolList => toolList.filter(tool => {
                        const name = tool.function.name;
                        // The legacy delegate/extract runners stay local-only; spawn_sub_agent
                        // (the Step 1-7 tool) is available to cloud chats too, because its
                        // child model is resolved independently of the chat's model.
                        if (cloud && ['delegate_task', 'extract_web_page_data'].includes(name)) return false;
                        if (commandAvailable && name === 'delegate_task') return false;
                        return true;
                    });
                    const tools = filterTools(availableTools);
                    // The protocol may only describe tools the model can actually call:
                    // it is advertised exactly when spawn_sub_agent survived filtering.
                    const delegationAvailable = tools.some(tool => tool.function.name === 'spawn_sub_agent');
                    messages.splice(summaryIndex < 0 ? 1 : summaryIndex + 1, 0, buildSessionSystemPrompt({ sessionId, modelId, delegationAvailable, userText: currentUserText }));
				notify({ type: "context", pluginTokens, toolTokens });
				const text = await runMemoryChat({
                        projectId: usageProjectId,
                        projectToolLoopGuard: usageProjectId ? createProjectToolLoopGuard(usageProjectId) : null,
                        rewindFailedTurnRange,
                        failedToolReason,
                        toolFailureCircuitBreaker: createToolFailureCircuitBreaker({ maxConsecutiveToolFailures, maxTotalToolFailures }),
                        onCircuitBreak: abortReason => {
                            stoppedByCircuitBreak = true;
                            require('./services/notificationService').sendDesktopNotification({
                                title: 'Agent Loop Interrupted', body: abortReason, type: 'error',
                            });
                        },
                        onContextRewind: ({ startTurnIndex, endTurnIndex, summary }) => {
                            require('./db').recordContextRewind({ sessionId,
                                messageId: persistence?.messageId, startTurnIndex, endTurnIndex, summary });
                        },
                        casualMode: usageProjectId == null,
                        onToolLimit: ({ currentCount, nextTool }) => permissionMode === 'full_access' ? Promise.resolve(true) : new Promise(resolve => {
                            let settled = false;
                            const finish = allowed => {
                                if (settled) return;
								settled = true;
								if (!allowed) stoppedByLimit = true;
                                clearTimeout(timeout);
                                controller.signal.removeEventListener('abort', stop);
                                delete controller.resolveToolLimit;
                                if (!sender.isDestroyed()) sender.send('engine:tool-limit-reached', { requestId, sessionId, resolved: true });
                                resolve(allowed);
                            };
                            const stop = () => finish(false);
                            const timeout = setTimeout(stop, 120_000);
                            controller.resolveToolLimit = finish;
                            controller.signal.addEventListener('abort', stop, { once: true });
                            if (controller.signal.aborted || sender.isDestroyed()) { stop(); return; }
                            sender.send('engine:tool-limit-reached', { requestId, sessionId, currentCount, nextTool });
                        }),
                        onPaused: state => new Promise(resolve => {
                            const finish = resume => {
								if (!resume) stoppedByLimit = true;
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
                        fetchImpl,
                        decodeImage: bytes => !nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty(),
                        loadedContextSize: cloud ? undefined : config.activeModelConfig?.contextLength ?? 32768,
                        recoverContext: !cloud && sessionId ? async ({ contextWindowLimit, signal }) => {
                            if (typeof llmSummarizeCallback !== 'function') return null;
                            const result = await require('./compressionEngine').recoverContextOverflow({
                                sessionId, modelId, contextWindowLimit, signal,
                                llmSummarizeCallback: (old, batch) => llmSummarizeCallback(old, batch, modelId, { signal, maxTokens: 512 }),
                            });
                            if (!result.compressed) return null;
                            if (!sender.isDestroyed()) sender.send('session:compression-complete', { sessionId, ...result });
                            const current = getEngineConfig?.();
                            if (current?.modelPath !== config.modelPath || current?.port !== config.port) throw new Error('The local model changed during context recovery. Send again with the loaded model.');
                            const enabled = profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled;
                            const fresh = filterTools(getToolContext(mcpManager.getTools(sessionId), enabled, sessionId, permissionMode).tools);
                            return { messages: rebuildChatMessages({ sessionId, modelId, excludeMessageIds: [persistence?.messageId, Number.isSafeInteger(messageId) ? messageId : null],
                                delegationAvailable: fresh.some(tool => tool.function.name === 'spawn_sub_agent'), userText: currentUserText }) };
                        } : undefined,
					baseUrl: cloud ? "https://cloud.invalid" : `http://127.0.0.1:${config.port}`,
					modelId,
					reasoningEffort,
					messages: prependBaseSystemPrompt(messages, memoryEnabled),
					guardToolContent: truncateToolOutput,
					chatTools: tools,
                    getChatTools: async () => {
                        await mcpManager.reload();
                        const context = getToolContext(mcpManager.getTools(sessionId), profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled, sessionId, permissionMode);
                        notify({ type: "context", pluginTokens: context.pluginTokens, toolTokens: context.toolTokens });
                        return filterTools(context.tools);
                    },
					signal: controller.signal,
					getSamplingParams: () =>
						generationSamplingParams(profiles.getSessionSettings(sessionId, modelId).params, thinkingBudget),
					retrieveDocuments: sessionId
						? (question) =>
								retrieveContext(sessionId, question, {
									signal: controller.signal,
									onProgress: (progress) => notify({ type: "indexing", ...progress }),
								}).finally(() => notify({ type: "indexing", progress: null }))
						: undefined,
				onText: (delta) => { contentChunks.push(delta); persist(); notify({ type: "text", delta }); },
                    resolveTool: name => memoryTools.some(tool => tool.name === name)
                        ? { serverName: "memory", toolName: name } : agentTools.some(tool => tool.function.name === name)
                        ? { serverName: "native", toolName: name } : name === 'ask_user'
                        ? { serverName: 'native', toolName: name } : mcpManager.resolveTool(name, sessionId),
                    onToolStream: event => notify({ ...event, messageId }),
                    onExecutionSteps: steps => {
                        executionSteps = steps;
                        persist();
                        notify({ type: "step-update", messageId, executionSteps: displaySteps(executionSteps) });
                    },
					onStats: (stats) => {
						currentStats = stats;
                        persist();
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
							const isAskUser = call.name === 'ask_user';
							target = isMemory
								? { serverName: "memory", toolName: call.name }
								: isAgent || isAskUser ? { serverName: "native", toolName: call.name } : mcpManager.resolveTool(call.name, sessionId);
							notify({ type: "tool", id, ...target, status: "pending" });
							const args = JSON.parse(call.arguments || "{}");
							if (isMemory && !profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled) throw new Error('Memory is disabled for this chat.');
							let approval;
							if (!isAskUser) approval = await guardTool({ name: target.toolName, args, permissionMode, project,
                                native: isAgent || isMemory, signal: controller.signal,
                                requestApproval: ({ name, args }) => requestToolApproval({ controller, sender, requestId, sessionId, name, args }) });
							const rawOutput = isMemory
								? await executeMemoryTool({ ...call, modelId, sessionId, signal: controller.signal })
								: isAskUser ? await require('./engineManager').askUserDuringRun({
									controller, sender, requestId, sessionId, stepId: call.id, ...args,
									enabled: profiles.getSessionSettings(sessionId, modelId).effective.allowMidRunQuestions,
								})
								: isAgent ? await executeAgentTool({ ...call, sessionId, permissionMode, permissionGranted: true, approval, signal: controller.signal,
                                    engine: chatEngine })
								: await mcpManager.callTool(target.serverName, target.toolName, args, {
										signal: controller.signal, sessionId, permissionMode, permissionGranted: true,
									});
							const output = sanitizeWebToolResult(rawOutput, call.name);
							if (isAgent && call.name === 'manage_mcp_servers') {
								const refreshed = getToolContext(mcpManager.getTools(sessionId), memoryEnabled, sessionId, permissionMode);
								notify({ type: 'context', pluginTokens: refreshed.pluginTokens, toolTokens: refreshed.toolTokens });
							}
							controller.signal.throwIfAborted();
							let result = output;
							if (typeof output === "string") {
								try {
									result = JSON.parse(output);
								} catch {
									/* Tools may return plain text. */
								}
							}
							const failed = Boolean(failedToolReason(output, call.name));
							result = truncateToolOutput((await import('../lib/toolResultFormatter.mjs')).formatToolResult(result, call.name).displayResult);
							notify({
								type: "tool",
								id,
								...target,
								status: failed ? "error" : "complete",
								result: displayValue(result),
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
				persist(controller.signal.aborted || stoppedByCircuitBreak ? "interrupted" : "completed");
				if (!stoppedByCircuitBreak) require('./engineManager').notifyChatOutcome({ text,
					interrupted: stoppedByLimit, aborted: controller.signal.aborted });
				return { text, stats: currentStats, executionSteps, message: { id: persistence?.messageId ?? messageId, role: "assistant", displayName: capturedDisplayName, content: text, executionSteps } };
			} catch (error) {
                persist("interrupted");
				require('./engineManager').notifyChatOutcome({ error, aborted: controller.signal.aborted });
                throw error;
			} finally {
				if (persistTimer !== null) clearTimeout(persistTimer);
                finishEngineRequest?.();
                notify({ type: "indexing", progress: null });
				sender.removeListener("destroyed", abort);
				active.delete(requestId);
				if (!active.size) requests.delete(sender);
				if (activeStreams.get(streamKey) === controller) activeStreams.delete(streamKey);
				if (sessionId && !sender.isDestroyed()) sender.send('engine:stream-status', { sessionId, status: 'idle' });
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
            const { db } = require('./db');
            return db.transaction(() => {
                if (result.message.id !== target.id) db.prepare('DELETE FROM messages WHERE id = ? AND session_id = ?').run(result.message.id, data.sessionId);
                db.prepare('UPDATE sessions SET active_leaf_id = ? WHERE id = ?').run(target.id, data.sessionId);
                return { ...result, message: appendReplyVariant(data.sessionId, target, variant) };
            })();
		},
		"session:set-active-variant": ({ sessionId, messageId, index }) => setActiveVariant(sessionId, messageId, index),
		"session:select-message-branch": ({ sessionId, messageId }) => selectMessageBranch(sessionId, messageId),
		"engine:branch-and-execute": async (data, notify, sender) => {
			if (activeStreams.has(data.sessionId)) throw new Error('This session is already running.');
			if (typeof data.modelId !== 'string' || !data.modelId.trim()) throw new Error('Select a model before editing.');
			validateChatProvider(data.activeChatProvider);
			const { branchUserMessage, db } = require('./db');
			if (!db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ? AND role = 'user'")
				.get(data.messageId, data.sessionId)) throw new Error('User message not found in this session.');
			const { userMessageId, sessionId } = branchUserMessage(data);
			db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(sessionId);
			db.prepare('UPDATE messages SET archived = 0, is_summarized = 0 WHERE session_id = ?').run(sessionId);
			const { messages } = require('./engineManager').buildBranchContext(userMessageId, data.modelId);
			return { ...await handlers['engine:chat']({ ...data, messages }, notify, sender), userMessageId };
		},
		"engine:get-load-config": ({ modelId }) => getLoadConfig(modelId),
		"engine:launch": ({ modelId, config }) => launchEngine(modelId, config),
		"file:process-uploads": (filePaths) => processUploads(filePaths),
		"session:get-all": () => getAllSessions(),
		"session:create-folder": ({ folderName }) => createFolder(folderName),
		"session:load": ({ sessionId }) => loadSession(sessionId),
		"session:load-display": async ({ sessionId }) => {
			const session = loadSession(sessionId);
			const { compactMessageForDisplay } = await import('../lib/toolDisplay.mjs');
			return { ...session, messages: session.messages.map(compactMessageForDisplay) };
		},
		"session:rename": ({ sessionId, title }) => updateSession(sessionId, "title", title),
		// One-shot AI title for a chat's FIRST prompt. The renderer fires this
		// after the first reply finishes, so the request never competes with the
		// main generation; the title is written only while it still equals the
		// snapshot taken here, so a manual rename that lands mid-generation wins.
		"session:generate-title": async ({ sessionId, prompt, modelId, activeChatProvider }) => {
			if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid session.");
			if (typeof modelId !== "string" || !modelId.trim()) throw new Error("Invalid model.");
			if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Invalid prompt.");
			const target = validateChatProvider(activeChatProvider);
			const cloud = target.type === "cloud";
			const config = getEngineConfig?.();
			if (!cloud && !config) throw new Error("Start the local model server first.");
			const engine = require("./subagents/modelSelection").buildChatEngine({ cloud, target, config, modelId });
			const { resolveProvider, isEngineReady, engineNotReadyError } = require("./subagents/providers");
			if (!isEngineReady(engine)) throw engineNotReadyError(engine, "naming this chat");
			const expectedTitle = getSessionTitle(sessionId);
			if (expectedTitle === undefined) throw new Error("Session not found.");
			const { TITLE_SYSTEM_PROMPT, sanitizeChatTitle } = await import("../lib/chatTitle.mjs");
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30_000);
			let finishEngineRequest;
			try {
				finishEngineRequest = cloud ? undefined : beginEngineRequest?.();
				const { ok, result, status } = await resolveProvider(engine).chatCompletion({
					engine,
					signal: controller.signal,
					payload: {
						model: engine.modelId,
						messages: [
							{ role: "system", content: TITLE_SYSTEM_PROMPT },
							{ role: "user", content: prompt.trim().slice(0, 2000) },
						],
						temperature: 0.2,
						max_tokens: 48,
					},
				});
				if (!ok) throw new Error(`Title generation failed (HTTP ${status}).`);
				const title = sanitizeChatTitle(result);
				if (!title) return { applied: false, title: null };
				const applied = applyGeneratedTitle(sessionId, expectedTitle, title);
				return { applied, title: applied ? title : null };
			} finally {
				clearTimeout(timeout);
				finishEngineRequest?.();
			}
		},
		"session:move-to-folder": ({ sessionId, folderName }) =>
			updateSession(sessionId, "folder_name", folderName),
		"session:delete": ({ sessionId }) => deleteSession(sessionId),
		"session:delete-message": ({ sessionId, messageId }) => deleteMessage(sessionId, messageId),
		"session:branch-chat": ({ sourceSessionId, targetMessageId }) =>
			branchChat(sourceSessionId, targetMessageId),
		"session:edit-message": ({ messageId, newContent }) => editMessage(messageId, newContent),
		"agent:get-tools": () => agentTools,
        "agent:execute-tool": async ({ name, arguments: args, sessionId, permissionMode }, _notify, sender) => {
            if (!['delegate_task', 'extract_web_page_data', 'spawn_sub_agent'].includes(name)) return executeAgentTool({ name, arguments: args, sessionId, permissionMode });
            if (requests.size || standaloneDelegation) throw new Error('Wait for the active chat before delegating a standalone task.');
            standaloneDelegation = true;
            const controller = new AbortController();
            const abort = () => controller.abort();
            let finish;
            try {
                sender.once('destroyed', abort);
                finish = beginEngineRequest?.();
                const config = getEngineConfig?.();
                return await executeAgentTool({ name, arguments: args, sessionId, permissionMode, signal: controller.signal,
                    engine: { port: config?.port, modelId: config?.modelPath, contextLength: config?.activeModelConfig?.contextLength } });
            } finally {
                finish?.(); sender.removeListener('destroyed', abort); standaloneDelegation = false;
            }
        },
        "memory:get-tools": () => memoryTools,
		"memory:execute-tool": async (data) => {
            await guardTool({ name: data.name, args: typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments, permissionMode: data.permissionMode, project: sessionProject(data.sessionId) });
            return executeMemoryTool(data);
        },
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
                if (channel.startsWith("mcp:") && !subscribers.has(event.sender)) {
                    subscribers.add(event.sender);
                    event.sender.once('destroyed', () => subscribers.delete(event.sender));
                }
				if (
					channel === "engine:chat" ||
					channel === "engine:branch-and-execute" ||
                    channel === "agent:execute-tool" ||
					channel === "session:regenerate-last" ||
					channel === "engine:cancel-chat" ||
					channel === "engine:cancel-session" ||
                    channel === "loop:respond" ||
                    channel === "engine:tool-limit-response" ||
                    channel === "engine:tool-approval-response" ||
                    channel === "engine:ask-user-response" ||
					channel === "rag:index"
				) {
					const dispatcher = createStreamDispatcher(event.sender, payload.requestId, payload.sessionId, () => isTrustedSender(event));
					try { return await handler(
						payload,
						(result) => dispatcher.dispatch(result),
						event.sender,
					); } finally { dispatcher.close(); }
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

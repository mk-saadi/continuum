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
const reasoningControls = require("../lib/reasoningControls.cjs");
const reasoningRuntime = require("./reasoningRuntime");
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
const { getPlan: getWorkspacePlan } = require("./workspacePlan");
const { indexDocuments, retrieveContext } = require("./ragManager");
const { processUploads } = require("./fileUploads");
const { prependBaseSystemPrompt } = require("./baseSystemPrompt");
const { executeMemoryTool } = require("./memoryToolExecutor");
const { activeStreams, truncateToolOutput } = require('./engineManager');
const { sanitizeWebToolResult } = require('./tools/webSearch');
const { createStreamDispatcher } = require('./streamDispatcher');
const runSteering = require('./runSteering');

const displayValue = value => {
	if (value == null) return value;
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length <= 10_000 ? value : `${text.slice(0, 10_000)}\n… [output truncated in chat; full result saved in session]`;
};
// The compact tool result no longer carries the plan. Re-read the complete
// authoritative state for the Activity-tab push; a read failure must not turn
// an already-committed mutation into a reported tool failure, so it degrades to
// no push (the card can still refresh via session:get-plan).
const planForPush = (sessionId) => {
	try {
		return getWorkspacePlan(sessionId);
	} catch (error) {
		console.error('[workspacePlan] could not read plan for Activity push:', error?.message ?? error);
		return null;
	}
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
	llmCheckpointCallback,
	launchEngine,
	beginEngineRequest,
	onIdleTimeoutChanged,
	getReasoningEfforts = () => [],
	getLocalModelMetadata = () => null,
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
	// Phase 2.1: trusted in-memory registry of executing main-agent runs. A run
	// id is generated here, never supplied by the renderer. Steering IPC resolves
	// the run from this map and additionally requires the requesting sender to be
	// the one that started it, so supplying another session's id is not enough.
	const steeringRuns = new Map();
	const emitSteeringUpdates = (sender, records, options = {}) => {
		if (!sender || sender.isDestroyed()) return;
		for (const record of records ?? []) {
			if (!record) continue;
			try {
				sender.send('steering:updated', runSteering.toEvent(record, options));
			} catch (error) {
				// A renderer teardown race must not fail an accepted instruction.
				console.error('[steering] could not emit a status update:', error?.message ?? error);
			}
		}
	};
	const resolveSteeringRun = ({ runId, sessionId, sender }) => {
		const entry = steeringRuns.get(runId);
		if (!entry || entry.sessionId !== sessionId || entry.sender !== sender ||
			entry.controller.signal.aborted || activeStreams.get(sessionId) !== entry.controller) {
			throw new Error('No active run matches this steering request.');
		}
		return entry;
	};
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
	require('./localEngineFetch').setLocalCapabilityProvider?.(() => getEngineConfig?.());
    const handlers = {
        "models:capability-overrides": () => require('./capabilityOverrides').readOverrides(),
        "models:save-capability-overrides": ({ target, overrides }) => require('./capabilityOverrides').saveOverrides(target, overrides),
        "engine:capabilities": async ({ modelId }) => {
            const config = getEngineConfig?.();
            if (!config || config.modelPath !== modelId) throw new Error('Load the selected local model before verifying media support.');
            const capabilities = await require('./modelCapabilities').queryCapabilities(config.port);
            const current = getEngineConfig?.();
            if (!current || current.port !== config.port || current.modelPath !== modelId) throw new Error('The loaded model changed during capability verification.');
            return capabilities;
        },
        "tokens:history": input => require('./tokenUsage').getTokenHistory(input),
        "tokens:retention": ({ months }) => require('./tokenUsage').setRetention(months),
        // Phase 2.0D spending dashboard. Read-only aggregates over the cost
        // evidence persisted by Phase 2.0C-3; these handlers never estimate a
        // new price and never trigger inference.
        "usage:dashboard": input => require('./spendingDashboard').getDashboard(input),
        "usage:attribution": input => require('./spendingDashboard').getAttribution(input),
        "usage:records": input => require('./spendingDashboard').getRecords(input),
        "usage:pricing-history": input => require('./spendingDashboard').getPricingHistory(input),
        "usage:model-detail": input => require('./spendingDashboard').getModelDetail(input),
        "project:create": input => projects.createProject(input),
        "project:update": async ({ id, ...patch }) => {
            const previous = projects.getProject(id);
            const updated = projects.updateProject(id, patch);
            if (previous.root_path && previous.root_path !== updated.root_path)
                await require("./lspManager").manager.closeRoot(previous.root_path).catch(() => {});
            return updated;
        },
        "project:delete": async ({ id }) => {
            const previous = projects.getProject(id);
            const result = projects.deleteProject(id);
            if (previous.root_path) await require("./lspManager").manager.closeRoot(previous.root_path).catch(() => {});
            return result;
        },
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
        "cloud:model-metadata": () => require("./cloudProviders").getCloudModelMetadata(),
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
        "config:set-runtime-paths": ({ paths }) => require('./configStore').saveConfig({ extraReadOnlyRuntimePaths: paths }),
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
        "background:get": () => require('./backgroundSettings').getBackgroundSettings(),
        "background:set-opacity": ({ opacity }) => require('./backgroundSettings').setBackgroundOpacity(opacity),
        "background:remove": () => require('./backgroundSettings').removeBackgroundImage(),
        // The picker runs in main so the chosen file can be copied into the
        // managed backgrounds directory before its path is ever trusted.
        "background:pick": () => {
            const result = dialog.showOpenDialogSync({
                properties: ['openFile'],
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico'] }],
            });
            if (!result?.[0]) return null;
            return require('./backgroundSettings').adoptBackgroundImage(result[0]);
        },
        "settings:profiles": () => profiles.getProfileSettings(),
        "settings:save-profile": ({ modelPath, patch }) => profiles.saveProfileSettings(modelPath, patch),
        "settings:save-memory": ({ sessionId, modelId, patch }) => profiles.saveSessionMemorySettings(sessionId, modelId, patch),
        "settings:effective": ({ sessionId, modelPath }) => profiles.getSessionSettings(sessionId, modelPath),
        // Capability view for the composer. It resolves the saved intent against
        // the actual target so the UI only offers controls this model can honor;
        // unsupported values come back as warnings, never as a coerced setting.
        "reasoning:capabilities": async ({ sessionId, modelId, activeChatProvider } = {}) => {
            const target = validateChatProvider(activeChatProvider);
            const config = target.type === 'local' ? getEngineConfig?.() : null;
            const resolution = await reasoningRuntime.resolveChatReasoning({
                sessionId: sessionId ?? null,
                modelId,
                target,
                localModel: target.type === 'local' ? getLocalModelMetadata(modelId) : null,
                contextSize: target.type === 'local' ? config?.activeModelConfig?.contextLength ?? null : null,
            });
            return reasoningRuntime.describeResolution(resolution);
        },
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
			const abort = () => controller.abort(require('./workspaceGenerationRuntime').reason('renderer-destroyed'));
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
		// Cumulative task token budgets (Automatic default, optional Custom
		// hard limits). Same standalone settings pattern as the model above.
		"subagent:get-budgets": () => {
			const budgets = require("./subagents/budgetSettings").getBudgetSettings();
			return { settings: budgets, policy: require("./subagents/budgets").describeAutoPolicy() };
		},
		"subagent:save-budgets": (patch) => {
			const budgets = require("./subagents/budgetSettings").saveBudgetSettings(patch);
			return { settings: budgets, policy: require("./subagents/budgets").describeAutoPolicy() };
		},
		// Read-only child transcript for the activity modal. The runtime is
		// in-memory, so unknown ids (e.g. after a restart) report found:false
		// instead of throwing; the UI renders that as "no longer available".
		"subagent:get-transcript": ({ childSessionId } = {}) =>
			require("./subagents").getChildTranscript(childSessionId),
		// Phase 1.3C continuation control (minimal contract; Phase 1.5 will build
		// the UI on top of exactly these calls). Authorization is the owning
		// parentSessionId, enforced inside the runtime for every mutating call.
		// `renew-budget` and `continue` reject/return structured results rather
		// than silently doing nothing.
		"subagent:describe": ({ childSessionId } = {}) =>
			require("./subagents").describeChild(childSessionId),
		// Phase 1.5 minimal child controls: interrupt stops the active turn at a
		// safe boundary and keeps the child resumable (never a cancellation).
		"subagent:interrupt": ({ childSessionId, parentSessionId } = {}) =>
			require("./subagents").interrupt(childSessionId, { parentSessionId }),
		"subagent:continuation-status": ({ childSessionId, parentSessionId } = {}) =>
			require("./subagents").continuationStatus(childSessionId, { parentSessionId }),
		"subagent:renew-budget": ({ childSessionId, parentSessionId, renewal, reason } = {}) =>
			require("./subagents").renewChildBudget(childSessionId, renewal ?? {}, { parentSessionId, reason }),
		"subagent:continue": ({ childSessionId, parentSessionId, renewal, message, allowCancelled, allowTimedOut } = {}) =>
			require("./subagents").continueChild(childSessionId, { parentSessionId, renewal, message, allowCancelled, allowTimedOut }),
		"subagent:list-recoverable": ({ parentSessionId } = {}) =>
			require("./subagents").listRecoverableChildren({ parentSessionId }),
		"subagent:recover": ({ childSessionId, parentSessionId, engine } = {}) =>
			require("./subagents").recoverChild(childSessionId, { parentSessionId, engine, verifyOwner: true }),
		// Workspace file recovery (Phase 3 UI). Every handler resolves the
		// chat session to its project workspace first; checkpoint ids are
		// then gated to that workspace root inside recoveryStore, so a
		// renderer-supplied id can never reach another workspace's files.
		// Restore additionally refuses while the chat has an active run.
		"recovery:overview": ({ sessionId } = {}) =>
			require("./recoveryIpc").recoveryOverview(sessionId),
		"recovery:history": ({ sessionId, limit } = {}) =>
			require("./recoveryIpc").recoveryHistory(sessionId, limit),
		"recovery:detail": ({ sessionId, checkpointId } = {}) =>
			require("./recoveryIpc").recoveryDetail(sessionId, checkpointId),
		"recovery:preview": ({ sessionId, checkpointId, paths, force } = {}) =>
			require("./recoveryIpc").recoveryPreview(sessionId, checkpointId, { paths, force }),
		"recovery:restore": async ({ sessionId, checkpointId, paths, force, allowRisky } = {}) =>
			require("./recoveryIpc").recoveryRestore(sessionId, checkpointId, { paths, force, allowRisky },
				activeStreams.has(sessionId) || standaloneDelegation),
		"recovery:pin": ({ sessionId, checkpointId, pinned } = {}) =>
			require("./recoveryIpc").recoveryPin(sessionId, checkpointId, pinned),
		// Diff review (UI-only reads + checkpoint-backed single-file revert
		// through the standard preview/restore path). No new destructive
		// primitives: revert reuses recovery:preview/recovery:restore below.
		"recovery:changed-files": ({ sessionId } = {}) =>
			require("./recoveryIpc").recoveryChangedFiles(sessionId),
		"recovery:file-diff": ({ sessionId, relPath } = {}) =>
			require("./recoveryIpc").recoveryFileDiff(sessionId, relPath),
		"recovery:covering-checkpoint": ({ sessionId, relPath } = {}) =>
			require("./recoveryIpc").recoveryCoveringCheckpoint(sessionId, relPath),
		"recovery:stats": () => require("./recoveryIpc").recoveryStats(),
		"recovery:prune": () => require("./recoveryIpc").recoveryPrune(),
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
        "tool-rules:list": ({ projectId, sessionId }) => require('./rememberedToolRules').list(projectId, sessionId),
        "tool-rules:delete": ({ projectId, id, sessionId }) => require('./rememberedToolRules').remove(projectId, id, sessionId),
        "tool-rules:delete-all": ({ projectId }) => require('./rememberedToolRules').removeAll(projectId),
        "engine:tool-approval-response": ({ requestId, approvalId, action, choice }, _notify, sender) => {
            action = choice ?? action;
            if (!['allow', 'deny', 'chat', 'project'].includes(action)) throw new Error('Invalid tool approval action.');
            const finish = requests.get(sender)?.get(requestId)?.toolApprovals?.get(approvalId);
            if (!finish) throw new Error('Tool approval is no longer pending.');
            finish(action);
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
			requests.get(sender)?.get(requestId)?.abort(require('./workspaceGenerationRuntime').reason('user-cancelled'));
		},
		"engine:cancel-session": ({ sessionId }, _notify, sender) => {
			const controller = activeStreams.get(sessionId);
			if (controller && [...(requests.get(sender)?.values() ?? [])].includes(controller)) controller.abort(require('./workspaceGenerationRuntime').reason('user-cancelled'));
		},
		// Phase 2.1 live steering. Every mutation resolves the executing run from
		// trusted in-memory state and requires the calling sender to own it; the
		// renderer cannot steer a run by guessing a session or steering id.
		"engine:set-permission-mode": async ({ sessionId, permissionMode }, _notify, sender) => {
            if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session.');
            const controller = activeStreams.get(sessionId);
            if (controller && ![...(requests.get(sender)?.values() ?? [])].includes(controller)) throw new Error('This sender does not own the run.');
            await require('./lspExecutionContext').setMode(sessionId, permissionMode);
            for (const finish of [...(controller?.toolApprovals?.values() ?? [])]) finish(false);
            return { success: true };
        },
        "steering:submit": ({ sessionId, runId, content, idempotencyKey }, _notify, sender) => {
			resolveSteeringRun({ runId, sessionId, sender });
			const result = runSteering.submitSteering({ sessionId, runId, content, idempotencyKey });
			emitSteeringUpdates(sender, [result.record], { includeContent: true });
			return result;
		},
		"steering:active": ({ sessionId } = {}, _notify, sender) => {
			if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session.');
			const controller = activeStreams.get(sessionId);
			if (!controller) return null;
			const entry = controller.runId ? steeringRuns.get(controller.runId) : null;
			if (!entry || entry.sender !== sender) return null;
			return { sessionId, runId: entry.runId };
		},
		"steering:history": ({ sessionId, limit } = {}) => {
			if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session.');
			// A session id is minted in the renderer when a tab opens, but the
			// row is only persisted once the first message is sent. Asking for
			// the steering history of a not-yet-persisted session is therefore a
			// normal startup condition, not an error: the steering table is
			// keyed by session id and cannot hold rows for a session that does
			// not exist, so the correct answer is an empty history. Throwing
			// here only produced a spurious unhandled-rejection log at startup.
			return runSteering.getSteeringHistory(sessionId, limit);
		},
		"steering:cancel": ({ sessionId, runId, steeringId }, _notify, sender) => {
			resolveSteeringRun({ runId, sessionId, sender });
			const existing = runSteering.getSteering(sessionId, steeringId);
			if (!existing || existing.runId !== runId) throw new Error('Steering instruction not found.');
			const record = runSteering.cancelSteering({ sessionId, steeringId });
			emitSteeringUpdates(sender, [record]);
			return record;
		},
		"engine:chat": async ({ requestId, modelId, messages, sessionId, displayName, modelName, activeChatProvider, permissionMode, messageId = requestId }, notify, sender, emitActivity = () => {}) => {
            if (sessionId) require('./sessionDeletion').assertAvailable(sessionId);
            const project = sessionProject(sessionId);
            permissionMode = effectiveMode(permissionMode, project);
            const target = validateChatProvider(activeChatProvider);
            const cloud = target.type === "cloud";
            const fetchImpl = cloud ? createCloudFetch(target) : localEngineFetch;
			let executionSteps = [];
            const childSessionsByToolCall = new Map();
            const gitCommitReviewsByToolCall = new Map();
            const savedRulesByToolCall = new Map();
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
			// The run id is minted in the main process. It is the only handle a
			// steering submission may target; the renderer learns it from the
			// generating status event.
			const runId = require('node:crypto').randomUUID();
			controller.runId = runId;
            let settleRun;
            controller.settled = new Promise(resolve => { settleRun = resolve; });
            const lspExecutionContext = require('./lspExecutionContext').createContext(sessionId, permissionMode, runId);
            const backgroundProject = require('./toolPermissions').sessionProject(sessionId);
            const backgroundContext = backgroundProject?.root_path ? { runId, sessionId, workspace: require('node:fs').realpathSync(backgroundProject.root_path) } : null;
            if (backgroundContext) require('./backgroundCommands').openRun({ ...backgroundContext, signal: controller.signal });
            const backgroundUpdate = record => {
                if (record.session_id === sessionId && record.workspace === backgroundContext?.workspace && !sender.isDestroyed()) sender.send('session:background-command', { sessionId, record });
            };
            if (backgroundContext) require('./backgroundCommands').events.on('change', backgroundUpdate);
			const active = requests.get(sender) ?? new Map();
			active.set(requestId, controller);
			requests.set(sender, active);
			activeStreams.set(streamKey, controller);
			if (sessionId) {
				steeringRuns.set(runId, { runId, sessionId, sender, controller });
				sender.send('engine:stream-status', { sessionId, status: 'generating', runId });
			}
			const abort = () => controller.abort(require('./workspaceGenerationRuntime').reason('renderer-destroyed'));
			sender.once("destroyed", abort);
            let persistence;
			let persistTimer = null;
			const persist = (status = "in_progress") => {
                // An overflow before any generated data must not leave a blank
                // assistant row on every attempt. Existing real output persists.
                if (!persistence && sessionId && (materializeContent() || executionSteps.length || currentStats)) {
                    persistence = require('./engineManager').createMessagePersistence({ sessionId, modelId, modelName,
                        displayName: capturedDisplayName, agentName: agents.getSessionAgent(sessionId)?.name, runId });
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
                require('./nativeToolActivation').begin(sessionId, runId);
                mcpManager.beginRun?.(sessionId, runId);
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
				// Reasoning is resolved against the actual target/model before any
				// request is built. The renderer cannot inject wire parameters.
				const localModel = cloud ? null : getLocalModelMetadata(modelId);
				const resolveReasoningForRequest = ({ contextSize } = {}) =>
					reasoningRuntime.resolveChatReasoning({
						sessionId, modelId, target, localModel,
						contextSize: cloud ? null : contextSize ?? config?.activeModelConfig?.contextLength ?? null,
					});
				const reasoning = await resolveReasoningForRequest({});
				const { runMemoryChat } = await import("../lib/memoryChat.mjs");
                const { rewindFailedTurnRange, failedToolReason, createProjectToolLoopGuard, createToolFailureCircuitBreaker } = require('./engineManager');
                const { maxConsecutiveToolFailures, maxTotalToolFailures } = getAppSettings();
                const usageTurnId = require('node:crypto').randomUUID();
                const childBudgetScope = require('./subagents/executionBudget').createParentRunBudget();
                const usageTimestamp = new Date().toISOString();
                // Cost evidence is resolved once per turn. For cloud turns the
                // async path refreshes the read-only metadata cache; the
                // synchronous settlement below reads only what is already
                // materialized, so no cost path adds a network call to a turn.
                const costEstimator = require('./costEstimator');
                let turnPricing = null;
                if (cloud) {
                    costEstimator.resolveTurnPricingAsync({ providerId: target.provider, modelId })
                        .then(value => { turnPricing = value; })
                        .catch(() => { /* provider-reported cost still applies */ });
                }
                const usageProjectId = sessionId ? require('./db').db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)?.project_id ?? null : null;
				const memoryEnabled = profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled;
					const { tools: availableTools, pluginTokens, toolTokens } = getToolContext(mcpManager.getTools(sessionId), memoryEnabled, sessionId, permissionMode, modelId);
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
                const resolveAdvertisedIdentity = name => memoryTools.some(t => t.name === name)
                    ? { serverName: 'memory', toolName: name }
                    : agentTools.some(t => t.function.name === name) || name === 'ask_user'
                        ? { serverName: 'native', toolName: name } : mcpManager.resolveTool(name, sessionId);
                const advertisedTools = require('./advertisedTools').createManifestStore({ sessionId, runId,
                    epoch: () => ({ permission: require('./lspExecutionContext').revision(sessionId),
                        mcpMode: mcpManager.getMcpMode?.() ?? getAppSettings().mcpMode,
                        configuration: require('./advertisedTools').fingerprint([...(mcpManager.servers ?? [])].map(([name, server]) =>
                            [name, server.definition, server.enabled, [...(server.disabledTools ?? [])]])) }), resolve: resolveAdvertisedIdentity });
				const text = await runMemoryChat({
                    onAdvertisedTools: schemas => advertisedTools.record(schemas),
                        projectId: usageProjectId,
                        workspaceRoot: backgroundContext?.workspace,
                        takeCommandCompletions: backgroundContext ? () => require('./backgroundCommands').take(backgroundContext) : null,
                        markCommandCompletions: backgroundContext ? (ids, accepted) => require('./backgroundCommands').acknowledge(backgroundContext, ids, accepted) : null,
                        projectToolLoopGuard: usageProjectId ? createProjectToolLoopGuard(usageProjectId) : null,
                        // Phase 2.1: the loop asks for steering only at a model-request
                        // boundary. These callbacks claim/confirm rows for this exact
                        // run id and push compact status events to the owning sender.
                        takeSteeringInstructions: sessionId ? () => {
                            const requestId = require('node:crypto').randomUUID();
                            const batch = runSteering.takeSteering({ sessionId, runId, requestId });
                            emitSteeringUpdates(sender, batch);
                            return batch;
                        } : null,
                        markSteeringDelivered: sessionId ? (ids, requestId) => {
                            const records = runSteering.markDelivered({ sessionId, runId, ids, requestId });
                            emitSteeringUpdates(sender, records);
                            return records;
                        } : null,
                        markSteeringUndelivered: sessionId ? (ids, reason) => {
                            const records = runSteering.markUndelivered({ sessionId, runId, ids, reason });
                            emitSteeringUpdates(sender, records);
                            return records;
                        } : null,
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
                        rebuildWorkspacePrefix: usageProjectId ? projection => rebuildChatMessages({
                            sessionId, modelId, excludeMessageIds: [persistence?.messageId],
                            delegationAvailable: tools.some(tool => tool.function?.name === 'spawn_sub_agent'),
                            userText: currentUserText, compactionProjection: projection,
                        }) : null,
                        workspaceCompaction: usageProjectId ? async boundary => {
                            // Flush the current row without completing it or changing run identity.
                            if (persistTimer !== null) clearTimeout(persistTimer);
                            persistTimer = null;
                            persistence?.update({ content: materializeContent(), executionSteps, stats: currentStats, status: 'in_progress' });
                            const measurement = cloud ? require('./promptMeasurement').createCloudWorkspaceMeasurer(target)
                                : require('./contextBudget').createPromptMeasurer(require('./localEngineFetch').localEngineFetch);
                            const policyRevision = require('./lspExecutionContext').revision(sessionId);
                            const runtime = getEngineConfig?.();
                            const providerIdentity = cloud ? JSON.stringify(require('./cloudProviders').getStoredProvider(target.provider)) : null;
                            const isCurrent = () => (cloud ? JSON.stringify(require('./cloudProviders').getStoredProvider(target.provider)) === providerIdentity : (runtime?.modelPath === config.modelPath && runtime?.port === config.port &&
                                runtime?.runtimeIdentity === config.runtimeIdentity &&
                                JSON.stringify(getEngineConfig?.()?.activeModelConfig) === JSON.stringify(runtime?.activeModelConfig) && !controller.signal.aborted && activeStreams.get(streamKey) === controller &&
                                getEngineConfig?.()?.runtimeIdentity === runtime?.runtimeIdentity &&
                                getEngineConfig?.()?.modelPath === runtime?.modelPath && getEngineConfig?.()?.port === runtime?.port)) &&
                                !controller.signal.aborted && activeStreams.get(streamKey) === controller &&
                                require('./lspExecutionContext').revision(sessionId) === policyRevision &&
                                require('./promptMeasurement').preparedConfigurationIdentity(sessionId, modelId) === configuration;
                            const configuration = require('./promptMeasurement').preparedConfigurationIdentity(sessionId, modelId);
                            try {
                                const result = await require('./workspaceCompaction').compactAtBoundary({ ...boundary,
                                    sessionId, modelId, owner: controller, messageId: persistence?.messageId,
                                    onActivity: emitActivity,
                                    mcpToolNames: mcpManager.getTools(sessionId).map(tool => tool.function?.name ?? tool.name),
                                    signal: controller.signal, isCurrent,
                                    measure: payload => cloud ? measurement(payload) : measurement(`http://127.0.0.1:${config.port}/v1/chat/completions`, payload,
                                        { signal: controller.signal, contextWindowLimit: config.activeModelConfig?.contextLength ?? 32768 }, boundary.contextWindowLimit ?? undefined),
                                    generate: cloud ? async (candidateRequest, { signal }) => {
                                        const response = await createCloudFetch(target, { stream: false })('cloud:workspace-candidate', {
                                            body: JSON.stringify(candidateRequest), signal });
                                        return response.json();
                                    } : (candidateRequest, { signal, onProgress }) => llmCheckpointCallback(null, modelId, { signal, onProgress, candidateRequest }),
                                });
                                if (result.compressed && !sender.isDestroyed()) sender.send('session:compression-complete', {
                                    sessionId, compressed: true, checkpointId: result.checkpointId, archivedCount: result.archivedCount, diagnostics: result.diagnostics });
                                return result;
                            } catch (error) {
                                if (!sender.isDestroyed()) sender.send('session:compression-complete', { sessionId, compressed: false, reason: error.code });
                                // Unknown metadata cannot certify compaction fit. Keep the
                                // pre-existing provider path, with compaction unsupported.
                                if (cloud && error.code === 'unknown-cloud-capacity') return { compressed: false, reason: error.code, unsupported: true };
                                throw error;
                            }
                        } : null,
                        recoverContext: !usageProjectId && !cloud && sessionId ? async ({ contextWindowLimit, signal }) => {
                            if (typeof llmSummarizeCallback !== 'function') return null;
                            const enabled = profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled;
                            // Schemas for the floor projection: the same tool
                            // set that will ride the rebuilt request, so the
                            // gate measures the real overhead.
                            const preTools = filterTools(getToolContext(mcpManager.getTools(sessionId), enabled, sessionId, permissionMode, modelId).tools);
                            const excludeMessageIds = [persistence?.messageId, Number.isSafeInteger(messageId) ? messageId : null];
                            const delegationAvailable = preTools.some(tool => tool.function?.name === 'spawn_sub_agent');
                            // Configured output caps so the prospective
                            // measurement reserves what the real request will
                            // reserve (uncapped defaults otherwise; the guard
                            // re-measures the real payload afterwards).
                            const sampling = profiles.getSessionSettings(sessionId, modelId).params ?? {};
                            const maxTokens = Number.isSafeInteger(sampling.max_tokens) && sampling.max_tokens > 0
                                ? sampling.max_tokens : null;
                            // Re-resolve against the window recovery is working
                            // toward; a saved budget may clamp to that ceiling.
                            const currentReasoning = await resolveReasoningForRequest({ contextSize: contextWindowLimit });
                            const effectiveBudget = currentReasoning.effective.mode === 'budget'
                                ? currentReasoning.effective.budget : null;
                            let result;
                            try {
                                result = await require('./compressionEngine').recoverContextOverflow({
                                sessionId, modelId, contextWindowLimit, signal, tools: preTools,
                                delegationAvailable, userText: currentUserText, excludeMessageIds,
                                maxTokens, thinkingBudget: effectiveBudget,
                                llmCheckpointCallback: typeof llmCheckpointCallback === 'function'
                                    ? (input) => llmCheckpointCallback(input, modelId, { signal, maxTokens: require('./taskCheckpoints').CHECKPOINT_LLM_MAX_TOKENS })
                                    : null,
                                // Exact pre-commit verification over the live
                                // server-template/tokenizer path (falls back
                                // to the labeled approximation when probes
                                // are unavailable; never held across a txn).
                                measurePrompt: async ({ messages, tools, limit, signal: measureSignal }) => {
                                    const measurer = require('./contextBudget').createPromptMeasurer(
                                        require('./localEngineFetch').localEngineFetch);
                                    return measurer(`http://127.0.0.1:${config.port}/v1/chat/completions`,
                                        { model: modelId, messages, tools,
                                            ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
                                            ...reasoningControls.localRequestFields(currentReasoning) },
                                        { signal: measureSignal, contextWindowLimit: limit });
                                },
                                llmSummarizeCallback: (old, batch) => llmSummarizeCallback(old, batch, modelId, { signal, maxTokens: 512 }),
                                });
                            } catch (error) {
                                // Surface the failure reason to the inspection
                                // panel through the existing completion
                                // channel, then let the chat error propagate
                                // unchanged to the caller.
                                if (!sender.isDestroyed()) sender.send('session:compression-complete',
                                    { sessionId, compressed: false, error: error?.message ?? String(error) });
                                throw error;
                            }
                            if (!result.compressed) {
                                if (result.reason && !sender.isDestroyed()) {
                                    sender.send('session:compression-complete', { sessionId, ...result });
                                }
                                return null;
                            }
                            if (!sender.isDestroyed()) sender.send('session:compression-complete', { sessionId, ...result });
                            const current = getEngineConfig?.();
                            if (current?.modelPath !== config.modelPath || current?.port !== config.port) throw new Error('The local model changed during context recovery. Send again with the loaded model.');
                            const fresh = filterTools(getToolContext(mcpManager.getTools(sessionId), enabled, sessionId, permissionMode, modelId).tools);
                            return { messages: rebuildChatMessages({ sessionId, modelId, excludeMessageIds,
                                delegationAvailable: fresh.some(tool => tool.function.name === 'spawn_sub_agent'), userText: currentUserText, contextWindowLimit }) };
                        } : undefined,
					baseUrl: cloud ? "https://cloud.invalid" : `http://127.0.0.1:${config.port}`,
					modelId,
					reasoning,
					getReasoning: resolveReasoningForRequest,
					cloud,
					localModel,
					messages: prependBaseSystemPrompt(messages, memoryEnabled, null, profiles.resolveRichLevel(sessionId, modelId)),
					guardToolContent: truncateToolOutput,
					chatTools: tools,
                    getChatTools: async () => {
                        await mcpManager.reload();
                        await mcpManager.reconnectPrepared?.(sessionId, { signal: controller.signal, authorize: async serverName => {
                            const contexts = require('./lspExecutionContext');
                            const mode = contexts.currentMode(sessionId, permissionMode);
                            if (mode === 'read_only') return null;
                            let approval;
                            try {
                                approval = await guardTool({ name: 'find_and_prepare_mcp_tools', args: { query: serverName },
                                    permissionMode: mode, sessionId, project, signal: controller.signal,
                                    requestApproval: ({ name, args, policy }) => requestToolApproval({ controller, sender, requestId, sessionId, name, args, policy }) });
                            } catch (error) {
                                if (['APPROVAL_DENIED', 'PERMISSION_DENIED'].includes(error.code)) return null;
                                throw error;
                            }
                            return () => {
                                controller.signal.throwIfAborted();
                                if (contexts.currentMode(sessionId, permissionMode) !== approval.mode ||
                                    contexts.revision(sessionId) !== approval.policyRevision)
                                    throw new Error('PERMISSION_REVOKED: Permission changed before MCP reconnection.');
                            };
                        } });
                        const context = getToolContext(mcpManager.getTools(sessionId), profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled, sessionId, permissionMode, modelId);
                        notify({ type: "context", pluginTokens: context.pluginTokens, toolTokens: context.toolTokens });
                        return filterTools(context.tools);
                    },
					signal: controller.signal,
					// Sampling only. Reasoning is resolved separately above, so no
					// legacy budget alias leaks into the provider payload.
					getSamplingParams: () => profiles.getSessionSettings(sessionId, modelId).params,
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
                        executionSteps = steps.map(step => {
                            let linked = childSessionsByToolCall.has(step.id)
                                ? { ...step, childSessionId: childSessionsByToolCall.get(step.id) } : step;
                            if (savedRulesByToolCall.has(step.id)) linked = { ...linked, savedRule: savedRulesByToolCall.get(step.id) };
                            const review = gitCommitReviewsByToolCall.get(step.id);
                            return review ? { ...linked, args: { ...linked.args, ...review } } : linked;
                        });
                        persist();
                        notify({ type: "step-update", messageId, executionSteps: displaySteps(executionSteps) });
                    },
					onStats: (stats) => {
                        const estimate = costEstimator.estimateFromStats({ stats, resolvedPricing: turnPricing,
                            isLocal: !cloud, providerId: cloud ? target.provider : null, modelId });
                        // The renderer shows a compact per-turn cost chip from
                        // this summary; the full evidence (breakdown, rates,
                        // version) is persisted to token history below.
                        currentStats = { ...stats, cost: {
                            total: estimate.totalCost ?? null, currency: estimate.currency,
                            completeness: estimate.completeness, savings: estimate.cacheSavings ?? null,
                            providerReported: estimate.providerReportedCost ?? null, source: estimate.source } };
						persist();
                        // Persist the same normalized turn aggregate the UI sees.
                        // Unknown sides are never replaced with zero: the existing
                        // row schema requires gross prompt/completion counts, so a
                        // turn missing either side is not written as a false total.
                        // Cache fields stay nullable and carry their coverage label.
                        if (Number.isSafeInteger(stats.promptTokens) && Number.isSafeInteger(stats.completionTokens)) {
                            require('./tokenUsage').logTokenUsage({ turnId: usageTurnId, chatId: sessionId ?? null, projectId: usageProjectId,
                                timestamp: usageTimestamp,
                                promptTokens: stats.promptTokens,
                                completionTokens: stats.completionTokens,
                                uncachedInputTokens: stats.uncachedInputTokens ?? null,
                                cacheReadTokens: stats.cachedTokens ?? null,
                                cacheCreationTokens: stats.cacheCreationTokens ?? null,
                                reasoningTokens: stats.reasoningTokens ?? null,
                                visibleOutputTokens: stats.visibleCompletionTokens ?? null,
                                inputSource: stats.inputSource ?? null,
                                cacheReadSource: stats.cacheReadSource ?? null,
                                cacheWriteSource: stats.cacheWriteSource ?? null,
                                cacheReadCoverage: stats.cacheReadCoverage ?? null,
                                cacheWriteCoverage: stats.cacheWriteCoverage ?? null,
                                usageCoverage: stats.inputCoverage === 'measured' && stats.outputCoverage === 'measured'
                                    ? 'measured' : 'partially_measured',
                                modelId: modelId ?? null,
                                provider: cloud ? (target.provider ?? null) : 'local',
                                cost: costEstimator.costColumns(estimate) });
                        }
						notify({ type: "stats", stats: currentStats });
					},
					// Live per-request prompt telemetry. Forward-only: never
					// persisted here and never logged to token usage. The final
					// onStats above remains the single persistence/logging path.
					onPhase: ({ round, promptTokens, completionTokens, cachedTokens, cacheCreationTokens,
						reasoningTokens, visibleCompletionTokens, telemetry }) => {
						notify({ type: "phase", sessionId, round,
							promptTokens: promptTokens ?? null,
							completionTokens: completionTokens ?? null,
							cachedTokens: cachedTokens ?? null,
							cacheCreationTokens: cacheCreationTokens ?? null,
							reasoningTokens: reasoningTokens ?? null,
							visibleCompletionTokens: visibleCompletionTokens ?? null,
							telemetry });
					},
					onThinking: (thinking) => notify({ type: "thinking", thinking }),
					executeTool: async (call, activationRequest) => {
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
                            const currentSchema = getToolContext(mcpManager.getTools(sessionId), memoryEnabled, sessionId,
                                lspExecutionContext?.permissionMode ?? permissionMode, modelId).tools.find(t => t.function.name === call.name);
                            if (!currentSchema) throw new Error('TOOL_NOT_ADVERTISED: Tool was revoked.');
                            const acceptedManifest = advertisedTools.accept(activationRequest?.advertisedManifest, call.name, currentSchema.function.parameters, target);
                            require('./toolSchemaValidation').validate(currentSchema.function.parameters, args);

							if (isMemory && !profiles.getSessionSettings(sessionId, modelId).effective.memoryEnabled) throw new Error('Memory is disabled for this chat.');
							let approval;
							if (!isAskUser) approval = await guardTool({ name: target.toolName, args, permissionMode: lspExecutionContext?.permissionMode ?? permissionMode, sessionId, project,
                                native: isAgent || isMemory, serverName: target.serverName,
                                ...(!isAgent && !isMemory ? mcpManager.getApprovalFacts(target.serverName, target.toolName) : {}), signal: controller.signal,
                                requestApproval: ({ name, args, policy }) => requestToolApproval({ controller, sender, requestId, sessionId, name, args, policy }) });
                            advertisedTools.validateEpoch(acceptedManifest);
                            if (approval?.savedRule) {
                                savedRulesByToolCall.set(call.id, { ...approval.savedRule, projectId: project.id, sessionId });
                                const step = executionSteps.find(step => step?.id === call.id);
                                if (step) {
                                    step.savedRule = { ...approval.savedRule, projectId: project.id, sessionId };
                                    persist();
                                    notify({ type: 'step-update', messageId, executionSteps: displaySteps(executionSteps) });
                                }
                            }
                            if (approval?.gitCommitReview) {
                                gitCommitReviewsByToolCall.set(call.id, approval.gitCommitReview);
                                const step = executionSteps.find(step => step?.id === call.id);
                                if (step) {
                                    step.args = { ...step.args, ...approval.gitCommitReview };
                                    persist();
                                    notify({ type: 'step-update', messageId, executionSteps: displaySteps(executionSteps) });
                                }
                            }
							// Sub-agent observability: link the parent step to the child
							// session as soon as the runtime opens it (before the
							// child finishes), and re-assert on completion. The
							// step id matches the tool-call id (see memoryChat),
							// so parallel same-name calls attach independently.
							// childSessionId survives persistence/display because
							// step validation preserves unknown fields.
							const attachChildSession = (childSessionId) => {
								if (typeof childSessionId !== 'string' || !childSessionId) return;
                                childSessionsByToolCall.set(call.id, childSessionId);
								const step = executionSteps.find(step => step?.id === call.id);
								if (step && step.childSessionId !== childSessionId) {
									step.childSessionId = childSessionId;
									persist();
									notify({ type: "step-update", messageId, executionSteps: displaySteps(executionSteps) });
								}
								return childSessionId;
							};
							let spawnChildId = null;
							const rawOutput = isMemory
								? await executeMemoryTool({ ...call, modelId, sessionId, signal: controller.signal })
								: isAskUser ? await require('./engineManager').askUserDuringRun({
									controller, sender, requestId, sessionId, stepId: call.id, ...args,
									enabled: profiles.getSessionSettings(sessionId, modelId).effective.allowMidRunQuestions,
								})
								: isAgent ? await executeAgentTool({ ...call, sessionId, permissionMode: lspExecutionContext?.permissionMode ?? permissionMode, permissionGranted: true, approval, signal: controller.signal,
                                    engine: chatEngine, budgetScope: childBudgetScope, executionContext: lspExecutionContext, backgroundContext,
                                    validateToolAuthorization: () => advertisedTools.validateEpoch(acceptedManifest),
                                    validateMcpActivation: async (mcpTools) => {
                                        const active = filterTools(getToolContext(mcpTools, memoryEnabled, sessionId,
                                            lspExecutionContext?.permissionMode ?? permissionMode, modelId).tools);
                                        const payload = { ...activationRequest, tools: active };
                                        const { createPromptMeasurer, approximateTokens, createRuntimeBudget } = require('./contextBudget');
                                        if (!cloud) return createPromptMeasurer(require('./localEngineFetch').localEngineFetch)(
                                            `http://127.0.0.1:${config.port}/v1/chat/completions`, payload,
                                            { signal: controller.signal, contextWindowLimit: config.activeModelConfig?.contextLength ?? 32768 });
                                        const metadata = await require('./cloudProviders').getCloudModelMetadata();
                                        const advertised = metadata.find(row => row.providerId === target.provider && row.modelId === target.model)?.contextLength;
                                        const tokens = approximateTokens(payload);
                                        const budgetContract = createRuntimeBudget({ provider: target.provider, modelId,
                                            runtimeContextTokens: advertised, payload, currentInputTokens: tokens });
                                        return { tokens, budget: budgetContract.usableInputTokens, budgetContract, method: 'approximate-full-request' };
                                    },
                                    onChildSession: (childSessionId) => { spawnChildId = attachChildSession(childSessionId); } })
								: await mcpManager.callTool(target.serverName, target.toolName, args, {
										signal: controller.signal, sessionId, permissionMode: lspExecutionContext?.permissionMode ?? permissionMode, permissionGranted: true, approval,
									});
							if (spawnChildId) attachChildSession(spawnChildId);
							const output = sanitizeWebToolResult(rawOutput, call.name);
							// A durable plan change is pushed immediately so the
							// sidebar card updates without polling. Other tabs
							// receive the event but ignore a mismatched sessionId.
							// The tool result is compact, so the card's complete
							// state is re-read from SQLite — the same authoritative
							// rows, never reconstructed from mutation fragments.
							// Failed writes send nothing: the card keeps the last
							// durable state while the agent sees the error.
							if (isAgent && call.name === 'update_plan' && rawOutput?.success && !sender.isDestroyed()) {
								const latestPlan = planForPush(sessionId);
								if (latestPlan) sender.send('session:plan-updated', { sessionId, plan: latestPlan });
							}
							if (isAgent && call.name === 'manage_mcp_servers') {
								const refreshed = getToolContext(mcpManager.getTools(sessionId), memoryEnabled, sessionId, permissionMode, modelId);
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
							result = truncateToolOutput((await import('../lib/toolResultFormatter.mjs')).formatToolResult(result, call.name, { workspaceRoot: backgroundContext?.workspace }).displayResult);
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
				// Per-turn work digest: built from the persisted steps for
				// Workspace sessions only. Fail-safe by contract
				// (recordTurnDigestSafe never throws): digest work must never
				// break, stall, or alter a turn.
				if (sessionId && persistence) {
					require('./workLog').recordTurnDigestSafe({
						sessionId,
						assistantMessageId: persistence.messageId,
						partial: controller.signal.aborted || stoppedByCircuitBreak,
					});
				}
				if (!stoppedByCircuitBreak) require('./engineManager').notifyChatOutcome({ text,
					interrupted: stoppedByLimit, aborted: controller.signal.aborted });
				return { text, stats: currentStats, executionSteps, runId, message: { id: persistence?.messageId ?? messageId, role: "assistant", displayName: capturedDisplayName, content: text, executionSteps, status: controller.signal.aborted || stoppedByCircuitBreak ? "interrupted" : "completed" } };
			} catch (error) {
                persist("interrupted");
				if (sessionId && persistence) {
					require('./workLog').recordTurnDigestSafe({
						sessionId,
						assistantMessageId: persistence.messageId,
						partial: true,
					});
				}
				require('./engineManager').notifyChatOutcome({ error, aborted: controller.signal.aborted });
                throw error;
			} finally {
                try {
				if (persistTimer !== null) clearTimeout(persistTimer);
                finishEngineRequest?.();
                notify({ type: "indexing", progress: null });
				sender.removeListener("destroyed", abort);
				active.delete(requestId);
				if (!active.size) requests.delete(sender);
				if (activeStreams.get(streamKey) === controller) activeStreams.delete(streamKey);
				if (backgroundContext) {
                    await require('./backgroundCommands').closeRun(backgroundContext);
                    require('./backgroundCommands').events.removeListener('change', backgroundUpdate);
                }
				steeringRuns.delete(runId);
                require('./nativeToolActivation').end(sessionId, runId);
                mcpManager.endRun?.(sessionId, runId);
				// Close the steering queue only after the run is no longer
				// discoverable, so a late submission cannot slip in after this
				// reconciliation. Anything not delivered is reported, never applied.
				if (sessionId) {
					try {
						const remaining = runSteering.finalizeRun({
							sessionId, runId,
							reason: controller.signal.aborted
								? 'The run was stopped before this instruction could be delivered.'
								: undefined,
						});
						emitSteeringUpdates(sender, remaining);
					} catch (error) {
						// Run teardown must never mask the model result or the abort.
						console.error('[steering] could not finalize the run:', error?.message ?? error);
					}
				}
				if (sessionId && !sender.isDestroyed()) sender.send('engine:stream-status', { sessionId, status: 'idle', runId });
                } finally { settleRun(); }
			}
		},
		"session:regenerate-last": async (data, notify, sender) => {
			const target = getRegenerationTarget(data.sessionId);
			const messages = prepareChatMessages({ ...data, userText: '', regenerate: true, regenerateLast: true });
            const agent = agents.getSessionAgent(data.sessionId);
            const result = await handlers["engine:chat"]({ ...data, messages, messageId: target.id }, notify, sender);
            const variant = {
                content: result.text, status: result.message.status, executionSteps: result.executionSteps, displayName: result.message.displayName,
                model_name: typeof data.modelName === 'string' && data.modelName.trim() ? data.modelName : data.modelId,
                model_id: data.modelId, agent_name: agent?.name ?? null,
                run_id: result.runId ?? null,
                stats: result.stats ? { ...result.stats, tokens_per_sec: result.stats.tokensPerSecond,
                    total_tokens: result.stats.totalTokens, duration: result.stats.time } : null,
                created_at: new Date().toISOString(),
            };
            const { db } = require('./db');
            return db.transaction(() => {
                try {
                    // The re-run turn's digest was recorded against the
                    // temporary row: re-key it onto the surviving target row
                    // FIRST, so the temporary row's deletion below (which
                    // cascades digest rows) never orphans it. Complete beats
                    // stale partial, same as same-turn races.
                    require('./workLog').rekeyTurnDigest({ sessionId: data.sessionId, fromMessageId: result.message.id, toMessageId: target.id });
                } catch (error) {
                    console.error('[workLog] regenerate digest rekey failed (turn unaffected):', error?.message ?? error);
                }
                if (result.message.id !== target.id) db.prepare('DELETE FROM messages WHERE id = ? AND session_id = ?').run(result.message.id, data.sessionId);
                // The surviving reply row now represents this run, so its
                // additional-prompts footer follows the regenerated answer.
                if (result.runId) db.prepare('UPDATE messages SET run_id = ? WHERE id = ? AND session_id = ?').run(result.runId, target.id, data.sessionId);
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
		"file:attachment-policy": input => require('./attachmentAccess').getAttachmentPolicy(input, getEngineConfig),
        "file:process-uploads": async input => {
            if (Array.isArray(input)) {
                const engine = getEngineConfig?.();
                input = { files: input, modelId: engine?.modelPath, activeChatProvider: { type: 'local' } };
            }
            const policy = await require('./attachmentAccess').getAttachmentPolicy(input, getEngineConfig);
            const { assertAttachmentNames } = await import('../lib/attachmentPolicy.mjs');
            if (!Array.isArray(input.files)) throw new Error('Invalid uploads.');
            assertAttachmentNames(input.files.map(file => typeof file === 'string' ? file : file.name), policy);
            return processUploads(input.files);
        },
		"workspace:compaction-activity-list": ({ sessionId }) => require('./workspaceCompactionActivity').list(sessionId),
        "session:get-all": () => getAllSessions(),
		"session:create-folder": ({ folderName }) => createFolder(folderName),
		"session:load": ({ sessionId }) => loadSession(sessionId),
		"session:load-display": async ({ sessionId }) => {
			// A restored tab can outlive its session row: the chat was deleted in
			// another tab, or the tab was flagged saved for a session whose first
			// message never reached the database. The renderer renders that as an
			// empty chat, so report the absence as `null` instead of throwing a
			// main-process handler error on every launch.
			let session;
			try {
				session = loadSession(sessionId);
			} catch (error) {
				if (error?.message === 'Session not found.') return null;
				throw error;
			}
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
		"session:delete": ({ sessionId }, _notify, sender) => require('./sessionDeletion').deleteConversation(
            sessionId, sender, controller => [...(requests.get(sender)?.values() ?? [])].includes(controller)),
		"session:delete-message": ({ sessionId, messageId }) => deleteMessage(sessionId, messageId),
		"session:branch-chat": ({ sourceSessionId, targetMessageId }) =>
			branchChat(sourceSessionId, targetMessageId),
		"session:edit-message": ({ messageId, newContent }) => editMessage(messageId, newContent),
		"agent:get-tools": ({ sessionId = null, permissionMode } = {}) => agentTools.filter(tool =>
            (!require('./tools/lspTools').LSP_TOOL_NAMES.includes(tool.function.name) || require('./tools/lspTools').available(sessionProject(sessionId))) && require('./toolPermissions').isToolVisible(tool.function.name, { project: sessionProject(sessionId),
                permissionMode: require('./lspExecutionContext').currentMode(sessionId, permissionMode) })),
        "agent:execute-tool": async ({ name, arguments: args, sessionId, permissionMode }, _notify, sender) => {
            if (!['delegate_task', 'extract_web_page_data', 'spawn_sub_agent'].includes(name)) {
                const result = await executeAgentTool({ name, arguments: args, sessionId, permissionMode });
                if (name === 'update_plan' && result?.success && !sender.isDestroyed()) {
                    const latestPlan = planForPush(sessionId);
                    if (latestPlan) sender.send('session:plan-updated', { sessionId, plan: latestPlan });
                }
                return result;
            }
            if (requests.size || standaloneDelegation) throw new Error('Wait for the active chat before delegating a standalone task.');
            standaloneDelegation = true;
            const controller = new AbortController();
            const abort = () => controller.abort(require('./workspaceGenerationRuntime').reason('renderer-destroyed'));
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
            await guardTool({ name: data.name, args: typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments, permissionMode: data.permissionMode, sessionId: data.sessionId, project: sessionProject(data.sessionId) });
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
		// Tokenizer-based measurement of the prepared prompt for the next
		// request. Event-driven only (never polled): the renderer calls this
		// after prompt state changes. Failures degrade to a labeled estimate.
		"session:measure-context": async ({ sessionId, modelId, cloud = false, permissionMode = undefined, userText = "" }) => {
			const config = getEngineConfig?.();
			return require("./promptMeasurement").measurePreparedContext({ sessionId, modelId, cloud, permissionMode, userText,
				engine: cloud || !config ? null : { port: config.port, modelPath: config.modelPath ?? config.activeModelConfig?.modelPath ?? null,
					contextLength: config.activeModelConfig?.contextLength ?? 32768,
                    localModel: config.modelMetadata, runtimeIdentity: config.runtimeIdentity, parallelSlots: config.activeModelConfig?.parallel } });
		},
		"session:get-messages": ({ sessionId }) => getActiveMessages(sessionId),
		"session:get-summary": ({ sessionId }) => getSessionSummary(sessionId),
		// Read-only Workspace Context inspection (see src/main/contextInspection.js).
		// Same trusted-sender + withDataAccess wrapping as every handler below.
		"session:get-checkpoint": ({ sessionId }) => require('./contextInspection').getCheckpointForDisplay(sessionId),
		"session:get-checkpoint-history": ({ sessionId, limit }) => require('./contextInspection').getCheckpointHistoryForDisplay(sessionId, limit),
		"session:get-briefs": ({ sessionId }) => require('./contextInspection').getBriefsForDisplay(sessionId),
		// Read-only durable task plan for the workspace sidebar. Null for a
		// casual session or a task that has not created a plan yet.
		"session:get-background-commands": async ({ sessionId }) => {
            const project = require('./toolPermissions').sessionProject(sessionId);
            return project?.root_path ? require('./backgroundCommands').list(sessionId, await require('node:fs/promises').realpath(project.root_path)) : [];
        },
        "session:get-plan": ({ sessionId }) => require('./workspacePlan').getPlan(sessionId),
        // Explicit W2 preparation only. This API never calls the compaction
        // commit path and never changes the prompt or active history.
        "session:generate-compact-candidate": async ({ sessionId, modelId }) => {
            const config = getEngineConfig?.();
            if (!config || config.modelPath !== modelId || !config.port || typeof llmCheckpointCallback !== 'function')
                return { ok: false, code: 'model-unavailable' };
            const identity = config.runtimeIdentity;
            const { createPromptMeasurer } = require('./contextBudget');
            const { localEngineFetch } = require('./localEngineFetch');
            const measure = createPromptMeasurer(localEngineFetch);
            return require('./compressionEngine').generateWorkspaceCompactCandidate({ sessionId, modelId,
                isCurrent: () => getEngineConfig?.()?.runtimeIdentity === identity && getEngineConfig?.()?.modelPath === modelId,
                capacityTokens: config.activeModelConfig?.contextLength ?? 8192,
                measure: (payload, { signal }) => measure(`http://127.0.0.1:${config.port}/v1/chat/completions`, payload,
                    { signal, contextWindowLimit: config.activeModelConfig?.contextLength ?? 8192 }),
                generate: async (request, { signal, onProgress }) => {
                    if (getEngineConfig?.()?.runtimeIdentity !== identity) throw Object.assign(new Error('Engine changed.'), { code: 'concurrent-state-change' });
                    const result = await llmCheckpointCallback(null, modelId, { signal, onProgress, candidateRequest: request });
                    if (getEngineConfig?.()?.runtimeIdentity !== identity) throw Object.assign(new Error('Engine changed.'), { code: 'concurrent-state-change' });
                    return result;
                },
            });
        },
		"session:get-archived-messages": ({ sessionId, limit, offset }) => require('./contextInspection').getArchivedMessagesForDisplay(sessionId, { limit, offset }),
		"session:trigger-compression": ({ sessionId, modelId, contextWindowLimit }, notify) => {
			if (typeof llmSummarizeCallback !== "function") {
				throw new Error("Configure a main-process summarizer before scheduling compression.");
			}
			scheduleIdleCompression(
				sessionId,
				modelId,
				contextWindowLimit,
				(oldSummary, messageBatch, _modelId, opts) => llmSummarizeCallback(oldSummary, messageBatch, modelId, opts ?? {}),
				notify,
				typeof llmCheckpointCallback === "function"
					? (input, _modelId, opts) => llmCheckpointCallback(input, modelId, opts ?? {})
					: null,
                {
                    resolveMeasurement: async () => {
                        const config = getEngineConfig?.();
                        const currentModel = config?.modelPath ?? config?.activeModelConfig?.modelPath;
                        if (!config || currentModel !== modelId || !config.port) return null;
                        const identity = config.runtimeIdentity;
                        const measured = await require('./promptMeasurement').measurePreparedContext({ sessionId, modelId,
                            engine: { port: config.port, modelPath: currentModel, runtimeIdentity: identity,
                                contextLength: config.activeModelConfig?.contextLength, localModel: config.modelMetadata } });
                        if (getEngineConfig?.()?.runtimeIdentity !== identity) return null;
                        return { ...measured, isCurrent: () => require('./promptMeasurement').isPreparedContextCurrent(sessionId, modelId, measured.stateIdentity) && getEngineConfig?.()?.runtimeIdentity === identity &&
                            (getEngineConfig?.()?.modelPath ?? getEngineConfig?.()?.activeModelConfig?.modelPath) === modelId };
                    },
                },
			);
			return { scheduled: true };
		},
	};

	const registered = [];
	const dispose = () => {
		mcpManager.off("changed", broadcast);
		subscribers.clear();
		for (const active of requests.values()) for (const controller of active.values()) controller.abort(require('./workspaceGenerationRuntime').reason('ipc-disposed'));
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
                        record => { if (!event.sender.isDestroyed() && isTrustedSender(event)) event.sender.send('workspace:compaction-activity', record); },
					); } finally { dispatcher.close(); }
				}
				if (channel === "session:trigger-compression") {
					return handler(payload, (result) => {
						if (!event.sender.isDestroyed() && isTrustedSender(event)) {
							event.sender.send("session:compression-complete", result);
						}
					});
				}
				// Steering handlers read/write only main-process state but need the
				// sender identity to prove run ownership. No stream dispatcher is
				// involved: status updates are compact direct events.
				if (channel.startsWith("steering:") || channel === "engine:set-permission-mode" || channel === "session:delete") return handler(payload, () => {}, event.sender);
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

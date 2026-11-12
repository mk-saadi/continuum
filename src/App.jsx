import DesktopMascotBridge from './components/mascot/DesktopMascotBridge';
import CommandSpotlight from "./components/CommandSpotlight.jsx";
import NotificationSoundLifecycle from './components/NotificationSoundLifecycle.jsx';
import ProjectsView from "./components/ProjectsView";
import ProjectWorkspace from "./components/ProjectWorkspace";
import TasksView from "./components/scheduled-tasks/TasksView.jsx";
import ProjectModal from "./components/ProjectModal";
import Header from "./components/main-app/Header.jsx";
import MemorySettings from "./components/main-app/MemorySettings.jsx";
import ModelSelectorModal from "./components/main-app/ModelSelectorModal.jsx";
import useAvatarSettings from "./hooks/useAvatarSettings";
import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useMemoryPalace } from "./components/MemoryPalace.jsx";
import { ChatInterface } from "./components/main-app/ChatInterface.jsx";
import { Titlebar } from "./components/main-app/Titlebar.jsx";
import TabBar from "./components/TabBar.jsx";
import { TabProvider, useTabs } from "./context/TabContext.jsx";
import { CompressionEventsProvider } from "./context/CompressionEventsContext.jsx";
import { UIStateProvider, useModalActions, useModalState, useTheme } from "./context/UIStateContext.jsx";
import useBackgroundSettings from "./hooks/useBackgroundSettings";
import { workspaceHeaderFor } from "./lib/headerWorkspace.mjs";

// Global modal visibility lives in UIStateContext, so this subscriber is the
// only thing that re-renders when a modal opens or closes — AppContent, the tab
// list and every mounted chat transcript stay put.
function GlobalModals({
	models,
	selectedModel,
	engines,
	cloudProviders,
	activeChatProvider,
	onSelectProvider,
	onSelectModel,
	scanning,
	onScan,
	engineRunning,
	serverError,
	onLoadedModel,
	onUnloadModel,
	onCreateProject,
}) {
	const actions = useModalActions();
	const modals = useModalState();
	return (
		<>
			{modals?.modelSelectorOpen && (
				<ModelSelectorModal
					models={models}
					selectedModel={selectedModel}
					engines={engines}
					cloudProviders={cloudProviders}
					activeChatProvider={activeChatProvider}
					onSelectProvider={onSelectProvider}
					onSelectModel={onSelectModel}
					scanning={scanning}
					onScan={onScan}
					engineRunning={engineRunning}
					serverError={serverError}
					onLoaded={onLoadedModel}
					onUnloadModel={onUnloadModel}
					onClose={actions.closeModelSelector}
				/>
			)}
			{modals?.projectModalOpen && (
				<ProjectModal onClose={actions.closeProjectModal} onCreate={onCreateProject} />
			)}
		</>
	);
}

// Per-tab settings panel. Subscribing to the modal + theme contexts here means
// opening the panel (or switching theme) never re-renders the tab's transcript.
function SettingsModalSlot({ active, palace, avatars, models, engineRunning, serverPort, serverError }) {
	const actions = useModalActions();
	const modals = useModalState();
	const themeState = useTheme();
	// The palace publishes a new object on every 2-second context poll. The
	// settings modal only reads a few fields from it, so it is narrowed here:
	// passing the whole object made every poll rebuild the entire settings
	// tree, which is what made opening and scrolling the modal feel heavy.
	const palaceView = useMemo(
		() => ({
			api: palace?.api,
			enabled: palace?.enabled,
			toggle: palace?.toggle,
			mcpStatus: palace?.mcpStatus,
			refresh: palace?.refresh,
		}),
		[palace?.api, palace?.enabled, palace?.toggle, palace?.mcpStatus, palace?.refresh],
	);
	if (!modals?.settingsOpen || !active) return null;
	return (
		<MemorySettings
			initialTab={modals.settingsTab}
			palace={palaceView}
			avatars={avatars}
			models={models}
			theme={themeState?.theme}
			onChangeTheme={themeState?.setTheme}
			engineRunning={engineRunning}
			serverPort={serverPort}
			serverError={serverError}
			onClose={actions.closeSettings}
		/>
	);
}

function AppContent() {
	const { tabs, activeTab, activeTabId, updateTab, markTabSaved } = useTabs();
	// Stable action object: opening the project modal from the sidebar must not
	// subscribe AppContent (or TabPane) to modal visibility changes.
	const modalActions = useModalActions();
	const [projects, setProjects] = useState([]);
	const [projectsLoading, setProjectsLoading] = useState(true);
	const [projectsError, setProjectsError] = useState("");
	const refreshProjects = useCallback(async () => {
		setProjectsLoading(true);
		setProjectsError("");
		try {
			setProjects(await window.api.listProjects());
		} catch (error) {
			setProjectsError(error.message);
		} finally {
			setProjectsLoading(false);
		}
	}, []);
	useEffect(() => {
		refreshProjects();
	}, [refreshProjects]);
	const updateProject = useCallback(
		(updated) =>
			setProjects((previous) =>
				previous
					.map((project) => (project.id === updated.id ? updated : project))
					.sort((a, b) => b.is_pinned - a.is_pinned || b.updated_at.localeCompare(a.updated_at)),
			),
		[],
	);
	const avatars = useAvatarSettings();
	// Owns the custom background image + whole-UI opacity layer (side effect;
	// the returned state is currently unused by the shell itself).
	useBackgroundSettings();
	const [models, setModels] = useState([]);
	const selectedModel = activeTab.modelId;
	// Every running local engine (one per loaded model). The pool is shared by
	// all chat tabs; a tab routes to whichever engine matches its model.
	const [engines, setEngines] = useState([]);
	// The engine the UI last acted on, used when a tab falls back to "local".
	const [activeModelPath, setActiveModelPath] = useState(null);
	const activeChatProvider = activeTab.modelId?.startsWith("cloud:")
		? {
				type: "cloud",
				provider: activeTab.modelId.split(":")[1],
				model: activeTab.modelId.split(":").slice(2).join(":"),
			}
		: { type: "local" };
	const [cloudProviders, setCloudProviders] = useState([]);
	useEffect(() => {
		let active = true;
		const refresh = () =>
			window.api
				.getCloudProviders()
				.then((rows) => {
					if (active) {
						setCloudProviders(rows);
					}
				})
				.catch(console.error);
		refresh();
		window.addEventListener("cloud-providers-changed", refresh);
		return () => {
			active = false;
			window.removeEventListener("cloud-providers-changed", refresh);
		};
	}, []);
	const [scanning, setScanning] = useState(false);
	const scanInProgress = useRef(false);
	const [serverError, setServerError] = useState(null); // last bridge-level error (spawn/bind failure, etc.)
	// Stable array: rebuilt only when the underlying model/cloud lists change,
	// so unrelated AppContent renders do not invalidate every TabPane.
	// Cloud providers no longer store a single model. A provider's legacy saved
	// model is listed for compatibility, and every chat tab's current cloud
	// selection is added so the header and transcript can resolve its name.
	const chatModels = useMemo(() => {
		const cloudModels = [];
		const seen = new Set();
		for (const row of cloudProviders) {
			if (!row.configured) continue;
			const modelId = row.modelId?.trim();
			if (!modelId) continue;
			const id = `cloud:${row.id}:${modelId}`;
			seen.add(id);
			cloudModels.push({ id, name: `${row.name} / ${modelId}` });
		}
		for (const item of tabs) {
			if (!item.modelId?.startsWith("cloud:") || seen.has(item.modelId)) continue;
			const [, providerId, ...rest] = item.modelId.split(":");
			const model = rest.join(":");
			if (!providerId || !model) continue;
			const provider = cloudProviders.find((row) => row.id === providerId);
			seen.add(item.modelId);
			cloudModels.push({
				id: item.modelId,
				name: `${provider?.name || providerId} / ${model}`,
			});
		}
		return [...models, ...cloudModels];
	}, [models, cloudProviders, tabs]);

	// Scan on mount; clicking an empty dropdown also allows a retry.
	const handleScanClick = useCallback(async () => {
		const { modelsAPI } = window;
		if (!modelsAPI || scanInProgress.current) return;
		scanInProgress.current = true;
		setScanning(true);
		try {
			const config = await window.api.getConfig();
			const result = await modelsAPI.scanLocalModels(config.modelDirectory);
			if (result.success) {
				const scannedModels = result.models || [];
				setModels(scannedModels);
			}
		} catch (err) {
			console.error("Model scan failed:", err);
		} finally {
			scanInProgress.current = false;
			setScanning(false);
		}
	}, []);
	useEffect(() => {
		handleScanClick();
	}, [handleScanClick]);
	useEffect(() => {
		window.addEventListener("model-directory-changed", handleScanClick);
		return () => window.removeEventListener("model-directory-changed", handleScanClick);
	}, [handleScanClick]);
	// Listen for engine status changes from the main process. Status now
	// carries the full `engines` pool (one entry per loaded model); this is the
	// only place the pool is written, so its ports always reflect what the
	// backend actually bound.
	useEffect(() => {
		const { terminalAPI, electronAPI } = window;
		if (!terminalAPI) return;
		let statusVersion = 0;
		let disposed = false;
		const applyStatus = (payload) => {
			if (disposed) return;
			statusVersion++;
			const list = Array.isArray(payload?.engines)
				? payload.engines
				: payload?.modelPath
					? [payload]
					: [];
			setEngines(list);
			const activePath = payload?.modelPath ?? list.at(-1)?.modelPath ?? null;
			setActiveModelPath(activePath);
			if (payload?.modelPath) {
				try {
					localStorage.setItem("lastSelectedModelPath", payload.modelPath);
				} catch {
					/* Selection still works without storage. */
				}
			}
			if (list.length) setServerError(null);
		};
		const cleanupStatus = terminalAPI.onStatus(applyStatus);
		// Initial status check
		const initialVersion = statusVersion;
		Promise.all([terminalAPI.status(), electronAPI?.getEngineStatus()])
			.then(([status, modelStatus]) => {
				if (statusVersion === initialVersion) applyStatus({ ...status, ...modelStatus });
			})
			.catch((error) => {
				if (!disposed && statusVersion === initialVersion) setServerError(error.message);
			});
		// Dedicated error channel for bridge-level failures (bind conflicts,
		// spawn failures, unexpected exits) that aren't just a stdout/stderr
		// log line. Not present in the current preload.js — guarded so this
		// is a no-op until/unless that's added, rather than throwing.
		const cleanupError = terminalAPI.onError
			? terminalAPI.onError((message) => {
					setServerError(message);
				})
			: undefined;
		return () => {
			disposed = true;
			cleanupStatus?.();
			cleanupError?.();
		};
	}, []);
	// Bound to the active tab. Kept stable per active tab so the model selector
	// consumer is not invalidated by unrelated shell renders.
	const setSelectedModel = useCallback((modelId) => updateTab(activeTabId, { modelId }), [updateTab, activeTabId]);
	const defaultLocalModel = activeModelPath ?? engines[0]?.modelPath ?? selectedModel;
	const setActiveChatProvider = useCallback(
		(provider) =>
			updateTab(activeTabId, {
				modelId:
					provider.type === "cloud"
						? `cloud:${provider.provider}:${provider.model}`
						: defaultLocalModel,
			}),
		[updateTab, activeTabId, defaultLocalModel],
	);
	const onLoadedModel = useCallback(
		(result) => {
			setServerError(result.warning || null);
			if (result.modelPath) {
				setSelectedModel(result.modelPath);
				try {
					localStorage.setItem("lastSelectedModelPath", result.modelPath);
				} catch {
					/* Optional. */
				}
			}
		},
		[setSelectedModel],
	);
	// Unload one engine without touching the others in the pool.
	const onUnloadModel = useCallback(async (modelPath) => {
		try {
			await window.api.unloadEngine(modelPath);
		} catch (error) {
			setServerError(error.message);
		}
	}, []);
	const handleCreateProject = useCallback(
		async (fields) => {
			const project = await window.api.createProject(fields);
			setProjects((previous) => [...previous, project]);
			updateTab(activeTabId, { projectId: project.id, view: "project" });
		},
		[updateTab, activeTabId],
	);
	return (
		<div className="sk-app sk-app-window flex flex-col h-full w-full overflow-hidden ui-radius-surface bg-[var(--surface)] shadow-[0_8px_32px_var(--window-shadow)]">
			<CommandSpotlight projects={projects} models={models} engines={engines} onLoadedModel={onLoadedModel} />
			<Titlebar />
			<TabBar projects={projects} />
			<GlobalModals
				models={models}
				selectedModel={selectedModel}
				engines={engines}
				cloudProviders={cloudProviders}
				activeChatProvider={activeChatProvider}
				onSelectProvider={setActiveChatProvider}
				onSelectModel={setSelectedModel}
				scanning={scanning}
				onScan={handleScanClick}
				engineRunning={engines.length > 0}
				serverError={serverError}
				onLoadedModel={onLoadedModel}
				onUnloadModel={onUnloadModel}
				onCreateProject={handleCreateProject}
			/>
			{tabs.map((tab) => (
				<TabPane
					key={tab.id}
					tab={tab}
					active={tab.id === activeTabId}
					updateTab={updateTab}
					projects={projects}
					projectsLoading={projectsLoading}
					projectsError={projectsError}
					refreshProjects={refreshProjects}
					updateProject={updateProject}
					avatars={avatars}
					models={chatModels}
					localModels={models}
					onCreateProject={modalActions.openProjectModal}
					onUnloadModel={onUnloadModel}
					engines={engines}
					serverError={serverError}
					markTabSaved={markTabSaved}
				/>
			))}
		</div>
	);
}

// Memoized: every prop above has a stable identity across unrelated shell
// renders (state values, memoized arrays, useCallback handlers, or the tab
// object, whose identity only changes when that tab actually changes). Sidebar,
// modal and theme state no longer pass through here — the components that
// render that chrome subscribe to UIStateContext directly.
const TabPane = memo(function TabPane({
	tab,
	active,
	updateTab,
	projects,
	projectsLoading,
	projectsError,
	refreshProjects,
	updateProject,
	avatars,
	models,
	localModels,
	onCreateProject,
	onUnloadModel,
	engines,
	serverError,
	markTabSaved,
}) {
	const update = useCallback((patch) => updateTab(tab.id, patch), [updateTab, tab.id]);
	const setSessionId = useCallback((id) => update({ sessionId: id }), [update]);
	const isCloud = tab.modelId?.startsWith("cloud:");
	const parts = isCloud ? tab.modelId.split(":") : [];
	// Derived from the tab's model id only. A fresh object on every render would
	// invalidate ChatInterface's send/reply callbacks (and the effects that
	// depend on them) even when the provider itself is unchanged.
	const activeChatProvider = useMemo(
		() =>
			isCloud
				? { type: "cloud", provider: parts[1], model: parts.slice(2).join(":") }
				: { type: "local" },
		[isCloud, tab.modelId],
	);
	// This tab routes to its own engine in the shared pool (if loaded).
	const tabEngine = isCloud
		? null
		: engines.find((engine) => engine.modelPath === tab.modelId) ?? null;
	const localReady = !!tabEngine?.isLoaded;
	const contextStatus = tabEngine?.contextStatus ?? "stopped";
	const activeModelConfig = tabEngine?.activeModelConfig ?? null;
	const serverPort = tabEngine?.port ?? null;
	const loadWarning = tabEngine?.offloadWarning ?? null;
	const palace = useMemoryPalace(
		tab.modelId,
		localReady ? activeModelConfig : null,
		tab.sessionId,
		setSessionId,
		{ isCloud, permissionMode: tab.permissionMode, engineReady: localReady, enginePort: localReady ? serverPort : null, isActive: active },
	);
	const view = tab.view || "chat";
	const onChat = () => update({ view: "chat" });
	const onTasks = () => update({ view: "tasks" });
	const onProject = (id) => update({ projectId: id, view: "project" });
	// Chat vs Workspace Chat for the Header, keyed on tab.projectId.
	const workspaceHeader = workspaceHeaderFor(tab, projects, update);
	return (
		<div
			style={active ? undefined : { display: "none" }}
			aria-hidden={!active}
			className="flex min-h-0 flex-1 flex-col"
		>
			<Header
				contextStatus={contextStatus}
				loadWarning={loadWarning}
				isCloud={isCloud}
				modelName={
					isCloud
						? models.find((model) => model.id === tab.modelId)?.name ||
							`${parts[1]} / ${parts.slice(2).join(":")}`
						: localReady
							? tabEngine?.modelName || tab.modelId
							: models.find((model) => model.id === tab.modelId)?.name || tab.modelId
				}
				engineRunning={localReady}
				modelId={tab.modelId}
				onUnloadModel={onUnloadModel}
				palace={palace}
				workspace={view === "tasks" && workspaceHeader ? { ...workspaceHeader, name: null } : workspaceHeader}
                sidebarsDisabled={view === "projects" || view === "tasks"}
			/>
			<SettingsModalSlot
				active={active}
				palace={palace}
				avatars={avatars}
				models={localModels}
				engineRunning={engines.length > 0}
				serverPort={serverPort}
				serverError={serverError}
			/>
			{palace.toast && (
				<div
					role="status"
					className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 ui-radius-control bg-[var(--surface-raised)] px-4 py-2 text-xs shadow-lg"
				>
					{palace.toast}
				</div>
			)}
			<ChatInterface
				navigationTarget={tab.navigationTarget}
				tabActive={active}
				view={view}
				projects={projects}
				activeProjectId={tab.projectId}
				onProjects={() => update({ view: "projects" })}
				onProject={onProject}
				onCreateProject={onCreateProject}
				onChat={onChat}
				onTasks={onTasks}
				renderWorkspace={({ groups, loadChat, startProjectChat, busy, canStartChat, chatComposer }) =>
					view === "tasks" ? (
						<TasksView
							models={models}
							projects={projects}
							onOpenRun={loadChat}
							chatBusy={busy}
						/>
					) : view === "projects" ? (
						<ProjectsView
							projects={projects}
							loading={projectsLoading}
							error={projectsError}
							onRetry={refreshProjects}
							onCreate={onCreateProject}
							onOpen={onProject}
							onPin={async (project) =>
								updateProject(
									await window.api.setProjectPinned(project.id, !project.is_pinned),
								)
							}
						/>
					) : view === "project" ? (
						<ProjectWorkspace
							key={tab.projectId}
							projectId={tab.projectId}
							sessions={groups.flatMap((group) => group.sessions)}
							onBack={() => update({ view: "projects" })}
							onUpdated={updateProject}
							onLoadChat={loadChat}
							onStartChat={startProjectChat}
                            chatComposer={chatComposer}
							chatDisabled={busy}
							canStartChat={canStartChat}
						/>
					) : null
				}
				models={models}
				onSelectModel={(modelId) => update({ modelId })}
				avatarSettings={avatars.settings}
				selectedModel={tab.modelId}
				activeChatProvider={activeChatProvider}
				baseUrl={localReady && serverPort ? `http://127.0.0.1:${serverPort}` : null}
				engineRunning={localReady}
				activeModel={
					localReady && ["warming", "ready", "warmup-failed"].includes(contextStatus)
						? { modelPath: tab.modelId, contextSize: activeModelConfig?.contextLength ?? 32768 }
						: null
				}
				palace={palace}
				onTabUpdate={update}
				tabPermissionMode={tab.permissionMode}
				tabSaved={tab.saved === true}
				onTabSaved={markTabSaved}
			/>
		</div>
	);
});

export { TabPane };

export default function App() {
	return (
		<CompressionEventsProvider>
            <NotificationSoundLifecycle />
			<TabProvider>
				<UIStateProvider>
					<AppContent />
					<DesktopMascotBridge />
				</UIStateProvider>
			</TabProvider>
		</CompressionEventsProvider>
	);
}

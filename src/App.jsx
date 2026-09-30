import ProjectsView from './components/ProjectsView';
import ProjectWorkspace from './components/ProjectWorkspace';
import ProjectModal from './components/ProjectModal';
import Header from "./components/main-app/Header.jsx";
import MemorySettings from "./components/main-app/MemorySettings.jsx";
import ModelSelectorModal from "./components/main-app/ModelSelectorModal.jsx";
import { useTerminalLog } from "./components/TerminalLog";
import useAvatarSettings from "./hooks/useAvatarSettings";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { useMemoryPalace } from "./components/MemoryPalace.jsx";
import { ChatInterface } from "./components/main-app/ChatInterface.jsx";
import { Titlebar } from "./components/main-app/Titlebar.jsx";

export default function App() {
	const [view, setView] = useState('chat');
    const [activeProjectId, setActiveProjectId] = useState(null);
    const [projects, setProjects] = useState([]);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const [projectsError, setProjectsError] = useState('');
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const refreshProjects = useCallback(async () => {
        setProjectsLoading(true); setProjectsError('');
        try { setProjects(await window.api.listProjects()); }
        catch (error) { setProjectsError(error.message); }
        finally { setProjectsLoading(false); }
    }, []);
    useEffect(() => { refreshProjects(); }, [refreshProjects]);
    const updateProject = updated => setProjects(previous => previous.map(project => project.id === updated.id ? updated : project)
        .sort((a, b) => b.is_pinned - a.is_pinned || b.updated_at.localeCompare(a.updated_at)));
    const openProject = id => { setActiveProjectId(id); setView('project'); };
    const avatars = useAvatarSettings();
	const terminalLog = useTerminalLog();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(
		() => localStorage.getItem("rightSidebarOpen") === "true",
	);
	useEffect(() => {
		localStorage.setItem("rightSidebarOpen", String(isRightSidebarOpen));
	}, [isRightSidebarOpen]);
	const [isSidebarOpen, setIsSidebarOpen] = useState(() => localStorage.getItem("sidebarOpen") === "true");
	useEffect(() => {
		localStorage.setItem("sidebarOpen", String(isSidebarOpen));
	}, [isSidebarOpen]);
	const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
	const [models, setModels] = useState([]);
	const [selectedModel, setSelectedModel] = useState(() => {
        try { return localStorage.getItem("lastSelectedModelPath") || ""; } catch { return ""; }
    });
	const [loadedLocalModel, setLoadedLocalModel] = useState(null);
    const activeModelPath = loadedLocalModel?.modelPath ?? null;
    const [activeChatProvider, setActiveChatProvider] = useState({ type: "local" });
    const [cloudProviders, setCloudProviders] = useState([]);
    useEffect(() => {
        let active = true;
        const refresh = () => window.api.getCloudProviders().then(rows => { if (active) {
            setCloudProviders(rows);
            setActiveChatProvider(previous => {
                if (previous.type !== 'cloud') return previous;
                const provider = rows.find(row => row.id === previous.provider && row.configured && row.modelId?.trim());
                return provider ? { type: 'cloud', provider: provider.id, model: provider.modelId } : { type: 'local' };
            });
        } }).catch(console.error);
        refresh();
        window.addEventListener("cloud-providers-changed", refresh);
        return () => { active = false; window.removeEventListener("cloud-providers-changed", refresh); };
    }, []);
    const [activeModelName, setActiveModelName] = useState(null);
	const [scanning, setScanning] = useState(false);
	const scanInProgress = useRef(false);
	const [contextStatus, setContextStatus] = useState("stopped");
	const [engineRunning, setEngineRunning] = useState(false);
	const [activeModelConfig, setActiveModelConfig] = useState(null);
	const [enginePid, setEnginePid] = useState(null);
	const [serverPort, setServerPort] = useState(null); // dynamic port reported by main/preload, null until known
	const [serverError, setServerError] = useState(null); // last bridge-level error (spawn/bind failure, etc.)
	const isCloud = activeChatProvider.type === "cloud";
    const chatModelId = isCloud ? `cloud:${activeChatProvider.provider}:${activeChatProvider.model}` : (activeModelPath || selectedModel);
    const chatModels = [...models, ...cloudProviders.filter(row => row.configured && row.modelId?.trim()).map(row => ({ id: `cloud:${row.id}:${row.modelId}`, name: `${row.name} / ${row.modelId}` }))];
    const palace = useMemoryPalace(chatModelId, !isCloud && engineRunning ? activeModelConfig : null);
	// Chat uses the active engine port reported by main.js.
	const baseUrl = serverPort ? `http\://127.0.0.1:${serverPort}` : null;
	// Apply theme to document
	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
		localStorage.setItem("theme", theme);
	}, [theme]);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		localStorage.setItem("theme", theme);
	}, [theme]);

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
    // Listen for engine status changes from main process. `status` now
	// carries the dynamically bound `port` alongside `running`/`pid` — this
	// is the only place `serverPort` is written, so it always reflects
	// whatever the backend actually bound, not what the launch command
	// happened to ask for.
	useEffect(() => {
		const { terminalAPI, engineAPI, electronAPI } = window;
		if (!terminalAPI) return;
		// Refresh the authoritative port and applied load settings on engine startup.
		let statusVersion = 0;
		let disposed = false;
		const refreshConfig = async (version) => {
			if (!engineAPI) return;
			try {
				const cfg = await engineAPI.getConfig();
				if (disposed || version !== statusVersion) return;
				setActiveModelConfig(cfg?.activeModelConfig ?? null);
				setServerPort(cfg?.port ?? null);
			} catch (err) {
				console.error("Failed to read engine config:", err);
			}
		};
		const applyStatus = ({ running, pid, activeModelConfig: config, contextStatus: status, modelPath, modelName }) => {
			if (disposed) return;
			const version = ++statusVersion;
			setActiveModelConfig(running ? (config ?? null) : null);
			setEngineRunning(running);
            setLoadedLocalModel(running && modelPath ? { modelPath, name: modelName || modelPath } : null);
            setActiveModelName(running ? (modelName ?? null) : null);
            if (running && modelPath) {
                setSelectedModel(modelPath);
                try { localStorage.setItem("lastSelectedModelPath", modelPath); } catch { /* Selection still works without storage. */ }
            }
            setContextStatus(running ? (status || "loading") : "stopped");
			setEnginePid(pid ?? null);
			if (running) {
				setServerError(null);
				refreshConfig(version);
			} else {
				setServerPort(null);
			}
		};
		const cleanupStatus = terminalAPI.onStatus(applyStatus);
		// Initial status check
		const initialVersion = statusVersion;
		Promise.all([terminalAPI.status(), electronAPI?.getEngineStatus()]).then(([status, modelStatus]) => {
            if (statusVersion === initialVersion) applyStatus({ ...status, ...modelStatus });
        }).catch(error => {
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
	return (
		<div className="flex flex-col h-full w-full overflow-hidden rounded-xl bg-[var(--surface)] shadow-[0_8px_32px_var(--window-shadow)] ">
			<Titlebar />
			<Header
                contextStatus={contextStatus}
				isSidebarOpen={isSidebarOpen}
				onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
				isRightSidebarOpen={isRightSidebarOpen}
				onToggleRightSidebar={() => setIsRightSidebarOpen((open) => !open)}
				isCloud={isCloud}
                modelName={isCloud ? `${activeChatProvider.provider} / ${activeChatProvider.model}` : engineRunning ? (activeModelName || activeModelPath || "Loading model...") : (models.find((model) => model.id === selectedModel)?.name || selectedModel)}
				engineRunning={engineRunning}
				onOpenModels={() => setModelSelectorOpen(true)}
				palace={palace}
				onOpenSettings={() => setSettingsOpen(true)}
			/>
			{settingsOpen && (
				<MemorySettings
					palace={palace}
					avatars={avatars}
					models={models}
					theme={theme}
					// onToggleTheme={toggleTheme}
					onChangeTheme={setTheme}
					terminalLog={terminalLog}
					engineRunning={engineRunning}
					serverPort={serverPort}
					serverError={serverError}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{modelSelectorOpen && (
				<ModelSelectorModal
					models={models}
					selectedModel={selectedModel}
                    loadedLocalModel={loadedLocalModel}
                    cloudProviders={cloudProviders}
                    activeChatProvider={activeChatProvider}
                    onSelectProvider={setActiveChatProvider}
					onSelectModel={setSelectedModel}
					scanning={scanning}
					onScan={handleScanClick}
					engineRunning={engineRunning}
					serverError={serverError}
					onLoaded={(result) => {
                        setServerError(result.warning || null);
                        setActiveChatProvider({ type: "local" });
                        if (result.modelPath) {
                            setSelectedModel(result.modelPath);
                            try { localStorage.setItem("lastSelectedModelPath", result.modelPath); } catch { /* Storage is optional. */ }
                        }
                    }}
					onClose={() => setModelSelectorOpen(false)}
				/>
			)}
			{palace.toast && (
				<div
					role="status"
					className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-[var(--surface-raised)] px-4 py-2 text-xs shadow-lg"
				>
					{palace.toast}
				</div>
			)}
            {projectModalOpen && <ProjectModal onClose={() => setProjectModalOpen(false)} onCreate={async fields => {
                const project = await window.api.createProject(fields);
                setProjects(previous => [...previous, project]);
                setProjectModalOpen(false); openProject(project.id);
            }} />}
            <ChatInterface
                view={view}
                projects={projects}
                activeProjectId={activeProjectId}
                onProjects={() => setView('projects')}
                onProject={openProject}
                onCreateProject={() => setProjectModalOpen(true)}
                onChat={() => setView('chat')}
                renderWorkspace={({ groups, loadChat, startProjectChat, busy, canStartChat }) => view === 'projects'
                    ? <ProjectsView projects={projects} loading={projectsLoading} error={projectsError} onRetry={refreshProjects}
                        onCreate={() => setProjectModalOpen(true)} onOpen={openProject}
                        onPin={async project => updateProject(await window.api.setProjectPinned(project.id, !project.is_pinned))} />
                    : view === 'project' ? <ProjectWorkspace key={activeProjectId} projectId={activeProjectId}
                        sessions={groups.flatMap(group => group.sessions)} onBack={() => setView('projects')}
                        onUpdated={updateProject} onLoadChat={loadChat} onStartChat={startProjectChat}
                        chatDisabled={busy} canStartChat={canStartChat} /> : null}

				isRightSidebarOpen={isRightSidebarOpen}
				onCloseRightSidebar={() => setIsRightSidebarOpen(false)}
				models={chatModels}
				onSelectModel={setSelectedModel}
				avatarSettings={avatars.settings}
				isSidebarOpen={isSidebarOpen}
				selectedModel={chatModelId}
                activeChatProvider={activeChatProvider}
				baseUrl={baseUrl}
				engineRunning={engineRunning}
                activeModel={!isCloud && engineRunning && ["warming", "ready", "warmup-failed"].includes(contextStatus)
                    ? { modelPath: activeModelPath, contextSize: activeModelConfig?.contextLength ?? 32768 } : null}
				palace={palace}
			/>
		</div>
	);
}

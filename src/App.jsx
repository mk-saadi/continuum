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
	const [selectedModel, setSelectedModel] = useState("");
	const [activeModelId, setActiveModelId] = useState(null); // informational only — what the server reports as loaded
	const [scanning, setScanning] = useState(false);
	const scanInProgress = useRef(false);
	const [contextStatus, setContextStatus] = useState("stopped");
	const [engineRunning, setEngineRunning] = useState(false);
	const [activeModelConfig, setActiveModelConfig] = useState(null);
	const [enginePid, setEnginePid] = useState(null);
	const [serverPort, setServerPort] = useState(null); // dynamic port reported by main/preload, null until known
	const [serverError, setServerError] = useState(null); // last bridge-level error (spawn/bind failure, etc.)
	const palace = useMemoryPalace(selectedModel || activeModelId, engineRunning ? activeModelConfig : null);
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

	// Poll the server for whatever model it currently reports as active.
	// This is purely informational (e.g. for a future "currently loaded"
	// badge) and must NEVER touch `models` or `selectedModel` — those are
	// driven solely by the disk scan. Overwriting them here was the cause
	// of the dropdown selection flickering/resetting every \~10s.
	const fetchActiveModel = useCallback(async () => {
		const { modelsAPI } = window;
		if (!modelsAPI || !baseUrl) return;
		try {
			const data = await modelsAPI.getActiveModels();
			const list = data.data || [];
			setActiveModelId(list.length > 0 ? list[0].id : null);
		} catch {
			setActiveModelId(null);
		}
	}, [baseUrl]);
	useEffect(() => {
		fetchActiveModel();
		const interval = setInterval(fetchActiveModel, 10000);
		return () => clearInterval(interval);
	}, [fetchActiveModel]);
	// Scan on mount; clicking an empty dropdown also allows a retry.
	const handleScanClick = useCallback(async () => {
		const { modelsAPI } = window;
		if (!modelsAPI || scanInProgress.current) return;
		scanInProgress.current = true;
		setScanning(true);
		try {
			const result = await modelsAPI.scanLocalModels("/media/mk_saadi/e_drive/llm-folder/extra_llms");
			if (result.success) {
				const scannedModels = result.models || [];
				setModels(scannedModels);
				setSelectedModel((prev) =>
					scannedModels.some((model) => model.id === prev) ? prev : scannedModels[0]?.id || "",
				);
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
	// Keep the controlled selection valid if the model list changes.
	useEffect(() => {
		setSelectedModel((current) =>
			models.some((model) => model.id === current) ? current : models[0]?.id || "",
		);
	}, [models]);
	// Listen for engine status changes from main process. `status` now
	// carries the dynamically bound `port` alongside `running`/`pid` — this
	// is the only place `serverPort` is written, so it always reflects
	// whatever the backend actually bound, not what the launch command
	// happened to ask for.
	useEffect(() => {
		const { terminalAPI, engineAPI } = window;
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
		const applyStatus = ({ running, pid, activeModelConfig: config, contextStatus: status }) => {
			if (disposed) return;
			const version = ++statusVersion;
			setActiveModelConfig(running ? (config ?? null) : null);
			setEngineRunning(running);
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
		terminalAPI.status().then((status) => {
			if (statusVersion === initialVersion) applyStatus(status);
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
				modelName={models.find((model) => model.id === selectedModel)?.name || selectedModel}
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
					onSelectModel={setSelectedModel}
					scanning={scanning}
					onScan={handleScanClick}
					engineRunning={engineRunning}
					serverError={serverError}
					onLoaded={(result) => setServerError(result.warning || null)}
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
			<ChatInterface
				isRightSidebarOpen={isRightSidebarOpen}
				onCloseRightSidebar={() => setIsRightSidebarOpen(false)}
				models={models}
				onSelectModel={setSelectedModel}
				avatarSettings={avatars.settings}
				isSidebarOpen={isSidebarOpen}
				selectedModel={selectedModel || activeModelId}
				baseUrl={baseUrl}
				engineRunning={engineRunning}
				palace={palace}
			/>
		</div>
	);
}

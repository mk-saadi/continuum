import AgentModal from "./components/AgentModal";
import ChatTuning from "./components/ChatTuning";
import useAvatarSettings from "./hooks/useAvatarSettings";
import AssistantAvatar from "./components/AssistantAvatar";
import MessageActions from "./components/MessageActions.jsx";
import { optimizeImage } from "./utils/imageUtils.mjs";
import ModelSettingsModal from "./components/ModelSettingsModal.jsx";
import AssistantMessage from "./components/AssistantMessage.jsx";
import ChatHistory from "./components/ChatHistory.jsx";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { runDesktopChat, indexDesktopDocuments } from "./lib/desktopChat.mjs";
import { MemoryPalaceHeader, useMemoryPalace } from "./components/MemoryPalace.jsx";
import { BsMoonStarsFill } from "react-icons/bs";
import { FaBars, FaSun } from "react-icons/fa";

/* ==========================================================================
   Titlebar Component
   ========================================================================== */
function Titlebar() {
	const { windowAPI } = window;

	return (
		<div className="flex h-[38px] min-h-[38px] items-center justify-between rounded-t-xl border-b pl-3.5 pr-2 bg-[var(--surface)]/95 [-webkit-app-region:drag] max-[450px]:h-[30px] max-[450px]:min-h-[30px] border-[var(--border)] ">
			<div className="flex items-center gap-2 text-xs leading-normal font-semibold tracking-[0.3px] text-[var(--text-secondary)] ">
				<span className="inline-block size-2 rounded-full bg-[var(--accent)] " />
				LLM Desktop Assistant
			</div>
			<div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
				<button
					className="flex h-7 w-8 items-center justify-center rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-200 text-[var(--text-secondary)] [&_svg]:size-3.5 [&_svg]:fill-current hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] "
					onClick={() => windowAPI?.minimize()}
					title="Minimize"
				>
					<svg viewBox="0 0 16 16">
						<rect
							x="3"
							y="7"
							width="10"
							height="1.5"
							rx="0.75"
						/>
					</svg>
				</button>
				<button
					className="flex h-7 w-8 items-center justify-center rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-200 text-[var(--text-secondary)] [&_svg]:size-3.5 [&_svg]:fill-current hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] "
					onClick={() => windowAPI?.maximize()}
					title="Maximize / Restore"
				>
					<svg viewBox="0 0 16 16">
						<rect
							x="3"
							y="3"
							width="10"
							height="10"
							rx="1"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
					</svg>
				</button>
				<button
					className="flex h-7 w-8 items-center justify-center rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-200 text-[var(--text-secondary)] [&_svg]:size-3.5 [&_svg]:fill-current hover:bg-[var(--danger-hover)] hover:text-[var(--on-accent)]"
					onClick={() => windowAPI?.close()}
					title="Close"
				>
					<svg viewBox="0 0 16 16">
						<path
							d="M4 4 L12 12 M12 4 L4 12"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
				</button>
			</div>
		</div>
	);
}

/* ==========================================================================
   Header Bar Component (Model Selector + Theme Toggle)
   ========================================================================== */
function HeaderBar({
	theme,
	onToggleTheme,
	models,
	selectedModel,
	onSelectModel,
	scanning,
	onScanClick,
	isSidebarOpen,
	onToggleSidebar,
}) {
	return (
		<div className="flex items-center justify-between gap-2.5 border-b px-3.5 py-2 max-[450px]:gap-1.5 max-[450px]:px-2.5 max-[450px]:py-1 bg-[var(--surface-raised)] border-[var(--border)] ">
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<button
					type="button"
					onClick={onToggleSidebar}
					aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
					aria-expanded={isSidebarOpen}
					aria-controls="chat-sidebar"
					title={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
					className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-[var(--border)] bg-[var(--input)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
				>
					<FaBars aria-hidden="true" />
				</button>
				<div className="relative max-w-[320px] flex-1 after:pointer-events-none after:absolute after:right-2.5 after:top-1/2 after:-translate-y-1/2 after:text-xs leading-normal after:text-[var(--text-muted)] after:content-['▾']">
					<select
						className="w-full appearance-none rounded-md border py-1.5 pl-2.5 pr-[30px] text-[13px] cursor-pointer transition-colors duration-200 max-[450px]:py-[3px] max-[450px]:text-[11px] bg-[var(--input)] border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] "
						value={selectedModel || ""}
						onMouseDown={() => {
							if (models.length === 0) onScanClick();
						}}
						onChange={(e) => onSelectModel(e.target.value)}
					>
						{scanning ? (
							<option value="">Scanning for models...</option>
						) : models.length === 0 ? (
							<option value="">Click to scan for local models</option>
						) : (
							models.map((m) => (
								<option
									key={m.id}
									value={m.id}
								>
									{m.name || m.id}
								</option>
							))
						)}
					</select>
				</div>
				<span className="text-[11px] whitespace-nowrap max-[450px]:hidden text-[var(--text-muted)] ">
					{scanning
						? "Scanning..."
						: models.length > 0
							? `${models.length} model(s)`
							: "No models found"}
				</span>
			</div>
			<div className="flex items-center gap-2">
				<button
					className="flex items-center rounded-md border p-[5px] text-xs leading-normal cursor-pointer transition-all duration-200 hover:border-[var(--accent)] hover:text-[var(--text-primary)] max-[450px]:px-1.5 max-[450px]:py-[3px] max-[450px]:text-[10px] bg-[var(--input)] border-[var(--border)] text-[var(--text-secondary)] "
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					onClick={onToggleTheme}
				>
					<span className="text-sm">{theme === "dark" ? <FaSun /> : <BsMoonStarsFill />}</span>
				</button>
			</div>
		</div>
	);
}

/* ==========================================================================
   Engine Controller Component
   ========================================================================== */
function EngineController({ engineRunning, enginePid, serverPort, selectedModel, models, onEngineError }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const model = models.find((model) => model.id === selectedModel);
	const unload = async () => {
		setBusy(true);
		try {
			const result = await window.terminalAPI.kill();
			if (!result?.success) throw new Error(result?.error || "Could not unload engine.");
		} catch (error) {
			onEngineError(error.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2.5">
			<div className="flex items-center gap-2">
				<button
					onClick={() => setSettingsOpen(true)}
					disabled={!selectedModel}
					className="rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] disabled:opacity-40"
				>
					Configure & Load Model
				</button>
				<button
					onClick={unload}
					disabled={busy || !engineRunning}
					className="rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] disabled:opacity-40"
				>
					Unload
				</button>
			</div>
			<p className="mt-2 text-[11px] text-[var(--text-secondary)]">
				{engineRunning
					? `Engine running (PID: ${enginePid}, Port: ${serverPort})`
					: selectedModel
						? "Configure loading settings before starting the engine."
						: "Scan and select a local model to begin."}
			</p>
			{settingsOpen && model && (
				<ModelSettingsModal
					key={model.id}
					model={model}
					onClose={() => setSettingsOpen(false)}
					onLoaded={(result) => onEngineError(result.warning || null)}
				/>
			)}
		</div>
	);
}

/* ==========================================================================
   Terminal Drawer Component
   ========================================================================== */
function TerminalDrawer() {
	const { terminalAPI } = window;
	const [expanded, setExpanded] = useState(true);
	const [lines, setLines] = useState([]);
	const bodyRef = useRef(null);
	const lineCountRef = useRef(0);

	// Cap stored lines to avoid unbounded memory growth
	const MAX_LINES = 2000;

	useEffect(() => {
		if (!terminalAPI) return;
		const cleanup = terminalAPI.onOutput(({ stream, data }) => {
			setLines((prev) => {
				const next = [...prev, { stream, data }];
				lineCountRef.current = next.length;
				if (next.length > MAX_LINES) {
					return next.slice(next.length - MAX_LINES);
				}
				return next;
			});
		});
		return cleanup;
	}, [terminalAPI]);

	// Surface bridge-level errors (spawn failure, port bind failure, etc.)
	// as a synthetic stderr line so they show up in the same place the user
	// is already looking, without needing a second UI surface.
	useEffect(() => {
		if (!terminalAPI?.onError) return;
		const cleanup = terminalAPI.onError((message) => {
			setLines((prev) => {
				const next = [...prev, { stream: "stderr", data: `[bridge error] ${message}` }];
				lineCountRef.current = next.length;
				if (next.length > MAX_LINES) {
					return next.slice(next.length - MAX_LINES);
				}
				return next;
			});
		});
		return cleanup;
	}, [terminalAPI]);

	// Auto-scroll to bottom on new output
	useEffect(() => {
		if (bodyRef.current && expanded) {
			bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
		}
	}, [lines, expanded]);

	const toggle = () => setExpanded((e) => !e);

	return (
		<div
			className={`overflow-hidden border-b border-[var(--border)] transition-[max-height] duration-300 ease-in-out ${expanded ? "max-h-[200px]" : "max-h-8"}`}
		>
			<div
				className="flex cursor-pointer select-none items-center justify-between px-3.5 py-1.5 hover:bg-[var(--input)] bg-[var(--surface-hover)] "
				onClick={toggle}
			>
				<span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)] ">
					<span
						className={`text-[10px] transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
					>
						▾
					</span>
					Terminal Output
				</span>
				<span className="text-[10px] text-[var(--text-muted)] ">{lines.length} lines</span>
			</div>
			{expanded && (
				<div
					className="h-40 overflow-y-auto px-3.5 py-2 text-[11px] leading-[1.6] select-text bg-[var(--terminal)] text-[var(--terminal-text)] font-['Cascadia_Code','Fira_Code','JetBrains_Mono',monospace] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-[var(--scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-[var(--scrollbar-thumb)] "
					ref={bodyRef}
				>
					{lines.length === 0 ? (
						<div className="whitespace-pre-wrap break-all text-[var(--text-muted)] ">
							No output yet. Load the engine to see logs.
						</div>
					) : (
						lines.map((line, i) => (
							<div
								key={line.id ?? i}
								className={`whitespace-pre-wrap break-all ${line.stream === "stderr" ? "text-[var(--error)] " : ""}`}
							>
								{line.data}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}

/* ==========================================================================
   Chat Interface Component
   ========================================================================== */
function SelectedFilePreview({ file, onRemove, disabled }) {
	const [previewUrl, setPreviewUrl] = useState(null);
	useEffect(() => {
		if (file.dataUrl) {
			setPreviewUrl(file.dataUrl);
			return;
		}
		if (!/\.(png|jpe?g|gif|webp)$/i.test(file.name)) return;
		const url = URL.createObjectURL(file);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file]);
	return (
		<div className="relative flex w-28 shrink-0 flex-col gap-1 rounded-md border border-[var(--border)] p-2 ">
			{previewUrl ? (
				<img
					src={previewUrl}
					alt={file.name}
					className="h-16 w-full rounded object-contain"
				/>
			) : (
				<span className="flex h-16 items-center justify-center text-xs">Text file</span>
			)}
			<span
				title={file.name}
				className="truncate text-[11px]"
			>
				{file.name}
			</span>
			<button
				type="button"
				aria-label={`Remove ${file.name}`}
				disabled={disabled}
				onClick={onRemove}
				className="absolute right-1 top-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-[var(--input)] text-[var(--text-primary)] shadow disabled:opacity-50"
			>
				×
			</button>
		</div>
	);
}

function ChatInterface({
	selectedModel,
	baseUrl,
	engineRunning,
	palace,
	isSidebarOpen,
	avatarSettings,
	models,
	onSelectModel,
}) {
	const [messages, setMessages] = useState([]);
	const [input, setInput] = useState("");
	const [selectedFiles, setSelectedFiles] = useState([]);
	const [indexing, setIndexing] = useState(null);
	const fileInputRef = useRef(null);
	const uploadCache = useRef(new Map());
	const clearFiles = useCallback(() => {
		setSelectedFiles([]);
		uploadCache.current.clear();
	}, []);
	const [streaming, setStreaming] = useState(false);
	const [groups, setGroups] = useState([]);
	const [historyError, setHistoryError] = useState("");
	const [loading, setLoading] = useState(false);
	const [editing, setEditing] = useState(null);
	const [editText, setEditText] = useState("");
	const busyRef = useRef(false);
	const refreshHistory = useCallback(async () => {
		if (palace.api) setGroups(await palace.api.getAllSessions());
	}, [palace.api]);
	useEffect(() => {
		refreshHistory().catch((err) => setHistoryError(err.message));
	}, [refreshHistory]);
	const newChat = () => {
		if (busyRef.current) return;
		palace.setSessionId(crypto.randomUUID());
		setMessages([]);
		setInput("");
		clearFiles();
		setEditing(null);
		palace.setDraftTokens(0);
	};
	const loadChat = async (id) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setLoading(true);
		setHistoryError("");
		try {
			const session = await palace.api.loadSession(id);
			palace.setSessionId(id);
			setMessages(session.messages);
			setInput("");
			clearFiles();
			setEditing(null);
			palace.setDraftTokens(0);
		} catch (err) {
			setHistoryError(err.message);
		} finally {
			busyRef.current = false;
			setLoading(false);
		}
	};
	const handleMessageAction = async (kind, messageId) => {
		if (busyRef.current || !palace.api) return;
		busyRef.current = true;
		setLoading(true);
		setHistoryError("");
		try {
			if (kind === "delete") {
				const retained = await palace.api.deleteMessage(palace.sessionId, messageId);
				setMessages(retained);
				if (editing === messageId) setEditing(null);
				await palace.refresh();
			} else {
				const { sessionId } = await palace.api.branchChat(palace.sessionId, messageId);
				const session = await palace.api.loadSession(sessionId);
				palace.setSessionId(sessionId);
				setMessages(session.messages);
				setInput("");
				clearFiles();
				setEditing(null);
				palace.setDraftTokens(0);
			}
			await refreshHistory();
		} catch (error) {
			setHistoryError(error.message);
		} finally {
			busyRef.current = false;
			setLoading(false);
		}
	};

	const [agents, setAgents] = useState([]);
	const [agentModalOpen, setAgentModalOpen] = useState(false);
	const [sessionAgent, setSessionAgent] = useState(null);
	const [agentLoading, setAgentLoading] = useState(true);
	const [tuningVersion, setTuningVersion] = useState(0);
	const refreshAgents = useCallback(async () => {
		if (window.api?.listAgents) setAgents(await window.api.listAgents());
	}, []);
	useEffect(() => {
		refreshAgents().catch((error) => setHistoryError(error.message));
	}, [refreshAgents]);
	useEffect(() => {
		let active = true;
		setAgentLoading(true);
		setSessionAgent(null);
		(async () => {
			try {
				const profile = await window.api?.getSessionAgent(palace.sessionId);
				if (active) setSessionAgent(profile || null);
			} catch (error) {
				if (active) setHistoryError(error.message);
			} finally {
				if (active) setAgentLoading(false);
			}
		})();
		return () => {
			active = false;
		};
	}, [palace.sessionId]);
	const selectAgent = async (agentId) => {
		if (busyRef.current || agentLoading) return;
		busyRef.current = true;
		setLoading(true);
		setHistoryError("");
		try {
			const preset = agents.find((agent) => agent.id === agentId);
			if (preset?.model_id && !models.some((model) => model.id === preset.model_id)) {
				throw new Error(
					"This agent’s default model is not scanned. Scan it or edit the agent’s model first.",
				);
			}
			const result = await window.api.applyAgent(palace.sessionId, agentId || null, selectedModel);
			setSessionAgent(result.agent);
			if (result.agent?.model_id) onSelectModel(result.agent.model_id);
			setTuningVersion((version) => version + 1);
			await refreshHistory();
		} catch (error) {
			setHistoryError(error.message);
		} finally {
			busyRef.current = false;
			setLoading(false);
		}
	};

	const messagesRef = useRef(null);
	const abortRef = useRef(null);
	useEffect(() => () => abortRef.current?.abort(), []);
	useEffect(() => {
		if (!input && !streaming) return;
		const timer = setTimeout(palace.schedule, 250);
		return () => clearTimeout(timer);
	}, [input, messages, streaming, palace.schedule]);

	// Auto-scroll to bottom
	useEffect(() => {
		if (messagesRef.current) {
			messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
		}
	}, [messages]);

	const addAttachments = async (files) => {
		if (busyRef.current) return;
		const next = [...selectedFiles, ...files];
		if (
			next.length > 10 ||
			next.some((file) => file.size > 20 * 1024 * 1024) ||
			next.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024
		) {
			setHistoryError("Choose up to 10 files, at most 20 MB each and 50 MB total.");
			return;
		}
		if (files.some((file) => !/\.(png|jpe?g|gif|webp|pdf|txt|md|csv)$/i.test(file.name))) {
			setHistoryError("Supported attachments: PNG, JPEG, GIF, WebP, PDF, TXT, Markdown, and CSV.");
			return;
		}
		setHistoryError("");
		busyRef.current = true;
		setLoading(true);
		const controller = new AbortController();
		abortRef.current = controller;
		try {
			const optimized = [];
			// Decode sequentially to avoid holding several large bitmaps at once.
			for (const file of files) {
				if (!/\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
					optimized.push(file);
					continue;
				}
				const dataUrl = await optimizeImage(file);
				const base64 = dataUrl.split(",")[1];
				optimized.push({
					name: file.name.replace(/\.[^.]+$/, ".jpg"),
					type: "image/jpeg",
					dataUrl,
					lastModified: file.lastModified,
					size:
						(base64.length * 3) / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0),
				});
			}
			const documents = optimized.filter((file) => /\.(pdf|txt|md|csv)$/i.test(file.name));
			if (documents.length) {
				const uploaded = await window.api.processUploads(documents);
				await indexDesktopDocuments(uploaded, { signal: controller.signal, onProgress: setIndexing });
				documents.forEach((file, index) => uploadCache.current.set(file, uploaded[index]));
			}
			controller.signal.throwIfAborted();
			setSelectedFiles((current) => [...current, ...optimized]);
		} catch (error) {
			if (error.name !== "AbortError") setHistoryError(error.message);
		} finally {
			busyRef.current = false;
			setLoading(false);
			setIndexing(null);
			abortRef.current = null;
		}
	};

	const sendMessage = useCallback(
		async (edit = null) => {
			const text = edit ? editText.trim() : input.trim();
			if ((!text && (edit || !selectedFiles.length)) || busyRef.current || !baseUrl || !selectedModel)
				return;
			busyRef.current = true;
			setHistoryError("");

			const assistantMsg = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true };

			setStreaming(true);

			const controller = new AbortController();
			abortRef.current = controller;
			let assistantText = "";
			let assistantStats = null;
			let assistantTools = [];
			let assistantThinking = null;
			let prepared = false;

			try {
				if (edit) {
					const retained = await palace.api.editMessage(edit.id, text);
					setMessages([...retained, assistantMsg]);
					setEditing(null);
				}
				let attachments = [];
				if (!edit && selectedFiles.length) {
					if (!window.api?.processUploads)
						throw new Error("File uploads are available in the desktop app.");
					const pending = selectedFiles.filter((file) => !uploadCache.current.has(file));
					if (pending.length) {
						const uploaded = await window.api.processUploads(pending);
						pending.forEach((file, index) => uploadCache.current.set(file, uploaded[index]));
					}
					attachments = selectedFiles.map((file) => uploadCache.current.get(file));
				}
				controller.signal.throwIfAborted();
				const requestMessages = await palace.prepareMessages(text, !!edit, attachments);
				prepared = true;
				if (!edit) {
					setInput("");
					clearFiles();
				}
				const saved = await palace.api.loadSession(palace.sessionId);
				setMessages([...saved.messages, assistantMsg]);
				await refreshHistory();
				await runDesktopChat({
					sessionId: palace.sessionId,
					onIndexing: setIndexing,
					modelId: selectedModel,
					messages: requestMessages,
					onTool: ({ requestId, type, ...tool }) => {
						const index = assistantTools.findIndex((call) => call.id === tool.id);
						if (index < 0) assistantTools.push(tool);
						else assistantTools[index] = tool;
						const toolCalls = [...assistantTools];
						setMessages((prev) =>
							prev.map((message) =>
								message.id === assistantMsg.id ? { ...message, toolCalls } : message,
							),
						);
					},
					onThinking: (thinking) => {
						assistantThinking = thinking;
						setMessages((prev) =>
							prev.map((message) =>
								message.id === assistantMsg.id
									? {
											...message,
											thinkingText: thinking.text,
											thinkingDuration: thinking.duration,
										}
									: message,
							),
						);
					},
					signal: controller.signal,
					onStats: (stats) => {
						assistantStats = stats;
						setMessages((prev) =>
							prev.map((message) =>
								message.id === assistantMsg.id ? { ...message, stats } : message,
							),
						);
					},
					onText: (delta) => {
						assistantText += delta;
						palace.setDraftTokens(Math.ceil(assistantText.length / 4));
						setMessages((prev) => {
							const next = [...prev];
							next[next.length - 1] = { ...next[next.length - 1], content: assistantText };
							return next;
						});
					},
				});
			} catch (err) {
				if (err.name !== "AbortError") {
					setHistoryError(err.message);
					assistantText += `${assistantText ? "\n\n" : ""}⚠ Error: ${err.message}`;
					if (prepared)
						setMessages((prev) => {
							const next = [...prev];
							const last = next[next.length - 1];
							next[next.length - 1] = {
								...last,
								content: assistantText,
								streaming: false,
							};
							return next;
						});
				}
			} finally {
				if (prepared) {
					assistantTools = assistantTools.map((call) =>
						call.status === "pending"
							? { ...call, status: controller.signal.aborted ? "cancelled" : "error" }
							: call,
					);
					// Publish the completed reply before awaiting persistence. Stats belong
					// to this request, so they do not depend on a React state update flushing.
					setMessages((prev) =>
						prev.map((message) =>
							message.id === assistantMsg.id
								? {
										...message,
										stats: assistantStats,
										toolCalls: assistantTools,
										thinkingText: assistantThinking?.text ?? null,
										thinkingDuration: assistantThinking?.duration ?? null,
										streaming: false,
									}
								: message,
						),
					);
					try {
						const saved = await palace.finishMessage(
							assistantText,
							assistantStats,
							assistantTools,
							assistantThinking,
						);
						if (saved)
							setMessages((prev) =>
								prev.map((message) =>
									message.id === assistantMsg.id ? { ...saved, streaming: false } : message,
								),
							);
					} catch (error) {
						setMessages((prev) => [
							...prev,
							{ role: "system", content: `Could not save reply: ${error.message}` },
						]);
					}
				} else {
					palace.setDraftTokens(0);
				}
				setMessages((prev) =>
					prev.map((message) => (message.streaming ? { ...message, streaming: false } : message)),
				);
				await refreshHistory().catch((err) => setHistoryError(err.message));
				setStreaming(false);
				setIndexing(null);
				busyRef.current = false;
				abortRef.current = null;
			}
		},
		[input, editText, selectedFiles, clearFiles, selectedModel, baseUrl, palace, refreshHistory],
	);

	const handleKeyDown = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	};

	const handleStop = () => {
		if (abortRef.current) {
			abortRef.current.abort();
		}
	};

	const canSend =
		(!!input.trim() || selectedFiles.length > 0) && !!baseUrl && !!selectedModel && !!palace.api;

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			<div
				id="chat-sidebar"
				aria-hidden={!isSidebarOpen}
				inert={isSidebarOpen ? undefined : ""}
				className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none [&>aside]:h-full ${isSidebarOpen ? "w-[220px] translate-x-0 opacity-100 max-[650px]:w-[150px]" : "w-0 -translate-x-full opacity-0"}`}
			>
				<ChatHistory
					groups={groups}
					activeId={palace.sessionId}
					disabled={streaming || loading}
					onLoad={loadChat}
					onNew={newChat}
					onAction={async (kind, id, value) => {
						if (busyRef.current) throw new Error("Wait for the current operation to finish.");
						busyRef.current = true;
						setLoading(true);
						try {
							if (kind === "Rename") await palace.api.renameSession(id, value);
							else if (kind === "Move to Folder") await palace.api.moveSession(id, value);
							else {
								await palace.api.deleteSession(id);
								if (id === palace.sessionId) {
									palace.setSessionId(crypto.randomUUID());
									setMessages([]);
									setInput("");
									clearFiles();
									setEditing(null);
									palace.setDraftTokens(0);
								}
							}
							await refreshHistory();
						} finally {
							busyRef.current = false;
							setLoading(false);
						}
					}}
				/>
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none">
				<div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1">
					<label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
						Agent
						<select
							aria-label="Agent preset"
							className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--input)] p-1"
							value={sessionAgent?.id || ""}
							disabled={streaming || loading || agentLoading || !window.api?.applyAgent}
							onChange={(event) => selectAgent(event.target.value)}
						>
							<option value="">Default assistant</option>
							{sessionAgent && !agents.some((agent) => agent.id === sessionAgent.id) && (
								<option value={sessionAgent.id}>{sessionAgent.name} (saved profile)</option>
							)}
							{agents.map((agent) => (
								<option
									key={agent.id}
									value={agent.id}
								>
									{agent.name}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="rounded px-2 py-1 text-xs hover:bg-[var(--surface-hover)]"
						disabled={streaming || loading}
						onClick={() => setAgentModalOpen(true)}
					>
						Manage agents
					</button>
					{sessionAgent && (
						<button
							type="button"
							className="text-xs"
							disabled={
								streaming ||
								loading ||
								agentLoading ||
								!agents.some((agent) => agent.id === sessionAgent.id)
							}
							onClick={() => selectAgent(sessionAgent.id)}
						>
							Reapply
						</button>
					)}
				</div>
				{sessionAgent?.model_id && (
					<p className="px-3 text-[10px] text-[var(--text-muted)]">
						Agent model selected. Use Configure &amp; Load Model to load it before chatting.
					</p>
				)}
				{agentModalOpen && (
					<AgentModal
						agents={agents}
						models={models}
						onChanged={refreshAgents}
						onClose={() => setAgentModalOpen(false)}
					/>
				)}
				<ChatTuning
					key={`${palace.sessionId}:${tuningVersion}`}
					sessionId={palace.sessionId}
					modelId={selectedModel}
				/>
				{historyError && (
					<p
						role="alert"
						className="p-2 text-[var(--error-soft)]"
					>
						{historyError}
					</p>
				)}
				<div
					className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3.5 max-[450px]:px-2.5 max-[450px]:py-2 max-[450px]:gap-[7px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-[var(--scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-[var(--scrollbar-thumb)] "
					ref={messagesRef}
				>
					{messages.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 max-[450px]:gap-1 max-[450px]:text-center text-[var(--text-muted)]">
							<span className="text-[40px] opacity-40 max-[450px]:text-xl">🤖</span>
							<span className="text-[13px] max-[450px]:text-[11px]">
								{baseUrl
									? "Load the engine and start chatting"
									: "Waiting for engine to report an active port..."}
							</span>
						</div>
					) : (
						messages.map((msg, i) => {
							const isEditing = editing === msg.id && msg.id;

							return (
								<div
									key={msg.id ?? i}
									className={`group flex max-w-[85%] flex-col transition-[opacity,transform] duration-200 starting:opacity-0 starting:translate-y-1 motion-reduce:transition-none max-[550px]:max-w-[95%] ${
										msg.role === "user" ? "self-end items-end" : "self-start items-start"
									}`}
								>
									{/* Avatar / Name Header */}
									<span className="mb-[3px] flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-muted)]">
										{msg.role === "assistant" && (
											<AssistantAvatar
												sessionAvatarUrl={sessionAgent?.avatar_url}
												settings={avatarSettings}
												modelId={msg.modelId || selectedModel}
											/>
										)}
										{msg.role === "user" ? "" : sessionAgent?.name || "Assistant"}
									</span>

									{/* EDITING STATE */}
									{isEditing ? (
										<div className="flex w-full flex-col gap-2.5">
											<form
												className="flex flex-col gap-2"
												onSubmit={(event) => {
													event.preventDefault();
													sendMessage(msg);
												}}
											>
												<textarea
													className="max-h-[300px] min-h-[150px] w-full! rounded-xl border border-[var(--accent)] bg-[var(--surface-raised)] p-3 text-[12px] leading-[1.6] text-[var(--text-primary)] outline-none shadow-[0_0_12px_rgba(var(--accent-rgb),0.15)] focus:border-[var(--accent)] resize-y select-text"
													aria-label="Edit message"
													autoFocus
													value={editText}
													disabled={streaming || loading}
													onChange={(event) => setEditText(event.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
															e.preventDefault();
															if (editText.trim() && baseUrl && selectedModel) {
																sendMessage(msg);
															}
														} else if (e.key === "Escape") {
															setEditing(null);
														}
													}}
												/>

												{/* Attachments Tray during edit mode */}
												{msg.attachments?.length > 0 && (
													<ul
														aria-label="Message attachments"
														className="flex flex-wrap gap-1.5 whitespace-normal"
													>
														{msg.attachments.map((attachment) => (
															<li
																key={attachment.id || attachment.file_path}
																className="max-w-full truncate rounded-md border border-[var(--attachment-border)] bg-[var(--surface-muted)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
															>
																{attachment.mime_type.startsWith("image/")
																	? "Image: "
																	: "File: "}
																{attachment.file_path
																	.split(/[\\/]/)
																	.pop()
																	.replace(/^\d+-[0-9a-f-]{36}-/i, "")}
															</li>
														))}
													</ul>
												)}

												{/* Save / Discard Actions Outside Main Box */}
												<div className="flex items-center justify-end gap-2 mt-1">
													<button
														type="button"
														className="cursor-pointer rounded-lg px-3 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
														disabled={streaming || loading}
														onClick={() => setEditing(null)}
													>
														Discard (Esc)
													</button>
													<button
														type="submit"
														className="cursor-pointer rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[11px] font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
														disabled={
															streaming ||
															loading ||
															!editText.trim() ||
															!baseUrl ||
															!selectedModel
														}
													>
														Save (Ctrl + Enter)
													</button>
												</div>
											</form>
										</div>
									) : (
										/* NORMAL DISPLAY STATE */
										<>
											<div
												className={`min-w-0 max-w-full rounded-[10px] px-[13px] py-[9px] text-[11px] leading-[1.55] [overflow-wrap:break-word] whitespace-pre-wrap select-text text-[var(--text-primary)] ${
													msg.role === "user"
														? "bg-[var(--user-bubble)] rounded-br-[3px]"
														: "bg-[var(--surface-raised)] rounded-bl-[3px]"
												} ${
													msg.streaming
														? "after:content-['▊'] after:animate-pulse after:[animation-duration:1s] after:text-[var(--accent)] motion-reduce:after:animate-none"
														: ""
												}`}
											>
												{msg.role === "assistant" ? (
													<AssistantMessage message={msg} />
												) : (
													msg.content ||
													(msg.streaming || msg.attachments?.length ? "" : "...")
												)}

												{/* Attachments inside bubble during view mode */}
												{msg.attachments?.length > 0 && (
													<ul
														aria-label="Message attachments"
														className="mt-2 flex flex-wrap gap-1 whitespace-normal"
													>
														{msg.attachments.map((attachment) => (
															<li
																key={attachment.id || attachment.file_path}
																className="max-w-full truncate rounded border border-[var(--attachment-border)] px-2 py-1 text-[11px]"
															>
																{attachment.mime_type.startsWith("image/")
																	? "Image: "
																	: "File: "}
																{attachment.file_path
																	.split(/[\\/]/)
																	.pop()
																	.replace(/^\d+-[0-9a-f-]{36}-/i, "")}
															</li>
														))}
													</ul>
												)}
											</div>

											{/* Actions toolbar */}
											{["user", "assistant"].includes(msg.role) && (
												<MessageActions
													message={msg}
													disabled={streaming || loading || !palace.api}
													onDelete={(id) => handleMessageAction("delete", id)}
													onBranch={(id) => handleMessageAction("branch", id)}
													onEdit={(messageToEdit) => {
														setEditing(messageToEdit.id);
														setEditText(messageToEdit.content);
													}}
													onError={setHistoryError}
												/>
											)}
										</>
									)}
								</div>
							);
						})
					)}
				</div>
				{selectedFiles.length > 0 && (
					<div
						aria-label="Selected attachments"
						className="flex max-h-36 shrink-0 gap-2 overflow-auto border-t border-[var(--border)] px-3.5 py-2 "
					>
						{selectedFiles.map((file, index) => (
							<SelectedFilePreview
								key={`${file.name}-${file.lastModified}-${index}`}
								file={file}
								disabled={streaming || loading}
								onRemove={() => {
									uploadCache.current.delete(file);
									setSelectedFiles((files) => files.filter((_, i) => i !== index));
								}}
							/>
						))}
					</div>
				)}
				{indexing && (
					<div
						role="status"
						className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-xs"
					>
						<span>
							{indexing.stage} {indexing.fileName}{" "}
							{indexing.total > 0 ? `(${indexing.completed}/${indexing.total} chunks)` : "…"}
						</span>
						<button
							type="button"
							className="rounded border border-[var(--border)] px-2 py-1"
							onClick={handleStop}
						>
							Cancel
						</button>
					</div>
				)}
				<div
					onDragOver={(event) => {
						event.preventDefault();
						event.dataTransfer.dropEffect = loading || streaming ? "none" : "copy";
					}}
					onDrop={(event) => {
						event.preventDefault();
						if (!busyRef.current) addAttachments(Array.from(event.dataTransfer.files));
					}}
					className="flex items-end gap-2 rounded-b-xl border-t px-3.5 py-2.5 max-[450px]:px-2.5 max-[450px]:py-[7px] bg-[var(--surface-raised)] border-[var(--border)] "
				>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv"
						className="hidden"
						aria-label="Choose attachments"
						disabled={streaming || loading}
						onChange={(event) => {
							const files = Array.from(event.target.files || []);
							event.target.value = "";
							addAttachments(files);
						}}
					/>
					<button
						type="button"
						aria-label="Attach files"
						title="Attach images, PDF, TXT, Markdown, or CSV"
						disabled={streaming || loading || !window.api?.processUploads}
						onClick={() => fileInputRef.current?.click()}
						className="flex size-[38px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						<svg
							viewBox="0 0 24 24"
							className="size-5 fill-none stroke-current"
							strokeWidth="1.7"
							aria-hidden="true"
						>
							<path d="M8 12.5 14.5 6a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1L12 2.7" />
							<path d="m8 12.5 6-6" />
						</svg>
					</button>
					<textarea
						className="min-h-[38px] max-h-[120px] min-w-0 flex-1 resize-none rounded-md border px-3 py-[9px] text-[11px] leading-[1.4] transition-colors duration-200 placeholder:text-[var(--text-muted)] max-[450px]:text-xs leading-normal bg-[var(--input)] border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] "
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							palace.setDraftTokens(Math.ceil(e.target.value.length / 4));
						}}
						disabled={streaming || loading}
						onKeyDown={handleKeyDown}
						placeholder="Type a message..."
						rows={1}
					/>
					{streaming ? (
						<button
							className="flex size-[38px] shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed [&_svg]:size-4 [&_svg]:fill-current bg-[var(--accent)] hover:bg-[var(--accent-hover)] "
							onClick={handleStop}
							title="Stop"
						>
							<svg viewBox="0 0 16 16">
								<rect
									x="4"
									y="4"
									width="8"
									height="8"
									rx="1"
								/>
							</svg>
						</button>
					) : (
						<button
							className="flex size-[38px] shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed [&_svg]:size-4 [&_svg]:fill-current bg-[var(--accent)] hover:bg-[var(--accent-hover)] "
							onClick={() => sendMessage()}
							disabled={!canSend || loading}
							title={baseUrl ? "Send" : "No active engine port yet"}
						>
							<svg viewBox="0 0 16 16">
								<path d="M2 8 L14 2 L8 8 L14 14 Z" />
							</svg>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

/* ==========================================================================
   Main App Component
   ========================================================================== */
export default function App() {
	const avatars = useAvatarSettings();
	const [isSidebarOpen, setIsSidebarOpen] = useState(() => localStorage.getItem("sidebarOpen") === "true");

	useEffect(() => {
		localStorage.setItem("sidebarOpen", String(isSidebarOpen));
	}, [isSidebarOpen]);

	const [theme, setTheme] = useState("dark");
	const [models, setModels] = useState([]);
	const [selectedModel, setSelectedModel] = useState("");
	const [activeModelId, setActiveModelId] = useState(null); // informational only — what the server reports as loaded
	const [scanning, setScanning] = useState(false);
	const scanInProgress = useRef(false);
	const [engineRunning, setEngineRunning] = useState(false);
	const [activeModelConfig, setActiveModelConfig] = useState(null);
	const [enginePid, setEnginePid] = useState(null);
	const [serverPort, setServerPort] = useState(null); // dynamic port reported by main/preload, null until known
	const [serverError, setServerError] = useState(null); // last bridge-level error (spawn/bind failure, etc.)
	const palace = useMemoryPalace(selectedModel || activeModelId, engineRunning ? activeModelConfig : null);

	// Chat uses the active engine port reported by main.js.
	const baseUrl = serverPort ? `http://127.0.0.1:${serverPort}` : null;

	// Apply theme to document
	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);

	const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

	// Poll the server for whatever model it currently reports as active.
	// This is purely informational (e.g. for a future "currently loaded"
	// badge) and must NEVER touch `models` or `selectedModel` — those are
	// driven solely by the disk scan. Overwriting them here was the cause
	// of the dropdown selection flickering/resetting every ~10s.
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

		const applyStatus = ({ running, pid, activeModelConfig: config }) => {
			if (disposed) return;
			const version = ++statusVersion;
			setActiveModelConfig(running ? (config ?? null) : null);
			setEngineRunning(running);
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
			<MemoryPalaceHeader
				avatars={avatars}
				models={models}
				palace={palace}
				pluginTokens={palace.pluginTokens}
			/>
			<HeaderBar
				isSidebarOpen={isSidebarOpen}
				onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
				theme={theme}
				onToggleTheme={toggleTheme}
				models={models}
				selectedModel={selectedModel}
				onSelectModel={setSelectedModel}
				scanning={scanning}
				onScanClick={handleScanClick}
			/>
			<details className="max-h-[45vh] shrink-0 overflow-auto border-b border-[var(--border)] ">
				<summary className="cursor-pointer px-3 py-[3px] text-[11px] text-[var(--text-secondary)] ">
					Engine & terminal
				</summary>
				<EngineController
					engineRunning={engineRunning}
					enginePid={enginePid}
					serverPort={serverPort}
					selectedModel={selectedModel}
					models={models}
					onEngineError={setServerError}
				/>
				{serverError && (
					<div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--error-strong)]">
						⚠ {serverError}
					</div>
				)}
				<TerminalDrawer />
			</details>
			<ChatInterface
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

import AgentModal from "./components/AgentModal";
import Header from "./components/Header";
import RightSidebar from "./components/RightSidebar";
import MemorySettings from "./components/MemorySettings";
import ModelSelectorModal from "./components/ModelSelectorModal";
import { useTerminalLog } from "./components/TerminalLog";
import useAvatarSettings from "./hooks/useAvatarSettings";
import AssistantAvatar from "./components/AssistantAvatar";
import MessageActions from "./components/MessageActions.jsx";
import { optimizeImage } from "./utils/imageUtils.mjs";
import { assistantLabel, formatModelName } from "./lib/messageIdentity.mjs";
import AssistantMessage from "./components/AssistantMessage.jsx";
import ChatHistory from "./components/ChatHistory.jsx";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { runDesktopChat, indexDesktopDocuments } from "./lib/desktopChat.mjs";
import { useMemoryPalace } from "./components/MemoryPalace.jsx";
import { RxPanelBottomMinimized } from "react-icons/rx";
import { IoClose, IoSend } from "react-icons/io5";
import { MdMinimize } from "react-icons/md";
import { GrAttachment } from "react-icons/gr";
import { FaStop } from "react-icons/fa";
/** ==========================================================================*
 *   Titlebar Component*
 *   ========================================================================== **/
function Titlebar() {
	const { windowAPI } = window;
	return (
		<div className="flex h-[28px] min-h-[28px] items-center justify-between rounded-t-xl border-b pl-3.5 pr-2 bg-[var(--surface)]/95 [-webkit-app-region:drag] max-[450px]:h-[30px] max-[450px]:min-h-[30px] border-[var(--border)] ">
			<div className="flex items-center gap-2 text-xs leading-normal font-semibold tracking-[0.3px] text-[var(--text-secondary)] ">
				<span className="inline-block size-2 rounded-full bg-[var(--accent)] " />
				LLM Desktop Assistant
			</div>
			<div className="flex items-center gap-3.5 [-webkit-app-region:no-drag]">
				<button
					className="flex items-center justify-center h-4 w-4 rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-200 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
					onClick={() => windowAPI?.minimize()}
					title="Minimize"
				>
					<MdMinimize size={18} />
				</button>
				<button
					className="flex items-center justify-center h-4 w-4 rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-200 text-[var(--text-secondary)] hover:text-[var(--text-primary)] "
					onClick={() => windowAPI?.maximize()}
					title="Maximize / Restore"
				>
					<RxPanelBottomMinimized />
				</button>
				<button
					className="flex items-center justify-center h-4 w-4 rounded-md border-0 bg-transparent text-sm leading-normal cursor-pointer transition-colors duration-200 text-[var(--text-secondary)] hover:text-[var(--on-accent)]"
					onClick={() => windowAPI?.close()}
					title="Close"
				>
					<IoClose />
				</button>
			</div>
		</div>
	);
}

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
					className="h-14 w-full rounded object-contain"
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
	isRightSidebarOpen,
	onCloseRightSidebar,
	models,
	onSelectModel,
}) {
	const activeModelName = formatModelName(
		models.find((model) => model.id === selectedModel)?.name || selectedModel,
	);
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
	const textareaRef = useRef(null);

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
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 350) + "px";
	}, [input]);
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
	const savePrompt = async (prompt) => {
		if (busyRef.current) return false;
		busyRef.current = true;
		setLoading(true);
		setHistoryError("");
		try {
			const profile = await window.api.saveSessionPrompt(palace.sessionId, prompt, selectedModel);
			setSessionAgent(profile);
			await refreshHistory();
			return true;
		} catch (error) {
			setHistoryError(error.message);
			return false;
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
			const identity = {
				modelName: activeModelName || selectedModel,
				modelId: selectedModel,
				agentName: sessionAgent?.name || null,
			};
			const assistantMsg = {
				id: crypto.randomUUID(),
				role: "assistant",
				content: "",
				streaming: true,
				...identity,
			};
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
							identity,
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
		[
			input,
			editText,
			selectedFiles,
			clearFiles,
			selectedModel,
			activeModelName,
			sessionAgent,
			baseUrl,
			palace,
			refreshHistory,
		],
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
		<div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
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
			<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none">
				{agentModalOpen && (
					<AgentModal
						agents={agents}
						models={models}
						onChanged={refreshAgents}
						onClose={() => setAgentModalOpen(false)}
					/>
				)}
				{historyError && (
					<p
						role="alert"
						className="p-2 text-[var(--error-soft)]"
					>
						{historyError}
					</p>
				)}
				<div
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 max-[450px]:px-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-[var(--scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-[var(--scrollbar-thumb)]"
					ref={messagesRef}
				>
					<div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col gap-7">
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
										className={`group flex min-w-0 flex-col transition-[opacity,transform] duration-200 starting:opacity-0 starting:translate-y-1 motion-reduce:transition-none ${
											msg.role === "user"
												? "max-w-[85%] self-end items-end"
												: "w-full self-start items-start"
										}`}
									>
										{/** Avatar / Name Header **/}
										{msg.role === "assistant" && (
											<span className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
												<AssistantAvatar
													sessionAvatarUrl={sessionAgent?.avatar_url}
													settings={avatarSettings}
													modelId={msg.modelId || selectedModel}
												/>
												{assistantLabel(msg, activeModelName, sessionAgent)}
											</span>
										)}
										{/** EDITING STATE **/}
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
														className="max-h-[300px] min-h-[150px] w-full! resize-y rounded-xl border border-[var(--accent)] bg-[var(--surface-raised)] p-3 text-sm leading-relaxed text-[var(--text-primary)] outline-none select-text"
														aria-label="Edit message"
														autoFocus
														value={editText}
														disabled={streaming || loading}
														onChange={(event) => setEditText(event.target.value)}
														onKeyDown={(e) => {
															if (
																e.key === "Enter" &&
																(e.ctrlKey || e.metaKey)
															) {
																e.preventDefault();
																if (
																	editText.trim() &&
																	baseUrl &&
																	selectedModel
																) {
																	sendMessage(msg);
																}
															} else if (e.key === "Escape") {
																setEditing(null);
															}
														}}
													/>
													{/** Attachments Tray during edit mode **/}
													{msg.attachments?.length > 0 && (
														<ul
															aria-label="Message attachments"
															className="flex flex-wrap gap-1.5 whitespace-normal"
														>
															{msg.attachments.map((attachment) => (
																<li
																	key={
																		attachment.id || attachment.file_path
																	}
																	className="max-w-full truncate rounded-md border border-[var(--attachment-border)] bg-[var(--surface-raised)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
																>
																	{attachment.mime_type.startsWith("image/")
																		? "Image: "
																		: "File: "}
																	{attachment.file_path
																		.split(/[\\\\/]/)
																		.pop()
																		.replace(/^\d+-[0-9a-f-]{36}-/i, "")}
																</li>
															))}
														</ul>
													)}
													{/** Save / Discard Actions Outside Main Box **/}
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
											/** NORMAL DISPLAY STATE **/
											<>
												<div
													className={`min-w-0 max-w-full select-text text-[var(--text-primary)] ${
														msg.role === "user"
															? "rounded-2xl rounded-br-md bg-[var(--user-bubble)] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
															: "w-full text-sm leading-[1.7] [overflow-wrap:anywhere]"
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
														(msg.streaming || msg.attachments?.length
															? ""
															: "...")
													)}
													{/** Attachments inside bubble during view mode **/}
													{msg.attachments?.length > 0 && (
														<ul
															aria-label="Message attachments"
															className="mt-2 flex flex-wrap gap-1 whitespace-normal"
														>
															{msg.attachments.map((attachment) => (
																<li
																	key={
																		attachment.id || attachment.file_path
																	}
																	className="max-w-full truncate rounded border border-[var(--attachment-border)] px-2 py-1 text-[11px]"
																>
																	{attachment.mime_type.startsWith("image/")
																		? "Image: "
																		: "File: "}
																	{attachment.file_path
																		.split(/[\\\\/]/)
																		.pop()
																		.replace(/^\d+-[0-9a-f-]{36}-/i, "")}
																</li>
															))}
														</ul>
													)}
												</div>
												{/** Actions toolbar **/}
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
				</div>
				{selectedFiles.length > 0 && (
					<div
						aria-label="Selected attachments"
						className="mx-auto mb-3 flex w-[calc(100%-2rem)] max-w-[980px] max-h-36 shrink-0 gap-2 overflow-auto border-t border-[var(--border)] py-2 "
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
					className="mx-auto mb-3 flex w-[calc(100%-2rem)] max-w-[980px] flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3.5 py-2.5 shadow-[0_4px_20px_var(--window-shadow)] max-[450px]:w-[calc(100%-1.5rem)] max-[450px]:px-2.5 max-[450px]:py-[7px]"
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

					<textarea
						ref={textareaRef}
						className="max-h-[350px] min-h-[38px] w-full resize-none overflow-y-auto rounded-md py-[9px] text-sm leading-normal text-[var(--text-primary)] transition-colors duration-200 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
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

					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							aria-label="Attach files"
							title="Attach images, PDF, TXT, Markdown, or CSV"
							disabled={streaming || loading || !window.api?.processUploads}
							onClick={() => fileInputRef.current?.click()}
							className="flex shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
						>
							<GrAttachment />
						</button>

						{streaming ? (
							<button
								className="flex size-[28px] shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
								onClick={handleStop}
								title="Stop"
							>
								<FaStop />
							</button>
						) : (
							<button
								className="flex size-[28px] shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
								onClick={() => sendMessage()}
								disabled={!canSend || loading}
								title={baseUrl ? "Send" : "No active engine port yet"}
							>
								<IoSend className="-rotate-45" />
							</button>
						)}
					</div>
				</div>
			</div>
			<RightSidebar
				open={isRightSidebarOpen}
				onClose={onCloseRightSidebar}
				sessionId={palace.sessionId}
				modelId={selectedModel}
				agents={agents}
				sessionAgent={sessionAgent}
				disabled={streaming || loading || agentLoading || !window.api?.applyAgent}
				onSelectAgent={selectAgent}
				onManageAgents={() => setAgentModalOpen(true)}
				onSavePrompt={savePrompt}
				tuningVersion={tuningVersion}
			/>
		</div>
	);
}
/** ==========================================================================*
 *   Main App Component*
 *   ========================================================================== **/
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
	const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
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
			<Header
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
					onToggleTheme={toggleTheme}
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

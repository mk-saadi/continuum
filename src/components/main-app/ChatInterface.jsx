import RightSidebar from "../RightSidebar";
import AssistantAvatar from "../AssistantAvatar";
import MessageActions from "../MessageActions.jsx";
import ChatMessage from "../ChatMessage.jsx";
import ChatHistory from "../ChatHistory.jsx";
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { GrAttachment } from "react-icons/gr";
import { FaStop } from "react-icons/fa";
import { BsRobot } from "react-icons/bs";
import useSessionDraft from "../../hooks/useSessionDraft";
import AgentModal from "../AgentModal";
import { optimizeImage } from "../../utils/imageUtils.mjs";
import { assistantLabel, resolveDisplayName, formatModelName } from "../../lib/messageIdentity.mjs";
import { indexDesktopDocuments, runDesktopChat } from "../../lib/desktopChat.mjs";
import { LuX } from "react-icons/lu";
import { IoSend } from "react-icons/io5";

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
				<LuX />
			</button>
		</div>
	);
}

export function ChatInterface({
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
	const currentModel = models.find(model => model.id === selectedModel);
    const currentModelPath = currentModel?.modelPath || currentModel?.path || selectedModel;
    const activeModelName = formatModelName(
		models.find((model) => model.id === selectedModel)?.name || selectedModel,
	);
	const [messages, setMessages] = useState([]);
	const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
	const { input, updateDraft } = useSessionDraft(palace.sessionId);
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
		pendingAgent.current = null;
        pendingSend.current = null;
        palace.setSessionId(crypto.randomUUID());
		setMessages([]);
		clearFiles();
		setEditing(null);
		palace.setDraftTokens(0);
	};

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;

		// Reset height to auto to calculate the true scrollHeight for the current text
		el.style.height = "auto";

		// Set height to scrollHeight. If it exceeds the Tailwind max-h class,
		// CSS takes over and it becomes scrollable.
		el.style.height = el.scrollHeight + "px";
	}, [input]);

	const loadChat = async (id) => {
		if (busyRef.current) return;
		busyRef.current = true;
        setIndexing(null);
		setLoading(true);
		setHistoryError("");
		try {
			const session = await palace.api.loadSession(id);
			pendingAgent.current = null;
            pendingSend.current = null;
            palace.setSessionId(id);
			setMessages(session.messages);
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
        setIndexing(null);
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
				pendingAgent.current = null;
            pendingSend.current = null;
            palace.setSessionId(sessionId);
				setMessages(session.messages);
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
    const pendingAgent = useRef(null);
    const pendingSend = useRef(null);
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
		setSessionAgent(pendingAgent.current?.profile || null);
		(async () => {
			try {
				if (!palace.sessionId) return;
                const pending = pendingAgent.current;
                let profile;
                if (pending) {
                    const result = await window.api.applyAgent({ sessionId: palace.sessionId, agentId: pending.agentId, modelId: selectedModel });
                    profile = result.agent;
                    if (pending.prompt !== undefined) profile = await window.api.saveSessionPrompt(palace.sessionId, pending.prompt, selectedModel);
                    if (active && pendingAgent.current === pending) pendingAgent.current = null;
                } else profile = await window.api?.getSessionAgent(palace.sessionId);
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
	const selectAgent = async ({ agentId, sessionId: activeSessionId = palace.sessionId }) => {
		if (busyRef.current || agentLoading) return;
		busyRef.current = true;
        setIndexing(null);
		setLoading(true);
		setHistoryError("");
		try {
			const preset = agents.find((agent) => agent.id === agentId);
			if (preset?.model_id && !models.some((model) => model.id === preset.model_id)) {
				throw new Error(
					"This agent’s default model is not scanned. Scan it or edit the agent’s model first.",
				);
			}
			const result = await window.api.applyAgent({ sessionId: activeSessionId || null, agentId, modelId: selectedModel });
            pendingAgent.current = result.pending ? { agentId: result.agentId, profile: result.agent || preset || null } : null;
			setSessionAgent(result.agent || null);
			if (result.agent?.model_id) onSelectModel(result.agent.model_id);
			setTuningVersion((version) => version + 1);
			await refreshHistory();
            return result;
		} catch (error) {
			setHistoryError(error.message);
            return false;
		} finally {
			busyRef.current = false;
			setLoading(false);
		}
	};
	const savePrompt = async (prompt) => {
		if (busyRef.current) return false;
		busyRef.current = true;
        setIndexing(null);
		setLoading(true);
		setHistoryError("");
		try {
			if (!palace.sessionId) {
                const profile = { ...(sessionAgent || { id: null, name: 'Assistant' }), system_prompt: prompt };
                pendingAgent.current = { agentId: sessionAgent?.id || null, profile, prompt };
                setSessionAgent(profile);
                return true;
            }
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
	const handleScroll = (event) => {
		// Ignore scroll events bubbling from code blocks inside a message.
		if (event.target !== event.currentTarget) return;
		const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
		setIsUserScrolledUp(scrollHeight - (scrollTop + clientHeight) > 50);
	};
	useLayoutEffect(() => {
		setIsUserScrolledUp(false);
	}, [palace.sessionId]);
	// Follow before paint so growing Markdown does not briefly move the viewport.
	// Direct scrolling affects only the chat pane and never queues animations.
	useLayoutEffect(() => {
		if (!isUserScrolledUp && messagesRef.current) {
			messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "auto" });
		}
	}, [messages, isUserScrolledUp]);
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
        setIndexing(null);
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
		async (edit = null, retry = false) => {
			const text = retry ? "" : edit ? editText.trim() : input.trim();
			if (
				(!retry && !text && (edit || !selectedFiles.length)) ||
                agentLoading ||
				busyRef.current ||
				!baseUrl ||
				!selectedModel ||
				!palace.api
			)
				return;
            if (!palace.sessionId) {
                pendingSend.current = { edit, retry };
                setAgentLoading(true);
                palace.setSessionId(crypto.randomUUID());
                return;
            }
            if (pendingAgent.current) return; // A failed pending apply must be retried before generation.

			busyRef.current = true;
        setIndexing(null);
			setHistoryError("");
			const identity = Object.freeze({
                displayName: resolveDisplayName(avatarSettings, currentModelPath, activeModelName || selectedModel),
				modelName: activeModelName || selectedModel,
				modelId: selectedModel,
				agentName: sessionAgent?.name || null,
			});
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
			let executionSteps = [];
			let prepared = false;
			let failed = false;
			try {
				if (edit) {
					const retained = await palace.api.editMessage(edit.id, text);
					setMessages([...retained, assistantMsg]);
					setEditing(null);
				}
				let attachments = [];
				if (!edit && !retry && selectedFiles.length) {
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
				const requestMessages = await palace.prepareMessages(text, !!edit || retry, attachments);
				prepared = true;
				if (!edit && !retry) {
					updateDraft("");
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
					messageId: assistantMsg.id,
                    displayName: identity.displayName,
					onExecutionSteps: (steps) => {
						executionSteps = steps;
						setMessages((prev) =>
							prev.map((message) =>
								message.id === assistantMsg.id
									? { ...message, executionSteps: steps }
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
				failed = true;
				if (err.name !== "AbortError") setHistoryError(err.message);
			} finally {
				if (prepared && (!failed || assistantText || executionSteps.length)) {
					executionSteps = executionSteps.map((step) =>
						step.type === "tool_call" && ["pending", "running"].includes(step.status)
							? {
									...step,
									status: "error",
									error: controller.signal.aborted
										? "Tool execution cancelled."
										: "Execution interrupted.",
								}
							: step,
					);
					// Publish the completed reply before awaiting persistence. Stats belong
					// to this request, so they do not depend on a React state update flushing.
					setMessages((prev) =>
						prev.map((message) =>
							message.id === assistantMsg.id
								? {
										...message,
										displayName: identity.displayName,
                                        stats: assistantStats,
										executionSteps,
										streaming: false,
									}
								: message,
						),
					);
					try {
						const saved = await palace.finishMessage(
							assistantText,
							assistantStats,
							null,
							null,
							identity,
							executionSteps,
						);
						if (saved)
							setMessages((prev) =>
								prev.map((message) =>
									message.id === assistantMsg.id ? { ...saved, streaming: false } : message,
								),
							);
						else setMessages((prev) => prev.filter((message) => message.id !== assistantMsg.id));
					} catch (error) {
						setHistoryError(`Could not save reply: ${error.message}`);
						setMessages((prev) => prev.filter((message) => message.id !== assistantMsg.id));
					}
				} else {
					setMessages((prev) => prev.filter((message) => message.id !== assistantMsg.id));
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
			updateDraft,
			editText,
			selectedFiles,
			clearFiles,
			selectedModel,
			activeModelName,
            currentModelPath,
            avatarSettings,
			sessionAgent,
            agentLoading,
			baseUrl,
			palace,
			refreshHistory,
		],
	);
    useEffect(() => {
        if (agentLoading || !palace.sessionId || pendingAgent.current || !pendingSend.current) return;
        const { edit, retry } = pendingSend.current;
        pendingSend.current = null;
        void sendMessage(edit, retry);
    }, [agentLoading, palace.sessionId, sendMessage]);
	const regenerateReply = async (message) => {
		if (busyRef.current || !baseUrl || !selectedModel) return;
		busyRef.current = true;
        setIndexing(null);
		setStreaming(true);
		setHistoryError("");
		const controller = new AbortController();
		abortRef.current = controller;
		const previousVariants = message.variants?.length
			? message.variants
			: [
					{
						content: message.content,
						thinking: message.thinkingText,
						thinking_duration: message.thinkingDuration,
						stats: message.stats,
						tool_calls: message.toolCalls,
						displayName: message.displayName,
                        model_name: message.modelName,
						model_id: message.modelId,
						agent_name: message.agentName,
					},
				];
		const index = previousVariants.length;
		let draft = {
			content: "",
			executionSteps: [],
			stats: null,
			displayName: resolveDisplayName(avatarSettings, currentModelPath, activeModelName || selectedModel),
            model_name: activeModelName || selectedModel,
			model_id: selectedModel,
			agent_name: sessionAgent?.name ?? null,
			created_at: new Date().toISOString(),
		};
		const updateDraft = (patch) => {
			draft = { ...draft, ...patch };
			const snapshot = draft;
			setMessages((previous) =>
				previous.map((row) =>
					row.id === message.id
						? {
								...row,
								content: snapshot.content,
								variants: [...previousVariants, snapshot],
								active_variant_index: index,
								streaming: true,
							}
						: row,
				),
			);
		};
		updateDraft({});
		try {
			const result = await runDesktopChat({
				regenerate: true,
				sessionId: palace.sessionId,
				modelId: selectedModel,
				modelName: draft.model_name,
                displayName: draft.displayName,
				memoryEnabled: palace.enabled,
				signal: controller.signal,
				onIndexing: setIndexing,
				onText: (delta) => updateDraft({ content: draft.content + delta }),
				messageId: message.id,
				onExecutionSteps: (executionSteps) => updateDraft({ executionSteps }),
				onStats: (stats) => updateDraft({ stats }),
			});
			setMessages((previous) => previous.map((row) => (row.id === message.id ? result.message : row)));
			await palace.refresh();
			await refreshHistory();
		} catch (error) {
			setMessages((previous) => previous.map((row) => (row.id === message.id ? message : row)));
			if (error.name !== "AbortError") setHistoryError(error.message);
		} finally {
			busyRef.current = false;
			setStreaming(false);
			setIndexing(null);
			abortRef.current = null;
		}
	};
	const selectReplyVariant = async (message, index) => {
		if (busyRef.current) return;
		busyRef.current = true;
        setIndexing(null);
		setLoading(true);
		setHistoryError("");
		setMessages((previous) =>
			previous.map((row) =>
				row.id === message.id
					? { ...row, active_variant_index: index, content: row.variants[index].content }
					: row,
			),
		);
		try {
			const saved = await palace.api.setActiveVariant(palace.sessionId, message.id, index);
			setMessages((previous) => previous.map((row) => (row.id === message.id ? saved : row)));
			await palace.refresh();
		} catch (error) {
			setMessages((previous) => previous.map((row) => (row.id === message.id ? message : row)));
			setHistoryError(error.message);
		} finally {
			busyRef.current = false;
			setLoading(false);
		}
	};
	const hasUnrepliedMessage = messages.at(-1)?.role === "user" && !streaming;
	const generateReply = useCallback(() => {
		if (hasUnrepliedMessage && !loading) sendMessage(null, true);
	}, [hasUnrepliedMessage, loading, sendMessage]);
	useEffect(() => {
		const handleGenerateShortcut = (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
				event.preventDefault();
				if (!event.repeat) generateReply();
			}
		};
		window.addEventListener("keydown", handleGenerateShortcut);
		return () => window.removeEventListener("keydown", handleGenerateShortcut);
	}, [generateReply]);
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
				className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none [&>aside]:h-full ${isSidebarOpen ? "w-[272px] translate-x-0 opacity-100 max-[650px]:w-[220px]" : "w-0 -translate-x-full opacity-0"}`}
			>
				<ChatHistory
					isOpen={isSidebarOpen}
					groups={groups}
					activeId={palace.sessionId}
					disabled={streaming || loading}
					onLoad={loadChat}
					onNew={newChat}
					onAction={async (kind, id, value) => {
						if (busyRef.current) throw new Error("Wait for the current operation to finish.");
						busyRef.current = true;
        setIndexing(null);
						setLoading(true);
						try {
							if (kind === "New Folder") await palace.api.createFolder(value);
							else if (kind === "Rename") await palace.api.renameSession(id, value);
							else if (kind === "Move to Folder") await palace.api.moveSession(id, value);
							else {
								await palace.api.deleteSession(id);
								if (id === palace.sessionId) {
									pendingAgent.current = null;
        pendingSend.current = null;
        palace.setSessionId(crypto.randomUUID());
									setMessages([]);
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
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-auto px-4 py-6 max-[450px]:px-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-[var(--scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-[var(--scrollbar-thumb)]"
					ref={messagesRef}
					onScroll={handleScroll}
				>
					<div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col gap-7">
						{messages.length === 0 ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-3 max-[450px]:gap-1 max-[450px]:text-center text-[var(--text-muted)]">
								<span className="text-[50px] opacity-40 max-[450px]:text-xl">
									<BsRobot />
								</span>
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
										className={`group flex min-w-0 flex-col transition-[opacity,transform] duration-300 starting:opacity-0 starting:translate-y-1 motion-reduce:transition-none ${
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
												{assistantLabel(msg, activeModelName)}
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
															Cancel (Esc)
														</button>
														<button
															type="submit"
															className="rounded-lg text-[var(--on-accent)] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)] px-3.5 py-1.5 text-[11px] font-medium shadow-[0_4px_20px_var(--window-shadow)] hover:opacity-90"
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
													className={`min-w-0 max-w-full break-words whitespace-pre-wrap select-text text-[var(--text-primary)] ${
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
														<ChatMessage
															message={msg}
															showHeader={false}
															disabled={streaming || loading}
															onSelectVariant={(index) =>
																selectReplyVariant(msg, index)
															}
														/>
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
														onRegenerate={() => regenerateReply(msg)}
														isLast={i === messages.length - 1}
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
					className="mx-auto relative mb-3 flex w-[calc(100%-2rem)] max-w-[980px] flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3.5 py-2.5 shadow-[0_4px_20px_var(--window-shadow)] max-[450px]:w-[calc(100%-1.5rem)] max-[450px]:px-2.5 max-[450px]:py-[7px]"
				>
					{hasUnrepliedMessage && (
						<div className="absolute -top-10 left-0 right-0 flex justify-center pointer-events-none">
							<button
								type="button"
								onClick={generateReply}
								disabled={loading || !baseUrl || !selectedModel || !palace.api}
								className="pointer-events-auto rounded-full text-[var(--on-accent)] cursor-pointer transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)] px-4 py-1.5 text-xs backdrop-blur-sm shadow-[0_4px_20px_var(--window-shadow)]"
							>
								Generate a reply (Ctrl + R)
							</button>
						</div>
					)}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.toml,.ini,.sh,.sql,.log,.tsv,.c,.h,.cpp,.java,.go,.rs,.rb,.php"
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
						className="max-h-[200px] sm:max-h-[350px] min-h-[38px] w-full resize-none overflow-y-auto rounded-md py-[9px] text-sm leading-normal text-[var(--text-primary)] transition-colors duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none [scrollbar-width:none] and [&::-webkit-scrollbar]:hidden"
						value={input}
						onChange={(e) => {
							updateDraft(e.target.value);
							palace.setDraftTokens(Math.ceil(e.target.value.length / 4));
						}}
						// disabled={streaming || loading}
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
								className="flex size-[28px] shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
								onClick={handleStop}
								title="Stop"
							>
								<FaStop />
							</button>
						) : (
							<button
								className="flex size-[28px] shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
								onClick={() => sendMessage()}
								disabled={!canSend || loading}
								title={baseUrl ? "Send" : "No active engine port yet"}
							>
								<IoSend />
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

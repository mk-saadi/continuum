import RightSidebar from "../RightSidebar";
import AssistantAvatar from "../AssistantAvatar";
import MessageActions from "../MessageActions.jsx";
import ChatMessage, { MessageContextStatus } from "../ChatMessage.jsx";
import Sidebar from "../Sidebar.jsx";
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { BsRobot } from "react-icons/bs";
import ChatInput from "../ChatInput";
import { optimizeImage } from "../../utils/imageUtils.mjs";
import { assistantLabel, resolveDisplayName, formatModelName } from "../../lib/messageIdentity.mjs";
import { indexDesktopDocuments, runDesktopChat } from "../../lib/desktopChat.mjs";
import { LuX } from "react-icons/lu";
import { IoIosHourglass } from "react-icons/io";
import ToolApprovalToast from "./ToolApprovalToast.jsx";
import ToolLimitToast from "./ToolLimitToast.jsx";
import { useStreamBuffer } from "./useStreamBuffer.js";
import { compactMessageForDisplay, compactStepsForDisplay } from "../../lib/toolDisplay.mjs";

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
	view = "chat",
	projects = [],
	activeProjectId,
	onProjects,
	onProject,
	onCreateProject,
	onChat = () => {},
	renderWorkspace,
	selectedModel,
	baseUrl,
	activeChatProvider = { type: "local" },
	engineRunning,
	activeModel = null,
	palace,
	isSidebarOpen,
	avatarSettings,
	isRightSidebarOpen,
	onCloseRightSidebar,
models,
	onSelectModel,
onTabUpdate,
	tabPermissionMode,
	tabSaved = false,
	onTabSaved,
}) {
	const [permissionBySession, setPermissionBySession] = useState({});
	const project = projects.find((project) => project.id === activeProjectId);
	const permissionMode =
		permissionBySession[palace.sessionId] ??
		tabPermissionMode ??
		project?.permissionMode ??
		project?.permission_mode ??
		(activeProjectId ? "workspace_write" : "ask_approval");
	const [toolApprovals, setToolApprovals] = useState([]);
	useEffect(
		() =>
			window.chatAPI?.onToolApproval?.((state) => {
				if (state.sessionId !== palace.sessionId) return;
				setToolApprovals((current) =>
					state.resolved
						? current.filter((item) => item.approvalId !== state.approvalId)
						: [...current.filter((item) => item.approvalId !== state.approvalId), state],
				);
			}),
		[palace.sessionId],
	);
	const chatAvailable = activeChatProvider.type === "cloud" || !!baseUrl;
	const currentModel = models.find((model) => model.id === selectedModel);
	const supportedEfforts = currentModel?.reasoningEfforts ?? [];
	const [effortByModel, setEffortByModel] = useState({});
	const savedEffort = effortByModel[selectedModel];
	const reasoningEffort = supportedEfforts.includes(savedEffort)
		? savedEffort
		: supportedEfforts.includes("medium")
			? "medium"
			: supportedEfforts[0];
	const currentModelPath = currentModel?.modelPath || currentModel?.path || selectedModel;
	const activeModelName = formatModelName(
		models.find((model) => model.id === selectedModel)?.name || selectedModel,
	);
	const [messages, setMessages] = useState([]);
	const streamBuffer = useStreamBuffer();
	const activeStreamMessageIdRef = useRef(null);
	const loadDisplaySession = (sessionId) => palace.api.loadDisplaySession?.(sessionId) ?? palace.api.loadSession(sessionId);
	const displayMessages = (session) => palace.api.loadDisplaySession
		? session.messages : session.messages.map(compactMessageForDisplay);
	const [promptQueue, setPromptQueue] = useState([]);
	const queuePrompt = useCallback((text) => {
		setPromptQueue((previous) => [...previous, { id: Date.now(), text }]);
	}, []);
	const isUserScrolledUp = useRef(false);
	const composerRef = useRef(null);
	const [selectedFiles, setSelectedFiles] = useState([]);
	const [indexing, setIndexing] = useState(null);
	const fileInputRef = useRef(null);
	const uploadCache = useRef(new Map());
	const clearFiles = useCallback(() => {
		setSelectedFiles([]);
		uploadCache.current.clear();
	}, []);
	const [streaming, setStreaming] = useState(false);
	const [allowMidRunQuestions, setAllowMidRunQuestions] = useState(false);
	const [midRunQuestionsBusy, setMidRunQuestionsBusy] = useState(true);
	const [midRunQuestionsError, setMidRunQuestionsError] = useState("");
	useEffect(() => {
		let current = true;
		setAllowMidRunQuestions(false);
		setMidRunQuestionsError("");
		setMidRunQuestionsBusy(true);
		if (palace.sessionId && selectedModel)
			window.api
				.getEffectiveSettings(palace.sessionId, selectedModel)
				.then((result) => {
					if (current) setAllowMidRunQuestions(result.effective.allowMidRunQuestions === true);
				})
				.catch((error) => {
					if (current) setMidRunQuestionsError(error.message);
				})
				.finally(() => {
					if (current) setMidRunQuestionsBusy(false);
				});
		else setMidRunQuestionsBusy(false);
		return () => {
			current = false;
		};
	}, [palace.sessionId, selectedModel]);
	async function changeMidRunQuestions(value) {
		setMidRunQuestionsBusy(true);
		setMidRunQuestionsError("");
		try {
			const result = await window.api.saveSessionMemorySettings(palace.sessionId, selectedModel, {
				allowMidRunQuestions: value,
			});
			setAllowMidRunQuestions(result.effective.allowMidRunQuestions === true);
		} catch (error) {
			setMidRunQuestionsError(error.message);
		} finally {
			setMidRunQuestionsBusy(false);
		}
	}
	const [pendingQuestions, setPendingQuestions] = useState({});
	useEffect(() => {
		setPendingQuestions({});
		return window.chatAPI?.onAskUser?.((request) => {
			if (request.sessionId !== palace.sessionId) return;
			setPendingQuestions((current) => {
				const next = { ...current };
				if (request.resolved) delete next[request.stepId];
				else next[request.stepId] = request;
				return next;
			});
		});
	}, [palace.sessionId]);
	const [pausedLoop, setPausedLoop] = useState(null);
	const [toolLimit, setToolLimit] = useState(null);
	useEffect(
		() =>
			window.chatAPI?.onToolLimitReached?.((state) => {
				if (state.sessionId !== palace.sessionId) return;
				setToolLimit((current) =>
					state.resolved ? (current?.requestId === state.requestId ? null : current) : state,
				);
			}),
		[palace.sessionId],
	);
	useEffect(
		() =>
			window.chatAPI?.onLoopPaused?.((state) => {
				if (state.sessionId !== palace.sessionId) return;
				setPausedLoop(state.executionState === "paused_turn_limit" ? state : null);
			}),
		[palace.sessionId],
	);
	useEffect(() => {
		onTabUpdate?.({
			status:
				toolApprovals.length || toolLimit || pausedLoop || Object.keys(pendingQuestions).length
					? "awaiting_approval"
					: streaming
						? "generating"
						: "idle",
		});
	}, [toolApprovals, toolLimit, pausedLoop, pendingQuestions, streaming, onTabUpdate]);
useEffect(() => {
		if (!streaming) {
			setPendingQuestions({});
			setPausedLoop(null);
			setToolLimit(null);
		}
	}, [streaming]);
	// Restore the transcript for a tab rehydrated from persisted state. Only
	// committed chats exist in the database; a never-sent tab has no row yet,
	// so its empty history is correct and must not raise an error.
	useEffect(() => {
		const sessionId = palace.sessionId;
		if (!sessionId || !tabSaved || !palace.api) return;
		let current = true;
		setLoading(true);
		loadDisplaySession(sessionId)
			.then((session) => {
				if (!current) return;
				setMessages(displayMessages(session));
			})
			.catch((error) => {
				// The session can disappear between restore and this read.
				if (current) setMessages([]);
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [palace.sessionId, tabSaved, palace.api]);
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
	useEffect(
		() =>
			palace.api?.onCompressionComplete((result) => {
				if (result.sessionId !== palace.sessionId) return;
				const ids = new Set(result.summarizedMessageIds || []);
				setMessages((previous) =>
					previous.map((message) =>
						ids.has(message.id) ? { ...message, is_summarized: 1, archived: 1 } : message,
					),
				);
			}),
		[palace.api, palace.sessionId],
	);
	const newChat = () => {
		if (busyRef.current) return;
		onChat();
		onTabUpdate?.({ title: "New chat", status: "idle" });
		pendingAgent.current = null;
		pendingSend.current = null;
		setPromptQueue([]);
		palace.setSessionId(crypto.randomUUID());
		setMessages([]);
		clearFiles();
		setEditing(null);
		palace.setDraftTokens(0);
	};

	const loadChat = async (id) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setIndexing(null);
		setLoading(true);
		setHistoryError("");
		try {
			const session = await loadDisplaySession(id);
			pendingAgent.current = null;
			pendingSend.current = null;
			setPromptQueue([]);
			palace.setSessionId(id);
			onTabUpdate?.({
				title: session.title || "Untitled chat",
				modelId: session.model_id || selectedModel,
				projectId: session.project_id ?? null,
				permissionMode: session.project_id ? "workspace_write" : "ask_approval",
			});
			setMessages(displayMessages(session));
			onChat();
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
	const startProjectChat = async (projectId, text) => {
		if (busyRef.current || agentLoading)
			throw new Error("Wait for the current chat operation to finish.");
		if (!chatAvailable || !selectedModel)
			throw new Error("Start a model before creating a project chat.");
		busyRef.current = true;
		setLoading(true);
		try {
			const id = crypto.randomUUID();
			await palace.api.getOrCreateSession(id, selectedModel, projectId);
			// Persist the submitted prompt as a draft until generation accepts it.
			try {
				localStorage.setItem(`chat_draft_${id}`, text);
			} catch {
				/* Draft storage is optional. */
			}
			pendingAgent.current = null;
			setPromptQueue([]);
			pendingSend.current = { edit: null, retry: false, submittedText: text, draftSessionId: id };
			setAgentLoading(true);
			palace.setSessionId(id);
			onTabUpdate?.({ projectId, title: "New chat", permissionMode: "workspace_write" });
			setMessages([]);
			clearFiles();
			setEditing(null);
			palace.setDraftTokens(0);
			onChat();
			await refreshHistory();
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
				const session = await loadDisplaySession(sessionId);
				pendingAgent.current = null;
				pendingSend.current = null;
				setPromptQueue([]);
				palace.setSessionId(sessionId);
				setMessages(displayMessages(session));
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
					const result = await window.api.applyAgent({
						sessionId: palace.sessionId,
						agentId: pending.agentId,
						modelId: selectedModel,
					});
					profile = result.agent;
					if (pending.prompt !== undefined)
						profile = await window.api.saveSessionPrompt(
							palace.sessionId,
							pending.prompt,
							selectedModel,
						);
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
			const result = await window.api.applyAgent({
				sessionId: activeSessionId || null,
				agentId,
				modelId: selectedModel,
			});
			pendingAgent.current = result.pending
				? { agentId: result.agentId, profile: result.agent || preset || null }
				: null;
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
				const profile = {
					...(sessionAgent || { id: null, name: "Assistant" }),
					system_prompt: prompt,
				};
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
	const onStreamFrame = useCallback(() => {
		if (!isUserScrolledUp.current && messagesRef.current)
			messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "auto" });
	}, []);
	const abortRef = useRef(null);
	useEffect(() => () => abortRef.current?.abort(), []);
	useEffect(() => {
		if (!streaming) return;
		const timer = setTimeout(palace.schedule, 250);
		return () => clearTimeout(timer);
	}, [messages, streaming, palace.schedule]);
	const handleScroll = (event) => {
		// Ignore scroll events bubbling from code blocks inside a message.
		if (event.target !== event.currentTarget) return;
		const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
		isUserScrolledUp.current = scrollHeight - (scrollTop + clientHeight) > 50;
	};
	useLayoutEffect(() => {
		isUserScrolledUp.current = false;
	}, [palace.sessionId]);
	// Follow before paint so growing Markdown does not briefly move the viewport.
	// Direct scrolling affects only the chat pane and never queues animations.
	useLayoutEffect(() => {
		if (!isUserScrolledUp.current && messagesRef.current) {
			messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "auto" });
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
		async (
			edit = null,
			retry = false,
			submittedText = "",
			draftSessionId = palace.sessionId,
			queued = false,
		) => {
			const text = retry ? "" : edit ? editText.trim() : submittedText.trim();
			if (
				(!retry && !text && (edit || !selectedFiles.length)) ||
				agentLoading ||
				busyRef.current ||
				!chatAvailable ||
				!selectedModel ||
				!palace.api
			)
				return;
			if (!palace.sessionId) {
				pendingSend.current = { edit, retry, submittedText, draftSessionId, queued };
				setAgentLoading(true);
				palace.setSessionId(crypto.randomUUID());
				return;
			}
if (pendingAgent.current) return; // A failed pending apply must be retried before generation.

		busyRef.current = true;
		setIndexing(null);
		setHistoryError("");
		// The session row is created from here on, so the tab becomes a
		// restorable chat rather than a blank one.
		onTabSaved?.();
			const identity = Object.freeze({
				displayName: resolveDisplayName(
					avatarSettings,
					currentModelPath,
					activeModelName || selectedModel,
				),
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
			let persistedMessageId = null;
			let assistantText = "";
			activeStreamMessageIdRef.current = assistantMsg.id;
			let lastDraftTokenUpdate = 0;
			streamBuffer.start((text) => {
				const now = performance.now();
				if (now - lastDraftTokenUpdate >= 1000) {
					lastDraftTokenUpdate = now;
					palace.setDraftTokens(Math.ceil(text.length / 4));
				}
			});
			let assistantStats = null;
			let executionSteps = [];
			let prepared = false;
			let failed = false;
			try {
				if (edit) setEditing(null);
				let attachments = [];
				if (!queued && !edit && !retry && selectedFiles.length) {
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
				const requestMessages = edit
					? undefined
					: await palace.prepareMessages(text, retry, attachments);
				if (!edit && !retry && text?.trim()) onTabUpdate?.({ title: text.trim().slice(0, 48) });
				prepared = true;
				if (!queued && !edit && !retry) {
					composerRef.current?.clearSubmitted(submittedText, draftSessionId);
					clearFiles();
				}
			const saved = await loadDisplaySession(palace.sessionId);
			setMessages([...displayMessages(saved), assistantMsg]);
				await refreshHistory();
				const thinkingBudget =
					(await window.api.getEffectiveSettings(palace.sessionId, selectedModel)).effective
						.thinkingBudget ?? -1;
				await runDesktopChat({
					activeChatProvider,
					permissionMode,
					reasoningEffort,
					thinkingBudget,
					sessionId: palace.sessionId,
					onIndexing: setIndexing,
					modelId: selectedModel,
					messages: requestMessages,
					...(edit ? { branchMessageId: edit.id, newContent: text } : {}),
					messageId: assistantMsg.id,
					modelName: identity.modelName,
					onMessageCreated: (id) => {
						persistedMessageId = id;
					},
					displayName: identity.displayName,
					onExecutionSteps: (steps) => {
						executionSteps = steps;
						setMessages((prev) =>
							prev.map((message) =>
								message.id === assistantMsg.id
									? { ...message, executionSteps: compactStepsForDisplay(steps, message.executionSteps) }
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
						streamBuffer.push(delta);
					},
				});
			} catch (err) {
				failed = true;
				if (err.name !== "AbortError") setHistoryError(err.message);
			} finally {
				assistantText = streamBuffer.flush();
				palace.setDraftTokens(Math.ceil(assistantText.length / 4));
				if (prepared && (persistedMessageId || !failed || assistantText || executionSteps.length)) {
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
										executionSteps: compactStepsForDisplay(executionSteps),
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
							persistedMessageId,
						);
						if (saved)
							setMessages((prev) =>
								prev.map((message) =>
									message.id === assistantMsg.id ? { ...compactMessageForDisplay(saved), streaming: false } : message,
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
				if (edit) {
					try {
						setMessages(displayMessages(await loadDisplaySession(palace.sessionId)));
					} catch (error) {
						setHistoryError(error.message);
					}
				}
				setStreaming(false);
				activeStreamMessageIdRef.current = null;
				setIndexing(null);
				busyRef.current = false;
				abortRef.current = null;
			}
		},
		[
			editText,
			selectedFiles,
			clearFiles,
			selectedModel,
			permissionMode,
			reasoningEffort,
			activeChatProvider,
			activeModelName,
			currentModelPath,
			avatarSettings,
			sessionAgent,
			agentLoading,
chatAvailable,
			palace,
			refreshHistory,
			onTabSaved,
		],
	);
	useEffect(() => {
		if (agentLoading || loading || !palace.sessionId || pendingAgent.current || !pendingSend.current)
			return;
		const { edit, retry, submittedText, draftSessionId, queued } = pendingSend.current;
		pendingSend.current = null;
		void sendMessage(edit, retry, submittedText, draftSessionId, queued);
	}, [agentLoading, loading, palace.sessionId, sendMessage]);
	const isGenerating = streaming || loading || agentLoading;
	useEffect(() => {
		if (
			isGenerating ||
			busyRef.current ||
			pendingSend.current ||
			pendingAgent.current ||
			!chatAvailable ||
			!selectedModel ||
			!palace.api ||
			promptQueue.length === 0
		)
			return;
		const nextPrompt = promptQueue[0];
		// sendMessage acquires the busy ref synchronously, including during effect replay.
		void sendMessage(null, false, nextPrompt.text, palace.sessionId, true);
		setPromptQueue((previous) => previous.slice(1));
	}, [isGenerating, promptQueue, chatAvailable, selectedModel, palace.api, palace.sessionId, sendMessage]);

	const regenerateReply = async (message) => {
		if (busyRef.current || !chatAvailable || !selectedModel) return;
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
			displayName: resolveDisplayName(
				avatarSettings,
				currentModelPath,
				activeModelName || selectedModel,
			),
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
		activeStreamMessageIdRef.current = message.id;
		streamBuffer.start();
		updateDraft({});
		try {
			const result = await runDesktopChat({
				activeChatProvider,
				permissionMode,
				reasoningEffort,
				regenerate: true,
				sessionId: palace.sessionId,
				modelId: selectedModel,
				modelName: draft.model_name,
				displayName: draft.displayName,
				memoryEnabled: palace.enabled,
				signal: controller.signal,
				onIndexing: setIndexing,
				onText: (delta) => streamBuffer.push(delta),
				messageId: message.id,
				onExecutionSteps: (executionSteps) => updateDraft({ executionSteps }),
				onStats: (stats) => updateDraft({ stats }),
			});
			setMessages((previous) => previous.map((row) => (row.id === message.id ? compactMessageForDisplay(result.message) : row)));
			await palace.refresh();
			await refreshHistory();
		} catch (error) {
			setMessages((previous) => previous.map((row) => (row.id === message.id ? message : row)));
			if (error.name !== "AbortError") setHistoryError(error.message);
		} finally {
			streamBuffer.flush();
			activeStreamMessageIdRef.current = null;
			busyRef.current = false;
			setStreaming(false);
			setIndexing(null);
			abortRef.current = null;
		}
	};
	const selectReplyVariant = useCallback(
		async (message, index) => {
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
				setMessages((previous) => previous.map((row) => (row.id === message.id ? compactMessageForDisplay(saved) : row)));
				await palace.refresh();
			} catch (error) {
				setMessages((previous) => previous.map((row) => (row.id === message.id ? message : row)));
				setHistoryError(error.message);
			} finally {
				busyRef.current = false;
				setLoading(false);
			}
		},
		[palace.api, palace.sessionId, palace.refresh],
	);
	const answerQuestion = useCallback((request, answer) =>
		window.chatAPI.respondToAskUser(request.requestId, request.questionId, answer), []);
	const selectMessageBranch = async (message, offset) => {
		if (busyRef.current || !palace.api) return;
		const siblings = message.siblings || [];
		const targetId = siblings[siblings.indexOf(message.id) + offset];
		if (!targetId) return;
		busyRef.current = true;
		setLoading(true);
		try {
			setMessages((await palace.api.selectMessageBranch(palace.sessionId, targetId)).map(compactMessageForDisplay));
			await palace.refresh();
		} catch (error) {
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
			if (view === "chat" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
				event.preventDefault();
				if (!event.repeat) generateReply();
			}
		};
		window.addEventListener("keydown", handleGenerateShortcut);
		return () => window.removeEventListener("keydown", handleGenerateShortcut);
	}, [generateReply, view]);
	const handleStop = () => {
		if (abortRef.current) {
			abortRef.current.abort();
		}
	};
	return (
		<div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
			{toolApprovals[0] && (
				<ToolApprovalToast
					key={toolApprovals[0].approvalId}
					approval={toolApprovals[0]}
				/>
			)}
			{toolLimit && (
				<ToolLimitToast
					key={toolLimit.requestId + ":" + toolLimit.currentCount}
					limit={toolLimit}
					onError={setHistoryError}
				/>
			)}
			{pausedLoop && (
				<div
					role="status"
					className="absolute top-3 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-amber-400/40 bg-slate-900 p-4 text-white shadow-lg"
				>
					<p>Agent reached max autonomous turns.</p>
					<div className="mt-2 flex gap-3">
						<button
							type="button"
							className="rounded bg-blue-600 px-3 py-1"
							onClick={() =>
								window.chatAPI
									.respondToLoop(pausedLoop.requestId, "continue")
									.catch((error) => setHistoryError(error.message))
							}
						>
							Continue
						</button>
						<button
							type="button"
							className="rounded border px-3 py-1"
							onClick={() =>
								window.chatAPI
									.respondToLoop(pausedLoop.requestId, "stop")
									.catch((error) => setHistoryError(error.message))
							}
						>
							Stop
						</button>
					</div>
				</div>
			)}
			<div
				id="chat-sidebar"
				aria-hidden={!isSidebarOpen}
				inert={isSidebarOpen ? undefined : ""}
				className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none [&>aside]:h-full ${isSidebarOpen ? "w-[272px] translate-x-0 opacity-100 max-[650px]:w-[220px]" : "w-0 -translate-x-full opacity-0"}`}
			>
				<Sidebar
					projects={projects}
					view={view}
					activeProjectId={activeProjectId}
					onProjects={onProjects}
					onProject={onProject}
					onCreateProject={onCreateProject}
					onChat={onChat}
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
									onTabUpdate?.({ title: "New chat", status: "idle" });
									pendingAgent.current = null;
									pendingSend.current = null;
									setPromptQueue([]);
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
			{renderWorkspace?.({
				groups,
				loadChat,
				startProjectChat,
				busy: streaming || loading || agentLoading,
				canStartChat: !!chatAvailable && !!selectedModel,
			})}
			<div
				style={view === "chat" ? undefined : { display: "none" }}
				className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none"
			>
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
									{chatAvailable
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
													className="flex flex-col gap-2 w-full"
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
																	chatAvailable &&
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
																!chatAvailable ||
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
															streamBuffer={msg.streaming && activeStreamMessageIdRef.current === msg.id ? streamBuffer : undefined}
															onStreamFrame={onStreamFrame}
															projectId={activeProjectId}
															pendingQuestions={pendingQuestions}
												onAnswerQuestion={answerQuestion}
															showHeader={false}
															disabled={streaming || loading}
															onSelectReplyVariant={selectReplyVariant}
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
												<MessageContextStatus message={msg} />
												{msg.role === "user" && msg.siblings?.length > 1 && (
													<div
														className="mt-2 flex items-center gap-2 rounded-full border border-[var(--subtle-border)] px-2 py-1 text-xs text-[var(--text-muted)]"
														aria-label="Prompt versions"
													>
														<button
															type="button"
															aria-label="Previous prompt version"
															disabled={
																streaming ||
																loading ||
																msg.siblings[0] === msg.id
															}
															onClick={() => selectMessageBranch(msg, -1)}
														>
															◄
														</button>
														<span aria-live="polite">
															{msg.siblings.indexOf(msg.id) + 1} /{" "}
															{msg.siblings.length}
														</span>
														<button
															type="button"
															aria-label="Next prompt version"
															disabled={
																streaming ||
																loading ||
																msg.siblings.at(-1) === msg.id
															}
															onClick={() => selectMessageBranch(msg, 1)}
														>
															►
														</button>
													</div>
												)}
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
					{promptQueue.length > 0 && (
						<div
							aria-label="Queued prompts"
							className="absolute bottom-full left-0 right-0 z-10 mb-2 flex max-h-28 flex-wrap gap-1 overflow-y-auto"
						>
							{promptQueue.map((item, index) => (
								<button
									key={`${item.id}-${index}`}
									type="button"
									title={item.text}
									aria-label={`Remove queued prompt: ${item.text}`}
									onClick={() =>
										setPromptQueue((previous) =>
											previous.filter((entry) => entry !== item),
										)
									}
									className="max-w-full truncate rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-xs text-[var(--text-secondary)] shadow-sm hover:text-[var(--text-primary)]"
								>
									<IoIosHourglass /> Queued ({promptQueue.length}): &quot;
									{item.text.slice(0, 30)}
									{item.text.length > 30 ? "..." : ""}&quot; (click to remove)
								</button>
							))}
						</div>
					)}
					{hasUnrepliedMessage && promptQueue.length === 0 && (
						<div className="absolute -top-10 left-0 right-0 flex justify-center pointer-events-none">
							<button
								type="button"
								onClick={generateReply}
								disabled={loading || !chatAvailable || !selectedModel || !palace.api}
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

					<ChatInput
						modelId={selectedModel}
						permissionMode={permissionMode}
						allowMidRunQuestions={allowMidRunQuestions}
						onMidRunQuestionsChange={changeMidRunQuestions}
						midRunQuestionsBusy={midRunQuestionsBusy}
						midRunQuestionsError={midRunQuestionsError}
						onPermissionModeChange={(mode) => {
							setPermissionBySession((current) => ({ ...current, [palace.sessionId]: mode }));
							onTabUpdate?.({ permissionMode: mode });
						}}
						ref={composerRef}
						sessionId={palace.sessionId}
						onQueue={queuePrompt}
						onSubmit={(text) => sendMessage(null, false, text)}
						onStop={handleStop}
						onAttach={() => fileInputRef.current?.click()}
						canSubmit={!!chatAvailable && !!selectedModel && !!palace.api && !agentLoading}
						hasAttachments={selectedFiles.length > 0}
						streaming={streaming}
						loading={loading}
						attachDisabled={!window.api?.processUploads}
						sendTitle={chatAvailable ? "Send" : "Select a cloud model or load a local model"}
						supportedEfforts={supportedEfforts}
						reasoningEffort={reasoningEffort}
						showEffort={activeChatProvider.type === "local" && engineRunning}
						onEffortChange={(effort) =>
							setEffortByModel((previous) => ({ ...previous, [selectedModel]: effort }))
						}
					/>
				</div>
			</div>
			<RightSidebar
				activeModel={activeModel}
				open={view === "chat" && isRightSidebarOpen}
				onClose={onCloseRightSidebar}
				sessionId={palace.sessionId}
				modelId={selectedModel}
				agents={agents}
				sessionAgent={sessionAgent}
				disabled={streaming || loading || agentLoading || !window.api?.applyAgent}
				onSelectAgent={selectAgent}
				onSavePrompt={savePrompt}
				tuningVersion={tuningVersion}
			/>
		</div>
	);
}

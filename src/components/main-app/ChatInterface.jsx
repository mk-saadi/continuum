import RightSidebar from "../RightSidebar";
import { getSidebarMode } from "../../lib/sidebarControls.mjs";
import AssistantAvatar from "../AssistantAvatar";
import MessageActions from "../MessageActions.jsx";
import ChatMessage, { MessageContextStatus } from "../ChatMessage.jsx";
import AdditionalPrompts from "../AdditionalPrompts.jsx";
import Sidebar from "../Sidebar.jsx";
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { attachmentPolicy, assertAttachmentNames } from "../../lib/attachmentPolicy.mjs";
import { BsRobot } from "react-icons/bs";
import { FiArrowDown, FiChevronDown, FiMessageSquare } from "react-icons/fi";
import ChatInput from "../ChatInput";
import { optimizeImage } from "../../utils/imageUtils.mjs";
import { assistantLabel, resolveDisplayName, formatModelName } from "../../lib/messageIdentity.mjs";
import { combineQuotedMessage, extractScopedSelectionText } from "../../lib/textSelection.mjs";
import { applyFindMarks, clearFindMarks, markIndexForMessage, scrollMarkIntoView, setActiveFindMark } from "../../lib/chatFind.mjs";
import { findMessageMatches, resolveActiveMatchIndex } from "../../lib/chatSearch.mjs";
import { indexDesktopDocuments, runDesktopChat } from "../../lib/desktopChat.mjs";
import { firstPromptTitle } from "../../lib/chatTitle.mjs";
import { LuX } from "react-icons/lu";
import { IoIosHourglass } from "react-icons/io";
import ToolApprovalToast from "./ToolApprovalToast.jsx";
import ToolLimitToast from "./ToolLimitToast.jsx";
import { WorkspaceMessage } from "../chat/WorkspaceTimeline.jsx";
import TextSelectionMenu from "../chat/TextSelectionMenu.jsx";
import ChatFindBar from "../chat/ChatFindBar.jsx";
import PendingInteractions, { readSkillDecision } from "../chat/PendingInteractions.jsx";
import AttachmentPreview from "../chat/AttachmentPreview.jsx";
import { activeStepsOf, getTurnInteractions, pendingSkillProposals } from "../../lib/executionEvents.mjs";
import { fetchSessionGroups } from "../../lib/sessionGroups.mjs";
import { useLeftSidebar, useRightSidebar } from "../../context/UIStateContext.jsx";
import { useStreamBuffer } from "./useStreamBuffer.js";
import { OLDER_SCROLL_THRESHOLD_PX, useTranscriptWindow } from "./useTranscriptWindow.js";
import { useTranscriptVirtual } from "./useTranscriptVirtual.js";
import { clearRowUiState } from "../../lib/rowUiState.mjs";
import { compactMessageForDisplay, compactStepsForDisplay } from "../../lib/toolDisplay.mjs";
import { summarizeNoticeFor } from "../../lib/summarizeNotice.mjs";
import {
	availablePermissionModes,
	defaultPermissionMode,
	resolveChatPermissionMode,
} from "../../lib/permissionModes.mjs";

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

// Sidebar chrome state is delivered through a tiny context subscriber, so
// toggling a sidebar re-renders the panels and header controls but not the
// transcript subtree that ChatInterface owns. Explicit props stay supported so
// the standalone sidebar fixtures can drive the panels directly.
function LeftSidebarState({ isSidebarOpen, children }) {
	const sidebar = useLeftSidebar();
	return children(isSidebarOpen ?? sidebar?.open ?? false);
}

function RightSidebarState({ isRightSidebarOpen, onClose, children }) {
	const sidebar = useRightSidebar();
	const open = isRightSidebarOpen ?? sidebar?.open ?? false;
	const close = onClose ?? (() => sidebar?.setOpen(false));
	return children(open, close);
}

// Phase 2.1 steering status helpers live in a small tested module.
import {
	STEERING_STATE_LABELS,
	mergeSteeringHistory,
	mergeSteeringItem,
	steeringPromptsForRun,
	steeringRunIdForMessage,
	visibleSteeringForRun,
} from "../../lib/steeringDisplay.mjs";

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
	tabActive = false,
}) {
	const [permissionBySession, setPermissionBySession] = useState({});
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
	const [uploadPolicy, setUploadPolicy] = useState(() => attachmentPolicy());
	useEffect(() => {
		let active = true;
		setUploadPolicy(attachmentPolicy());
		const refresh = async () => {
			try {
				const policy = await window.api?.getAttachmentPolicy?.({
					modelId: selectedModel,
					activeChatProvider,
				});
				if (active && policy) setUploadPolicy(policy);
			} catch {
				if (active) setUploadPolicy(attachmentPolicy());
			}
		};
		refresh();
		const unsubscribe = window.terminalAPI?.onStatus?.(refresh);
		window.addEventListener("cloud-providers-changed", refresh);
		return () => {
			active = false;
			unsubscribe?.();
			window.removeEventListener("cloud-providers-changed", refresh);
		};
	}, [
		selectedModel,
		activeChatProvider.type,
		activeChatProvider.provider,
		activeChatProvider.model,
		engineRunning,
	]);
	const attachmentTarget = { modelId: selectedModel, activeChatProvider };

	const currentModel = models.find((model) => model.id === selectedModel);
	const currentModelPath = currentModel?.modelPath || currentModel?.path || selectedModel;
	const activeModelName = formatModelName(currentModel?.name || selectedModel);
	const [messages, setMessages] = useState([]);
	// The session the currently-loaded `messages` belong to. During a
	// conversation switch the session id changes a commit before the new
	// history resolves, so reveal/navigation must wait for this to catch up.
	const loadedSessionRef = useRef(null);
	// In-chat find (Ctrl+F): browser-style floating bar scoped to the transcript.
	// Matching runs over the CANONICAL messages (not the rendered window) so
	// older, paginated-out messages stay searchable; the rendered window only
	// supplies the visual highlight for the active result.
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findPosition, setFindPosition] = useState({ active: 0, total: 0 });
	// Bumped to force a re-render when the active result changes; the resolved
	// index itself lives in findActiveRef so it can be read during render.
	const [, setFindTick] = useState(0);
	const findMarksRef = useRef([]);
	const findActiveRef = useRef(0);
	// Identity of the active result ({ messageId, occurrence }), so the current
	// position survives recomputation when messages stream/edit/reorder.
	const findTargetRef = useRef(null);
	// Guards the render-time reset so a new query/session resolves on the first
	// commit instead of a frame later.
	const findKeyRef = useRef("");
	// The last active result whose window was (re)resolved, so a data change that
	// removes a match reveals the next one while an explicit return to the latest
	// messages is not undone.
	const findRevealedRef = useRef(null);
	// Set when navigation should scroll to the active match once its row is
	// mounted (which may require a target window change first).
	const pendingFindScrollRef = useRef(false);
	const pendingJumpBottomRef = useRef(false);
	const closeFindRef = useRef(null);
	const streamBuffer = useStreamBuffer();
	const activeStreamMessageIdRef = useRef(null);
	const loadDisplaySession = (sessionId) =>
		palace.api.loadDisplaySession?.(sessionId) ?? palace.api.loadSession(sessionId);
	const displayMessages = (session) =>
		palace.api.loadDisplaySession ? session.messages : session.messages.map(compactMessageForDisplay);
	const [promptQueue, setPromptQueue] = useState([]);
	const queuePrompt = useCallback((text) => {
		setPromptQueue((previous) => [...previous, { id: Date.now(), text }]);
	}, []);
	const isUserScrolledUp = useRef(false);
	const composerRef = useRef(null);
	// Keep the composer ready to type: when this tab becomes active, when a
	// new chat starts (session change), or when returning to the chat view,
	// move focus into the textarea so typing works without an extra click.
	// Inactive tabs (display:none) never steal focus; streaming never refocuses.
	useEffect(() => {
		if (!tabActive || view !== "chat") return;
		// After paint: the pane just became visible / the new draft mounted.
		const frame = requestAnimationFrame(() => {
			try {
				composerRef.current?.focusInput?.({ preventScroll: true });
			} catch {
				/* Focusing the composer is optional. */
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [tabActive, view, palace.sessionId]);
	const [selectedFiles, setSelectedFiles] = useState([]);
	const [dragActive, setDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [quotedSelection, setQuotedSelection] = useState("");
	// A quoted selection belongs to the visible draft; drop it on chat switch
	// so it can never leak into another conversation.
	useEffect(() => {
		setQuotedSelection("");
	}, [palace.sessionId]);
	const [indexing, setIndexing] = useState(null);
	const fileInputRef = useRef(null);
	const uploadCache = useRef(new Map());
	const clearFiles = useCallback(() => {
		setSelectedFiles([]);
		uploadCache.current.clear();
	}, []);
	const [streaming, setStreaming] = useState(false);
	// Phase 2.1 live steering state. `activeRunId` is minted by the main process
	// and arrives with the generating status event; it is never guessed here.
	const [activeRunId, setActiveRunId] = useState(null);
	const activeRunIdRef = useRef(null);
	const [steeringItems, setSteeringItems] = useState([]);
	const [steeringBusy, setSteeringBusy] = useState(false);
	const [steeringError, setSteeringError] = useState("");
	const [steeringExpanded, setSteeringExpanded] = useState(true);
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
	// Phase 2.1: the main process mints the run id and announces it on the
	// generating status event. Everything steering-related targets this id.
	useEffect(() => {
		const off = window.chatAPI?.onStreamStatus?.(({ sessionId, status, runId }) => {
			if (sessionId !== sessionIdRef.current) return;
			const next = status === "generating" ? runId ?? null : null;
			activeRunIdRef.current = next;
			setActiveRunId(next);
		});
		return off;
	}, []);
	useEffect(() => {
		let current = true;
		setSteeringItems([]);
		setSteeringError("");
		setSteeringBusy(false);
		setActiveRunId(null);
		activeRunIdRef.current = null;
		const sessionId = palace.sessionId;
		if (!sessionId) return undefined;
		window.chatAPI
			?.getSteeringHistory?.(sessionId, 200)
			.then((items) => {
				if (current) {
					setSteeringItems((previous) =>
						mergeSteeringHistory(previous, Array.isArray(items) ? items : []),
					);
				}
			})
			.catch(() => {});
		// A tab can be reopened while its run is still executing.
		window.chatAPI
			?.getActiveRun?.(sessionId)
			.then((run) => {
				if (current && run?.runId) {
					activeRunIdRef.current = run.runId;
					setActiveRunId(run.runId);
				}
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [palace.sessionId]);
	useEffect(() => {
		const off = window.chatAPI?.onSteering?.((event) => {
			if (!event?.id || event.sessionId !== sessionIdRef.current) return;
			setSteeringItems((previous) => mergeSteeringItem(previous, event));
		});
		return off;
	}, []);
	const submitSteering = useCallback(async (content) => {
		const text = typeof content === "string" ? content : "";
		if (!text.trim()) return false;
		const sessionId = sessionIdRef.current;
		let runId = activeRunIdRef.current;
		if (!runId && sessionId) {
			try {
				const run = await window.chatAPI?.getActiveRun?.(sessionId);
				runId = run?.runId ?? null;
			} catch {
				/* reported below as no active run */
			}
		}
		if (!sessionId || !runId) {
			setSteeringError(
				"The run has already ended. Your instruction was kept in the composer.",
			);
			return false;
		}
		setSteeringError("");
		setSteeringBusy(true);
		try {
			const result = await window.chatAPI.steer({
				sessionId,
				runId,
				content: text.trim(),
				idempotencyKey: crypto.randomUUID(),
			});
			if (result?.record) {
				activeRunIdRef.current = runId;
				setActiveRunId(runId);
				setSteeringItems((previous) => mergeSteeringItem(previous, result.record));
			}
			// Clear only when the draft still matches, so text typed while the
			// submission was in flight is never discarded.
			composerRef.current?.clearSubmitted(text, sessionId);
			return true;
		} catch (error) {
			setSteeringError(
				error?.message ||
					"Could not send the steering instruction. Your text was kept.",
			);
			return false;
		} finally {
			setSteeringBusy(false);
		}
	}, []);
	const withdrawSteering = useCallback(async (item) => {
		const sessionId = sessionIdRef.current;
		const runId = item?.runId ?? activeRunIdRef.current;
		if (!sessionId || !runId || !item?.id) return;
		setSteeringError("");
		try {
			const record = await window.chatAPI.cancelSteering({
				sessionId,
				runId,
				steeringId: item.id,
			});
			if (record) {
				setSteeringItems((previous) => mergeSteeringItem(previous, record));
			}
		} catch (error) {
			setSteeringError(
				error?.message || "Could not withdraw that instruction.",
			);
		}
	}, []);
	const steeringForRun = useMemo(
		() => visibleSteeringForRun(steeringItems, activeRunId),
		[activeRunId, steeringItems],
	);
	// Delivered instructions are attached to the reply's persisted run id, not
	// to the live panel. This keeps the footer accurate after a reload and while
	// later turns are running.
	const additionalPromptsFor = useCallback(
		(message) =>
			message?.role === "assistant"
				? steeringPromptsForRun(steeringItems, steeringRunIdForMessage(message))
				: [],
		[steeringItems],
	);
	// Questions the agent asked and skill-registration decisions the user made
	// while this reply's run executed. They are resolved from the recorded steps
	// only, and they move into the reply footer so the completed task keeps one
	// record of everything the user contributed mid-run.
	const turnInteractionsFor = useCallback(
		(message) =>
			message?.role === "assistant"
				? getTurnInteractions(activeStepsOf(message), {
						pendingQuestions,
						getSkillDecision: readSkillDecision,
					})
				: [],
		[pendingQuestions],
	);
	// Restore the transcript for a tab rehydrated from persisted state. Only
	// committed chats exist in the database; a never-sent tab has no row yet,
	// so its empty history is correct and must not raise an error.
	useEffect(() => {
		const sessionId = palace.sessionId;
		if (!sessionId || !tabSaved || !palace.api) return;
		let current = true;
		setLoading(true);
		setSummarizeNotice("");
		loadDisplaySession(sessionId)
			.then((session) => {
				if (!current) return;
				setMessages(displayMessages(session));
				loadedSessionRef.current = sessionId;
			})
			.catch((error) => {
				// The session can disappear between restore and this read.
				if (current) {
					setMessages([]);
					loadedSessionRef.current = sessionId;
				}
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [palace.sessionId, tabSaved, palace.api]);
	const [groups, setGroups] = useState([]);
	// Permission context for the visible chat: an existing session takes its
	// project from its own row (the tab may have been re-bound meanwhile), a
	// fresh chat falls back to the tab's project binding. A project without a
	// connected root behaves as a casual chat — availablePermissionModes and
	// the backend normalizeMode both encode that rule from the shared catalog.
	const activeProject = projects.find((candidate) => candidate.id === activeProjectId) ?? null;
	// Grouped rows are only rebuilt when the history listing or active session
	// changes, not on every transcript render.
	const sessionRow = useMemo(
		() => groups.flatMap((group) => group.sessions).find((row) => row.id === palace.sessionId),
		[groups, palace.sessionId],
	);
	const project = sessionRow
		? (projects.find((candidate) => candidate.id === sessionRow.project_id) ?? null)
		: activeProject;
	const chatProjectId = sessionRow ? (sessionRow.project_id ?? null) : (activeProjectId ?? null);
	const permissionMode = resolveChatPermissionMode({
		sessionId: palace.sessionId,
		currentSessionId: palace.sessionId,
		tabMode: tabPermissionMode,
		sessionMode: permissionBySession[palace.sessionId],
		project,
	});
	// Authoritative sidebar mode: the session row's project wins for existing
	// chats, the tab's project binding for fresh drafts — never the sidebar's
	// own visibility or tab state.
	const isWorkspaceChat = getSidebarMode(chatProjectId) === "workspace";
	// Skill proposals awaiting review above the composer. Resolved decisions
	// persist per step id in localStorage; the transcript shows the outcome.
	// Decision changes have their own version counter so derivation only re-runs
	// when the transcript or a decision actually changed — not on every render,
	// which would rescan every message and its nested steps (with a localStorage
	// read per `propose_skill` step).
	const [skillDecisionVersion, bumpSkillDecisions] = useState(0);
	const skillProposals = useMemo(
		() => pendingSkillProposals(messages, readSkillDecision),
		[messages, skillDecisionVersion],
	);
	const changePermissionMode = (mode) => {
		setPermissionBySession((current) => ({ ...current, [palace.sessionId]: mode }));
		onTabUpdate?.({ permissionMode: mode });
	};
	const [historyError, setHistoryError] = useState("");
	// Casual-chat summarization notice: a slim inline line near the composer,
	// set only when a sent prompt's reply save hits the compression lock.
	// Workspace chats keep the full-width error section instead.
	const [summarizeNotice, setSummarizeNotice] = useState("");
	const [loading, setLoading] = useState(false);
	const [editing, setEditing] = useState(null);
	const [editText, setEditText] = useState("");
	const busyRef = useRef(false);

	const refreshHistory = useCallback(async () => {
		if (palace.api) setGroups(await fetchSessionGroups(palace.api));
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
		onTabUpdate?.({
			title: "New chat",
			status: "idle",
			permissionMode: defaultPermissionMode(activeProject),
		});
		pendingAgent.current = null;
		pendingSend.current = null;
		setPromptQueue([]);
		palace.setSessionId(crypto.randomUUID());
		setMessages([]);
		clearFiles();
		setEditing(null);
		palace.setDraftTokens(0);
	};
	const newWorkspaceChat = async (projectId) => {
		if (busyRef.current || agentLoading) return;
		if (!chatAvailable || !selectedModel) {
			setHistoryError("Select and start a model before creating a workspace chat.");
			return;
		}
		if (!projectId) return;
		busyRef.current = true;
		setIndexing(null);
		setLoading(true);
		setHistoryError("");
		try {
			const id = crypto.randomUUID();
			await palace.api.getOrCreateSession(id, selectedModel, projectId);
			const targetProject = projects.find((candidate) => candidate.id === projectId) ?? null;
			pendingAgent.current = null;
			pendingSend.current = null;
			setPromptQueue([]);
			palace.setSessionId(id);
			onTabUpdate?.({
				title: "New chat",
				status: "idle",
				projectId,
				permissionMode: defaultPermissionMode(targetProject),
			});
			setMessages([]);
			clearFiles();
			setEditing(null);
			palace.setDraftTokens(0);
			onChat();
			await refreshHistory();
		} catch (err) {
			setHistoryError(err.message);
		} finally {
			busyRef.current = false;
			setLoading(false);
		}
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
			// Resolve the mode while the tab still points at the outgoing
			// session, so the tab's stored mode only applies when it is the
			// same chat being reloaded (never a stale mode leaking sideways).
			const targetProject = session.project_id
				? (projects.find((candidate) => candidate.id === session.project_id) ?? null)
				: null;
			const nextPermissionMode = resolveChatPermissionMode({
				sessionId: id,
				currentSessionId: palace.sessionId,
				tabMode: tabPermissionMode,
				sessionMode: permissionBySession[id],
				project: targetProject,
			});
			palace.setSessionId(id);
			onTabUpdate?.({
				title: session.title || "Untitled chat",
				modelId: session.model_id || selectedModel,
				projectId: session.project_id ?? null,
				permissionMode: nextPermissionMode,
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
			onTabUpdate?.({
				projectId,
				title: "New chat",
				permissionMode: defaultPermissionMode(
					projects.find((candidate) => candidate.id === projectId) ?? null,
				),
			});
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
	// Progressive transcript rendering: only the newest slice of the canonical
	// conversation is mounted; older messages are revealed on scroll. The full
	// `messages` collection stays untouched for inference, persistence, export,
	// search, editing and regeneration (see lib/transcriptWindow.mjs).
	const transcript = useTranscriptWindow({
		messages,
		sessionId: palace.sessionId,
		scrollRef: messagesRef,
		// Phase 8: the virtualized mounted-row hook anchors the scroll position
		// (using prefix sums), so this window hook must not anchor as well.
		anchoring: false,
	});
	// Phase 8: bound the mounted rows to the viewport plus overscan. The logical
	// window above still grows by older pages; virtualization only decides which
	// slice of it is mounted. `focusedRowId`/`editing` are pinned so a control the
	// user is interacting with is never unmounted mid-interaction.
	const [focusedRowId, setFocusedRowId] = useState(null);
	const pinnedIds = useMemo(() => {
		const set = new Set();
		if (editing != null) set.add(String(editing));
		if (focusedRowId != null) set.add(String(focusedRowId));
		return set.size ? set : null;
	}, [editing, focusedRowId]);
	const virtual = useTranscriptVirtual({
		messages: transcript.visibleMessages,
		sessionId: palace.sessionId,
		scrollRef: messagesRef,
		pinnedIds,
	});
	// Open the find bar on Ctrl/Cmd+F, pre-filling the transcript selection.
	// Capture phase on window: fires before any in-page bubble handler, so the
	// shortcut works no matter which element has focus (chat text, whitespace
	// gutters, composer, sidebar). `code` is matched alongside `key` so
	// non-Latin keyboard layouts still trigger on the physical F key.
	useEffect(() => {
		const onFindKey = (event) => {
			if (event.key === "Escape" && findOpen) {
				closeFindRef.current?.();
				return;
			}
			if (!(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() !== "f" && event.code !== "KeyF") return;
			event.preventDefault();
			let selected = "";
			try {
				selected = extractScopedSelectionText(
					messagesRef.current,
					window.getSelection?.() ?? null,
				);
			} catch {
				selected = "";
			}
			if (selected) setFindQuery(selected.slice(0, 200));
			setFindOpen(true);
		};
		window.addEventListener("keydown", onFindKey, { capture: true });
		return () => window.removeEventListener("keydown", onFindKey, { capture: true });
	}, [findOpen]);
	// Track which transcript row holds focus so virtualization never unmounts the
	// row the user is typing in or tabbing through (Phase 8).
	useEffect(() => {
		const node = messagesRef.current;
		if (!node) return;
		const onFocusIn = (event) => {
			const row = event.target?.closest?.("[data-message-id]");
			setFocusedRowId(row ? row.getAttribute("data-message-id") : null);
		};
		const onFocusOut = () => setFocusedRowId(null);
		node.addEventListener("focusin", onFocusIn, true);
		node.addEventListener("focusout", onFocusOut, true);
		return () => {
			node.removeEventListener("focusin", onFocusIn, true);
			node.removeEventListener("focusout", onFocusOut, true);
		};
	}, [palace.sessionId]);
	// Canonical matches for the current query. Memoized on the canonical array
	// and query, so unrelated renders (scroll, sidebar, layout) never rescan the
	// conversation. Streaming/edits replace `messages`, which correctly recomputes.
	const findMatches = useMemo(
		() => (!findOpen || !findQuery.trim() ? [] : findMessageMatches(messages, findQuery)),
		[findOpen, findQuery, messages],
	);
	const findMatchesRef = useRef(findMatches);
	findMatchesRef.current = findMatches;
	// Reset tracking when the query, find visibility, or conversation changes.
	// Guarded and idempotent, so a target from another query/session can never be
	// applied and the first commit for a new query already knows to scroll.
	const findKey = `${palace.sessionId}\u0000${findOpen}\u0000${findQuery}`;
	if (findKeyRef.current !== findKey) {
		findKeyRef.current = findKey;
		findTargetRef.current = null;
		findActiveRef.current = 0;
		findRevealedRef.current = null;
		pendingFindScrollRef.current = findOpen && findQuery.trim().length > 0;
	}
	// Resolve the active result by stable identity. If the tracked result is
	// gone (edited/deleted/regenerated), fall back to the clamped index so the
	// bar never points at a stale message.
	const activeIndex = resolveActiveMatchIndex(findMatches, findTargetRef.current, findActiveRef.current);
	const activeMatch = findMatches[activeIndex] ?? null;
	findActiveRef.current = activeIndex;
	if (activeMatch)
		findTargetRef.current = { messageId: activeMatch.messageId, occurrence: activeMatch.occurrence };
	// Bring the active result into the rendered window with a bounded target
	// window (never mounting every message between it and the newest reply).
	// Runs on navigation and when a data change moves the active result, but not
	// merely because the result is off-window: streaming output and an explicit
	// "jump to latest" must never yank the viewport back to an old hit.
	useEffect(() => {
		if (!findOpen || !activeMatch) return;
		// A conversation switch changes the session id a commit before the new
		// history loads; never navigate using the previous session's messages.
		if (loadedSessionRef.current !== palace.sessionId) return;
		const revealed = findRevealedRef.current;
		const changed =
			!revealed ||
			revealed.messageId !== activeMatch.messageId ||
			revealed.occurrence !== activeMatch.occurrence;
		if (!pendingFindScrollRef.current && !changed) return;
		findRevealedRef.current = {
			messageId: activeMatch.messageId,
			occurrence: activeMatch.occurrence,
		};
		pendingFindScrollRef.current = true;
		if (!transcript.containsMessage(activeMatch.messageId)) {
			transcript.showTarget(activeMatch.messageId);
			// The bounded target window replaces the suffix window; anchor the
			// virtual range to its top so the target row is mounted.
			virtual.resetToStart();
		} else {
			// Already in the window: make sure the virtual range includes it.
			virtual.scrollToKey(activeMatch.messageId, { align: "center" });
		}
	}, [
		findOpen,
		activeMatch,
		transcript.containsMessage,
		transcript.showTarget,
		transcript.visibleMessages,
		virtual.resetToStart,
		virtual.scrollToKey,
	]);
	// Paint highlights over the rendered window and scroll to the active match.
	useLayoutEffect(() => {
		const scope = messagesRef.current;
		if (!findOpen || !findQuery.trim()) {
			if (scope) clearFindMarks(scope);
			findMarksRef.current = [];
			setFindPosition({ active: 0, total: 0 });
			return;
		}
		if (!scope) return;
		const marks = applyFindMarks(scope, findQuery);
		findMarksRef.current = marks;
		let markIndex = -1;
		let row = null;
		if (activeMatch && activeMatch.messageId != null) {
			markIndex = markIndexForMessage(scope, marks, activeMatch.messageId, activeMatch.occurrence);
			// The exact segment may be hidden (e.g. collapsed content); still show
			// the owning row so the result is visible.
			if (markIndex === -1)
				row = scope.querySelector(`[data-message-id="${CSS.escape(String(activeMatch.messageId))}"]`);
		}
		setActiveFindMark(marks, markIndex);
		setFindPosition({ active: activeIndex, total: findMatches.length });
		if (pendingFindScrollRef.current) {
			const target = markIndex >= 0 ? marks[markIndex] : row;
			if (target) {
				pendingFindScrollRef.current = false;
				// Stop auto-follow so the jump is never yanked back to bottom.
				isUserScrolledUp.current = true;
				scrollMarkIntoView(scope, target);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [findOpen, findQuery, findMatches, activeIndex, transcript.visibleMessages, virtual.first, virtual.last, streaming]);
	const closeFind = useCallback(() => {
		if (messagesRef.current) clearFindMarks(messagesRef.current);
		findMarksRef.current = [];
		findActiveRef.current = 0;
		findTargetRef.current = null;
		pendingFindScrollRef.current = false;
		setFindPosition({ active: 0, total: 0 });
		setFindOpen(false);
	}, []);
	useEffect(() => {
		closeFindRef.current = closeFind;
	}, [closeFind]);
	const stepFind = useCallback((direction) => {
		const list = findMatchesRef.current;
		const total = list.length;
		if (!total) return;
		const next = (findActiveRef.current + direction + total) % total;
		const match = list[next];
		findTargetRef.current = match
			? { messageId: match.messageId, occurrence: match.occurrence }
			: null;
		findActiveRef.current = next;
		pendingFindScrollRef.current = true;
		setFindTick((tick) => tick + 1);
	}, []);
	// Leave a search-navigation window for the newest messages.
	const jumpToLatest = useCallback(() => {
		pendingJumpBottomRef.current = true;
		transcript.followLatest();
		virtual.resetToEnd();
	}, [transcript.followLatest, virtual.resetToEnd]);
	const onStreamFrame = useCallback(() => {
		if (!isUserScrolledUp.current && messagesRef.current)
			messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "auto" });
	}, []);
	const abortRef = useRef(null);
	useEffect(() => () => abortRef.current?.abort(), []);
	// Latest transcript/session for the send flow: the "first prompt" decision
	// must never read a stale render's messages.
	const loadedMessagesRef = useRef(messages);
	useEffect(() => {
		loadedMessagesRef.current = messages;
	}, [messages]);
	const sessionIdRef = useRef(palace.sessionId);
	useEffect(() => {
		sessionIdRef.current = palace.sessionId;
	}, [palace.sessionId]);
	// The first prompt's pending AI title, requested once the first reply finishes.
	const pendingTitleGen = useRef(null);
	useEffect(() => {
		if (!streaming) return;
		const timer = setTimeout(palace.schedule, 250);
		return () => clearTimeout(timer);
	}, [messages, streaming, palace.schedule]);
	const handleScroll = (event) => {
		// Ignore scroll events bubbling from code blocks inside a message.
		if (event.target !== event.currentTarget) return;
		const node = event.currentTarget;
		const { scrollTop, scrollHeight, clientHeight } = node;
		const distanceToBottom = scrollHeight - (scrollTop + clientHeight);
		isUserScrolledUp.current = distanceToBottom > 50;
		// Approaching the top reveals the next page of older messages. Capture the
		// visible anchor first so prepended rows never shift the reader's view.
		// Duplicate triggers within one expansion are ignored inside loadOlder.
		if (scrollTop <= OLDER_SCROLL_THRESHOLD_PX && transcript.hasOlder) {
			// Capture the visible anchor before the window grows so prepended rows
			// never shift the reader's view. Duplicate triggers within one
			// expansion are ignored inside loadOlder.
			virtual.beginHold();
			transcript.loadOlder();
		} else if (transcript.hasNewer && distanceToBottom <= OLDER_SCROLL_THRESHOLD_PX) {
			virtual.beginHold();
			transcript.loadNewer();
		}
		// Keep the mounted virtual range in step with the scroll position. This
		// only re-renders when the range actually changes.
		virtual.onScroll(node);
	};
	useLayoutEffect(() => {
		isUserScrolledUp.current = false;
		// Row UI state (expanded blocks) is session-scoped; never carry one
		// conversation's toggles into another (Phase 8).
		clearRowUiState();
	}, [palace.sessionId]);
	// Follow before paint so growing Markdown does not briefly move the viewport.
	// Direct scrolling affects only the chat pane and never queues animations.
	// Re-runs when the mounted tail grows or rows change height so the newest
	// message stays pinned while following.
	useLayoutEffect(() => {
		if (!isUserScrolledUp.current && messagesRef.current) {
			messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "auto" });
		}
	}, [messages, virtual.last, virtual.heightsVersion]);
	// After leaving a search-navigation window, land on the newest messages.
	useLayoutEffect(() => {
		if (!pendingJumpBottomRef.current) return;
		const node = messagesRef.current;
		if (!node) return;
		pendingJumpBottomRef.current = false;
		isUserScrolledUp.current = false;
		node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
	}, [transcript.visibleMessages]);
	const MIME_FALLBACK_EXT = {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
		"application/pdf": ".pdf",
		"text/plain": ".txt",
		"text/markdown": ".md",
		"text/csv": ".csv",
	};
	const isImageFile = (file) =>
		/\.(png|jpe?g|gif|webp)$/i.test(file.name || "") || /^image\/(png|jpe?g|gif|webp)$/i.test(file.type || "");
	// Pasted/dropped clipboard images often arrive unnamed ("image.png" or no
	// name at all). Derive a name from the MIME type so policy checks,
	// previews, and uploads treat them like chosen files.
	const normalizeIncomingFiles = (files) =>
		files.map((file, index) => {
			if (file?.name?.includes?.(".")) return file;
			const ext = MIME_FALLBACK_EXT[file?.type] ?? "";
			if (!ext) return file;
			const name = `pasted-image-${Date.now()}-${index}${ext}`;
			try {
				return new File([file], name, { type: file.type, lastModified: file.lastModified ?? Date.now() });
			} catch {
				return file;
			}
		});
	const addAttachments = async (files) => {
		if (busyRef.current) {
			setHistoryError("Wait for the current send to finish before attaching files.");
			return;
		}
		files = normalizeIncomingFiles(files.filter(Boolean));
		if (!files.length) return;
		const next = [...selectedFiles, ...files];
		if (
			next.length > 10 ||
			next.some((file) => file.size > 20 * 1024 * 1024) ||
			next.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024
		) {
			setHistoryError("Choose up to 10 files, at most 20 MB each and 50 MB total.");
			return;
		}
		busyRef.current = true;
		try {
			const policy = window.api?.getAttachmentPolicy
				? await window.api.getAttachmentPolicy(attachmentTarget)
				: uploadPolicy;
			assertAttachmentNames(
				files.map((file) => file.name),
				policy,
			);
			setUploadPolicy(policy);
		} catch (error) {
			busyRef.current = false;
			setHistoryError(error.message);
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
				if (!isImageFile(file)) {
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
				const uploaded = await window.api.processUploads(documents, attachmentTarget);
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
			// A quoted transcript selection travels as context above fresh prompts
			// (never on edits, retries, or queued sends, which bake it in at
			// queue time instead).
			const text = retry
				? ""
				: edit
					? editText.trim()
					: combineQuotedMessage(!queued ? quotedSelection : "", submittedText);
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
			setSummarizeNotice("");
			// The session row is created from here on, so the tab becomes a
			// restorable chat rather than a blank one.
			onTabSaved?.(palace.sessionId);
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
				if (!queued && !edit && !retry && selectedFiles.length) {
					const policy = await window.api.getAttachmentPolicy({
						modelId: selectedModel,
						activeChatProvider,
					});
					assertAttachmentNames(
						selectedFiles.map((file) => file.name),
						policy,
					);
				}
				// Create/bind the session row before generation so the backend
				// resolves the same project context (and therefore permission
				// normalization) as the selector shown in the composer.
				await palace.api.getOrCreateSession(palace.sessionId, selectedModel, chatProjectId);
				if (edit) setEditing(null);
				let attachments = [];
				if (!queued && !edit && !retry && selectedFiles.length) {
					if (!window.api?.processUploads)
						throw new Error("File uploads are available in the desktop app.");
					const pending = selectedFiles.filter((file) => !uploadCache.current.has(file));
					if (pending.length) {
						const uploaded = await window.api.processUploads(pending, {
							modelId: selectedModel,
							activeChatProvider,
						});
						pending.forEach((file, index) => uploadCache.current.set(file, uploaded[index]));
					}
					attachments = selectedFiles.map((file) => uploadCache.current.get(file));
				}
				controller.signal.throwIfAborted();
				const requestMessages = edit
					? undefined
					: await palace.prepareMessages(text, retry, attachments);
				// The first prompt names the chat (placeholder now, AI title after
				// the first reply). Later prompts, edits and retries never touch
				// the title again — it stays locked until a manual rename.
				const placeholderTitle = firstPromptTitle(text, {
					edit,
					retry,
					hasMessages: loadedMessagesRef.current.length > 0,
				});
				if (placeholderTitle) {
					onTabUpdate?.({ title: placeholderTitle });
					pendingTitleGen.current = {
						sessionId: palace.sessionId,
						prompt: text.trim(),
						modelId: selectedModel,
						activeChatProvider,
					};
				}
				prepared = true;
				if (!queued && !edit && !retry) {
					composerRef.current?.clearSubmitted(submittedText, draftSessionId);
					clearFiles();
					setQuotedSelection("");
				}
				const saved = await loadDisplaySession(palace.sessionId);
				setMessages([...displayMessages(saved), assistantMsg]);
				await refreshHistory();
				const result = await runDesktopChat({
					activeChatProvider,
					permissionMode,
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
									? {
											...message,
											executionSteps: compactStepsForDisplay(
												steps,
												message.executionSteps,
											),
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
					onPhase: (event) => {
						palace.noteLivePhase?.(event);
					},
					onText: (delta) => {
						streamBuffer.push(delta);
					},
				});
				if (result?.runId) {
					setMessages((prev) =>
						prev.map((message) =>
							message.id === assistantMsg.id
								? { ...message, run_id: result.runId }
								: message,
						),
					);
				}
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
									message.id === assistantMsg.id
										? { ...compactMessageForDisplay(saved), streaming: false }
										: message,
								),
							);
						else setMessages((prev) => prev.filter((message) => message.id !== assistantMsg.id));
					} catch (error) {
						const notice = summarizeNoticeFor({ message: error?.message, isWorkspaceChat });
						if (notice) setSummarizeNotice(notice);
						else setHistoryError(`Could not save reply: ${error.message}`);
						setMessages((prev) => prev.filter((message) => message.id !== assistantMsg.id));
					}
				} else {
					setMessages((prev) => prev.filter((message) => message.id !== assistantMsg.id));
					palace.setDraftTokens(0);
				}
				setMessages((prev) =>
					prev.map((message) => (message.streaming ? { ...message, streaming: false } : message)),
				);
				// Turn over: persisted telemetry (via finishMessage's refresh)
				// supersedes live per-request updates from this point on.
				palace.clearLiveTelemetry?.();
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
				activeRunIdRef.current = null;
				setActiveRunId(null);
				setIndexing(null);
				busyRef.current = false;
				// The first prompt's AI title: requested now that the engine is
				// free, so generation never competes with the main reply. The main
				// process applies it only if the title is unchanged (a manual
				// rename wins), and the tab follows only while this session is
				// still open here.
				const titleJob = pendingTitleGen.current;
				pendingTitleGen.current = null;
				if (titleJob) {
					void (async () => {
						try {
							const result = await window.memoryPalace?.generateSessionTitle?.(titleJob);
							if (!result?.applied || !result.title) return;
							if (sessionIdRef.current === titleJob.sessionId)
								onTabUpdate?.({ title: result.title });
							await refreshHistory().catch(() => {});
						} catch (error) {
							// Keep the prompt placeholder when generation fails.
							console.warn("Chat title generation failed:", error);
						}
					})();
				}
				abortRef.current = null;
			}
		},
		[
			editText,
			selectedFiles,
			quotedSelection,
			clearFiles,
			selectedModel,
			permissionMode,
			chatProjectId,
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
						status: message.status,
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
			status: "in_progress",
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
			setMessages((previous) =>
				previous.map((row) =>
					row.id === message.id ? compactMessageForDisplay(result.message) : row,
				),
			);
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
				setMessages((previous) =>
					previous.map((row) => (row.id === message.id ? compactMessageForDisplay(saved) : row)),
				);
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
	const answerQuestion = useCallback(
		(request, answer) => window.chatAPI.respondToAskUser(request.requestId, request.questionId, answer),
		[],
	);
	const selectMessageBranch = async (message, offset) => {
		if (busyRef.current || !palace.api) return;
		const siblings = message.siblings || [];
		const targetId = siblings[siblings.indexOf(message.id) + offset];
		if (!targetId) return;
		busyRef.current = true;
		setLoading(true);
		try {
			setMessages(
				(await palace.api.selectMessageBranch(palace.sessionId, targetId)).map(
					compactMessageForDisplay,
				),
			);
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
	// Stage a transcript excerpt as a quoted block above the composer (the
	// Selection chip). The user reviews it, optionally types alongside it, and
	// submits manually; sendMessage prepends the quote to fresh sends and
	// clears the chip on submit.
	const askAboutSelection = useCallback((selectedText) => {
		const excerpt = String(selectedText ?? "").trim();
		if (!excerpt) return;
		setQuotedSelection(excerpt);
		try {
			composerRef.current?.focusInput?.();
		} catch {
			/* Focusing the composer is optional. */
		}
	}, []);
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
			<LeftSidebarState isSidebarOpen={isSidebarOpen}>
				{(isSidebarOpen) => (
			<div
				id="chat-sidebar"
				aria-hidden={!isSidebarOpen}
				inert={isSidebarOpen ? undefined : ""}
				className={`relative z-20 h-full shrink-0 ${isSidebarOpen ? "w-[272px] max-[650px]:w-[220px]" : "w-0"}`}
			>
				{/*
				 * The spacer element above owns the transcript's available width.
				 * It changes size once per toggle (a single layout) and never
				 * animates width, so the transcript is not re-laid-out on every
				 * animation frame. Only this inner panel is animated, and only
				 * with translate/opacity — properties that do not cause layout.
				 */}
				<div
					className={`absolute inset-y-0 left-0 w-[272px] max-[650px]:w-[220px] overflow-hidden transition-[translate,opacity] duration-300 ease-in-out motion-reduce:transition-none ${isSidebarOpen ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"}`}
				>
					<Sidebar
						projects={projects}
						view={view}
						activeProjectId={activeProjectId}
						onProjects={onProjects}
						onProject={onProject}
						onCreateProject={onCreateProject}
						onChat={onChat}
						isWorkspace={isWorkspaceChat}
						chatProjectId={chatProjectId}
						onNewWorkspaceChat={() => newWorkspaceChat(chatProjectId)}
						canStartChat={!!chatAvailable && !!selectedModel}
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
								else if (kind === "Rename") {
									await palace.api.renameSession(id, value);
									// A manual rename is the locked title — reflect it in the
									// open tab instead of waiting for the session to reload.
									if (id === palace.sessionId) onTabUpdate?.({ title: value.trim() });
								} else if (kind === "Move to Folder") await palace.api.moveSession(id, value);
								else {
									await palace.api.deleteSession(id);
									if (id === palace.sessionId) {
										onTabUpdate?.({
											title: "New chat",
											status: "idle",
											permissionMode: defaultPermissionMode(activeProject),
										});
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
			</div>
				)}
			</LeftSidebarState>
			{renderWorkspace?.({
				groups,
				loadChat,
				startProjectChat,
				busy: streaming || loading || agentLoading,
				canStartChat: !!chatAvailable && !!selectedModel,
			})}
			<div
				style={view === "chat" ? undefined : { display: "none" }}
				className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none"
			>
				{/* bg-[var(--bg-secondary)]!  */}
				{historyError && (
					<p
						role="alert"
						className="p-2 text-[var(--error-soft)]"
					>
						{historyError}
					</p>
				)}
				{findOpen && view === "chat" && (
					<ChatFindBar
						query={findQuery}
						onQueryChange={setFindQuery}
						active={findPosition.active}
						total={findPosition.total}
						onPrev={() => stepFind(-1)}
						onNext={() => stepFind(1)}
						onClose={closeFind}
					/>
				)}
				{transcript.hasNewer && (
					<button
						type="button"
						aria-label="Jump to latest"
						onClick={jumpToLatest}
						className="absolute bottom-4 right-4 z-[55] flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5 text-xs text-[var(--text-secondary)] shadow-[0_4px_20px_var(--window-shadow)] transition-colors hover:text-[var(--text-primary)]"
					>
						<FiArrowDown aria-hidden="true" />
						Jump to latest
					</button>
				)}
				<div
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-auto px-4 py-6 max-[450px]:px-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-[var(--scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-[3px] [&::-webkit-scrollbar-thumb]:bg-[var(--scrollbar-thumb)]"
					ref={messagesRef}
					onScroll={handleScroll}
				>
					<div
						data-transcript-list=""
						data-window-count={transcript.visibleMessages.length}
						data-window-first-id={transcript.visibleMessages[0]?.id ?? ""}
						data-window-last-id={transcript.visibleMessages.at(-1)?.id ?? ""}
						data-vt-first={virtual.first}
						data-vt-last={virtual.last}
						data-vt-mounted={virtual.mountedCount}
						className={`mx-auto flex min-h-full w-full flex-col gap-7 ${
							isWorkspaceChat ? "max-w-[860px] pb-10" : "max-w-[960px]"
						}`}
					>
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
						) : isWorkspaceChat ? (
							<>
								{virtual.topSpacer > 0 && (
									<div aria-hidden="true" style={{ height: virtual.topSpacer }} />
								)}
								{virtual.mountedMessages.map((msg, i) => (
									<WorkspaceMessage
										key={msg?.id ?? `ws-${virtual.first + i}`}
										message={msg}
										index={virtual.first + i}
										lastMessageId={messages.at(-1)?.id ?? null}
										streamBuffer={streamBuffer}
										activeStreamMessageId={activeStreamMessageIdRef.current}
										onStreamFrame={onStreamFrame}
										projectId={chatProjectId}
										pendingQuestions={pendingQuestions}
										disabled={streaming || loading}
										onSelectReplyVariant={selectReplyVariant}
										activeModelName={activeModelName}
										selectedModel={selectedModel}
										sessionAgent={sessionAgent}
										avatarSettings={avatarSettings}
										onDelete={(id) => handleMessageAction("delete", id)}
										onBranch={(id) => handleMessageAction("branch", id)}
										onRegenerate={regenerateReply}
										onStartEdit={(messageToEdit) => {
											setEditing(messageToEdit.id);
											setEditText(messageToEdit.content);
										}}
										onError={setHistoryError}
										editing={editing}
										editText={editText}
										onEditChange={setEditText}
										onCancelEdit={() => setEditing(null)}
										onSubmitEdit={(messageToEdit) => sendMessage(messageToEdit)}
										registerRow={virtual.getMeasureRef}
										steeringPrompts={additionalPromptsFor(msg)}
										steeringInteractions={turnInteractionsFor(msg)}
									/>
								))}
								{virtual.bottomSpacer > 0 && (
									<div aria-hidden="true" style={{ height: virtual.bottomSpacer }} />
								)}
							</>
						) : (
							<>
								{virtual.topSpacer > 0 && (
									<div aria-hidden="true" style={{ height: virtual.topSpacer }} />
								)}
								{virtual.mountedMessages.map((msg, i) => {
									const windowIndex = virtual.first + i;
									const isEditing = editing === msg.id && msg.id;
									return (
										<div
											key={msg.id ?? `message-${windowIndex}`}
											ref={virtual.getMeasureRef(
												msg.id != null ? String(msg.id) : `__vt_${msg.role ?? "m"}_${windowIndex}`,
											)}
											data-message-id={msg.id}
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
														<div className="mt-1">
															<AttachmentPreview
																attachments={msg.attachments}
															/>
														</div>
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
															streamBuffer={
																msg.streaming &&
																activeStreamMessageIdRef.current === msg.id
																	? streamBuffer
																	: undefined
															}
															onStreamFrame={onStreamFrame}
															// Skill proposals register against the chat's own
															// project (session row, else the tab binding) —
															// never the currently selected tab's project.
															projectId={chatProjectId}
															pendingQuestions={pendingQuestions}
															onAnswerQuestion={answerQuestion}
															showHeader={false}
															disabled={streaming || loading}
															onSelectReplyVariant={selectReplyVariant}
															mode="casual"
															interactive={false}
															// Resolved questions/skills render inside the reply's
															// Additional prompts footer, so the inline footer is
															// suppressed here.
															showTurnOutcomes={false}
														/>
													) : (
														msg.content ||
														(msg.streaming || msg.attachments?.length
															? ""
															: "...")
													)}
													{/** Attachments inside bubble during view mode **/}
													{msg.attachments?.length > 0 && (
														<div className="mt-2">
															<AttachmentPreview
																attachments={msg.attachments}
															/>
														</div>
													)}
												</div>
												{msg.role !== "assistant" && (
													<MessageContextStatus message={msg} />
												)}
												{/** Actions toolbar **/}
												{["user", "assistant"].includes(msg.role) && (
													<MessageActions
														message={msg}
														disabled={streaming || loading || !palace.api}
														onDelete={(id) => handleMessageAction("delete", id)}
														onBranch={(id) => handleMessageAction("branch", id)}
														onRegenerate={() => regenerateReply(msg)}
														onSelectReplyVariant={selectReplyVariant}
														onSelectPromptVersion={(offset) =>
															selectMessageBranch(msg, offset)
														}
														isLast={windowIndex === transcript.visibleMessages.length - 1}
														onEdit={(messageToEdit) => {
															setEditing(messageToEdit.id);
															setEditText(messageToEdit.content);
														}}
														onError={setHistoryError}
													/>
												)}
												{/** Steering instructions and resolved interactions from this run. **/}
												{msg.role === "assistant" && !msg.streaming && (
													<AdditionalPrompts
														prompts={additionalPromptsFor(msg)}
														interactions={turnInteractionsFor(msg)}
													/>
												)}
											</>
										)}
									</div>
								);
							})}
								{virtual.bottomSpacer > 0 && (
									<div aria-hidden="true" style={{ height: virtual.bottomSpacer }} />
								)}
							</>
						)}
					</div>
				</div>
				{/* Pending questions and skill approvals stay anchored above the
				composer, independent of conversation scroll. The transcript
				below keeps only the resolved outcome at the step's position. */}
				{/* Transcript text-selection menu (Copy / Ask question). Scoped to
				the transcript scroll container, so it appears only for chat
				transcript selections in both Casual and Workspace modes. */}
				<TextSelectionMenu
					scopeRef={messagesRef}
					onAskQuestion={askAboutSelection}
				/>
				<PendingInteractions
					pendingQuestions={pendingQuestions}
					skillProposals={skillProposals}
					onAnswerQuestion={answerQuestion}
					onDecision={() => bumpSkillDecisions((version) => version + 1)}
					projectId={chatProjectId}
				/>
				{selectedFiles.length > 0 && (
					<div
						aria-label="Selected attachments"
						className={`mx-auto mb-3 flex w-[calc(100%-2rem)] max-h-36 shrink-0 gap-2 overflow-auto border-t border-[var(--border)] py-2 max-w-[980px]`}
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

				{summarizeNotice && !isWorkspaceChat && (
					<p className="mx-auto w-[calc(100%-2rem)] max-w-[980px] px-1 pb-1 text-[11px] leading-relaxed text-[var(--text-muted)] max-[450px]:w-[calc(100%-1.5rem)]">
						{summarizeNotice}
					</p>
				)}

				{(steeringForRun.length > 0 || steeringError) && (
					<div
						aria-label="Steering instructions"
						className="mx-auto mb-2 w-[calc(100%-2rem)] max-w-[980px] max-[450px]:w-[calc(100%-1.5rem)]"
					>
						<div className="flex items-center justify-between gap-2 px-1 pb-1 text-[11px] text-[var(--text-muted)]">
							<button
								type="button"
								aria-expanded={steeringExpanded}
								onClick={() => setSteeringExpanded((value) => !value)}
								className="inline-flex cursor-pointer items-center gap-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
							>
								<FiMessageSquare aria-hidden="true" />
								Steering
								{steeringForRun.some((item) => item.state === "queued") && (
									<span>
										(
										{steeringForRun.filter((item) => item.state === "queued").length}{" "}
										queued)
									</span>
								)}
								<FiChevronDown
									aria-hidden="true"
									className={`size-3 transition-transform duration-200 ${
										steeringExpanded ? "" : "-rotate-90"
									}`}
								/>
							</button>
							{activeRunId && (
								<span>Delivered at the next safe model-request boundary</span>
							)}
						</div>
						{steeringExpanded && steeringForRun.length > 0 && (
							<ul className="flex flex-col gap-1">
								{steeringForRun.map((item) => {
									const label = STEERING_STATE_LABELS[item.state] ?? item.state;
									const terminal = ["delivered", "undelivered", "cancelled"].includes(
										item.state,
									);
									return (
										<li
											key={item.id}
											className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-xs text-[var(--text-secondary)]"
										>
											<span
												title={item.failureReason || undefined}
												className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
													item.state === "delivered"
														? "bg-[var(--accent)]/15 text-[var(--accent)]"
														: item.state === "undelivered"
															? "bg-[var(--error)]/15 text-[var(--error)]"
															: "bg-[var(--surface-hover)] text-[var(--text-muted)]"
												}`}
											>
												{label}
											</span>
											<span className="min-w-0 flex-1 whitespace-pre-wrap break-words line-clamp-3">
												{item.content}
											</span>
											{item.state === "queued" && activeRunId && (
												<button
													type="button"
													onClick={() => withdrawSteering(item)}
													className="shrink-0 cursor-pointer text-[11px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
												>
													Withdraw
												</button>
											)}
											{terminal && item.state === "undelivered" && item.failureReason && (
												<span className="shrink-0 text-[11px] text-[var(--text-muted)]">
													{item.failureReason}
												</span>
											)}
										</li>
									);
								})}
							</ul>
						)}
						{steeringError && (
							<p role="alert" className="px-1 pt-1 text-[11px] text-[var(--error)]">
								{steeringError}
							</p>
						)}
					</div>
				)}

				<div
					onDragEnter={(event) => {
						event.preventDefault();
						if (loading || streaming) return;
						if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
						dragDepth.current += 1;
						setDragActive(true);
					}}
					onDragOver={(event) => {
						event.preventDefault();
						event.dataTransfer.dropEffect = loading || streaming ? "none" : "copy";
					}}
					onDragLeave={(event) => {
						event.preventDefault();
						dragDepth.current = Math.max(0, dragDepth.current - 1);
						if (dragDepth.current === 0) setDragActive(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						dragDepth.current = 0;
						setDragActive(false);
						if (!busyRef.current) addAttachments(Array.from(event.dataTransfer.files));
					}}
					className={`mx-auto relative mb-3 flex w-[calc(100%-2rem)] flex-col gap-2 rounded-xl border ${dragActive ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-[var(--surface-raised)] px-3.5 py-2.5 shadow-[0_4px_20px_var(--window-shadow)] max-[450px]:w-[calc(100%-1.5rem)] max-[450px]:px-2.5 max-[450px]:py-[7px] max-w-[980px]`}
				>
					{dragActive && (
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--accent)] bg-[var(--accent)]/10 text-sm font-medium text-[var(--accent)]"
						>
							Drop files to attach
						</div>
					)}
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
						accept={uploadPolicy.accept}
						className="hidden"
						aria-label="Choose attachments"
						disabled={streaming || loading}
						onChange={(event) => {
							const files = Array.from(event.target.files || []);
							event.target.value = "";
							addAttachments(files);
						}}
					/>

					{quotedSelection ? (
						<div
							aria-label="Quoted selection"
							className="min-w-0 rounded-lg border border-[var(--control-border)] bg-[var(--input)] px-2.5 py-2"
						>
							<p className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)] select-text">
								{quotedSelection}
							</p>
							<div className="mt-1.5 flex items-center justify-between gap-2">
								<span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
									<FiMessageSquare aria-hidden="true" />
									Selection
								</span>
								<button
									type="button"
									aria-label="Remove quoted selection"
									onClick={() => setQuotedSelection("")}
									className="flex size-5 cursor-pointer items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
								>
									<LuX className="size-3" />
								</button>
							</div>
						</div>
					) : null}

					<ChatInput
						modelId={selectedModel}
						permissionMode={permissionMode}
						permissionModes={availablePermissionModes(project)}
						allowMidRunQuestions={isWorkspaceChat ? true : allowMidRunQuestions}
						onMidRunQuestionsChange={changeMidRunQuestions}
						midRunQuestionsBusy={midRunQuestionsBusy}
						midRunQuestionsError={midRunQuestionsError}
						midRunQuestionsLocked={isWorkspaceChat}
						onPermissionModeChange={changePermissionMode}
						ref={composerRef}
						sessionId={palace.sessionId}
						hasQuote={!!quotedSelection}
						onQueue={(text) => {
							// Bake the quote in now: the queued send must not pick up
							// a different (or dismissed) quote when it later runs.
							queuePrompt(combineQuotedMessage(quotedSelection, text));
							setQuotedSelection("");
						}}
						onSubmit={(text) => sendMessage(null, false, text)}
						onSteer={submitSteering}
						steeringEnabled={streaming}
						steeringBusy={steeringBusy}
						onStop={handleStop}
						onAttach={() => fileInputRef.current?.click()}
						onPasteFiles={(files) => addAttachments(files)}
						canSubmit={!!chatAvailable && !!selectedModel && !!palace.api && !agentLoading}
						hasAttachments={selectedFiles.length > 0}
						streaming={streaming}
						loading={loading}
						attachDisabled={!window.api?.processUploads}
						attachmentTooltip={`${uploadPolicy.tooltip} You can also paste (Ctrl+V) or drag & drop files onto the composer.`}
						sendTitle={chatAvailable ? "Send" : "Select a cloud model or load a local model"}
						activeChatProvider={activeChatProvider}
					/>
				</div>
			</div>
			<RightSidebarState isRightSidebarOpen={isRightSidebarOpen} onClose={onCloseRightSidebar}>
				{(isRightSidebarOpen, onClose) => (
			<RightSidebar
				open={view === "chat" && isRightSidebarOpen}
				onClose={onClose}
				sessionId={palace.sessionId}
				modelId={selectedModel}
				agents={agents}
				sessionAgent={sessionAgent}
				disabled={streaming || loading || agentLoading || !window.api?.applyAgent}
				onSelectAgent={selectAgent}
				onSavePrompt={savePrompt}
				tuningVersion={tuningVersion}
				isWorkspace={isWorkspaceChat}
				projectName={project?.name ?? null}
				modelName={activeModelName || selectedModel}
				cloudChat={activeChatProvider.type === "cloud"}
				runtime={{
					streaming,
					loading,
					agentLoading,
					toolApprovals,
					pendingQuestions,
					toolLimit,
					pausedLoop,
					messages,
					indexing,
				}}
			/>
				)}
			</RightSidebarState>
		</div>
	);
}

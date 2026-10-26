import React, { useEffect, useRef, useState } from "react";
import { formatUsd } from '../lib/costFormat.mjs';
import { activeReplyVariant } from '../lib/messageIdentity.mjs';
import {
	LuActivity,
	LuBot,
	LuBrain,
	LuCheck,
	LuHistory,
	LuInfo,
	LuRotateCcw,
	LuSave,
	LuSettings2,
	LuSlidersHorizontal,
	LuSparkles,
	LuUsers,
	LuX,
} from "react-icons/lu";
import { CheckboxField, SelectField, TextAreaField } from "./FormControls";
import SubagentModelSelect from "./SubagentModelSelect";
import ContextPanel from "./ContextPanel";
import BackgroundCommandCard from "./chat/BackgroundCommandCard";
import WorkspacePlanCard from "./chat/WorkspacePlanCard";
import RecoveryCard from "./chat/RecoveryCard";
import RecoveryHistoryModal from "./chat/RecoveryHistoryModal";
import DiffReviewModal from "./chat/DiffReviewModal";
import {
	extractSubagentRuns,
	getNextTabIndex,
	isPromptDirty,
	summarizeActivity,
} from "../lib/sidebarControls.mjs";
import ChatTuning from "./ChatTuning";

const MEMORY_OPTIONS = [
	{
		key: "memoryEnabled",
		label: "Enable Memory (Facts & Past Chats)",
		hint: "Saved facts and past-chat search. Existing messages in this chat remain visible to the AI.",
	},
	{
		key: "compactionEnabled",
		label: "Auto-Compress Long Chats",
		hint: "Summarize long chats automatically. Existing summaries remain in use.",
	},
];

const CASUAL_SECTIONS = [
	{ id: "persona", label: "Persona", Icon: LuUsers },
	{ id: "generation", label: "Generation", Icon: LuSlidersHorizontal },
	{ id: "memory", label: "Memory", Icon: LuBrain },
];

const WORKSPACE_SECTIONS = [
	{ id: "activity", label: "Activity", Icon: LuActivity },
	{ id: "agents", label: "Agents", Icon: LuBot },
	{ id: "context", label: "Context", Icon: LuHistory },
	{ id: "controls", label: "Controls", Icon: LuSlidersHorizontal },
];

const SUB_AGENT_LABELS = {
	spawn_sub_agent: "Subagent",
	delegate_task: "Delegated task",
	extract_web_page_data: "Web extraction",
};

// Fixed subagent capabilities the main agent can call. There is no
// per-session enablement backend: availability follows the chat provider
// (mirrors the engine's tool filtering — delegation and web extraction are
// local-only), and every child runs read-only.
const AGENT_CAPABILITIES = [
	{
		toolName: "spawn_sub_agent",
		label: "Subagent worker",
		description: "Isolated research or file analysis; returns a concise answer.",
		localOnly: false,
	},
	{
		toolName: "delegate_task",
		label: "Task delegation",
		description: "Legacy background task runner.",
		localOnly: true,
	},
	{
		toolName: "extract_web_page_data",
		label: "Page extraction",
		description: "Structured extraction from a fetched page.",
		localOnly: true,
	},
];

const STATUS_DOT = {
	generating: "bg-[var(--accent)] animate-pulse",
	working: "bg-[var(--accent)] animate-pulse",
	awaiting_approval: "bg-amber-500",
	paused: "bg-amber-500",
	idle: "bg-[var(--text-muted)]",
};

const TOOL_STATUS_STYLE = {
	complete: "text-[var(--text-muted)]",
	error: "text-[var(--error)] font-medium",
	cancelled: "text-amber-500",
	running: "text-[var(--accent)]",
	pending: "text-[var(--text-secondary)]",
	preparing: "text-[var(--text-secondary)]",
	unknown: "text-[var(--text-muted)]",
};

export default function RightSidebar({
	open,
	onClose,
	sessionId,
	modelId,
	agents,
	sessionAgent,
	disabled,
	onSelectAgent,
	onSavePrompt,
	tuningVersion,
	isWorkspace = false,
	projectName = null,
	modelName = null,
	cloudChat = false,
    contextMeasurement = null,
	runtime = null,
}) {
	const sections = isWorkspace ? WORKSPACE_SECTIONS : CASUAL_SECTIONS;
    const latestResponse = [...(runtime?.messages ?? [])].reverse().find(message => message.role === 'assistant');
    const responseCost = runtime?.streaming ? runtime?.liveResponseCost
        : latestResponse ? activeReplyVariant(latestResponse).stats?.cost : null;
    const [sessionSpend, setSessionSpend] = useState(null);
    useEffect(() => {
        let active = true;
        if (!open || !sessionId || !window.api?.getSessionCost) return;
        const refresh = () => window.api.getSessionCost(sessionId)
            .then(cost => { if (active) setSessionSpend({ sessionId, ...cost }); })
            .catch(() => { if (active) setSessionSpend(null); });
        refresh();
        const timer = runtime?.streaming ? setInterval(refresh, 2000) : null;
        return () => { active = false; if (timer) clearInterval(timer); };
    }, [open, sessionId, runtime?.streaming, latestResponse?.stats?.cost?.total]);
    const chatSpend = sessionSpend?.sessionId === sessionId ? sessionSpend : null;
	const tabs = useRef([]);
	const [tab, setTab] = useState(isWorkspace ? "activity" : "persona");
	const [prompt, setPrompt] = useState("");
	const [savedPrompt, setSavedPrompt] = useState("");
	const [notice, setNotice] = useState("");
	const [saving, setSaving] = useState(false);
	const [effectiveState, setEffectiveState] = useState(null);
	const [settingsRevision, setSettingsRevision] = useState(0);
	const [selecting, setSelecting] = useState(false);
	const [confirmReapply, setConfirmReapply] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [memoryBusyKey, setMemoryBusyKey] = useState(null);
	const [memoryError, setMemoryError] = useState("");
	const [memoryStatus, setMemoryStatus] = useState("");
	const [recoveryOpen, setRecoveryOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const isDirty = isPromptDirty(prompt, savedPrompt);
	const presetExists = !sessionAgent?.id || agents.some((agent) => agent.id === sessionAgent.id);
	const prevMode = useRef(isWorkspace);
	useEffect(() => {
		if (prevMode.current !== isWorkspace) {
			prevMode.current = isWorkspace;
			tabs.current = [];
			setTab(isWorkspace ? "activity" : "persona");
		} else if (!sections.some((section) => section.id === tab)) {
			setTab(sections[0].id);
		}
	}, [isWorkspace, tab, sections]);

	useEffect(() => {
		let active = true;
		setNotice("");
		setConfirmReapply(false);
		setConfirmReset(false);
		if (window.api?.getEffectiveSettings) {
			window.api
				.getEffectiveSettings(sessionId, modelId)
				.then((result) => {
					if (active) {
						const pendingPrompt = !sessionId && typeof sessionAgent?.system_prompt === "string";
						const nextPrompt = pendingPrompt
							? sessionAgent.system_prompt
							: (result.effective.systemPrompt ?? "");
						setEffectiveState(pendingPrompt ? { ...result, source: "chat" } : result);
						setPrompt(nextPrompt);
						setSavedPrompt(nextPrompt);
					}
				})
				.catch((error) => {
					if (active) setNotice(error.message);
				});
		} else {
			const fallback = sessionAgent?.system_prompt || "";
			setPrompt(fallback);
			setSavedPrompt(fallback);
		}
		return () => {
			active = false;
		};
	}, [sessionId, modelId, sessionAgent, tuningVersion, settingsRevision, open]);
	useEffect(() => {
		const refresh = () => setSettingsRevision((value) => value + 1);
		window.addEventListener("generation-settings-changed", refresh);
		return () => window.removeEventListener("generation-settings-changed", refresh);
	}, []);
	const saveMemorySetting = async (patch) => {
		const key = Object.keys(patch)[0];
		setMemoryBusyKey(key);
		setMemoryError("");
		setMemoryStatus("Saving…");
		try {
			await window.api.saveSessionMemorySettings(sessionId, modelId, patch);
			setMemoryStatus("Saved");
			window.dispatchEvent(new Event("generation-settings-changed"));
		} catch (error) {
			setMemoryError(error.message);
			setMemoryStatus("");
		} finally {
			setMemoryBusyKey(null);
		}
	};
	const resetOverrides = async () => {
		if (isDirty && !confirmReset) {
			setConfirmReset(true);
			setNotice(
				"You have unsaved prompt edits. Click reset again to discard them and reset this chat.",
			);
			return;
		}
		setSelecting(true);
		try {
			const result = await onSelectAgent({ agentId: null, sessionId: sessionId || null });
			if (result === false) return;
			if (sessionId) {
				await window.api.saveSessionMemorySettings(sessionId, modelId, {
					memoryEnabled: null,
					compactionEnabled: null,
				});
				if (window.api?.saveSamplingParams) {
					await window.api.saveSamplingParams(sessionId, modelId, null);
				}
			}
			window.dispatchEvent(new Event("generation-settings-changed"));
			setConfirmReset(false);
			setConfirmReapply(false);
			setSettingsRevision((value) => value + 1);
		} catch (error) {
			setNotice(error.message);
		} finally {
			setSelecting(false);
		}
	};

	const handleAgentChange = async (eventOrId) => {
		const value = typeof eventOrId === "string" ? eventOrId : eventOrId?.target?.value;
		const agentId = !value || value === "default" ? null : value;
		const preset = agents.find((agent) => agent.id === agentId);
		const previousPrompt = prompt;
		setPrompt(preset?.system_prompt || "");
		setNotice("");
		setConfirmReapply(false);
		setConfirmReset(false);
		setSelecting(true);
		try {
			const result = await onSelectAgent({ agentId, sessionId: sessionId || null });
			if (result === false) {
				setPrompt(previousPrompt);
			} else {
				setSavedPrompt(preset?.system_prompt || "");
			}
		} catch (error) {
			setPrompt(previousPrompt);
			setNotice(error.message);
		} finally {
			setSelecting(false);
		}
	};

	const handleReapply = async () => {
		if (!sessionAgent?.id) return;
		if (isDirty && !confirmReapply) {
			setConfirmReapply(true);
			setNotice("You have unsaved edits. Click Reapply again to discard them and restore the preset.");
			return;
		}
		setConfirmReapply(false);
		await handleAgentChange(sessionAgent.id);
	};

	const secondaryButton =
		"flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

	const handleSavePrompt = async (e) => {
		e.preventDefault();
		setSaving(true);
		try {
			const saved = await onSavePrompt?.(prompt);
			if (saved === false) {
				setNotice("Could not save instructions — your edits are preserved above.");
			} else {
				setNotice("Saved");
				setSavedPrompt(prompt);
				setConfirmReapply(false);
				setConfirmReset(false);
				setSettingsRevision((value) => value + 1);
			}
		} catch (error) {
			setNotice(error.message);
		} finally {
			setSaving(false);
		}
	};

	const handleTabKey = (event, index) => {
		const next = getNextTabIndex(event.key, index, sections.length);
		if (next === null) return;
		event.preventDefault();
		setTab(sections[next].id);
		tabs.current[next]?.focus();
	};

	const memoryLoading = !effectiveState;
	const memoryDisabled = () => disabled || memoryBusyKey !== null || !sessionId || memoryLoading;
	const renderResetBlock = (compact = false) => (
		<div
			className={
				compact
					? "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
					: "mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
			}
		>
			<button
				type="button"
				disabled={disabled || selecting || saving}
				onClick={resetOverrides}
				aria-describedby="chat-reset-hint"
				className="w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
			>
				{confirmReset ? "Click again to confirm reset" : "Reset chat overrides"}
			</button>
			<p
				id="chat-reset-hint"
				className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]"
			>
				Clears this chat&apos;s assistant, custom instructions, sampling overrides, and memory
				settings. Model and global defaults are unchanged.
			</p>
		</div>
	);

	const renderAgentSelect = () => (
		<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
			<div className="mb-3 flex items-center gap-2">
				<LuUsers
					size={16}
					className="text-[var(--accent)]"
					aria-hidden="true"
				/>
				<h3 className="text-xs font-semibold">Active agent</h3>
			</div>

			<SelectField
				label="Assistant for this conversation"
				value={sessionAgent?.id || ""}
				disabled={disabled || selecting}
				onChange={handleAgentChange}
			>
				<option value="">Default assistant</option>
				{sessionAgent?.id && !presetExists && (
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
			</SelectField>

			<div className="mt-3 flex flex-wrap gap-2">
				{sessionAgent?.id && presetExists && (
					<button
						type="button"
						className={secondaryButton}
						disabled={disabled || selecting || saving}
						onClick={handleReapply}
					>
						<LuRotateCcw
							size={14}
							aria-hidden="true"
						/>{" "}
						{confirmReapply ? "Click again to discard edits" : "Reapply preset"}
					</button>
				)}
				{sessionAgent?.id && !presetExists && (
					<p
						role="note"
						className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]"
					>
						<LuInfo
							size={13}
							className="mt-0.5 shrink-0"
							aria-hidden="true"
						/>
						This assistant was removed from the library. Your saved instructions are preserved —
						choose another assistant to replace it.
					</p>
				)}
			</div>
		</div>
	);

	const renderPromptForm = () => (
		<form
			className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
			onSubmit={handleSavePrompt}
		>
			<div className="mb-3 flex items-center gap-2">
				<LuSparkles
					size={16}
					className="text-[var(--accent)]"
					aria-hidden="true"
				/>
				<h3 className="text-xs font-semibold">System prompt</h3>
			</div>

			<TextAreaField
				label="Instructions for this chat"
				hint={
					<span className="flex items-start gap-1.5 mt-2">
						<LuInfo
							size={13}
							className="mt-0.5 shrink-0"
							aria-hidden="true"
						/>
						Applies to this chat; the library preset stays unchanged.
					</span>
				}
				rows={8}
				maxLength={32000}
				disabled={disabled || saving || selecting}
				value={prompt}
				onChange={(event) => {
					setPrompt(event.target.value);
					setNotice("");
					setConfirmReapply(false);
					setConfirmReset(false);
				}}
				placeholder="Add instructions for this chat…"
				inputClassName="resize-y leading-relaxed"
			/>

			<div className="mt-3 flex items-center justify-between gap-2">
				<span
					role="status"
					className="flex items-center gap-1 text-[11px] text-[var(--accent)]"
				>
					{isDirty && !notice && <span className="text-[var(--text-muted)]">Unsaved changes</span>}
					{notice && (
						<>
							<LuCheck
								size={13}
								aria-hidden="true"
							/>
							{notice}
						</>
					)}
				</span>
				<button
					type="submit"
					className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
					disabled={disabled || saving || selecting}
				>
					<LuSave
						size={14}
						aria-hidden="true"
					/>{" "}
					{saving ? "Saving…" : "Save prompt"}
				</button>
			</div>
		</form>
	);

	const renderSampling = () => (
		<>
			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<div className="mb-3 flex items-center gap-2">
					<LuSlidersHorizontal
						size={16}
						className="text-[var(--accent)]"
						aria-hidden="true"
					/>
					<h3 className="text-xs font-semibold">Sampling scope</h3>
				</div>

				<p className="text-xs text-[var(--text-muted)]">
					Changes override defaults for this chat only. Configure global and model defaults in
					Models &amp; Generation.
				</p>
			</div>

			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<ChatTuning
					key={`${sessionId}:${modelId}:${tuningVersion}`}
					disabled={!sessionId || disabled || selecting}
					onChanged={() => setSettingsRevision((value) => value + 1)}
					sessionId={sessionId}
					modelId={modelId}
				/>
			</div>
		</>
	);

	const renderMemory = () => (
		<>
			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<div className="mb-2 flex items-center gap-2">
					<LuBrain
						size={16}
						className="text-[var(--accent)]"
						aria-hidden="true"
					/>
					<h3 className="text-xs font-semibold">Memory &amp; Context</h3>
				</div>
				<p className="text-xs leading-relaxed text-[var(--text-muted)]">
					Changes apply to this chat. Turning memory off disables saved facts and past-chat search.
					Existing messages in this chat remain visible to the AI.
				</p>
				{!sessionId && (
					<p
						role="status"
						className="mt-2 text-[11px] text-[var(--text-secondary)]"
					>
						Start this chat (send a first message or pick a model) to customize memory per chat.
					</p>
				)}
			</div>

			{memoryLoading ? (
				<p
					role="status"
					className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)] text-xs text-[var(--text-secondary)]"
				>
					Loading memory settings…
				</p>
			) : (
				MEMORY_OPTIONS.map(({ key, label, hint }) => {
					const isOverride = effectiveState?.overrides[key] !== undefined;
					const busy = memoryBusyKey === key;
					return (
						<div
							key={key}
							className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]"
						>
							<CheckboxField
								label={label}
								hint={hint}
								checked={effectiveState?.effective[key] ?? true}
								disabled={memoryDisabled()}
								onChange={(event) => saveMemorySetting({ [key]: event.target.checked })}
							/>
							<div className="mt-2 flex items-center justify-between gap-2">
								<span className="text-[11px] text-[var(--text-muted)]">
									{busy ? "Saving…" : isOverride ? "Chat override" : "Using model default"}
								</span>
								<button
									type="button"
									aria-label={`Use model default for ${label}`}
									disabled={disabled || memoryBusyKey !== null || !isOverride}
									onClick={() => saveMemorySetting({ [key]: null })}
									className="shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
								>
									Use model default
								</button>
							</div>
						</div>
					);
				})
			)}

			<p className="text-xs leading-relaxed text-[var(--text-muted)]">
				Turning compression off stops future summarization; existing summaries remain in use.
			</p>
			{(memoryStatus || memoryError) && (
				<div className="flex items-center gap-2">
					{memoryStatus && !memoryError && (
						<p
							role="status"
							className="text-[11px] font-medium text-[var(--text-secondary)]"
						>
							{memoryStatus}
						</p>
					)}
					{memoryError && (
						<p
							role="alert"
							className="text-[11px] font-medium text-[var(--error)]"
						>
							{memoryError}
						</p>
					)}
				</div>
			)}
		</>
	);

	const activity = isWorkspace ? summarizeActivity(runtime ?? {}) : null;
	const subagentRuns = isWorkspace ? extractSubagentRuns(runtime?.messages ?? []) : [];
	const panelClass = isWorkspace
		? "min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4"
		: "min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5";

	const renderActivity = () => (
		<>
			{isWorkspace && <WorkspacePlanCard sessionId={sessionId} />}
            {isWorkspace && <BackgroundCommandCard sessionId={sessionId} />}
			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<div className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className={`size-2 shrink-0 rounded-full ${STATUS_DOT[activity.status] ?? STATUS_DOT.idle}`}
					/>
					<h3 className="text-xs font-semibold">{activity.statusLabel}</h3>
				</div>
				<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
					{activity.toolStats.total === 0
						? "No tool calls in this chat yet."
						: `${activity.toolStats.total} tool call${activity.toolStats.total === 1 ? "" : "s"} · ${activity.toolStats.running} running · ${activity.toolStats.complete} done · ${activity.toolStats.error} failed`}
				</p>
				{(activity.approvalCount > 0 || activity.questionCount > 0) && (
					<p
						role="status"
						className="mt-2 text-[11px] font-medium text-amber-500"
					>
						{activity.approvalCount > 0 &&
							`${activity.approvalCount} approval${activity.approvalCount === 1 ? "" : "s"} pending`}
						{activity.approvalCount > 0 && activity.questionCount > 0 && " · "}
						{activity.questionCount > 0 &&
							`${activity.questionCount} question${activity.questionCount === 1 ? "" : "s"} for you`}
					</p>
				)}
				{(activity.hasLimitPause || activity.hasLoopPause) && (
					<p
						role="status"
						className="mt-2 text-[11px] font-medium text-amber-500"
					>
						Run paused — respond in the chat to continue or stop it.
					</p>
				)}
				{activity.indexing && (
					<p
						role="status"
						className="mt-2 text-[11px] text-[var(--text-secondary)]"
					>
						Indexing files…
					</p>
				)}
				{!runtime && (
					<p className="mt-2 text-[11px] text-[var(--text-muted)]">
						Live run state is unavailable for this chat.
					</p>
				)}
			</div>

			<RecoveryCard
				sessionId={sessionId}
				disabled={disabled}
				running={Boolean(runtime && (runtime.streaming || runtime.loading || runtime.agentLoading))}
				onOpenHistory={() => setRecoveryOpen(true)}
				onOpenReview={() => setReviewOpen(true)}
			/>
			{recoveryOpen && (
				<RecoveryHistoryModal
					sessionId={sessionId}
					projectName={projectName}
					running={Boolean(
						runtime && (runtime.streaming || runtime.loading || runtime.agentLoading),
					)}
					onClose={() => setRecoveryOpen(false)}
				/>
			)}
			{reviewOpen && (
				<DiffReviewModal
					sessionId={sessionId}
					projectName={projectName}
					running={Boolean(
						runtime && (runtime.streaming || runtime.loading || runtime.agentLoading),
					)}
					onClose={() => setReviewOpen(false)}
				/>
			)}

			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<h3 className="mb-2 text-xs font-semibold">Recent tool activity</h3>
				{activity.recentTools.length === 0 ? (
					<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
						Tool calls will appear here as the agent works. Your approvals and questions are
						answered in the chat.
					</p>
				) : (
					<ul className="space-y-1.5">
						{activity.recentTools.map((call) => (
							<li
								key={call.id}
								className="flex min-w-0 items-center justify-between gap-2 text-[11px]"
							>
								<span className="min-w-0 truncate" title={call.toolName}>{call.displayName}</span>
								<span
									className={`shrink-0 ${TOOL_STATUS_STYLE[call.status] ?? TOOL_STATUS_STYLE.unknown}`}
								>
									{call.status}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</>
	);

	const renderAgentsPanel = () => (
		<>
			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<div className="mb-2 flex items-center gap-2">
					<LuBot
						size={16}
						className="text-[var(--accent)]"
						aria-hidden="true"
					/>
					<h3 className="text-xs font-semibold">Main model</h3>
				</div>
				<p className="min-w-0 truncate text-xs font-medium">
					{modelName || modelId || "No model selected"}
				</p>
				<p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
					The LLM handling this conversation. Change it from the model selector in the chat header.
				</p>
			</div>

			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<h3 className="mb-1 text-xs font-semibold">Available subagents</h3>
				<p className="mb-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
					Fixed capabilities the main model can call. There is no per-session enablement setting;
					availability follows the chat provider and every child runs read-only.
				</p>
				<ul className="space-y-2">
					{AGENT_CAPABILITIES.map(({ toolName, label, description, localOnly }) => {
						const available = !localOnly || !cloudChat;
						return (
							<li
								key={toolName}
								className="flex min-w-0 items-start justify-between gap-2 text-[11px]"
							>
								<span className="min-w-0">
									<span className="block truncate font-medium">{label}</span>
									<span className="block leading-relaxed text-[var(--text-muted)]">
										{description}
										{localOnly && " Local chats only."}
									</span>
								</span>
								<span
									role="status"
									className={`shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 ${available ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`}
								>
									{available ? "Available" : "Unavailable"}
								</span>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<h3 className="mb-1 text-xs font-semibold">Sub-agent model</h3>
				<p className="mb-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
					Global setting — applies to every chat&apos;s future subagents, not just this session.
					Same control as Settings → General.
				</p>
				<SubagentModelSelect disabled={disabled} />
			</div>

			<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]">
				<h3 className="mb-2 text-xs font-semibold">
					Running subagents{subagentRuns.length > 0 && ` · ${subagentRuns.length}`}
				</h3>
				{subagentRuns.length === 0 ? (
					<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
						No subagents spawned in this chat yet.
					</p>
				) : (
					<ul className="space-y-1.5">
						{subagentRuns.slice(0, 10).map((run) => (
							<li
								key={run.id}
								className="flex min-w-0 items-center justify-between gap-2 text-[11px]"
							>
								<span className="min-w-0 truncate">
									{SUB_AGENT_LABELS[run.toolName] ?? run.toolName}
								</span>
								<span
									className={`shrink-0 ${TOOL_STATUS_STYLE[run.status] ?? TOOL_STATUS_STYLE.unknown}`}
								>
									{run.status}
								</span>
							</li>
						))}
					</ul>
				)}
				<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
					Live subagent progress is reported through tool activity; the app has no separate subagent
					status feed.
				</p>
			</div>
		</>
	);

	// Permission mode, mid-run questions, and thinking budget live in the
	// composer for both modes: a second sidebar copy would show two
	// independent controls for the same setting.
	const renderWorkspaceControls = () => (
		<>
			{renderSampling()}
			{renderMemory()}
			{renderResetBlock(true)}
		</>
	);

	return (
		<aside
			id="right-sidebar"
			aria-label={isWorkspace ? "Workspace controls" : "Chat controls"}
			aria-hidden={!open}
			inert={open ? undefined : ""}
			className={`relative z-30 h-full shrink-0 max-[900px]:absolute max-[900px]:top-0 max-[900px]:right-0 max-[900px]:z-40 ${open ? "w-80" : "w-0"}`}
		>
			{/*
			 * The aside above is the layout spacer: it owns the transcript's
			 * available width and changes size once per toggle (a single layout),
			 * never animating width itself. Only this inner panel animates, using
			 * translate/opacity, so the transcript is not re-laid-out on every
			 * frame of the transition.
			 */}
			<div className={`absolute inset-y-0 right-0 flex h-full w-80 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-[translate,opacity] duration-300 ease-in-out motion-reduce:transition-none max-[900px]:shadow-xl ${open ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"}`}>
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-4">
					<div className="flex min-w-0 items-center gap-3">
						<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--active-chat)] text-[var(--accent)]">
							{isWorkspace ? (
								<LuActivity
									size={18}
									aria-hidden="true"
								/>
							) : (
								<LuSettings2
									size={18}
									aria-hidden="true"
								/>
							)}
						</span>
						<div className="min-w-0">
							<h2 className="truncate text-sm font-semibold">
								{isWorkspace ? "Workspace controls" : "Chat controls"}
							</h2>
							<p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
								{isWorkspace && projectName ? `${projectName} · ` : ""}
								{effectiveState?.source === "chat"
									? "Chat Overridden"
									: "Using Model Defaults"}
							</p>
						</div>
					</div>
					<button
						type="button"
						aria-label="Close chat controls"
						className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
						onClick={onClose}
					>
						<LuX
							size={17}
							aria-hidden="true"
						/>
					</button>
				</header>

                <div className="mx-4 mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3" aria-label="Response cost">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-[var(--text-secondary)]">{runtime?.streaming ? 'Live response estimate' : 'Latest response cost'}</span>
                            <span className="font-semibold tabular-nums text-[var(--accent)]">
                                {!cloudChat ? 'Local · no charge' : formatUsd(responseCost?.total)}
                            </span>
                        </div>
                        {cloudChat && <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                            {runtime?.streaming ? responseCost?.total == null
                                ? 'Waiting for pricing or provider usage.'
                                : runtime?.liveResponseCost?.partial
                                ? 'Partial estimate; some requests have no pricing.'
                                : 'Estimated tokens while generating. Final usage may change the charge.'
                                : 'USD · Cost of the latest response, including tool follow-ups.'}
                        </p>}
                        <div className="mt-3 border-t border-[var(--border)] pt-3">
                            <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="text-[var(--text-secondary)]">Total spent in this chat</span>
                                <span className="font-semibold tabular-nums">{chatSpend?.partial && chatSpend.total != null ? '≥ ' : ''}{formatUsd(chatSpend?.total)}</span>
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                                {chatSpend?.partial ? 'Known subtotal; some turns have no complete cost record.'
                                    : 'Recorded USD spend, including agent runs. Kept after compaction.'}
                            </p>
                        </div>
                </div>
				{!isWorkspace && renderResetBlock(false)}

				<div
					role="tablist"
					aria-label={isWorkspace ? "Workspace sections" : "Chat control sections"}
					className="mt-3 flex shrink-0 gap-1 overflow-hidden border-b border-[var(--border)] bg-[var(--surface)] px-3 pt-2"
				>
					{sections.map(({ id, label, Icon }, index) => (
						<button
							key={id}
							ref={(node) => {
								tabs.current[index] = node;
							}}
							type="button"
							role="tab"
							id={`controls-tab-${id}`}
							aria-controls={`controls-${id}`}
							aria-label={label}
							title={label}
							aria-selected={tab === id}
							tabIndex={tab === id ? 0 : -1}
							onClick={() => setTab(id)}
							onKeyDown={(event) => handleTabKey(event, index)}
							className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center border-b-2 px-1 py-3 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${tab === id ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
						>
							<Icon
								size={17}
								aria-hidden="true"
								className="shrink-0"
							/>
						</button>
					))}
				</div>

				{!isWorkspace && (
					<>
						<section
							role="tabpanel"
							id="controls-persona"
							aria-labelledby="controls-tab-persona"
							hidden={tab !== "persona"}
							className={panelClass}
						>
							{renderAgentSelect()}
							{renderPromptForm()}
						</section>

						<section
							role="tabpanel"
							id="controls-generation"
							aria-labelledby="controls-tab-generation"
							hidden={tab !== "generation"}
							className={panelClass}
						>
							{renderSampling()}
						</section>
						<section
							role="tabpanel"
							id="controls-memory"
							aria-labelledby="controls-tab-memory"
							hidden={tab !== "memory"}
							className={panelClass}
						>
							{renderMemory()}
						</section>
					</>
				)}

				{isWorkspace && (
					<>
						<section
							role="tabpanel"
							id="controls-activity"
							aria-labelledby="controls-tab-activity"
							hidden={tab !== "activity"}
							className={panelClass}
						>
							{renderActivity()}
						</section>
						<section
							role="tabpanel"
							id="controls-agents"
							aria-labelledby="controls-tab-agents"
							hidden={tab !== "agents"}
							className={panelClass}
						>
							{renderAgentsPanel()}
						</section>
						<section
							role="tabpanel"
							id="controls-context"
							aria-labelledby="controls-tab-context"
							hidden={tab !== "context"}
							className={panelClass}
						>
							<ContextPanel
                                measurement={contextMeasurement}
								sessionId={sessionId}
								modelId={modelId}
								active={tab === "context"}
							/>
						</section>
						<section
							role="tabpanel"
							id="controls-controls"
							aria-labelledby="controls-tab-controls"
							hidden={tab !== "controls"}
							className={panelClass}
						>
							{renderWorkspaceControls()}
						</section>
					</>
				)}
			</div>
		</aside>
	);
}

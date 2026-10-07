import React, { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { GrAttachment } from "react-icons/gr";
import { IoSend } from "react-icons/io5";
import { FaStop, FaShieldAlt, FaPencilAlt, FaQuestionCircle } from "react-icons/fa";
import { PiShieldWarningBold } from "react-icons/pi";
import useSessionDraft from "../hooks/useSessionDraft";
import { SelectField } from "./FormControls";
import { AgentSettingsPopover } from "./AgentSettingsPopover";

const ChatInputBar = memo(
	forwardRef(function ChatInputBar(
		{
			sessionId,
			onSubmit,
			onQueue,
			onStop,
			onAttach,
			canSubmit,
			hasAttachments,
			streaming,
			loading,
			attachDisabled,
			sendTitle,
			permissionMode = "ask_approval",
			onPermissionModeChange,
			allowMidRunQuestions = false,
			onMidRunQuestionsChange,
			midRunQuestionsBusy = false,
			midRunQuestionsError = "",
			modelId,
			supportedEfforts = [],
			reasoningEffort,
			onEffortChange,
			showEffort,
		},
		ref,
	) {
		// This hook owns the local text and the cancellable 1-second storage debounce.
		const { input: draftText, updateDraft, clearSubmitted } = useSessionDraft(sessionId);
		const textarea = useRef(null);

		useImperativeHandle(ref, () => ({ clearSubmitted }), [clearSubmitted]);

		useLayoutEffect(() => {
			const element = textarea.current;
			element.style.height = "auto";
			element.style.height = `${element.scrollHeight}px`;
		}, [draftText]);

		const ready = canSubmit && !streaming && !loading && (draftText.trim() || hasAttachments);
		const submit = () => {
			if (ready) onSubmit(draftText);
		};

		return (
			<>
				<textarea
					ref={textarea}
					aria-label="Message"
					className="max-h-[200px] sm:max-h-[350px] min-h-[38px] w-full resize-none overflow-y-auto rounded-md py-[9px] text-sm leading-normal text-[var(--text-primary)] transition-colors duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					value={draftText}
					onChange={(event) => updateDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
							return;
						if ((event.ctrlKey || event.metaKey) && event.shiftKey && onQueue) {
							event.preventDefault();
							if (!event.repeat && draftText.trim()) {
								onQueue(draftText);
								clearSubmitted(draftText, sessionId);
							}
						} else if (!event.shiftKey) {
							event.preventDefault();
							if (!event.repeat) submit();
						}
					}}
					placeholder="Type a message..."
					rows={1}
				/>

				<div className="flex items-center justify-between gap-2 px-1 py-1">
					{/* Left: Attachment & Permission Controls */}
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							aria-label="Attach files"
							title="Attach images, PDF, TXT, Markdown, or CSV"
							disabled={streaming || loading || attachDisabled}
							onClick={onAttach}
							className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-[var(--control-border)] bg-[var(--input)] text-[var(--text-muted)] hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
						>
							<GrAttachment className="size-3.5" />
						</button>

						<PermissionSelector
							value={permissionMode}
							onChange={onPermissionModeChange}
							disabled={streaming || loading}
						/>
					</div>

					{/* Right: Consolidated Settings Popover & Send Button */}
					<div className="flex items-center gap-1.5">
						<AgentSettingsPopover
							sessionId={sessionId}
							modelId={modelId}
							disabled={!modelId || streaming || loading}
							allowMidRunQuestions={allowMidRunQuestions}
							onMidRunQuestionsChange={onMidRunQuestionsChange}
							midRunQuestionsBusy={midRunQuestionsBusy}
							showEffort={showEffort}
							supportedEfforts={supportedEfforts}
							reasoningEffort={reasoningEffort}
							onEffortChange={onEffortChange}
						/>

						<button
							type="button"
							title={streaming ? "Stop" : sendTitle}
							aria-label={streaming ? "Stop" : "Send"}
							onClick={streaming ? onStop : submit}
							disabled={!streaming && !ready}
							className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xl border-0 bg-[var(--accent)] text-[var(--on-accent)] transition-all duration-200 hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
						>
							{streaming ? <FaStop className="size-3" /> : <IoSend className="size-3" />}
						</button>
					</div>
				</div>
				{midRunQuestionsError && (
					<p
						role="alert"
						className="text-xs text-[var(--error)]"
					>
						{midRunQuestionsError}
					</p>
				)}
			</>
		);
	}),
);

function PermissionSelector({ value = "ask_approval", onChange, disabled }) {
	const getIcon = (val) => {
		switch (val) {
			case "read_only":
				return <FaShieldAlt />;
			case "workspace_write":
				return <FaPencilAlt />;
			case "ask_approval":
				return <FaQuestionCircle />;
			case "full_access":
				return <PiShieldWarningBold />;
			default:
				return <FaQuestionCircle />;
		}
	};

	return (
		<div className="mr-auto w-full max-w-[200px]">
			<SelectField
				aria-label="Tool permission mode"
				title="Tool permission mode"
				value={value}
				onChange={(event) => onChange?.(event.target.value)}
				disabled={disabled}
				icon={getIcon(value)}
				openTop={true}
			>
				<option value="read_only">Read Only</option>
				<option value="workspace_write">Workspace Write</option>
				<option value="ask_approval">Ask for Approval</option>
				<option value="full_access">Full Access</option>
			</SelectField>
		</div>
	);
}

export default ChatInputBar;

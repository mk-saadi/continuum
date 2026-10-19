import React, { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { GrAttachment } from "react-icons/gr";
import { IoSend } from "react-icons/io5";
import { FaStop, FaShieldAlt, FaPencilAlt, FaQuestionCircle } from "react-icons/fa";
import { PiShieldWarningBold } from "react-icons/pi";
import useSessionDraft from "../hooks/useSessionDraft";
import { SelectField } from "./FormControls";
import { AgentSettingsPopover } from "./AgentSettingsPopover";
import {
	PERMISSION_MODES,
	PERMISSION_MODE_LABELS,
	PERMISSION_MODE_DEFAULTS,
} from "../lib/permissionModes.mjs";
import Tooltip from "./Tooltip";

const ChatInputBar = memo(
	forwardRef(function ChatInputBar(
		{
			sessionId,
			onSubmit,
			onQueue,
			onStop,
			onAttach,
			onPasteFiles,
			canSubmit,
			hasAttachments,
			hasQuote = false,
			streaming,
			loading,
			attachDisabled,
            attachmentTooltip = "Attach text files, PDF, or Excel (.xlsx)",
			sendTitle,
			permissionMode = PERMISSION_MODE_DEFAULTS.casual,
			onPermissionModeChange,
			permissionModes = PERMISSION_MODES,
			allowMidRunQuestions = false,
			onMidRunQuestionsChange,
			midRunQuestionsBusy = false,
			midRunQuestionsError = "",
			midRunQuestionsLocked = false,
			modelId,
			activeChatProvider = { type: "local" },
		},
		ref,
	) {
		// This hook owns the local text and the cancellable 1-second storage debounce.
		const { input: draftText, updateDraft, clearSubmitted } = useSessionDraft(sessionId);
		const textarea = useRef(null);

		useImperativeHandle(
			ref,
			() => ({
				clearSubmitted,
				setDraft: updateDraft,
				focusInput: (options) => textarea.current?.focus?.(options ?? { preventScroll: true }),
			}),
			[clearSubmitted, updateDraft],
		);

		useLayoutEffect(() => {
			const element = textarea.current;
			if (!element) return;
			element.style.height = "auto";
			element.style.height = `${element.scrollHeight}px`;
			// Empty/single-line content must never show a scrollbar (subpixel
			// rounding alone can trip overflow-y: auto). Only scroll once the
			// max-height cap actually clips content.
			element.style.overflowY =
				element.scrollHeight > element.clientHeight + 1 ? "auto" : "hidden";
		}, [draftText]);

		const ready = canSubmit && !streaming && !loading && (draftText.trim() || hasAttachments || hasQuote);
		const submit = () => {
			if (ready) onSubmit(draftText);
		};

	function collectPastedFiles(event) {
		const clipboard = event.clipboardData;
		if (!clipboard) return [];
		// Files first (real file copies, screenshots from most apps).
		const fromFiles = clipboard.files?.length ? Array.from(clipboard.files) : [];
		if (fromFiles.length) return fromFiles;
		// Fallback: clipboard items (e.g. copied web images expose no File).
		const items = Array.from(clipboard.items ?? []);
		return items
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter(Boolean);
	}

		return (
			<>
				<textarea
					ref={textarea}
					aria-label="Message"
					className="max-h-[200px] sm:max-h-[350px] min-h-[38px] w-full resize-none overflow-y-hidden rounded-md py-[9px] text-sm leading-normal text-[var(--text-primary)] transition-colors duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					value={draftText}
					onChange={(event) => updateDraft(event.target.value)}
					onPaste={(event) => {
						if (!onPasteFiles) return;
						const files = collectPastedFiles(event);
						if (!files.length) return;
						event.preventDefault();
						onPasteFiles(files);
					}}
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
						<Tooltip content={attachmentTooltip}>
							<button
								type="button"
								aria-label="Attach files"
								disabled={streaming || loading || attachDisabled}
								onClick={onAttach}
								className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-[var(--control-border)] bg-[var(--input)] text-[var(--text-muted)] hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
							>
								<GrAttachment className="size-3.5" />
							</button>
						</Tooltip>

						<PermissionSelector
							value={permissionMode}
							onChange={onPermissionModeChange}
							disabled={streaming || loading}
							modes={permissionModes}
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
							midRunQuestionsLocked={midRunQuestionsLocked}
							activeChatProvider={activeChatProvider}
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

function PermissionSelector({
	value = PERMISSION_MODE_DEFAULTS.casual,
	onChange,
	disabled,
	modes = PERMISSION_MODES,
}) {
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
				{modes.map((mode) => (
					<option
						key={mode}
						value={mode}
					>
						{PERMISSION_MODE_LABELS[mode]}
					</option>
				))}
			</SelectField>
		</div>
	);
}

export default ChatInputBar;

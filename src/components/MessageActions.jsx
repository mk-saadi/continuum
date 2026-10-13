import React, { useState } from "react";
import {
	FiCheck,
	FiCopy,
	FiGitBranch,
	FiTrash2,
	FiEdit,
	FiRefreshCw,
	FiChevronLeft,
	FiChevronRight,
} from "react-icons/fi";
import Tooltip from "./Tooltip.jsx";

export default function MessageActions({
	message,
	disabled,
	onDelete,
	onBranch,
	onEdit,
	onError,
	onRegenerate,
	onSelectReplyVariant,
	onSelectPromptVersion,
	isLast,
}) {
	const [copied, setCopied] = useState(false);
	const saved = Number.isSafeInteger(message.id) && message.id > 0;
	const activeContent = message.variants?.[message.active_variant_index ?? 0]?.content;
	const textToCopy =
		typeof message.content === "string" && message.content
			? message.content
			: typeof activeContent === "string"
				? activeContent
				: "";
	const replyVersions =
		message.role === "assistant" && message.variants?.length > 1 && onSelectReplyVariant;
	const promptVersions = message.role === "user" && message.siblings?.length > 1 && onSelectPromptVersion;
	const versionCount = replyVersions
		? message.variants.length
		: promptVersions
			? message.siblings.length
			: 0;
	const versionIndex = replyVersions
		? (message.active_variant_index ?? 0)
		: promptVersions
			? message.siblings.indexOf(message.id)
			: 0;
	const versionKind = replyVersions ? "reply" : "prompt";
	const navigate = (offset) =>
		replyVersions ? onSelectReplyVariant(message, versionIndex + offset) : onSelectPromptVersion(offset);
	const buttonClass =
		"inline-flex items-center cursor-pointer gap-1 rounded p-1 hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

	return (
		<div
			role="group"
			aria-label="Message actions"
			className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-secondary)] transition-opacity opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
		>
			{versionCount > 1 && (
				<div
					aria-label={replyVersions ? "Reply versions" : "Prompt versions"}
					className="inline-flex shrink-0 items-center gap-1 border-r border-[var(--subtle-border)] pr-2"
				>
					<Tooltip
						content={`Previous ${versionKind} version`}
						placement="top"
						delay={350}
					>
						<button
							type="button"
							className={buttonClass}
							aria-label={`Previous ${versionKind} version`}
							disabled={disabled || message.streaming || versionIndex <= 0}
							onClick={() => navigate(-1)}
						>
							<FiChevronLeft aria-hidden="true" />
						</button>
					</Tooltip>
					<span
						aria-live="polite"
						className="whitespace-nowrap tabular-nums"
					>
						{versionIndex + 1} / {versionCount}
					</span>
					<Tooltip
						content={`Next ${versionKind} version`}
						placement="top"
						delay={350}
					>
						<button
							type="button"
							className={buttonClass}
							aria-label={`Next ${versionKind} version`}
							disabled={disabled || message.streaming || versionIndex >= versionCount - 1}
							onClick={() => navigate(1)}
						>
							<FiChevronRight aria-hidden="true" />
						</button>
					</Tooltip>
				</div>
			)}

			<Tooltip
				content="Branch chat from here"
				placement="top"
				delay={350}
			>
				<button
					type="button"
					className={buttonClass}
					aria-label="Branch chat"
					disabled={disabled || !saved}
					onClick={() => onBranch(message.id)}
				>
					<FiGitBranch aria-hidden="true" />
				</button>
			</Tooltip>

			{message.role === "assistant" && isLast && onRegenerate && (
				<Tooltip
					content="Regenerate reply"
					placement="top"
					delay={350}
				>
					<button
						type="button"
						className={buttonClass}
						aria-label="Regenerate reply"
						disabled={disabled || message.streaming}
						onClick={onRegenerate}
					>
						<FiRefreshCw aria-hidden="true" />
					</button>
				</Tooltip>
			)}

			<Tooltip
				content={copied ? "Copied!" : "Copy message"}
				placement="top"
				delay={350}
			>
				<button
					type="button"
					className={buttonClass}
					aria-label="Copy message"
					onBlur={() => setCopied(false)}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(textToCopy || "");
							setCopied(true);
						} catch (error) {
							onError(`Could not copy message: ${error.message}`);
						}
					}}
				>
					{copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
				</button>
			</Tooltip>

			{/* Edit Button - only show for user messages */}
			{message.role === "user" && message.id && (
				<Tooltip
					content="Edit message"
					placement="top"
					delay={350}
				>
					<button
						type="button"
						className={buttonClass}
						aria-label="Edit message"
						disabled={disabled}
						onClick={() => onEdit(message)}
					>
						<FiEdit aria-hidden="true" />
					</button>
				</Tooltip>
			)}

			<Tooltip
				content="Delete message"
				placement="top"
				delay={350}
			>
				<button
					type="button"
					className={buttonClass}
					aria-label="Delete message"
					disabled={disabled || !saved}
					onClick={() => onDelete(message.id)}
				>
					<FiTrash2 aria-hidden="true" />
				</button>
			</Tooltip>
		</div>
	);
}

import React, { useState } from "react";
import { FiCheck, FiCopy, FiGitBranch, FiTrash2 } from "react-icons/fi";

export default function MessageActions({ message, disabled, onDelete, onBranch, onError }) {
	const [copied, setCopied] = useState(false);
	const saved = Number.isSafeInteger(message.id) && message.id > 0;
	const buttonClass =
		"inline-flex items-center cursor-pointer gap-1 rounded p-1 hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

	return (
		<div
			role="group"
			aria-label="Message actions"
			className="mt-1 flex flex-wrap gap-2 text-[11px] text-[var(--text-secondary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
		>
			<button
				type="button"
				className={buttonClass}
				aria-label="Copy message"
				onBlur={() => setCopied(false)}
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(message.content || "");
						setCopied(true);
					} catch (error) {
						onError(`Could not copy message: ${error.message}`);
					}
				}}
			>
				{copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
				{/* {copied ? "Copied" : "Copy"} */}
			</button>

			<button
				type="button"
				className={buttonClass}
				aria-label="Delete message"
				disabled={disabled || !saved}
				onClick={() => onDelete(message.id)}
			>
				<FiTrash2 aria-hidden="true" />
				{/* Delete Message */}
			</button>

			<button
				type="button"
				className={buttonClass}
				aria-label="Branch chat"
				disabled={disabled || !saved}
				onClick={() => onBranch(message.id)}
			>
				<FiGitBranch aria-hidden="true" />
				{/* Branch Chat */}
			</button>
		</div>
	);
}

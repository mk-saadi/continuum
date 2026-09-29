import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FiChevronDown } from "react-icons/fi";
import { GiStarSwirl } from "react-icons/gi";

export default function ThoughtBlock({ content = "", durationMs }) {
	const seconds = Number.isFinite(durationMs) ? Math.max(0, durationMs) / 1000 : null;
	return (
		<details className="group/thinking min-w-0 mb-3 text-xs text-[var(--text-muted)] bg-white/5 py-1.5 px-3 rounded-md">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--accent)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
				<FiChevronDown
					aria-hidden="true"
					className="-rotate-90 transition-transform group-open/thinking:rotate-0"
				/>
				<GiStarSwirl
					aria-hidden="true"
					className="shrink-0"
				/>
				<span>Thought{seconds === null ? "" : ` for ${seconds.toFixed(2)}s`}</span>
			</summary>

			<div className="assistant-markdown mt-2 border-l-2 border-[var(--subtle-border)] py-1 pl-3 min-w-0 break-words leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3 [&_a]:text-[var(--link)] [&_a]:underline">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
			</div>
		</details>
	);
}

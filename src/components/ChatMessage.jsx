import React, { useState } from "react";
import ThoughtBlock from "./ThoughtBlock";
import ToolCallBlock from "./ToolCallBlock";
import { activeReplyVariant, assistantLabel } from "../lib/messageIdentity.mjs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismAsync as SyntaxHighlighter } from "react-syntax-highlighter";
import {
	FiChevronLeft,
	FiChevronRight,
	FiCheck,
	FiChevronDown,
	FiClock,
	FiCopy,
	FiFileText,
	FiTool,
	FiZap,
} from "react-icons/fi";
import { GiStarSwirl } from "react-icons/gi";

// Prism accepts CSS variables, so syntax colors change with data-theme.
const syntaxTheme = {
	'pre[class*="language-"]': { background: "transparent", color: "var(--code-text)" },
	'code[class*="language-"]': { background: "transparent", color: "var(--code-text)" },
	comment: { color: "var(--code-comment)" },
	prolog: { color: "var(--code-comment)" },
	doctype: { color: "var(--code-comment)" },
	cdata: { color: "var(--code-comment)" },
	punctuation: { color: "var(--code-text)" },
	property: { color: "var(--code-key)" },
	tag: { color: "var(--code-key)" },
	boolean: { color: "var(--code-literal)" },
	number: { color: "var(--code-literal)" },
	constant: { color: "var(--code-literal)" },
	symbol: { color: "var(--code-literal)" },
	selector: { color: "var(--code-key)" },
	"attr-name": { color: "var(--code-key)" },
	string: { color: "var(--code-string)" },
	char: { color: "var(--code-string)" },
	builtin: { color: "var(--code-string)" },
	inserted: { color: "var(--code-string)" },
	operator: { color: "var(--code-text)" },
	entity: { color: "var(--code-text)" },
	url: { color: "var(--code-string)" },
	atrule: { color: "var(--code-key)" },
	"attr-value": { color: "var(--code-string)" },
	keyword: { color: "var(--code-keyword)" },
	function: { color: "var(--code-function)" },
	"class-name": { color: "var(--code-function)" },
	regex: { color: "var(--code-literal)" },
	important: { color: "var(--code-literal)" },
	variable: { color: "var(--code-text)" },
	deleted: { color: "var(--error)" },
};

function CodeBlock({ code, language }) {
	const [copied, setCopied] = useState(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(code.replace(/\n$/, ""));
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			setCopied(false);
		}
	}
	return (
		<div className="my-3 min-w-0 overflow-hidden rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)] text-[var(--code-text)]">
			<div className="flex items-center justify-between border-b border-[var(--code-border)] px-3 py-1.5 text-[11px] text-[var(--code-muted)]">
				<span>{language || "text"}</span>
				<button
					type="button"
					onClick={copy}
					aria-label="Copy code"
					className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[var(--code-text)] hover:bg-[var(--code-button-hover)]"
				>
					{copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
					<span>{copied ? "Copied" : "Copy"}</span>
				</button>
			</div>
			<SyntaxHighlighter
				language={language || "text"}
				style={syntaxTheme}
				customStyle={{
					margin: 0,
					padding: "12px 16px",
					background: "transparent",
					maxWidth: "100%",
					overflowX: "auto",
					fontSize: "12px",
					lineHeight: 1.55,
				}}
			>
				{code.replace(/\n$/, "")}
			</SyntaxHighlighter>
		</div>
	);
}

const components = {
	pre: ({ children }) => <>{children}</>,
	table: ({ node, ...props }) => (
		<div className="assistant-table-scroll">
			<table
				{...props}
				className="assistant-table"
			/>
		</div>
	),
	code({ className, children, node, ...props }) {
		const code = String(children);
		const language = /language-([^\s]+)/.exec(className || "")?.[1];
		if (language || code.endsWith("\n"))
			return (
				<CodeBlock
					code={code}
					language={language}
				/>
			);
		return (
			<code
				{...props}
				className={`${className || ""} rounded bg-[var(--inline-code-bg)] px-1 py-0.5 font-mono text-[var(--text-primary)]`}
			>
				{children}
			</code>
		);
	},
	a: ({ node, ...props }) => (
		<a
			{...props}
			target="_blank"
			rel="noopener noreferrer"
			className="text-[var(--link)] underline"
		/>
	),
};

export default function ChatMessage({ message, disabled = false, onSelectVariant, showHeader = true }) {
	const index = message.active_variant_index ?? 0;
	const activeVariant = activeReplyVariant(message);
	const thinking = activeVariant.thinking ?? activeVariant.thinkingText;
	const thinkingDuration = activeVariant.thinking_duration ?? activeVariant.thinkingDuration;
	const toolCalls = activeVariant.tool_calls ?? activeVariant.toolCalls;
    const steps = activeVariant.executionSteps;
	return (
		<div className="min-w-0 w-full whitespace-normal">
			{showHeader && (
				<div className="mb-2 text-xs text-[var(--text-muted)]">{assistantLabel(message)}</div>
			)}
            {steps?.length > 0 && (
                <div key={`${message.id ?? 'message'}:${index}`} className="message-execution-timeline mb-3 space-y-2">
                    {steps.map((step, idx) => {
                        if (step.type === 'thought') {
                            return <ThoughtBlock key={step.id ?? idx} content={step.content} durationMs={step.durationMs} />;
                        }
                        if (step.type === 'tool_call') {
                            return <ToolCallBlock key={step.id ?? idx} step={step} />;
                        }
                        return null;
                    })}
                </div>
            )}
            {!steps && toolCalls?.length > 0 && <ToolCallBadge toolCalls={toolCalls} />}
			{!steps && thinking && (
				<ThinkingAccordion
					text={thinking}
					duration={thinkingDuration}
				/>
			)}
			<div className="assistant-markdown prose max-w-none text-inherit [&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h1]:my-4 [&_h2]:my-4 [&_h3]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-current [&_blockquote]:pl-3 [&_blockquote]:opacity-80 [&_hr]:my-4">
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={components}
				>
					{activeVariant.content ||
						(message.streaming || steps?.length || toolCalls?.length || thinking ? "" : "...")}
				</ReactMarkdown>
			</div>
			{/* {message.streaming && (
				<span
					role="status"
					className="text-xs text-[var(--text-muted)]"
				>
					Generating…
				</span>
			)} */}
			<div className="mt-2 flex items-center gap-3 text-xs text-[var(--text-muted)]">
				{message.variants?.length > 1 && (
					<div
						className="flex items-center gap-2 rounded-full border border-[var(--subtle-border)] px-2 py-1"
						aria-label="Reply versions"
					>
						<button
							type="button"
							aria-label="Previous reply version"
							disabled={disabled || message.streaming || index === 0}
							onClick={() => onSelectVariant?.(index - 1)}
							className="disabled:opacity-40"
						>
							<FiChevronLeft />
						</button>
						<span aria-live="polite">
							{index + 1} / {message.variants.length}
						</span>
						<button
							type="button"
							aria-label="Next reply version"
							disabled={disabled || message.streaming || index === message.variants.length - 1}
							onClick={() => onSelectVariant?.(index + 1)}
							className="disabled:opacity-40"
						>
							<FiChevronRight />
						</button>
					</div>
				)}
			</div>
			{message.role === "assistant" && activeVariant.stats && (
				<StatsFooter stats={activeVariant.stats} />
			)}
		</div>
	);
}

export function StatsFooter({ stats }) {
	stats = {
		...stats,
		tokensPerSecond: stats.tokens_per_sec ?? stats.tokensPerSecond,
		totalTokens: stats.total_tokens ?? stats.totalTokens,
		time: stats.duration ?? stats.time,
	};
	const scope = stats.scope === "final" ? "Final generation phase" : "All generation phases";
	return (
		<footer
			aria-label="Generation statistics"
			className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]"
		>
			<span
				className="inline-flex items-center gap-1"
				title={`${scope}: ${stats.generationTime != null ? "server generation timing" : "elapsed-time throughput"}`}
			>
				<FiZap aria-hidden="true" />{" "}
				{stats.tokensPerSecond == null ? "—" : stats.tokensPerSecond.toFixed(1)} tok/sec
			</span>
			<span
				className="inline-flex items-center gap-1"
				title={`${scope}. Prompt: ${stats.promptTokens ?? "unavailable"}; generated: ${stats.completionTokens ?? "unavailable"}`}
			>
				<FiFileText aria-hidden="true" />{" "}
				{stats.totalTokens == null
					? "Tokens unavailable"
					: `${stats.totalTokens.toLocaleString()} total tokens`}
			</span>
			<span
				className="inline-flex items-center gap-1"
				title={`${scope}: elapsed time`}
			>
				<FiClock aria-hidden="true" /> {stats.time == null ? "—" : stats.time.toFixed(1)}s
			</span>
			{stats.scope === "final" && (
				<span title="Earlier tool phases did not report complete usage">Final phase</span>
			)}
		</footer>
	);
}

export function ToolCallBadge({ toolCalls }) {
	return (
		<div
			aria-label="Tool executions"
			className="mb-2 space-y-1"
		>
			{toolCalls.map((call, index) => (
				<div
					key={call.id || index}
					role="status"
					className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]"
				>
					<FiTool
						aria-hidden="true"
						className="shrink-0"
					/>
					<span>
						{call.serverName ? `${call.serverName} / ` : ""}
						{call.toolName ||
							(typeof call.function?.name === "string" ? call.function.name : "Tool")}
					</span>
					{call.status && (
						<span className="text-[var(--text-secondary)]">
							· {call.status === "pending" ? "Running…" : call.status}
						</span>
					)}
					{call.error && (
						<p className="w-full pl-5 whitespace-pre-wrap text-[var(--error)]">{call.error}</p>
					)}
				</div>
			))}
		</div>
	);
}

export function ThinkingAccordion({ text, duration }) {
	return (
		<details className="group/thinking mb-3  text-xs text-[var(--text-muted)] bg-white/5 py-1 rounded-md">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 py-1 hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
				<FiChevronDown
					aria-hidden="true"
					className="-rotate-90 transition-transform group-open/thinking:rotate-0"
				/>
				<GiStarSwirl /> Thought{duration != null ? ` for ${duration.toFixed(1)}s` : ""}
			</summary>
			<div className="mt-1 border-l-2 border-[var(--subtle-border)] py-1 pl-3 whitespace-pre-wrap break-words leading-relaxed">
				{text}
			</div>
		</details>
	);
}

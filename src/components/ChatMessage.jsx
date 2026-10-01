import React, { useState } from "react";
import ThoughtBlock from "./ThoughtBlock";
import ToolCallBlock from "./ToolCallBlock";
import { activeReplyVariant, assistantLabel } from "../lib/messageIdentity.mjs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { mediaSource, isLocalVideoSource, mediaUrlTransform, rehypeMediaSources, mediaSchema } from '../lib/markdownMedia.mjs';

// MIME hints for local video containers so Chromium selects the right demuxer.
const VIDEO_MIME_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t' };

function videoMimeType(source) {
	try {
		const ext = decodeURIComponent(new URL(source).pathname).split('.').pop().toLowerCase();
		return VIDEO_MIME_TYPES[ext] || undefined;
	} catch { return undefined; }
}
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

function MarkdownMedia({ src, alt = '', children }) {
	const source = mediaSource(src);
	const [failedSource, setFailedSource] = useState(null);
	if ((!source && !children) || failedSource === source) {
		return <span role="status" className="text-[var(--text-muted)]">{alt || 'Media unavailable'}</span>;
	}
	// Video playback is restricted to local files; remote video URLs degrade to the image path.
	if (isLocalVideoSource(source)) {
		return <video src={source} type={videoMimeType(source)} controls preload="metadata" aria-label={alt || 'Video'}
			className="max-w-full rounded-lg my-2 max-h-[400px]" onError={() => setFailedSource(source)}>{children}</video>;
	}
	if (!source && children) {
		return <video controls preload="metadata" aria-label={alt || 'Video'}
			className="max-w-full rounded-lg my-2 max-h-[400px]">{children}</video>;
	}
	return <img src={source} alt={alt} loading="lazy"
		className="max-w-full rounded-lg my-2 max-h-[500px] object-contain" onError={() => setFailedSource(source)} />;
}

const components = {
	img: ({ src, alt }) => <MarkdownMedia src={src} alt={alt} />,
	video: ({ src, title, children }) => <MarkdownMedia src={src} alt={title} video>{children}</MarkdownMedia>,
	source: ({ src, type }) => {
		const source = mediaSource(src);
		return <source src={source || undefined} type={type || videoMimeType(source)} />;
	},
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
	a: ({ node, href, ...props }) => {
		// Local filesystem path -> open with the system's default app
		if (href && /^\/[^\s]+/.test(href)) {
			return (
				<a
					{...props}
					href={href}
					className="text-[var(--link)] underline cursor-pointer"
					onClick={(e) => {
						e.preventDefault();
						window.api?.openPath?.(href);
					}}
				/>
			);
		}
		// Everything else (http/https, etc.) -> normal external link
		return (
			<a
				{...props}
				target="_blank"
				rel="noopener noreferrer"
				className="text-[var(--link)] underline"
			/>
		);
	},
};

const ChatMessage = React.memo(function ChatMessage({
	message,
	disabled = false,
	onSelectVariant,
	onSelectReplyVariant,
	showHeader = true,
}) {
	const index = message.active_variant_index ?? 0;
	const activeVariant = activeReplyVariant(message);
	// Read the identity captured with this reply, never current branding settings.
	const displayName = assistantLabel(message);
	const thinking = activeVariant.thinking ?? activeVariant.thinkingText;
	const thinkingDuration = activeVariant.thinking_duration ?? activeVariant.thinkingDuration;
	const toolCalls = activeVariant.tool_calls ?? activeVariant.toolCalls;
	const steps = activeVariant.executionSteps;
	return (
		<div className="min-w-0 w-full whitespace-normal">
			{showHeader && <MessageContextStatus message={message} />}
			{showHeader && <div className="mb-2 text-xs text-[var(--text-muted)]">{displayName}</div>}
			{steps?.length > 0 && (
				<div
					key={`${message.id ?? "message"}:${index}`}
					className="message-execution-timeline mb-3 space-y-2"
				>
					{steps.map((step, idx) => {
						if (step.type === "thought") {
							return (
								<ThoughtBlock
									key={step.id ?? idx}
									content={step.content}
									durationMs={step.durationMs}
								/>
							);
						}
						if (step.type === "tool_call") {
                            if (step.toolName === 'delegate_task') return <SubAgentBadge key={step.id ?? idx} step={step} />;
							return (
								<ToolCallBlock
									key={step.id ?? idx}
									step={step}
								/>
							);
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
					rehypePlugins={[rehypeRaw, rehypeMediaSources, [rehypeSanitize, mediaSchema]]}
					urlTransform={mediaUrlTransform}
					components={components}
				>
					{activeVariant.content ||
						(message.streaming || steps?.length || toolCalls?.length || thinking ? "" : "...")}
				</ReactMarkdown>
			</div>
            {message.status === 'interrupted' && <div role="status" className="mt-3 text-xs text-[var(--text-muted)]">
                ⚠ Execution interrupted. Saved progress is shown above.
            </div>}
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
							onClick={() =>
								onSelectReplyVariant
									? onSelectReplyVariant(message, index - 1)
									: onSelectVariant?.(index - 1)
							}
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
							onClick={() =>
								onSelectReplyVariant
									? onSelectReplyVariant(message, index + 1)
									: onSelectVariant?.(index + 1)
							}
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
});

export default ChatMessage;

export function MessageContextStatus({ message }) {
	const summarized =
		message.is_summarized === true || message.is_summarized === 1 || message.archived === 1;
	const timestamp = message.created_at;
	const date = timestamp
		? new Date(/Z$|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : timestamp.replace(" ", "T") + "Z")
		: null;
	if (!summarized && !date) return null;
	const explanation =
		"This message has been compressed into a summary to save context space. The AI can no longer see this exact phrasing.";
	return (
		<div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
			{date && !Number.isNaN(date.getTime()) && (
				<time
					dateTime={date.toISOString()}
					title={date.toLocaleString()}
				>
					{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
				</time>
			)}
			{summarized && (
				<span
					title={explanation}
					aria-label={`Summarized. ${explanation}`}
					tabIndex={0}
					className="rounded border border-[var(--subtle-border)] px-1.5 py-0.5"
				>
					[⚡ Summarized]
				</span>
			)}
		</div>
	);
}

export function StatsFooter({ stats }) {
	stats = {
		...stats,
		tokensPerSecond: stats.tokens_per_sec ?? stats.tokensPerSecond,
		totalTokens: stats.total_tokens ?? stats.totalTokens,
		promptTokens: stats.prompt_tokens ?? stats.promptTokens,
		completionTokens: stats.completion_tokens ?? stats.completionTokens,
		time: stats.duration ?? stats.time,
	};

	const isMultiPass = stats.scope !== "final";
	const promptFormatted = stats.promptTokens != null ? stats.promptTokens.toLocaleString() : "—";
	const genFormatted = stats.completionTokens != null ? stats.completionTokens.toLocaleString() : "—";
	const totalFormatted = stats.totalTokens != null ? stats.totalTokens.toLocaleString() : "—";

	// Human-friendly hover tooltips
	const tokenTooltip = isMultiPass
		? `Cumulative Workload (All Tool Turns):\n• Prompt Context re-processed: ${promptFormatted}\n• Output Tokens Generated: ${genFormatted}\n• Total Compute Workload: ${totalFormatted}`
		: `Single Turn Usage:\n• Prompt Context: ${promptFormatted}\n• Response Generated: ${genFormatted}`;

	const speedTooltip = isMultiPass
		? "Average generation speed across all tool execution rounds"
		: "Generation speed for this response";

	return (
		<footer
			aria-label="Generation statistics"
			className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]"
		>
			{/* Generation Speed */}
			<span
				className="inline-flex items-center gap-1"
				title={speedTooltip}
			>
				<FiZap aria-hidden="true" />{" "}
				{stats.tokensPerSecond == null ? "—" : stats.tokensPerSecond.toFixed(1)} tok/sec
			</span>

			{/* Token Breakdown */}
			<span
				className="inline-flex items-center gap-1 cursor-help"
				title={tokenTooltip}
			>
				<FiFileText aria-hidden="true" />{" "}
				{stats.totalTokens == null
					? "Tokens unavailable"
					: isMultiPass
						? `${totalFormatted} tokens processed`
						: `${genFormatted} gen (${promptFormatted} ctx)`}
			</span>

			{/* Duration */}
			<span
				className="inline-flex items-center gap-1"
				title={isMultiPass ? "Total time spent across all tool loops" : "Response generation time"}
			>
				<FiClock aria-hidden="true" /> {stats.time == null ? "—" : stats.time.toFixed(1)}s
			</span>

			{/* Tool Loop Indicator Badge */}
			{isMultiPass ? (
				<span
					className="rounded bg-[var(--bg-subtle,#2a2d3e)] px-1.5 py-0.5 text-[10px] opacity-75 cursor-help"
					title="The model executed intermediate tool rounds. This token count reflects total GPU compute across all turns, not your active chat memory size."
				>
					Multi-turn tool loop
				</span>
			) : (
				<span
					className="rounded bg-[var(--bg-subtle,#2a2d3e)] px-1.5 py-0.5 text-[10px] opacity-75"
					title="Direct response without internal tool calls"
				>
					Single turn
				</span>
			)}
		</footer>
	);
}

export function SubAgentBadge({ step }) {
    let args = step.args ?? step.function?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const files = Array.isArray(args?.target_files) ? args.target_files.filter(file => typeof file === 'string') : [];
    const running = ['pending', 'running'].includes(step.status);
    const failed = ['error', 'cancelled'].includes(step.status) || step.result?.success === false || step.result?.isError;
    const label = running ? `Researching ${files.length} files...` : failed ? 'Research failed' : `Researched ${files.length} files`;
    const result = typeof step.result === 'string' ? step.result : step.error || step.result?.error;
    return <details className="mb-2 rounded-lg border border-[var(--subtle-border)] bg-[var(--surface)] text-xs" aria-label="Sub-agent delegation">
        <summary className="cursor-pointer rounded-lg px-3 py-2 text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
            <span aria-live="polite">[🤖 Sub-Agent Delegated: {label}]</span>
        </summary>
        <div className="space-y-3 border-t border-[var(--subtle-border)] p-3">
            {typeof args?.task_description === 'string' && <p className="whitespace-pre-wrap break-words">{args.task_description}</p>}
            {files.length > 0 && <ul aria-label="Research files" className="list-disc pl-5">{files.map((file, index) => <li className="break-all" key={index}>{file}</li>)}</ul>}
            <p className={`whitespace-pre-wrap break-words ${failed ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'}`}>
                {running ? 'The main agent is waiting for the research summary.' : result || 'No summary was saved.'}
            </p>
        </div>
    </details>;
}

export function ToolCallBadge({ toolCalls }) {
	return (
		<div
			aria-label="Tool executions"
			className="mb-2 space-y-1"
		>
			{toolCalls.map((call, index) => (call.toolName || call.function?.name) === 'delegate_task'
                ? <SubAgentBadge key={call.id || index} step={call} /> : (
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

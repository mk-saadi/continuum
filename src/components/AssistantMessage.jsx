import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismAsync as SyntaxHighlighter } from "react-syntax-highlighter";
import { FiCheck, FiClock, FiCopy, FiFileText, FiZap } from "react-icons/fi";

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

export default function AssistantMessage({ message }) {
	return (
		<div className="min-w-0 whitespace-normal">
			{message.toolCalls?.length > 0 && <ToolCallBadge toolCalls={message.toolCalls} />}
			{message.thinkingText && (
				<ThinkingAccordion
					text={message.thinkingText}
					duration={message.thinkingDuration}
				/>
			)}
			<div className="assistant-markdown prose prose-sm max-w-none text-inherit [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h1]:my-3 [&_h2]:my-3 [&_h3]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-current [&_blockquote]:pl-3 [&_blockquote]:opacity-80 [&_hr]:my-3">
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={components}
				>
					{message.content ||
						(message.streaming || message.toolCalls?.length || message.thinkingText ? "" : "...")}
				</ReactMarkdown>
			</div>
			{message.role === "assistant" && message.stats && <StatsFooter stats={message.stats} />}
		</div>
	);
}

export function StatsFooter({ stats }) {
	const scope = stats.scope === "final" ? "Final generation phase" : "All generation phases";
	return (
		<footer
			aria-label="Generation statistics"
			className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--subtle-border)] pt-2 text-[10px] text-[var(--text-muted)]"
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
			className="space-y-2"
		>
			{toolCalls.map((call, index) => (
				<div
					key={call.id || index}
					role="status"
					className="my-2 rounded border border-[var(--tool-border)] p-2 text-xs"
				>
					<strong>
						{call.serverName ? `${call.serverName} / ` : ""}
						{call.toolName ||
							(typeof call.function?.name === "string" ? call.function.name : "Tool")}
					</strong>
					{call.status && <> · {call.status === "pending" ? "Running…" : call.status}</>}
					{call.error && <p className="mt-1 whitespace-pre-wrap">{call.error}</p>}
				</div>
			))}
		</div>
	);
}

export function ThinkingAccordion({ text, duration }) {
	return (
		<details className="my-2 rounded border border-[var(--subtle-border)] text-xs">
			<summary className="cursor-pointer px-3 py-2 text-[var(--text-muted)]">
				Thinking{duration != null ? ` · ${duration.toFixed(1)}s` : ""}
			</summary>
			<div className="border-t border-[var(--subtle-border)] px-3 py-2 whitespace-pre-wrap break-words">
				{text}
			</div>
		</details>
	);
}

// import React, { useState } from "react";
// import ReactMarkdown from "react-markdown";
// import remarkGfm from "remark-gfm";
// import { PrismAsync as SyntaxHighlighter } from "react-syntax-highlighter";

// const syntaxTheme = {
// 	'pre[class*="language-"]': { background: "transparent", color: "var(--code-text)" },
// 	'code[class*="language-"]': { background: "transparent", color: "var(--code-text)" },
// 	comment: { color: "var(--code-comment)" },
// 	prolog: { color: "var(--code-comment)" },
// 	doctype: { color: "var(--code-comment)" },
// 	cdata: { color: "var(--code-comment)" },
// 	punctuation: { color: "var(--code-text)" },
// 	property: { color: "var(--code-key)" },
// 	tag: { color: "var(--code-key)" },
// 	boolean: { color: "var(--code-literal)" },
// 	number: { color: "var(--code-literal)" },
// 	constant: { color: "var(--code-literal)" },
// 	symbol: { color: "var(--code-literal)" },
// 	selector: { color: "var(--code-key)" },
// 	"attr-name": { color: "var(--code-key)" },
// 	string: { color: "var(--code-string)" },
// 	char: { color: "var(--code-string)" },
// 	builtin: { color: "var(--code-string)" },
// 	inserted: { color: "var(--code-string)" },
// 	operator: { color: "var(--code-text)" },
// 	entity: { color: "var(--code-text)" },
// 	url: { color: "var(--code-string)" },
// 	atrule: { color: "var(--code-key)" },
// 	"attr-value": { color: "var(--code-string)" },
// 	keyword: { color: "var(--code-keyword)" },
// 	function: { color: "var(--code-function)" },
// 	"class-name": { color: "var(--code-function)" },
// 	regex: { color: "var(--code-literal)" },
// 	important: { color: "var(--code-literal)" },
// 	variable: { color: "var(--code-text)" },
// 	deleted: { color: "var(--error)" },
// };

// function CodeBlock({ code, language }) {
// 	const [copied, setCopied] = useState(false);
// 	async function copy() {
// 		try {
// 			await navigator.clipboard.writeText(code.replace(/\n$/, ""));
// 			setCopied(true);
// 			setTimeout(() => setCopied(false), 2000);
// 		} catch {
// 			setCopied(false);
// 		}
// 	}
// 	return (
// 		<div className="my-3 min-w-0 overflow-hidden rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)] text-[var(--code-text)]">
// 			<div className="flex items-center justify-between border-b border-[var(--code-border)] px-3 py-1.5 text-[11px] text-[var(--code-muted)]">
// 				<span>{language || "text"}</span>
// 				<button
// 					type="button"
// 					onClick={copy}
// 					aria-label="Copy code"
// 					className="cursor-pointer rounded px-2 py-1 text-[var(--code-text)] hover:bg-[var(--code-button-hover)]"
// 				>
// 					{copied ? "Copied" : "▢ Copy"}
// 				</button>
// 			</div>
// 			<SyntaxHighlighter
// 				language={language || "text"}
// 				style={syntaxTheme}
// 				customStyle={{
// 					margin: 0,
// 					padding: "12px 16px",
// 					background: "transparent",
// 					maxWidth: "100%",
// 					overflowX: "auto",
// 					fontSize: "12px",
// 					lineHeight: 1.55,
// 				}}
// 			>
// 				{code.replace(/\n$/, "")}
// 			</SyntaxHighlighter>
// 		</div>
// 	);
// }

// const components = {
// 	pre: ({ children }) => <>{children}</>,
// 	code({ className, children, node, ...props }) {
// 		const code = String(children);
// 		const language = /language-([^\s]+)/.exec(className || "")?.[1];
// 		if (language || code.endsWith("\n"))
// 			return (
// 				<CodeBlock
// 					code={code}
// 					language={language}
// 				/>
// 			);
// 		return (
// 			<code
// 				{...props}
// 				className={`${className || ""} rounded bg-[var(--inline-code-bg)] px-1 py-0.5 font-mono text-[var(--text-primary)]`}
// 			>
// 				{children}
// 			</code>
// 		);
// 	},
// 	a: ({ node, ...props }) => (
// 		<a
// 			{...props}
// 			target="_blank"
// 			rel="noopener noreferrer"
// 			className="text-[var(--link)] underline"
// 		/>
// 	),
// };

// export default function AssistantMessage({ message }) {
// 	return (
// 		<div className="min-w-0 whitespace-normal">
// 			{message.toolCalls?.length > 0 && <ToolCallBadge toolCalls={message.toolCalls} />}
// 			{message.thinkingText && (
// 				<ThinkingAccordion
// 					text={message.thinkingText}
// 					duration={message.thinkingDuration}
// 				/>
// 			)}
// 			<div className="assistant-markdown prose prose-sm max-w-none text-inherit [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h1]:my-3 [&_h2]:my-3 [&_h3]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-current [&_blockquote]:pl-3 [&_blockquote]:opacity-80 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:border-[var(--attachment-border)] [&_th]:p-2 [&_td]:border [&_td]:border-[var(--attachment-border)] [&_td]:p-2 [&_hr]:my-3">
// 				<ReactMarkdown
// 					remarkPlugins={[remarkGfm]}
// 					components={components}
// 				>
// 					{message.content ||
// 						(message.streaming || message.toolCalls?.length || message.thinkingText ? "" : "...")}
// 				</ReactMarkdown>
// 			</div>
// 			{message.role === "assistant" && message.stats && <StatsFooter stats={message.stats} />}
// 		</div>
// 	);
// }

// export function StatsFooter({ stats }) {
// 	const scope = stats.scope === "final" ? "Final generation phase" : "All generation phases";
// 	return (
// 		<footer
// 			aria-label="Generation statistics"
// 			className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--subtle-border)] pt-2 text-[10px] text-[var(--text-muted)]"
// 		>
// 			<span
// 				title={`${scope}: ${stats.generationTime != null ? "server generation timing" : "elapsed-time throughput"}`}
// 			>
// 				⚡ {stats.tokensPerSecond == null ? "—" : stats.tokensPerSecond.toFixed(1)} tok/sec
// 			</span>
// 			<span
// 				title={`${scope}. Prompt: ${stats.promptTokens ?? "unavailable"}; generated: ${stats.completionTokens ?? "unavailable"}`}
// 			>
// 				📝{" "}
// 				{stats.totalTokens == null
// 					? "Tokens unavailable"
// 					: `${stats.totalTokens.toLocaleString()} total tokens`}
// 			</span>
// 			<span title={`${scope}: elapsed time`}>
// 				⏱️ {stats.time == null ? "—" : stats.time.toFixed(1)}s
// 			</span>
// 			{stats.scope === "final" && (
// 				<span title="Earlier tool phases did not report complete usage">Final phase</span>
// 			)}
// 		</footer>
// 	);
// }

// export function ToolCallBadge({ toolCalls }) {
// 	return (
// 		<div
// 			aria-label="Tool executions"
// 			className="space-y-2"
// 		>
// 			{toolCalls.map((call, index) => (
// 				<div
// 					key={call.id || index}
// 					role="status"
// 					className="my-2 rounded border border-[var(--tool-border)] p-2 text-xs"
// 				>
// 					<strong>
// 						{call.serverName ? `${call.serverName} / ` : ""}
// 						{call.toolName ||
// 							(typeof call.function?.name === "string" ? call.function.name : "Tool")}
// 					</strong>
// 					{call.status && <> · {call.status === "pending" ? "Running…" : call.status}</>}
// 					{call.error && <p className="mt-1 whitespace-pre-wrap">{call.error}</p>}
// 				</div>
// 			))}
// 		</div>
// 	);
// }

// export function ThinkingAccordion({ text, duration }) {
// 	return (
// 		<details className="my-2 rounded border border-[var(--subtle-border)] text-xs">
// 			<summary className="cursor-pointer px-3 py-2 text-[var(--text-muted)]">
// 				Thinking{duration != null ? ` · ${duration.toFixed(1)}s` : ""}
// 			</summary>
// 			<div className="border-t border-[var(--subtle-border)] px-3 py-2 whitespace-pre-wrap break-words">
// 				{text}
// 			</div>
// 		</details>
// 	);
// }

import React, { useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import { FiEdit2, FiSearch, FiRotateCcw, FiRotateCw } from "react-icons/fi";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { syntaxTheme } from "../lib/syntaxTheme.mjs";
import "./workspaceFileEditor.css";
import FileSelectionMenu from "./FileSelectionMenu.jsx";
import ChatFindBar from "./chat/ChatFindBar.jsx";

const button =
	"material-control sk-button material-fill sk-fill ui-radius-control flex h-7 items-center justify-center gap-1 px-2 disabled:opacity-40 disabled:cursor-not-allowed";

// Keep find navigation and toolbar updates from tokenizing the entire file again.
const HighlightedCode = React.memo(function HighlightedCode({ text, language, wrap }) {
	return (
		<SyntaxHighlighter
			language={language}
			style={syntaxTheme}
			showLineNumbers
			wrapLines
			wrapLongLines={wrap}
			lineProps={{
				style: {
					display: "block",
					position: "relative",
					paddingLeft: "4em",
					minHeight: "18px",
					whiteSpace: wrap ? "pre-wrap" : "pre",
					overflowWrap: wrap ? "anywhere" : "normal",
				},
			}}
			lineNumberStyle={{
				position: "absolute",
				left: 0,
				top: 0,
				width: "3em",
				minWidth: "3em",
				paddingRight: "1em",
				color: "var(--code-muted)",
				userSelect: "none",
			}}
			customStyle={{
				margin: 0,
				padding: "16px",
				background: "transparent",
				fontSize: "12px",
				lineHeight: "18px",
				fontFamily: "var(--font-mono)",
				overflow: "visible",
				width: wrap ? "100%" : "max-content",
				minWidth: "100%",
				tabSize: 4,
			}}
			codeTagProps={{ style: { font: "inherit" } }}
		>
			{text + (text.endsWith("\n") || !text ? " " : "")}
		</SyntaxHighlighter>
	);
});
const MAX_FIND_MATCHES = 500;
const HISTORY_BUDGET = 4 * 1024 * 1024;
function retainHistory(entries) {
	let size = 0;
	let start = entries.length;
	while (start > 0 && entries.length - start < 100) {
		const next = entries[start - 1].length * 2;
		if (size + next > HISTORY_BUDGET) break;
		size += next;
		start--;
	}
	return entries.slice(start);
}

export default function WorkspaceFileEditor({
	projectId,
	path,
	content,
	truncated,
	wrap,
	drafts,
	language = "text",
	onAddToChat,
}) {
	const key = JSON.stringify([projectId, path]);
	const [history, setHistory] = useState(
		() => drafts.current[key]?.history || { past: [], text: content, future: [] },
	);
	const [saved, setSaved] = useState(() => drafts.current[key]?.saved ?? content);
	const [editing, setEditing] = useState(() => !!drafts.current[key]);
	const [finding, setFinding] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const editor = useRef(null);
	const surface = useRef(null);
	const paint = useRef(null);
	const scrollPosition = useRef({ top: 0, left: 0 });
	const lastFindNavigation = useRef(null);
	const dirty = history.text !== saved;
	useEffect(() => {
		// Only unsaved work needs to survive file switches. Browsing clean files
		// must not grow a permanent cache of file contents and undo snapshots.
		if (dirty) drafts.current[key] = { history, saved, dirty };
		else delete drafts.current[key];
	}, [history, saved, dirty, key, drafts]);
	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!finding || !needle) return [];
		const source = history.text.toLowerCase();
		const result = [];
		for (
			let pos = source.indexOf(needle);
			pos !== -1 && result.length < MAX_FIND_MATCHES;
			pos = source.indexOf(needle, pos + needle.length)
		)
			result.push(pos);
		return result;
	}, [history.text, query, finding]);
	useEffect(() => {
		setActive(0);
	}, [query, history.text]);
	useEffect(() => {
		const root = paint.current;
		if (!root || !CSS.highlights || !finding || !matches.length) return;
		const ranges = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				node.parentElement.closest(".react-syntax-highlighter-line-number")
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT,
		});
		const nodes = [];
		let offset = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode;
			nodes.push({ node, start: offset });
			offset += node.length;
		}
		let firstIndex = 0;
		let lastIndex = 0;
		for (const start of matches) {
			const end = start + query.trim().length;
			while (
				firstIndex < nodes.length &&
				nodes[firstIndex].start + nodes[firstIndex].node.length <= start
			)
				firstIndex++;
			lastIndex = Math.max(firstIndex, lastIndex);
			while (lastIndex < nodes.length && nodes[lastIndex].start + nodes[lastIndex].node.length < end)
				lastIndex++;
			const first = nodes[firstIndex];
			const last = nodes[lastIndex];
			if (!first || !last) continue;
			const range = new Range();
			range.setStart(first.node, start - first.start);
			range.setEnd(last.node, end - last.start);
			ranges.push(range);
		}
		// Each editor owns its highlights, including when multiple chats are mounted.
		const id =
			root.dataset.highlightId || (root.dataset.highlightId = `file-find-${crypto.randomUUID()}`);
		const style = document.createElement("style");
		style.textContent = `::highlight(${id}) { background: var(--accent); color: var(--bg-primary); } ::highlight(${id}-active) { background: var(--warning, #e7ad44); color: var(--bg-primary); }`;
		document.head.append(style);
		CSS.highlights.set(id, new Highlight(...ranges));
		CSS.highlights.set(id + "-active", new Highlight(...(ranges[active] ? [ranges[active]] : [])));
		const range = ranges[active];
		const previous = lastFindNavigation.current;
		const navigate =
			!previous ||
			previous.matches !== matches ||
			previous.active !== active ||
			previous.finding !== finding;
		lastFindNavigation.current = { matches, active, finding };
		if (range && navigate) {
			const scroll = editing ? editor.current : surface.current;
			const rect = range.getBoundingClientRect();
			const bounds = scroll.getBoundingClientRect();
			scroll.scrollTop += rect.top - bounds.top - scroll.clientHeight / 2;
			if (!wrap) scroll.scrollLeft += rect.left - bounds.left - scroll.clientWidth / 2;
			if (editing) {
				editor.current.setSelectionRange(matches[active], matches[active] + query.trim().length);
				syncScroll();
			}
		}
		return () => {
			CSS.highlights.delete(id);
			CSS.highlights.delete(id + "-active");
			style.remove();
		};
	}, [matches, active, finding, query, editing, history.text, language, wrap]);
	function syncScroll() {
		if (paint.current && editor.current) {
			paint.current.style.transform = `translate(${-editor.current.scrollLeft}px, ${-editor.current.scrollTop}px)`;
		}
	}

	useLayoutEffect(() => {
		const node = editor.current;
		if (!editing || !node) {
			paint.current.style.transform = "";
			paint.current.style.width = "";
			surface.current.scrollTop = scrollPosition.current.top;
			surface.current.scrollLeft = scrollPosition.current.left;
			return;
		}
		// Preview scrolls the surface; Edit scrolls the transparent input.
		// Only one may scroll at a time or their offsets would be applied twice.
		surface.current.scrollTop = 0;
		surface.current.scrollLeft = 0;
		node.scrollTop = scrollPosition.current.top;
		node.scrollLeft = scrollPosition.current.left;
		const resize = () => {
			paint.current.style.width = `${node.clientWidth}px`;
			syncScroll();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(node);
		resize();
		return () => observer.disconnect();
	}, [editing]);
	function toggleEditing() {
		const node = editing ? editor.current : surface.current;
		scrollPosition.current = { top: node.scrollTop, left: node.scrollLeft };
		setEditing(!editing);
	}
	function undo() {
		setHistory((h) =>
			h.past.length
				? { past: h.past.slice(0, -1), text: h.past.at(-1), future: [h.text, ...h.future] }
				: h,
		);
	}
	function redo() {
		setHistory((h) =>
			h.future.length
				? { past: retainHistory([...h.past, h.text]), text: h.future[0], future: h.future.slice(1) }
				: h,
		);
	}
	async function save() {
		if (!dirty || saving || truncated) return;
		setSaving(true);
		setError("");
		const text = history.text;
		try {
			await window.api.writeWorkspaceFile(projectId, path, text, saved);
			setSaved(text);
		} catch (error) {
			setError(error.message);
		} finally {
			setSaving(false);
		}
	}
	function find() {
		setFinding(true);
	}
	return (
		<div
			className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col"
			data-file-editor
			onKeyDown={(event) => {
				if (!(event.ctrlKey || event.metaKey)) return;
				const key = event.key.toLowerCase();
				if (["f", "s", "z", "y"].includes(key)) {
					event.preventDefault();
					event.stopPropagation();
					if (key === "f") find();
					else if (key === "s") save();
					else if (key === "y" || event.shiftKey) redo();
					else undo();
				}
			}}
		>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs">
				<button
					className={button}
					aria-pressed={editing}
					onClick={toggleEditing}
				>
					<FiEdit2 />
					{editing ? "Preview" : "Edit"}
				</button>
				<button
					className={button}
					aria-label="Undo file edit"
					disabled={!history.past.length || truncated}
					onClick={undo}
				>
					<FiRotateCcw />
				</button>
				<button
					className={button}
					aria-label="Redo file edit"
					disabled={!history.future.length || truncated}
					onClick={redo}
				>
					<FiRotateCw />
				</button>
				<button
					className={button}
					aria-label="Find in file"
					onClick={find}
				>
					<FiSearch />
				</button>
				{finding && matches.length === MAX_FIND_MATCHES && (
					<span className="text-[var(--text-muted)]">First 500 matches</span>
				)}
				<span
					role="status"
					className="text-[var(--text-muted)]"
				>
					{truncated
						? "Partial file · read only"
						: saving
							? "Saving…"
							: dirty
								? "Unsaved changes · Ctrl+S to save"
								: "Saved"}
				</span>
			</div>
			<FileSelectionMenu
				paint={paint}
				editor={editor}
				editing={editing}
				text={history.text}
				path={path}
				dirty={dirty}
				onAddToChat={onAddToChat}
			/>
			{error && (
				<p
					role="alert"
					className="px-3 py-2 text-xs text-[var(--danger)]"
				>
					{error}
				</p>
			)}
			<div className="relative flex min-h-0 flex-1 flex-col">
				{finding && (
					<ChatFindBar
						label="Find in file"
						query={query}
						onQueryChange={setQuery}
						active={active}
						total={matches.length}
						onPrev={() => setActive((i) => (i - 1 + matches.length) % matches.length)}
						onNext={() => setActive((i) => (i + 1) % matches.length)}
						onClose={() => {
							setFinding(false);
							editor.current?.focus();
						}}
					/>
				)}
				<div
					ref={surface}
					className={`file-code-surface ${editing ? "is-editing" : ""} ${wrap ? "is-wrapped" : ""}`}
				>
					<div
						ref={paint}
						className="file-code-paint"
						aria-hidden={editing || undefined}
					>
						<HighlightedCode
							text={history.text}
							language={language}
							wrap={wrap}
						/>
					</div>
					{editing && (
						<textarea
							ref={editor}
							aria-label={`Edit ${path}`}
							readOnly={truncated}
							spellCheck={false}
							wrap={wrap ? "soft" : "off"}
							value={history.text}
							onScroll={syncScroll}
							onChange={(event) => {
								const text = event.target.value;
								setHistory((h) => ({
									past: retainHistory([...h.past, h.text]),
									text,
									future: [],
								}));
							}}
							className="file-code-input"
						/>
					)}
				</div>
			</div>
		</div>
	);
}

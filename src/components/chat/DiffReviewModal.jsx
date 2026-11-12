import "./diffReview.css";
import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { PrismAsync as SyntaxHighlighter } from "react-syntax-highlighter";
import { CheckboxField } from "../FormControls";
import { FiEye } from "react-icons/fi";
import { formatBytes, safetyVerdictInfo, restoreOutcomeMessage } from "../../lib/recoverySafety.mjs";
import { parseUnifiedDiff, SIDE_BY_SIDE_ROW_CAP } from "../../lib/diffView.mjs";
import { LuX } from "react-icons/lu";

const LANGUAGE_BY_EXTENSION = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	ts: "typescript",
	tsx: "tsx",
	json: "json",
	css: "css",
	scss: "scss",
	html: "markup",
	xml: "markup",
	svg: "markup",
	md: "markdown",
	mdx: "markdown",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	sh: "bash",
	bash: "bash",
	yml: "yaml",
	yaml: "yaml",
	sql: "sql",
};
const syntaxTheme = {
	'pre[class*="language-"]': { color: "var(--code-text)", background: "transparent" },
	'code[class*="language-"]': { color: "var(--code-text)", background: "transparent" },
	...Object.fromEntries(
		Object.entries({
			comment: "comment",
			prolog: "comment",
			punctuation: "muted",
			property: "key",
			tag: "key",
			"attr-name": "key",
			boolean: "literal",
			number: "literal",
			constant: "literal",
			string: "string",
			char: "string",
			"attr-value": "string",
			keyword: "keyword",
			function: "function",
			"class-name": "function",
		}).map(([token, color]) => [token, { color: `var(--code-${color})` }]),
	),
};

// Render the highlighter's safe token tree as React elements, never raw HTML.
function renderToken(node, key, stylesheet) {
	if (node.type === "text") return node.value;
	const classes = node.properties?.className ?? [];
	return (
		<span
			key={key}
			style={Object.assign({}, ...classes.map((name) => stylesheet[name]))}
		>
			{node.children?.map((child, index) => renderToken(child, index, stylesheet))}
		</span>
	);
}

// Highlight a whole column once so multiline comments and strings keep their
// syntax context. Each pane owns one horizontal scrollbar, shared by all rows.
const DiffCodePane = React.memo(function DiffCodePane({ rows, side, language, unified = false, onScroll, wrap = false }) {
    const lineNumberDigits = rows.reduce((digits, row) => Math.max(digits, String(row[`${side}No`] ?? '').length), 4);
	const text = rows
		.map((row) => (row.type === "hunk" || row.type === "note" ? row.text : (row[side] ?? "")))
		.join("\n");
	return (
		<div
			className="min-h-0 min-w-0 h-full overflow-auto"
            onScroll={onScroll}
			tabIndex={0}
			aria-label={unified ? "Unified code" : side === "left" ? "Original code" : "Updated code"}
		>
			<SyntaxHighlighter
				language={text.length > 64 * 1024 ? 'text' : language}
				style={syntaxTheme}
				wrapLines
				customStyle={{
					margin: 0,
					padding: 0,
					background: "transparent",
					fontSize: 11,
					lineHeight: "22px",
					fontFamily: "var(--font-mono)",
					overflow: "visible",
				}}
				codeTagProps={{ style: { fontFamily: "inherit", display: "block", minWidth: wrap ? 0 : "max-content" } }}
				renderer={({ rows: tokens, stylesheet }) =>
					tokens.map((token, index) => {
						const row = rows[index];
						if (!row) return null;
						const meta = row.type === "hunk" || row.type === "note";
						const added =
							(unified || side === "right") && (row.type === "add" || row.type === "change");
						const removed =
							(unified || side === "left") && (row.type === "del" || row.type === "change");
						const tone = meta
							? "bg-[var(--surface-hover)] text-[var(--text-secondary)]"
							: added
								? "bg-[var(--success)]/10"
								: removed
									? "bg-[var(--error)]/10"
									: "";
						return (
							<div
								key={index}
								data-diff-row=""
                                className={`flex min-h-[22px] ${tone}`}
							>
								{!unified && <span
									aria-hidden="true"
									style={{ width: `calc(${lineNumberDigits}ch + 12px)`, paddingLeft: 6, paddingRight: 6, fontSize: 10 }}
                                    className="sticky left-0 shrink-0 select-none border-r border-[var(--code-border)] bg-[var(--code-bg)] text-right text-[var(--text-muted)] tabular-nums"
								>
									{meta ? "" : row[`${side}No`]}
								</span>}
								<span
									aria-hidden="true"
									className={`w-5 shrink-0 select-none text-center ${added ? "text-[var(--success)]" : removed ? "text-[var(--error)]" : ""}`}
								>
									{added ? "+" : removed ? (unified ? "-" : "−") : ""}
								</span>
								<span className="min-w-0 pr-4" style={{ whiteSpace: wrap ? "pre-wrap" : "pre", overflowWrap: wrap ? "anywhere" : "normal" }}>
									{meta ? row.text : renderToken(token, index, stylesheet)}
								</span>
							</div>
						);
					})
				}
			>
				{text}
			</SyntaxHighlighter>
		</div>
	);
});

const STATUS_TONE = {
	modified: "text-[var(--warning)]",
	added: "text-[var(--accent-bright)]",
	deleted: "text-[var(--error)]",
	renamed: "text-[var(--accent-bright)]",
	untracked: "text-[var(--text-muted)]",
};

const FLAG_TONE = {
	staged: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	unstaged: "bg-[var(--warning)]/15 text-[var(--warning)]",
	untracked: "bg-[var(--surface-hover)] text-[var(--text-secondary)]",
};

// Diff review for uncommitted workspace changes: changed-file list from git
// worktree status, per-file diffs, and per-file revert through the recovery
// checkpoint engine (latest covering checkpoint, preview-then-confirm).
// Read-only until the user confirms; revert refuses while its run is active.
export default function DiffReviewModal({ sessionId, projectName, running = false, onClose, embedded = false, filePath = null, wrap = false }) {
	const dialogRef = useRef(null);
    const synchronizedScroll = useRef(new WeakMap());
    const syncDiffScroll = useCallback((event) => {
      const source = event.currentTarget;
      const expected = synchronizedScroll.current.get(source);
      if (expected && expected.left === source.scrollLeft && expected.top === source.scrollTop) {
        synchronizedScroll.current.delete(source);
        return;
      }
      for (const target of source.parentElement.children) {
        if (target === source) continue;
        target.scrollLeft = source.scrollLeft;
        target.scrollTop = source.scrollTop;
        synchronizedScroll.current.set(target, { left: target.scrollLeft, top: target.scrollTop });
      }
    }, []);

	const [files, setFiles] = useState(null);
	const [filesTruncated, setFilesTruncated] = useState(false);
	const [branch, setBranch] = useState(null);
	const [selectedPath, setSelectedPath] = useState(null);
	const [diff, setDiff] = useState(null);
	const [covering, setCovering] = useState(null);
	const [view, setView] = useState(embedded ? "unified" : "split");
	const [recoveryExpanded, setRecoveryExpanded] = useState(false);
	const [preview, setPreview] = useState(null);
	const [force, setForce] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	// Explicit user authorization for a risky-content revert. Never set
	// programmatically: only the checkbox below flips it, and any new basis
	// (selection, flags, preview) clears it.
	const [riskyConfirmed, setRiskyConfirmed] = useState(false);
	// Re-entrancy guard: `busy` state lags rapid double clicks, so the ref
	// is the actual single-flight gate for preview/revert dispatches.
	const busyRef = useRef(false);

	useEffect(() => {
		if (embedded) return;
		const element = dialogRef.current;
		if (element && !element.open) {
			try {
				element.showModal();
			} catch {
				/* Already open or unsupported; content still renders. */
			}
		}
		return () => {
			if (element?.open) element.close();
		};
	}, [embedded]);

	const loadFiles = async (selectFirst) => {
		setError("");
		try {
			if (!window.api?.getRecoveryChangedFiles) throw new Error("Diff review is unavailable here.");
			const value = await window.api.getRecoveryChangedFiles(sessionId, { includeCounts: !embedded });
			setBranch(value.branch ?? null);
			setFiles(value.files ?? []);
			setFilesTruncated(!!value.truncated);
			if (selectFirst && (value.files ?? []).length) setSelectedPath(filePath ?? value.files[0].path);
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		}
	};

	useEffect(() => {
		setFiles(null);
		setFilesTruncated(false);
		setBranch(null);
		setSelectedPath(filePath);
		setDiff(null);
		setCovering(null);
		setView(embedded ? "unified" : "split");
		setPreview(null);
		setConfirming(false);
		setRiskyConfirmed(false);
		setNotice("");
		setRecoveryExpanded(false);
		loadFiles(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionId, filePath]);

	useEffect(() => {
		if (selectedPath == null) {
			setDiff(null);
			setCovering(null);
			setView(embedded ? "unified" : "split");
			setPreview(null);
			setConfirming(false);
			setRiskyConfirmed(false);
			return;
		}
		let active = true;
		setDiff(null);
		setCovering(null);
		setView(embedded ? "unified" : "split");
		setPreview(null);
		setConfirming(false);
		setRiskyConfirmed(false);
		setError("");
		Promise.all([
			window.api.getRecoveryFileDiff(sessionId, selectedPath),
			window.api.getRecoveryCoveringCheckpoint(sessionId, selectedPath),
		]).then(
			([fileDiff, cover]) => {
				if (active) {
					setDiff(fileDiff);
					setCovering(cover);
				}
			},
			(cause) => {
				if (active) setError(cause?.message ?? String(cause));
			},
		);
		return () => {
			active = false;
		};
	}, [sessionId, selectedPath]);

	// Untracked content is raw file text, not a unified diff: every line is
	// an addition against an empty left side. Tracked diffs go through the
	// shared unified parser; anything unparseable falls back to unified.
	const splitRows = () => {
		if (!diff || diff.binary || diff.text == null || diff.text === "") return null;
		if (diff.untracked) {
			const lines = diff.text.split("\n");
			if (lines.length > SIDE_BY_SIDE_ROW_CAP) return null;
			return {
				ok: true,
				hunks: 0,
				capped: false,
				rows: lines.map((line, index) => ({
					type: "add",
					leftNo: null,
					left: null,
					rightNo: index + 1,
					right: line,
				})),
			};
		}
		return parseUnifiedDiff(diff.text);
	};
	const split = useMemo(splitRows, [diff]);
	const language = LANGUAGE_BY_EXTENSION[selectedPath?.split(".").pop()?.toLowerCase()] ?? "text";
	const unifiedRows = useMemo(
		() =>
			(diff?.text ?? "").split("\n").map((line) => {
				const type = diff?.untracked
					? "add"
					: line.startsWith("@@")
						? "hunk"
						: line.startsWith("+") && !line.startsWith("+++")
							? "add"
							: line.startsWith("-") && !line.startsWith("---")
								? "del"
								: "context";
				const content =
					!diff?.untracked && (type === "add" || type === "del" || line.startsWith(" "))
						? line.slice(1)
						: line;
				return { type, right: content, rightNo: null, text: line };
			}),
		[diff],
	);
    const displayedUnifiedRows = useMemo(() => embedded ? unifiedRows.filter(row => !/^(diff --git |index |--- |\+\+\+ )/.test(row.text)) : unifiedRows, [embedded, unifiedRows]);
	const splitAvailable = split?.ok === true;
	const effectiveView = view === "split" && splitAvailable ? "split" : "unified";

    useEffect(() => {
      if (!wrap || effectiveView !== 'split') return;
      const root = dialogRef.current;
      let frame;
      const align = () => {
        const left = root?.querySelectorAll('[aria-label="Original code"] [data-diff-row]');
        const right = root?.querySelectorAll('[aria-label="Updated code"] [data-diff-row]');
        if (!left || !right) return;
        [...left, ...right].forEach(row => { row.style.minHeight = '22px'; });
        left.forEach((row, i) => { if (right[i]) {
          const height = Math.max(row.getBoundingClientRect().height, right[i].getBoundingClientRect().height);
          row.style.minHeight = right[i].style.minHeight = `${height}px`;
        } });
      };
      const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(align); };
      const resize = new ResizeObserver(schedule);
      const mutations = new MutationObserver(schedule);
      root?.querySelectorAll('[aria-label="Original code"], [aria-label="Updated code"]').forEach(pane => resize.observe(pane));
      if (root) mutations.observe(root, { childList: true, subtree: true });
      schedule();
      return () => {
        cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
        root?.querySelectorAll('[data-diff-row]').forEach(row => { row.style.minHeight = ''; });
      };
    }, [wrap, effectiveView, split, language]);

	const runPreviewWith = async (forceValue) => {
		if (selectedPath == null || covering?.checkpointId == null || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			setPreview(
				await window.api.previewRecoveryRestore(sessionId, covering.checkpointId, {
					paths: [selectedPath],
					force: forceValue,
				}),
			);
			// A fresh preview is a new basis: prior authorization lapses.
			setRiskyConfirmed(false);
			setConfirming(false);
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const runPreview = async () => runPreviewWith(force);

	const refreshAfterRevert = async () => {
		const value = await window.api.getRecoveryChangedFiles(sessionId, { includeCounts: !embedded });
		setBranch(value.branch ?? null);
		setFiles(value.files ?? []);
		setFilesTruncated(!!value.truncated);
		if ((value.files ?? []).some((entry) => entry.path === selectedPath)) {
			const [fileDiff, cover] = await Promise.all([
				window.api.getRecoveryFileDiff(sessionId, selectedPath),
				window.api.getRecoveryCoveringCheckpoint(sessionId, selectedPath),
			]);
			setDiff(fileDiff);
			setCovering(cover);
		} else {
			setSelectedPath((value.files ?? [])[0]?.path ?? null);
		}
	};

	const runRevert = async () => {
		if (selectedPath == null || covering?.checkpointId == null || busyRef.current || running) return;
		busyRef.current = true;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			// Revalidate before applying: the workspace or the checkpoint may
			// have changed since the preview was taken. Never apply a stale
			// verdict, and never infer consent from an older preview.
			let fresh;
			try {
				fresh = await window.api.previewRecoveryRestore(sessionId, covering.checkpointId, {
					paths: [selectedPath],
					force,
				});
			} catch (cause) {
				setPreview(null);
				setConfirming(false);
				setRiskyConfirmed(false);
				setError(`This revert is no longer available: ${cause?.message ?? String(cause)}`);
				return;
			}
			const freshVerdict = fresh?.safety?.verdict ?? "safe";
			const shownVerdict = preview?.safety?.verdict ?? "safe";
			if (freshVerdict !== shownVerdict) {
				setPreview(fresh);
				setConfirming(false);
				setRiskyConfirmed(false);
				setNotice(
					"The workspace changed since this preview was taken — review the updated preview before confirming. Nothing was reverted.",
				);
				return;
			}
			const authorized =
				freshVerdict === "safe" ||
				(freshVerdict === "authorization-required" && riskyConfirmed) ||
				(freshVerdict === "refused" && riskyConfirmed && force);
			if (!authorized) {
				setPreview(fresh);
				setNotice(
					freshVerdict === "safe"
						? "Preview refreshed — review it before confirming. Nothing was reverted."
						: "This revert still needs your explicit confirmation below. Nothing was reverted.",
				);
				return;
			}
			const result = await window.api.restoreRecoveryCheckpoint(sessionId, covering.checkpointId, {
				paths: [selectedPath],
				force,
				allowRisky: riskyConfirmed,
			});
			if (result.strategy === "refused" || result.strategy === "authorization-required") {
				// Lost a race between validation and application (or the flags
				// were insufficient): surface the refusal, change nothing else.
				setPreview({ ...(fresh ?? {}), safety: result.safety, strategy: result.strategy });
				setConfirming(false);
				const info = safetyVerdictInfo(result.safety);
				setNotice(
					info != null
						? `${info.title}. ${info.footer}`
						: "Revert was not applied: authorization is still required. No files were changed.",
				);
				return;
			}
			const outcome = restoreOutcomeMessage(result);
			setNotice(outcome.text);
			setConfirming(false);
			setPreview(null);
			setRiskyConfirmed(false);
			await refreshAfterRevert();
		} catch (cause) {
			setError(`Revert failed: ${cause?.message ?? String(cause)}`);
			setConfirming(false);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const renderCounts = (entry) => {
		if (entry.binary)
			return `binary${typeof entry.bytes === "number" ? ` · ${formatBytes(entry.bytes)}` : ""}`;
		if (typeof entry.added === "number" && typeof entry.deleted === "number")
			return `+${entry.added}/−${entry.deleted}`;
		return "";
	};

	const renderRow = (entry) => (
		<li key={entry.path}>
			<button
				type="button"
				onClick={() => setSelectedPath(entry.path)}
				aria-pressed={selectedPath === entry.path}
				className="aero-list-item sk-list-row flex w-full cursor-pointer flex-wrap items-center gap-2 px-2.5 py-2 text-left ui-radius-control"
				aria-current={selectedPath === entry.path ? "true" : undefined}
			>
				<span
					className={`shrink-0 ui-radius-control px-1.5 py-0.5 font-mono text-[10px] ${STATUS_TONE[entry.status] ?? "text-[var(--text-muted)]"}`}
				>
					{entry.status}
				</span>
				<span className="order-first min-w-0 basis-full">
					<span
						className="block truncate font-mono text-[11px]"
						title={entry.path}
					>
						{entry.path}
					</span>
					<span className="block text-[10px] text-[var(--text-muted)] tabular-nums">
						{renderCounts(entry)}
						{entry.renamedFrom ? ` ← ${entry.renamedFrom}` : ""}
						{typeof entry.bytes === "number" && !entry.binary && entry.untracked
							? ` · ${formatBytes(entry.bytes)}`
							: ""}
					</span>
				</span>
				<span className="flex shrink-0 gap-1">
					{entry.staged && (
						<span className={`ui-radius-control px-1.5 py-0.5 text-[10px] ${FLAG_TONE.staged}`}>
							staged
						</span>
					)}
					{entry.unstaged && (
						<span className={`ui-radius-control px-1.5 py-0.5 text-[10px] ${FLAG_TONE.unstaged}`}>
							unstaged
						</span>
					)}
					{entry.untracked && (
						<span className={`ui-radius-control px-1.5 py-0.5 text-[10px] ${FLAG_TONE.untracked}`}>
							untracked
						</span>
					)}
				</span>
			</button>
		</li>
	);

	const invalidSelection = diff === null && covering === null && error !== "";
	const revertBlocked = running || busy || selectedPath == null || covering?.checkpointId == null;
	const safetyInfo = safetyVerdictInfo(preview?.safety);
	const confirmRiskyReady = safetyInfo == null || riskyConfirmed;
	const confirmForceReady = safetyInfo?.needsForce ? force : true;
	const confirmBlocked =
		busy ||
		running ||
		selectedPath == null ||
		invalidSelection ||
		covering?.checkpointId == null ||
		!confirmRiskyReady ||
		!confirmForceReady;

	const Container = embedded ? "div" : "dialog";
	return (
		<Container
			ref={dialogRef}
			aria-label="Review workspace changes"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
			onClick={(event) => {
				if (event.target === dialogRef.current && !busy) onClose();
			}}
			className={embedded ? "embedded-diff h-full min-h-0 overflow-hidden text-[var(--text-primary)]" : "aero-dialog sk-window sk-dialog fixed inset-0 m-auto h-[92dvh] max-h-[92dvh] w-[calc(100%-24px)] max-w-[1480px] overflow-hidden p-0"}
		>
			<div className="flex h-full min-h-0 flex-col">
				<header style={embedded ? { display: "none" } : undefined} className="aero-header sk-window-header sk-texture-grain flex shrink-0 items-center gap-2 px-4 py-3">
					<FiEye
						aria-hidden="true"
						className="shrink-0 text-[var(--accent)]"
					/>
					<h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
						Review changes
						{projectName ? (
							<span className="font-normal text-[var(--text-muted)]"> · {projectName}</span>
						) : null}
						{branch ? (
							<span className="font-normal text-[var(--text-muted)]"> · {branch}</span>
						) : null}
					</h2>
					<button
						type="button"
						className="aero-orb sk-icon-button aero-fill sk-fill flex size-7 shrink-0 items-center justify-center cursor-pointer"
						aria-label="Close settings"
						disabled={busy}
						onClick={() => {
							if (!busy) onClose();
						}}
						autoFocus
					>
						<LuX />
					</button>
				</header>
				<div className={embedded ? "diff-body flex min-h-0 flex-1 flex-col overflow-hidden text-xs" : "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 text-xs"}>
					{error && (
						<p
							role="alert"
							className="text-[var(--error)]"
						>
							{error}
						</p>
					)}
					{notice && (
						<p
							role="status"
							className="ui-radius-control bg-[var(--accent)]/10 px-2.5 py-2 text-[var(--accent-bright)]"
						>
							{notice}
						</p>
					)}
					{!files ? (
                        !error && <div role="status" className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[var(--text-muted)]">Loading changed files…</div>
                    ) : files.length === 0 ? (
						<p className="text-[var(--text-muted)]">No uncommitted changes in this workspace.</p>
					) : (
						<div className={embedded ? "flex min-h-0 flex-1 flex-col gap-2" : "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)] gap-3 md:grid-rows-1 md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)]"}>
                            {embedded && <select aria-label="Changed file" value="" onChange={event => { setSelectedPath(event.target.value); setRecoveryExpanded(false); }} className="diff-file-picker">
                              <option value="">Browse changes ({files.length})</option>
                              {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
                            </select>}
							<section
								hidden={embedded}
                                aria-label="Changed files"
								className={embedded ? "hidden" : "flex min-h-0 flex-col gap-2"}
							>
								<div className="flex items-center gap-2">
									<h3 className="text-xs font-semibold">Changed files ({files.length})</h3>
								</div>
								{filesTruncated && (
									<p className="text-[11px] text-[var(--text-muted)]">
										List truncated for display.
									</p>
								)}
								<ul className="aero-flat sk-list min-h-0 flex-1 space-y-1.5 overflow-auto p-1">
									{files.map(renderRow)}
								</ul>
							</section>
							<section
								aria-label="File diff"
								className="diff-file-section flex min-h-0 min-w-0 flex-1 flex-col gap-3"
							>
								{selectedPath == null ? (
									<p className="min-h-0 flex-1 text-[var(--text-muted)]">
										Select a file to review its diff.
									</p>
								) : !diff ? (
									<p className="min-h-0 flex-1 text-[var(--text-muted)]">Loading diff…</p>
								) : (
									<>
										<div className="diff-toolbar flex flex-wrap items-center gap-2">
											<h3
												className="min-w-0 flex-1 truncate font-mono text-xs"
												title={selectedPath}
											>
												{embedded ? <span className="flex items-center gap-2 font-sans font-normal"><span className="text-[var(--text-muted)]">{branch || 'Working tree'}</span><span className="text-[var(--success)]">+{(diff.text?.match(/^\+(?!\+)/gm) || []).length}</span><span className="text-[var(--error)]">−{(diff.text?.match(/^-(?!-)/gm) || []).length}</span></span> : selectedPath}
                                            </h3>
                                            {embedded && !diff.clean && <button type="button" aria-expanded={recoveryExpanded} onClick={() => setRecoveryExpanded(value => !value)} className="diff-recovery-toggle">Recovery</button>}
											<div
												className="flex gap-1"
												role="group"
												aria-label="Diff layout"
											>
												<button
													type="button"
													onClick={() => setView("split")}
													aria-pressed={effectiveView === "split"}
													disabled={!splitAvailable}
													className="aero-control sk-button aero-fill sk-fill px-2 py-0.5 text-[11px] cursor-pointer"
												>
													Side-by-side
												</button>
												<button
													type="button"
													onClick={() => setView("unified")}
													aria-pressed={effectiveView === "unified"}
													className="aero-control sk-button aero-fill sk-fill px-2 py-0.5 text-[11px] cursor-pointer"
												>
													Unified
												</button>
											</div>
										</div>
										<div
											className="flex min-h-0 flex-1 flex-col gap-2"
											aria-label="Diff content"
										>
											{diff.clean ? (
												<p className="text-[var(--text-muted)]">
													No changes — the file matches HEAD.
												</p>
											) : diff.binary ? (
												<p className="text-[var(--text-secondary)]">
													Binary file
													{typeof diff.bytes === "number"
														? `, ${formatBytes(diff.bytes)}`
														: ""}{" "}
													— content is not shown.
												</p>
											) : diff.unavailable || diff.text == null ? (
												<p className="text-[var(--text-secondary)]">
													Content unavailable
													{typeof diff.bytes === "number"
														? ` (${formatBytes(diff.bytes)})`
														: ""}{" "}
													— the file may be too large to preview.
												</p>
											) : diff.text === "" ? (
												<p className="text-[var(--text-muted)]">
													Empty file — no lines to show.
												</p>
											) : effectiveView === "split" ? (
												<div
													className="flex min-h-0 flex-1 flex-col overflow-hidden ui-radius-control border border-[var(--code-border)] bg-[var(--code-bg)]"
													aria-label="Side-by-side diff"
												>
													<div className="grid shrink-0 grid-cols-2 divide-x divide-[var(--code-border)] border-b border-[var(--code-border)] bg-[var(--surface-hover)] text-[11px] font-medium text-[var(--text-secondary)]">
														<div className="px-3 py-2">
															Original{" "}
															<span className="text-[var(--error)]">
																− removed
															</span>
														</div>
														<div className="px-3 py-2">
															Updated{" "}
															<span className="text-[var(--success)]">
																+ added
															</span>
														</div>
													</div>
													<div className="min-h-0 flex-1 overflow-hidden">
														<div className="grid h-full min-h-0 grid-cols-2 divide-x divide-[var(--code-border)]">
															<DiffCodePane wrap={wrap}
																onScroll={syncDiffScroll}
                                                        rows={split.rows}
																side="left"
																language={language}
															/>
															<DiffCodePane wrap={wrap}
																onScroll={syncDiffScroll}
                                                        rows={split.rows}
																side="right"
																language={language}
															/>
														</div>
													</div>
												</div>
											) : (
												<>
													{view === "split" && (
														<p className="text-[11px] text-[var(--text-muted)]">
															Side-by-side unavailable (too large to align) —
															showing unified.
														</p>
													)}
													<div className="min-h-0 flex-1 overflow-hidden ui-radius-control border border-[var(--code-border)] bg-[var(--code-bg)]">
														<DiffCodePane wrap={wrap}
															rows={displayedUnifiedRows}
															side="right"
															language={language}
															unified
														/>
													</div>
												</>
											)}
										</div>
										<div
											style={embedded && (!recoveryExpanded || diff.clean) ? { display: "none" } : undefined}
                                            className="diff-recovery-details max-h-[30dvh] shrink-0 space-y-2 overflow-y-auto"
											aria-label="Revert details"
										>
											{diff.truncated && (
												<p className="text-[11px] text-[var(--text-muted)] tabular-nums">
													Diff truncated for display.
												</p>
											)}
											{covering && covering.checkpointId != null ? (
												<p className="text-[11px] text-[var(--text-muted)] tabular-nums">
													Covered by checkpoint #{covering.checkpointId} (
													{covering.kind}).
												</p>
											) : covering && covering.checkpointId == null ? (
												<p className="text-[11px] font-medium text-[var(--warning)]">
													No recovery checkpoint covers {selectedPath} yet — it was
													never captured, so revert is unavailable.
												</p>
											) : null}
											{preview && (
												<div
													className="aero-inset sk-well space-y-1 p-2.5 text-[11px]"
													aria-label="Revert preview"
												>
													<p className="font-medium">
														{preview.strategy === "refused"
															? "Preview: revert refused"
															: preview.strategy === "authorization-required"
																? "Preview: revert needs confirmation"
																: preview.complete
																	? "Preview: complete revert"
																	: "Preview: partial revert"}
														{preview.strategy === "preview"
															? " (no changes made)"
															: ""}
													</p>
													{safetyInfo && (
														<div
															className={`space-y-1 ui-radius-control border p-2 ${safetyInfo.tone === "refused" ? "border-[var(--error)]/50" : "border-[var(--warning)]/50"}`}
															aria-label="Revert safety verdict"
														>
															<p
																className={`font-medium ${safetyInfo.tone === "refused" ? "text-[var(--error)]" : "text-[var(--warning)]"}`}
															>
																{safetyInfo.title}
															</p>
															<p className="text-[var(--text-secondary)]">
																{safetyInfo.explanation}
															</p>
															{safetyInfo.lines.length > 0 && (
																<ul className="list-disc pl-4 font-mono text-[var(--text-secondary)]">
																	{safetyInfo.lines
																		.slice(0, 12)
																		.map((line) => (
																			<li key={line}>{line}</li>
																		))}
																</ul>
															)}
															<p className="text-[var(--text-muted)]">
																{safetyInfo.footer}
															</p>
															<CheckboxField
																label="I authorize exactly this content change. This does not change the overwrite checkbox above."
																checked={riskyConfirmed}
																disabled={busy}
																onChange={(event) =>
																	setRiskyConfirmed(event.target.checked)
																}
																className="pt-1"
															/>
															{safetyInfo.needsForce && (
																<p className="text-[var(--text-secondary)]">
																	A refused revert additionally requires the
																	overwrite checkbox above — both
																	confirmations are needed.
																</p>
															)}
														</div>
													)}
												</div>
											)}
											{running && (
												<p className="text-[11px] text-[var(--text-muted)]">
													Stop the run to enable reverting.
												</p>
											)}
											{confirming && (
												<div
													className="space-y-2 ui-radius-control border border-[var(--error)]/40 p-2.5"
													role="alertdialog"
													aria-label="Confirm revert"
												>
													<p className="text-[11px] text-[var(--text-secondary)]">
														Revert {selectedPath} to checkpoint #
														{covering?.checkpointId}? The current version is saved
														as a pre-restore point first, but review the preview —
														revert overwrites the file.
													</p>
													<p className="text-[11px] text-[var(--text-muted)] tabular-nums">
														Overwrite conflicts: {force ? "on" : "off"} · Risky
														content authorized:{" "}
														{riskyConfirmed
															? "yes"
															: safetyInfo == null
																? "not needed"
																: "no"}
													</p>
													{safetyInfo && !confirmRiskyReady && (
														<p className="text-[11px] font-medium text-[var(--warning)]">
															Check the authorization box in the preview above
															first.
														</p>
													)}
													{safetyInfo?.needsForce && !force && (
														<p className="text-[11px] font-medium text-[var(--warning)]">
															This refused revert also needs the overwrite
															checkbox above.
														</p>
													)}
												</div>
											)}
										</div>
									</>
								)}
								<div
									style={embedded && (!recoveryExpanded || diff?.clean) ? { display: "none" } : undefined}
                                    className="aero-footer sk-window-footer flex shrink-0 flex-wrap items-center gap-2 py-1.5 px-3 ui-radius-control"
									role="group"
									aria-label="Revert controls"
								>
									<CheckboxField
										label="Overwrite files changed since the checkpoint (off = skip conflicts)"
										checked={force}
										disabled={busy}
										className="min-w-0 flex-1 [&>label]:items-center [&>label]:ui-radius-control [&>label]:px-3 [&>label]:py-2"
										onChange={(event) => {
											const next = event.target.checked;
											setForce(next);
											setPreview(null);
											setConfirming(false);
											setRiskyConfirmed(false);
											if (selectedPath != null && covering?.checkpointId != null)
												runPreviewWith(next);
										}}
									/>
									<button
										type="button"
										onClick={() => loadFiles(false)}
										disabled={busy}
										className="aero-control sk-button aero-fill sk-fill shrink-0 px-3 py-2 text-[11px] cursor-pointer"
									>
										Refresh
									</button>
									<button
										type="button"
										onClick={runPreview}
										disabled={busy || running || revertBlocked}
										className="aero-control sk-button aero-fill sk-fill shrink-0 px-3 py-2 text-[11px] font-medium cursor-pointer"
									>
										Preview revert
									</button>
									{!confirming ? (
										<button
											type="button"
											onClick={() => setConfirming(true)}
											disabled={revertBlocked || invalidSelection}
											className="aero-primary sk-button sk-primary aero-fill sk-fill shrink-0 px-3 py-2 text-[11px] font-semibold cursor-pointer"
										>
											Revert this file…
										</button>
									) : (
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => setConfirming(false)}
												disabled={busy}
												className="aero-control sk-button aero-fill sk-fill px-3 py-1.5 text-[11px] font-medium cursor-pointer"
											>
												Cancel
											</button>
											<button
												type="button"
												onClick={runRevert}
												disabled={confirmBlocked}
												className="aero-primary sk-button sk-primary aero-fill sk-fill px-3 py-1.5 text-[11px] font-semibold cursor-pointer"
											>
												{busy ? "Reverting…" : "Confirm revert"}
											</button>
										</div>
									)}
								</div>
							</section>
						</div>
					)}
				</div>
			</div>
		</Container>
	);
}

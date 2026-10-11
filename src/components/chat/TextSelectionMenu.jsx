import React, { useCallback, useEffect, useRef, useState } from "react";
import { FiCheck, FiCopy, FiMessageCircle } from "react-icons/fi";
import { clampMenuPosition, extractScopedSelectionText } from "../../lib/textSelection.mjs";

const MENU_WIDTH = 216;
const MENU_HEIGHT = 38;
const MENU_GAP = 10;

const itemClass =
	"flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs whitespace-nowrap text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";

// Floating Copy / Ask-question menu for transcript text selections. Mounted
// only inside the chat column and scoped to the transcript scroll container,
// so selections in the sidebar, composer, right panel, or settings never
// trigger it. Works for both Casual and Workspace transcripts because both
// render inside the same scroll container.
export default function TextSelectionMenu({ scopeRef, onAskQuestion }) {
	const [menu, setMenu] = useState(null); // { text, left, top, placement }
	const [copied, setCopied] = useState(false);
	const rafRef = useRef(0);
	const hideTimer = useRef(null);

	const hide = useCallback(() => {
		setMenu(null);
		setCopied(false);
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
	}, []);

	useEffect(() => {
		const scope = scopeRef?.current;
		if (!scope || typeof document === "undefined") return;
		const update = () => {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = requestAnimationFrame(() => {
				let selection = null;
				try {
					selection = window.getSelection?.() ?? null;
				} catch {
					selection = null;
				}
				const text = extractScopedSelectionText(scope, selection);
				if (!text) {
					setMenu(null);
					return;
				}
				let rect = null;
				try {
					if (selection?.rangeCount) rect = selection.getRangeAt(0).getBoundingClientRect();
				} catch {
					rect = null;
				}
				if (!rect || (rect.width === 0 && rect.height === 0)) {
					setMenu(null);
					return;
				}
				const pos = clampMenuPosition(rect, MENU_WIDTH, MENU_HEIGHT, MENU_GAP);
				setMenu((prev) =>
					prev?.text === text && prev?.left === pos.left && prev?.top === pos.top
						? prev
						: { text, ...pos },
				);
			});
		};
		const onScroll = (event) => {
			// The stored rect goes stale while the transcript scrolls.
			if (event.target === scope || scope.contains(event.target)) setMenu(null);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				setMenu(null);
				try {
					window.getSelection()?.removeAllRanges();
				} catch {
					/* Selection clearing is best-effort. */
				}
			}
		};
		document.addEventListener("selectionchange", update);
		scope.addEventListener("scroll", onScroll, true);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", hide);
		return () => {
			cancelAnimationFrame(rafRef.current);
			document.removeEventListener("selectionchange", update);
			scope.removeEventListener("scroll", onScroll, true);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", hide);
		};
	}, [scopeRef, hide]);

	const onCopy = async () => {
		if (!menu?.text) return;
		try {
			await navigator.clipboard.writeText(menu.text);
			setCopied(true);
			hideTimer.current = setTimeout(hide, 1100);
		} catch {
			setCopied(false);
		}
	};

	const onAsk = () => {
		if (!menu?.text) return;
		const text = menu.text;
		hide();
		try {
			window.getSelection()?.removeAllRanges();
		} catch {
			/* Selection clearing is best-effort. */
		}
		onAskQuestion?.(text);
	};

	if (!menu) return null;
	return (
		<div
			role="menu"
			aria-label="Text selection actions"
			// Keep the transcript selection intact while the menu is clicked.
			onMouseDown={(event) => event.preventDefault()}
			className="fixed z-[70] flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-1 shadow-[0_8px_30px_var(--window-shadow)]"
			style={{ left: menu.left, top: menu.top }}
		>
			<button
				type="button"
				role="menuitem"
				aria-label="Copy selected text"
				onClick={onCopy}
				className={itemClass}
			>
				{copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
				<span>{copied ? "Copied" : "Copy"}</span>
			</button>
			<button
				type="button"
				role="menuitem"
				aria-label="Ask the agent about the selected text"
				onClick={onAsk}
				className={itemClass}
			>
				<FiMessageCircle aria-hidden="true" />
				<span>Ask question</span>
			</button>
		</div>
	);
}

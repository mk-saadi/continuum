import React, { useEffect, useRef } from "react";
import { LuChevronDown, LuChevronUp, LuX } from "react-icons/lu";

const barButton =
	"flex size-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

// Browser-style in-chat find bar. Floating top-right of the chat column;
// all colors come from the active theme, no hard-coded values.
export default function ChatFindBar({
	query,
	onQueryChange,
	active,
	total,
	onPrev,
	onNext,
	onClose,
}) {
	const inputRef = useRef(null);
	useEffect(() => {
		const node = inputRef.current;
		if (!node) return;
		node.focus();
		node.select();
	}, []);

	return (
		<div
			role="search"
			aria-label="Find in chat"
			className="absolute top-2 right-4 z-[60] flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 shadow-[0_8px_30px_var(--window-shadow)]"
		>
			<input
				ref={inputRef}
				type="text"
				aria-label="Find in chat"
				placeholder="Find in chat"
				value={query}
				onChange={(event) => onQueryChange?.(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						if (event.shiftKey) onPrev?.();
						else onNext?.();
					} else if (event.key === "Escape") {
						event.preventDefault();
						onClose?.();
					}
				}}
				className="w-44 rounded-lg border border-[var(--control-border)] bg-[var(--input)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
			/>
			<span
				aria-live="polite"
				className="min-w-10 shrink-0 px-1 text-center text-[11px] tabular-nums text-[var(--text-muted)] select-none"
			>
				{query.trim() ? `${total === 0 ? 0 : active + 1}/${total}` : ""}
			</span>
			<button
				type="button"
				aria-label="Previous match (Shift+Enter)"
				disabled={total === 0}
				onClick={onPrev}
				className={barButton}
			>
				<LuChevronUp aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="Next match (Enter)"
				disabled={total === 0}
				onClick={onNext}
				className={barButton}
			>
				<LuChevronDown aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="Close find (Escape)"
				onClick={onClose}
				className={barButton}
			>
				<LuX aria-hidden="true" />
			</button>
		</div>
	);
}

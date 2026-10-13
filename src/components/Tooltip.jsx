import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolvePortalTarget, resolveTooltipPosition } from "../lib/tooltip.mjs";

function mergeRefs(...refs) {
	return (node) => {
		for (const ref of refs) {
			if (!ref) continue;
			if (typeof ref === "function") ref(node);
			else if (typeof ref === "object") ref.current = node;
		}
	};
}

// Custom theme-aware tooltip to use anywhere instead of the unstyled native
// `title` tooltip. Wrap a single element child; `content` shows on hover or
// keyboard focus. Colors come from the active theme (surface / text / border),
// so it adapts to light and dark themes automatically.
//
// <Tooltip content="Qwen3-8B" placement="top" delay={350}>
//   <strong>Workspace agent</strong>
// </Tooltip>
//
// Props:
// - content: string or node. Falsy renders the child untouched (no tooltip).
// - placement: "top" | "bottom" | "left" | "right" (default "top"). Flips to
//   the opposite side for top/bottom when there is no room.
// - delay: hover-intent delay in ms before showing (default 350). Focus uses
//   the same delay. 0 shows immediately.
// - offset: gap in px between trigger and tooltip (default 8).
// - disabled: never show.
export default function Tooltip({
	content,
	children,
	placement = "top",
	delay = 350,
	offset = 8,
	disabled = false,
}) {
	const tooltipId = useId();
	const triggerRef = useRef(null);
	const nodeRef = useRef(null);
	const timerRef = useRef(null);
	// Latest pointer position over the trigger. Used to anchor wide triggers
	// near the cursor; cleared on hide so keyboard focus falls back to center.
	const cursorRef = useRef(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState(null);

	const hide = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		cursorRef.current = null;
		setOpen(false);
		setPos(null);
	}, []);

	const show = useCallback(() => {
		if (!content || disabled) return;
		if (timerRef.current) clearTimeout(timerRef.current);
		if (delay <= 0) {
			setOpen(true);
		} else {
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				setOpen(true);
			}, delay);
		}
	}, [content, disabled, delay]);

	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		},
		[],
	);

	// Measure after mount so the position uses the real tooltip size.
	// The anchor is read here (not when hover starts) so the 350ms-delayed
	// open uses where the pointer actually is, not where it entered.
	useLayoutEffect(() => {
		if (!open) return;
		const node = nodeRef.current;
		const trigger = triggerRef.current;
		if (!node || !trigger || typeof window === "undefined") return;
		const rect = trigger.getBoundingClientRect();
		const size = { width: node.offsetWidth, height: node.offsetHeight };
		const viewport = { width: window.innerWidth, height: window.innerHeight };
		setPos(
			resolveTooltipPosition(rect, size, viewport, placement, offset, cursorRef.current?.x ?? null),
		);
	}, [open, placement, offset, content]);

	// Dismiss when the page moves or Escape is pressed. pointer-events-none
	// on the tooltip means it never needs a leave handler of its own.
	useEffect(() => {
		if (!open) return;
		const onScroll = () => hide();
		const onKeyDown = (event) => {
			if (event.key === "Escape") hide();
		};
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", hide);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", hide);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, hide]);

	let trigger = children;
	if (React.isValidElement(children)) {
		const childRef = children.ref ?? children.props.ref;
		const trackCursor = (event) => {
			if (typeof event?.clientX === "number" && Number.isFinite(event.clientX)) {
				cursorRef.current = { x: event.clientX, y: event.clientY };
			}
		};
		const { onMouseEnter, onMouseMove, onMouseLeave, onFocus, onBlur, onClick, ...rest } =
			children.props;
		trigger = React.cloneElement(children, {
			...rest,
			ref: mergeRefs(childRef, triggerRef),
			"aria-describedby": open ? tooltipId : rest["aria-describedby"],
			onMouseEnter: (event) => {
				onMouseEnter?.(event);
				trackCursor(event);
				show();
			},
			onMouseMove: (event) => {
				onMouseMove?.(event);
				trackCursor(event);
			},
			onMouseLeave: (event) => {
				onMouseLeave?.(event);
				hide();
			},
			onFocus: (event) => {
				onFocus?.(event);
				show();
			},
			onBlur: (event) => {
				onBlur?.(event);
				hide();
			},
			onClick: (event) => {
				onClick?.(event);
				hide();
			},
		});
	}

	return (
		<React.Fragment>
			{trigger}
			{open &&
				!!content &&
				createPortal(
					<div
						ref={nodeRef}
						id={tooltipId}
						role="tooltip"
						className="pointer-events-none fixed z-[9999] max-w-xs break-words rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-xs leading-snug text-[var(--text-primary)] shadow-xl transition-opacity motion-reduce:transition-none"
						style={{
							top: pos?.top ?? 0,
							left: pos?.left ?? 0,
							opacity: pos ? 1 : 0,
							visibility: pos ? "visible" : "hidden",
						}}
					>
						{content}
					</div>,
					// Inside a showModal() dialog, only a portal into that dialog
					// paints above it (top layer beats any body-level z-index).
					// The trigger node persists across renders, so its ref is
					// already attached when `open` flips true.
					resolvePortalTarget(triggerRef.current) ?? document.body,
				)}
		</React.Fragment>
	);
}

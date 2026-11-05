import React, { useEffect, useRef, useState } from "react";
import { useTabs } from "../context/TabContext.jsx";
import { getTabShortcut } from "../lib/tabShortcuts.mjs";
import { PiWarning } from "react-icons/pi";
import { LuX } from "react-icons/lu";
import { getTabTypeIcon } from "../lib/tabIcons.mjs";
import Tooltip from "./Tooltip.jsx";

export default function TabBar() {
	const { tabs, activeTabId, activateTab, closeTab, closeAllTabs, cycleTab, openTab, activeTab, moveTab } =
		useTabs();
	const tabButtons = useRef(new Map());
	// Drag-to-reorder (browser-style). The dragged tab id lives in a ref so
	// drop math always sees it; dragId/dropIndex state only drives visuals.
	// The + button is never draggable and never a drop slot past the end, so
	// tabs reorder among themselves and the + stays pinned last.
	const dragIdRef = useRef(null);
	const [dragId, setDragId] = useState(null);
	const [dropIndex, setDropIndex] = useState(null);
	// Insertion slot (0..tabs.length) for a pointer x: before the tab whose
	// midpoint the pointer passes, or the end slot (after the last tab, still
	// before the + button) for gutters and the + button itself.
	const indicatorForEvent = (event) => {
		const tabEl = event.target?.closest?.("[data-tab-index]");
		if (!tabEl) return tabs.length;
		const rect = tabEl.getBoundingClientRect();
		const index = Number(tabEl.dataset.tabIndex);
		return event.clientX < rect.left + rect.width / 2 ? index : index + 1;
	};
	const endDrag = () => {
		dragIdRef.current = null;
		setDragId(null);
		setDropIndex(null);
	};
	const focusShortcutTab = useRef(false);
	useEffect(() => {
		if (!focusShortcutTab.current) return;
		focusShortcutTab.current = false;
		tabButtons.current.get(activeTabId)?.focus();
	}, [activeTabId, tabs]);
	useEffect(() => {
		const handleKeyDown = (event) => {
			if (event.defaultPrevented) return;
			const shortcut = getTabShortcut(event);
			if (!shortcut) return;

			event.preventDefault();
			if (event.repeat) return;
			if ((shortcut === "previous" || shortcut === "next") && tabs.length < 2) return;
			focusShortcutTab.current = true;
			if (shortcut === "new") openTab(activeTab?.modelId || "");
			else if (shortcut === "close") closeTab(activeTabId);
			else if (shortcut === "close-all") closeAllTabs();
			else cycleTab(shortcut === "previous" ? -1 : 1);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [activeTab?.modelId, activeTabId, tabs.length, openTab, closeTab, closeAllTabs, cycleTab]);
	return (
		<nav
			aria-label="Chat tabs"
			className="aero-tabbar sk-toolbar sk-texture-brushed flex h-8 shrink-0 items-end gap-1 overflow-x-auto px-2"
			onDragOver={(event) => {
				if (dragIdRef.current == null) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				const next = indicatorForEvent(event);
				setDropIndex((prev) => (prev === next ? prev : next));
			}}
			onDrop={(event) => {
				event.preventDefault();
				const dragged = dragIdRef.current;
				const from = tabs.findIndex((tab) => tab.id === dragged);
				endDrag();
				if (from < 0) return;
				let to = indicatorForEvent(event);
				// Removing the dragged tab shifts later slots down by one.
				if (from < to) to -= 1;
				if (to !== from) moveTab(from, to);
			}}
			onDragEnd={endDrag}
			onDragLeave={(event) => {
				if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
				setDropIndex(null);
			}}
		>
			{tabs.map((tab, index) => (
				<React.Fragment key={tab.id}>
					{dropIndex === index && (
						<div
							aria-hidden="true"
							className="h-6 w-[2px] shrink-0 self-center ui-radius-round bg-[var(--accent)]"
						/>
					)}
				<div
					data-tab-id={tab.id}
					data-tab-index={index}
					data-active={tab.id === activeTabId}
					data-dragging={dragId === tab.id}
					draggable
					onDragStart={(event) => {
						dragIdRef.current = tab.id;
						setDragId(tab.id);
						event.dataTransfer.effectAllowed = "move";
						try {
							event.dataTransfer.setData("text/plain", tab.id);
						} catch {
							/* setData is required by some browsers; failures still drag. */
						}
					}}
					className="aero-tab sk-tab group flex max-w-48 min-w-32 cursor-grab items-center gap-2 px-2 py-1 text-xs select-none active:cursor-grabbing"
					onAuxClick={(event) => {
						if (event.button === 1) {
							event.preventDefault();
							closeTab(tab.id);
						}
					}}
				>
					<Tooltip
						content={tab.title}
						placement="bottom"
					>
						<button
							type="button"
							ref={(element) => {
								if (element) tabButtons.current.set(tab.id, element);
								else tabButtons.current.delete(tab.id);
							}}
							onClick={() => activateTab(tab.id)}
							aria-current={tab.id === activeTabId ? "page" : undefined}
							className="aero-tab-label flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
						>
							{(() => {
								if (tab.status === "awaiting_approval") {
									return (
										<PiWarning
											className="size-3 shrink-0 text-red-500 animate-pulse"
											aria-label="Needs attention"
											title="Needs attention"
										/>
									);
								}
								const tabType = getTabTypeIcon(tab);
								const { Icon, label } = tabType;
								const isGenerating = tab.status === "generating";
								return (
									<Icon
										className={`size-3 shrink-0 ${isGenerating ? "animate-pulse [filter:drop-shadow(0_0_4px_var(--accent))]" : ""}`}
										aria-label={label}
										title={label}
									/>
								);
							})()}
							<span className="truncate">{tab.title}</span>
						</button>
					</Tooltip>
					<button
						type="button"
						onClick={() => closeTab(tab.id)}
						aria-label={`Close ${tab.title}`}
						className="aero-chrome-button sk-icon-button p-1 cursor-pointer"
					>
						<LuX />
					</button>
				</div>
				</React.Fragment>
			))}
			{dropIndex === tabs.length && tabs.length > 0 && (
				<div
					aria-hidden="true"
					className="h-6 w-[2px] shrink-0 self-center ui-radius-round bg-[var(--accent)]"
				/>
			)}
			<button
				type="button"
				onClick={() => openTab(activeTab?.modelId || "")}
				aria-label="New chat tab"
				title="New chat tab"
				className="aero-orb sk-icon-button aero-fill sk-fill mb-0.5 size-7 shrink-0 cursor-pointer"
			>
				✦
			</button>
		</nav>
	);
}

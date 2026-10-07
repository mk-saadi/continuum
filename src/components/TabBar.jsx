import React, { useEffect, useRef } from "react";
import { useTabs } from "../context/TabContext.jsx";
import { getTabShortcut } from "../lib/tabShortcuts.mjs";
import { PiWarning } from "react-icons/pi";
import { LuPlus, LuX } from "react-icons/lu";

export default function TabBar() {
	const { tabs, activeTabId, activateTab, closeTab, closeAllTabs, cycleTab, openTab, activeTab } =
		useTabs();
	const tabButtons = useRef(new Map());
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
			className="flex h-8 shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-raised)] px-2"
		>
			{tabs.map((tab) => (
				<div
					key={tab.id}
					className={`group flex max-w-48 min-w-32 items-center gap-2 rounded-t-lg border border-b-0 px-2 py-1 text-xs duration-300 ${tab.id === activeTabId ? "border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]" : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"}`}
					onAuxClick={(event) => {
						if (event.button === 1) {
							event.preventDefault();
							closeTab(tab.id);
						}
					}}
				>
					<button
						type="button"
						ref={(element) => {
							if (element) tabButtons.current.set(tab.id, element);
							else tabButtons.current.delete(tab.id);
						}}
						onClick={() => activateTab(tab.id)}
						aria-current={tab.id === activeTabId ? "page" : undefined}
						className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
						title={tab.title}
					>
						<span
							aria-hidden="true"
							className={`size-2 shrink-0 rounded-full ${tab.status === "awaiting_approval" ? "bg-amber-500" : tab.status === "generating" ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--text-muted)]"}`}
						/>
						<span className="truncate">{tab.title}</span>
						{tab.status === "awaiting_approval" && (
							<span
								aria-label="Needs attention"
								title="Needs attention"
							>
								<PiWarning />
							</span>
						)}
					</button>
					<button
						type="button"
						onClick={() => closeTab(tab.id)}
						aria-label={`Close ${tab.title}`}
						className="rounded p-1 hover:bg-[var(--surface-hover)] cursor-pointer duration-300"
					>
						<LuX />
					</button>
				</div>
			))}
			<button
				type="button"
				onClick={() => openTab(activeTab?.modelId || "")}
				aria-label="New chat tab"
				title="New chat tab"
				className="rounded p-1 px-2 duration-300 cursor-pointer hover:bg-[var(--accent)]/60"
			>
				✦
			</button>
		</nav>
	);
}

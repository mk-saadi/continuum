import { applyTheme } from "../lib/themes.mjs";
import React, { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createSidebarStore } from "../lib/sidebarState.mjs";

// UI chrome state — conversation sidebar visibility, theme and modal visibility —
// lives here instead of inside AppContent. When it changes, only the components
// that actually render that chrome re-render: AppContent, the tab list, and
// every mounted chat transcript stay untouched.
//
// Each concern gets its own context so a change to one (say, the right sidebar)
// cannot invalidate consumers of another (the theme picker). Modal *actions*
// are split from modal *state* too: the action object never changes identity,
// so components that only need to open a modal (the header, the sidebar) can
// consume it without re-rendering when a modal opens.
const LeftSidebarContext = createContext(null);
const RightSidebarContext = createContext(null);
const SidebarStoreContext = createContext(null);

export function ChatSidebarProvider({ sessionId, children }) {
	const store = useContext(SidebarStoreContext);
	return store && sessionId
		? <ScopedSidebars entry={store.forSession(sessionId)}>{children}</ScopedSidebars>
		: children;
}

function ScopedSidebars({ entry, children }) {
	const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
	const left = useMemo(() => ({ open: state.left, setOpen: value => entry.setOpen("left", value), toggle: () => entry.setOpen("left", value => !value) }), [entry, state.left]);
	const right = useMemo(() => ({ open: state.right, setOpen: value => entry.setOpen("right", value), toggle: () => entry.setOpen("right", value => !value) }), [entry, state.right]);
	return <LeftSidebarContext.Provider value={left}><RightSidebarContext.Provider value={right}>{children}</RightSidebarContext.Provider></LeftSidebarContext.Provider>;
}
const ThemeContext = createContext(null);
const ModalActionsContext = createContext(null);
const ModalStateContext = createContext(null);

function readBool(key) {
	try {
		return localStorage.getItem(key) === "true";
	} catch {
		return false; // Storage can be unavailable (disabled, private mode).
	}
}

function readTheme() {
	try {
		return localStorage.getItem("theme") || "dark";
	} catch {
		return "dark";
	}
}

export function UIStateProvider({ children }) {
	const [sidebarStore] = useState(() => {
		let storage;
		try { storage = window.localStorage; } catch { /* Storage is optional. */ }
		return createSidebarStore(storage);
	});
	const [leftOpen, setLeftOpen] = useState(() => readBool("sidebarOpen"));
	const [rightOpen, setRightOpen] = useState(() => readBool("rightSidebarOpen"));
	const [theme, setTheme] = useState(readTheme);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsTab, setSettingsTab] = useState("appearance");
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [projectModalOpen, setProjectModalOpen] = useState(false);

	useEffect(() => {
		try {
			localStorage.setItem("sidebarOpen", String(leftOpen));
		} catch {
			/* Persistence is best-effort; the app stays usable without it. */
		}
	}, [leftOpen]);
	useEffect(() => {
		try {
			localStorage.setItem("rightSidebarOpen", String(rightOpen));
		} catch {
			/* Best effort. */
		}
	}, [rightOpen]);
	useEffect(() => {
		applyTheme(document.documentElement, theme);
		try {
			localStorage.setItem("theme", theme);
		} catch {
			/* Best effort. */
		}
	}, [theme]);

	const left = useMemo(
		() => ({
			open: leftOpen,
			setOpen: setLeftOpen,
			toggle: () => setLeftOpen((value) => !value),
		}),
		[leftOpen],
	);
	const right = useMemo(
		() => ({
			open: rightOpen,
			setOpen: setRightOpen,
			toggle: () => setRightOpen((value) => !value),
		}),
		[rightOpen],
	);
	const themeValue = useMemo(() => ({ theme, setTheme }), [theme]);
	// State setters are stable for the provider's lifetime, so this object is
	// built once and never changes identity.
	const modalActions = useMemo(
		() => ({
			openSettings: (tab) => {
				setSettingsTab(typeof tab === "string" ? tab : "appearance");
				setSettingsOpen(true);
			},
			closeSettings: () => setSettingsOpen(false),
			openModelSelector: () => setModelSelectorOpen(true),
			closeModelSelector: () => setModelSelectorOpen(false),
			openProjectModal: () => setProjectModalOpen(true),
			closeProjectModal: () => setProjectModalOpen(false),
		}),
		[],
	);
	const modalState = useMemo(
		() => ({ settingsOpen, settingsTab, modelSelectorOpen, projectModalOpen }),
		[settingsOpen, settingsTab, modelSelectorOpen, projectModalOpen],
	);

	return (
		<ModalActionsContext.Provider value={modalActions}>
			<ModalStateContext.Provider value={modalState}>
				<ThemeContext.Provider value={themeValue}>
					<LeftSidebarContext.Provider value={left}>
						<RightSidebarContext.Provider value={right}><SidebarStoreContext.Provider value={sidebarStore}>{children}</SidebarStoreContext.Provider></RightSidebarContext.Provider>
					</LeftSidebarContext.Provider>
				</ThemeContext.Provider>
			</ModalStateContext.Provider>
		</ModalActionsContext.Provider>
	);
}

// Hooks return null without a provider so prop-driven fixtures and isolated
// tests of the individual components keep working unchanged.
export function useLeftSidebar() {
	return useContext(LeftSidebarContext);
}

export function useRightSidebar() {
	return useContext(RightSidebarContext);
}

export function useTheme() {
	return useContext(ThemeContext);
}

export function useModalActions() {
	return useContext(ModalActionsContext);
}

export function useModalState() {
	return useContext(ModalStateContext);
}

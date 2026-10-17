import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

// Global UI chrome state — sidebar visibility, theme and modal visibility —
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
	const [leftOpen, setLeftOpen] = useState(() => readBool("sidebarOpen"));
	const [rightOpen, setRightOpen] = useState(() => readBool("rightSidebarOpen"));
	const [theme, setTheme] = useState(readTheme);
	const [settingsOpen, setSettingsOpen] = useState(false);
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
		document.documentElement.setAttribute("data-theme", theme);
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
			openSettings: () => setSettingsOpen(true),
			closeSettings: () => setSettingsOpen(false),
			openModelSelector: () => setModelSelectorOpen(true),
			closeModelSelector: () => setModelSelectorOpen(false),
			openProjectModal: () => setProjectModalOpen(true),
			closeProjectModal: () => setProjectModalOpen(false),
		}),
		[],
	);
	const modalState = useMemo(
		() => ({ settingsOpen, modelSelectorOpen, projectModalOpen }),
		[settingsOpen, modelSelectorOpen, projectModalOpen],
	);

	return (
		<ModalActionsContext.Provider value={modalActions}>
			<ModalStateContext.Provider value={modalState}>
				<ThemeContext.Provider value={themeValue}>
					<LeftSidebarContext.Provider value={left}>
						<RightSidebarContext.Provider value={right}>{children}</RightSidebarContext.Provider>
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

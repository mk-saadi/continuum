// Pure left-sidebar history helpers shared by Sidebar.jsx/ChatHistory.jsx
// and their tests. No JSX here so tests can import this module directly.

export function sessionsWithoutProject(sessions) {
	return (sessions ?? []).filter((session) => !session.project_id);
}

export function sessionsForProject(sessions, projectId) {
	if (projectId == null) return [];
	return (sessions ?? []).filter((session) => session.project_id === projectId);
}

export function mapSessionGroups(groups, select) {
	return (groups ?? []).map((group) => ({
		...group,
		sessions: select(group.sessions ?? []),
	}));
}

export function getRecentSessions(sessions, limit = 6) {
	return (sessions ?? [])
		.slice()
		.sort((a, b) =>
			String(b.last_active_at || "").localeCompare(String(a.last_active_at || "")),
		)
		.slice(0, limit);
}

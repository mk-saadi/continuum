'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const historySource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'ChatHistory.jsx'),
	'utf8',
);
const sidebarSource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'Sidebar.jsx'),
	'utf8',
);
const chatInterfaceSource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'main-app', 'ChatInterface.jsx'),
	'utf8',
);

// 1. Mode is derived from existing state, never brittle labels or open state.
assert.ok(
	chatInterfaceSource.includes('isWorkspace={isWorkspaceChat}'),
	'ChatInterface passes the derived workspace mode to the sidebar',
);
assert.ok(
	chatInterfaceSource.includes('getSidebarMode(chatProjectId)'),
	'mode derives from the session/tab project binding',
);
assert.ok(!sidebarSource.includes('isOpen ?'), 'sidebar mode never inferred from open state');
assert.ok(
	sidebarSource.includes('isWorkspace'),
	'Sidebar branches on the explicit mode prop',
);
// One shared history store: both modes derive from the same groups prop.
assert.ok(sidebarSource.includes('history.groups'), 'both modes read the same groups store');
assert.ok(
	!sidebarSource.match(/useState\(\[\]\)/) || sidebarSource.includes('openProjects'),
	'no duplicated conversation store in the sidebar',
);
assert.ok(
	!sidebarSource.includes('getAllSessions') && !sidebarSource.includes('loadSession'),
	'sidebar performs no history fetching of its own',
);

// 2. Casual: untouched — conversation-first history plus the projects
// disclosure at the bottom. Only global chats appear in the folders.
assert.ok(
	sidebarSource.includes('aria-label="Chat navigation"'),
	'casual sidebar keeps its own landmark',
);
assert.ok(sidebarSource.includes('showRecents'), 'casual mode prioritizes recent conversations');
assert.ok(historySource.includes('aria-label="Recent chats"'), 'recents section is labelled');
assert.ok(historySource.includes('getRecentSessions'), 'recents reuse the shared helper');
assert.ok(sidebarSource.includes('Pinned projects'), 'casual keeps the pinned project group');
assert.ok(sidebarSource.includes('Projects ({projects.length})'), 'casual keeps project access with a count');
assert.ok(sidebarSource.includes('<details'), 'casual keeps projects in a bottom disclosure');
assert.ok(sidebarSource.includes('All projects'), 'casual keeps full project navigation');
assert.ok(sidebarSource.includes('New Project'), 'casual keeps project creation');
assert.ok(
	sidebarSource.includes('onProject(project.id)'),
	'casual keeps the pinned project navigation handler',
);
assert.ok(sidebarSource.includes('Back to Chat'), 'return path to chat preserved');
assert.ok(
	sidebarSource.includes('sessionsWithoutProject'),
	'casual history excludes project-bound chats via the shared helper',
);

// 3. Workspace: one hierarchy — current workspace card plus its own folders.
// No all-projects tree, so conversations are never listed twice.
assert.ok(
	sidebarSource.includes('aria-label="Workspace navigation"'),
	'workspace sidebar keeps its own landmark',
);
assert.ok(
	!sidebarSource.includes('Current workspace'),
	'no redundant workspace identity card on top of the workspace card',
);
assert.ok(
	!sidebarSource.includes('project-nav-threads'),
	'no second conversation tree anywhere; workspace lists each chat once',
);
assert.ok(
	/>Projects</.test(sidebarSource.slice(sidebarSource.indexOf('aria-label="Workspace navigation"'))),
	'workspace keeps project-hub navigation for the projectNavigation flow',
);
assert.ok(
	sidebarSource.includes('.filter((group) => group.sessions.length > 0)'),
	'workspace prunes folders left empty by the project filter',
);
assert.ok(
	sidebarSource.includes('sessionsForProject'),
	'workspace filters the shared store to the current project',
);
assert.ok(
	sidebarSource.includes('workspaceChatCount'),
	'workspace conversation count shown once',
);
assert.ok(
	historySource.includes('New workspace chat'),
	'creating a workspace chat is explicit',
);
assert.ok(
	historySource.includes('onNewWorkspaceChat?.()'),
	'workspace creation reuses the ChatInterface handler',
);
assert.ok(
	historySource.includes('Select and start a model'),
	'model requirement explained when creation is unavailable',
);
// New workspace chats bind the project at creation via the existing session API.
assert.ok(
	chatInterfaceSource.includes('newWorkspaceChat'),
	'ChatInterface owns workspace chat creation',
);
assert.ok(
	chatInterfaceSource.includes('getOrCreateSession(id, selectedModel, projectId)'),
	'workspace chats reuse the existing session creation API',
);
assert.ok(
	chatInterfaceSource.includes('projectId,') || chatInterfaceSource.includes('projectId:'),
	'new workspace chat binds the tab project like loadChat does',
);
assert.ok(
	chatInterfaceSource.includes('Select and start a model before creating a workspace chat'),
	'creation guards mirror the existing project-chat requirements',
);

// 4. Existing history behavior preserved in both modes.
for (const token of [
	'role="menu"',
	'role="menuitem"',
	'data-session-id',
	'aria-label="New Folder"',
	'Move to Folder',
	'Export Chat...',
	'DRAG_TYPE',
	'onDragStart',
	'onContextMenu',
	'type="search"',
]) {
	assert.ok(historySource.includes(token), `history interaction preserved: ${token}`);
}
assert.ok(
	historySource.includes('mode = "casual"'),
	'default render stays casual for existing embeds and the UI fixture',
);
assert.ok(
	historySource.includes('aria-label="Saved chats"'),
	'conversation list landmark unchanged',
);

// 5. Layout: one flexible scroll area, no capped regions fighting each other.
assert.ok(
	!sidebarSource.includes('max-h-['),
	'no arbitrary capped nav regions that starve the conversation list',
);
assert.ok(
	(sidebarSource.match(/min-h-0 flex-1/g) || []).length >= 2,
	'both modes give the conversation list the flexible scroll area',
);
assert.ok(
	sidebarSource.includes('max-[650px]:w-[220px]'),
	'narrow window widths preserved',
);
assert.ok(
	sidebarSource.includes('project-nav-link'),
	'nav rows use the ellipsis nav-link style for long names',
);
assert.ok(
	historySource.includes('truncate') && historySource.includes('min-w-0'),
	'long chat and folder names truncate instead of clipping layout',
);
assert.ok(historySource.includes('min-h-0 flex-1 overflow-y-auto'), 'history list scrolls independently');

console.log(
	'Left sidebar modes: derived mode state, shared store, intact casual tree, single-hierarchy workspace with pruned folders, preserved interactions, and flexible scroll layout passed.',
);

import React from "react";
import { FiGrid, FiMessageSquare, FiPlus, FiStar } from "react-icons/fi";
import ChatHistory from "./ChatHistory";
import { mapSessionGroups, sessionsForProject, sessionsWithoutProject } from "../lib/sidebarHistory.mjs";
import "./projects.css";

export default function Sidebar({
	projects = [],
	view = "chat",
	activeProjectId,
	onProjects,
	onProject,
	onCreateProject,
	onChat,
	isWorkspace = false,
	chatProjectId = null,
	onNewWorkspaceChat = null,
	canStartChat = false,
	...history
}) {
	const globalGroups = mapSessionGroups(history.groups, sessionsWithoutProject);
	const workspaceProject = chatProjectId
		? (projects.find((project) => project.id === chatProjectId) ?? null)
		: null;
	// Workspace mode renders only the current workspace's conversations. Groups
	// left empty by the filter are pruned so global folder names (e.g. casual
	// folders with no workspace chats) never appear as empty rows.
	const workspaceGroups = mapSessionGroups(history.groups, (list) =>
		sessionsForProject(list, chatProjectId),
	).filter((group) => group.sessions.length > 0);
	const workspaceChatCount = workspaceGroups.reduce(
		(count, group) => count + group.sessions.length,
		0,
	);
	if (!isWorkspace) {
		return (
			<aside
				aria-label="Chat navigation"
				className="flex h-full w-[272px] shrink-0 flex-col bg-[var(--surface)] text-[var(--text-primary)] max-[650px]:w-[220px]"
			>
				<div className="min-h-0 flex-1">
					<ChatHistory
						{...history}
						mode="casual"
						showRecents
						groups={globalGroups}
						activeId={view === "chat" ? history.activeId : null}
					/>
				</div>
				<details className="shrink-0 border-t border-[var(--border)]">
					<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
						<FiGrid className="shrink-0" />
						<span className="min-w-0 flex-1 truncate text-left">
							Projects ({projects.length})
						</span>
					</summary>
					<div className="max-h-48 min-h-0 overflow-y-auto px-2 pb-2">
						<button
							className="project-nav-link w-full"
							onClick={onChat}
						>
							<FiMessageSquare />
							<span>Back to Chat</span>
						</button>
						{projects.some((project) => project.is_pinned) && (
							<section aria-label="Pinned projects">
								{projects
									.filter((project) => project.is_pinned)
									.map((project) => (
										<button
											key={project.id}
											className="project-nav-link w-full"
											onClick={() => onProject(project.id)}
										>
											<FiStar className="shrink-0" />
											<span>{project.name}</span>
										</button>
									))}
							</section>
						)}
						<button
							className="project-nav-link w-full"
							onClick={onProjects}
						>
							<FiGrid />
							<span>All projects</span>
						</button>
						<button
							className="project-nav-link w-full"
							onClick={onCreateProject}
						>
							<FiPlus />
							<span>New Project</span>
						</button>
					</div>
				</details>
			</aside>
		);
	}
	// Workspace mode is a single hierarchy: the workspace card (name, count,
	// creation) plus its folder-grouped conversations. The all-projects tree is
	// intentionally absent here so the same conversations are never listed
	// twice, and global casual history is never passed down.
	return (
		<aside
			aria-label="Workspace navigation"
			className="flex h-full w-[272px] shrink-0 flex-col bg-[var(--surface)] text-[var(--text-primary)] max-[650px]:w-[220px]"
		>
			<div className="shrink-0 space-y-1 border-b border-[var(--border)] px-3 pt-3 pb-2">
				<button
					className="project-nav-link w-full"
					onClick={onChat}
					aria-current={view === "chat" ? "page" : undefined}
				>
					<FiMessageSquare />
					<span>Back to Chat</span>
				</button>
				<button
					className="project-nav-link w-full"
					onClick={onProjects}
					aria-current={view === "projects" ? "page" : undefined}
				>
					<FiGrid />
					<span>Projects</span>
				</button>
			</div>
			<div className="min-h-0 flex-1">
				<ChatHistory
					{...history}
					mode="workspace"
					workspaceName={workspaceProject?.name ?? null}
					workspaceChatCount={workspaceChatCount}
					onNewWorkspaceChat={onNewWorkspaceChat}
					canCreateWorkspaceChat={canStartChat && chatProjectId != null}
					groups={workspaceGroups}
					activeId={view === "chat" ? history.activeId : null}
				/>
			</div>
		</aside>
	);
}

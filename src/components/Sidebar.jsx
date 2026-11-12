import React, { useState, useEffect } from "react";
import { WorkspaceFiles } from "./WorkspaceFiles.jsx";
import { FiCalendar, FiFolder, FiGrid, FiMessageSquare, FiPlus, FiStar } from "react-icons/fi";
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
	onTasks = null,
	tasksActive = false,
	isWorkspace = false,
	chatProjectId = null,
	onNewWorkspaceChat = null,
	canStartChat = false,
	selectedFilePath = null,
	onSelectFile = null,
	explorerActive = true,
	...history
}) {
	const [section, setSection] = useState("chats");
	useEffect(() => setSection("chats"), [chatProjectId]);
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
	const workspaceChatCount = workspaceGroups.reduce((count, group) => count + group.sessions.length, 0);
	if (!isWorkspace) {
		return (
			<aside
				aria-label="Chat navigation"
				className="flex h-full w-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]"
			>
				<div className="min-h-0 flex-1">
					<ChatHistory
						{...history}
						embedded
						mode="casual"
						showRecents
						onTasks={onTasks}
						tasksActive={tasksActive}
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
							className="aero-list-item sk-list-row project-nav-link w-full cursor-pointer"
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
											className="aero-list-item sk-list-row project-nav-link w-full"
											onClick={() => onProject(project.id)}
										>
											<FiStar className="shrink-0" />
											<span>{project.name}</span>
										</button>
									))}
							</section>
						)}
						<button
							className="aero-list-item sk-list-row project-nav-link w-full"
							onClick={onProjects}
						>
							<FiGrid />
							<span>All projects</span>
						</button>
						<button
							className="aero-list-item sk-list-row project-nav-link w-full"
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
			className="flex h-full w-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]"
		>
			<div className="flex shrink-0 gap-1 border-b border-[var(--border)] p-2" aria-label="Workspace sidebar views">
                {[['chats', 'Chats', FiMessageSquare], ['files', 'Files', FiFolder]].map(([id, label, Icon]) =>
                    <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}
                        className={`flex flex-1 cursor-pointer items-center justify-center gap-2 ui-radius-control px-3 py-2 text-xs ${section === id ? 'bg-[var(--surface-hover)] text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}><Icon />{label}</button>)}
            </div>
            {section === "files" ? <div className="min-h-0 flex-1"><WorkspaceFiles active={explorerActive} projectId={chatProjectId} projectName={workspaceProject?.name} selectedPath={selectedFilePath} onSelect={onSelectFile} /></div> : <>
			<div className="shrink-0 space-y-1 border-b border-[var(--border)] px-3 pt-3 pb-2">
				<button
					className="aero-list-item sk-list-row project-nav-link w-full cursor-pointer ui-radius-control"
					onClick={onChat}
					aria-current={view === "chat" ? "page" : undefined}
				>
					<FiMessageSquare />
					<span>Back to Chat</span>
				</button>
				{onTasks && (
					<button
						className="aero-list-item sk-list-row project-nav-link w-full cursor-pointer ui-radius-control"
						onClick={onTasks}
						aria-current={tasksActive ? "page" : undefined}
					>
						<FiCalendar />
						<span>Tasks</span>
					</button>
				)}
				<button
					className="aero-list-item sk-list-row project-nav-link w-full cursor-pointer ui-radius-control"
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
					embedded
					mode="workspace"
					workspaceName={workspaceProject?.name ?? null}
					workspaceChatCount={workspaceChatCount}
					onNewWorkspaceChat={onNewWorkspaceChat}
					canCreateWorkspaceChat={canStartChat && chatProjectId != null}
					groups={workspaceGroups}
					activeId={view === "chat" ? history.activeId : null}
				/>
			</div>
            </>}
		</aside>
	);
}

import React, { useState } from "react";
import {
	FiChevronDown,
	FiChevronRight,
	FiFolder,
	FiGrid,
	FiMessageSquare,
	FiPlus,
	FiStar,
} from "react-icons/fi";
import ChatHistory from "./ChatHistory";
import "./projects.css";

export default function Sidebar({
	projects = [],
	view = "chat",
	activeProjectId,
	onProjects,
	onProject,
	onCreateProject,
	onChat,
	...history
}) {
	const [expanded, setExpanded] = useState(true);
	const [openProjects, setOpenProjects] = useState(new Set());
	const sessions = history.groups.flatMap((group) => group.sessions);
	const globalGroups = history.groups.map((group) => ({
		...group,
		sessions: group.sessions.filter((session) => !session.project_id),
	}));
	const pinned = projects.filter((project) => project.is_pinned);
	return (
		<aside
			aria-label="Workspace navigation"
			className="flex h-full w-[272px] shrink-0 flex-col bg-[var(--surface)] text-[var(--text-primary)] max-[650px]:w-[220px]"
		>
			<nav
				className="project-nav"
				aria-label="Projects"
			>
				<button
					className="project-nav-link w-full mb-2"
					onClick={onChat}
					aria-current={view === "chat" ? "page" : undefined}
				>
					<FiMessageSquare />
					<span>Back to Chat</span>
				</button>
				<div className="project-nav-row">
					<button
						aria-label={expanded ? "Collapse projects" : "Expand projects"}
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
						className="px-2"
					>
						{expanded ? <FiChevronDown /> : <FiChevronRight />}
					</button>
					<button
						className="project-nav-link"
						onClick={onProjects}
						aria-current={view === "projects" ? "page" : undefined}
					>
						<FiGrid />
						<span>Projects</span>
					</button>
					<button
						className="px-2"
						onClick={onCreateProject}
						aria-label="New project"
					>
						<FiPlus />
					</button>
				</div>
				{expanded && (
					<>
						{pinned.length > 0 && (
							<section aria-label="Pinned Projects">
								<h2 className="projects-muted px-2 pt-4 pb-1">Pinned Projects</h2>
								{pinned.map((project) => (
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
						<section
							aria-label="All projects"
							className="mt-2"
						>
							{projects.map((project) => {
								const open = openProjects.has(project.id);
								const chats = sessions.filter((session) => session.project_id === project.id);
								return (
									<div key={project.id}>
										<div className="project-nav-row">
											<button
												className="px-2"
												aria-label={`${open ? "Collapse" : "Expand"} ${project.name} chats`}
												aria-expanded={open}
												onClick={() =>
													setOpenProjects((previous) => {
														const next = new Set(previous);
														if (next.has(project.id)) next.delete(project.id);
														else next.add(project.id);
														return next;
													})
												}
											>
												{open ? <FiChevronDown /> : <FiChevronRight />}
											</button>
											<button
												className="project-nav-link"
												onClick={() => onProject(project.id)}
												aria-current={
													view === "project" && activeProjectId === project.id
														? "page"
														: undefined
												}
											>
												<FiFolder className="shrink-0" />
												<span>{project.name}</span>
												<small className="ml-auto projects-muted">
													{chats.length}
												</small>
											</button>
										</div>
										{open && (
											<div className="project-nav-threads">
												{chats.length ? (
													chats.map((chat) => (
														<button
															key={chat.id}
															title={chat.title || "Untitled chat"}
															disabled={history.disabled}
															aria-current={
																view === "chat" &&
																history.activeId === chat.id
																	? "page"
																	: undefined
															}
															onClick={() => history.onLoad(chat.id)}
														>
															{chat.title || "Untitled chat"}
														</button>
													))
												) : (
													<p className="projects-muted p-2">No chats yet</p>
												)}
											</div>
										)}
									</div>
								);
							})}
						</section>
						<button
							className="project-nav-link w-full mt-2"
							onClick={onCreateProject}
						>
							<FiPlus />
							<span>New Project</span>
						</button>
					</>
				)}
			</nav>
			<div className="min-h-0 flex-1">
				<ChatHistory
					{...history}
					groups={globalGroups}
					activeId={view === "chat" ? history.activeId : null}
				/>
			</div>
		</aside>
	);
}

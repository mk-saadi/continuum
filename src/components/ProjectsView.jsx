import React, { useState } from "react";
import { FiFolder, FiPlus, FiStar } from "react-icons/fi";
import { TextField } from "./FormControls";
import "./projects.css";

export function projectDate(value) {
	if (!value) return "";
	const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ProjectsView({ projects, loading, error, onRetry, onCreate, onOpen, onPin }) {
	const [query, setQuery] = useState("");
	const [pinnedOnly, setPinnedOnly] = useState(false);
	const [pinning, setPinning] = useState(null);
	const [actionError, setActionError] = useState("");
	const filtered = projects.filter(
		(project) =>
			(!pinnedOnly || project.is_pinned) &&
			[project.name, project.description, project.root_path].some((value) =>
				value?.toLowerCase().includes(query.toLowerCase().trim()),
			),
	);
	async function pin(project) {
		setPinning(project.id);
		setActionError("");
		try {
			await onPin(project);
		} catch (err) {
			setActionError(err.message);
		} finally {
			setPinning(null);
		}
	}
	return (
		<main
			className="aero-stage projects-page"
			aria-label="Projects dashboard"
		>
			<div className="projects-content">
				<header className="projects-heading">
					<div className="flex min-w-0 items-center gap-3">
						<span className="project-heading-icon">
							<FiFolder
								size={18}
								aria-hidden="true"
							/>
						</span>
						<div>
							<h1>Projects</h1>
							<p className="projects-muted">
								A home for your goals, context, and conversations.
							</p>
						</div>
					</div>
					<button
						className="aero-primary inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-xs leading-normal font-semibold"
						onClick={onCreate}
					>
						<FiPlus /> Create New Project
					</button>
				</header>
				<div className="projects-toolbar">
					<TextField
						className="flex-1"
						frameClassName="aero-well flex min-h-8 items-center text-[var(--text-primary)]"
						type="search"
						aria-label="Search projects"
						placeholder="Search projects by name, goal, or folder…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<button
						className="aero-control inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
						aria-pressed={pinnedOnly}
						onClick={() => setPinnedOnly(!pinnedOnly)}
					>
						<FiStar /> Pinned
					</button>
				</div>
				{(error || actionError) && (
					<p
						role="alert"
						className="project-error"
					>
						{error || actionError}{" "}
						{error && (
							<button
								className="aero-control inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
								onClick={onRetry}
							>
								Retry
							</button>
						)}
					</p>
				)}
				{loading ? (
					<p role="status">Loading projects…</p>
				) : !filtered.length ? (
					<div className="aero-empty project-empty">
						<FiFolder className="mx-auto mb-4 size-8" />
						<p>
							{projects.length
								? "No projects match your filters."
								: "Your next idea starts here."}
						</p>
						<p className="mt-2 text-sm">
							{projects.length
								? "Try a different search or show all projects."
								: "Create a project to keep instructions, files, and chats together."}
						</p>
					</div>
				) : (
					<div className="projects-grid">
						{filtered.map((project) => (
							<article
								className="aero-panel aero-panel--interactive project-card"
								key={project.id}
							>
								<button
									className="project-card-link"
									onClick={() => onOpen(project.id)}
								>
									<FiFolder className="size-4 text-[var(--accent)]" />
									<h2>{project.name}</h2>
									<p className="project-card-goal">
										{project.description || "Add a goal to give this project direction."}
									</p>
									<div className="mt-auto w-full min-w-0">
										<span
											className="project-path"
											title={project.root_path || undefined}
										>
											{project.root_path || "No folder connected"}
										</span>
										<p className="projects-muted mt-3">
											Created {projectDate(project.created_at)}
										</p>
									</div>
								</button>
								<button
									className="aero-orb aero-fill project-pin cursor-pointer text-[11px] font-medium"
									aria-label={`${project.is_pinned ? "Unpin" : "Pin"} ${project.name}`}
									aria-pressed={!!project.is_pinned}
									disabled={pinning !== null}
									onClick={() => pin(project)}
								>
									<FiStar fill={project.is_pinned ? "currentColor" : "none"} />
								</button>
							</article>
						))}
					</div>
				)}
			</div>
		</main>
	);
}

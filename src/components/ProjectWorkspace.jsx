import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeLatexArrows } from "../lib/latexArrows.mjs";
import {
	FiArrowLeft,
	FiFileText,
	FiFolder,
	FiMessageSquare,
	FiStar,
	FiTrash2,
	FiUpload,
} from "react-icons/fi";
import { LuTarget, LuMessageSquare, LuFiles, LuShield, LuSparkles, LuChevronRight } from "react-icons/lu";
import { projectDate } from "./ProjectsView";
import ProjectSkillsCard from "./project/ProjectSkillsCard";
import {
	PERMISSION_MODE_LABELS,
	availablePermissionModes,
	defaultPermissionMode,
} from "../lib/permissionModes.mjs";
import ChatInput from "./ChatInput";
import { TextField, TextAreaField, SelectField } from "./FormControls";
import "./projects.css";

export default function ProjectWorkspace({
	projectId,
	sessions = [],
	onBack,
	onUpdated,
	onLoadChat,
	chatDisabled,
	canStartChat,
	chatComposer = {},
	onStartChat,
}) {
	const [project, setProject] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const [goal, setGoal] = useState("");
	const [instructions, setInstructions] = useState("");
	const [chatPage, setChatPage] = useState(1);
	const [dragging, setDragging] = useState(false);
	const [version, setVersion] = useState(0);
	const composerRef = useRef(null);
	const [permissionMode, setPermissionMode] = useState(null);
	const input = useRef(null);
	const lock = useRef(false);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		window.api
			.getProject(projectId)
			.then((value) => {
				if (!active) return;
				setProject(value);
				setName(value.name);
				setGoal(value.description || "");
				setInstructions(value.custom_instructions || "");
			})
			.catch((err) => {
				if (active) setError(err.message);
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [projectId, version]);
	async function perform(task) {
		if (lock.current) return;
		lock.current = true;
		setBusy(true);
		setError("");
		try {
			await task();
		} catch (err) {
			setError(err.message);
		} finally {
			lock.current = false;
			setBusy(false);
		}
	}
	async function save(patch) {
		const updated = await window.api.updateProject(projectId, patch);
		setProject(updated);
		onUpdated(updated);
	}
	async function changeFolder() {
		await perform(async () => {
			try {
				const selectedPath = await window.api.selectDirectory();
				if (!selectedPath) return;
				const previousPath = project.root_path;
				setProject((previous) => ({ ...previous, root_path: selectedPath }));
				try {
					await save({ root_path: selectedPath });
				} catch (error) {
					setProject((previous) => ({ ...previous, root_path: previousPath }));
					throw error;
				}
			} catch (error) {
				console.error("Failed to change project root directory:", error);
				throw error;
			}
		});
	}
	async function upload(files) {
		if (!files.length) return;
		await perform(async () => {
			await window.api.importProjectFiles(projectId, files);
			const updated = await window.api.getProject(projectId);
			setProject(updated);
			onUpdated(updated);
		});
	}
	const chats = sessions
		.filter((session) => session.project_id === projectId)
		.sort((a, b) => (b.last_active_at || "").localeCompare(a.last_active_at || ""));
	const pageCount = Math.max(1, Math.ceil(chats.length / 10));
	const currentPage = Math.min(chatPage, pageCount);
	const visibleChats = chats.slice((currentPage - 1) * 10, currentPage * 10);
	return (
		<main
			className="aero-stage sk-app projects-page project-workspace"
			aria-label="Project workspace"
		>
			<div className="projects-content">
				<button
					className="aero-control sk-button inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium mb-6"
					onClick={onBack}
				>
					<FiArrowLeft /> All Projects
				</button>
				{error && (
					<p
						className="project-error"
						role="alert"
					>
						{error}{" "}
						{!project && (
							<button
								className="aero-control sk-button inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
								onClick={() => setVersion((value) => value + 1)}
							>
								Retry
							</button>
						)}
					</p>
				)}
				{loading ? (
					<p role="status">Loading project…</p>
				) : (
					project && (
						<>
							<header className="projects-heading">
								<div className="flex min-w-0 items-center gap-3">
									<span className="project-heading-icon">
										<FiFolder
											size={18}
											aria-hidden="true"
										/>
									</span>
									<div className="min-w-0">
										<p className="projects-muted mb-2">Project workspace</p>
										<h1 className="break-words">{project.name}</h1>
									</div>
								</div>
								<button
									className="aero-control sk-button inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
									aria-pressed={!!project.is_pinned}
									disabled={busy}
									onClick={() =>
										perform(async () => {
											const updated = await window.api.setProjectPinned(
												projectId,
												!project.is_pinned,
											);
											setProject(updated);
											onUpdated(updated);
										})
									}
								>
									<FiStar fill={project.is_pinned ? "currentColor" : "none"} />
									{project.is_pinned ? "Pinned" : "Pin Project"}
								</button>
							</header>
							<div className="project-hub">
								<div className="project-stack">
									<section className="aero-panel sk-panel project-panel">
										<div className="flex justify-between items-center gap-4 mb-2">
											<h2>
												<LuTarget aria-hidden="true" />
												Project goal
											</h2>
											{!editing && (
												<button
													className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
													disabled={busy}
													onClick={() => setEditing(true)}
												>
													Edit Goal
												</button>
											)}
										</div>
										{editing ? (
											<form
												onSubmit={(event) => {
													event.preventDefault();
													perform(async () => {
														await save({ name, description: goal });
														setEditing(false);
													});
												}}
											>
												<TextField
													label="Project title"
													className="mb-3"
													required
													value={name}
													disabled={busy}
													onChange={(event) => setName(event.target.value)}
												/>
												<TextAreaField
													label="Goal (Markdown)"
													rows={6}
													value={goal}
													disabled={busy}
													onChange={(event) => setGoal(event.target.value)}
												/>
												<div className="project-actions">
													<button
														type="button"
														className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
														disabled={busy}
														onClick={() => {
															setName(project.name);
															setGoal(project.description || "");
															setEditing(false);
														}}
													>
														Cancel
													</button>
													<button
														className="aero-primary sk-button sk-primary inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-xs leading-normal font-semibold"
														disabled={busy || !name.trim()}
													>
														Save Goal
													</button>
												</div>
											</form>
										) : (
											<div className="aero-inset sk-well project-markdown p-3">
												<ReactMarkdown remarkPlugins={[remarkGfm]}>
													{normalizeLatexArrows(
														project.description ||
															"Add a goal to help guide every conversation in this project.",
													)}
												</ReactMarkdown>
											</div>
										)}
									</section>
									<section className="aero-panel sk-panel project-panel">
										<h2>
											<LuMessageSquare aria-hidden="true" />
											Start a new chat
										</h2>
										<div
											className="aero-well sk-well aero-fill sk-fill project-composer"
											onDragOver={(event) => event.preventDefault()}
											onDrop={(event) => {
												event.preventDefault();
												if (!busy && !chatDisabled)
													chatComposer.onPasteFiles?.(
														Array.from(event.dataTransfer.files),
													);
											}}
										>
											{chatComposer.attachments}
											<ChatInput
												{...chatComposer}
												ref={composerRef}
												sessionId={`project-${projectId}`}
												settingsSessionId={null}
												permissionMode={
													permissionMode ?? defaultPermissionMode(project)
												}
												permissionModes={availablePermissionModes(project)}
												onPermissionModeChange={setPermissionMode}
												allowMidRunQuestions
												midRunQuestionsLocked
												attachDisabled={
													busy || chatDisabled || chatComposer.attachDisabled
												}
												loading={busy || chatDisabled}
												canSubmit={canStartChat && !busy && !chatDisabled}
												onSubmit={(text) =>
													perform(async () => {
														await onStartChat(
															projectId,
															text,
															permissionMode ?? defaultPermissionMode(project),
														);
														composerRef.current?.clearSubmitted(
															text,
															`project-${projectId}`,
														);
													})
												}
											/>
										</div>
										{!canStartChat && (
											<p className="projects-muted mt-2!">
												Select and start a model to begin chatting.
											</p>
										)}
									</section>
									<section className="aero-panel sk-panel project-panel">
										<h2>
											<LuMessageSquare aria-hidden="true" />
											Recent chats{" "}
											<span className="projects-muted">({chats.length})</span>
										</h2>
										<div className="aero-flat sk-list px-2 pt-2">
											{chats.length ? (
												visibleChats.map((chat) => (
													<button
														className="aero-list-item sk-list-row project-chat disabled:opacity-40"
														disabled={chatDisabled || busy}
														key={chat.id}
														onClick={() => onLoadChat(chat.id)}
													>
														<FiMessageSquare />
														<span>{chat.title || "Untitled chat"}</span>
														<time className="projects-muted">
															{projectDate(chat.last_active_at)}
														</time>
													</button>
												))
											) : (
												<p className="projects-muted">
													No conversations yet. Start with a question above.
												</p>
											)}
											{chats.length > 10 && (
												<nav
													className="project-pagination mb-2"
													aria-label="Chat list pagination"
												>
													<span
														className="projects-muted"
														role="status"
													>
														{(currentPage - 1) * 10 + 1}–
														{Math.min(currentPage * 10, chats.length)} of{" "}
														{chats.length} chats
													</span>
													<button
														className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
														disabled={currentPage === 1}
														onClick={() => setChatPage(currentPage - 1)}
													>
														Previous
													</button>
													<span className="projects-muted">
														Page {currentPage} of {pageCount}
													</span>
													<button
														className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
														disabled={currentPage === pageCount}
														onClick={() => setChatPage(currentPage + 1)}
													>
														Next
													</button>
												</nav>
											)}
										</div>
									</section>
								</div>
								<aside
									className="project-stack"
									aria-label="Project controls"
								>
									<details
										className="aero-panel sk-panel project-panel group"
										open
									>
										<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 transition-colors hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
											<LuSparkles
												className="inline mr-2"
												aria-hidden="true"
											/>
											Custom instructions
											<LuChevronRight
												size={12}
												aria-hidden="true"
												className="transition-transform duration-200 group-open:rotate-90"
											/>
										</summary>
										<form
											onSubmit={(event) => {
												event.preventDefault();
												perform(() => save({ custom_instructions: instructions }));
											}}
										>
											<TextAreaField
												hint="Applied to every chat in this project."
												aria-label="Custom Instructions"
												rows={5}
												value={instructions}
												disabled={busy}
												onChange={(event) => setInstructions(event.target.value)}
												placeholder="How should the assistant approach this work?"
											/>
											<div className="project-actions">
												<button
													className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
													disabled={
														busy ||
														instructions === (project.custom_instructions || "")
													}
												>
													Save Instructions
												</button>
											</div>
										</form>
									</details>
									<section className="aero-panel sk-panel project-panel">
										<h2>
											<LuFiles aria-hidden="true" />
											Context files{" "}
											<span className="projects-muted">({project.files.length})</span>
										</h2>
										<div
											className="aero-empty sk-empty aero-fill sk-fill project-drop"
											data-dragging={dragging}
											onDragOver={(event) => {
												event.preventDefault();
												if (!busy) setDragging(true);
											}}
											onDragLeave={(event) => {
												if (!event.currentTarget.contains(event.relatedTarget))
													setDragging(false);
											}}
											onDrop={(event) => {
												event.preventDefault();
												setDragging(false);
												if (!busy) upload(Array.from(event.dataTransfer.files));
											}}
										>
											<FiUpload className="mx-auto mb-2" />
											<p className="projects-muted">Drop reference files here</p>
											<button
												className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium mt-3"
												disabled={busy}
												onClick={() => input.current.click()}
											>
												Choose Files
											</button>
											<p className="projects-muted mt-2!">
												Text, Markdown, code, or PDF · up to 20 MB each
											</p>
											<input
												ref={input}
												type="file"
												multiple
												className="hidden"
												aria-label="Upload project context files"
												accept=".txt,.md,.pdf,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.toml,.ini,.sql,.log,.mjs,.cjs,.sh,.tsv,.c,.h,.cpp,.java,.go,.rs,.rb,.php"
												onChange={(event) => {
													const files = Array.from(event.target.files);
													event.target.value = "";
													upload(files);
												}}
											/>
										</div>
										{project.files.map((file) => (
											<div
												className="project-file"
												key={file.id}
											>
												<FiFileText />
												<span title={file.file_path}>{file.file_name}</span>
												<button
													className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium"
													aria-label={`Remove ${file.file_name}`}
													disabled={busy}
													onClick={() =>
														perform(async () => {
															await window.api.removeProjectFile(file.id);
															setProject((previous) => ({
																...previous,
																files: previous.files.filter(
																	(item) => item.id !== file.id,
																),
															}));
														})
													}
												>
													<FiTrash2 />
												</button>
											</div>
										))}
									</section>
									<ProjectSkillsCard
										project={project}
										onUpdated={(updated) => {
											setProject(updated);
											onUpdated(updated);
										}}
									/>
									<section className="aero-panel sk-panel project-panel">
										<h2 className="flex items-center gap-2">
											<FiFolder /> Root Directory
										</h2>
										<span
											className="project-path sk-path"
											title={project.root_path || ""}
										>
											{project.root_path || "No folder connected"}
										</span>
										<p className="projects-muted mt-2!">
											Connect your working folder to include repository guidelines and
											workspace context.
										</p>
										<button
											className="aero-control sk-button aero-fill sk-fill inline-flex items-center justify-center gap-1.5 min-h-7 px-2.5 py-1.5 cursor-pointer text-[11px] font-medium mt-4"
											disabled={busy}
											onClick={changeFolder}
										>
											{project.root_path ? "Change Folder" : "Connect Folder"}
										</button>
									</section>
									<section className="aero-panel sk-panel project-panel">
										<h2>
											<LuShield aria-hidden="true" />
											Default permission mode
										</h2>
										<SelectField
											hint="Applied to every new chat started in this project."
											aria-label="Default permission mode"
											value={defaultPermissionMode(project)}
											disabled={busy}
											onChange={(event) =>
												perform(() => save({ permissionMode: event.target.value }))
											}
										>
											{availablePermissionModes(project).map((mode) => (
												<option
													key={mode}
													value={mode}
												>
													{PERMISSION_MODE_LABELS[mode]}
												</option>
											))}
										</SelectField>
										{!project.root_path && (
											<p className="projects-muted mt-2!">
												Connect a root folder to make Workspace Write available.
											</p>
										)}
									</section>
								</aside>
							</div>
						</>
					)
				)}
			</div>
		</main>
	);
}

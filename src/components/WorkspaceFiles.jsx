import WorkspaceFileEditor from "./WorkspaceFileEditor.jsx";
import Tooltip from "./Tooltip.jsx";
import WorkspaceChanges, { WORKSPACE_CHANGES } from "./WorkspaceChanges.jsx";
import React, { useEffect, useRef, useState, useMemo } from "react";
import DiffReviewModal from "./chat/DiffReviewModal.jsx";
import {
	FiChevronDown,
	FiChevronRight,
	FiFile,
	FiFolder,
	FiRefreshCw,
	FiSearch,
	FiGitBranch,
	FiX,
	FiCornerDownLeft,
} from "react-icons/fi";

function fileLanguage(path) {
	const name = path.split("/").pop().toLowerCase();
	const extension = name.split(".").pop();
	if (/^(dockerfile|containerfile)(\.|$)/.test(name)) return "docker";
	if ([".bashrc", ".zshrc", ".profile"].includes(name)) return "bash";

	return (
		{
			js: "javascript",
			mjs: "javascript",
			cjs: "javascript",
			jsx: "jsx",
			ts: "typescript",
			mts: "typescript",
			cts: "typescript",
			tsx: "tsx",
			json: "json",
			jsonc: "json",
			css: "css",
			scss: "scss",
			less: "less",
			html: "markup",
			htm: "markup",
			xml: "markup",
			svg: "markup",
			md: "markdown",
			mdx: "markdown",
			py: "python",
			pyw: "python",
			sh: "bash",
			bash: "bash",
			zsh: "bash",
			yml: "yaml",
			yaml: "yaml",
			toml: "toml",
			sql: "sql",
			rs: "rust",
			go: "go",
			java: "java",
			c: "c",
			h: "c",
			cpp: "cpp",
			hpp: "cpp",
			cs: "csharp",
			rb: "ruby",
			php: "php",
			swift: "swift",
			kt: "kotlin",
			diff: "diff",
			patch: "diff",
			ini: "ini",
			conf: "ini",
			ps1: "powershell",
			r: "r",
			lua: "lua",
		}[extension] || "text"
	);
}

function Directory({ projectId, path = ".", depth = 0, selectedPath, onSelect, refresh, modified }) {
	const [state, setState] = useState({ loading: true });
	const [expanded, setExpanded] = useState({});

	useEffect(() => {
		let cancelled = false;
		setState({ loading: true });
		Promise.resolve()
			.then(() => {
				if (!window.api?.listWorkspaceDirectory)
					throw new Error("File browsing requires the desktop app.");
				return window.api.listWorkspaceDirectory(projectId, path);
			})
			.then(
				(result) => {
					if (!cancelled) setState(result);
				},
				(error) => {
					if (!cancelled) setState({ error: error.message });
				},
			);
		return () => {
			cancelled = true;
		};
	}, [projectId, path, refresh]);

	if (state.loading || state.error)
		return (
			<p
				role={state.error ? "alert" : "status"}
				className="px-3 py-2 text-xs text-[var(--text-muted)]"
			>
				{state.error || "Loading files…"}
			</p>
		);

	return (
		<ul aria-label={path === "." ? "Workspace files" : path}>
			{state.items.map((item) => (
				<li key={item.path}>
					<Tooltip content={item.path}>
						<button
							type="button"
							aria-label={item.path}
							aria-expanded={item.directory ? !!expanded[item.path] : undefined}
							aria-current={!item.directory && selectedPath === item.path ? "true" : undefined}
							onClick={() =>
								item.directory
									? setExpanded((old) => ({ ...old, [item.path]: !old[item.path] }))
									: onSelect(item.path)
							}
							style={{ paddingLeft: 12 + depth * 14 }}
							className={`flex w-full cursor-pointer ui-radius-control items-center gap-2 py-1.5 pr-3 text-left text-xs hover:bg-[var(--surface-hover)] ${selectedPath === item.path ? "bg-[var(--surface-hover)] text-[var(--accent)]" : ""}`}
						>
							{item.directory ? (
								<>
									{expanded[item.path] ? (
										<FiChevronDown className="shrink-0" />
									) : (
										<FiChevronRight className="shrink-0" />
									)}
									<FiFolder className="shrink-0 text-[var(--accent)]" />
								</>
							) : (
								<FiFile className="ml-5 shrink-0 text-[var(--text-muted)]" />
							)}
							{!item.directory && modified.has(item.path) && (
								<span
									aria-label="Modified"
									className="shrink-0 font-semibold text-[var(--warning)]"
								>
									M
								</span>
							)}
							<span
								className={`truncate ${!item.directory && modified.has(item.path) ? "text-[var(--warning)]" : ""}`}
							>
								{item.name}
							</span>
						</button>
					</Tooltip>
					{item.directory && expanded[item.path] && (
						<Directory
							{...{ projectId, selectedPath, onSelect, refresh, modified }}
							path={item.path}
							depth={depth + 1}
						/>
					)}
				</li>
			))}
			{!state.items.length && (
				<li className="px-3 py-2 text-xs text-[var(--text-muted)]">Empty folder</li>
			)}
			{state.truncated && (
				<li className="px-3 py-2 text-xs text-[var(--text-muted)]">
					Showing the first 2,000 entries.
				</li>
			)}
		</ul>
	);
}

function FileSearch({ projectId, selectedPath, onSelect, refresh, onClose, active, onQueryActive }) {
	const [query, setQuery] = useState("");
	const [result, setResult] = useState(null);
	const needle = query.trim();
	const requestKey = JSON.stringify([projectId, needle, refresh]);
	const state = result?.key === requestKey ? result : { loading: true };
	useEffect(() => {
		if (!needle || !active) return;
		let cancelled = false;
		const timer = setTimeout(async () => {
			try {
				const data = await window.api.searchWorkspaceFiles(projectId, needle);
				if (!cancelled) setResult({ key: requestKey, ...data });
			} catch (error) {
				if (!cancelled) setResult({ key: requestKey, error: error.message });
			}
		}, 500);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [projectId, needle, refresh, active]);
	return (
		<>
			<div className="border-b border-[var(--border)] px-3 py-2">
				<input
					autoFocus
					type="search"
					aria-label="Search workspace files"
					placeholder="Search files by name or path…"
					maxLength={256}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						onQueryActive(!!event.target.value.trim());
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							onClose();
						}
					}}
					className="w-full ui-radius-control border border-[var(--control-border)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
				/>
			</div>
			{needle && (
				<div
					className="min-h-0 flex-1 overflow-auto py-1"
					aria-label="File search results"
				>
					{state.loading || state.error ? (
						<p
							role={state.error ? "alert" : "status"}
							className="px-3 py-2 text-xs text-[var(--text-muted)]"
						>
							{state.error || "Searching files…"}
						</p>
					) : (
						<>
							{state.items.map((item) => (
								<button
									key={item.path}
									type="button"
									aria-label={item.path}
									aria-current={selectedPath === item.path ? "true" : undefined}
									onClick={() => onSelect(item.path)}
									className={`flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--surface-hover)] ${selectedPath === item.path ? "bg-[var(--surface-hover)] text-[var(--accent)]" : ""}`}
								>
									<FiFile className="mt-0.5 shrink-0" />
									<span className="min-w-0">
										<span className="block truncate">{item.name}</span>
										<span className="block break-all text-[10px] text-[var(--text-muted)]">
											{item.path}
										</span>
									</span>
								</button>
							))}
							<p
								role="status"
								className="px-3 py-2 text-xs text-[var(--text-muted)]"
							>
								{state.truncated
									? "Search limit reached. Refine your search."
									: state.items.length
										? `${state.items.length} files found`
										: "No matching files."}
							</p>
							<p className="px-3 pb-2 text-[10px] text-[var(--text-muted)]">
								Dependencies and build folders are excluded.
							</p>
						</>
					)}
				</div>
			)}
		</>
	);
}

export const WorkspaceFiles = React.memo(function WorkspaceFiles({
	projectId,
	projectName,
	selectedPath,
	onSelect,
	active = true,
}) {
	const [refresh, setRefresh] = useState(0);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searching, setSearching] = useState(false);
	const searchToggle = useRef(null);
	const [modified, setModified] = useState(new Set());
	const [hasRepository, setHasRepository] = useState(false);
	useEffect(() => setSearching(false), [projectId]);
	useEffect(() => {
		let cancelled = false;
		setHasRepository(false);
		window.api.getWorkspaceRepository(projectId).then(
			(result) => {
				if (!cancelled) setHasRepository(result.available);
			},
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [projectId, refresh]);

	useEffect(() => {
		let cancelled = false;
		let pending = false;
		if (!active) return;

		async function loadStatus() {
			if (cancelled || document.hidden || pending || !window.api?.getWorkspaceGitStatus) return;
			pending = true;
			try {
				const result = await window.api.getWorkspaceGitStatus(projectId);
				if (!cancelled) {
					const next = new Set(result.connected ? result.modified : []);
					setModified((previous) =>
						previous.size === next.size && [...next].every((path) => previous.has(path))
							? previous
							: next,
					);
				}
			} catch {
				if (!cancelled) setModified(new Set());
			} finally {
				pending = false;
			}
		}

		loadStatus();

		const timer = setInterval(loadStatus, 10000);
		window.addEventListener("focus", loadStatus);
		document.addEventListener("visibilitychange", loadStatus);

		return () => {
			cancelled = true;
			clearInterval(timer);
			window.removeEventListener("focus", loadStatus);
			document.removeEventListener("visibilitychange", loadStatus);
		};
	}, [projectId, refresh, active]);

	return (
		<section
			className="flex h-full min-h-0 flex-col"
			aria-label="File explorer"
		>
			<div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs font-medium">
				<FiFolder className="shrink-0" />
				<span className="min-w-0 flex-1 truncate">{projectName || "Workspace"}</span>
				{hasRepository && (
					<Tooltip content="Review all uncommitted changes">
						<button
							type="button"
							onClick={() => onSelect(WORKSPACE_CHANGES)}
							className="material-control sk-button material-fill sk-fill flex size-7 shrink-0 cursor-pointer items-center justify-center ui-radius-control"
							aria-label="Review all uncommitted changes"
						>
							<FiGitBranch aria-hidden="true" />
						</button>
					</Tooltip>
				)}
				<Tooltip content="Refresh files">
					<button
						type="button"
						aria-label="Refresh files"
						onClick={() => setRefresh((value) => value + 1)}
						className="material-control sk-button material-fill sk-fill flex size-7 shrink-0 cursor-pointer items-center justify-center ui-radius-control"
					>
						<FiRefreshCw />
					</button>
				</Tooltip>
				<Tooltip content="Search files">
					<button
						ref={searchToggle}
						type="button"
						aria-label="Toggle file search"
						aria-expanded={searchOpen}
						aria-pressed={searchOpen}
						onClick={() => {
							setSearchOpen((value) => !value);
							setSearching(false);
						}}
						className="material-control sk-button material-fill sk-fill flex size-7 shrink-0 cursor-pointer items-center justify-center ui-radius-control"
					>
						<FiSearch />
					</button>
				</Tooltip>
			</div>
			{searchOpen && (
				<FileSearch
					key={projectId}
					projectId={projectId}
					selectedPath={selectedPath}
					onSelect={onSelect}
					refresh={refresh}
					active={active}
					onQueryActive={setSearching}
					onClose={() => {
						setSearchOpen(false);
						setSearching(false);
						searchToggle.current?.focus();
					}}
				/>
			)}

			<div
				className="min-h-0 flex-1 overflow-auto py-1"
				style={searchOpen && searching ? { display: "none" } : undefined}
			>
				<Directory
					key={projectId}
					{...{ projectId, selectedPath, onSelect, refresh, modified }}
				/>
			</div>
		</section>
	);
});

function UnsupportedFile({ projectId, path }) {
	const [error, setError] = useState("");
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--text-muted)]">
			<p>File format not supported</p>
			<button
				type="button"
				className="material-control sk-button material-fill sk-fill ui-radius-control px-4 py-2 cursor-pointer"
				onClick={() =>
					window.api.revealWorkspaceFile(projectId, path).catch((error) => setError(error.message))
				}
			>
				Show in file manager
			</button>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}

function MediaPreview({ state, projectId, path }) {
	const [failed, setFailed] = useState(false);
	if (failed)
		return (
			<UnsupportedFile
				projectId={projectId}
				path={path}
			/>
		);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4">
			{state.kind === "image" ? (
				<img
					src={state.src}
					alt={path}
					onError={() => setFailed(true)}
					className="max-h-full max-w-full object-contain"
				/>
			) : (
				<video
					src={state.src}
					controls
					preload="metadata"
					onError={() => setFailed(true)}
					className="max-h-full max-w-full"
				/>
			)}
		</div>
	);
}

export const WorkspaceFilePreview = React.memo(function WorkspaceFilePreview({
	projectId,
	sessionId,
	running = false,
	path,
	onClose,
	onSelectFile,
	onAddToChat,
}) {
	const drafts = useRef({});
	const [refresh, setRefresh] = useState(0);
	const requestKey = JSON.stringify([projectId, path, refresh]);
	const [loadedFile, setLoadedFile] = useState(null);
	// Props change before effects run. Never mount an editor for the new path
	// with the previous file's content, which would cache a draft under that path.
	const state = loadedFile?.key === requestKey ? loadedFile.result : { loading: true };
	const [showDiff, setShowDiff] = useState(false);
	const allChanges = path === WORKSPACE_CHANGES;
	const [wrap, setWrap] = useState(false);
	const [repository, setRepository] = useState(null);

	useEffect(() => {
		let cancelled = false;
		setRepository(null);
		Promise.resolve()
			.then(() => window.api.getWorkspaceRepository(projectId))
			.then(
				(result) => {
					if (!cancelled) {
						setRepository({ projectId, available: result.available });
						if (!result.available) setShowDiff(false);
					}
				},
				() => {
					if (!cancelled) {
						setRepository(null);
						setShowDiff(false);
					}
				},
			);
		return () => {
			cancelled = true;
		};
	}, [projectId, refresh]);

	const gitAvailable = repository?.projectId === projectId && repository.available;

	useEffect(() => setShowDiff(false), [projectId, path]);

	useEffect(() => {
		let cancelled = false;
		setLoadedFile({ key: requestKey, result: { loading: true } });
		Promise.resolve()
			.then(() =>
				path === WORKSPACE_CHANGES
					? { loading: true }
					: window.api.readWorkspaceFile(projectId, path),
			)
			.then(
				(result) => {
					if (!cancelled) setLoadedFile({ key: requestKey, result });
				},
				(error) => {
					if (!cancelled) setLoadedFile({ key: requestKey, result: { error: error.message } });
				},
			);
		return () => {
			cancelled = true;
		};
	}, [projectId, path, refresh]);

	const diffPreview = useMemo(
		() => (
			<DiffReviewModal
				key={`${sessionId}:${path}:${refresh}`}
				embedded
				wrap={wrap}
				sessionId={sessionId}
				filePath={path}
				running={running}
				onClose={() => setShowDiff(false)}
			/>
		),
		[sessionId, path, refresh, running, wrap],
	);

	return (
		<section
			aria-label="File preview"
			className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--surface)] text-[var(--text-primary)]"
		>
			<header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2.5 text-xs">
				<FiFile className="shrink-0" />
				<Tooltip content={path === WORKSPACE_CHANGES ? "Uncommitted changes" : path}>
					<span className="min-w-0 flex-1 truncate">
						{allChanges ? "Uncommitted changes" : path}
					</span>
				</Tooltip>
				{gitAvailable && !allChanges && (
					<div
						role="group"
						aria-label="Preview mode"
						className="flex shrink-0 items-center gap-1"
					>
						{[
							["File", false],
							["Git diff", true],
						].map(([label, active]) => (
							<button
								key={label}
								type="button"
								aria-pressed={showDiff === active}
								onClick={() => setShowDiff(active)}
								className="material-control sk-button material-fill sk-fill flex h-7 cursor-pointer items-center justify-center ui-radius-control px-2.5 text-[11px]"
							>
								{label}
							</button>
						))}
					</div>
				)}
				<Tooltip content={wrap ? "Disable line wrap" : "Enable line wrap"}>
					<button
						type="button"
						disabled={
							!allChanges &&
							!showDiff &&
							(state.kind || state.binary || state.loading || !!state.error)
						}
						aria-label="Toggle line wrap"
						aria-pressed={wrap}
						onClick={() => setWrap((value) => !value)}
						className="material-control sk-button material-fill sk-fill flex size-7 shrink-0 cursor-pointer items-center justify-center ui-radius-control"
					>
						<FiCornerDownLeft />
					</button>
				</Tooltip>
				<button
					type="button"
					aria-label="Refresh preview"
					onClick={() => {
						const key = JSON.stringify([projectId, path]);
						if (
							drafts.current[key]?.dirty &&
							!window.confirm("Discard unsaved edits and reload this file?")
						)
							return;
						delete drafts.current[key];
						setRefresh((value) => value + 1);
					}}
					className="material-control sk-button material-fill sk-fill flex size-7 shrink-0 cursor-pointer items-center justify-center ui-radius-control"
				>
					<FiRefreshCw />
				</button>
				<button
					type="button"
					aria-label="Close file preview"
					onClick={() => {
						if (
							Object.values(drafts.current).some((draft) => draft.dirty) &&
							!window.confirm("Discard unsaved file edits?")
						)
							return;
						onClose();
					}}
					className="material-orb sk-icon-button material-fill sk-fill flex size-7 shrink-0 cursor-pointer items-center justify-center"
				>
					<FiX />
				</button>
			</header>
			{allChanges && gitAvailable ? (
				<WorkspaceChanges
					key={`${sessionId}:${refresh}`}
					sessionId={sessionId}
					refresh={refresh}
					wrap={wrap}
					onOpenFile={onSelectFile || (() => {})}
				/>
			) : showDiff && gitAvailable ? (
				<div className="min-h-0 flex-1">{diffPreview}</div>
			) : state.kind ? (
				<MediaPreview
					key={`${projectId}:${path}:${refresh}`}
					state={state}
					projectId={projectId}
					path={path}
				/>
			) : state.binary ? (
				<UnsupportedFile
					key={`${projectId}:${path}`}
					projectId={projectId}
					path={path}
				/>
			) : state.loading || state.error ? (
				<p
					role={state.error ? "alert" : "status"}
					className="p-4 text-sm text-[var(--text-muted)]"
				>
					{state.error ||
						(state.loading ? "Loading preview…" : "Preview is unavailable for this binary file.")}
				</p>
			) : (
				<>
					{state.truncated && (
						<p
							role="status"
							className="px-3 py-2 text-xs text-[var(--text-muted)]"
						>
							Showing the first 512 KB.
						</p>
					)}
					<WorkspaceFileEditor
						key={`${projectId}:${path}:${refresh}`}
						projectId={projectId}
						path={path}
						content={state.content || ""}
						truncated={state.truncated}
						wrap={wrap}
						drafts={drafts}
						language={fileLanguage(path)}
						onAddToChat={onAddToChat}
					/>
				</>
			)}
		</section>
	);
});

export function WorkspaceSplit({ children, preview, visible = true }) {
	const root = useRef(null);
	const [width, setWidth] = useState(45);

	function resize(event) {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	return (
		<div
			ref={root}
			style={visible ? undefined : { display: "none" }}
			className="workspace-split flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
		>
			<div className="order-3 flex min-h-0 min-w-0 flex-1">{children}</div>
			{preview && (
				<>
					<div
						role="separator"
						aria-label="Resize chat and file preview"
						aria-orientation="vertical"
						tabIndex={0}
						aria-valuemin={25}
						aria-valuemax={75}
						aria-valuenow={Math.round(width)}
						onKeyDown={(event) => {
							if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
								event.preventDefault();
								setWidth((value) =>
									Math.max(25, Math.min(75, value + (event.key === "ArrowLeft" ? -5 : 5))),
								);
							}
						}}
						onPointerDown={resize}
						onPointerMove={(event) => {
							if (event.currentTarget.hasPointerCapture(event.pointerId)) {
								const bounds = root.current.getBoundingClientRect();
								setWidth(
									Math.max(
										25,
										Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100),
									),
								);
							}
						}}
						onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
						className="relative order-2 w-px shrink-0 touch-none cursor-col-resize bg-[var(--border)] hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)]"
					>
						<span
							aria-hidden="true"
							className="absolute inset-y-0 -left-1 w-2"
						/>
					</div>
					<div
						className="order-1 min-h-0 min-w-0 overflow-hidden"
						style={{ flex: `0 0 ${width}%` }}
					>
						{preview}
					</div>
				</>
			)}
		</div>
	);
}

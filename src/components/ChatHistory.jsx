import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	FiCheck,
	FiChevronDown,
	FiChevronRight,
	FiEdit2,
	FiFolder,
	FiFolderPlus,
	FiMessageSquare,
	FiMoreHorizontal,
	FiPlus,
	FiSearch,
	FiTrash2,
	FiX,
} from "react-icons/fi";

const UNASSIGNED = "Uncategorized";
const DRAG_TYPE = "application/x-chat-session";
const buttonStyle =
	"flex items-center gap-2 rounded-lg px-3 py-1 cursor-pointer text-sm transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
const tokenFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function ActionDialog({ action, folders, busy, disabled, error, onClose, onSubmit }) {
	const dialog = useRef(null);
	const [value, setValue] = useState(
		action.kind === "Rename"
			? action.session.title || ""
			: action.kind === "Move to Folder"
				? action.session.folder_name || UNASSIGNED
				: "",
	);
	useEffect(() => {
		const element = dialog.current;
		element.showModal();
		return () => element.close();
	}, []);

	return createPortal(
		<dialog
			ref={dialog}
			aria-labelledby="chat-action-title"
			className="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-5 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/50"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<form
				className="grid gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit(value.trim());
				}}
			>
				<div className="flex items-center justify-between gap-3">
					<h2
						id="chat-action-title"
						className="font-semibold"
					>
						{action.kind}
					</h2>
					<button
						type="button"
						className={buttonStyle}
						aria-label="Close dialog"
						disabled={busy}
						onClick={onClose}
					>
						<FiX />
					</button>
				</div>
				{action.kind === "Delete" ? (
					<p className="text-sm text-[var(--text-secondary)]">
						Delete “{action.session.title || "Untitled chat"}” and all its messages?
					</p>
				) : action.kind === "Move to Folder" ? (
					<fieldset
						disabled={busy || disabled}
						className="max-h-72 space-y-1 overflow-y-auto"
					>
						<legend className="mb-2 text-xs text-[var(--text-muted)]">
							Choose a destination for “{action.session.title || "Untitled chat"}”
						</legend>
						{[...folders, UNASSIGNED].map((name) => (
							<label
								key={name}
								className={`${buttonStyle} cursor-pointer ${value === name ? "bg-[var(--active-chat)]" : ""}`}
							>
								<input
									type="radio"
									name="destination"
									value={name}
									checked={value === name}
									onChange={() => setValue(name)}
									className="accent-[var(--accent)]"
								/>
								{name === UNASSIGNED ? (
									<FiMessageSquare className="shrink-0" />
								) : (
									<FiFolder className="shrink-0" />
								)}
								<span className="min-w-0 flex-1 break-words">
									{name === UNASSIGNED ? "Chats (unassigned)" : name}
								</span>
								{value === name && <FiCheck className="shrink-0" />}
							</label>
						))}
					</fieldset>
				) : (
					<input
						autoFocus
						required
						aria-label={action.kind === "New Folder" ? "Folder name" : "Chat name"}
						value={value}
						disabled={busy || disabled}
						onChange={(event) => setValue(event.target.value)}
						placeholder={action.kind === "New Folder" ? "Folder name" : "Chat name"}
						className="w-full rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
					/>
				)}
				{error && (
					<p
						role="alert"
						className="text-sm text-[var(--error)]"
					>
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<button
						type="button"
						className={buttonStyle}
						disabled={busy}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						className={`${buttonStyle} bg-[var(--active-chat)]`}
						disabled={busy || disabled || (action.kind !== "Delete" && !value.trim())}
					>
						{busy
							? "Saving…"
							: action.kind === "Move to Folder"
								? "Move chat"
								: action.kind === "New Folder"
									? "Create folder"
									: action.kind === "Delete"
										? "Delete chat"
										: "Save"}
					</button>
				</div>
			</form>
		</dialog>,
		document.body,
	);
}

export default function ChatHistory({ groups, activeId, disabled, isOpen = true, onLoad, onNew, onAction }) {
	const [search, setSearch] = useState("");
	const [collapsed, setCollapsed] = useState(new Set());
	const [menu, setMenu] = useState(null);
	const [action, setAction] = useState(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [dropTarget, setDropTarget] = useState(null);
	const menuRef = useRef(null);
	const menuTrigger = useRef(null);
	const locked = disabled || busy;
	const folders = useMemo(
		() =>
			[...new Set(groups.map((group) => group.folder_name).filter((name) => name !== UNASSIGNED))].sort(
				(a, b) => a.localeCompare(b),
			),
		[groups],
	);
	const orderedGroups = [...folders, UNASSIGNED].map((name) => ({
		folder_name: name,
		sessions: groups.find((group) => group.folder_name === name)?.sessions || [],
	}));
	const query = search.trim().toLocaleLowerCase();
	const visibleGroups = orderedGroups
		.map((group) => ({
			...group,
			sessions: group.folder_name.toLocaleLowerCase().includes(query)
				? group.sessions
				: group.sessions.filter((session) =>
						(session.title || "Untitled chat").toLocaleLowerCase().includes(query),
					),
		}))
		.filter(
			(group) =>
				!query || group.sessions.length || group.folder_name.toLocaleLowerCase().includes(query),
		);

	function closeMenu(restoreFocus = false) {
		setMenu(null);
		if (restoreFocus) menuTrigger.current?.focus();
	}
	useEffect(() => {
		if (!isOpen) {
			setMenu(null);
			setAction(null);
		}
		if (disabled) setMenu(null);
	}, [isOpen, disabled]);
	useEffect(() => {
		if (!menu) return;
		menuRef.current?.querySelector("button")?.focus();
		const outside = (event) => {
			if (!menuRef.current?.contains(event.target) && !menuTrigger.current?.contains(event.target))
				setMenu(null);
		};
		const dismiss = () => setMenu(null);
		document.addEventListener("pointerdown", outside);
		window.addEventListener("resize", dismiss);
		document.addEventListener("scroll", dismiss, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", dismiss);
			document.removeEventListener("scroll", dismiss, true);
		};
	}, [menu]);

	function openMenu(event, session, trigger = event.currentTarget) {
		event.preventDefault();
		if (locked) return;
		if (menu?.session.id === session.id) return closeMenu(true);
		menuTrigger.current = trigger;
		const rect = trigger.getBoundingClientRect();
		setMenu({
			session,
			left: Math.max(8, Math.min(rect.right - 184, window.innerWidth - 192)) + window.scrollX,
			top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 132)) + window.scrollY,
		});
	}
	function choose(kind) {
		setAction({ kind, session: menu.session });
		setError("");
		closeMenu();
	}
	async function perform(kind, id, value) {
		if (locked) return;
		setBusy(true);
		setError("");
		try {
			await onAction(kind, id, value);
			if (kind === "Move to Folder" || kind === "New Folder")
				setCollapsed((current) => {
					const next = new Set(current);
					next.delete(value);
					return next;
				});
			setAction(null);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	}
	function drop(event, folder) {
		event.preventDefault();
		setDropTarget(null);
		if (locked) return;
		const id = event.dataTransfer.getData(DRAG_TYPE);
		const session = groups.flatMap((group) => group.sessions).find((item) => item.id === id);
		if (session && session.folder_name !== folder) perform("Move to Folder", id, folder);
	}

	return (
		<aside
			aria-label="Chat history"
			className="flex h-full w-[272px] shrink-0 flex-col bg-[var(--surface)] text-[var(--text-primary)] max-[650px]:w-[220px]"
		>
			<div className="space-y-3 px-3 pt-4 pb-2">
				<div className="flex items-center gap-1">
					<button
						className="flex-1 w-full py-1 shrink-0 items-center justify-center rounded-md border-0 text-[var(--on-accent)] cursor-pointer transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
						disabled={locked}
						onClick={onNew}
					>
						✦ New chat
					</button>
				</div>
				<label className="flex items-center gap-2 rounded-lg bg-[var(--input)] px-3 py-2 text-[var(--text-muted)] focus-within:ring-1 focus-within:ring-[var(--accent)]">
					<FiSearch className="shrink-0" />
					<input
						type="search"
						aria-label="Search chats and folders"
						placeholder="Search chats…"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							closeMenu();
						}}
						className="min-w-0 w-full bg-transparent text-sm text-[var(--text-primary)] outline-none"
					/>
				</label>
				<button
					className={buttonStyle}
					disabled={locked}
					onClick={() => {
						setAction({ kind: "New Folder" });
						setError("");
					}}
					title="New Folder"
					aria-label="New Folder"
				>
					<FiFolderPlus className="size-4" />
				</button>
			</div>
			<nav
				aria-label="Saved chats"
				className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
			>
				{visibleGroups.map((group) => {
					const expanded = !!query || !collapsed.has(group.folder_name);
					return (
						<section
							key={group.folder_name}
							aria-label={group.folder_name === UNASSIGNED ? "Chats" : group.folder_name}
							className={`mt-3 rounded-lg ${dropTarget === group.folder_name ? "bg-[var(--active-chat)] ring-1 ring-[var(--accent)]" : ""}`}
							onDragOver={(event) => {
								if (!locked && [...event.dataTransfer.types].includes(DRAG_TYPE)) {
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									setDropTarget(group.folder_name);
								}
							}}
							onDragLeave={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
							}}
							onDrop={(event) => drop(event, group.folder_name)}
						>
							<button
								className={`${buttonStyle} w-full text-xs font-medium text-[var(--text-muted)]`}
								aria-expanded={expanded}
								onClick={() =>
									setCollapsed((current) => {
										const next = new Set(current);
										if (next.has(group.folder_name)) next.delete(group.folder_name);
										else next.add(group.folder_name);
										return next;
									})
								}
							>
								{expanded ? (
									<FiChevronDown className="shrink-0" />
								) : (
									<FiChevronRight className="shrink-0" />
								)}
								{group.folder_name !== UNASSIGNED && <FiFolder className="shrink-0" />}
								<span
									className="min-w-0 flex-1 truncate text-left"
									title={group.folder_name}
								>
									{group.folder_name === UNASSIGNED ? "Chats" : group.folder_name}
								</span>
								<span>{group.sessions.length}</span>
							</button>
							{expanded && (
								<div className="space-y-0.5 ml-4">
									{!group.sessions.length && (
										<p className="px-8 py-2 text-xs text-[var(--text-muted)]">
											{query
												? "No matching chats"
												: group.folder_name === UNASSIGNED
													? "No chats yet"
													: "Drop chats here"}
										</p>
									)}
									{group.sessions.map((session) => (
										<div
											key={session.id}
											data-session-id={session.id}
											draggable={!locked}
											onDragStart={(event) => {
												if (locked) {
													event.preventDefault();
													return;
												}
												closeMenu();
												event.dataTransfer.setData(DRAG_TYPE, session.id);
												event.dataTransfer.effectAllowed = "move";
											}}
											onDragEnd={() => setDropTarget(null)}
											onContextMenu={(event) =>
												openMenu(
													event,
													session,
													event.currentTarget.querySelector("[aria-haspopup]"),
												)
											}
											className={`group relative flex py-1 duration-300 items-center rounded-lg transition-colors ${activeId === session.id ? "bg-[var(--active-chat)]" : "bg-transparent hover:bg-[var(--surface-hover)]"}`}
										>
											<button
												className="min-w-0 flex-1 truncate rounded-lg py-0 pl-3 pr-1 text-left text-[12px] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 cursor-pointer"
												disabled={locked}
												aria-current={activeId === session.id ? "page" : undefined}
												title={session.title || "Untitled chat"}
												onClick={() => {
													closeMenu();
													onLoad(session.id);
												}}
											>
												{session.title || "Untitled chat"}
											</button>
											<span
												className="shrink-0 block group-hover:hidden text-[10px] tabular-nums text-[var(--text-muted)] duration-300 pr-1.5"
												title={`${(session.total_tokens || 0).toLocaleString()} estimated tokens in saved messages`}
											>
												{tokenFormatter.format(session.total_tokens || 0)} tokens
											</span>
											<button
												className="shrink-0 hidden group-hover:block rounded-md px-1.5 text-[var(--text-muted)] cursor-pointer hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40"
												aria-label={`Actions for ${session.title || "Untitled chat"}`}
												aria-haspopup="menu"
												aria-expanded={menu?.session.id === session.id}
												disabled={locked}
												onClick={(event) => openMenu(event, session)}
											>
												<FiMoreHorizontal />
											</button>
										</div>
									))}
								</div>
							)}
						</section>
					);
				})}
				{!visibleGroups.length && (
					<p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
						No matching chats or folders
					</p>
				)}
			</nav>
			{error && !action && (
				<p
					role="alert"
					className="px-3 pb-3 text-xs text-[var(--error)]"
				>
					{error}
				</p>
			)}

			{menu &&
				createPortal(
					<div
						ref={menuRef}
						role="menu"
						aria-label="Chat actions"
						style={{ left: menu.left, top: menu.top }}
						className="absolute z-50 w-[184px] rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-1 text-[var(--text-primary)] shadow-xl"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								closeMenu(true);
							}
							if (event.key === "Tab") closeMenu();
							if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
								event.preventDefault();
								const items = [...event.currentTarget.querySelectorAll("button")];
								const index = items.indexOf(document.activeElement);
								items[
									event.key === "Home"
										? 0
										: event.key === "End"
											? items.length - 1
											: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
												items.length
								]?.focus();
							}
						}}
					>
						{[
							[FiEdit2, "Rename"],
							[FiFolder, "Move to Folder"],
							[FiTrash2, "Delete"],
						].map(([Icon, kind]) => (
							<button
								key={kind}
								role="menuitem"
								className={`${buttonStyle} w-full ${kind === "Delete" ? "text-[var(--error)]" : ""}`}
								disabled={locked}
								onClick={() => choose(kind)}
							>
								<Icon />
								{kind}
							</button>
						))}
					</div>,
					document.body,
				)}
			{action && (
				<ActionDialog
					action={action}
					folders={folders}
					busy={busy}
					disabled={disabled}
					error={error}
					onClose={() => setAction(null)}
					onSubmit={(value) => perform(action.kind, action.session?.id, value)}
				/>
			)}
		</aside>
	);
}

import React, { useState } from "react";

export default function ChatHistory({ groups, activeId, disabled, onLoad, onNew, onAction }) {
	const [menu, setMenu] = useState(null);
	const [action, setAction] = useState(null);
	const [value, setValue] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	function choose(kind) {
		setAction({ kind, session: menu });
		setValue(kind === "Rename" ? menu.title || "" : menu.folder_name);
		setMenu(null);
		setError("");
	}
	return (
		<aside
			className="w-[220px] shrink-0 overflow-y-auto border-r border-[var(--border)] p-3 max-[650px]:w-[150px] max-[650px]:p-1.5"
			aria-label="Chat history"
		>
			<button
				className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50"
				disabled={disabled || busy}
				onClick={onNew}
			>
				＋ New chat
			</button>
			{!groups.length && <p>No saved chats yet.</p>}
			{groups.map((group) => (
				<details
					key={group.folder_name}
					open
				>
					<summary className="mt-4 mb-2 cursor-pointer [overflow-wrap:anywhere]">
						{group.folder_name} ({group.sessions.length})
					</summary>
					{group.sessions.map((session) => (
						<div
							className="my-1 flex flex-wrap"
							key={session.id}
							onContextMenu={(event) => {
								event.preventDefault();
								if (!disabled && !busy) setMenu(session);
							}}
						>
							<button
								className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50 min-w-0 flex-1 truncate text-left aria-[current=page]:bg-[var(--active-chat)]"
								disabled={disabled || busy}
								aria-current={activeId === session.id ? "page" : undefined}
								onClick={() => onLoad(session.id)}
								title={session.title || "Untitled chat"}
							>
								{session.title || "Untitled chat"}
							</button>
							<button
								className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50"
								aria-label={`Actions for ${session.title || "Untitled chat"}`}
								disabled={disabled || busy}
								onClick={() => setMenu(session)}
							>
								⋯
							</button>
							{menu?.id === session.id && (
								<div
									className="grid w-full gap-1 p-1.5"
									role="menu"
									onKeyDown={(event) => {
										if (event.key === "Escape") setMenu(null);
									}}
								>
									{["Rename", "Move to Folder", "Delete"].map((kind) => (
										<button
											className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50"
											role="menuitem"
											key={kind}
											disabled={disabled || busy}
											onClick={() => choose(kind)}
										>
											{kind}
										</button>
									))}
									<button
										className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50"
										role="menuitem"
										onClick={() => setMenu(null)}
									>
										Close
									</button>
								</div>
							)}
						</div>
					))}
				</details>
			))}
			{action && (
				<form
					className="mt-4 grid gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						setBusy(true);
						try {
							await onAction(action.kind, action.session.id, value.trim());
							setAction(null);
						} catch (err) {
							setError(err.message);
						} finally {
							setBusy(false);
						}
					}}
				>
					<strong>{action.kind}</strong>
					{action.kind === "Delete" ? (
						<p>Delete this chat and all its messages?</p>
					) : (
						<input
							className="w-full box-border border border-[var(--edit-border)] bg-[var(--edit-bg)] p-2 text-inherit"
							autoFocus
							aria-label={action.kind}
							required
							value={value}
							list={action.kind === "Move to Folder" ? "chat-folders" : undefined}
							onChange={(event) => setValue(event.target.value)}
						/>
					)}
					<datalist id="chat-folders">
						{groups.map((group) => (
							<option
								key={group.folder_name}
								value={group.folder_name}
							/>
						))}
					</datalist>
					{error && (
						<p
							role="alert"
							className="text-[var(--error)]"
						>
							{error}
						</p>
					)}
					<button
						className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50"
						disabled={busy || disabled || (action.kind !== "Delete" && !value.trim())}
					>
						Save
					</button>
					<button
						className="cursor-pointer rounded-[5px] border border-[var(--control-border)] bg-transparent p-1.5 text-inherit disabled:cursor-default disabled:opacity-50"
						type="button"
						disabled={busy}
						onClick={() => setAction(null)}
					>
						Cancel
					</button>
				</form>
			)}
		</aside>
	);
}

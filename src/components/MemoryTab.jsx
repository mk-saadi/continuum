import React, { useEffect, useState } from "react";
import { SettingsIcon as Icon } from "./SettingsIcon";

export default function MemoryTab({ palace }) {
	const [memories, setMemories] = useState([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [category, setCategory] = useState("preference");
	const [content, setContent] = useState("");
	const [alwaysInject, setAlwaysInject] = useState(true);
	useEffect(() => {
		let active = true;
		if (!palace.api) {
			setError("Open the desktop app to manage memories.");
			setLoading(false);
			return;
		}
		palace.api
			.getAllActiveMemories()
			.then((rows) => {
				if (active) setMemories(rows);
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
	}, [palace.api]);

	async function mutate(action) {
		setBusy(true);
		setError("");
		try {
			await action();
			setMemories(await palace.api.getAllActiveMemories());
			await palace.refresh();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	}

	function addMemory(event) {
		event.preventDefault();
		if (!content.trim() || busy) return;
		mutate(async () => {
			await palace.api.addPermanentMemory({
				category,
				content: content.trim(),
				scope: "global",
				alwaysInject,
			});
			setContent("");
		});
	}

	return (
		<div className="space-y-4">
			{error && (
				<p
					className="palace-error"
					role="alert"
				>
					{error}
				</p>
			)}
			{loading ? (
				<p role="status">Loading memories…</p>
			) : memories.length === 0 ? (
				<p className="palace-empty">No memories yet. Add a preference below.</p>
			) : (
				<ul className="palace-list">
					{memories.map((memory) => (
						<li key={memory.id}>
							<div>
								<span className="palace-tag">{memory.category}</span>
								<span className="palace-scope">
									{memory.scope}
									{memory.always_inject ? " · Core" : ""}
								</span>
								<p>{memory.content}</p>
							</div>
							<button
								className="palace-icon palace-delete"
								disabled={busy}
								aria-label={`Delete memory: ${memory.content}`}
								title="Delete memory"
								onClick={() => mutate(() => palace.api.deleteMemory(memory.id))}
							>
								<Icon name="delete" />
							</button>
						</li>
					))}
				</ul>
			)}
			<form
				className="palace-form"
				onSubmit={addMemory}
			>
				<h3>Add memory</h3>
				<label>
					Category
					<select
						value={category}
						onChange={(event) => setCategory(event.target.value)}
						disabled={busy}
					>
						<option value="preference">Preference</option>
						<option value="rule">Rule</option>
						<option value="fact">Fact</option>
					</select>
				</label>
				<label>
					Rule or preference
					<textarea
						required
						maxLength={8000}
						rows={2}
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder="e.g. Keep answers concise and use metric units."
						disabled={busy}
					/>
				</label>
				<label className="palace-check">
					<input
						type="checkbox"
						checked={alwaysInject}
						onChange={(event) => setAlwaysInject(event.target.checked)}
						disabled={busy}
					/>{" "}
					Include in every request when memory is on
				</label>
				<button
					className="palace-add"
					disabled={busy || !palace.api || !content.trim()}
				>
					{busy ? "Saving…" : "Add memory"}
				</button>
			</form>
		</div>
	);
}

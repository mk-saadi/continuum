import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TextField, TextAreaField } from "./FormControls";
import "./projects.css";

export default function ProjectModal({ onClose, onCreate }) {
	const ref = useRef(null);
	const [fields, setFields] = useState({
		name: "",
		description: "",
		custom_instructions: "",
		root_path: null,
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const dialog = ref.current;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	async function pickFolder() {
		setBusy(true);
		setError("");
		try {
			const root_path = await window.api.pickDirectory();
			if (root_path) setFields((previous) => ({ ...previous, root_path }));
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	}
	async function submit(event) {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			await onCreate(fields);
			onClose();
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	}
	return createPortal(
		<dialog
			ref={ref}
			className="aero-dialog m-auto w-[min(540px,calc(100vw-32px))] max-h-[calc(100dvh-48px)] overflow-auto p-7"
			aria-labelledby="new-project-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<form onSubmit={submit} className="grid gap-[18px]">
				<div className="aero-header -mx-7 -mt-7 px-7 py-5">
					<h2
						id="new-project-title"
						className="text-xl font-semibold"
					>
						Create a project
					</h2>
					<p className="projects-muted mt-2">Give your work a shared goal and a place to grow.</p>
				</div>
				<fieldset
					disabled={busy}
					className="grid gap-4"
				>
					<TextField label="Name" disabled={busy}
							autoFocus
							required
							maxLength={200}
							value={fields.name}
							onChange={(event) => setFields({ ...fields, name: event.target.value })}
							placeholder="e.g. Personal website"
						/>
					<TextAreaField label="Goal / Description" rows={4} disabled={busy}
							value={fields.description}
							onChange={(event) => setFields({ ...fields, description: event.target.value })}
							placeholder="What are you working toward? Markdown is supported."
						/>
					<TextAreaField label="Custom Instructions" rows={4} disabled={busy}
							value={fields.custom_instructions}
							onChange={(event) =>
								setFields({ ...fields, custom_instructions: event.target.value })
							}
							placeholder="Preferences and rules for every chat in this project"
						/>
					<div className="project-field">
						<span>Root folder (optional)</span>
						<span
							className="aero-inset break-all px-3 py-2 font-mono text-xs text-[var(--text-muted)]"
							title={fields.root_path || ""}
						>
							{fields.root_path || "No folder selected"}
						</span>
						<button
							type="button"
							className="aero-control aero-fill px-3 py-2 text-xs font-medium"
							onClick={pickFolder}
						>
							Choose Folder
						</button>
					</div>
				</fieldset>
				{error && (
					<p
						role="alert"
						className="project-error"
					>
						{error}
					</p>
				)}
				<div className="aero-footer -mx-7 -mb-7 flex justify-end gap-2 px-7 py-4">
					<button
						type="button"
						className="aero-control aero-fill px-3 py-2 text-xs font-medium"
						disabled={busy}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						className="aero-primary aero-fill px-3 py-2 text-xs font-semibold"
						disabled={busy || !fields.name.trim()}
					>
						{busy ? "Saving…" : "Create Project"}
					</button>
				</div>
			</form>
		</dialog>,
		document.body,
	);
}

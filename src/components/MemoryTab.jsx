import React, { useEffect, useState } from "react";
import { LuBrain } from "react-icons/lu";
import { SettingsIcon as Icon } from "./SettingsIcon";
import { SelectField, TextAreaField } from "./FormControls";
import {
	SettingsButton,
	SettingsCard,
	SettingsCheckRow,
	SettingsEmpty,
	SettingsMessage,
} from "./settings/SettingsSection";

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
		<div className="space-y-3">
			<SettingsCard
				icon={LuBrain}
				title="Saved memories"
				description="Facts and preferences injected into future requests when memory is on."
			>
				<SettingsMessage>{error}</SettingsMessage>
				{loading ? (
					<p
						role="status"
						className="text-[11px] text-[var(--text-muted)]"
					>
						Loading memories…
					</p>
				) : memories.length === 0 ? (
					<SettingsEmpty>No memories yet. Add a preference below.</SettingsEmpty>
				) : (
					<ul className="divide-y divide-[var(--border)]">
						{memories.map((memory) => (
							<li
								key={memory.id}
								className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">
											{memory.category}
										</span>
										<span className="text-[10px] text-[var(--text-muted)]">
											{memory.scope}
											{memory.always_inject ? " · Core" : ""}
										</span>
									</div>
									<p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--text-primary)]">
										{memory.content}
									</p>
								</div>
								<button
									type="button"
									className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--error)] active:translate-y-0.5 focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
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
			</SettingsCard>

			<SettingsCard
				as="form"
				title="Add memory"
				onSubmit={addMemory}
				className="space-y-3"
			>
				<SelectField
					label="Category"
					value={category}
					onChange={(event) => setCategory(event.target.value)}
					disabled={busy}
				>
					<option value="preference">Preference</option>
					<option value="rule">Rule</option>
					<option value="fact">Fact</option>
				</SelectField>
				<TextAreaField
					label="Rule or preference"
					required
					maxLength={8000}
					rows={2}
					value={content}
					onChange={(event) => setContent(event.target.value)}
					placeholder="e.g. Keep answers concise and use metric units."
					disabled={busy}
				/>
				<SettingsCheckRow
					label="Include in every request when memory is on"
					checked={alwaysInject}
					onChange={(event) => setAlwaysInject(event.target.checked)}
					disabled={busy}
				/>
				<SettingsButton
					type="submit"
					variant="primary"
					disabled={busy || !palace.api || !content.trim()}
				>
					{busy ? "Saving…" : "Add memory"}
				</SettingsButton>
			</SettingsCard>
		</div>
	);
}

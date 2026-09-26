import React, { useEffect, useRef, useState } from "react";
import {
	LuBot,
	LuCheck,
	LuInfo,
	LuRotateCcw,
	LuSave,
	LuSettings2,
	LuSlidersHorizontal,
	LuSparkles,
	LuUsers,
	LuX,
} from "react-icons/lu";
import { SelectField, TextAreaField } from "./FormControls";
import ChatTuning from "./ChatTuning";

const sections = [
	{ id: "persona", label: "Agent & Persona", Icon: LuBot },
	{ id: "sampling", label: "Sampling", Icon: LuSlidersHorizontal },
];

const fieldClass =
	"mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--input)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const secondaryButton =
	"inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

export default function RightSidebar({
	open,
	onClose,
	sessionId,
	modelId,
	agents,
	sessionAgent,
	disabled,
	onSelectAgent,
	onManageAgents,
	onSavePrompt,
	tuningVersion,
}) {
	const tabs = useRef([]);
	const [tab, setTab] = useState("persona");
	const [scope, setScope] = useState("chat");
	const [prompt, setPrompt] = useState("");
	const [notice, setNotice] = useState("");
	const [saving, setSaving] = useState(false);

	const sections = [
		{ id: "persona", label: "Agent & Persona", Icon: LuUsers },
		{ id: "sampling", label: "Sampling", Icon: LuSlidersHorizontal },
	];

	const secondaryButton =
		"flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

	const handleSavePrompt = async (e) => {
		e.preventDefault();
		setSaving(true);
		try {
			await onSavePrompt?.(prompt);
			setNotice("Saved");
		} finally {
			setSaving(false);
		}
	};

	return (
		<aside
			id="right-sidebar"
			aria-label="Chat controls"
			aria-hidden={!open}
			inert={open ? undefined : ""}
			className={`h-full shrink-0 overflow-hidden bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-all duration-300 ease-in-out motion-reduce:transition-none max-[900px]:absolute max-[900px]:top-0 max-[900px]:right-0 max-[900px]:z-30 max-[900px]:shadow-xl ${open ? "w-80 translate-x-0 opacity-100" : "w-0 translate-x-full opacity-0"}`}
		>
			<div className="flex h-full w-80 flex-col border-l border-[var(--border)]">
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-4">
					<div className="flex min-w-0 items-center gap-3">
						<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--active-chat)] text-[var(--accent)]">
							<LuSettings2
								size={18}
								aria-hidden="true"
							/>
						</span>
						<div>
							<h2 className="text-sm font-semibold">Chat controls</h2>
							<p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
								Make this chat yours
							</p>
						</div>
					</div>
					<button
						type="button"
						aria-label="Close chat controls"
						className="flex size-7 cursor-pointer shrink-0 items-center justify-center active:translate-y-0.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] duration-300"
						onClick={onClose}
					>
						<LuX
							size={17}
							aria-hidden="true"
						/>
					</button>
				</header>

				<div
					role="tablist"
					aria-label="Chat control sections"
					className="flex shrink-0 gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-3 pt-2"
				>
					{sections.map(({ id, label, Icon }, index) => (
						<button
							key={id}
							ref={(node) => {
								tabs.current[index] = node;
							}}
							type="button"
							role="tab"
							id={`controls-tab-${id}`}
							aria-controls={`controls-${id}`}
							aria-selected={tab === id}
							tabIndex={tab === id ? 0 : -1}
							onClick={() => setTab(id)}
							onKeyDown={(event) => {
								if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
									event.preventDefault();
									const next =
										event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
									setTab(sections[next].id);
									tabs.current[next]?.focus();
								}
							}}
							className={`flex flex-1 items-center justify-center cursor-pointer gap-1.5 whitespace-nowrap border-b-2 px-2 py-3 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${tab === id ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
						>
							<Icon
								size={15}
								aria-hidden="true"
							/>
							{label}
						</button>
					))}
				</div>

				<section
					role="tabpanel"
					id="controls-persona"
					aria-labelledby="controls-tab-persona"
					hidden={tab !== "persona"}
					className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
				>
					<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
						<div className="mb-3 flex items-center gap-2">
							<LuUsers
								size={16}
								className="text-[var(--accent)]"
								aria-hidden="true"
							/>
							<h3 className="text-xs font-semibold">Active agent</h3>
						</div>

						<SelectField
							label="Assistant for this conversation"
							value={sessionAgent?.id || ""}
							disabled={disabled}
							onChange={(value) => onSelectAgent(value)}
						>
							<option value="">Default assistant</option>
							{sessionAgent?.id && !agents.some((agent) => agent.id === sessionAgent.id) && (
								<option value={sessionAgent.id}>{sessionAgent.name} (saved profile)</option>
							)}
							{agents.map((agent) => (
								<option
									key={agent.id}
									value={agent.id}
								>
									{agent.name}
								</option>
							))}
						</SelectField>

						<div className="mt-3 flex flex-wrap gap-2">
							<button
								type="button"
								className={secondaryButton}
								disabled={disabled}
								onClick={onManageAgents}
							>
								<LuUsers
									size={14}
									aria-hidden="true"
								/>{" "}
								Manage agents
							</button>
							{sessionAgent?.id && (
								<button
									type="button"
									className={secondaryButton}
									disabled={
										disabled || !agents.some((agent) => agent.id === sessionAgent.id)
									}
									onClick={() => onSelectAgent(sessionAgent.id)}
								>
									<LuRotateCcw
										size={14}
										aria-hidden="true"
									/>{" "}
									Reapply preset
								</button>
							)}
						</div>
					</div>

					<form
						className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
						onSubmit={handleSavePrompt}
					>
						<div className="mb-3 flex items-center gap-2">
							<LuSparkles
								size={16}
								className="text-[var(--accent)]"
								aria-hidden="true"
							/>
							<h3 className="text-xs font-semibold">System prompt</h3>
						</div>

						<TextAreaField
							label="Instructions for this chat"
							hint={
								<span className="flex items-start gap-1.5 mt-2">
									<LuInfo
										size={13}
										className="mt-0.5 shrink-0"
										aria-hidden="true"
									/>
									Applies to this chat; the library preset stays unchanged.
								</span>
							}
							rows={11}
							maxLength={32000}
							disabled={disabled || saving}
							value={prompt}
							onChange={(event) => {
								setPrompt(event.target.value);
								setNotice("");
							}}
							placeholder="Add instructions for this chat…"
							inputClassName="resize-y leading-relaxed"
						/>

						<div className="mt-3 flex items-center justify-between gap-2">
							<span
								role="status"
								className="flex items-center gap-1 text-[11px] text-[var(--accent)]"
							>
								{notice && (
									<>
										<LuCheck
											size={13}
											aria-hidden="true"
										/>
										{notice}
									</>
								)}
							</span>
							<button
								type="submit"
								className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
								disabled={disabled || saving}
							>
								<LuSave
									size={14}
									aria-hidden="true"
								/>{" "}
								{saving ? "Saving…" : "Save prompt"}
							</button>
						</div>
					</form>
				</section>

				<section
					role="tabpanel"
					id="controls-sampling"
					aria-labelledby="controls-tab-sampling"
					hidden={tab !== "sampling"}
					className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
				>
					<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
						<div className="mb-3 flex items-center gap-2">
							<LuSlidersHorizontal
								size={16}
								className="text-[var(--accent)]"
								aria-hidden="true"
							/>
							<h3 className="text-xs font-semibold">Sampling scope</h3>
						</div>

						<SelectField
							label="Apply tuning to"
							value={scope}
							onChange={(value) => setScope(value)}
							hint={
								scope === "chat"
									? "These settings affect only this conversation."
									: "These defaults apply to new conversations."
							}
						>
							<option value="chat">This chat</option>
							<option value="global">Global defaults</option>
						</SelectField>
					</div>

					<div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
						<ChatTuning
							key={`${scope}:${sessionId}:${tuningVersion}`}
							sessionId={scope === "chat" ? sessionId : undefined}
							modelId={modelId}
						/>
					</div>
				</section>
			</div>
		</aside>
	);
}

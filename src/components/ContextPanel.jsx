import React, { useCallback, useEffect, useState } from "react";

// Read-only Workspace Context inspection: what compression preserved — the
// current and historical checkpoints, the verbatim task brief, the rolling
// summary, and the archived original messages. Workspace-only; Casual Chat
// never mounts this panel. All checkpoint text and tool output render as
// plain text (React-escaped), never as markup.

const cardClass = "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3";
const headingClass = "text-xs font-semibold";
const bodyClass = "text-[11px] leading-relaxed text-[var(--text-muted)]";
const pillClass = "shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium";
const verifiedClass = "text-[var(--accent)]";
const unverifiedClass = "text-[var(--text-muted)]";
const errorClass = "text-[var(--error)]";
const warnClass = "text-amber-500";

function formatTimestamp(value) {
	if (typeof value !== "string" || !value) return null;
	const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString();
}

function StatusPill({ tone, children }) {
	return (
		<span
			role="status"
			className={`${pillClass} ${tone === "good" ? verifiedClass : tone === "bad" ? errorClass : tone === "warn" ? warnClass : unverifiedClass}`}
		>
			{children}
		</span>
	);
}

function SectionTitle({ children }) {
	return <h4 className="mb-1 mt-3 text-[11px] font-semibold">{children}</h4>;
}

function EmptyNote({ children }) {
	return <p className={bodyClass}>{children}</p>;
}

function EvidenceRef({ source, evidence }) {
	if (!source || typeof source !== "object") return null;
	const key = `${source.messageId}:${source.stepId ?? ""}`;
	const record = evidence?.[key];
	const label = source.stepId != null ? `msg #${source.messageId} · step ${source.stepId}` : `msg #${source.messageId}`;
	if (!record || !record.found) {
		return (
			<span className={`${bodyClass} italic`}>
				{label} (record unavailable)
			</span>
		);
	}
	return (
		<details className="mt-0.5">
			<summary className="cursor-pointer text-[11px] text-[var(--text-secondary)]">
				{label}
				{record.toolName ? ` · ${record.toolName}` : ""}
				{record.status ? ` · ${record.status}` : ""}
			</summary>
			{record.snippet ? (
				<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-secondary)] p-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
					{record.snippet}
				</pre>
			) : (
				<p className={bodyClass}>No recorded output.</p>
			)}
		</details>
	);
}

function CheckpointDetail({ record, evidence }) {
	if (!record) return <EmptyNote>No checkpoint selected.</EmptyNote>;
	const { checkpoint } = record;
	if (!checkpoint) return <EmptyNote>This checkpoint record is unreadable.</EmptyNote>;
	const created = formatTimestamp(record.created_at);
	return (
		<div className="min-w-0">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="text-xs font-semibold">Checkpoint v{record.id}</span>
				{record.status === "current" ? (
					<StatusPill tone={record.stale ? "warn" : "good"}>{record.stale ? "Stale" : "Current"}</StatusPill>
				) : (
					<StatusPill tone="muted">Superseded</StatusPill>
				)}
				{record.stale ? (
					<p role="note" className={`${bodyClass} w-full`}>
						Changed since this snapshot: {record.staleReasons.join("; ") || "history moved on"}. Verify against the current chat before acting.
					</p>
				) : null}
				{record.status !== "current" ? (
					<p role="note" className={`${bodyClass} w-full`}>
						Superseded versions describe past history; verify against the current chat before acting.
					</p>
				) : null}
			</div>
			<p className={`${bodyClass} mt-1`}>
				{created ? `Recorded ${created}` : "Recording time unavailable"}
				{record.model_id ? ` · model ${record.model_id}` : ""}
				{typeof record.archivedCount === "number" ? ` · covers ${record.archivedCount} archived message${record.archivedCount === 1 ? "" : "s"}` : ""}
			</p>
			<SectionTitle>Objective</SectionTitle>
			<p className="text-[11px] leading-relaxed">{checkpoint.objective}</p>
			<SectionTitle>Outstanding requirements ({checkpoint.outstandingRequirements.length})</SectionTitle>
			{checkpoint.outstandingRequirements.length === 0 ? (
				<EmptyNote>None recorded.</EmptyNote>
			) : (
				<ul className="space-y-1.5">
					{checkpoint.outstandingRequirements.map((req, index) => (
						<li key={index} className="text-[11px] leading-relaxed">
							<span className="mr-1.5 inline-block min-w-14 rounded-full border border-[var(--border)] px-1.5 py-px text-center text-[10px] font-medium text-[var(--text-secondary)]">
								{req.status}
							</span>
							{req.briefId != null ? <span className="mr-1.5 font-mono text-[10px] text-[var(--text-muted)]">brief #{req.briefId}</span> : null}
							{req.text}
						</li>
					))}
				</ul>
			)}
			{checkpoint.decisions.length > 0 ? (
				<>
					<SectionTitle>Decisions ({checkpoint.decisions.length})</SectionTitle>
					<ul className="space-y-1.5">
						{checkpoint.decisions.map((decision, index) => (
							<li key={index} className="text-[11px] leading-relaxed">
								<StatusPill tone={decision.verified ? "good" : "muted"}>{decision.verified ? "Verified" : "Unverified"}</StatusPill>{" "}
								{decision.text}
								{decision.rationale ? <span className={bodyClass}> — {decision.rationale}</span> : null}
								{(decision.sources ?? []).map((source, sourceIndex) => (
									<EvidenceRef key={sourceIndex} source={source} evidence={evidence} />
								))}
							</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.completedWork.length > 0 ? (
				<>
					<SectionTitle>Completed work ({checkpoint.completedWork.length})</SectionTitle>
					<ul className="space-y-1.5">
						{checkpoint.completedWork.map((item, index) => (
							<li key={index} className="text-[11px] leading-relaxed">
								<StatusPill tone="good">Verified</StatusPill> {item.text}
								{(item.sources ?? []).map((source, sourceIndex) => (
									<EvidenceRef key={sourceIndex} source={source} evidence={evidence} />
								))}
							</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.inProgress.length > 0 ? (
				<>
					<SectionTitle>In progress ({checkpoint.inProgress.length})</SectionTitle>
					<ul className="space-y-1.5">
						{checkpoint.inProgress.map((item, index) => (
							<li key={index} className="text-[11px] leading-relaxed">
								<span className="mr-1.5 font-mono text-[10px] text-[var(--text-muted)]">{item.status}</span>
								{item.text}
								{item.stepRef ? <EvidenceRef source={item.stepRef} evidence={evidence} /> : null}
							</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.filesChanged.length > 0 ? (
				<>
					<SectionTitle>Files changed ({checkpoint.filesChanged.length})</SectionTitle>
					<ul className="space-y-1.5">
						{checkpoint.filesChanged.map((file, index) => (
							<li key={index} className="text-[11px] leading-relaxed">
								<StatusPill tone={file.verified ? "good" : "muted"}>{file.verified ? "Verified" : "Unverified"}</StatusPill>{" "}
								<span className="font-mono text-[10px]">{file.path}</span>
								{file.nature ? <span className={bodyClass}> ({file.nature})</span> : null}
								{file.stepRef ? <EvidenceRef source={file.stepRef} evidence={evidence} /> : null}
							</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.commands.length > 0 ? (
				<>
					<SectionTitle>Commands ({checkpoint.commands.length})</SectionTitle>
					<ul className="space-y-1.5">
						{checkpoint.commands.map((command, index) => (
							<li key={index} className="text-[11px] leading-relaxed">
								<StatusPill tone={command.verified ? "good" : "muted"}>{command.verified ? "Verified" : "Unverified"}</StatusPill>{" "}
								<span className="font-mono text-[10px]">{command.command}</span>
								<span className={bodyClass}> → exit {command.exitCode == null ? "?" : command.exitCode}</span>
								{command.stepRef ? <EvidenceRef source={command.stepRef} evidence={evidence} /> : null}
							</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.tests.length > 0 ? (
				<>
					<SectionTitle>Tests ({checkpoint.tests.length})</SectionTitle>
					<ul className="space-y-1.5">
						{checkpoint.tests.map((test, index) => (
							<li key={index} className="text-[11px] leading-relaxed">
								<StatusPill tone={test.verified ? "good" : "muted"}>{test.verified ? "Verified" : "Unverified"}</StatusPill>{" "}
								{test.command ? <span className="font-mono text-[10px]">{test.command} → </span> : null}
								exit {test.exitCode == null ? "?" : test.exitCode}
								{test.parsedAs === "regex" ? (
									<span className={bodyClass}>
										{" "}(parsed output: {test.passed ?? "?"} passed / {test.failed ?? "?"} failed
										{test.total != null ? ` / ${test.total} total` : ""})
									</span>
								) : (
									<span className={bodyClass}> (no parseable counts)</span>
								)}
								{test.stepRef ? <EvidenceRef source={test.stepRef} evidence={evidence} /> : null}
							</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.blockers.length > 0 ? (
				<>
					<SectionTitle>Blockers ({checkpoint.blockers.length})</SectionTitle>
					<ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed">
						{checkpoint.blockers.map((item, index) => (
							<li key={index}>{item}</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.nextActions.length > 0 ? (
				<>
					<SectionTitle>Next actions ({checkpoint.nextActions.length})</SectionTitle>
					<ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed">
						{checkpoint.nextActions.map((item, index) => (
							<li key={index}>{item}</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.risks.length > 0 ? (
				<>
					<SectionTitle>Risks ({checkpoint.risks.length})</SectionTitle>
					<ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed">
						{checkpoint.risks.map((item, index) => (
							<li key={index}>{item}</li>
						))}
					</ul>
				</>
			) : null}
			{checkpoint.unknowns.length > 0 ? (
				<>
					<SectionTitle>Unknowns ({checkpoint.unknowns.length})</SectionTitle>
					<ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-[var(--text-secondary)]">
						{checkpoint.unknowns.map((item, index) => (
							<li key={index}>{item}</li>
						))}
					</ul>
				</>
			) : null}
		</div>
	);
}

export default function ContextPanel({ sessionId, modelId = null, active = false }) {
	const api = typeof window !== "undefined" ? window.memoryPalace : null;
	const [usage, setUsage] = useState(null);
	const [usageError, setUsageError] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [checkpoint, setCheckpoint] = useState(null);
	const [evidence, setEvidence] = useState({});
	const [history, setHistory] = useState([]);
	const [selectedId, setSelectedId] = useState(null);
	const [briefs, setBriefs] = useState(null);
	const [summary, setSummary] = useState(null);
	const [summaryError, setSummaryError] = useState("");
	const [briefsError, setBriefsError] = useState("");
	const [historyError, setHistoryError] = useState("");
	const [checkpointError, setCheckpointError] = useState("");
	const [archived, setArchived] = useState({ messages: [], total: 0, offset: 0, limit: 20 });
	const [archivedLoading, setArchivedLoading] = useState(false);
	const [archivedError, setArchivedError] = useState("");
	const [lastAttempt, setLastAttempt] = useState(null);

	const loadArchived = useCallback(
		async (offset) => {
			if (!api || !sessionId) return;
			setArchivedLoading(true);
			setArchivedError("");
			try {
				const page = await api.getArchivedMessages(sessionId, { limit: 20, offset });
				setArchived({ messages: page.messages, total: page.total, offset: page.offset, limit: page.limit });
			} catch (err) {
				setArchivedError(err?.message ?? String(err));
			} finally {
				setArchivedLoading(false);
			}
		},
		[api, sessionId],
	);

	const refreshUsage = useCallback(async () => {
		if (!api?.getContextUsage || !sessionId || !modelId) {
			setUsage(null);
			return;
		}
		try {
			setUsage(await api.getContextUsage(sessionId, modelId));
			setUsageError("");
		} catch (err) {
			setUsageError(err?.message ?? String(err));
		}
	}, [api, sessionId, modelId]);

	const refresh = useCallback(async () => {
		if (!api || !sessionId) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError("");
		setCheckpointError("");
		setHistoryError("");
		setBriefsError("");
		setSummaryError("");
		const [checkpointResult, historyResult, briefsResult, summaryResult] = await Promise.allSettled([
			api.getCheckpoint(sessionId),
			api.getCheckpointHistory(sessionId),
			api.getBriefs(sessionId),
			api.getSessionSummary(sessionId),
		]);
		let failed = false;
		if (checkpointResult.status === "fulfilled") {
			setCheckpoint(checkpointResult.value.checkpoint);
			setEvidence(checkpointResult.value.evidence ?? {});
		} else {
			failed = true;
			setCheckpointError(checkpointResult.reason?.message ?? String(checkpointResult.reason));
		}
		if (historyResult.status === "fulfilled") {
			setHistory(historyResult.value.checkpoints ?? []);
		} else {
			failed = true;
			setHistoryError(historyResult.reason?.message ?? String(historyResult.reason));
		}
		if (briefsResult.status === "fulfilled") {
			setBriefs(briefsResult.value);
		} else {
			failed = true;
			setBriefsError(briefsResult.reason?.message ?? String(briefsResult.reason));
		}
		if (summaryResult.status === "fulfilled") {
			const value = summaryResult.value;
			setSummary(typeof value === "string" ? value : (value?.text ?? null));
		} else {
			failed = true;
			setSummaryError(summaryResult.reason?.message ?? String(summaryResult.reason));
		}
		if (failed) setError("Some context sections failed to load. Retry below.");
		setSelectedId(null);
		setLoading(false);
		await loadArchived(0);
	}, [api, sessionId, loadArchived]);

	useEffect(() => {
		setLastAttempt(null);
		setSelectedId(null);
		void refresh();
		void refreshUsage();
	}, [refresh, refreshUsage]);

	useEffect(() => {
		if (active) {
			void refresh();
			void refreshUsage();
		}
	}, [active, refresh, refreshUsage]);

	useEffect(
		() =>
			api?.onCompressionComplete?.((result) => {
				if (!result || result.sessionId !== sessionId) return;
				if (result.compressed) {
					setLastAttempt({
						ok: true,
						archivedCount: result.archivedCount ?? 0,
						checkpointId: result.checkpointId ?? null,
					});
				} else if (result.error || result.reason) {
					setLastAttempt({ ok: false, error: result.error ?? result.reason });
				} else {
					return;
				}
				void refresh();
			}),
		[api, sessionId, refresh],
	);

	if (!api) {
		return (
			<div className={cardClass}>
				<p className={bodyClass}>Context inspection is available in the desktop app.</p>
			</div>
		);
	}

	const selected = selectedId == null ? null : history.find((row) => row.id === selectedId) ?? null;

	return (
		<div className="space-y-3">
			<div className={cardClass}>
				<div className="mb-2 flex items-center justify-between gap-2">
					<h3 className={headingClass}>Token usage</h3>
					<button
						type="button"
						onClick={() => void refreshUsage()}
						className="shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
					>
						Refresh
					</button>
				</div>
				{!modelId ? (
					<p className={bodyClass}>Select a model to load usage.</p>
				) : usageError ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Could not load usage: {usageError}
					</p>
				) : !usage ? (
					<p role="status" className={bodyClass}>
						Loading usage…
					</p>
				) : (
					<dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
						<dt className={bodyClass}>Current estimate</dt>
						<dd className="text-right font-medium">
							{(usage.totalTokens ?? 0).toLocaleString()} tokens
						</dd>
						<dt className={bodyClass}>Last prompt</dt>
						<dd className="text-right font-medium">
							{usage.telemetry?.lastPromptTokens != null
								? usage.telemetry.lastPromptTokens.toLocaleString()
								: "—"}
						</dd>
						<dt className={bodyClass}>Cache read / write</dt>
						<dd className="text-right font-medium">
							{(usage.telemetry?.lastCachedTokens ?? usage.telemetry?.cachedTokens) != null
								? (usage.telemetry.lastCachedTokens ?? usage.telemetry.cachedTokens).toLocaleString()
								: "—"}
							{" / "}
							{(usage.telemetry?.lastCacheCreationTokens ?? usage.telemetry?.cacheCreationTokens) != null
								? (usage.telemetry.lastCacheCreationTokens ?? usage.telemetry.cacheCreationTokens).toLocaleString()
								: "—"}
						</dd>
						<dt className={bodyClass}>Last completion</dt>
						<dd className="text-right font-medium">
							{usage.telemetry?.completionTokens != null
								? usage.telemetry.completionTokens.toLocaleString()
								: "—"}
						</dd>
					</dl>
				)}
				{usage && !usage.telemetry ? (
					<p className={`${bodyClass} mt-1`}>No server request telemetry yet — send a message to populate cache stats.</p>
				) : usage?.telemetry &&
				  (usage.telemetry.lastCachedTokens ?? usage.telemetry.cachedTokens) == null ? (
					<p className={`${bodyClass} mt-1`}>
						Provider did not report cache tokens for the last turn (local cache shows after a llama.cpp response; cloud shows when the provider returns cached tokens).
					</p>
				) : null}
			</div>
			<div className={cardClass}>
				<div className="mb-2 flex items-center justify-between gap-2">
					<h3 className={headingClass}>Compression status</h3>
					<button
						type="button"
						onClick={() => void refresh()}
						disabled={loading}
						className="shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						Refresh
					</button>
				</div>
				{loading ? (
					<p role="status" className={bodyClass}>
						Loading context…
					</p>
				) : error ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						{error}
					</p>
				) : lastAttempt == null ? (
					<p className={bodyClass}>No compression activity observed in this view yet.</p>
				) : lastAttempt.ok ? (
					<p role="status" className={bodyClass}>
						Compressed {lastAttempt.archivedCount} earlier message{lastAttempt.archivedCount === 1 ? "" : "s"}
						{lastAttempt.checkpointId != null ? ` into checkpoint v${lastAttempt.checkpointId}` : " into a new summary"}.
					</p>
				) : (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Last compression attempt failed: {lastAttempt.error}. Saved history is unchanged.
					</p>
				)}
				{checkpoint && !loading && !error ? (
					<p className={`${bodyClass} mt-1`}>
						Last persisted checkpoint: v{checkpoint.id} ({checkpoint.status}
						{checkpoint.stale ? ", stale" : ", current"}).
					</p>
				) : null}
			</div>

			<div className={cardClass}>
				<h3 className={`${headingClass} mb-2`}>Current checkpoint</h3>
				{loading ? (
					<p role="status" className={bodyClass}>
						Loading checkpoint…
					</p>
				) : checkpointError ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Could not load the checkpoint: {checkpointError}
					</p>
				) : checkpoint ? (
					<CheckpointDetail record={checkpoint} evidence={evidence} />
				) : (
					<EmptyNote>No checkpoint yet. Checkpoints are created when long Workspace chats are compressed.</EmptyNote>
				)}
			</div>

			<div className={cardClass}>
				<h3 className={`${headingClass} mb-2`}>Checkpoint history</h3>
				{loading ? (
					<p role="status" className={bodyClass}>
						Loading history…
					</p>
				) : historyError ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Could not load checkpoint history: {historyError}
					</p>
				) : history.length === 0 ? (
					<EmptyNote>No checkpoint versions recorded for this chat.</EmptyNote>
				) : (
					<>
						<div className="flex flex-wrap gap-1.5" role="group" aria-label="Checkpoint versions">
							{history.map((row) => (
								<button
									key={row.id}
									type="button"
									onClick={() => setSelectedId((current) => (current === row.id ? null : row.id))}
									aria-pressed={selectedId === row.id}
									className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${selectedId === row.id ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--surface-hover)]"}`}
								>
									v{row.id} · {row.status}
									{row.stale ? " · stale" : ""}
								</button>
							))}
						</div>
						{selected ? (
							<div className="mt-3 border-t border-[var(--border)] pt-3">
								<CheckpointDetail record={selected} evidence={selected.evidence ?? {}} />
							</div>
						) : (
							<p className={`${bodyClass} mt-2`}>Select a version to inspect it. Superseded versions describe past history.</p>
						)}
					</>
				)}
			</div>

			<div className={cardClass}>
				<h3 className={`${headingClass} mb-2`}>Original task brief</h3>
				{loading ? (
					<p role="status" className={bodyClass}>
						Loading brief…
					</p>
				) : briefsError ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Could not load the task brief: {briefsError}
					</p>
				) : briefs == null || (briefs.applicable.length === 0 && briefs.others.length === 0) ? (
					<EmptyNote>No task brief recorded for this chat.</EmptyNote>
				) : (
					<>
						<ul className="space-y-2.5">
							{briefs.applicable.map((brief) => (
								<li key={brief.id} className="min-w-0">
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="text-[11px] font-semibold">Brief #{brief.id}</span>
										<span className={`${pillClass} ${unverifiedClass}`}>{brief.kind}</span>
										{brief.message_id != null ? (
											<span className="font-mono text-[10px] text-[var(--text-muted)]">#msg-{brief.message_id}</span>
										) : null}
									</div>
									<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-secondary)] p-2 text-[11px] leading-relaxed">
										{brief.content_text}
									</pre>
									{brief.attachments.length > 0 ? (
										<ul className="mt-1 space-y-0.5">
											{brief.attachments.map((attachment, index) => (
												<li key={index} className={bodyClass}>
													📎 {attachment.file_name ?? "attachment"}
													{attachment.available ? "" : " (file unavailable)"}
												</li>
											))}
										</ul>
									) : null}
								</li>
							))}
						</ul>
						{briefs.others.length > 0 ? (
							<>
								<SectionTitle>Other retained records (not applicable to this branch)</SectionTitle>
								<ul className="space-y-2">
									{briefs.others.map((brief) => (
										<li key={brief.id} className="min-w-0">
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="text-[11px] font-semibold">Brief #{brief.id}</span>
												<span className={`${pillClass} ${unverifiedClass}`}>{brief.kind}</span>
											</div>
											<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-secondary)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
												{brief.content_text}
											</pre>
										</li>
									))}
								</ul>
							</>
						) : null}
					</>
				)}
			</div>

			<div className={cardClass}>
				<h3 className={`${headingClass} mb-2`}>Rolling summary</h3>
				{loading ? (
					<p role="status" className={bodyClass}>
						Loading summary…
					</p>
				) : summaryError ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Could not load the summary: {summaryError}
					</p>
				) : summary ? (
					<>
						<p className={`${bodyClass} mb-1`}>
							Generated historical summary — the model&apos;s paraphrase of older turns. It is not the canonical brief or evidence.
						</p>
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-secondary)] p-2 text-[11px] leading-relaxed">
							{summary}
						</pre>
					</>
				) : (
					<EmptyNote>No rolling summary yet. Summaries appear after long chats are compressed.</EmptyNote>
				)}
			</div>

			<div className={cardClass}>
				<h3 className={`${headingClass} mb-2`}>Archived messages</h3>
				{archivedLoading && archived.messages.length === 0 ? (
					<p role="status" className={bodyClass}>
						Loading archived messages…
					</p>
				) : archivedError ? (
					<p role="alert" className={`${bodyClass} ${errorClass}`}>
						Could not load archived messages: {archivedError}
					</p>
				) : archived.total === 0 ? (
					<EmptyNote>No archived messages on this branch. Originals below are stored records, shown as saved.</EmptyNote>
				) : (
					<>
						<p className={`${bodyClass} mb-2`}>
							{archived.total} archived message{archived.total === 1 ? "" : "s"} on this branch, oldest first. Stored records, shown as saved.
						</p>
						<ul className="space-y-2.5">
							{archived.messages.map((message) => (
								<li key={message.id} className="min-w-0 rounded-lg bg-[var(--bg-secondary)] p-2">
									<div className="flex flex-wrap items-center gap-1.5">
										<span className={`${pillClass} ${unverifiedClass}`}>{message.role}</span>
										<span className="font-mono text-[10px] text-[var(--text-muted)]">#msg-{message.id}</span>
										{message.created_at ? (
											<span className="text-[10px] text-[var(--text-muted)]">{message.created_at}</span>
										) : null}
									</div>
									<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
										{message.content || "(no text)"}
									</pre>
									{message.attachments.length > 0 ? (
										<p className={`${bodyClass} mt-1`}>
											📎 {message.attachments.map((attachment) => attachment.file_name ?? "attachment").join(", ")}
										</p>
									) : null}
									{message.executionSteps.length > 0 ? (
										<details className="mt-1">
											<summary className="cursor-pointer text-[11px] text-[var(--text-secondary)]">
												{message.executionSteps.length} recorded step{message.executionSteps.length === 1 ? "" : "s"}
											</summary>
											<ul className="mt-1 space-y-1">
												{message.executionSteps.map((step, index) => (
													<li key={step.id ?? index} className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
														{step.type === "thought" ? (
															<>thought: {step.content}{step.truncated ? " …(truncated)" : ""}</>
														) : (
															<>
																{step.toolName} · {step.status}
																{step.argsSummary ? ` · ${step.argsSummary}` : ""}
																{step.error ? <span className={errorClass}> · {step.error}</span> : null}
																{step.result ? (
																	<pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface)] p-1.5">
																		{step.result}
																		{step.resultTruncated ? " …(truncated)" : ""}
																	</pre>
																) : null}
															</>
														)}
													</li>
												))}
											</ul>
										</details>
									) : null}
								</li>
							))}
						</ul>
						<div className="mt-2 flex items-center justify-between gap-2">
							<button
								type="button"
								disabled={archived.offset === 0 || archivedLoading}
								onClick={() => void loadArchived(Math.max(0, archived.offset - archived.limit))}
								className="cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
							>
								Older
							</button>
							<span className={bodyClass} role="status">
								{archived.total === 0 ? 0 : archived.offset + 1}–{Math.min(archived.offset + archived.limit, archived.total)} of {archived.total}
							</span>
							<button
								type="button"
								disabled={archived.offset + archived.limit >= archived.total || archivedLoading}
								onClick={() => void loadArchived(archived.offset + archived.limit)}
								className="cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
							>
								Newer
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

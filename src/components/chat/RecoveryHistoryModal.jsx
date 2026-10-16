import React, { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiX } from "react-icons/fi";
import { LuHistory, LuPin } from "react-icons/lu";
import { safetyVerdictInfo, restoreOutcomeMessage } from "../../lib/recoverySafety.mjs";

const KIND_TONE = {
	op: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	shell: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	mcp: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	manual: "bg-[var(--accent)]/15 text-[var(--accent-bright)]",
	'pre-restore': "bg-[var(--surface-hover)] text-[var(--text-secondary)]",
};

const STATUS_TONE = {
	modified: "text-amber-500",
	created: "text-[var(--accent-bright)]",
	deleted: "text-[var(--error)]",
	renamed: "text-[var(--accent-bright)]",
	unchanged: "text-[var(--text-muted)]",
	conflict: "text-[var(--error)] font-medium",
	unavailable: "text-[var(--text-muted)]",
	unverifiable: "text-[var(--text-muted)]",
};

function formatTime(value) {
	try {
		return new Date(`${String(value).replace(' ', 'T')}Z`).toLocaleString();
	} catch {
		return String(value ?? '');
	}
}

function changeSummary(entry) {
	if (!entry.changedKinds) return entry.kind;
	const kinds = entry.changedKinds;
	const bits = [
		kinds.modified ? `${kinds.modified} modified` : '',
		kinds.created ? `${kinds.created} created` : '',
		kinds.deleted ? `${kinds.deleted} deleted` : '',
		kinds.renamed ? `${kinds.renamed} renamed` : '',
	].filter(Boolean);
	return bits.length ? bits.join(' · ') : entry.kind;
}

// Main recovery interface: checkpoint history, per-path detail with compare
// excerpts, preview-then-confirm restoration. Read-only until the user
// confirms; restoration refuses while its run is active.
export default function RecoveryHistoryModal({ sessionId, projectName, running = false, onClose }) {
	const dialogRef = useRef(null);
	const [history, setHistory] = useState(null);
	const [selectedId, setSelectedId] = useState(null);
	const [detail, setDetail] = useState(null);
	const [preview, setPreview] = useState(null);
	const [force, setForce] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	// Explicit user authorization for a risky-content restore. Never set
	// programmatically: only the checkbox below flips it, and any new basis
	// (selection, flags, preview) clears it.
	const [riskyConfirmed, setRiskyConfirmed] = useState(false);
	// Re-entrancy guard: `busy` state lags rapid double clicks, so the ref
	// is the actual single-flight gate for preview/restore dispatches.
	const busyRef = useRef(false);

	useEffect(() => {
		const element = dialogRef.current;
		if (element && !element.open) {
			try {
				element.showModal();
			} catch {
				/* Already open or unsupported; content still renders. */
			}
		}
		return () => {
			if (element?.open) element.close();
		};
	}, []);

	const loadHistory = async () => {
		setError('');
		try {
			const value = await window.api.getRecoveryHistory(sessionId, 100);
			setHistory(value);
			if (value.mine.length && !selectedId) setSelectedId(value.mine[0].id);
			else if (!value.mine.length && value.other.length && !selectedId) setSelectedId(value.other[0].id);
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		}
	};

	useEffect(() => {
		setHistory(null);
		setSelectedId(null);
		setDetail(null);
		setPreview(null);
		setConfirming(false);
		setRiskyConfirmed(false);
		setNotice('');
		loadHistory();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionId]);

	useEffect(() => {
		if (selectedId == null) {
			setDetail(null);
			setPreview(null);
			setConfirming(false);
			setRiskyConfirmed(false);
			return;
		}
		let active = true;
		setDetail(null);
		setPreview(null);
		setConfirming(false);
		setRiskyConfirmed(false);
		setError('');
		window.api.getRecoveryDetail(sessionId, selectedId).then(
			(value) => { if (active) setDetail(value); },
			(cause) => { if (active) setError(cause?.message ?? String(cause)); },
		);
		return () => {
			active = false;
		};
	}, [sessionId, selectedId]);

	const runPreviewWith = async (forceValue) => {
		if (selectedId == null || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError('');
		setNotice('');
		try {
			setPreview(await window.api.previewRecoveryRestore(sessionId, selectedId, { force: forceValue }));
			// A fresh preview is a new basis: prior authorization lapses.
			setRiskyConfirmed(false);
			setConfirming(false);
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const runPreview = async () => runPreviewWith(force);

	const runRestore = async () => {
		if (selectedId == null || busyRef.current || running) return;
		busyRef.current = true;
		setBusy(true);
		setError('');
		setNotice('');
		try {
			// Revalidate before applying: the workspace or the checkpoint may
			// have changed since the preview was taken. Never apply a stale
			// verdict, and never infer consent from an older preview.
			let fresh;
			try {
				fresh = await window.api.previewRecoveryRestore(sessionId, selectedId, { force });
			} catch (cause) {
				setPreview(null);
				setConfirming(false);
				setRiskyConfirmed(false);
				setError(`This checkpoint is no longer available: ${cause?.message ?? String(cause)}`);
				return;
			}
			const freshVerdict = fresh?.safety?.verdict ?? 'safe';
			const shownVerdict = preview?.safety?.verdict ?? 'safe';
			if (freshVerdict !== shownVerdict) {
				setPreview(fresh);
				setConfirming(false);
				setRiskyConfirmed(false);
				setNotice('The workspace changed since this preview was taken — review the updated preview before confirming. Nothing was restored.');
				return;
			}
			const authorized = freshVerdict === 'safe'
				|| (freshVerdict === 'authorization-required' && riskyConfirmed)
				|| (freshVerdict === 'refused' && riskyConfirmed && force);
			if (!authorized) {
				setPreview(fresh);
				setNotice(freshVerdict === 'safe'
					? 'Preview refreshed — review it before confirming. Nothing was restored.'
					: 'This restore still needs your explicit confirmation below. Nothing was restored.');
				return;
			}
			const result = await window.api.restoreRecoveryCheckpoint(sessionId, selectedId, { force, allowRisky: riskyConfirmed });
			if (result.strategy === 'refused' || result.strategy === 'authorization-required') {
				// Lost a race between validation and application (or the flags
				// were insufficient): surface the refusal, change nothing else.
				setPreview({ ...(fresh ?? {}), safety: result.safety, strategy: result.strategy });
				setConfirming(false);
				const info = safetyVerdictInfo(result.safety);
				setNotice(info != null
					? `${info.title}. ${info.footer}`
					: 'Restore was not applied: authorization is still required. No files were changed.');
				return;
			}
			const outcome = restoreOutcomeMessage(result);
			setNotice(outcome.text);
			setConfirming(false);
			setPreview(null);
			setRiskyConfirmed(false);
			await loadHistory();
			if (selectedId != null) {
				try {
					setDetail(await window.api.getRecoveryDetail(sessionId, selectedId));
				} catch {
					/* History refresh is the source of truth. */
				}
			}
		} catch (cause) {
			setError(`Restore failed: ${cause?.message ?? String(cause)}`);
			setConfirming(false);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const togglePin = async (entry) => {
		if (busy) return;
		setBusy(true);
		setError('');
		try {
			await window.api.pinRecoveryCheckpoint(sessionId, entry.id, !entry.pinned);
			await loadHistory();
		} catch (cause) {
			setError(cause?.message ?? String(cause));
		} finally {
			setBusy(false);
		}
	};

	const renderEntry = (entry, other) => (
		<li key={entry.id}>
			<button
				type="button"
				onClick={() => setSelectedId(entry.id)}
				aria-pressed={selectedId === entry.id}
				className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left ${selectedId === entry.id ? 'border-[var(--accent)] bg-[var(--active-chat)]' : 'border-[var(--subtle-border)] bg-[var(--surface)] hover:bg-[var(--surface-hover)]'}`}
			>
				<span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${KIND_TONE[entry.kind] ?? KIND_TONE.op}`}>
					{entry.kind}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-xs text-[var(--text-secondary)]">{changeSummary(entry)}</span>
					<span className="block text-[10px] text-[var(--text-muted)] tabular-nums">
						#{entry.id} · {formatTime(entry.createdAt)}{other ? ` · from ${entry.originChat}` : ''}{!entry.coverageComplete ? ' · partial' : ''}{entry.emptyFileCount ? ` · ${entry.emptyFileCount} empty` : ''}
					</span>
				</span>
				{entry.pinned && <LuPin aria-label="Pinned checkpoint" className="shrink-0 text-[var(--accent)]" />}
			</button>
		</li>
	);

	const previewPaths = (list) => (list ?? []).slice(0, 100).map((item) => item.path ?? item);
	const previewChanged = (preview?.restored ?? []).filter((r) => r.action !== 'unchanged');
	const previewUnchanged = (preview?.restored ?? []).length - previewChanged.length;
	const invalidSelection = detail === null && error !== '';
	const restoreBlocked = running || busy || selectedId == null;
	// Safety verdict for the currently displayed preview. Null means safe:
	// the normal flow. Authorization (risky content) and conflict overwrite
	// (force) stay independent decisions — a refused verdict needs both.
	const safetyInfo = safetyVerdictInfo(preview?.safety);
	const confirmRiskyReady = safetyInfo == null || riskyConfirmed;
	const confirmForceReady = safetyInfo?.needsForce ? force : true;
	const confirmBlocked = busy || running || selectedId == null || invalidSelection || !confirmRiskyReady || !confirmForceReady;
	const confirmScopePaths = [...previewPaths(previewChanged), ...previewPaths(preview?.removed ?? [])].slice(0, 12);
	const confirmScopeExtra = previewChanged.length + (preview?.removed ?? []).length - confirmScopePaths.length;

	return (
		<dialog
			ref={dialogRef}
			aria-label="Workspace Recovery history"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
			onClick={(event) => {
				if (event.target === dialogRef.current && !busy) onClose();
			}}
			className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-24px)] max-w-[860px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60"
		>
			<div className="flex max-h-[85dvh] flex-col">
				<header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
					<LuHistory aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
					<h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
						Workspace Recovery{projectName ? <span className="font-normal text-[var(--text-muted)]"> · {projectName}</span> : null}
					</h2>
					<button
						type="button"
						aria-label="Close Workspace Recovery"
						onClick={() => { if (!busy) onClose(); }}
						className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
					>
						<FiX aria-hidden="true" />
					</button>
				</header>
				<div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-xs">
					{error && (
						<p role="alert" className="text-[var(--error)]">
							{error}
						</p>
					)}
					{notice && (
						<p role="status" className="rounded-lg bg-[var(--accent)]/10 px-2.5 py-2 text-[var(--accent-bright)]">
							{notice}
						</p>
					)}
					{!history ? (
						<p className="text-[var(--text-muted)]">Loading recovery history…</p>
					) : history.mine.length === 0 && history.other.length === 0 ? (
						<p className="text-[var(--text-muted)]">No recovery checkpoints yet. They appear automatically once the agent changes files in this workspace.</p>
					) : (
						<>
							<section aria-label="This chat's checkpoints">
								<h3 className="mb-2 text-xs font-semibold">This chat ({history.mine.length})</h3>
								{history.mine.length === 0 ? (
									<p className="text-[11px] text-[var(--text-muted)]">Nothing captured for this chat yet.</p>
								) : (
									<ul className="space-y-1.5">{history.mine.map((entry) => renderEntry(entry, false))}</ul>
								)}
							</section>
							{history.other.length > 0 && (
								<details className="rounded-xl border border-[var(--subtle-border)] px-3 py-2" aria-label="Other chats in this workspace">
									<summary className="flex min-h-8 cursor-pointer items-center gap-2 font-medium">
										<FiChevronDown aria-hidden="true" />
										Other chats in this workspace
										<span className="ml-auto text-[var(--text-muted)]">{history.other.length}</span>
									</summary>
									<ul className="mt-2 space-y-1.5">{history.other.map((entry) => renderEntry(entry, true))}</ul>
									<p className="mt-2 text-[11px] text-[var(--text-muted)]">
										Restoring these still conflict-checks against current files, but they describe another chat's work.
									</p>
								</details>
							)}
						</>
					)}
					{detail && (
						<section aria-label="Checkpoint details" className="space-y-2 rounded-xl border border-[var(--subtle-border)] p-3">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)] tabular-nums">
								<span>Checkpoint #{detail.id} · {detail.kind} · {formatTime(detail.createdAt)}</span>
								{detail.originChat && <span>from {detail.originChat}</span>}
								<button
									type="button"
									onClick={() => togglePin({ id: detail.id, pinned: detail.pinned })}
									disabled={busy}
									className="cursor-pointer rounded border border-[var(--subtle-border)] px-1.5 py-0.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
								>
									{detail.pinned ? 'Unpin (protected from cleanup)' : 'Pin (protect from cleanup)'}
								</button>
							</div>
							{!detail.coverage.complete && (
								<p className="text-[11px] font-medium text-amber-500">
									Partial capture: {(detail.coverage.skipped ?? []).length} path(s) skipped
									{(detail.coverage.excluded ?? []).length ? `, ${(detail.coverage.excluded ?? []).length} excluded by policy` : ''}.
									This checkpoint cannot fully roll back the workspace.
								</p>
							)}
							{(detail.coverage.emptyFiles ?? []).length > 0 && (
								<p className="text-[11px] text-[var(--text-muted)] tabular-nums">
									{(detail.coverage.emptyFiles ?? []).length} recorded file(s) {(detail.coverage.emptyFiles ?? []).length === 1 ? 'is' : 'are'} empty
									{detail.coverage.allEmptyFiles ? ' (every recorded file — treat this checkpoint with suspicion)' : ''}.
								</p>
							)}
							<p className="text-[11px] text-[var(--text-muted)] tabular-nums">
								{detail.totalPaths} path{detail.totalPaths === 1 ? '' : 's'} recorded{detail.truncated ? ' (list truncated for display)' : ''}.
							</p>
							<ul className="max-h-64 space-y-1 overflow-auto rounded-lg border border-[var(--subtle-border)] bg-[var(--surface)] p-2">
								{detail.paths.map((item) => (
									<li key={item.path} className="min-w-0 text-[11px]">
										<span className="flex min-w-0 items-baseline gap-2">
											<span className="min-w-0 flex-1 truncate font-mono" title={item.path}>{item.path}</span>
											<span className={`shrink-0 ${STATUS_TONE[item.status] ?? STATUS_TONE.unverifiable}`}>
												{item.status}{item.reason ? ` (${item.reason})` : ''}
											</span>
										</span>
										{item.diff && !item.diff.identical && (
											<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--code-bg)] p-2 font-mono text-[11px] text-[var(--code-text)]">
												{item.diff.truncated
													? `Lines changed: −${item.diff.hunks[0]?.oldCount ?? '?'} / +${item.diff.hunks[0]?.newCount ?? '?'} (too large to preview)`
													: (item.diff.hunks[0]?.oldLines ?? []).map((line) => `− ${line}`).join('\n')
													+ ((item.diff.hunks[0]?.oldLines?.length && item.diff.hunks[0]?.newLines?.length) ? '\n' : '')
													+ (item.diff.hunks[0]?.newLines ?? []).map((line) => `+ ${line}`).join('\n')}
											</pre>
										)}
									</li>
								))}
							</ul>
							<label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
								<input
									type="checkbox"
									checked={force}
									onChange={(event) => {
										const next = event.target.checked;
										setForce(next);
										setPreview(null);
										setConfirming(false);
										setRiskyConfirmed(false);
										// The safety verdict depends on the flags: refresh the
										// preview so the panel always describes the current
										// basis instead of vanishing until the next click.
										if (selectedId != null) runPreviewWith(next);
									}}
									className="accent-[var(--accent)]"
								/>
								Overwrite files changed since the checkpoint (off = skip conflicts)
							</label>
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									onClick={runPreview}
									disabled={busy || running}
									className="cursor-pointer rounded-md border border-[var(--code-border)] bg-[var(--code-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
								>
									Preview restore
								</button>
							</div>
							{preview && (
								<div className="space-y-1 rounded-lg border border-[var(--subtle-border)] bg-[var(--surface-hover)]/40 p-2.5 text-[11px]" aria-label="Restore preview">
									<p className="font-medium">
										{preview.strategy === 'refused' ? 'Preview: restore refused'
											: preview.strategy === 'authorization-required' ? 'Preview: restore needs confirmation'
											: preview.complete ? 'Preview: complete restore' : 'Preview: partial restore'}
										{preview.strategy === 'preview' ? ' (no changes made)' : ''}
									</p>
									{previewChanged.length > 0 && <p className="text-[var(--text-secondary)]">Would restore: {previewPaths(previewChanged).join(', ')}</p>}
									{previewUnchanged > 0 && <p className="text-[var(--text-muted)]">{previewUnchanged} already matching — no change needed.</p>}
									{previewPaths(preview.removed).length > 0 && <p className="text-[var(--text-secondary)]">Would remove: {previewPaths(preview.removed).join(', ')}</p>}
									{preview.skipped.length > 0 && (
										<p className="text-amber-500">
											Would skip: {preview.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}
										</p>
									)}
									{safetyInfo && (
										<div className={`space-y-1 rounded-md border p-2 ${safetyInfo.tone === 'refused' ? 'border-[var(--error)]/50' : 'border-amber-500/50'}`} aria-label="Restore safety verdict">
											<p className={`font-medium ${safetyInfo.tone === 'refused' ? 'text-[var(--error)]' : 'text-amber-500'}`}>
												{safetyInfo.title}
											</p>
											<p className="text-[var(--text-secondary)]">{safetyInfo.explanation}</p>
											{safetyInfo.lines.length > 0 && (
												<ul className="list-disc pl-4 font-mono text-[var(--text-secondary)]">
													{safetyInfo.lines.slice(0, 12).map((line) => <li key={line}>{line}</li>)}
												</ul>
											)}
											{safetyInfo.lines.length > 12 && (
												<p className="text-[var(--text-muted)]">…and {safetyInfo.lines.length - 12} more.</p>
											)}
											<p className="text-[var(--text-muted)]">{safetyInfo.footer}</p>
											<label className="flex items-start gap-2 pt-1 text-[var(--text-secondary)]">
												<input
													type="checkbox"
													checked={riskyConfirmed}
													onChange={(event) => setRiskyConfirmed(event.target.checked)}
													className="mt-0.5 accent-[var(--accent)]"
												/>
												<span>
													I authorize exactly this content change
													{safetyInfo.filesWouldEmpty > 0 && ` (${safetyInfo.filesWouldEmpty} file${safetyInfo.filesWouldEmpty === 1 ? '' : 's'} would become empty)`}.
													This does not change the overwrite checkbox above.
												</span>
											</label>
											{safetyInfo.needsForce && (
												<p className="text-[var(--text-secondary)]">
													A refused restore additionally requires the overwrite checkbox above — both confirmations are needed.
												</p>
											)}
										</div>
									)}
								</div>
							)}
							{invalidSelection && (
								<p className="text-[11px] text-[var(--error)]">This checkpoint cannot be loaded, so restoration is unavailable.</p>
							)}
							{running && (
								<p className="text-[11px] text-[var(--text-muted)]">Stop the run to enable restoration.</p>
							)}
							{!confirming ? (
								<button
									type="button"
									onClick={() => setConfirming(true)}
									disabled={restoreBlocked || invalidSelection}
									className="cursor-pointer rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
								>
									Restore this checkpoint…
								</button>
							) : (
								<div className="space-y-2 rounded-lg border border-[var(--error)]/40 p-2.5" role="alertdialog" aria-label="Confirm restoration">
									<p className="text-[11px] text-[var(--text-secondary)]">
										Restore {confirmScopePaths.length ? confirmScopePaths.join(', ') : 'the selected paths'}
										{confirmScopeExtra > 0 && ` (and ${confirmScopeExtra} more)`} to checkpoint #{detail.id}?
										Current versions are saved as a pre-restore point first, but review the preview above — restores overwrite files.
									</p>
									<p className="text-[11px] text-[var(--text-muted)] tabular-nums">
										Overwrite conflicts: {force ? 'on' : 'off'} · Risky content authorized: {riskyConfirmed ? 'yes' : safetyInfo == null ? 'not needed' : 'no'}
									</p>
									{safetyInfo && !confirmRiskyReady && (
										<p className="text-[11px] font-medium text-amber-500">
											Check the authorization box in the preview above first.
										</p>
									)}
									{safetyInfo?.needsForce && !force && (
										<p className="text-[11px] font-medium text-amber-500">
											This refused restore also needs the overwrite checkbox above.
										</p>
									)}
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => setConfirming(false)}
											disabled={busy}
											className="cursor-pointer rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-medium disabled:opacity-40"
										>
											Cancel
										</button>
										<button
											type="button"
											onClick={runRestore}
											disabled={confirmBlocked}
											className="cursor-pointer rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
										>
											{busy ? 'Restoring…' : 'Confirm restore'}
										</button>
									</div>
								</div>
							)}
						</section>
					)}
				</div>
			</div>
		</dialog>
	);
}

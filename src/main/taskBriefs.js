"use strict";

// Workspace task briefs: verbatim, durable records of task requirements.
//
// A brief row is a copy of a Workspace user message's text plus an attachment
// snapshot, stored independently of the source message row and of the rolling
// conversation summary. Rows are append-only: edits insert a `revision` row
// that supersedes (never overwrites) the prior row. Applicability is derived
// from the session's active message path, so branch/edit/delete semantics
// follow the existing session-history model without extra bookkeeping.
//
// Only Workspace sessions (sessions.project_id IS NOT NULL) capture or inject
// briefs. Casual Chat neither writes nor reads this table.
//
// This module intentionally avoids requiring sessionManager/promptBuilder at
// the top level (both depend on it indirectly). The active-path walk below
// mirrors sessionManager.activePath for IDs only.

const fs = require("node:fs");
const { db } = require("./db");
const { attachmentName } = require("./fileUploads");

const SECTION_MARKER = "[WORKSPACE TASK BRIEF]";
const BACK_REFERENCE = /\b(earlier|previous|same requirements|remaining|you (?:listed|suggested)|those tests|last change|continue)\b/i;
const SECTION_END = "[END OF WORKSPACE TASK BRIEF]";
const KINDS = Object.freeze(["original", "instruction", "revision"]);

// Directives must occupy the leading lines of the user's message, outside
// quoted/fenced examples. Ordinary prose and embedded examples do not classify.
function lifecycleDirectives(content) {
  const directives = [];
  for (const line of String(content).split(/\r?\n/)) {
    const match = /^\[workspace-brief #(\d+) state=(active|persistent|completed|superseded)\]$/.exec(line);
    if (!match) break;
    directives.push({ briefId: Number(match[1]), state: match[2] });
  }
  return directives;
}

function requireSessionId(sessionId) {
	if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.includes("\0")) {
		throw new TypeError("sessionId must be a non-empty string without null characters.");
	}
}

function isWorkspaceSession(sessionId) {
	requireSessionId(sessionId);
	const row = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId);
	return !!row && row.project_id != null;
}

// IDs on the visible branch only (leaf -> root). Mirrors
// sessionManager.activePath but returns IDs to avoid a require cycle.
function activeMessageIds(sessionId) {
	requireSessionId(sessionId);
	const leaf = db
		.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?")
		.get(sessionId)?.active_leaf_id;
	const ids = new Set();
	const seen = new Set();
	let id = leaf;
	while (id != null) {
		if (seen.has(id)) throw new Error("Message branch contains a cycle.");
		seen.add(id);
		const row = db
			.prepare("SELECT id, parent_id FROM messages WHERE id = ? AND session_id = ?")
			.get(id, sessionId);
		if (!row) throw new Error("Message branch is incomplete.");
		ids.add(row.id);
		id = row.parent_id;
	}
	return ids;
}

function parseAttachmentsJson(value) {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function snapshotBriefAttachments(files) {
	if (!files || !files.length) return [];
	return files.map(({ file_path, mime_type }) => {
		let size = null;
		try {
			size = fs.statSync(file_path).size;
		} catch {
			size = null;
		}
		return { file_path, mime_type, file_name: attachmentName(file_path), size };
	});
}

function attachmentsForMessage(messageId) {
	const rows = db
		.prepare("SELECT file_path, mime_type FROM message_attachments WHERE message_id = ? ORDER BY id")
		.all(messageId);
	return snapshotBriefAttachments(rows);
}

function insertBrief({ sessionId, messageId, kind, contentText, attachments, supersedesId }) {
	if (!KINDS.includes(kind)) throw new TypeError("Invalid brief kind.");
	if (
		typeof contentText !== "string" ||
		(!contentText.trim() && (!attachments || !attachments.length)) ||
		contentText.includes("\0")
	) {
		throw new TypeError(
			"Brief content must be non-empty text without null characters (or accompany attachments).",
		);
	}
	const result = db
		.prepare(
			`INSERT INTO workspace_task_briefs
    (session_id, message_id, kind, content_text, attachments_json, supersedes_id)
    VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			sessionId,
			messageId,
			kind,
			contentText,
			JSON.stringify(attachments ?? []),
			supersedesId ?? null,
		);
	return Number(result.lastInsertRowid);
}

// Capture for a newly saved user message. Must run inside the caller's
// transaction so message + brief commit atomically. Returns the brief id, or
// null for non-Workspace sessions (including missing session rows).
function captureBriefForUserMessage(sessionId, messageId, content, files) {
	requireSessionId(sessionId);
	if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TypeError("Invalid messageId.");
	if (!isWorkspaceSession(sessionId)) return null;
	const existing = db
		.prepare("SELECT COUNT(*) AS n FROM workspace_task_briefs WHERE session_id = ?")
		.get(sessionId).n;
	const briefId = insertBrief({
		sessionId,
		messageId,
		kind: existing === 0 ? "original" : "instruction",
		contentText: content,
		attachments: snapshotBriefAttachments(files),
		supersedesId: null,
	});
  // Explicit user-authored lifecycle directives only; no natural-language or
  // LLM inference of completion. Originals remain immutable.
  for (const directive of lifecycleDirectives(content))
    recordLifecycle(sessionId, directive.briefId, { state: directive.state, sourceMessageId: messageId });
  return briefId;
}

// Capture for an edit (db.branchUserMessage). The prior row is retained; the
// new row supersedes the brief anchored to the edited message, when one
// exists. Runs inside the caller's transaction.
function captureRevisionBrief(sessionId, newMessageId, newContent, supersedesMessageId) {
	requireSessionId(sessionId);
	if (!Number.isSafeInteger(newMessageId) || newMessageId <= 0)
		throw new TypeError("Invalid newMessageId.");
	if (!isWorkspaceSession(sessionId)) return null;
	const prior =
		Number.isSafeInteger(supersedesMessageId) && supersedesMessageId > 0
			? db
					.prepare(
						`SELECT id FROM workspace_task_briefs
        WHERE session_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1`,
					)
					.get(sessionId, supersedesMessageId)
			: null;
	return insertBrief({
		sessionId,
		messageId: newMessageId,
		kind: "revision",
		contentText: newContent,
		attachments: attachmentsForMessage(newMessageId),
		supersedesId: prior ? prior.id : null,
	});
}

// Copy only briefs anchored to the branch's ancestor messages. Later
// instructions from beyond the branch point are never copied. Remaps both
// message_id and supersedes_id through the caller's old->new maps. Runs
// inside the caller's transaction.
function copyBriefsForBranch(
	newSessionId,
	sourceSessionId,
	ancestorMessageIds,
	messageIdMap,
	briefIdMap = new Map(),
) {
	requireSessionId(newSessionId);
	requireSessionId(sourceSessionId);
	if (!(ancestorMessageIds instanceof Set)) throw new TypeError("ancestorMessageIds must be a Set.");
	const rows = db
		.prepare(`SELECT * FROM workspace_task_briefs WHERE session_id = ? ORDER BY id ASC`)
		.all(sourceSessionId);
	let copied = 0;
	for (const row of rows) {
		if (row.message_id == null || !ancestorMessageIds.has(row.message_id)) continue;
		const newMessageId = messageIdMap.get(row.message_id);
		if (!Number.isSafeInteger(newMessageId)) continue;
		const newSupersedesId =
			row.supersedes_id == null ? null : (briefIdMap.get(row.supersedes_id) ?? null);
		const result = db
			.prepare(
				`INSERT INTO workspace_task_briefs
      (session_id, message_id, kind, content_text, attachments_json, supersedes_id)
      VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				newSessionId,
				newMessageId,
				row.kind,
				row.content_text,
				row.attachments_json,
				newSupersedesId,
			);
		briefIdMap.set(row.id, Number(result.lastInsertRowid));
		copied++;
	}
	return copied;
}

function rowToBrief(row) {
	return { ...row, attachments: parseAttachmentsJson(row.attachments_json) };
}

function getAllBriefs(sessionId) {
	requireSessionId(sessionId);
	return db
		.prepare(`SELECT * FROM workspace_task_briefs WHERE session_id = ? ORDER BY id ASC`)
		.all(sessionId)
		.map(rowToBrief);
}

// Applicable briefs: rows whose anchor message is on the session's current
// active path. Rows whose anchor was deleted (message_id NULL) or lives on a
// different branch are retained for inspection but excluded from prompts.
function getApplicableBriefs(sessionId) {
	requireSessionId(sessionId);
	if (!isWorkspaceSession(sessionId)) return [];
	let active;
	try {
		active = activeMessageIds(sessionId);
	} catch {
		return [];
	}
	return db
		.prepare(`SELECT * FROM workspace_task_briefs WHERE session_id = ? ORDER BY id ASC`)
		.all(sessionId)
		.filter((row) => row.message_id != null && active.has(row.message_id))
		.map(rowToBrief);
}

function getBriefsForMessageIds(sessionId, messageIds) {
	requireSessionId(sessionId);
	if (!isWorkspaceSession(sessionId)) return [];
	const wanted = messageIds instanceof Set ? messageIds : new Set(messageIds ?? []);
	return db
		.prepare(`SELECT * FROM workspace_task_briefs WHERE session_id = ? ORDER BY id ASC`)
		.all(sessionId)
		.filter((row) => row.message_id != null && wanted.has(row.message_id))
		.map(rowToBrief);
}

// Only trusted host callers may record explicit user lifecycle decisions. There
// is intentionally no model tool for declaring a requirement completed/revoked.
function recordLifecycle(sessionId, briefId, { state, sourceMessageId, dependencies = [] }) {
  require('./sessionDeletion').assertAvailable(sessionId);
  const applicable = getApplicableBriefs(sessionId);
  if (!applicable.some(b => b.id === briefId) ||
      !['active', 'persistent', 'completed', 'superseded'].includes(state) ||
      !Array.isArray(dependencies) || dependencies.some(id => !applicable.some(b => b.id === id)))
    throw new Error('Invalid brief lifecycle reference.');
  const source = db.prepare("SELECT role, content FROM messages WHERE session_id = ? AND id = ?").get(sessionId, sourceMessageId);
  if (source?.role !== 'user' || !lifecycleDirectives(source.content).some(d => d.briefId === briefId && d.state === state) || !activeMessageIds(sessionId).has(sourceMessageId))
    throw new Error('Lifecycle facts require an on-branch user source.');
  db.prepare(`INSERT INTO workspace_brief_lifecycle VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(brief_id) DO UPDATE SET state=excluded.state,
    source_message_id=excluded.source_message_id, dependencies_json=excluded.dependencies_json`)
    .run(briefId, sessionId, state, sourceMessageId, JSON.stringify(dependencies));
}

// Coverage permits replacing old requests with validated working state; it is
// not a lifecycle decision or permission grant. Verify content and branch bindings.
function coveredBriefMessages(sessionId, projection = null) {
  const checkpoint = projection?.checkpoint ?? require('./taskCheckpoints').getLatestCheckpoint(sessionId)?.checkpoint;
  if (checkpoint?.lifecycle !== 'w3-current' || checkpoint.version !== 2) return new Set();
  const path = activeMessageIds(sessionId), covered = new Set(), seen = new Set();
  const crypto = require('node:crypto');
  for (const ref of checkpoint.sourceCoverage ?? []) {
    if (!Number.isSafeInteger(ref.messageId) || seen.has(ref.messageId)) return new Set();
    seen.add(ref.messageId);
    const m = db.prepare('SELECT * FROM messages WHERE session_id = ? AND id = ?').get(sessionId, ref.messageId);
    const digest = m && crypto.createHash('sha256').update(JSON.stringify([m.id, m.role, m.content, m.execution_steps])).digest('hex');
    if (!m || !path.has(m.id) || digest !== ref.digest) return new Set();
    if (m.archived || projection?.archiveIds?.includes(m.id)) covered.add(m.id);
  }
  const taskReferences = new Map((checkpoint.taskReferences ?? []).map(ref => [ref.briefId, ref]));
  for (const brief of getApplicableBriefs(sessionId)) {
    if (!covered.has(brief.message_id)) continue;
    const ref = taskReferences.get(brief.id);
    const digest = crypto.createHash('sha256').update(JSON.stringify([brief.content_text, brief.attachments_json])).digest('hex');
    if (!ref || ref.messageId !== brief.message_id || ref.digest !== digest) covered.delete(brief.message_id);
  }
  return covered;
}

// Deterministic extraction keeps explicit restrictions independently of model
// summaries. A whole sentence/line is preserved, never an LLM paraphrase.
function constraintText(text) {
  let requirementSection = false;
  return String(text).split(/(?<=[.!?])\s+|\n/).filter(line => {
    if (/^\s*(?:#+\s*)?(?:persistent\s+)?(?:requirements|constraints|rules|polic(?:y|ies)|restrictions)\s*:?\s*$/i.test(line)) requirementSection = true;
    else if (/^\s*#+\s/.test(line)) requirementSection = false;
    return requirementSection || /\b(do not|don't|never|must|preserve|always|constraint|required|only|without|keep|ensure|use|avoid|prefer|retain|should|no|every|whenever|throughout|standing)\b/i.test(line);
  }).join('\n');
}

function selectModelBriefs(sessionId, candidates = getApplicableBriefs(sessionId), projection = null) {
  if (!candidates.length) return [];
  const path = activeMessageIds(sessionId);
  const facts = new Map(db.prepare('SELECT * FROM workspace_brief_lifecycle WHERE session_id = ?').all(sessionId)
    .filter(f => path.has(f.source_message_id) && candidates.some(b => b.message_id === f.source_message_id)).map(f => [f.brief_id, f]));
  const selected = new Set();
  const covered = coveredBriefMessages(sessionId, projection);
  const latest = candidates.at(-1);
  // Uncovered legacy instructions remain protected. Coverage is representation,
  // never a guessed lifecycle transition.
  for (const b of candidates) {
    const state = facts.get(b.id)?.state;
    // Completion is not revocation of a potentially persistent constraint.
    const uncertainConstraint = state === 'completed' && /\b(do not|don't|never|must|preserve|always|constraint|required)\b/i.test(b.content_text);
    if ((!state && !covered.has(b.message_id)) || ['active', 'persistent'].includes(state) || uncertainConstraint ||
        (state !== 'superseded' && (constraintText(b.content_text) || b.attachments?.length))) selected.add(b.id);
  }
  if (latest) selected.add(latest.id);
  const requiredDependencies = new Set();
  const visit = id => {
    const fact = facts.get(id);
    for (const dep of JSON.parse(fact?.dependencies_json ?? '[]')) {
      requiredDependencies.add(dep);
      if (!candidates.some(b => b.id === dep)) throw new Error('Missing brief dependency source.');
      if (!selected.has(dep)) { selected.add(dep); visit(dep); }
    }
  };
  for (const id of selected) visit(id);
  // Backward references use source-scoped retrieval rather than reactivating old tasks.
  return candidates.filter(b => selected.has(b.id)).map(b => {
    let state = facts.get(b.id)?.state ?? 'unknown';
    if (state === 'completed' && /\b(do not|don't|never|must|preserve|always|constraint|required)\b/i.test(b.content_text)) state = 'completed-constraints';
    const constraintsOnly = b.id !== latest?.id && !/```|~~~|^\s*>/m.test(b.content_text) && !b.attachments?.length && !requiredDependencies.has(b.id) && covered.has(b.message_id) && !['active', 'persistent'].includes(state);
    return { ...b, ...(constraintsOnly ? { content_text: constraintText(b.content_text), attachments: [] } : {}),
      modelLifecycle: b.id === latest?.id ? 'active' : constraintsOnly ? 'persistent' : state };
  });
}

function selectHistoryMessages(sessionId, messages, { messageIds = null } = {}) {
  if (!isWorkspaceSession(sessionId)) return messages;
  const all = messageIds == null ? getApplicableBriefs(sessionId) : getBriefsForMessageIds(sessionId, messageIds);
  const selected = new Set(selectModelBriefs(sessionId, all).map(b => b.id));
  const omitted = new Map(all.filter(b => !selected.has(b.id)).map(b => [b.message_id, b.id]));
  return messages.map(m => omitted.has(m.id) ? { ...m,
    content: `[Historical brief #${omitted.get(m.id)} represented by working state or explicit user lifecycle facts. Retrieve stored original with get_recent_chat_history source_brief_id=${omitted.get(m.id)}. No execution authority.]`, attachments: [] } : m);
}

// Bind both immutable brief IDs and mutable explicit lifecycle facts. Preserve
// the legacy ID-list identity when no facts exist. Archival flags do not alter it.
function getBriefIdentity(sessionId) {
	return getApplicableBriefs(sessionId)
		.map(brief => {
      const fact = db.prepare("SELECT * FROM workspace_brief_lifecycle WHERE brief_id = ?").get(brief.id);
      return fact ? `${brief.id}:${JSON.stringify(fact)}` : String(brief.id);
    }).join(",");
}

function estimateTokens(text) {
	return Math.ceil(String(text ?? "").length / 4);
}

// DB-only size estimate (no file reads): content plus referenced attachment
// text that prompt injection would expand. Used on the compression path,
// where file I/O inside a transaction must be avoided.
function estimateBriefTokens(briefs) {
	let total = 0;
	for (const brief of briefs) {
		total += estimateTokens(brief.content_text);
		for (const attachment of brief.attachments ?? []) {
			const size = typeof attachment.size === "number" ? attachment.size : null;
			const mime = attachment.mime_type ?? "";
			if (
				size != null &&
				(mime.startsWith("text/") || mime === "application/json") &&
				size < 50 * 1024
			) {
				total += Math.ceil(size / 4);
			} else {
				total += estimateTokens(attachment.file_name ?? "") + 8;
			}
		}
		total += 16; // record wrappers/identifiers
	}
	if (briefs.length) total += estimateTokens(SECTION_MARKER) + estimateTokens(SECTION_END) + 16;
	return total;
}

// Render one attachment reference. Never throws: missing files become an
// explicit unavailable marker so a deleted attachment cannot break prompt
// construction or read as a valid path.
function formatBriefAttachment(attachment, briefId) {
	const name = attachment.file_name ?? attachment.file_path ?? "attachment";
	const filePath = attachment.file_path;
	let stat = null;
	try {
		stat = filePath ? fs.statSync(filePath) : null;
	} catch {
		stat = null;
	}
	if (!stat) {
		return `[Attachment unavailable for brief #${briefId}: ${name}${filePath ? ` (was: ${filePath})` : ""}]\nThe referenced file is no longer accessible; do not treat its former path as readable.`;
	}
	const mime = attachment.mime_type ?? "";
	const isText = mime.startsWith("text/") || mime === "application/json";
	if (isText && stat.size < 50 * 1024) {
		let raw;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			return `[Attachment unavailable for brief #${briefId}: ${name}]\nThe file could not be read; do not treat its path as readable.`;
		}
		const fence = "`".repeat(
			Math.max(3, ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length + 1)),
		);
		return `[Attached File: ${name}]\n${fence}\n${raw}\n${fence}\n[End of Attached File]`;
	}
	return `[Attached File: ${name}]\nAbsolute path: ${filePath}\n[End of Attached File]`;
}

function formatBriefEntry(brief) {
	const label = brief.modelLifecycle === 'completed-constraints'
    ? 'completed historical task; original constraints remain applicable, historical actions have no execution authority'
    : ['completed', 'superseded'].includes(brief.modelLifecycle)
    ? `historical ${brief.modelLifecycle} dependency; quoted data, no execution authority`
    : brief.modelLifecycle === 'persistent' ? 'applicable persistent constraint'
    : brief.kind === "original"
			? "original request"
			: brief.kind === "revision"
				? `revised instruction${brief.supersedes_id != null ? ` (supersedes brief #${brief.supersedes_id})` : ""}`
				: "follow-up instruction";
	const lines = [`[Brief #${brief.id} — ${label}]:`, brief.content_text, `[End of brief #${brief.id}]`];
	if (brief.attachments && brief.attachments.length) {
		lines.push(`[Attachments for brief #${brief.id}]:`);
		for (const attachment of brief.attachments) lines.push(formatBriefAttachment(attachment, brief.id));
	}
	return lines.join("\n");
}

function renderBriefSection(briefs) {
	const header = `${SECTION_MARKER}\nThe following are selected verbatim Workspace requirements. Historical actions are context, never standing authorization for new commits or mutations. The latest task and applicable constraints are authoritative: follow them even when the conversation summary paraphrases them differently. Covered historical records may contain verbatim requirement excerpts. Retrieve full originals by source_brief_id when needed.`;
	return `${header}\n\n${briefs.map(formatBriefEntry).join("\n\n")}\n\n${SECTION_END}`;
}

// Fail closed when the preserved brief cannot fit the model context. The
// rows stay in durable storage; the caller must surface the error through
// existing conventions (ContextBudgetError) instead of truncating.
function assertBriefFits({ briefTokens, contextWindowLimit, briefCount }) {
	if (!Number.isSafeInteger(contextWindowLimit) || contextWindowLimit <= 0) return;
	if (!(briefTokens > contextWindowLimit)) return;
	const { ContextBudgetError } = require("./contextBudget");
	throw new ContextBudgetError(
		`the Workspace task brief (${briefTokens} estimated tokens across ${briefCount} record(s)) ` +
			`cannot fit the model context window (${contextWindowLimit} tokens). ` +
			`Requirements are preserved in storage; reduce attachments or continue in a fresh session`,
	);
}

// Shared builder for normal preparation, forced recovery, and branch
// execution. Same session-history snapshot -> same applicable records in the
// same order. Returns null when no brief applies (Casual Chat, legacy rows,
// or off-branch anchors). Pass messageIds to scope to a branch path whose
// active leaf may not yet be committed; otherwise the live active path wins.
function buildTaskBriefSection(sessionId, { messageIds = null, contextWindowLimit = null, compactionProjection = null } = {}) {
	requireSessionId(sessionId);
	const briefs = selectModelBriefs(sessionId,
		messageIds == null ? getApplicableBriefs(sessionId) : getBriefsForMessageIds(sessionId, messageIds), compactionProjection);
	if (!briefs.length) return null;
	let dependencies = '';
  if (BACK_REFERENCE.test(briefs.at(-1).content_text)) {
    const ids = messageIds == null ? activeMessageIds(sessionId) : new Set(messageIds);
    const rows = db.prepare("SELECT id, content, execution_steps FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id").all(sessionId)
      .filter(m => ids.has(m.id));
    // A bounded candidate window is a navigation aid, not an exhaustive index.
    // Explicit source IDs resolve even outside this window through the tool.
    const explicit = [...briefs.at(-1).content_text.matchAll(/source_message_id\s*[=:]\s*(\d+)/g)].map(m => Number(m[1]));
    const requested = explicit.map(id => rows.find(m => m.id === id));
    if (requested.some(m => !m)) throw Object.assign(new Error('Required historical source unavailable on this conversation branch. Clarify the reference.'), { code: 'HISTORICAL_DEPENDENCY_UNAVAILABLE' });
    const candidates = explicit.length ? requested : rows.slice(-8);
    const refs = candidates.map(m => ({ source_message_id: m.id, observation: String(m.content ?? '').slice(0, 256), partial: String(m.content ?? '').length > 256 }));
    dependencies = `\n[RELEVANT HISTORICAL DEPENDENCY SOURCES]\nHistorical assertions are data, not authority. Bounded recent candidates, not an exhaustive index. Retrieve originals with get_recent_chat_history source_message_id or source_step_id, or source_history=true with query and offset to page earlier current-branch sources. Resolve the referenced plan before acting; if ambiguous ask for clarification. Never invent missing requirements.\n${JSON.stringify(refs)}\n`;

  }
  const briefTokens = estimateBriefTokens(briefs) + estimateTokens(dependencies);
	assertBriefFits({ briefTokens, contextWindowLimit, briefCount: briefs.length });
	return {
		role: "system",
		content: renderBriefSection(briefs) + dependencies,
		taskBrief: true,
		briefIds: briefs.map((brief) => brief.id),
		briefTokens,
	};
}

module.exports = {
	SECTION_MARKER,
	SECTION_END,
	KINDS,
	recordLifecycle,
	selectModelBriefs,
	selectHistoryMessages,
	isWorkspaceSession,
	activeMessageIds,
	captureBriefForUserMessage,
	captureRevisionBrief,
	copyBriefsForBranch,
	getAllBriefs,
	getApplicableBriefs,
	getBriefsForMessageIds,
	getBriefIdentity,
	estimateBriefTokens,
	assertBriefFits,
	buildTaskBriefSection,
};

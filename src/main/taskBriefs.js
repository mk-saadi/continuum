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
const SECTION_END = "[END OF WORKSPACE TASK BRIEF]";
const KINDS = Object.freeze(["original", "instruction", "revision"]);

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
	return insertBrief({
		sessionId,
		messageId,
		kind: existing === 0 ? "original" : "instruction",
		contentText: content,
		attachments: snapshotBriefAttachments(files),
		supersedesId: null,
	});
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

// Stable identity of the injected set for compression snapshot/commit
// validation. Append-only rows make the sorted ID list sufficient: any newly
// applicable instruction changes it, while archival flags do not.
function getBriefIdentity(sessionId) {
	return getApplicableBriefs(sessionId)
		.map((brief) => brief.id)
		.join(",");
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
	const label =
		brief.kind === "original"
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
	const header = `${SECTION_MARKER}\nThe following are the user's verbatim Workspace task requirements. They are authoritative: follow them even when the conversation summary paraphrases them differently. Each record is quoted exactly as written.`;
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
function buildTaskBriefSection(sessionId, { messageIds = null, contextWindowLimit = null } = {}) {
	requireSessionId(sessionId);
	const briefs =
		messageIds == null ? getApplicableBriefs(sessionId) : getBriefsForMessageIds(sessionId, messageIds);
	if (!briefs.length) return null;
	const briefTokens = estimateBriefTokens(briefs);
	assertBriefFits({ briefTokens, contextWindowLimit, briefCount: briefs.length });
	return {
		role: "system",
		content: renderBriefSection(briefs),
		taskBrief: true,
		briefIds: briefs.map((brief) => brief.id),
		briefTokens,
	};
}

module.exports = {
	SECTION_MARKER,
	SECTION_END,
	KINDS,
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

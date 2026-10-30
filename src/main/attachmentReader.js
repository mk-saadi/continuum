'use strict';
// Session-owned read capability, independent of workspace mutation permissions.
// References identify persisted user attachments, never caller-supplied paths.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { validateAttachments, attachmentName, MAX_FILE_BYTES } = require('./fileUploads');
const fail = (code, message) => Object.assign(new Error(message), { code });
function reference(row) {
  const { db } = require('./db');
  db.prepare('INSERT OR IGNORE INTO attachment_read_refs(attachment_id, reference) VALUES (?, ?)')
    .run(row.id, `att_${randomBytes(16).toString('hex')}`);
  return db.prepare('SELECT reference FROM attachment_read_refs WHERE attachment_id = ?').get(row.id).reference;
}
function rowForFile(filePath, messageId) {
  if (!require('./db').isInitialized()) return null;
  // Model context builders have an authoritative message ID. Never infer a
  // grant merely from the presence of a file in managed storage.
  if (!Number.isInteger(messageId)) return null;
  return require('./db').db.prepare('SELECT * FROM message_attachments WHERE message_id = ? AND file_path = ? ORDER BY id LIMIT 1').get(messageId, filePath);
}
function describe(file, messageId) {
  const row = rowForFile(file.file_path, messageId);
  const metadata = { name: attachmentName(file.file_path), media_type: file.mime_type };
  if (!row) return { ...metadata, access: 'No persisted attachment reference is available.' };
  return { ...metadata, attachment_id: reference(row), tool: 'read_project_file', argument: 'attachment_id' };
}
function owner(sessionId, context) {
  if (sessionId) return sessionId;
  const contexts = require('./lspExecutionContext');
  if (!contexts.isTrusted(context) || !context.childSessionId) throw fail('ATTACHMENT_UNAUTHORIZED', 'Attachment access requires an authorized conversation.');
  const child = require('./subagents/sessionManager').getSession(context.childSessionId);
  if (!child || contexts.childContext(child) !== context || child.parentSessionId !== context.sessionId || child.status === 'cancelled')
    throw fail('ATTACHMENT_UNAUTHORIZED', 'Delegated attachment access is no longer valid.');
  return context.sessionId;
}
function resolve(attachmentId, sessionId, context) {
  if (typeof attachmentId !== 'string' || !/^att_[a-f0-9]{32}$/.test(attachmentId))
    throw fail('ATTACHMENT_INVALID_REFERENCE', 'Use the exact attachment_id supplied with the user attachment; filesystem paths are not attachment references.');
  const authorizedSession = owner(sessionId, context);
  require('./sessionDeletion').assertAvailable(authorizedSession);
  const row = require('./db').db.prepare(`SELECT a.* FROM attachment_read_refs r
    JOIN message_attachments a ON a.id = r.attachment_id
    JOIN messages m ON m.id = a.message_id JOIN sessions s ON s.id = m.session_id
    WHERE r.reference = ? AND m.session_id = ? AND m.role = 'user'`).get(attachmentId, authorizedSession);
  if (!row)
    throw fail('ATTACHMENT_UNAVAILABLE', 'Attachment is not attached to this conversation, or its reference has been revoked.');
  try { validateAttachments([row]); }
  catch { throw fail('ATTACHMENT_UNAVAILABLE', 'Attachment is missing, unsupported, oversized, or no longer a valid managed file.'); }
  return row;
}
function read({ attachment_id, start_line, end_line, ...other }, sessionId, context, mediaPolicy) {
  if (Object.keys(other).some(key => other[key] !== undefined)) throw fail('ATTACHMENT_INVALID_REQUEST', 'Attachment reads accept attachment_id and optional text line bounds only; omit paths and revision arguments.');
  const row = resolve(attachment_id, sessionId, context);
  let fd;
  try {
    // O_NOFOLLOW and the managed-directory check prevent a replaced symlink
    // from turning a valid reference into an arbitrary filesystem read.
    fd = fs.openSync(row.file_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail('ATTACHMENT_LIMIT', 'Attachment must be a regular file of at most 20 MB.');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fs.fstatSync(fd);
    if (offset !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw fail('ATTACHMENT_CHANGED', 'Attachment changed during inspection; retry using the current attachment reference.');
    resolve(attachment_id, sessionId, context);
    const base = { success: true, attachment_id, name: attachmentName(row.file_path), media_type: row.mime_type, size_bytes: bytes.length, access: 'read-only user attachment' };
    const document = require('./attachmentDocuments').extractedDocumentText(row.file_path);
    if (row.mime_type.startsWith('text/') || row.mime_type === 'application/json' || document !== null) {
      let text = document;
      if (text === null) {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw fail('ATTACHMENT_UNSUPPORTED_CONTENT', 'This attachment is not valid UTF-8 text; no compatible text decoder is available.'); }
      }
      if (text.includes('\0')) throw fail('ATTACHMENT_UNSUPPORTED_CONTENT', 'Binary content cannot be interpreted as text.');
      const start = start_line ?? 1, end = end_line ?? start + 199;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 400)
        throw fail('INVALID_LINE_RANGE', 'Use inclusive positive text line bounds spanning at most 400 lines.');
      const lines = text.split('\n');
      const selected = lines.slice(start - 1, end).join('\n');
      return { ...base, inspection: document === null ? 'text' : 'extracted-document-text', content: selected.slice(0, 20000), start_line: start,
        end_line: Math.min(end, lines.length), total_lines: lines.length, has_more: end < lines.length,
        content_truncated: selected.length > 20000, ...(end < lines.length ? { next_start_line: end + 1 } : {}) };
    }
    if (start_line !== undefined || end_line !== undefined) throw fail('LINE_RANGE_UNSUPPORTED', 'Line bounds apply only to attachment text.');
    if (['image/png', 'image/jpeg', 'image/webp'].includes(row.mime_type) && !context?.childSessionId && mediaPolicy?.enabled?.image !== false) return { ...base, inspection: 'image',
      note: 'Image supplied to the existing tool-vision pathway. Interpretation requires a compatible vision model; retrieving bytes alone does not establish visual understanding.',
      image: { type: 'image_url', image_url: { url: `data:${row.mime_type};base64,${bytes.toString('base64')}` } } };
    const kind = row.mime_type.split('/')[0];
    return { ...base, inspection: 'metadata', capability_code: 'ATTACHMENT_CONTENT_CAPABILITY_UNAVAILABLE',
      note: ['audio', 'video'].includes(kind)
        ? `Full ${kind} interpretation requires the compatible model/provider pathway carrying the original user attachment. This reader provides file metadata only; no decoder or frame extraction is installed by this operation.`
        : row.mime_type === 'image/gif' ? 'GIF is not supported by the existing tool-image validator; original attachment preserved. No pixel or animation interpretation was performed.'
        : row.mime_type.startsWith('image/') && mediaPolicy?.enabled?.image === false ? 'Image interpretation is unsupported or unverified for the selected model. File metadata is available; use a compatible vision model to inspect pixels.'
        : 'No compatible content reader is available in this tool context. Image interpretation requires a vision model; PDF/XLSX require successfully extracted text.' };
  } catch (error) {
    if (error.code?.startsWith('ATTACHMENT') || ['INVALID_LINE_RANGE', 'LINE_RANGE_UNSUPPORTED'].includes(error.code)) throw error;
    throw fail('ATTACHMENT_UNREADABLE', 'Attachment could not be decoded or safely read. The original file was not modified.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { reference, describe, resolve, read };

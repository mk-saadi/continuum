// Casual-chat presentation for a failed assistant-reply save.
//
// When history compression holds the write lock, the backend rejects the
// save with a "being summarized" error. In casual chats that must not
// surface as a full-width error section: the user's prompt was already
// persisted, so only a short inline note is shown (and nothing at all when
// there was no user prompt in flight). Workspace chats keep the existing
// loud error path; unknown shapes fail closed to no notice.
const SUMMARIZING_RE = /being summarized/i;

export function isSummarizingError(error) {
  return SUMMARIZING_RE.test(error?.message ?? "");
}

export function summarizeNoticeFor({ message, isWorkspaceChat }) {
  if (isWorkspaceChat) return null;
  if (typeof message !== "string" || !message) return null;
  if (!SUMMARIZING_RE.test(message)) return null;
  return "Chat is being summarized — your message was kept. Wait a moment, then send again.";
}

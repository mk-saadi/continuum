# Chat history wiring

Startup checks `PRAGMA table_info(sessions)` and runs this migration only if the column is missing:

```sql
ALTER TABLE sessions ADD COLUMN folder_name TEXT NOT NULL DEFAULT 'Uncategorized';
SELECT * FROM sessions ORDER BY last_active_at DESC, id DESC;
UPDATE sessions SET title = ? WHERE id = ?;
UPDATE sessions SET folder_name = ? WHERE id = ?;
SELECT * FROM sessions WHERE id = ?;
SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC;
DELETE FROM sessions WHERE id = ?;
```

The startup migration installs delete triggers for existing databases: deleting a session deletes its messages and summaries; deleting a message deletes its attachment records. Referenced files on disk are not removed.

Editing executes these statements in one immediate transaction, after validating a user message and ensuring compression is not in progress:

```sql
UPDATE messages SET content = ?, estimated_tokens = ? WHERE id = ?;
DELETE FROM messages WHERE session_id = ? AND id > ?;
DELETE FROM session_summaries WHERE session_id = ?;
UPDATE messages SET archived = 0 WHERE session_id = ?;
UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?;
SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC;
```

Message IDs define order even when timestamps are identical. Clearing summaries and restoring retained messages prevents discarded conversation from surviving in compressed context.

The restricted `window.memoryPalace` bridge exposes:

- `getAllSessions()` → `[{ folder_name, sessions }]`, groups ordered by their most recent session, sessions newest first.
- `loadSession(sessionId)` → session fields plus `messages` (including archived messages).
- `renameSession(sessionId, title)` and `moveSession(sessionId, folderName)` → updated session.
- `deleteSession(sessionId)` → `{ deleted: true }`.
- `editMessage(messageId, newContent)` → retained message array, oldest first.

`src/components/ChatHistory.jsx` renders collapsible groups, right-click/ellipsis menus, and inline forms. Enter a new or existing folder name to move a chat. `src/App.jsx` loads history and renders pencil buttons on persisted user messages. Save calls `editMessage`, replaces the visible history, then calls `prepareMessages(text, true)` and streams with `runMemoryChat`. The regeneration flag builds context without inserting a duplicate user message. Replies are saved through `finishMessage`. Regeneration uses the currently selected model and active endpoint. Session changes and history mutations are disabled while a reply is streaming.

Validation:

```sh
npm run build
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/sessionHistory.test.cjs
node --test tests/memoryChat.test.mjs tests/memoryNormalization.test.cjs
```

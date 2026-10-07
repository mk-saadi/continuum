# File attachments

The composer accepts PNG, JPEG, GIF, WebP, TXT, and Markdown. Select multiple files with the paperclip, remove individual previews with ×, and send with or without typed text. The current limits are 10 files per message, 20 MB per file, and 50 MB combined.

## File handling and IPC

`window.api.processUploads(files)` accepts an array of browser `File` objects. The isolated preload uses Electron's `webUtils.getPathForFile` to resolve disk paths, then invokes `file:process-uploads` with an array of absolute paths. The existing trusted-sender check applies to this handler.

The main-process `processUploads` implementation in `src/main/fileUploads.js` copies files into `app.getPath('userData')/attachments` using timestamp + UUID + original filename. It returns:

```js
[{ file_path: '/.../attachments/1720000000000-uuid-photo.png', mime_type: 'image/png' }]
```

MIME types are inferred from the supported file extensions. Files are copied, not moved. A failed copy batch removes copies already made in that batch. The renderer caches completed copies for retries until the selection changes or the message is saved.

## Persistence and prompts

`saveMessage(sessionId, role, content, attachments = [])` inserts the message and all attachment rows in the same immediate SQLite transaction:

```sql
INSERT INTO messages(session_id, role, content, estimated_tokens, archived)
VALUES (?, ?, ?, ?, 0);

INSERT INTO message_attachments(message_id, file_path, mime_type)
VALUES (?, ?, ?);
```

Both `loadSession` and `getActiveMessages` include an `attachments` array on each message. Prompt construction validates that attachment paths refer to managed copies, reads image files as base64, and emits:

```js
{
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
  ],
}
```

TXT/Markdown file contents are appended to the text part with filename delimiters. Text-only turns continue using string content. Regeneration reuses the edited message's existing attachments without inserting another user message. Later attachment rows are removed with the truncated messages by the existing cascade triggers.

The React submission flow in `src/App.jsx` is:

```js
const attachments = await window.api.processUploads(selectedFiles);
const requestMessages = await palace.prepareMessages(text, false, attachments);
// prepareMessages -> session:prepare-messages -> transactional saveMessage
// Then stream requestMessages through the existing runMemoryChat flow.
```

Selected image previews use blob URLs, revoked on removal/unmount. The content security policy allows blob/data images. Loaded messages show their attachment filenames. Image interpretation requires a vision-capable model/server. Existing context-token estimates and idle summaries remain text-message based; uploaded copies are retained on disk when attachment rows are deleted.

## Validation

```sh
npm run build
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/attachments.test.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/sessionHistory.test.cjs
node --test tests/memoryChat.test.mjs tests/memoryNormalization.test.cjs
```

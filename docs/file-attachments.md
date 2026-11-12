# File attachments — Phases 1 and 2

Source implementation and isolated verification: 2026-11-07. No primary user profile was used. No installed package was replaced.

## Storage behavior

- Native disk selection and drag-and-drop default to **Referenced file**. Continuum records identity, MIME/name, source path, canonical path, size, SHA-256 fingerprint, device/inode and modification/change timestamps. It does not create a full managed copy.
- The composer and attachment details display storage behavior. **Keep a copy** creates an original-quality managed snapshot and changes that conversation grant to the managed version. A fork still referencing the original version can explicitly **Use saved copy** if that source later disappears.
- Pathless pasted files stay **Managed copy**, including original encoded image bytes. Supported pathless documents can also be stored as byte envelopes. Plain clipboard text still enters the message normally.
- Managed files live under configured `appDataDirectory/attachments`, normally `<Electron userData>/App_Data/attachments`, with timestamp–UUID names. Removing/omitting an attachment never deletes a referenced original.
- Limits remain 10 files, 20 MiB each and 50 MiB per selection/message. There is no content deduplication, general orphan cleanup or garbage collection. A failed selection rolls back only its own draft records and newly created managed files.

Relevant source: `src/preload.js`, `src/components/main-app/ChatInterface.jsx`, `src/components/chat/AttachmentControls.jsx`, `src/main/attachmentStore.js`, `src/main/fileUploads.js`.

## Authorization and identity

`webUtils.getPathForFile` runs in the isolated preload on the actual Chromium-backed File, before any byte conversion. A JS-created File has no native path. A main-issued, per-webContents bridge capability stays inside that isolated preload; stage IPC requires it and the existing trusted-main-frame sender check. Web content cannot authorize disk reads with a `path`, `nativePath`, MIME label or filename. Relinking paths come exclusively from a main-process native file dialog.

Electron documents this native-backed File distinction: https://www.electronjs.org/docs/latest/api/web-utils . Selection/drop that the OS/Chromium exposes only as a pathless File is deliberately managed, rather than guessing a disk location.

The database separates:

- `attachment_assets`: stable logical attachment identity, independent of storage.
- `attachment_versions`: source version, storage kind, path, fingerprint/identity metadata, extracted text and optional durable-copy location.
- `attachment_drafts`: opaque conversation-scoped selection grants, before message persistence. Starting a project chat reassigns its composer's drafts to the new conversation rather than leaving them bound to the previous one.
- `message_attachments`: existing conversation ownership rows, with additive `asset_id`, `version_id` and `omitted` fields. Existing numeric IDs and opaque `attachment_read_refs` remain valid.

Tool reads still resolve an opaque attachment reference through the owning user message and conversation. Delegated reads still require the trusted parent/child execution context and recheck authorization after asynchronous work. A supplied path or asset/version ID alone is never a tool read grant. Recovery does not alter another conversation's grant; forks share the original asset/version until explicitly changed.

Relevant source: `src/main/attachmentStore.js`, `src/main/attachmentReader.js`, `src/main/tools/agentTools.js`, `src/main/sessionManager.js`, `src/main/db.js`.

## Missing, modified or replaced files

Selection hashing and interactive request preloading use asynchronous file I/O and WebCrypto SHA-256, avoiding a synchronous large-file hash in the interface path. Capture uses a bounded file descriptor read, final-component `O_NOFOLLOW` where supported, canonical-path checks, and before/after descriptor/path identity checks. Symlink sources are rejected with instructions to select their actual target. Replacing the file, changing a symlinked parent, or changing metadata/content requires acknowledgement; identical bytes at a new inode are not silently trusted.

Before constructing a submission, the main process verifies referenced versions and captures request-owned buffers. Prompt construction, PDF/XLSX extraction and RAG consume those exact bytes. Changing a source afterward cannot change that prepared request's media or text. Engine dispatch revalidates and rebuilds versioned attachments from authoritative conversation records rather than trusting an earlier renderer projection. Tool reads verify current sources separately, instead of reusing a model-turn snapshot.

Missing/changed historical attachments produce an actionable blocked-send error and an **Attachments needing attention** panel. Available actions are:

- **Locate file**: native dialog; requires the same recorded fingerprint.
- **Accept changed version**: explicitly approves the current referenced path's bytes as a new version.
- **Choose new version**: native dialog explicitly approves different content/location in the same format.
- **Keep a copy / Use saved copy**: captures verified original bytes or explicitly selects a matching stored snapshot.
- **Omit attachment**: revokes its tool access and adds an explicit omission marker to model context; **Restore attachment** still requires subsequent source verification.

Stop an active run before changing its attachment grants. Recovery invalidates prepared-context measurement caches; automatic compaction policy/mechanics are unchanged.

Interactive builders preload snapshots asynchronously. Internal synchronous builder compatibility remains available and performs the same fingerprint/identity checks; it is not a streaming arbitrarily large-file reader. Active-turn snapshots and previews use memory bounded by the existing per-file/per-message limits; long histories containing many attachments can still consume substantial memory.

## Documents and derived content

New PDF/XLSX extracted text is kept in the source-version record, never beside a referenced original. It retains the existing 100,000-character inline/tool extraction cap. Spreadsheet extraction keeps worksheets, cells and cached formula results. Scanned PDFs still require user-provided OCR; there is no automatic OCR or tiling.

RAG indexes for new attachments use `attachment-version:<version-id>` plus the actual content hash and embedding model, rather than an unversioned mutable source path. Retrieval verifies the selected source version first. PDF RAG parses the immutable captured bytes, retaining its existing full-document indexing behavior. Accepting/relinking creates a new version and extraction/index identity; stale derivatives from old versions are never silently substituted. Old index rows remain for Phase 3 cleanup. XLSX retrieval uses its versioned extracted text.

Relevant source: `src/main/attachmentDocuments.js`, `src/main/ragManager.js`, `src/main/taskBriefs.js`.

## Images and structured media: Phase 1 preserved

Original encoded image bytes are retained; previews never replace them. Static PNG/JPEG keep their resolution and bytes for delivery unless EXIF orientation needs to be applied. Local llama.cpp WebP delivery and EXIF normalization create lossless in-memory PNG derivatives, preserving alpha and spatial resolution. Transformations are identified by an adjacent `Image delivery` text part. No derivative image is persisted. Original metadata is retained in stored originals, and unchanged JPEG submissions can carry original EXIF metadata to the selected backend.

GIF/SVG/AVIF/BMP are not advertised for new image attachments. Animated PNG/WebP and corrupt or mismatched image formats fail clearly. Legacy reduced JPEGs stay readable, but lost resolution cannot be recovered.

The shared sanitizer preserves text/image/audio/video arrays and rejects malformed, unsupported or already-stringified encoded media. Local audio/video retain `input_audio`/`input_video`; cloud OpenAI-compatible adapters preserve audio and map video to `video_url`. Anthropic receives base64 image blocks and rejects audio/video through its existing policy. Capability checks remain provider/model-specific and are rechecked at dispatch. Correct serialization is not proof of interpretation, mixed-media acceptance or codec support. No universal resolution/duration limit is invented; backend rejection feedback explains what to check. Backend-side resizing is still possible.

References for the established transport formats and decoder behavior:

- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api
- https://openrouter.ai/docs/guides/overview/multimodal/videos
- https://openrouter.ai/docs/guides/overview/multimodal/audio
- https://platform.claude.com/docs/en/build-with-claude/vision

Relevant source: `src/main/imageAttachments.js`, `src/lib/mediaContent.mjs`, `src/lib/memoryChat.mjs`, `src/main/modelCapabilities.js`, `src/main/cloudProviders.js`, `src/main/promptBuilder.js`.

## Preview access

Composer/transcript previews and file opening use conversation-owned attachment IDs or opaque draft grants, not arbitrary local paths. Preview bytes are fingerprint-verified, then ownership/version are checked again before returning them. Reference sources and managed attachments cannot bypass these checks through `media:`/legacy `local:` URLs.

The general Markdown/tool-media protocol now allows only known project roots and app-owned generated-media/avatar/background roots, and excludes registered attachment paths, canonical targets and saved copies. Previously embedded arbitrary external local paths need an authorized attachment or an allowed public-media location. This tighter boundary is deliberate; it is separate from general project-file tool permissions.

Relevant source: `src/components/chat/AttachmentPreview.jsx`, `src/main/localMedia.js`.

## Compatibility and migration

Initialization registers existing copies as **managed legacy** versions without reading/moving/deleting originals or inferring original source locations. Existing ownership row IDs, conversations, fork relationships and opaque references are preserved. Legacy fingerprints and versioned extraction are established lazily on the first verified read. Because old records had no fingerprint, changes made before that first baseline cannot be detected or reversed. A missing legacy copy with no baseline requires explicit **Choose new version**, rather than pretending a located replacement was verified as identical.

Task briefs retain their existing snapshots. Asset identity and stored path aliases let old snapshots resolve current authorized grants after relinking or an app-data move. App-data migration relocates managed version/copy paths while preserving aliases; external referenced paths are not guessed or rewritten. Legacy path repair is restricted to legacy managed copies. Conversation/message deletion revokes grants and opaque read references; files/version records are retained for Phase 3. No user original is deleted.

## Verification

All checks use disposable files and isolated `/tmp` profiles. No private attachment or live external provider was used.

- `attachmentReferences.test.cjs`: 12 cases covering native bridge authorization, no-copy references, ownership, changed/replaced/missing/inaccessible sources, native relink, explicit replacement/omission, durable copies and fork fallback, changes during read, immutable request bytes, stale renderer rejection, document/RAG versioning, PDF/XLSX extraction, delegation/revocation, legacy registration/restart, brief aliases, app-data path relocation, failed-batch rollback and mixed-media outgoing local/cloud capture. Access denial is injected deterministically because tests can run as root.
- `attachmentReferences.ui.cjs`: isolated production preload/context bridge and real `ChatInterface`; Chromium native-backed file selection/drop, pathless paste, storage badges, changed-version acceptance, relink, Keep a copy, source deletion, original outgoing PNG capture and historical-source omission. Native file paths come from Chromium's file input; native relink-dialog results use disposable selections injected by the test.
- `attachmentComposer.ui.cjs`: all 15 Phase 1 renderer cases still pass: five image fixtures across selection/drop/paste, browser preview inspection, original storage and outgoing request capture. Dense PNG stays 4096×2048; transparent PNG/WebP stay 37×23 with alpha 64/255; EXIF JPEG stays 40×24 in storage and is delivered as oriented 24×40 PNG; legacy JPEG stays 1024×512.
- Ten focused integration files pass, including Phase 1 delivery, R3 ownership (25 cases), attachment IPC, document extraction, RAG, history/query bounds and data/legacy migration. Ten focused unit files pass for media structure, policy, image validation/quality, model capabilities, context accounting and preview protocol handling.
- The production preload also passes its separate OS-sandbox integration check with `NoNewPrivs=1`, seccomp mode 2 and `--enable-sandbox`, including native file reference, pathless managed JPEG and SQLite reopening.
- Production Vite build passes with its chunk-size warning. Electron/libvips emits non-fatal GLib warnings in this environment. No running llama-server was found; live interpretation/codec/frame-sampling behavior was not tested. No packaged app was installed or launched.

Reproduction:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test tests/attachmentReferences.test.cjs tests/attachmentDelivery.test.cjs tests/attachments.test.cjs tests/r3Reliability.test.cjs tests/sessionHistory.test.cjs tests/sessionHistoryPerf.test.cjs tests/dataMigration.test.cjs tests/legacyDataMigration.test.cjs tests/rag.test.cjs tests/attachmentDocuments.test.cjs
node --test tests/mediaContent.test.mjs tests/imageValidation.test.mjs tests/imageUtils.test.mjs tests/modelCapabilities.test.cjs tests/capabilityOverrides.test.cjs tests/attachmentPolicy.test.mjs tests/toolResultFormatter.test.mjs tests/memoryChat.test.mjs tests/contextBudget.test.cjs tests/mediaProtocol.test.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/attachmentReferences.ui.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/attachmentComposer.ui.cjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron tests/preloadSandbox.integration.cjs
npm run build
```

Chromium tests require process permissions unavailable in the restricted execution sandbox. Their application data and fixtures remain isolated and are removed by the tests.

## Phase 3 — conservative storage cleanup (2026-11-08)

`attachmentCleanup.retained()` is the cleanup ownership authority. Every message
attachment (including omitted grants and fork copies), active draft, durable brief
snapshot, brief asset/path alias and needed version's durable fallback retains its
data. Malformed brief snapshots conservatively retain every version. Canonical
aliases retain data too. Legacy records remain evidence even without a surviving
grant. Existing attachment IDs, opaque read references and brief resolution stay
unchanged; no content deduplication is introduced.

New managed writes record creation receipts with a canonical root, root device/inode,
file identity, byte count and content fingerprint. Partial write failures retain a
receipt when the creation descriptor still matches the pathname. Unregistered files,
legacy extraction sidecars and legacy copies are **not adopted by filename**. Newly created legacy-format sidecars can extend an existing creation receipt; their source ownership retains them. They
remain unresolved, including files left by interruption before a receipt could be
committed. Legacy draft grants without lifecycle classification remain protected.
Versioned extracted text is removed with unused nonlegacy version rows; only exact
`attachment-version:<id>` RAG rows are removed. General document indexes, referenced
originals and generated media are outside physical cleanup authority.

Renderer selection removal, clearing selections, composer unmount and window destruction revoke draft
grants. Persisted messages independently retain submitted data. Classified drafts
from an earlier process expire on database initialization; reopening SQLite during
migration in the same process preserves active drafts. Failed selections attempt a
checked cleanup pass. A 30-second background timer catches released grants after
message/conversation deletion and unused versions. A continuously busy application
can defer reclamation; active work takes priority. No per-file approval is needed.

Attachment preparation, capture, preview, recovery and asynchronous RAG operations
hold process leases. Cleanup pauses during leases and migration. It yields between
files (16 by default, at most 64), then synchronously rechecks all current owners and
file/root identities inside a database transaction immediately before unlinking.
Physical cleanup on Linux uses an opened directory and `/proc/self/fd` to anchor
unlinking, preventing ancestor replacement from redirecting removal. Symlinks,
changed files and changed roots fail closed. Platforms without this safe-unlink
implementation retain files with retryable failure counts; they still prune eligible
versioned database derivatives. This phase has not implemented a corresponding native
safe-unlink adapter for Windows/macOS.

Receipts survive failed removal and application interruption. An absent file on retry
finishes the database step without counting its bytes again. Consequently reclaimed
bytes are a conservative count: a crash between unlink and database commit can
undercount them. Retry order favors fewer attempts to avoid a failing file starving
new work. Failure codes are stored without private paths in user-visible responses.
Database rollback cannot restore an already unlinked file, but only demonstrably
unowned data reaches that step, and its receipt makes the operation resumable.

Verified app-data migration rebinds existing receipts to copied file/root identities
only when their content still matches the creation fingerprint. Unmatched or missing
copies are retained rather than adopted. Old/unresolved copies and legacy sidecars
are intentionally not reclaimed automatically. Asset/path alias metadata is retained
for compatibility. Ownership scans are currently linear in stored references and run
on the main thread; file deletions are batched, but very large databases may require
future indexed/incremental ownership scanning. Checks cannot serialize a malicious
external process replacing a directory entry between the final identity check and
unlink; directory-descriptor anchoring prevents following that entry into an external
original.

The workspace Activity sidebar exposes **Attachment storage** with a cleanup summary;
the same count-only preview is also available in attachment details. Production
preload APIs expose `attachmentCleanupStatus`,
`previewAttachmentCleanup` and `runAttachmentCleanup`. Responses contain reclaimed
bytes, pending file count, retryable failure count, unresolved item count, unused
version count and active operation count; no paths or contents. Preview changes no
files or database rows. Unknown direct children of the configured attachment root
are counted as unresolved, never removed. Pending counts include retained failure
receipts; they are candidate counts, not a promise that every target can be removed.

### Phase 3 verification

All fixture data used disposable temporary profiles; cleanup was never run against
the primary user profile. `attachmentCleanup.test.cjs` covers 13 cases: draft release,
restart classification, count-only preview, derivative removal/idempotence, operation
leases and concurrent grant creation, brief retention, omitted/fork grants, durable
fallbacks, symlink/root replacement, injected filesystem failure and retry, interrupted
unlink recovery, partial-write failure and verified receipt migration. Tests exercise
production storage modules and SQLite. The interruption case simulates the persistent
post-unlink state; it does not kill an application process at every instruction.

`attachmentReferences.ui.cjs` exercises real Chromium selection/drop/paste, source
recovery, attachment details/status, selection removal, dry-run preservation and
production cleanup IPC. `attachmentComposer.ui.cjs` retains all 15 Phase 1 delivery
checks. Focused reference/delivery/IPC/R3/history/migration/RAG/document integration
suites and the existing media/policy/image/capability/context/protocol unit suites
were also run. The production Vite build passes with its existing large-chunk warning;
Electron/libvips emits non-fatal GLib warnings in this environment. Chromium checks
require execution outside the restricted process sandbox and keep isolated profiles.
No packaged application was installed or launched. No external provider interpretation
or cross-platform safe-unlink verification was performed.

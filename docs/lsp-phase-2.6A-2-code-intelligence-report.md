# Phase 2.6A-2 — internal read-only JS/TS code intelligence

## Scope and architecture

All six operations are implemented in `src/main/lspCodeIntelligence.js`, exporting `LspCodeIntelligence` and the production `codeIntelligence` singleton. They remain main-process internal APIs. No IPC, agent tool definitions, CHILD_TOOL_NAMES, prompts, settings, executable configuration, or dependencies were added. Phase 3 has not started.

Phase 1's manager, fixed bundled launcher, JSON-RPC transport, capabilities, UTF-16 negotiation, canonical workspace roots, document synchronization, diagnostics store, lifecycle hooks, and packaging configuration are reused. The manager gains a normalization callback executed inside its existing per-workspace queue, authorization rechecks, revocation cleanup, bounded diagnostic publications, notification events and monotonically increasing document versions. Unrelated permission policies are unchanged.

Initial working tree was clean. Read both Phase 1 reports, inspected actual manager/transport, permission definitions/policy, project IPC and application shutdown, file tools/scopedPath, canonical sha256 helpers, test fixtures, and dependency/unpack configuration. No commits, pushes, stashes, resets, or working-tree cleaning were performed.

## Internal API contract

```js
const { codeIntelligence } = require('./lspCodeIntelligence');
await codeIntelligence.definition({
  executionContext, // trusted main-process sessionId + current permissionMode
  filePath: 'src/example.ts', line: 1, column: 1,
  pageSize: 25, timeout: 15000, signal
});
```

Methods: `definition`, `references`, `documentSymbols`, `workspaceSymbols`, `hover`, `diagnostics`. Their future tool names are deliberately not registered. All methods accept one validated object. Workspace identity comes exclusively from the canonical session/project authorization path, rather than an independent caller-selected root. File inputs are workspace-relative. Positions and result ranges are 1-based UTF-16 code units, matching the only negotiated encoding. These are not Unicode-code-point or grapheme columns. CRLF and empty-file positions use the existing manager validator. Native file URLs handle Unicode and spaces; Windows-style absolute input is rejected on Linux as well as native Windows absolute paths.

List operations return `success`, `results`, `returnedCount`, retained-snapshot `totalCount`, `hasMore`, optional opaque `nextCursor`, `snapshotId`, `observedAt`, provenance, and explicit truncation/completeness fields. File operations include `sourceVersion` in the existing sha256 format. Continuation uses the same named method with `executionContext`, `cursor` and optional `pageSize`; it does not rerun LSP or reinterpret other query arguments.

Errors contain only stable `LSP_*` categories, never stack traces, server messages or absolute paths. Categories distinguish denied permissions, invalid input/position/query/cursor, stale result/cursor, missing files, unsupported language/capability, cancellation, timeout, and server failure. Existing manager internals retain their Phase 1 error codes; the adapter maps them. Server failure is never an empty successful list. Diagnostic infrastructure failure additionally reports `state: unavailable`.

## Operation behavior

- **Definition:** synchronizes before query; supports null, one or multiple Locations and LocationLinks; uses target selection range when present; retains distinct targets; bounds and paginates results. Cross-file results are workspace-relative.
- **References:** passes `includeDeclaration`, deduplicates, deterministically sorts by path/range, and paginates an immutable normalized snapshot. The real fixture returned 64 locations and exercised a second page without a second server query.
- **Document symbols:** supports hierarchical DocumentSymbol and flat SymbolInformation. Flattened output retains `id`, `parentId`, `depth`, kind, selection range and flat container names. Traversal depth is capped at 64 and reports truncation. Class/method nesting survives pagination through parent IDs.
- **Workspace symbols:** requires a nonempty bounded query (256 characters, no control characters); sends only `workspace/symbol`; preserves kinds/containers, sorts and deduplicates. No filesystem fuzzy-search fallback or global index is built. The bundled server returns resolved locations; unresolved newer WorkspaceSymbol locations lacking ranges fail rather than fabricating locations.
- **Hover:** supports plaintext, MarkupContent, legacy strings, language-tagged blocks and arrays; retains signatures, indicates format and `untrusted: true`; returns at most 6,000 characters by default, expandable to 24,000. Markdown, HTML and links remain inert data; nothing is rendered, executed or fetched by this module.
- **Diagnostics:** uses the existing publication map. No publication means `pending`; matching explicit document version means `ready`; omitted/mismatched version means `stale`; infrastructure failure is `unavailable`. Empty arrays only mean confirmed clean when the publication is version-confirmed. Severity, code, source, range, tags and authorized related locations are retained. Filtering, deduplication and pagination are supported. Messages cap at 2,000 characters, related messages at 1,000, and related locations at 10. Publication storage caps at 1,000 diagnostics and 1 MiB per document, with earlier 16,000-character message bounding. Output truncation includes publication-storage truncation.

## Freshness, synchronization and concurrency

Queries reuse refresh-before-query for all opened files and post-response hash verification, inside the existing workspace queue. Unchanged hashes send no redundant didChange. The queried source's exact disk-read hash is returned. Changes during a request produce `LSP_STALE_RESULT`. External edits and Continuum writes follow the same disk path; no mutation-tool refactor or filesystem watcher was added. Newly queried files open on demand. Deletion closes the document and clears diagnostics; rename is close-old/open-new or detected deletion/new path. Each workspace still owns one server/start promise, queue and document map.

Document versions now increase across the entry's entire lifetime, including close/reopen, preventing an old versioned publication from being mistaken for a newly opened document. Server restarts create distinct entries and empty diagnostic stores. Late diagnostics during closing/dead-client state are ignored. Diagnostic notifications emit an internal event, allowing bounded event-driven consumers; operations themselves return pending immediately rather than sleeping or waiting indefinitely. Real integration tests wait on these events with deadlines.

Pagination deliberately preserves historical immutable results across subsequent filesystem edits. `provenance: immutable-query-snapshot`, `observedAt`, source hash where available, and snapshot identity describe the original query, not the current repository. A continuation is **not** a live query and must never be described as current after an edit. No original-source-only hash is used to claim workspace-wide freshness, and no full-repository hash is maintained. Restart/shutdown, expiry or revoked authorization reject continuation. Changed-file continuation is tested to preserve the historical snapshot without rerunning the server. Phase 3 should start a fresh query when current-state results are required.

## Pagination and resource limits

Default page size 25; valid range 1–100. At most 16 snapshots, 2,000 normalized results per snapshot, 60-second lifetime, and 4 MiB of serialized result payload across snapshots. A single snapshot is additionally limited to half that payload budget. Oldest snapshots are evicted under pressure, and expired/stopped entries are pruned on storage. Returned cursors are random, one-use and operation/workspace/entry scoped. Each snapshot retains at most one outstanding continuation cursor, bounding cursor metadata. Recognized expired/restarted cursors yield STALE_CURSOR; unknown, evicted, replayed or foreign cursors yield INVALID_CURSOR. Permission checks precede cursor lookup and retrieval.

`totalCount` is the count retained in the snapshot, not a fabricated full server total. `hasMore` describes additional pages; `applicationTruncated`/`truncated` describe discarded application data, independently of pagination. No partial-result tokens are requested or advertised. `serverTruncated: unknown` and `incomplete: unknown` (or true when application truncation is known) avoid claiming the server proved exhaustive results. Final-response provenance is explicit. Normalization stops at its result limit; hierarchy traversal also stops at its depth bound.

Measured serialized snapshot payload: 30,241 bytes across 16 retained fixture snapshots. This measures encoded result payload, not V8 heap/RSS; object/Map/string overhead is additional and structurally bounded by the entry, item and cursor counts. JSON-RPC still receives a server's complete final response before normalization; this phase does not implement streaming transport-size limits or partial-result aggregation.

## Authorization and runtime transitions

| Canonical mode | Startup | All six operations |
| --- | --- | --- |
| read_only | denied | denied |
| ask_approval | denied | denied |
| workspace_write | allowed | allowed |
| full_access | allowed | allowed |

Production `authorizeContext` resolves `sessionProject` and canonical `effectiveMode`, then permits exactly workspace_write/full_access for LSP. Tests cover both allowed modes across every operation, denied startup and operations for both disallowed modes, and production resolution with mocked session/project bindings. No shell, write, deletion or approval guard changed.

Authorization is rechecked after shared initialization, inside queued requests, during active protocol requests (25 ms bounded polling while a request is pending), after normalization, and for every continuation. A downgrade observed in flight cancels the caller, prevents output delivery and closes the shared server. This conservative shutdown can interrupt eligible peers; they can reacquire on demand. Read-only callers cannot inherit authorization from a server started by another caller. Allowed-to-allowed changes keep the server eligible.

`manager.permissionChanged(context, previousCanonicalRoot)` is the explicit main-process lifecycle hook for mode changes: eligible same-root changes keep the instance; revocation closes it. Tests exercise denied-to-allowed transitions, active downgrade, revocation cleanup, cursor denial and eligible peer sharing. **The future Phase 3 execution owner must maintain a live trusted context and call this hook when its mode changes.** Phase 2 introduces no model/renderer bridge or autonomous subscription to a new UI permission channel. Mutating a captured renderer payload is not an authorization mechanism. Stored project policy is resolved afresh, and changing the trusted context while a request is pending is detected by the request rechecks.

## Workspace boundaries and execution limitations

Each result location passes canonical file/root checks, including symlink ancestors. External/dependency/non-file locations are omitted and counted in `excludedCount`; no external source is read or returned. Related diagnostic locations follow the same rule. Native path normalization is reused; no unneeded absolute paths appear in ordinary output/errors. No raw JSON-RPC API or executable/argument selector is exposed. The trusted bundled language server and TypeScript paths, fixed process launcher, disabled automatic typing acquisition and plugins list remain unchanged.

Workspace Write eligibility is the exact feature-specific policy requested for this phase; it does not grant arbitrary commands or change Workspace Write's global shell sandbox behavior. The language server itself remains an OS process, not a filesystem/network sandbox. TypeScript project configuration and dependency access can involve paths outside the wrapper's output boundary. This phase confines caller inputs and returned locations, not every internal backend read. No hosted service, inference or independent daemon is added. Installed Windows/macOS packaging and native Windows URI behavior remain unverified here.

## Real-server results and performance

Bundled typescript-language-server 4.3.4, TypeScript 5.7.3; temporary strict tsconfig with JS, JSX, TS, TSX, imports, class/method, emoji/Unicode path, 60 generated usages and error 2322. Startup under Workspace Write, all six operations, continuation, source fix, diagnostic publication clearing, changed-source query, Full Access, both denials and clean shutdown were asserted. Fixture bytes are compared afterward: only the intentional test fix changes source. Real navigation to Array in the bundled standard library excluded two outside-workspace declarations without exposing content; symlink filtering is also covered deterministically.

| Operation | Elapsed ms | Full serialized response bytes |
| --- | ---: | ---: |
| definition | 1789.05 | 598 |
| warmDefinition | 10.12 | 598 |
| references | 76.19 | 1317 |
| documentSymbols | 61.68 | 1081 |
| workspaceSymbols | 411.00 | 519 |
| hover | 45.25 | 347 |
| diagnostics | 222.56 | 5443 |

Startup: 226.21 ms. Cold first-query latency including startup: 2015.26 ms. Diagnostic refresh/publication after fix: 402.93 ms. Timings are one-host observations, affected by concurrent regression load. Warm definition is measured separately; references and workspace symbols run after initial project load. `docs/lsp-phase-2.6A-2-evidence.json` records actual normalized output samples, full response sizes/counts, versions, timings, and diagnostic clearing evidence; large sample arrays are trimmed only in that artifact.

Definition resolved `b.ts:2:23` to `a.ts:1:17–1:23`; references span modules; outline contains Service and method; workspace query finds answer; hover includes its number-returning signature; diagnostics include intentional code 2322, absent after the correction. The bundled server omits diagnostic versions. Consequently the observed publications, including the clearing publication, remain explicitly **stale/unverified**; real integration does not claim confirmed-current clean diagnostics. Deterministic versioned-server tests establish the separate ready/empty-confirmed behavior.

## Verification and regression comparison

Fresh restricted baseline was executed before edits. Its sandbox suppresses nested test output and blocks child stdio: 198 file entries, 166 passes, 32 failures. For reliable comparison, an untouched archive of HEAD `52e2349` was extracted to /tmp with the same dependency installation and run with local-process access. No working-tree files were reverted or replaced.

- Full original-source baseline: 1464 tests; 1439 passed; 25 failed.
- Final full suite: 1473 tests; 1448 passed; 25 failed. New failing identities: 0. Exact failing names for both runs are in the evidence artifact.
- Focused LSP: 19/19 pass (10 Phase 1 + 9 Phase 2 grouped tests). Full suite also exercises permission policy, workspace isolation, file versions/synchronization, agent loops, subagents, steering, plans, recovery and IPC.
- Production `npm run build`: passed, existing >500 kB chunk warning. Main-process module/test syntax checks and git diff whitespace checks passed.
- Electron permission selector: baseline passed; current assertions passed on first run but cleanup hit ENOTEMPTY; repeat exited successfully. This was a transient cleanup race, not a verified persistent baseline failure.
- Electron file browser: passed. These are the relevant selected UI tests, not a claim that the entire Electron UI catalog was rerun.
- No cloud inference, paid model call, installer build or platform-packaging expansion was performed.

## Files changed

1. `src/main/lspManager.js` — authorization, serialized normalization callback, event/publication bounds and generation safety.
2. `src/main/lspCodeIntelligence.js` — six named internal operations and bounded snapshot adapter.
3. `tests/lspCodeIntelligence.test.cjs` — deterministic and real-server operation/permission/freshness verification.
4. `docs/lsp-phase-2.6A-2-code-intelligence-report.md` — this report.
5. `docs/lsp-phase-2.6A-2-evidence.json` — compact verification evidence.

## Phase 2.6A-3 handoff

1. Review this phase before registering any tools. Map only the six named methods into the model-facing registry; never expose manager.request, transform callbacks, launcher configuration or a raw protocol proxy.
2. Derive session/project identity and live effective permission mode in trusted main-process orchestration. Call permissionChanged on runtime revocation; propagate AbortSignal and execution deadlines for main/subagents. Preserve per-caller checks even for shared servers and cursors.
3. Convert model-facing coordinates explicitly to this documented 1-based UTF-16 contract, validate schemas, and preserve source hashes, snapshot provenance, exclusion counts, state and truncation fields in compact tool output.
4. Treat hover/diagnostic/symbol text as untrusted data. Do not auto-append diagnostics to every prompt. Display stale/pending/unavailable honestly; omitted diagnostic versions cannot establish current cleanliness.
5. Retain page budgets, one-use cursors, expiry, operation/workspace scoping and historical-snapshot semantics. Start a new query after edits when current results are needed. Communicate that a stale or evicted cursor requires restarting the operation.
6. Add orchestration/permission transition tests at the eventual tool boundary, including live UI-to-main revocation delivery and child cancellation. No new approval semantics or arbitrary-executable configuration are authorized by this internal phase.
7. Keep installed-platform packaging, sandbox hardening and broader language support for their separately scoped phases. No rename, code actions, formatting or project writes are implemented here.

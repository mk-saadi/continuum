# Continuum — Agentic Phase 1.7 Implementation Report

**Native, permission-aware `web_search`: a discovery-only search tool integrated with the existing
permission model, network transport, agent loop, work logs, and tool-card UI, alongside the
existing web-fetch tool.**

- Date: 2026-10-19
- Reference brief: Phase 1.7 (agentic workspace roadmap — "permission-aware native web search").
- Prior work preserved: **Phase 1.1** (`run_tests`), **1.2** (durable plans), **1.3A** (long-horizon
  budgets), **1.3B** (timeouts/cancellation/terminal contract), **1.3C** (durable continuation),
  **1.4** (mid-run compaction + recovery hardening), **1.5** (completion/streaming reliability +
  child controls), **1.6** (permission-aware safe file deletion).
- Scope implemented: **Phase 1.7 only.** No second web-fetch system, no browser-automation
  framework, no scraping system, no cloud backend/CLI/daemon, no new dependency, no second
  permission/secret framework, no provider-plugin marketplace, no unrelated changes.
- Working tree preserved. **No commits, pushes, stashes, resets, or cleans.** All changes are
  uncommitted working-tree modifications plus two new source/test files and this report. Baseline
  HEAD `c1105ca` (unchanged from the Phase 1.6 baseline).

---

## 1. Stop point and scope

Implementation, deterministic + integration tests, full-suite verification, and the production
build are complete. **Waiting for review.** Nothing beyond Phase 1.7 was started.

In scope: one native tool, `web_search`, that lets an agent *discover* public web result URLs
(title, validated URL, snippet) without ever fetching a page. It reuses the existing permission
model (`READ`, identical to `get_single_web_page_content`), the existing `nodeHttpFetch` transport,
the existing agent tool loop/dispatch, the existing `app_settings` store, the existing IPC/preload
settings pattern, the existing work-log (`turnDigest`) and tool-card (`executionEvents`)
presentation helpers, and the existing `sanitizeWebToolResult` result guard. Its only genuinely new
logic is a small provider boundary and the Brave Search adapter behind it.

Out of scope: a second fetch/scrape pipeline, page-content extraction, result ranking beyond the
provider's order, multiple providers, credential management changes, and any change to unrelated
permission semantics.

---

## 2. Non-goals and constraints honored

- **One initial provider, small boundary.** `src/main/tools/webSearchProvider.js` exposes a single
  `searchWeb(...)` interface plus pure helpers; the Brave adapter is one `buildProviderRequest` /
  `parseProviderPayload` pair keyed by provider id, so a later provider is an additive change that
  does not touch the tool, permission, IPC, or transcript layers.
- **Search ≠ fetch.** `web_search` returns structured snippets and never retrieves a result page.
  Reading a page stays the job of the existing `get_single_web_page_content` /
  `spawn_sub_agent` paths. This is asserted directly (the only URL contacted is the provider
  endpoint).
- **No second web stack.** The provider performs a plain GET through the shared `nodeHttpFetch`
  (the same Node-HTTP transport cloud providers use), not `undici`/Playwright/global `fetch`.
- **No new dependency.** Brave is a GET endpoint with a single header; `nodeHttpFetch` and the
  existing `net`/`AbortSignal` primitives cover it.
- **No secret in prompts, tool results, work logs, or renderer state.** The API key lives in the
  existing `app_settings` row `'web-search'`. The renderer receives `{ provider, configured,
  providerLabel }` only. The key is injected into the request header and never returned, logged, or
  embedded in an error (asserted).
- **Data minimization.** Only the query and the provider's own parameters (`count`, `safesearch`,
  `text_decorations`, `extra_snippets`) are transmitted. Nothing from the chat transcript,
  workspace, attachments, or memory is ever sent.
- **Children gain nothing.** `web_search` is deliberately **not** in `CHILD_TOOL_NAMES`; the stale
  comments claiming the app has no search facility were corrected to state the new policy.
- **No permission weakening.** `web_search` is `READ`, matching `get_single_web_page_content`;
  every existing visibility/approval expectation is unchanged.

---

## 3. Investigation: reuse vs. build

Before writing anything, the existing tree was searched for a reusable structured-search capability.
**Result: none exists (build required).** Findings:

| Candidate | Verdict |
| --- | --- |
| `src/main/tools/webSearch.js` | **Misnomer — it is the page *fetch*/extraction module.** It exports `getSingleWebPageContent`, `sanitizeWebPageContent`, `sanitizeWebToolResult`; the registered tool is `get_single_web_page_content`. No provider, no query, no structured results. |
| `full-web-search` | Referenced only as an *optional user-provided MCP tool*; not native, not present by default. |
| Playwright MCP browser automation | An accessibility-tree browser driver, not a structured search API. Rejected as the primary path: fragile selectors, unbounded cost, and it is not a search boundary. |
| Any existing search API key/setting | None found anywhere (`app_settings`, config, cloud providers). |

A native structured search boundary is therefore genuinely new work. Brave Search was selected as
the single initial provider because it is an official, GET + single-header JSON API that returns
`web.results[] = { title, url, description, age, page_age }`, which maps cleanly onto the required
snippet-model and keeps search and fetch separate. (Tavily was also viable but POSTs chunked
content, conflating search with fetch content.)

Sources consulted: `https://api-dashboard.search.brave.com/app/documentation/web-search/get-started`
(and its query/responses pages, which return the same SPA shell).

---

## 4. Baseline state and reproduction

Independently reproduced before any Phase 1.7 change, on the uncommitted working tree at HEAD
`c1105ca`.

| Run | Command | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- | --- |
| Baseline | `node --test` (repo root) | 1,195 | 1,168 | **27** | 0 |
| Final (Phase 1.7) | `node --test` (repo root) | 1,232 | 1,204 | **27** | 1 |

The 27 baseline failures were saved by identity and compared by identity against the final run: the
failure set is **byte-identical** — no baseline failure newly passes and no new failure appears
(`comm` over the normalized `not ok` names returns empty in both directions). The +37 tests are
exactly the Phase 1.7 additions: 36 deterministic tests plus 1 skipped manual live smoke test
(§16).

> Tooling note: `npm test` (`node --test tests/`) fails on this runtime with
> `Cannot find module '…/tests'`; verification therefore used `node --test` from the repo root, the
> same approach used for the Phase 1.5/1.6 baselines.

---

## 5. The pipeline under test (real dispatch + permission + provider)

```
model requests web_search
  └─ ipcHandlers executeTool: guardTool({ name, args, permissionMode, project, requestApproval })
       └─ baseDecision(capability = READ, mode, hasWorkspace)
            • read_only                    -> allow (no prompt)
            • casual (no workspace)        -> allow (no prompt)
            • workspace_write/ask_approval -> allow (no prompt)
            • full_access                  -> allow
  └─ executeAgentTool({ …, signal })
       └─ web_search branch  ->  webSearchProvider.searchWeb({ query, max_results, signal })
            1. normalize query (throws on empty/non-string) and clamp max_results (1..20)
            2. resolve settings (configManager.readSearchSettings); empty key -> not_configured
            3. GET https://api.search.brave.com/res/v1/web/search  (redirect: 'manual')
                 resolveDefaultFetch() -> lazy require('../nodeHttpFetch').nodeHttpFetch
            4. bounded body read (1 MB) -> JSON.parse -> shape check -> normalizeResults()
            outcome: success | no_results | rate_limited | timed_out | provider_error |
                     invalid_response           (caller abort rethrown as AbortError)
  └─ ipcHandlers: sanitizeWebToolResult(raw, 'web_search')  (existing result guard)
  └─ engineManager.failedToolReason: success:false => failure (no_results stays success:true)
  └─ turnDigest (kind "web") + executionEvents (kind "search"): query + result count/outcome
```

The tests drive this exact path: `guardTool` → `executeAgentTool` (the IPC composition), plus the
config/IPC handlers, not standalone helpers.

---

## 6. Tool contract and outcome vocabulary

Schema (`agentTools.js`): `query` (required, string) and optional `max_results` (number, 1–20,
default 5). Result uses the existing `success` boolean plus a truthful `outcome`:

| outcome | meaningful state | `success` | notes |
| --- | --- | --- | --- |
| `success` | **results returned** | true | `results[]`, `resultCount`, `provider`, `providerLabel` |
| `no_results` | provider returned an empty set | **true** | never reported as a tool failure |
| `not_configured` | no API key saved | false | actionable Settings guidance |
| `rate_limited` | HTTP 429 | false | carries `retryAfter` when the header is present |
| `timed_out` | request deadline exceeded | false | not retried |
| `cancelled` | caller aborted | false (via the catch) | abort also stops the enclosing run |
| `provider_error` | network failure or non-2xx (auth/validation/5xx/redirect) | false | transient subset retried once |
| `invalid_response` | unparseable / unexpected shape / oversized body | false | |
| `permission_denied` | guard denied | false (via the catch) | unreachable for `READ` today, mapped for correctness |

Result entry shape (bounded): `{ position, title, url, source, snippet, published }` where
`published` is an ISO date **only** when reliable, else `null`.

---

## 7. Provider boundary and the Brave adapter

`searchWeb({ query, max_results, signal, fetchImpl, settings, maxRetries })` is the sole entry
point. Pure, independently-tested helpers:

- `providerLabel(provider)` — `'brave' → 'Brave Search'`, else `'Web Search'`.
- `normalizeMaxResults(value)` — default 5, clamped to 1..20.
- `validateResultUrl(value)` — public http(s) only (see §11).
- `normalizeResults(raw, maxResults)` — validate, de-duplicate, bound, cap.
- `classifyHttpFailure(response)` — status → outcome + retryable + `retryAfter`.

The Brave adapter sets `q`, `count`, `safesearch=moderate`, `text_decorations=false`,
`extra_snippets=false` and sends `X-Subscription-Token`. Requests use `redirect: 'manual'` (the
endpoint is fixed; a redirect must never move a credentialed request),
`Accept-Encoding: identity`, and `AbortSignal.any([callerSignal, AbortSignal.timeout(15000)])`.

The transport is resolved lazily via `require('../nodeHttpFetch').nodeHttpFetch` so tests can
monkeypatch the shared transport and so a stale reference is never captured at module load.

---

## 8. Permission model

`web_search: CAPABILITIES.READ` in `TOOL_CAPABILITIES`, exactly like `get_single_web_page_content`.
Consequences, all derived from the existing single policy table (visibility and execution read the
same table):

- `read_only` → allowed without a prompt.
- Casual chat (no workspace) → allowed without a prompt (reads are safe in every non-denied mode).
- `workspace_write` / `ask_approval` → allowed without a prompt.
- `full_access` → allowed.

No new capability, no new approval path, and no change to any other tool's capability. `capabilityOf`,
`isToolVisible`, and `guardTool` behavior are covered by focused tests.

---

## 9. Network, timeouts, retries, cancellation

- **Transport:** shared `nodeHttpFetch` (Node `http(s)`), independent of `global.fetch`.
- **Deadline:** 15 s per attempt via `AbortSignal.timeout`; a stalled GET also trips the transport's
  own idle timeout, both classified `timed_out`.
- **Retry:** a **single bounded retry** for genuinely transient failures only — network errors and
  HTTP 5xx. Auth (401/403), validation (400/422), redirects, invalid responses, rate limits, and
  timeouts are never retried. A 502 that clears on retry returns `success` (tested).
- **Rate limit:** 429 → `rate_limited` with `retryAfter` metadata and no automatic retry.
- **Cancellation:** the caller's abort is rethrown (not converted into a tool result), so the whole
  agent run stops; `executeAgentTool`'s catch types it as `cancelled`. Cancellation is checked at
  entry and per attempt.

---

## 10. Secret handling and data minimization

- The key is stored in the existing `app_settings` row `'web-search'` (same mechanism as cloud
  providers and the local embedding key) and read in the main process only.
- `getSearchSettings()` (renderer-facing) returns `{ provider, configured, providerLabel }` — the
  key is never included. `saveSearchSettings()` keeps the existing key when `apiKey` is omitted, so
  the UI can save the provider without re-typing a secret it was never shown.
- The key appears only in the request header. A dedicated test asserts it is absent from both
  success and failure result objects. Error messages carry status codes and a sanitized cause only.
- The outbound request carries only the query and provider parameters (tested by asserting the
  exact query-parameter set). Nothing from the chat, workspace, attachments, or memory is sent.
- Work-log rendering uses `args.query` (not a secret) plus result counts/outcome.

---

## 11. Result normalization and URL safety

Provider output is untrusted. `normalizeResults` / `validateResultUrl` fail closed:

- Only `http`/`https` with no embedded credentials; `javascript:`, `file:`, `ftp:`, and other
  schemes are dropped.
- Loopback / private / link-local / `.local` / `.localhost` / `.internal` hosts are dropped
  (mirrors the page fetcher's public-address predicate), so a hostile provider response cannot
  steer the model toward an internal address.
- Duplicates are removed by canonical URL (host case + trailing slash normalized) while **query
  strings are preserved** and treated as distinct.
- Titles (≤300) and snippets (≤1200) are bounded; at most `max_results` (≤20) are returned.
- `published` is kept only from a real, absolute ISO date (`page_age`); relative strings like
  `"3 days ago"` are **never** fabricated into a date.

The existing `sanitizeWebToolResult` already recognizes the `web_search` tool name (the module's
`WEB_TOOL_NAME` regex matches `web_search`), so results also pass through the app's HTML/data-URI
guard and per-string cap before display — no new guard was needed.

---

## 12. Configuration, IPC, and settings UI

- `src/main/configManager.js`: `SEARCH_PROVIDERS = ['brave']`, `normalizeSearchSettings`,
  `readSearchSettings` (internal, includes the key), `getSearchSettings` (redacted),
  `saveSearchSettings`. Invalid providers and keys containing control characters are rejected;
  a corrupt stored row degrades to *unconfigured* rather than crashing.
- `src/main/ipcHandlers.js`: `"search:get-settings"` / `"search:save-settings"`.
- `src/preload.js`: `getSearchSettings` / `saveSearchSettings`.
- `src/components/settings/GeneralSettingsTab.jsx` (Agents & Skills tab): a compact "Web Search"
  section — provider select (Brave), a password field, Save, and Remove key. The field is blank by
  default and blank-means-keep; the UI shows only configured/not-configured and the provider label.

---

## 13. Work-log / transcript integration

`src/main/turnDigest.js`: `web_search` joins `WEB_TOOLS` (`classifyTool → 'web'`), and a new
`summarizeWeb` branch reports `searched '<query>' (N results)` or `searched '<query>' → <outcome>`
instead of a fetch summary. The web entry signature uses `query:<q>` when there is no URL, so
distinct searches are not collapsed. No secret is rendered.

---

## 14. Tool-card UI presentation

`src/lib/executionEvents.mjs`: `web_search` joins `SEARCH_TOOLS`, giving `toolKind → 'search'`,
`toolVerb → 'Search'`, a `Query` argument field, and a `search` count in stage summaries. Only
presentation helpers changed; the existing tool card renders the result unchanged.

---

## 15. Child-agent policy

`web_search` is deliberately **not** added to `CHILD_TOOL_NAMES` (`subagents/agentLoop.js`). Children
remain read-only and cannot spend a search provider's quota; a child web task still requires an
exact URL. The stale comments in `src/main/tools/subagent.js` that claimed "the application exposes
no search/discovery facility anywhere" were corrected to describe the new native tool and the
deliberate child exclusion. The child-facing wording "cannot search or discover pages" is retained
because it is still true of children (pinned by `subagentFailureDiagnostics`).

---

## 16. Deterministic tests + optional live smoke test

New file `tests/webSearchTool.test.cjs` — **37 tests** (36 deterministic, 1 skipped live). The
deterministic suite never touches the network: the transport is monkeypatched and results are
synthesized.

Coverage:

1. schema/registry contract;
2. capability/visibility matrix (`READ`) and child-allowlist exclusion;
3. search-contacts-only-the-provider assertion;
4. unconfigured → `not_configured` without a network call;
5. key sent in the header but absent from success and failure results;
6. outbound request carries only the expected query parameters;
7. successful normalization (positions, fields, reliable vs. fabricated dates);
8. empty set → `success:true` / `no_results` (and not a `failedToolReason` failure);
9. `max_results` default and clamping;
10. canonical de-duplication with query-string preservation;
11. title/snippet bounding;
12. URL validation matrix (schemes, credentials, private/loopback/link-local IPs);
13. hostile/private result URLs dropped;
14. 401/403 and 400/422 → `provider_error`, no retry;
15. 5xx → one bounded retry then `provider_error`; a 502 that clears → success;
16. 429 → `rate_limited` + `retryAfter`, no retry;
17. network failure → retried once then `provider_error`;
18. timeout → `timed_out`, no retry;
19. redirect → `provider_error`, never followed;
20. non-JSON / wrong-shape / oversized body → `invalid_response`;
21. cancellation before and during the request propagates as an abort;
22. `executeAgentTool` success, `not_configured` (+ `failedToolReason`), malformed input, and
    cancellation typing;
23. guarded path (`read_only`, no grant) routes to the provider;
24. a `runMemoryChat` tool-call round-trip carries results back to the model;
25. config redaction/persistence (key preserved on omission, cleared on `''`, validation);
26. transcript (`turnDigest`) search summaries;
27. UI presentation (`toolKind`/`toolVerb`/`formatArgFields`/`summarizeStage`).

**Optional manual live smoke test (separately labelled, skipped by default):**
`MANUAL LIVE SMOKE: a real Brave search returns at least one structured result`. It runs only when
`CONTINUUM_LIVE_SEARCH_KEY` is set and is skipped otherwise, so routine runs and CI spend no quota.
To run it:

```
CONTINUUM_LIVE_SEARCH_KEY=... node --test tests/webSearchTool.test.cjs
```

---

## 17. Focused regression and full-suite verification

**Focused suites (individual runs):**

| Suite | Tests | Result |
| --- | --- | --- |
| `webSearchTool` (new) | 37 | 36 pass, 1 skipped (live) |
| `webSearch` (existing fetch regression) | 13 | 13 / 13 |
| `agentTools` | 1 | 1 / 1 |
| `toolPermissions` | 10 | 10 / 10 |
| `permissionPolicy` | 1 | 1 / 1 |
| `nativePermissions` | 1 | 0 / 1 (pre-existing baseline failure) |
| `turnDigest` | 20 | 20 / 20 |
| `toolVerbs` | 3 | 3 / 3 |
| `workspaceStages` | 9 | 9 / 9 |
| `sessionPromptWording` | 4 | 4 / 4 |
| `projects` | 1 | 1 / 1 |
| `subagentFailureDiagnostics` | 5 | 5 / 5 |

**Full-suite regression comparison (by test name):**

| Run | Tests | Pass | Fail | Skipped | New failures vs baseline |
| --- | --- | --- | --- | --- | --- |
| Baseline (working tree, HEAD `c1105ca`) | 1,195 | 1,168 | 27 | 0 | — |
| Final (Phase 1.7) | 1,232 | 1,204 | 27 | 1 | **0** |

The failure identities are byte-identical to the baseline set. The remaining 27 are the same
pre-existing, unrelated families recorded in the Phase 1.5/1.6 reports (Electron mocks lacking
`app.getPath`, and stale provider-stream expectations); they were neither introduced nor repaired
here.

**Production build:** `npm run build` → success (1,809 modules transformed; `dist/assets/index-*.js`
built), exit 0. The only output note is the pre-existing "chunks larger than 500 kB" advisory.

---

## 18. Supported vs. unsupported (explicit statement)

**Reported complete and verified by deterministic tests in this repo:**

- `web_search` is a native tool whose results come only from a configured provider, with no page
  ever fetched by the search tool.
- `READ` permission parity with `get_single_web_page_content`; no prompt in any mode; children
  excluded.
- The complete outcome vocabulary (`success`/`no_results`/`not_configured`/`rate_limited`/
  `timed_out`/`cancelled`/`provider_error`/`invalid_response`/`permission_denied`) is produced and
  classified truthfully, including `no_results` not counting as a failure.
- One bounded retry for transient failures only; no retry for auth, validation, rate limit,
  redirect, invalid response, or timeout.
- Results are validated (scheme/credentials/private-host), de-duplicated, bounded, and dated only
  from reliable ISO values; query strings preserved.
- The API key is confined to the request header and never appears in a result, error, log, or
  renderer state; the outbound request carries only the query and provider parameters.
- Settings persist/redact correctly across IPC and preload; the UI adds/removes the key.
- Transcript and tool-card presentation are wired and tested.

**Not verified end-to-end (and not claimed):**

- **A live provider call **is available** as a skipped, separately-labelled manual smoke test, but
  the default suite never performs one.** No live Brave response was captured during this run; the
  adapter is verified against a faithful synthetic payload.
- **A real model call.** Model-visible behavior is covered by the schema, dispatch, and a
  `runMemoryChat` round-trip with a stubbed model; no model backend was run.
- **Brave response drift.** Field names (`web.results[].title/url/description/page_age`) match the
  documented shape; a future provider change would surface as `invalid_response`, not silent
  corruption.
- **Additional providers.** Only Brave is implemented; the boundary is designed for more.
- **Repair of the 27 pre-existing baseline failures.** Out of scope and unchanged.

---

## 19. Distinguishing reported completion from independently verified behavior

- **Independently verified in this repository (deterministic, offline):** all provider
  classification/normalization/validation/retry/cancellation behavior, the permission matrix, the
  real `guardTool → executeAgentTool` dispatch, the chat-loop round-trip, config redaction and
  persistence, and the transcript/UI presentation — via `tests/webSearchTool.test.cjs` over a
  monkeypatched transport.
- **Implemented but only exercised by the optional manual live test:** a genuine network call to
  the Brave Search API (skipped unless `CONTINUUM_LIVE_SEARCH_KEY` is set).
- **Not exercised at all:** a real language model deciding to call the tool; a real end-user
  settings round-trip through a running Electron window.

---

## 20. Limitations and recommended next steps

1. **Only one provider.** Brave is implemented; adding a second is additive in
   `webSearchProvider.js` (endpoint + parse + label) with no tool/permission/IPC change.
2. **Result quality is the provider's.** No re-ranking, freshness filtering, or local caching is
   attempted; the tool returns the provider's order.
3. **`not_configured` counts as a tool failure.** It is `success:false` (truthful) and therefore
   contributes to the existing consecutive-failure circuit breaker; the actionable message nudges
   the model to stop. If undesired, the resilience policy (not this tool) is where to change it.
4. **No offline mode.** The app has no network-disable setting; connectivity failures are
   classified (`provider_error`/`timed_out`) rather than suppressed.
5. **Baseline test repair** remains out of scope.

---

## Appendix A — Changed files and symbols

| File | Change |
| --- | --- |
| `src/main/tools/webSearchProvider.js` | **new** — provider boundary + Brave adapter: `searchWeb`, `providerLabel`, `normalizeMaxResults`, `normalizeResults`, `validateResultUrl`, `classifyHttpFailure`, `SEARCH_OUTCOMES`, `REQUEST_TIMEOUT_MS`; bounded body read, single transient retry, deadline/cancellation handling, secret-safe errors |
| `src/main/tools/agentTools.js` | `web_search` schema; dispatch branch calling `searchWeb`; typed `outcome` for `web_search` in the `executeAgentTool` catch |
| `src/main/toolPermissions.js` | `TOOL_CAPABILITIES.web_search = CAPABILITIES.READ` |
| `src/main/configManager.js` | `SEARCH_PROVIDERS`, `DEFAULT_SEARCH_PROVIDER`, `normalizeSearchSettings`, `readSearchSettings`, `getSearchSettings`, `saveSearchSettings` |
| `src/main/ipcHandlers.js` | `search:get-settings` / `search:save-settings` handlers + imports |
| `src/preload.js` | `getSearchSettings` / `saveSearchSettings` |
| `src/components/settings/GeneralSettingsTab.jsx` | "Web Search" settings section (provider, key, save/remove) |
| `src/main/turnDigest.js` | `web_search` in `WEB_TOOLS`; search-aware `summarizeWeb`; query-based web entry signature |
| `src/lib/executionEvents.mjs` | `web_search` in `SEARCH_TOOLS` (kind `search`, verb `Search`, `Query` field) |
| `src/main/tools/subagent.js` | corrected stale "no search facility" comment (child policy documented) |
| `src/main/promptBuilder.js` | delegation protocol now points at native `web_search` for URL discovery |
| `tests/webSearchTool.test.cjs` | **new** — 36 deterministic tests + 1 skipped live smoke test |
| `docs/agentic-phase1-7-report.md` | **new** — this report |

Pre-existing Phase 1.2–1.6 working-tree changes (unchanged by Phase 1.7) remain present in
`src/main/{compactionCore,db,taskCheckpoints}.js`, `src/main/subagents/**`,
`src/components/chat/SubagentTranscriptModal.jsx`, plus `tests/toolVerbs.test.mjs` and
`tests/workspaceStages.test.mjs` (Phase 1.6 delete-verb assertions), and the untracked 1.3C–1.6
tests and docs.

## Appendix B — Key invariants

- One search tool, one provider boundary; `web_search` discovers URLs and never fetches a page.
- Search uses the shared `nodeHttpFetch` transport; no second web stack and no new dependency.
- `web_search` is `READ`, identical to `get_single_web_page_content`; no prompt in any mode.
- The API key is header-only: never in a result, error, log, prompt, or renderer state.
- Outbound requests carry only the query and provider parameters — never chat/workspace/memory.
- Transient failures retry at most once; auth/validation/rate-limit/redirect/invalid-response/
  timeout never retry; caller cancellation stops the run.
- Results are validated (scheme/credentials/private-host), de-duplicated by canonical URL with query
  strings preserved, bounded, and dated only from reliable ISO values.
- `no_results` is `success:true`; every other non-success outcome is a truthful, classified failure.
- Children never receive the tool and stay read-only.

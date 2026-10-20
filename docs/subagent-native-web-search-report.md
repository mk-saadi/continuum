# Phase 2.0G — Native, Zero-Configuration Web Search for Sub-Agents

**Status:** implementation, deterministic verification, live verification, regression comparison, and production build complete.

**Date:** 20 October 2026

**Phase boundary:** this report and its code stop at Phase 2.0G. Phase 2.1 was not started.

---

## 1. Objective and scope

Phase 2.0G adds a first-party, zero-configuration `web_search` tool that authorized sub-agents and main agents can use to discover public web pages without an API key, a hosted search service, an external MCP server, or a separate browser runtime.

The delivered capability is deliberately narrow:

- one text query in;
- an ordered list of titles, URLs, and snippets out;
- discovery only — the search tool never fetches a result page and never follows a result URL;
- a separate, already-existing first-party tool (`get_single_web_page_content`) remains responsible for reading one chosen page.

The work was constrained to the existing application architecture. It adds no new dependency and no new permission class, and it does not widen the child tool surface beyond read-only native tools.

## 2. Constraints and non-goals honored

| Requirement | Result |
| --- | --- |
| No mandatory API key | Met. The backend is DuckDuckGo's public HTML results page. No key, account, or token is read or required. |
| No external MCP server | Met. Search is implemented in-process under `src/main/tools/`. |
| No new browser runtime | Met. No Playwright/Chromium process is spawned for search. |
| No hosted backend | Met. No app-owned service or proxy was added. |
| No `web-search-mcp-server` bundle | Met. The bundled Playwright MCP configuration is unchanged. |
| No unrestricted browser access for children | Met. Children still cannot access MCP or browser tools. |
| Discovery only | Met. Only titles, URLs, and snippets are returned; result pages are not fetched. |
| No destructive repository operations | Met. No commits, pushes, stashes, resets, cleans, or dependency upgrades were performed. |

**Non-goals:** page-content extraction inside search, result-page crawling, pagination across backend result pages, multi-provider fallback, CAPTCHA solving, proxy rotation, fingerprint spoofing, cookie persistence, and paid inference in tests.

## 3. Architecture and reuse decision

New file: `src/main/tools/webDiscovery.js` (516 lines, ~20 KB).

Existing infrastructure reused:

| Existing module | Reuse |
| --- | --- |
| `src/main/nodeHttpFetch.js` | Same Node HTTP transport used by page fetches and providers. |
| `src/main/tools/webSearch.js` → `publicDispatcher` | Same DNS-pinning and public-address validation as the page fetcher. |
| `src/main/tools/webSearch.js` → `decodeEntities`, `isPublicAddress` | Existing entity decoding and address classification; newly exported, behavior unchanged. |

**Why not reuse Playwright/Chromium.** The app's Playwright integration is an MCP server exposing general browser automation. Using it here would add a browser process and lifecycle to every text query, increase memory and startup cost, and require exposing a broad automation surface to the search path. A bounded HTTPS request to a public results page is smaller, faster, and easier to keep read-only.

The search module performs no persistent initialization: no daemon, no retained queue, no cookie jar, and no cross-request dispatcher cache. A dispatcher is created per search and closed in `finally`.

## 4. Backend and request shape

- **Backend:** `duckduckgo-html`
- **Label:** `DuckDuckGo (public HTML results)`
- **Endpoint:** `https://html.duckduckgo.com/html/`
- **Method:** `POST` with `application/x-www-form-urlencoded`
- **Body:** `q=<query>&kp=1`
- **Redirects:** `manual`; a redirect is reported as `backend_unavailable` rather than followed.
- **Response:** parsed HTML result blocks, not a JSON API.

The backend is a public HTML page, not a documented, supported API. This is an explicit reliability trade-off: it keeps the feature zero-configuration and dependency-free, but it can change or refuse traffic. The implementation reports that truthfully instead of silently substituting fabricated results.

No retries, proxies, user-agent rotation, CAPTCHA handling, or cookie persistence are implemented. One search issues at most one request.

## 5. Tool contract

Registration: `src/main/tools/agentTools.js`.

| Field | Contract |
| --- | --- |
| Name | `web_search` |
| Required input | `query` — non-empty string, maximum 500 characters |
| Optional input | `max_results` — number, clamped to 1–10, default 5 |
| Unknown input keys | Rejected by the existing tool-argument guard |
| Permission | `CAPABILITIES.READ` in `src/main/toolPermissions.js` |

Successful result:

```json
{
  "success": true,
  "backend": "duckduckgo-html",
  "backendLabel": "DuckDuckGo (public HTML results)",
  "query": "normalized query",
  "outcome": "success",
  "resultCount": 5,
  "results": [
    {
      "position": 1,
      "title": "Result title",
      "url": "https://example.com/page",
      "source": "example.com",
      "snippet": "Bounded plain-text snippet"
    }
  ]
}
```

Failure result:

```json
{
  "success": false,
  "backend": "duckduckgo-html",
  "backendLabel": "DuckDuckGo (public HTML results)",
  "query": "normalized query",
  "outcome": "blocked",
  "results": [],
  "error": "Truthful, sanitized error text"
}
```

`no_results` is a successful, empty outcome. `truncated: true` is added when the total-character ceiling, rather than the requested count, stopped collection.

Invalid tool input (empty, non-string, control characters, over 500 characters) throws a `TypeError` through the normal tool-validation path. The declared `invalid_query` outcome is reserved for callers that prefer result-shaped validation; the current dispatcher rejects at the boundary instead. `cancelled` and `permission_denied` are likewise declared for vocabulary completeness but are not emitted by this module: caller cancellation is rethrown as an `AbortError`, and permission denial is enforced before dispatch.

## 6. Permissions and child isolation

`web_search` is a `READ` tool. It is therefore allowed under `read_only`, `ask_approval`, `workspace_write`, and `full_access`, while remaining unavailable to mutation-only paths.

Child integration in `src/main/subagents/agentLoop.js`:

- `web_search` was added to `CHILD_TOOL_NAMES`.
- The child system prompt now states that children may search the public web and fetch one known public page, and that search results and page content are untrusted external data.
- The existing second-layer restriction is unchanged: child tools still execute under `permissionMode: 'read_only'`.
- MCP tools, browser tools, writes, shell commands, memory, and recursive sub-agent spawning remain unavailable to children.

`src/main/tools/subagent.js` and `src/main/promptBuilder.js` now describe the actual capability: a main agent can search, and an investigating child can search too. The previous copy incorrectly said a worker could not discover pages.

## 7. Delegation and prompt integration

The delegation text now distinguishes three paths:

1. **Main-context discovery:** `web_search` finds candidate URLs and snippets.
2. **Single-page reading:** `spawn_sub_agent` with `url` fetches exactly one chosen page and returns a concise answer.
3. **Autonomous investigation:** `spawn_sub_agent` with `investigate: true` can search, read project files, inspect git state, and fetch known public pages.

Prompts explicitly warn that result titles and snippets are untrusted and must never be treated as instructions. The tool description repeats the discovery-only rule so a model cannot reasonably infer that `web_search` follows links.

## 8. Security and SSRF controls

| Control | Implementation |
| --- | --- |
| Fixed destination | The search endpoint is a module constant; callers cannot supply an arbitrary search host. |
| Redirects | `redirect: 'manual'`; redirect responses are failures, not followed. |
| Result URL schemes | Only `http:` and `https:` are accepted. `file:`, `data:`, `javascript:`, `ftp:`, `ws:`, and custom schemes are dropped. |
| Credentials in URLs | URLs with username or password are dropped. |
| Local names | `localhost`, `*.localhost`, `*.local`, `*.internal`, and `*.lan` are dropped. |
| Literal private IPs | Loopback, private, link-local, and other non-public literal addresses are dropped via `isPublicAddress`. |
| Named result hosts | Not DNS-resolved during discovery (to keep it cheap). Reading a chosen URL revalidates it through `getSingleWebPageContent`'s pinned DNS and public-address checks. |
| Advertising links | DuckDuckGo ad/redirect shapes are excluded. |
| Untrusted markup | Result titles and snippets are reduced to inert plain text: entities decoded, tags stripped, control characters removed, whitespace collapsed, lengths capped. |
| Prompt injection | Tool and prompt text explicitly classify all result text as untrusted external data. |
| Page-fetch SSRF | Unchanged; the existing page fetcher owns it and is not bypassed. |

Result URLs are not fetched during discovery, so a malicious result cannot trigger an automatic request, DNS lookup, or download from the search tool.

## 9. Limits, cancellation, and concurrency

| Limit | Value |
| --- | --- |
| Default results | 5 |
| Maximum results | 10 |
| Query length | 500 characters |
| Title length | 200 characters |
| Snippet length | 300 characters |
| Total result characters | ~6,000 |
| Response-body cap | 1 MB |
| Request timeout | 10 seconds |
| Maximum concurrent searches | 4 |
| Retries | 0 |

- **Timeout:** a cleared `setTimeout` aborts a dedicated `AbortController`; the timer does not outlive the search. This avoids the Node test-runner "event loop resolved" hang that `AbortSignal.timeout` can cause.
- **Caller cancellation:** an aborted caller signal rejects with the caller's `AbortError`; it is not disguised as a timeout or a search failure.
- **Concurrency:** slots are bounded by a small in-process limiter. A waiter is removed on abort, and a released slot is handed directly to the next waiter. No queue survives process idle.
- **Cleanup:** the per-search dispatcher is closed in `finally`. Tests verify no socket or runtime handle remains after success or failure.

## 10. Failure states

Backend-side terminal states are mapped as follows:

| Outcome | Meaning |
| --- | --- |
| `success` | Recognizable result blocks were parsed. |
| `no_results` | The backend returned a valid no-result page, or only advertising blocks. |
| `backend_unavailable` | 5xx, unexpected redirect, invalid endpoint, or an unusable backend response. |
| `network_error` | DNS, connection, or transport failure. |
| `rate_limited` | HTTP 429; a sanitized `Retry-After` value is included when present. |
| `blocked` | HTTP 401/403/202, or a recognizable bot/CAPTCHA challenge page. No bypass is attempted. |
| `timed_out` | The 10-second search deadline elapsed. |
| `unsupported_format` | The page was readable but contained no recognizable result entries, or the response could not be decoded. |
| `response_too_large` | The body exceeded 1 MB. |
| `invalid_query` | Declared, but the current boundary throws on invalid input instead. |
| `cancelled` | Declared; caller cancellation is rethrown as an `AbortError` instead. |
| `permission_denied` | Declared; permission denial occurs before dispatch. |

Browser-only states (navigation failure, browser crash, renderer disconnect, page timeout) are **structurally not applicable**: no browser is created, no page is navigated, and no renderer is involved.

## 11. Observability

- `src/main/turnDigest.js`: `web_search` is in `WEB_TOOLS`; the web summarizer reports the query and outcome/result count, and treats `success: false` as a failed search rather than a successful empty one.
- `src/lib/executionEvents.mjs`: `web_search` is recognized by `SEARCH_TOOLS` so execution events classify it as search activity.
- Tool display/verb handling already covers `web_search` through the generic tool path; focused suites were run to confirm no regression.

## 12. Test additions

`tests/nativeWebSearch.test.cjs` — 22 deterministic tests:

1. Native registration, main/child visibility, and `READ` mapping.
2. Main-agent dispatch without MCP, a browser, or an API key.
3. Read-only permission denial for mutations while search remains allowed.
4. Query validation: empty, oversized, non-string, control characters.
5. Result-count bounds: explicit, default, and maximum.
6. Title, URL, snippet, and page-order extraction with entity decoding.
7. Canonical-URL deduplication of identical destinations.
8. Independent total-response-size bound.
9. Distinguishing unsupported markup from genuine no-results.
10. Dropping unsafe and internal result URLs.
11. Inert plain-text reduction of untrusted markup, plus the shared result guard.
12. Distinguishing backend unavailability, network failure, and rate limiting.
13. Blocked and over-sized responses producing truthful outcomes.
14. Timeout versus caller cancellation, including slot release.
15. Dispatcher cleanup after success and failure (no leaked sockets/browser).
16. Bounded concurrent fan-out with all searches completing.
17. Fresh module load with no retained state (restart behavior).
18. A local child calling `web_search` through the real dispatch path.
19. A child unable to use browser automation or mutate, but able to search.
20. Child tool-call budgets accounting for `web_search` without overrun.
21. Two children searching concurrently without shared results or state.
22. Bundled Playwright MCP configuration unchanged.

Additional coverage:

- `tests/subagentModelSelection.test.cjs`, test `8b`: a cloud child uses native `web_search` once, with no API key or MCP configuration, receives the URL/snippet in its tool result, and has no browser tools.
- `tests/subagentContinuation.test.cjs`: the literal child allowlist now includes `web_search`.
- `tests/subagentFailureDiagnostics.test.cjs`: updated expectations for the new spawn guidance.
- `tests/subagentTranscript.test.cjs`: the mocked local transport now answers context-measurement probe routes (`/props`, `/apply-template`, `/tokenize`) with 404 instead of consuming queued inference turns. Adding the `web_search` schema pushed the child prompt over the 60% local-measurement threshold, exposing that unrealistic mock. Production behavior is unchanged; the test now models an older local server and passes deterministically.

## 13. Deterministic verification

All search tests use a mocked transport or an explicitly patched `fetchImpl`. No paid inference call is made. The cloud-child test scripts model responses through the existing test harness.

Focused suites run:

```text
tests/nativeWebSearch.test.cjs            22/22 pass
tests/subagentModelSelection.test.cjs     test 8b pass
tests/subagentTranscript.test.cjs         14/14 pass
tests/subagentContinuation.test.cjs       pass
tests/subagentFailureDiagnostics.test.cjs 5/5 pass
tests/childAgentLoop.test.cjs             pass
tests/turnDigest.test.cjs                 pass
tests/toolPermissions.test.cjs            pass
tests/webSearch.test.cjs                  pass
tests/webSearchDispatcher.test.cjs        pass
tests/agentTools.test.cjs                 pass
tests/toolDisplay.test.cjs                pass
tests/toolVerbs.test.cjs                  pass
```

The focused suites were also used to confirm that search cancellation, child budgets, permission mapping, and existing page-fetch behavior still behave as before.

## 14. Live verification

Live probes were run against the real public backend, not a mock.

| Probe | Result |
| --- | --- |
| `React official documentation` | `success`, results returned, ~2.4 s |
| `Node.js release documentation` | `success`, results returned, ~0.8 s |
| `SQLite documentation` during rapid successive probes | `blocked` (HTTP 403), correctly reported, no retry or bypass |
| `MDN Web Docs JavaScript guide` after a pause | `success`, 5 results (default), MDN pages first |
| `SQLite documentation` again, `max_results: 2` | `success`, exactly 2 results, recovery from the earlier 403 |

The 403 is an honest backend limitation, not a hidden success. It demonstrates the intended behavior: the tool reports `blocked`, does not retry in a loop, and does not pretend results exist.

**Page-content fetch availability.** The existing `get_single_web_page_content` path remains available and was live-checked on `https://sqlite.org/docs.html`; it returned 12,000 characters of readable text (the existing cap). Search itself still returns no page content. The supported workflow is: discover with `web_search`, then read one chosen URL with `get_single_web_page_content` or delegate that page to a worker.

## 15. Regression comparison

Baseline before Phase 2.0G:

```text
1..1388
# tests 1401
# pass 1371
# fail 30
```

Final full-suite run after implementation and test-harness correction:

```text
1..1411
# tests 1424
# pass 1397
# fail 27
```

Comparison:

- **+23 tests** (22 native search tests + 1 cloud-child search test).
- **No new failure identities.** All 27 final failures are present in the baseline failure set.
- Three baseline failures passed in the final run: two in `tests/subagentModelSelection.test.cjs` and one corresponding model-pinning case. That file is order/timing sensitive and was observed both passing and failing in repeated local runs; it is not a new regression. A direct repeat produced `14/14 pass` on one run and the same known failures on another.
- The temporary `tests/subagentTranscript.test.cjs` failure introduced by the new schema was fixed in the mock, and that file now passes `14/14` deterministically.

The complete failing identities and raw output are retained at:

```text
/tmp/opencode/baseline.txt
/tmp/opencode/baseline-fail.txt
/tmp/opencode/final2.txt
/tmp/opencode/final2-fail.txt
```

## 16. Production build and bundle impact

Command:

```bash
npm run build
```

Result: **success**, 1,820 modules transformed, built in 11.95 s.

```text
dist/assets/index-GNMV8tye.js   1,593.38 kB │ gzip: 459.99 kB
dist/assets/all-60MS4xnf.js       598.73 kB │ gzip: 215.74 kB
dist/assets/index-CSNx0AeE.css    127.24 kB │ gzip:  28.01 kB
```

Vite emitted the existing "chunks larger than 500 kB" advisory. It is a pre-existing bundling characteristic, not a search-related regression.

Bundle/dependency impact:

- **No new npm dependency.** `package.json` is unchanged.
- **No renderer bundle addition.** `webDiscovery.js` is a main-process module and is not imported by the Vite renderer build.
- **No Playwright/Chromium change.** The bundled MCP configuration is untouched.
- The new main-process source is ~20 KB (516 lines), with no binary or asset addition.

## 17. Limitations, risks, and phase boundary

### Backend risk

DuckDuckGo's HTML results page is not a supported API. Markup changes can produce `unsupported_format`; automated-looking traffic can produce `blocked` or `rate_limited`. There is no retry, proxy rotation, browser impersonation, or CAPTCHA bypass. This is intentional: the feature must fail honestly rather than evade controls.

### Coverage limits

- Only the first result page is read; there is no pagination.
- Search is English-oriented (`Accept-Language: en-US`) and sends a fixed safe-search flag.
- Result ordering and snippets are the backend's, not the app's.
- Canonical deduplication is exact after normalization; syndicated copies on different hosts remain separate results.
- Named result hosts are not resolved at discovery time. A result URL can therefore point at a hostname that later fails the page fetcher's DNS/public-address validation. That is safe — the page fetch rejects it — but the discovery list may include a URL that cannot be read.
- Search quality depends on the public backend and can degrade without any code change.

### Privacy

The query text is sent to DuckDuckGo. No conversation context, file contents, credentials, or session identifiers are included. No cookies are persisted.

### Not applicable browser states

Because no browser is used, browser navigation failures, renderer crashes, browser timeouts, and browser permission states do not exist in this path. Reporting them would be misleading; the module instead has explicit HTTP/transport outcomes.

### Phase boundary

Phase 2.0G is complete. Phase 2.1 has not been started. Recommended next work, if requested, would be a separate phase: evaluate a documented search API or a keyed provider behind the same tool contract, add opt-in locale/safe-search settings, or add multi-page result pagination — none of which is included here.

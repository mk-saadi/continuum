# Cache-Aware Token Accounting Report

Date: 2026-10-20
Phase: 2.0C-1
Status: implemented, tested, production build verified

No commit, push, stash, reset, or clean was performed. Existing unrelated
working-tree changes were left untouched.

## 1. Executive summary

Phase 2.0C-1 replaces cache-ambiguous prompt totals with an explicit accounting
contract:

- **gross input** — every prompt token the provider processed, including cache
  reads and cache writes;
- **uncached input** — the gross prompt portion the provider had to process
  without a cache hit;
- **cache reads** — the portion served from a provider prompt cache;
- **cache writes** — the portion written into a provider prompt cache;
- **visible output** — completion output excluding reasoning, when the provider
  reports both;
- **reasoning** — a measured subset of completion/output tokens, never an
  additional output total;
- **completeness and source** — whether each value was measured, estimated, only
  partially measured, or unavailable, and whether it came from a provider, local
  server timings, or was derived.

Missing provider fields are stored as `NULL`, not as measured zeros. Legacy
history rows remain readable with cache columns `NULL`. Turn aggregation sums
known phase values instead of copying the final phase's cache values over the
whole turn. The analytics UI labels unknown and partial values honestly and
withholds a cache-hit ratio unless cache reads were measured for every turn.

No prompt-caching behavior was enabled or changed. No cost estimation was added.

## 2. Objective and non-goals

### Objective

Make token accounting accurate for local and cloud chats that may or may not
report prompt caching, while preserving existing execution, prompt caching,
context management, and budget enforcement.

### Non-goals

- Do not activate Anthropic prompt caching or alter provider cache requests.
- Do not estimate monetary cost. Token counts are not converted to prices.
- Do not replace the existing Context Panel occupancy estimate with cache data.
- Do not change budget limits, enforcement, or continuation policy.
- Do not rebuild or rewrite legacy `token_usage` rows.
- Do not start Phase 2.0C-2 or Phase 2.0C-3.

## 3. Measurement vocabulary

The shared vocabulary lives in `src/lib/completionStats.mjs`:

| Value | Meaning |
| --- | --- |
| `measured` | The provider or server reported this value directly. `0` is a real measurement. |
| `estimated` | A value was derived from local accounting rather than a provider report. |
| `partially_measured` | At least one phase/bucket reported the value, but not all did. Aggregates are known subtotals. |
| `unavailable` | No phase reported the value. It is unknown, not zero. |

Reasoning telemetry keeps its existing compatibility labels (`measured`,
`partial`, `unreported`, `unavailable`) while cache coverage uses the four-value
vocabulary above. `usageSemantics` distinguishes independent per-request phases
from cumulative provider snapshots.

The central invariant is:

> A missing field is never silently promoted to a measured zero, and a known
> subtotal is never presented as a complete total.

## 4. Provider normalization matrix

`phaseStats()` recognizes the following shapes without adding cache tokens twice:

| Provider / transport | Gross input | Cache read | Cache write | Notes |
| --- | --- | --- | --- | --- |
| OpenAI-compatible | `usage.prompt_tokens` | `prompt_tokens_details.cached_tokens`, `cached_tokens` | `cache_write_tokens`, `prompt_tokens_details.cache_write_tokens` | Cached tokens are already part of gross prompt. |
| DeepSeek | `usage.prompt_tokens` | `prompt_cache_hit_tokens` | — | `prompt_cache_miss_tokens` remains derivable as gross minus reads. |
| Anthropic normalized | `prompt_tokens` folded by the cloud transport | `cache_read_input_tokens` | `cache_creation_input_tokens` | The transport adds input + read + write exactly once. |
| Anthropic raw | `input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` | Reconstructed as uncached + read + write. |
| Gemini / Google | `promptTokenCount` | `usageMetadata.cachedContentTokenCount` | — | Native count fields and `usageMetadata` are accepted. |
| local llama.cpp | `timings.prompt_n + timings.cache_n` | `timings.cache_n` | — | `prompt_n` is the processed/uncached portion; `cache_n` is the cached portion. |

Streaming and non-streaming paths both preserve these fields:

- `mergeMetrics()` merges non-negative numeric values and nested
  `prompt_tokens_details` one level deep, so split usage trailers keep cache
  details.
- Repeated cumulative snapshots replace counters; they are never added.
- `src/lib/memoryChat.mjs` also accepts `usageMetadata` for native Gemini-style
  chunk and non-streaming responses.
- `src/main/cloudProviders.js` preserves Anthropic cache counters only when the
  provider actually returned integers; it no longer coerces a missing counter to
  zero.

## 5. Per-request phase stats

Each request produces one normalized phase record through `phaseStats()`:

- prompt/gross input, completion/output, total, time, tokens per second;
- `cachedTokens` / `cacheReadTokens`;
- `cacheCreationTokens` / `cacheWriteTokens`;
- `reasoningTokens`;
- `visibleCompletionTokens` only when completion and reasoning were both
  measured (`completed - reasoning`), otherwise `null`;
- `uncachedInputTokens`;
- `inputSource`, `outputSource`, `cacheReadSource`, `cacheWriteSource`;
- `inputCoverage`, `outputCoverage`, `totalCoverage`, `cacheReadCoverage`,
  `cacheWriteCoverage`, `reasoningCoverage`;
- `usageSemantics: "per-request"`.

`visibleCompletionTokens` is deliberately not inferred from a reasoning budget.
If the provider did not separate reasoning from output, visible output stays
unknown rather than being mislabeled as all completion tokens.

## 6. Streaming merge and non-streaming paths

The accounting path is:

```text
provider SSE / JSON
  -> readCompletion() mergeMetrics()
  -> phaseStats() per request
  -> mergePhaseStats() per turn
  -> onStats()
  -> UI + SQLite token_usage
```

Key behavior:

- A usage-only chunk after the stop chunk contributes to the same phase.
- A later chunk that repeats `prompt_tokens` replaces the earlier value.
- A partial trailer does not erase a counter measured earlier in the phase.
- Non-streaming responses use the same normalization, including
  `usageMetadata`.
- `runMemoryChat()` forwards cache coverage and uncached input through its phase
  event, and includes the full normalized phase (with source fields) without
  making the phase listener part of the accounting path.

## 7. Turn aggregation and fallback correction

`mergePhaseStats()` now distinguishes two situations.

### Complete independent phases

When every phase reports gross prompt, completion, and total, the turn aggregate:

- sums gross input, completion, and total;
- sums every known cache-read and cache-write value with `sumKnown()`;
- computes `cacheReadCoverage` / `cacheWriteCoverage` as `measured`,
  `partially_measured`, or `unavailable`;
- keeps uncached input and its coverage separate, because a missing cache report
  means the uncached portion is unknown;
- sums reasoning and visible output only when every phase reported them;
- derives a mixed source as `derived` when phases disagree;
- produces `scope: "all"` and `usageSemantics: "per-request"`.

The previous last-phase fallback for cache values is gone in this branch. If the
first phase reported 40 cached tokens and the last phase reported none, the turn
still reports 40 with `partially_measured` coverage. If the first phase is
unknown and the last reports 7, the turn reports 7 with `partially_measured`
coverage; the last value is not presented as the whole turn.

### Incomplete or cumulative phases

When phases are cumulative snapshots, or any phase lacks a gross prompt,
completion, or total, the aggregate stays at the final response:

- `scope: "final"`;
- `usageSemantics: "final-request"` or `"cumulative"`;
- prompt/peak telemetry still describes all requests;
- cache values describe the final request only, never a fabricated turn sum.

This preserves valid final-answer stats when an intermediate tool phase failed
to report usage, and avoids summing running snapshots.

`cacheHitRatio()` returns a percentage only when gross input is positive, cache
reads are non-null, and cache-read coverage is fully measured. Otherwise it
returns `null`.

## 8. SQLite persistence and migration

The existing `token_usage` table was extended additively in `src/main/db.js`:

```text
uncached_input_tokens   INTEGER NULL
cache_read_tokens       INTEGER NULL
cache_creation_tokens   INTEGER NULL
reasoning_tokens        INTEGER NULL
visible_output_tokens   INTEGER NULL
input_source            TEXT NULL
cache_read_source       TEXT NULL
cache_write_source      TEXT NULL
cache_read_coverage     TEXT NULL
cache_write_coverage    TEXT NULL
usage_coverage          TEXT NULL
model_id                TEXT NULL
provider                TEXT NULL
```

- `NULL` means not reported. `0` means a measured zero.
- Migration uses `ALTER TABLE ... ADD COLUMN` only; legacy rows are not rewritten.
- A `(model_id, timestamp)` index supports model-filtered history.
- `src/main/tokenUsage.js` validates nullable counts and coverage/source values.
- Upserts use `COALESCE` so a later snapshot that omits a cache field cannot erase
  a value measured earlier for the same turn. Coverage follows the preserved
  counter.
- `src/main/ipcHandlers.js` persists the normalized turn aggregate rather than
  re-normalizing raw phases. It writes only when both gross prompt and completion
  are safe integers, because the existing row schema requires both; an unknown
  side is skipped rather than stored as a false zero.
- Model and provider are recorded for new rows; legacy rows remain `NULL` and are
  not guessed.
- Repeated snapshots for the same turn ID replace the row; regeneration uses a
  fresh turn ID.
- Retention pruning is unchanged.

## 9. History query and aggregation

`getTokenHistory()` supports the existing month/week grouping and project filter,
plus model and chat filters for concurrent-session correctness.

Per bucket it returns:

- `promptTokens` (gross) and `completionTokens`;
- `uncachedInputTokens`, `cacheReadTokens`, `cacheCreationTokens`,
  `reasoningTokens`, `visibleOutputTokens`;
- measured-turn counts for each optional counter;
- `cacheReadCoverage`, `cacheCreationCoverage`, `uncachedInputCoverage`,
  `reasoningCoverage`;
- the model/provider list for the current window.

Empty periods use `null` optional counters and `unavailable` coverage. A bucket
containing legacy rows has `cacheReadTokens = NULL` and `unavailable` coverage,
not zero. A bucket mixing measured rows and legacy/unknown rows reports the known
subtotal with `partially_measured` coverage.

## 10. Analytics UI

### TokenChart

- The prompt series is labeled **Input tokens (gross)**.
- When a bucket's cache reads and uncached input are fully measured, the gross
  input bar splits into uncached input, cached input, and a cache-write segment
  when writes were measured. Otherwise the whole gross prompt remains one bar;
  legacy and partial buckets are not drawn as if cache reads were zero.
- Tooltips show gross, cached, uncached, cache-write (when reported), completion,
  reasoning (when reported), total, and the cache-hit ratio only when valid.
- The ratio uses `cacheReadTokens / promptTokens` and is withheld for partial or
  unavailable cache coverage.

### TokenHistory

- Totals show gross prompt, cached input, uncached input, cache write, completion,
  reasoning (only when reported), and total.
- `measured` values show exact numbers; `partially_measured` values are prefixed
  with `≥`; `unavailable` values show `—`.
- A model filter is available when history rows carry model IDs.
- The cache-hit ratio line explicitly says when it is unavailable because cache
  reads were not reported for every turn.
- A disclaimer states that cached reads may still occupy the context window and
  that the ratio is not a context-occupancy measure.

## 11. Context Panel and occupancy semantics

The Context Panel continues to use its existing gross/estimated prompt occupancy.
Cache telemetry does not replace or reduce that number:

- `cachedTokens` is a provider billing/re-use fact, not an occupancy discount.
- `uncachedInputTokens` is not a substitute for context usage.
- `lastPromptTokens` remains a provider per-request observation, not the panel's
  independent occupancy estimate.

`tests/cacheTokenHistory.test.cjs` asserts that occupancy stays distinct from both
uncached input and last-prompt telemetry.

## 12. Subagent and concurrent-session accounting

- `src/main/subagents/budgets.js` recognizes OpenAI, DeepSeek, Anthropic, and
  Gemini cache-read fields.
- Each ledger records measured cache reads and unknown-cache turns separately.
- Ledger totals expose `cacheReadTokens` only when coverage is measured or
  partially measured; a ledger where no turn reported cache reads returns `null`
  with `unavailable` coverage.
- `src/main/subagents/executionBudget.js` counts cache reads as diagnostics and
  accumulates `cache_read_input_tokens` and a derived
  `uncached_input_tokens` in the child usage summary.
- Input budgets still count the full provider-reported prompt. Cache reads are
  never subtracted from the budget.
- Session/turn IDs remain the isolation boundary; concurrent chats write separate
  `token_usage` rows and history can filter by chat or model.

## 13. Budget enforcement policy

No budget policy changed:

- input limits continue to enforce gross prompt tokens;
- output limits continue to enforce measured output plus reservations;
- subagent continuation, escalation, and renewal use the same ledgers and
  thresholds;
- cache reads are recorded for diagnostics and analytics only.

This is intentional: a provider may charge less for cached input, but the model
still receives and attends to the cached context. Treating cache reads as free
would weaken an existing safety limit and would mix accounting with billing.

## 14. Tests and verification

### New focused coverage

| Test | Coverage |
| --- | --- |
| `tests/cacheTokenAccounting.test.cjs` | 13 deterministic tests: local timings, OpenAI, DeepSeek, Anthropic normalized/raw, Gemini, unknown-vs-zero, mixed-phase sums, complete sums, incomplete-phase fallback, streaming merge, reasoning subsets, ratio rules, subagent ledgers. |
| `tests/cacheTokenHistory.test.cjs` | Legacy six-column migration, nullable columns, unknown-vs-zero, mixed aggregation, model/chat/project filters, upsert preservation, Context Panel separation, restart readback. |
| `tests/cacheTokenIntegration.test.cjs` | Mocked SSE -> phase normalization -> turn aggregation -> SQLite -> history/ratio, plus a concurrent session with no cache report. |
| `tests/cacheTokenHistory.ui.cjs` | Electron UI: gross/uncached display, partial `≥` subtotal, ratio withholding, occupancy disclaimer, tooltip detail, model filter. |

Additional updates:

- `tests/cloudProviders.test.cjs` — Anthropic cache fields remain present and are
  not coerced to measured zeros.
- `tests/memoryChat.test.mjs` — exact telemetry expectation updated for the
  normalized contract.
- `tests/tokenUsage.test.cjs` — keeps the Electron stub active through
  `initDatabase`.

### Commands run

```text
node --test tests/messageStats.test.cjs \
  tests/reasoningUsage.test.cjs tests/tokenUsage.test.cjs \
  tests/cacheTokenAccounting.test.cjs tests/cacheTokenHistory.test.cjs \
  tests/cacheTokenIntegration.test.cjs tests/memoryChat.test.mjs \
  tests/cloudProviders.test.cjs
```

Result: 88/89 focused tests passed. The one failure is the pre-existing
`tests/messageStats.test.cjs` stale expectation. Its previous stats assertion is
now compatible; execution reaches a later assertion where the test does not
expect the existing `siblings` field. That remaining mismatch is unrelated to
cache accounting.

```text
node --test tests/*.test.*
```

Current result:

- 1,319 tests
- 1,293 passed
- 25 failed
- 1 skipped

Baseline before Phase 2.0C-1 work:

- 1,303 tests
- 1,275 passed
- 27 failed
- 1 skipped

The failure identities were diffed against the saved baseline. **No new failing
test was introduced.** Two baseline failures now pass:
`tests/tokenUsage.test.cjs` and the Anthropic tool-loop normalization test. The
remaining 25 failures are pre-existing and unrelated to cache accounting.

The configured `npm test` script (`node --test tests/`) fails on this Node 22
environment with `MODULE_NOT_FOUND`, so the suite was run with the explicit glob.

```text
npm run build
```

Production build passed (Vite 6.4.3, 1,810 modules transformed).

```text
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron \
  --no-sandbox tests/cacheTokenHistory.ui.cjs

env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron \
  --no-sandbox tests/tokenHistory.ui.cjs
```

Both Electron UI tests passed, including the pre-existing token history UI test.

## 15. Limitations and deferred work

- Legacy rows cannot be reconstructed. Their cache fields stay `NULL` and the UI
  says unavailable.
- A turn with an unknown gross prompt or completion is not written to
  `token_usage` because the existing row schema requires both. It is still shown
  in the live message stats. Allowing unknown gross values would require a
  separate migration and a broader history-schema change.
- `usageCoverage` is a gross prompt/completion completeness flag. Cache
  completeness is tracked independently by `cacheReadCoverage` and
  `cacheWriteCoverage`.
- Cache-hit ratio answers “how much of the gross prompt was served from cache,”
  not “how much context fits” and not “how much money was saved.”
- Anthropic cache fields are normalized only when the provider already returns
  them. No caching behavior, cache breakpoints, or cache TTL policy was added.
- No cost estimation, pricing table, or per-provider billing model was added.
- Phase 2.0C-2 and Phase 2.0C-3 were not started.
- The 25 remaining full-suite failures predate this phase and are outside its
  scope; they were left unchanged to avoid unrelated edits.

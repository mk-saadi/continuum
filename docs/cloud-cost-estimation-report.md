# Cloud API Cost Estimation — Phase 2.0C-3

Status: implemented and verified. This phase adds offline, read-only cloud cost
estimation, cache-aware billing analytics, SQLite persistence, per-message and
history UI reporting, and sub-agent cost attribution.

**No paid inference was performed.** No completion request was sent to Claude,
OpenRouter, OpenAI, or any other paid endpoint. No live stress test was run, no
paid pricing API was called, and no new hosted infrastructure was introduced.

---

## 1. Objective and scope

Continuum already records cache-aware token telemetry (Phase 2.0C-1) and shows
it in Token History and Token Chart. This phase answers the natural next
question — *what did those tokens cost, and what did caching save?* — while
keeping the same evidence discipline: an unknown price stays unknown, a local
model has no cloud charge at all, and a provider's authoritative bill is never
replaced by a locally derived guess.

In scope:

- A pure pricing resolver and cost estimator (`src/lib/cloudPricing.cjs`).
- Read-only orchestration that supplies pricing context to a settling turn
  (`src/main/costEstimator.js`).
- Additive cost columns on `token_usage` and `subagent_runs`, plus one new
  `provider_id` column.
- Cost aggregation in token history, including sub-agent roll-up and model
  breakdown.
- Cost surfaces in the per-message footer, Token History, Token Chart, and
  optional per-provider rate inputs in Cloud Provider settings.
- Deterministic tests for the required scenarios.

Out of scope / explicitly not done:

- No new inference, caching, or compaction behavior. Budgets and token
  enforcement are unchanged; the budget ledger keeps its exact
  `{ input, output, cachedInput, reasoning }` contract.
- No automatic spending controls, quotas, or alerts.
- No major UI redesign — cost is added to existing panels.
- No hosted service, telemetry upload, or background polling.

---

## 2. Constraints and invariants

These rules hold everywhere in the phase and are what the tests assert.

- **Offline and free.** Pricing math is pure. Nothing in a cost path performs a
  network call. The asynchronous OpenRouter metadata refresh reuses the same
  cached, bounded fetch the settings screen already uses; a failed or missing
  fetch degrades to the provider-reported or `unavailable` path and never blocks
  or delays a turn.
- **No invented prices.** A price is only used when there is explicit evidence:
  an exact verified catalog ID, live provider metadata, a user-typed rate, or a
  provider-reported charge. Prices are never inferred from a similar model name.
  `claude-sonnet-5` and `claude-sonnet-5.5` are different keys; only the first is
  catalogued, and the second resolves to `unavailable`.
- **Unknown ≠ zero.** A missing counter or a missing rate is `null` and is never
  coerced to `0`. A *measured* zero is stored as `0` and is visibly different
  from `null` through the coverage/completeness labels.
- **Local ≠ $0.00.** A local model resolves to `not_applicable` with
  `totalCost = null`. Its cloud charge does not exist, which is a different
  statement from a measured `$0.00` API cost.
- **Provider bill wins.** When a gateway reports an authoritative per-request
  charge (OpenRouter `usage.cost`), it is the total. The rate-based estimate is
  retained beside it for audit but never overrides it.
- **Historical evidence is preserved.** Cost rows are written once and never
  recalculated from current rates. An upsert that omits cost never erases an
  earlier estimate.

---

## 3. Pricing evidence sources and precedence

`resolvePricing(context, deps)` resolves a descriptor in this precedence order:

| Order | Source | `status` | When it applies |
|---|---|---|---|
| 1 | `not-applicable` | `not_applicable` | Route is local. Short-circuits everything else. |
| 2 | `user-configured` | `available` | The saved provider has valid user rates (both input **and** output). Overrides the catalog. |
| 3 | `anthropic-catalog` / `openai-catalog` | `available` | Route is direct Anthropic/OpenAI and the model ID is an exact catalog key. |
| 4 | `openrouter-metadata` | `available` | Route is OpenRouter and live metadata yields valid input+output rates. |
| 5 | `provider-reported` | `available` | No rate evidence, but the turn carries a provider-reported charge. Applied at estimation time. |
| 6 | `unavailable` | `unavailable` | No explicit evidence. `totalCost = null`, never a fabricated zero. |

Each descriptor records `source`, `currency` (`USD`), `unit`
(`per_million_tokens`), a `version` string, and the effective rates. The version
is persisted with every row so a historical cost can be explained later without
re-deriving it from whichever rates happen to be cached now.

---

## 4. Verified direct-provider catalog

Only exact model IDs with independently verified rates are catalogued. All
values are **USD per million tokens**.

### Anthropic — `anthropic-catalog:2026-04-01`

| Model ID | input | output | cacheRead | cacheWrite (5m) | cacheWrite1h |
|---|---|---|---|---|---|
| `claude-sonnet-5` | 2 | 10 | 0.2 | 2.5 | 4 |

`cacheWrite` is the 5-minute ephemeral write premium; `cacheWrite1h` is the
longer-TTL write premium where the provider distinguishes it.

### OpenAI — `openai-catalog:2026-04-01`

| Model ID | input | output | cacheRead | cacheWrite | Long-context tier |
|---|---|---|---|---|---|
| `gpt-5` | 1.25 | 10 | 0.125 | `null` | above **272,000** input tokens: input 2.5, output 15, cacheRead 0.25 |

A `null` cache-write rate means the provider has no separate cache-write charge;
that counter, when present, is billed at the ordinary input rate. The
long-context tier applies only when gross input is **strictly greater** than the
threshold; at exactly 272,000 the standard rates apply. `gpt-5`'s `cacheWrite`
stays `null` in both tiers.

Adding a model to the catalog is a deliberate act backed by verified rates. The
catalog is intentionally tiny — under-claiming is always preferred to inventing
a plausible-looking number.

---

## 5. OpenRouter pricing

OpenRouter speaks an OpenAI-compatible dialect but bills differently, so it is
routed and priced separately. Its own model metadata is the evidence source.

- **Normalization.** OpenRouter reports decimal-string prices *per token*. They
  are upscaled once to the canonical per-million unit and snapped to nine
  decimals, because `0.000002 * 1e6` is `2.0000000000000004` in floating point
  and downstream money math must not accumulate that noise. `prompt` →
  `input`, `completion` → `output`, `input_cache_read` → `cacheRead`,
  `input_cache_write` → `cacheWrite`, `input_cache_write_1h` → `cacheWrite1h`.
- **Conditional overrides.** Metadata may carry an `overrides` array. Each entry
  applies when its `min_prompt_tokens` is **strictly exceeded** (strict
  greater-than) and, when present, when the request time falls inside a UTC
  window that may wrap midnight. Overrides are applied in array order and each
  overwrites only the keys it defines, so a partial override composes with the
  base and with earlier overrides.
- **Provider-reported charge.** OpenRouter returns an authoritative per-request
  `usage.cost`. When present it becomes `totalCost` and the source is
  `provider-reported`; the rate-based figure is kept as `estimatedTotal` for
  audit. When it is absent, the normalized metadata estimate is used.
- **Never confused with direct Anthropic.** OpenRouter's host
  (`openrouter.ai`, including subdomains) is detected before the `apiType`
  check, so an OpenRouter Claude request is billed as `openrouter-metadata` and
  never as `anthropic-catalog`.

---

## 6. User-configured rates

The Cloud Provider settings screen offers optional per-provider rates in USD per
million tokens: input, output, cache read, cache write. Rules:

- A user rate set is usable only when **both input and output** are valid,
  non-negative finite numbers. Without both, the override is declined and the
  resolver falls through to the catalog/metadata/unavailable path — a
  half-entered rate is never treated as a `$0` rate.
- Cache fields are optional; an omitted cache rate falls back to the catalog
  or input rate at estimation time.
- `undefined` (field untouched) keeps any previously saved rates; blanking a
  field clears it. Blank fields are absent evidence, not zero.

User rates sit *above* the catalog in precedence, so a user who knows their
negotiated or self-hosted price can override a catalog entry. Nothing about this
control spends money or fetches anything.

---

## 7. Route detection

`detectRoute({ apiType, baseUrl, isLocal })` classifies a turn:

1. `isLocal` → **local**.
2. Host is `openrouter.ai` or a subdomain → **openrouter**.
3. `apiType === 'anthropic'` or host is `api.anthropic.com` → **anthropic**.
4. Host is `api.openai.com` → **openai**.
5. `apiType === 'openai'` with a non-empty non-OpenAI host → **custom**
   (any other OpenAI-compatible endpoint).
6. Otherwise → **unknown**.

Host parsing is defensive: a malformed `baseUrl` yields no host and falls
through rather than silently matching the wrong provider. Only **anthropic** and
**openai** routes consult the verified catalog; **custom** and **unknown**
routes have no catalog and resolve to user rates, provider-reported cost, or
`unavailable`.

---

## 8. Usage counters and the unknown-vs-zero contract

`normalizeUsage` produces canonical counters, each `null` when unreported:

- `uncachedInputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `cacheWrite1hTokens`
- `outputTokens` (aliases `completionTokens` / `completion_tokens`)
- `reasoningTokens`
- `grossInputTokens` (aliases `promptTokens` / `prompt_tokens`)
- `providerReportedCost`

A non-negative safe integer is accepted; anything else (negative, `NaN`,
`Infinity`, a fractional token count, a string) is treated as absent. Money
(`providerReportedCost`) accepts any non-negative finite number.

The gross prompt is the sum of its parts: `gross = uncached + cacheRead +
cacheWrite + cacheWrite1h`. The estimator uses this relationship to detect a
genuinely partial bill (see §9).

---

## 9. Estimation formula

For an `available` descriptor, `estimateUsageCost` converts per-million rates to
per-token rates once and computes:

```
uncachedCost  = uncachedInputTokens     * inputRate
cacheReadCost = cacheReadTokens         * (cacheReadRate  ?? inputRate)
cacheWriteCost   = cacheWriteTokens     * (cacheWriteRate ?? inputRate)
cacheWrite1hCost = cacheWrite1hTokens   * (cacheWrite1hRate ?? cacheWriteRate ?? inputRate)
outputCost    = outputTokens            * outputRate

totalCost = providerReportedCost ?? (uncachedCost + cacheReadCost
                                     + cacheWriteCost + cacheWrite1hCost + outputCost)
```

Rules that keep the total honest:

- **Missing counter.** If a counter that should have been reported is `null`,
  its component is `null`, its label is added to `missing`, and the total is not
  reported as complete.
- **Unreported cache reads are not silently zero.** When the provider reports no
  cache-read counter, the read cost is charged as `0` **only if** the gross
  prompt proves nothing was cached. If `gross > uncached + cacheWrite +
  cacheWrite1h` there is an unaccounted cached portion, so the bill is marked
  partial (`missing` includes `cache_read`) and the total is never understated.
- **Rounding.** The edge rounds `totalCost`, `estimatedTotal`, and
  `cacheSavings` to six decimals (half a micro-dollar) — enough to keep a single
  tiny turn non-zero without claiming precision the rates do not have.
  Component costs are kept unrounded for display and aggregation.

### Completeness labels

| Label | Meaning |
|---|---|
| `complete` | A total is known and `missing` is empty. |
| `partial` | A total or at least one real component is known, but the whole picture is not. |
| `unavailable` | No total and no usable component. |
| `not_applicable` | A local model; no cloud charge exists at all. |

A partial result never upgrades missing data to complete, and never downgrades a
real subtotal to `unavailable`.

---

## 10. Cache savings (can be negative, zero, or positive)

Savings compares the actual input cost with what the same prompt would have cost
with no cache at all:

```
baseline    = grossInputTokens * inputRate
actualInput = uncachedCost + cacheReadCost + cacheWriteCost + cacheWrite1hCost
cacheSavings = round6(baseline - actualInput)
```

`cacheSavings` is computed only when gross, uncached, input rate, and the read
cost are all known. It is reported honestly:

- **positive** — reads replaced full-price input (caching paid off),
- **zero** — nothing was cached,
- **negative** — a cache write that was never read back cost more than not
  caching (a real, common case).

Negative savings are never clamped to zero.

---

## 11. Reasoning tokens are a subset of output

Reasoning tokens are a measured *subset* of output/completion tokens. The
estimator exposes `components.reasoning = reasoningTokens * outputRate` as an
informational split for display only. It is **never added** to `totalCost`, and
it never inflates the output charge. It also does not affect cache savings.

---

## 12. Persistence schema and additive migration

Two tables gain cost evidence and one gains a provider identity. All additions
are nullable and additive; there is no table rebuild and existing rows are never
rewritten or recalculated.

**`token_usage`** (per parent turn) and **`subagent_runs`** (per child run) each
gain:

```
cost_total, cost_currency, cost_status, cost_completeness, cost_source,
cost_version, cost_timestamp,
cost_uncached_input, cost_cache_read, cost_cache_write, cost_cache_write_1h,
cost_output, cost_reasoning, cost_cache_savings, cost_provider_reported,
cost_breakdown
```

`subagent_runs` also gains `provider_id`. `cost_breakdown` is a JSON string
holding the estimator `version`, `source`, `completeness`, `missing` labels, and
the effective `rates`, so a stored row is self-explaining.

Migration is idempotent: `initDatabase` reads `PRAGMA table_info`, adds only the
columns that are missing, and creates supporting indexes
(`idx_token_usage_model_time`, `idx_subagent_runs_parent_time`). Legacy rows
keep `NULL` cost columns, which history labels `unavailable` — never a
backfilled zero.

The token-usage upsert uses `COALESCE(excluded.<col>, <table>.<col>)` for every
cost and cache column, so a later cumulative snapshot that omits cost evidence
cannot erase an earlier estimate. A measured zero still updates because `0` is
not `NULL`.

---

## 13. Sub-agent attribution and continuation

Child (sub-agent) runs are attributed to their parent session so that a parent's
history includes its children's cost **exactly once**:

- Each child is a single `subagent_runs` row keyed by `child_session_id`.
  Resumed or recovered runs **update** that row (upsert), so continuation never
  adds a second entry or doubles a parent total.
- The history query joins `subagent_runs` to `sessions` on
  `parent_session_id`, buckets child cost by the child's `completed_at`, and
  merges it into the parent period. A child belonging to a different parent
  never leaks into this parent's history.
- Child **tokens** are intentionally not folded into the parent's token columns;
  only **cost** is merged. Child models are added to the model list so a
  child-only model stays filterable.
- Child pricing uses the child's own `provider_id` / model / local flag. A local
  child resolves to `not_applicable` and is excluded from billable coverage.
- Coverage counts only **billable** (cloud) turns. Local `not_applicable` rows
  never drag a real total down to `partial`.

This supports mixed local/cloud parents and children, concurrent children, and
continued/recovered runs without duplicate aggregation.

---

## 14. UI surfaces

All money formatting flows through one source of truth
(`cloudPricing.formatUsd` / `formatSignedUsd`, re-exported by
`src/lib/costFormat.mjs`), so the estimator's rounding and the UI never drift.

- **Per-message footer (`ChatMessage.jsx`).** A cost chip beside the token
  stats. Its tooltip names the source (provider-reported vs estimated), flags
  `partial`, reports cache savings (signed), and — for a local turn — states
  explicitly that there is no cloud charge. Local turns read
  `Cloud cost n/a (local)`, never `$0.00 operating cost`.
- **Token History (`TokenHistory.jsx`).** A "Estimated cloud cost (USD)" panel
  with total, cache savings, provider-reported subtotal, and component
  breakdown (uncached input, cache reads, cache writes, output), plus a
  per-model cost table and coverage wording. `not_applicable` turns are
  explained as "not applicable, not $0.00". A model filter was also added.
- **Token Chart (`TokenChart.jsx`).** Tooltip and ARIA label include the
  period's estimated cloud cost when at least one turn was priced; a
  local-only period shows `n/a` rather than `$0.00`.
- **Cloud Provider settings (`CloudProviderSettings.jsx`).** Optional
  input/output/cache-read/cache-write rate fields, labelled "used for cost
  estimates only".

### Tiny-nonzero formatting

`formatUsd` never rounds a small non-zero charge to `$0.00`:

| Magnitude | Example output |
|---|---|
| `0` | `$0.00` |
| `< 0.0001` | `< $0.0001` |
| `< 0.01` | up to 5 decimals, trailing zeros trimmed |
| `< 1` | up to 4 decimals, trailing zeros trimmed |
| `≥ 1` | 2 decimals |

A `null`/non-finite value formats as `—`. `formatSignedUsd` prefixes `+`/`-`
for signed savings.

---

## 15. Tests and verification

All tests are deterministic — no network, no inference, fixed clocks.

**`tests/cloudPricing.test.cjs`** — 23 pure pricing/estimation scenarios:

1. Direct Anthropic exact ID resolves from the verified catalog
2. An unlisted Anthropic version is unavailable, never inferred from a similar name
3. Anthropic cache reads billed at the cache-read rate
4. Anthropic cache writes billed at the 5-minute write premium
5. Cache savings positive when reads replace full-price input
6. Cache savings negative when a write is never read back
7. Cache savings exactly zero when nothing was cached
8. The 1-hour cache-write premium billed separately when reported
9. Direct OpenAI exact ID resolves from the verified catalog
10. OpenAI long-context pricing applies only above the documented threshold
11. OpenAI cache reads billed at the discounted cached rate
12. OpenRouter per-token metadata normalized to per-million rates
13. OpenRouter provider-reported charge is authoritative over the estimate
14. OpenRouter conditional override wins only above its `min_prompt_tokens`
15. OpenRouter UTC time-window override applies and wraps midnight
16. OpenRouter Claude billed as OpenRouter, never as direct Anthropic
17. User-configured rates override the catalog
18. User rates without both input and output are refused, not treated as zero
19. A local model has no cloud charge — not applicable, never `$0.00`
20. Reasoning tokens are a subset of output and never added twice
21. Tiny non-zero costs format precisely and never as `$0.00`
22. A missing counter makes the estimate partial, not a false total
23. An unknown route/model has no price evidence and stays unavailable

**`tests/cloudCostEstimation.test.cjs`** — persistence, migration, attribution,
mixed local/cloud coverage, continuation without duplicate aggregation, provider
cost phase aggregation, and billing-evidence extraction held separate from the
budget ledger.

**`tests/cloudCostHistory.ui.cjs`** (+ fixture) — renders the history panel and
chart: total, savings, local "not applicable", tiny-cost formatting, model cost
table, and chart tooltip.

**`tests/cloudProviders.test.cjs`** — appended round-trip for optional cost
rates and refusal of malformed rates.

Verification results:

- **Focused suite.** `node --test tests/cloudPricing.test.cjs
  tests/cloudCostEstimation.test.cjs tests/tokenUsage.test.cjs
  tests/cacheTokenHistory.test.cjs tests/cloudProviders.test.cjs` → **45 pass,
  0 fail**.
- **Cost UI test.** `tests/cloudCostHistory.ui.cjs` → pass.
- **Production build.** `npm run build` (vite) → **exit 0**, 1813 modules
  transformed.
- **Full suite.** `node --test tests/*.test.*` → 1392 tests, 1366 pass, 25 fail,
  1 skip. The 25 failing test identities **exactly match the pre-change
  baseline** (`/tmp/opencode/baseline-failures.txt`): no new failures, none
  fixed. These are pre-existing failures unrelated to cost work.

### Known pre-existing failures (not addressed by this phase)

- **`tests/memorySettings.ui.cjs`** exits 1 with `Expected nine tabs`. Root
  cause: the fixture `tests/fixtures/memorySettings.jsx` does not stub
  `window.api.getSubagentBudgets`, which `SubagentBudgetSettings.jsx` calls.
  The missing stub throws during render, React unmounts the dialog, and the tab
  count is `0`. Both the bridge method (commit `6c961b1`, the subagent-reliability
  phase) and the fixture predate this phase and are untouched by it. Left
  unfixed deliberately to avoid unrelated UI churn.
- The 25 `.test.*` failures in the baseline list are likewise pre-existing and
  unchanged.

`npm test` itself is broken on the current Node 22 runtime
(`MODULE_NOT_FOUND`); the suites were run directly with `node --test`.

---

## 16. Worked examples and limitations

### 16a. Worked synthetic example — Anthropic `claude-sonnet-5`

Rates (USD per million tokens): input `2`, output `10`, cacheRead `0.2`,
cacheWrite `2.5`.

One turn reports gross prompt `10,000` = uncached `3,000` + cache read `6,000`
+ cache write `1,000`; output `500`; reasoning `200` (a subset of output).

| Component | Tokens | Rate / MTok | Cost |
|---|---|---|---|
| Uncached input | 3,000 | 2 | `$0.006` |
| Cache read | 6,000 | 0.2 | `$0.0012` |
| Cache write (5m) | 1,000 | 2.5 | `$0.0025` |
| Output | 500 | 10 | `$0.005` |
| **Total** | | | **`$0.0147`** |

- Reasoning component (informational, not added): `200 * 10 / 1e6 = $0.002`.
- Cache savings: baseline `10,000 * 2 / 1e6 = $0.02`; actual input
  `0.006 + 0.0012 + 0.0025 = $0.0097`; **savings `+$0.0103`**.
- Completeness: `complete` (all counters present, no `missing` labels).
- UI: footer chip `$0.0147`; history component breakdown shows uncached `$0.006`,
  cache reads `$0.0012`, cache writes `$0.0025`, output `$0.005`, and cache
  savings `+$0.0103`.

### 16b. Worked synthetic example — OpenRouter with a provider charge

Metadata normalizes a per-token prompt price of `0.000002` to `$2` per million
and a completion price of `0.00001` to `$10` per million. The request returns
`usage.cost = 0.002`.

Result: `totalCost = $0.002` with source `provider-reported`; `estimatedTotal`
holds the rate-based figure for audit. The provider's bill wins.

### 16c. Unavailable-price example

A custom OpenAI-compatible endpoint serves `my-finetune-v3`. Its host is not
`api.openai.com`, so the route is **custom**; the model is not in any catalog,
no user rates are set, and the gateway reports no `usage.cost`.

Result: `status = unavailable`, `completeness = unavailable`,
`totalCost = null`, `missing = ['price']`. The per-message chip reads
`Cost unavailable`, Token History shows `—`, and cost coverage for those turns
is `unavailable` with the note that their cost is unknown, never zero. No price
is invented from the model name.

### 16d. Limitations and honest unknowns

- The verified catalog is intentionally small. Anything not exactly catalogued
  on a direct Anthropic/OpenAI route, and anything on a custom/unknown route
  without user rates or a provider charge, is reported as unknown rather than
  guessed. Users can supply rates to fill the gap.
- OpenRouter estimates depend on the last successful metadata fetch. If
  metadata is not yet cached and the gateway reports no charge, the turn is
  `unavailable` for that settlement; a later turn with cached metadata prices
  normally. No cost path adds a blocking network call to fix this mid-turn.
- Rates are point-in-time. Historical rows keep the version, source, and
  effective rates they were priced with; they are never recalculated.
- Cache savings is a billing/re-use comparison, **not** a context-occupancy
  measure — cached reads may still occupy the context window. The UI says so
  explicitly wherever the ratio is shown.
- Reasonings and cache-write TTL premiums are only reported when the provider
  reports the underlying counters; absence is surfaced as `partial`/`missing`,
  never as zero.

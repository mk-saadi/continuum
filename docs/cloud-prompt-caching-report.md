# Provider-Aware Cloud Prompt Caching Report

Date: 2026-10-20
Phase: 2.0C-2
Status: implemented, deterministic tests passing, live behavior verified within budget, production build passing

No commit, push, stash, reset, or clean was performed. All pre-existing
working-tree changes were preserved. Phase 2.0C-3 was not started.

## 1. Executive summary

Phase 2.0C-2 turns prompt caching into a property of the **actual request
target** rather than a client-wide setting. A single resolver,
`src/lib/promptCaching.cjs`, maps `(apiType, baseUrl, modelId)` to the cache
fields that provider documents, and `createCloudFetch` applies them to the
outgoing body for both the main chat and subagent cloud paths.

Resulting behavior:

| Target | Cache request field | Caching mode |
| --- | --- | --- |
| Direct Anthropic Messages API | top-level `cache_control: { type: "ephemeral" }` | automatic, one server-placed breakpoint |
| OpenRouter `anthropic/...` / `~anthropic/...` | top-level `cache_control: { type: "ephemeral" }` | automatic, one server-placed breakpoint |
| OpenRouter MiMo, DeepSeek, Gemini, and other implicit families | none | automatic server-side |
| OpenAI / DeepSeek / Gemini direct-compatible | none | automatic server-side |
| Unknown OpenAI-compatible endpoint | none (safe fallback) | unknown; no field invented |

No duplicate breakpoints, no per-block breakpoints, no 1-hour TTL, and no
prompt-construction change were introduced. A child agent resolves caching from
its own target, so an Anthropic parent can never leak Anthropic-only cache
parameters into an OpenRouter child request.

Deterministic coverage is 23 new tests (all passing). The full suite count moved
from 1319 to 1342 with the same 25 pre-existing failures and no new ones.
Production `vite build` passed. Live verification used exactly 26 requests and
about **$0.0333** combined, inside the 26-request / $0.50 budget.

MiMo and DeepSeek both produced provider-confirmed cache reads. Direct Claude
accepted the field and produced cache **writes**, but the two-request cap was
exhausted before a read could be demonstrated; that limitation is reported
honestly in sections 13 and 16 rather than papered over.

## 2. Objective and non-goals

### Objective

- Enable prompt caching where the provider supports it, resolved per actual
  provider and model.
- Preserve MiMo and DeepSeek automatic caching without adding unsupported
  fields.
- Preserve streaming, reasoning/thinking, tool-use and tool-result blocks,
  context compaction, message ordering, and Phase 2.0C-1 accounting.
- Verify deterministic behavior first, then a bounded amount of live behavior.
- Document capability, evidence, spend, and remaining limits.

### Non-goals

- No new cloud provider or caching service.
- No token-history redesign and no cost-estimation UI.
- No compaction-policy change and no broad agent-loop refactor.
- No 1-hour cache TTL and no explicit per-block breakpoints.
- No duplicate cache breakpoints.
- No prompt-construction rewrite for cache alignment.
- No Phase 2.0C-3 work.

## 3. Provider and model capability matrix

Configured targets inspected on 2026-10-20:

| Provider record | Model ID | Transport | Base URL | Cache behavior |
| --- | --- | --- | --- | --- |
| Claude (`63dce8bb-…`) | `claude-sonnet-5` | Anthropic Messages | `api.anthropic.com` | explicit opt-in via top-level ephemeral field |
| MiMo (`dba1eefa-…`) | `xiaomi/mimo-v2.6-flash` | OpenRouter | `openrouter.ai/api/v1` | automatic server-side, no field |
| DeepSeek (`563c28af-…`) | `deepseek/deepseek-v4.1-flash` | OpenRouter | `openrouter.ai/api/v1` | automatic server-side, no field |
| Gemini | `google/gemini-2.5-flash-lite` | OpenRouter | `openrouter.ai/api/v1` | automatic server-side, no field |

Capability resolution:

| Family | `mode` | `explicitBreakpoints` | Reads reported | Writes reported |
| --- | --- | --- | --- | --- |
| `anthropic` | `automatic` | `false` | yes | yes |
| `openrouter` + `anthropic/*` | `automatic` | `false` | yes | yes |
| `openrouter` + other model | `automatic` | `false` | yes | no |
| `openai` | `server-side` | `false` | yes | yes |
| `deepseek` | `server-side` | `false` | yes | no |
| `gemini` | `server-side` | `false` | yes | no |
| unknown compatible | `unknown` | `false` | unknown | unknown |

`cacheCapability()` is descriptive only. `cacheRequestFields()` is the single
source of wire behavior, which prevents the reporting view from drifting from
what is actually sent.

## 4. Implementation design

### 4.1 New module: `src/lib/promptCaching.cjs`

- `openRouterAnthropic(modelId)` matches `anthropic/` and the `~anthropic/`
  newest-alias form by prefix. New Claude versions work without a model list
  edit.
- `cacheRequestFields({ apiType, baseUrl, modelId })` returns either
  `{ cache_control: { type: "ephemeral" } }` or `{}`.
- `cacheCapability({ … })` returns the human/test view described above.
- The module reuses `providerFamily()` from `reasoningControls.cjs` so provider
  classification has one implementation.

The only cache policy encoded is the default 5-minute ephemeral TTL. No
`ttl: "1h"` is emitted anywhere.

### 4.2 Integration point: `src/main/cloudProviders.js`

`createCloudFetch(target, …)` already receives the resolved target, so the cache
decision is made once, immediately before the body is built:

```js
const cacheFields = promptCaching.cacheRequestFields({
  apiType: provider.apiType, baseUrl: provider.baseUrl, modelId: target.model,
});
```

It is then merged into:

- the Anthropic payload: `{ ...anthropicPayload(original, target.model), ...cacheFields }`
- the OpenAI-shaped payload: `...mapped.fields, ...cacheFields`

This is deliberately the same function used by main chat and by
`src/main/subagents/providers/cloudProvider.js`, which calls
`createCloudFetch(engine.chatTarget)`. There is no parent-to-child inheritance
path for cache parameters.

### 4.3 Why a top-level field instead of a system breakpoint

Anthropic's automatic caching places one breakpoint on the last cacheable block
and advances it as the conversation grows. Adding explicit `cache_control`
objects to system blocks would consume the four-breakpoint budget and risk
duplicate breakpoints, which the phase explicitly forbids. The top-level
ephemeral field is therefore the only Anthropic cache addition.

## 5. Anthropic direct behavior

For a direct Anthropic target the request carries exactly one top-level field:

```json
{ "cache_control": { "type": "ephemeral" } }
```

Nothing is added inside `system`, `messages`, `tools`, or content blocks. The
cache-eligible minimum for Sonnet 5 is 1,024 input tokens; below that the field
is accepted but no caching occurs. The adapter does not synthesize a minimum or
pad prompts.

Anthropic usage mapping was also tightened so accounting stays honest:

- gross `prompt_tokens` = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- `cache_read_input_tokens` and `cache_creation_input_tokens` are copied only
  when the provider reported a safe integer, otherwise they remain absent
  (`NULL` downstream), never a measured zero.

This preserves the Phase 2.0C-1 invariant and prevents double counting.

## 6. OpenRouter Anthropic behavior

OpenRouter Claude IDs are matched by prefix:

- `anthropic/claude-…`
- `~anthropic/claude-…`

Both receive the same top-level ephemeral field as the direct API and nothing
else. This is resolved from the child's own `target.model`, so a request to
`xiaomi/…` or `deepseek/…` can never carry it.

## 7. MiMo and DeepSeek automatic caching

Neither family receives a cache field. Their caching is provider-side and
prefix-based, so the safest compatible request is the one without Anthropic-only
keys. This is also why the previous behavior keeps working: the new code adds
`{}` and the body is byte-identical to the pre-change body.

Observed live reads confirm the providers still cache automatically (section 13).

## 8. Unknown and unsupported fallbacks

- Unknown OpenAI-compatible endpoints return `{}`. No cache field is invented.
- A model that reports no cache metrics is left `unavailable`, not zero.
- Providers that do not report writes are not given a synthetic write count.
- A provider that rejects the cache field surfaces the HTTP error cleanly with
  no retry (covered by a deterministic test).

## 9. Preservation of existing behavior

| Behavior | Preservation |
| --- | --- |
| Streaming | cache field added before transport; SSE path unchanged; deterministic stream test passes |
| Non-streaming JSON | same body builder; deterministic JSON test passes |
| Reasoning / thinking | `cloudRequestFields()` output and Anthropic thinking blocks unchanged; tests cover both |
| Tool use / tool results | tool and tool-result blocks unchanged; Anthropic and OpenRouter tests pass |
| Context compaction | compacted history keeps stable system-first ordering; cache field still applied |
| Message ordering | no reordering, no new messages, no injected prompt text |
| Phase 2.0C-1 accounting | Anthropic counters are additive and conditionally present; normalization tests pass |
| Subagent isolation | child resolves from its own target; concurrent parent/child test passes |

The adapter adds no per-request dynamic content; the temporal anchor in
`src/main/baseSystemPrompt.js` is stable within a day, so it does not invalidate
the prefix on every call.

## 10. Deterministic test coverage

File: `tests/cloudPromptCaching.test.cjs` — 23 tests, 23 passing.

| # | Test | What it proves |
| --- | --- | --- |
| 1 | direct Anthropic enables one top-level ephemeral breakpoint | field shape and single occurrence |
| 2 | Anthropic tool-use and tool-result survive the cache field | tool blocks untouched |
| 3 | Anthropic models on OpenRouter receive the field | route-aware opt-in |
| 4 | `~anthropic` alias is treated as Anthropic | prefix alias handling |
| 5 | MiMo stays compatible | no field added |
| 6 | DeepSeek stays compatible | no field added |
| 7 | capabilities resolve per family and route | matrix correctness |
| 8 | unsupported/unknown never receive an invented field | safe fallback |
| 9 | cache control independent of streaming/JSON transport | both transports |
| 10 | multi-turn growth keeps a stable prefix | no prefix mutation |
| 11 | adapter adds no dynamic prompt content | determinism |
| 12 | Anthropic thinking and cache control coexist | no duplication |
| 13 | OpenRouter reasoning preserved, no cache field | reasoning compatibility |
| 14 | compacted conversation still receives the field | compaction compatibility |
| 15 | child resolves from its own target, not the parent | no parameter inheritance |
| 16 | concurrent Anthropic + OpenRouter agents stay independent | isolation |
| 17 | OpenRouter reads/writes normalize into phase stats | accounting |
| 18 | Anthropic reads/writes distinct, not double counted | accounting |
| 19 | no reported metrics stays unknown, not zero | honest missing data |
| 20 | rejected request surfaces a clean error with no retry | no retry loop |
| 21 | cancellation propagates before the field is sent | abort safety |
| 22 | normalized metrics feed 2.0C-1 aggregation/ratio | integration |
| 23 | temporal anchor stable within a day | prefix stability |

Focused run:

```
$ node --test tests/cloudPromptCaching.test.cjs
# tests 23
# pass 23
# fail 0
```

Full suite comparison:

| Run | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- |
| Baseline before changes | 1319 | 1293 | 25 | 1 |
| After Phase 2.0C-2 | 1342 | 1316 | 25 | 1 |

The 25 failures are pre-existing and unchanged. They include the known
`cloud settings persist privately and cloud chat works without a local engine`
failure and eleven test files that cannot load under the current harness. No new
failure was introduced. `npm test` remains broken on Node 22
(`MODULE_NOT_FOUND`), so the suite was run as `node --test tests/*.test.*`.

Production build:

```
$ npx vite build
✓ built in ~20.8s
```

## 11. Live verification methodology

Harness: `/tmp/opencode/live-cache-test.cjs` (temporary, not part of the
repository).

- Reads `cloud-providers` from
  `~/.config/Continuum/memory_palace.db` in **read-only** mode.
- Never prints API keys, authorization headers, private data, or response
  bodies; only normalized token counts, provider name, and derived cost.
- Uses the real production adapter (`createCloudFetch` + `readCompletion`), so
  the request body and usage parsing are the shipped code.
- Synthetic prompt only: a fixed ~5,324-token prefix plus numbered suffixes such
  as `Reply with the single word ONE.`
- One request per scenario, explicit `max_tokens` (48), 90-second timeout, no
  retries.
- Prices for cost estimates taken from OpenRouter `/api/v1/models` and
  Anthropic's published table on 2026-10-20:

| Model | Input /M | Output /M | Cache read /M | Cache write /M |
| --- | --- | --- | --- | --- |
| `xiaomi/mimo-v2.6-flash` | $0.14 | $0.28 | $0.0028 | not reported |
| `deepseek/deepseek-v4.1-flash` | $0.028 | $0.08 | $0.0016 | not reported |
| `claude-sonnet-5` | $2.00 | $10.00 | $0.20 | $2.50 |

Request budget:

| Provider | Allowed | Used |
| --- | --- | --- |
| MiMo | ≤ 12 | 12 (1 probe + 11 scenarios; one scenario skipped after the probe) |
| DeepSeek | ≤ 12 | 12 |
| Direct Claude | ≤ 2 | 2 |
| OpenRouter Claude | 0 | 0 |
| **Total** | **≤ 26** | **26** |

## 12. Live results — MiMo (`xiaomi/mimo-v2.6-flash`)

All requests carried no cache field. Provider routing is reported because it
changed between identical prefixes.

| Scenario | Prompt | Cache read | Cache write | Uncached | Output | Provider | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 initial prefix | 3,997 | **3,996** | 0 | 1 | 16 | Relace | $0.00001581 |
| 2 repeat prefix | 3,997 | 0 | 0 | 3,997 | 33 | Xiaomi | $0.00056882 |
| 3 prefix reuse | 3,997 | 0 | 0 | 3,997 | 13 | Venice | $0.00056322 |
| 4 multi-turn | 4,037 | **3,968** | 0 | 69 | 13 | DeepInfra | $0.00002441 |
| 5 append small | — | — | — | — | — | skipped | — |
| 6 tool continuation | 4,141 | 1 | 0 | 4,140 | 23 | Relace | $0.00058604 |
| 7 repeat after tool | 4,139 | 1 | 0 | 4,138 | 14 | Relace | $0.00058324 |
| 8 streaming | 3,998 | **3,968** | 0 | 30 | 29 | DeepInfra | $0.00002343 |
| 9 non-streaming | 3,998 | 1 | 0 | 3,997 | 48 | Relace | $0.00057302 |
| 10 reasoning | 3,997 | 1 | 0 | 3,996 | 16 | Relace | $0.00056392 |
| 11 changed prefix | 4,001 | 0 | 0 | 4,001 | 16 | Venice | $0.00056462 |
| 12 final reuse | 3,999 | **3,968** | 0 | 31 | 20 | Venice | $0.00002105 |

Interpretation:

- **Cache reads confirmed** on four requests (3,996 / 3,968 / 3,968 / 3,968).
- No cache writes were reported by any routed provider; MiMo's OpenRouter
  providers do not expose a write counter.
- Scenario 11 used a deliberately different prefix and correctly produced zero
  reads, confirming the reads are prefix-driven rather than a constant.
- Scenario 1 showing a read on a nominal cold prefix is attributable to the
  probe request that warm-started the prefix moments earlier; it is not treated
  as a controlled cold measurement.
- Scenarios 2, 3, 6, 7, 9, and 10 were routed to providers that either did not
  have the prefix cached or do not expose cache reads. This is provider routing
  churn, not a regression: the identical request bytes that read on DeepInfra or
  Venice reported 1 token elsewhere.
- The `1`-token reads are provider-specific near-miss accounting; they are
  reported as the provider sent them, not rounded to zero.

MiMo spend including the probe: **$0.00488759**.

## 13. Live results — DeepSeek (`deepseek/deepseek-v4.1-flash`)

All requests carried no cache field.

| Scenario | Prompt | Cache read | Cache write | Uncached | Output | Provider | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 initial prefix | 4,020 | 0 | 0 | 4,020 | 37 | DigitalOcean | $0.00011552 |
| 2 repeat prefix | 4,020 | 0 | 0 | 4,020 | 14 | Wafer | $0.00011368 |
| 3 prefix reuse | 4,020 | 0 | 0 | 4,020 | 34 | InferenceNet | $0.00011528 |
| 4 multi-turn | 4,048 | 0 | 0 | 4,048 | 12 | Crusoe | $0.00011430 |
| 5 append small | 4,014 | 0 | 0 | 4,014 | 48 | Together | $0.00011623 |
| 6 tool continuation | 4,357 | 0 | 0 | 4,357 | 5 | DigitalOcean | $0.00012240 |
| 7 repeat after tool | 4,356 | **4,224** | 0 | 132 | 4 | DigitalOcean | $0.00001077 |
| 8 streaming | 4,021 | **3,968** | 0 | 53 | 37 | InferenceNet | $0.00001079 |
| 9 non-streaming | 4,021 | **3,840** | 0 | 181 | 20 | Wafer | $0.00001281 |
| 10 reasoning | 4,020 | 0 | 0 | 4,020 | 14 | Wafer | $0.00011368 |
| 11 changed prefix | 4,024 | 0 | 0 | 4,024 | 33 | InferenceNet | $0.00011531 |
| 12 final reuse | 4,022 | **3,968** | 0 | 54 | 40 | Together | $0.00001106 |

Interpretation:

- **Cache reads confirmed** on four requests (4,224 / 3,968 / 3,840 / 3,968).
- Reads appear when the same prefix is served again by the same provider
  (DigitalOcean scenario 6→7, InferenceNet 8, Wafer 9, Together 12), which is
  exactly the expected prefix-cache behavior.
- Scenario 11's changed prefix produced zero reads, as designed.
- Writes are not reported by these providers; no write is inferred.
- Streaming, non-streaming, tool continuation, and low-effort reasoning all
  executed normally with cache fields absent.

DeepSeek spend: **$0.00097184**.

## 14. Live results — direct Claude (`claude-sonnet-5`)

Two requests only, both with the top-level ephemeral field.

| Scenario | Prompt | Cache read | Cache write | Uncached | Output | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A create cache | 5,462 | 0 | **5,460** | 2 | 7 | $0.013724 |
| B reuse cache | 5,460 | 0 | **5,458** | 2 | 5 | $0.013699 |

Interpretation:

- The field is accepted and caching is engaged: both requests created a cache
  of ~5,460 tokens, well above the 1,024-token minimum.
- **No cache read was observed on request B.** This is the documented Anthropic
  pitfall of placing the automatic breakpoint on content that changes every
  request. Automatic caching puts the single breakpoint at the end of the
  request, which here is the final user block (`ALPHA` vs `BETA`). Request A
  therefore wrote an entry ending at A's suffix; request B's suffix differs at
  the breakpoint, so there is no previously written prefix ending at B's
  breakpoint to read. The unchanged ~5,300-token system block was never written
  as its own interior entry because no explicit breakpoint was placed there.
- This confirms the field works but does **not** prove a read path in this
  configuration. It is reported as unverified, not as a success.
- The two-request cap was exhausted, so no further experiment (for example an
  explicit system-block breakpoint on a third request) was run.

Claude spend: **$0.027423**.

> **Phase 2.0C-2A correction (2026-10-20).** The root cause above was confirmed
> with serialized-request evidence and Anthropic's documented automatic-caching
> behavior: the top-level breakpoint landed on the changing final user block.
> Direct Anthropic now sends one explicit `cache_control` marker on the stable
> first system block instead. A later two-request live test reported 5,445
> cache-write tokens on request A and 5,445 cache-read tokens on request B. The
> original observations and figures above are retained unchanged; the corrected
> behavior, deterministic coverage, and live evidence are documented in
> `docs/anthropic-cache-reuse-verification.md`.

## 15. Cost and budget accounting

| Provider | Requests | Estimated spend |
| --- | ---: | ---: |
| MiMo (incl. probe) | 12 | $0.00488759 |
| DeepSeek | 12 | $0.00097184 |
| Direct Claude | 2 | $0.02742300 |
| OpenRouter Claude | 0 | $0.00000000 |
| **Total** | **26** | **$0.03328243** |

Budget: 26 / 26 requests used, $0.0333 / $0.50 spent. Estimates use provider
pricing and provider-reported token counts; they are not billing statements and
exclude any provider-side rounding or minimum charges.

## 16. Limitations and unverified behavior

1. **Direct Claude cache read is unverified.** Writes were confirmed; a read was
   not. The likely fix is an explicit breakpoint on the stable system block,
   which this phase deliberately did not add (duplicate-breakpoint and TTL
   constraints). This is the highest-value follow-up.
2. **Provider routing churn on OpenRouter.** Identical prefixes were served by
   Relace, Xiaomi, Venice, DeepInfra, DigitalOcean, Wafer, InferenceNet, Crusoe,
   and Together. Only some expose cache reads, and OpenRouter's sticky routing
   keys on the first system and first non-system message, so changing the test
   suffix can change the route. Real chats keep a stable first user message and
   should be stickier, but this was not measured in production sessions.
3. **No write counter for MiMo/DeepSeek.** Their routed providers reported reads
   only. Absence of writes is `unavailable`, not zero.
4. **One-token reads.** Several MiMo/DeepSeek responses reported `1` cached
   token. These are provider artifacts and are preserved verbatim.
5. **No prompt-construction change.** The temporal anchor is stable within a day
   but changes at midnight, so a session spanning midnight may pay one full
   re-read. This is acceptable and was not optimized.
6. **No OpenRouter Claude live request.** The budget explicitly reserved zero,
   so that path is covered deterministically only.
7. **No long-session or compaction live test.** Compaction compatibility is
   deterministic; a multi-hour live session was out of budget.

## 17. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Anthropic-only field leaks into a non-Anthropic child | resolved from `target.model` inside the child's own `createCloudFetch`; test 15 |
| Duplicate breakpoints / exceeded 4-slot budget | one top-level field only, no per-block markers; test 1 |
| Caching a changing block and wasting writes | documented limitation; follow-up proposes an explicit stable-prefix breakpoint |
| Provider rejects unknown field | unknown targets receive `{}`; test 8; rejection surfaces cleanly with no retry (test 20) |
| Missing metrics shown as zero | conditional integer copy; `NULL` downstream; tests 19 and 22 |
| Prompt behavior regression | no prompt changes; streaming/reasoning/tool/compaction tests |
| Spend overrun during verification | hard per-provider caps, harness request counter, no retries; 26/26 used |

## 18. Follow-ups (Phase 2.0C-3 candidates)

1. **Explicit stable-prefix breakpoint for Anthropic.** Add one
   `cache_control` marker on the last stable system/tool block (not the tail),
   keeping the total at or below four breakpoints, and verify a read on the
   second request. This directly addresses the Claude limitation above.
2. **Session/provider pinning for OpenRouter.** Explore a routing preference or
   session key so repeated turns stay on a cache-reporting provider.
3. **Gemini and Alibaba explicit caching.** Both offer explicit cache objects
   with different APIs and lifetimes; evaluate only if automatic prefix caching
   proves insufficient.
4. **Cache-aware budget policy.** Today budgets count gross tokens. Decide
   whether cache reads should be discounted in enforcement, separately from the
   accounting contract.
5. **Cross-midnight temporal anchor.** Consider a session-stable anchor to avoid
   one avoidable re-read per midnight boundary.
6. **Live read verification for OpenRouter Claude**, budget permitting.

## 19. Files changed

| File | Change |
| --- | --- |
| `src/lib/promptCaching.cjs` | new provider-aware resolver and capability view |
| `src/main/cloudProviders.js` | merge resolved cache fields into Anthropic and OpenAI-shaped bodies; conditional Anthropic cache counters |
| `tests/cloudPromptCaching.test.cjs` | new 23-test deterministic suite |
| `docs/cloud-prompt-caching-report.md` | this report |

Untouched by this phase: prompt construction, compaction policy, budgets, token
history schema, analytics UI, and all unrelated working-tree changes.

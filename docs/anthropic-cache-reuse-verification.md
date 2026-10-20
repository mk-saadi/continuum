# Anthropic Cache Reuse Verification

Date: 2026-10-20
Phase: 2.0C-2A
Status: implemented, deterministic tests passing, live reuse verified, production build passing

No commit, push, stash, reset, or clean was performed. Existing working-tree
changes were preserved. Phase 2.0C-3 was not started.

## 1. Previous failed cache-reuse observation

Phase 2.0C-2 sent a single top-level `cache_control: { type: "ephemeral" }`
field to the direct Anthropic Messages API and ran two synthetic requests:

| Request | Model | Cache strategy | Cache write | Cache read | Uncached input |
| --- | --- | --- | ---: | ---: | ---: |
| A | `claude-sonnet-5` | top-level automatic | 5,460 | 0 | 2 |
| B | `claude-sonnet-5` | top-level automatic | 5,458 | 0 | 2 |

Both requests succeeded and Anthropic accepted the field, but request B wrote
a second cache entry instead of reading request A's entry. Accepted request
fields alone do not prove reuse, so this phase treated the behavior as
unverified.

## 2. Root-cause investigation

The original Phase 2.0C-2 payloads were not retained (the harness printed only
normalized usage, never request bodies). The two requests were therefore
reconstructed with synthetic content through the same production builder and
adapter, without network access.

Reconstructed comparison:

| Property | Request A | Request B |
| --- | --- | --- |
| Model | `claude-sonnet-5` | `claude-sonnet-5` |
| Endpoint | `api.anthropic.com/v1/messages` | same |
| Top-level `cache_control` | `{ "type": "ephemeral" }` | same |
| System blocks | 1 | 1 |
| System prefix | identical (5,911 chars) | identical (5,911 chars) |
| Tool definitions | identical | identical |
| Stable prefix identical | yes | yes |
| Final user message | `Reply with ALPHA.` | `Reply with BETA.` |
| Reasoning / thinking | absent | absent |
| Block-level breakpoints | none | none |

Confirmed cause: **automatic breakpoint placement**. Anthropic's automatic
caching puts the single breakpoint on the last cacheable block, which in this
shape is the final user message. Request A wrote an entry whose hash included
`ALPHA`. Request B's suffix differed at the breakpoint, so its prefix hash did
not match. Anthropic's lookback finds only entries that earlier requests wrote
at a breakpoint; no entry had ever been written at the interior stable-system
position. The result was a fresh write on every request and no read.

This is the exact failure mode documented by Anthropic under "Common mistake:
Breakpoint on content that changes every request" and is repeated for automatic
caching: it places the breakpoint on the last cacheable block, which may be the
changing block.

Hypotheses ruled out:

| Candidate cause | Evidence |
| --- | --- |
| Different prompt prefixes | Reconstructed tools + system were byte-identical |
| Tool or system-message changes | No tools in the live test; system identical |
| Minimum cache length | ~5,300-token prefix versus 1,024-token Sonnet 5 minimum |
| Model or reasoning differences | Same model, no thinking/reasoning fields |
| Cache expiration | Request B followed A immediately, well inside 5 minutes |
| Request serialization | Anthropic accepted both requests and wrote cache entries |
| Provider-specific limitation | Writes succeeded; only the read position was wrong |

The original explanation was therefore correct, and is now backed by
serialized-request evidence and the provider documentation rather than
inference alone.

## 3. Actual request-format findings

The production adapter builds the Anthropic body as follows:

1. `tools` first, mapped from OpenAI function schemas to Anthropic
   `{ name, description, input_schema }`.
2. `system` next, as an array of `{ type: "text", text }` blocks. Continuum
   hoists every `system`/`developer` message into this array, preserving order.
3. `messages` last, with tool calls converted to `tool_use` blocks and tool
   results to `tool_result` blocks.

Anthropic's cache hierarchy is `tools` → `system` → `messages`. A breakpoint on
the first system block therefore caches the tool definitions and that system
block, and nothing after it. Later per-turn system blocks (briefs, checkpoints,
summaries, work log, plans, skills) and all user/assistant turns remain outside
the explicit prefix.

## 4. Explicit versus automatic caching strategy

The corrected strategy for the direct Anthropic Messages API is deliberately
one-or-the-other, never both:

| Condition | Strategy |
| --- | --- |
| An eligible stable system block exists | one explicit block-level breakpoint on the first system block |
| No system block, but tools exist and the prefix is eligible | one explicit block-level breakpoint on the last tool definition |
| No eligible stable prefix (too short, or no system and no tools) | top-level automatic `cache_control` fallback |
| Caller already supplied explicit breakpoints | preserve them; add no second strategy and remove any top-level field |

The top-level field is always deleted before applying the decision, so an
automatic decision can never coexist with an explicit one. No request carries
more than one cache-control strategy, and no request carries more than one
explicit marker from this code.

## 5. Stable-prefix selection rules

Continuum's prompt builder guarantees that the **first** system block is the
stable base instruction prefix: `buildTemporalAnchor()` plus the base prompt.
Later system blocks are per-turn context built by `buildSessionSystemPrompt`,
`taskBriefs`, `taskCheckpoints`, the earlier-conversation summary, `workLog`,
and `workspacePlan`.

Selection is therefore deterministic:

1. First non-empty text block in `system` → explicit boundary.
2. Otherwise, last tool definition → explicit boundary.
3. Otherwise, automatic top-level fallback.

The rule deliberately does **not** choose the last system block. In a workspace
session that block can be a changing plan or work-log digest; a cache write
there would reproduce the original bug.

Token eligibility uses a rough `ceil(characters / 4)` estimate over tools plus
the system content up to the boundary. This is conservative: underestimating
skips an eligible breakpoint rather than claiming a cache that will not happen.
Per-model minimums are applied for known Claude families (1,024 for Sonnet 5,
512 for the 5.5/Opus 5/Fable/Mythos families, 4,096 for Opus 4.5/4.6 and
Haiku 4.5, and so on). Below-minimum breakpoints are harmless at Anthropic, but
the gate avoids pointless writes.

## 6. Breakpoint placement

```
tools:    [ tool 1, tool 2, ... ]          <- cached by a system breakpoint
system:   [ base instructions ]  <-- cache_control: { type: "ephemeral" }
          [ brief / checkpoint / summary / session / work log / plan ]
messages: [ user, assistant, tool_use, tool_result, ... ]
```

Only the block marked above carries `cache_control`. Request A writes the
prefix ending there. Request B, with a different final user message, hashes the
same tools + base system prefix and reads it back. Changes to a later system
block or message cannot invalidate it.

If no system block exists, the marker moves to the last tool definition, which
caches the tool list. If neither exists, automatic caching is used.

## 7. String and structured system prompts

Both Anthropic system shapes are supported:

- **String form** (`system: "..."`): normalized to
  `[{ type: "text", text, cache_control }]` so a block-level marker can be
  attached. Meaning and ordering are unchanged.
- **Array form** (`system: [{ type: "text", text }]`): kept as an array; the
  first non-empty text block receives the marker. Other blocks are untouched.

A missing or empty system prompt is not replaced with synthetic content. The
tool-boundary or automatic fallback applies instead.

## 8. Tool-calling and reasoning compatibility

- Tool definitions keep their order, names, descriptions, and input schemas.
  They are not reordered or marked individually when a system boundary exists.
- A tool-definition change keeps the same breakpoint position but changes the
  cached prefix; Anthropic invalidates the cache in that case, as documented.
  Continuum does not try to hide that invalidation.
- Tool-use and tool-result blocks are unchanged.
- `thinking` / reasoning fields are unchanged. A breakpoint on the system block
  coexists with a thinking configuration without duplicating cache controls.
- `max_tokens` is unchanged; the explicit marker does not alter output limits.
- Context compaction appends a summary as a later system block, leaving the
  base-system breakpoint in place. A compacted turn does not move or duplicate
  the marker.

## 9. Main-agent and subagent compatibility

- **Main chat** (casual and workspace): the first system block is the base
  prompt, so the marker lands there. Per-turn blocks stay uncached.
- **Tool loops**: tool calls and results remain in `messages`; the stable
  system marker survives each iteration.
- **One-shot and investigation subagents**: the subagent provider calls
  `createCloudFetch(engine.chatTarget)`, so a direct-Claude child resolves its
  own explicit boundary from its own system prompt. It never inherits the
  parent's cache decision.
- **Independently selected child models**: a MiMo or DeepSeek child receives no
  Anthropic field, even when the parent is Claude.
- **Streaming and non-streaming**: the Anthropic transport sends the same JSON
  body either way; the marker is identical.
- **Cancellation and budgets**: unchanged; no retries are introduced.

## 10. Files and functions modified

| File | Change |
| --- | --- |
| `src/lib/promptCaching.cjs` | added `anthropicCachePlan`, `applyAnthropicCaching`, `minimumCacheableTokens`; direct Anthropic `cacheRequestFields` now returns `{}`; capability view reports explicit strategy |
| `src/main/cloudProviders.js` | direct Anthropic body now passes through `applyAnthropicCaching`; OpenRouter and other families unchanged |
| `tests/anthropicCacheReuse.test.cjs` | new 25-test focused suite |
| `tests/cloudPromptCaching.test.cjs` | direct-Anthropic assertions updated to the explicit stable-boundary behavior |
| `docs/anthropic-cache-reuse-verification.md` | this report |
| `docs/cloud-prompt-caching-report.md` | correction note appended; original observations retained |

No changes were made to prompt construction, compaction policy, budgets, token
history schema, analytics UI, OpenRouter routing, or local llama.cpp caching.

## 11. Deterministic test results

New focused suite: `tests/anthropicCacheReuse.test.cjs` — **25 tests, 25 pass**.

Coverage maps to the requested scenarios:

| Requested scenario | Test |
| --- | --- |
| Identical stable prefixes across two requests | identical stable system prefixes serialize identically |
| Different final user messages, same prefix | different final user messages keep the same breakpoint |
| Correct explicit breakpoint placement | breakpoint on first system block, not changing tail |
| Correct system-block serialization | system blocks serialize as text blocks |
| String-form system prompt | string form normalized to a cacheable block |
| Array-form system prompt | array form keeps shape and caches stable block |
| Tools preceding the breakpoint | tools precede breakpoint and are not marked |
| Tool-definition changes | tool change keeps boundary, changes prefix |
| Reasoning-setting changes | reasoning preserved, no duplicate controls |
| Streaming inference | streaming carries the same breakpoint |
| Non-streaming inference | non-streaming carries the same breakpoint |
| Main-chat requests | casual main-chat base block is the boundary |
| Workspace requests | workspace caches base, leaves briefs/plans uncached |
| Direct Claude subagents | subagent resolves its own explicit boundary |
| Parent/child independence | parent and child cache independently |
| Short or ineligible prefixes | short prefix gets no ineffective block marker |
| Missing system prompts | tool boundary is used when system is absent |
| Automatic-caching fallback | no stable prefix falls back to automatic |
| Unsupported models | non-Anthropic providers receive no cache fields |
| No duplicate/conflicting controls | existing markers preserved without a second strategy |
| Context compaction changes | summary does not move the breakpoint |
| Cache-creation normalization | gross input not double counted |
| Cache-read normalization | reads stay distinct from writes |
| No leakage into other providers | MiMo/DeepSeek/custom receive no field |
| Existing Phase 2.0C-2 behavior | OpenRouter Claude automatic field preserved |

Related suites run together: 48/48 passing across
`anthropicCacheReuse.test.cjs` and `cloudPromptCaching.test.cjs`. A wider
targeted run covering cloud providers, cloud IPC/metadata, cache accounting,
reasoning controls/runtime/usage, streaming dispatch, and subagent fetch/payload/
runtime produced 127 pass and only the known pre-existing
`cloud settings persist privately and cloud chat works without a local engine`
failure.

## 12. Live verification results

Authorized budget: 2 direct Claude requests, $0.10 maximum. Used exactly 2
requests, $0.0148855 estimated.

Harness: the same production adapter (`createCloudFetch` + `readCompletion`)
used by main chat, with synthetic content only, `max_tokens: 48`, a 90-second
timeout, and no retries. The provider was read from
`~/.config/Continuum/memory_palace.db` in read-only mode; keys and private data
were never printed.

Model: `claude-sonnet-5` (direct `https://api.anthropic.com/v1`, configured
provider `63dce8bb-…`). Prefix: ~5,324 estimated tokens, above the 1,024-token
minimum. No tools, no thinking, short user suffixes.

| Request | User suffix | HTTP | Cache write | Cache read | Uncached | Output | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | `Reply with the single word ALPHA.` | ok | 5,445 | 0 | 17 | 7 | $0.0137165 |
| B | `Reply with the single word BETA.` | ok | 0 | **5,445** | 15 | 5 | $0.0011690 |

Request B read exactly the number of tokens request A wrote, with zero new
writes. This is provider-confirmed reuse, not merely an accepted field.

Serialized prefix before the live call:

```
topLevelCacheControl: null
systemBlocks: 1
systemChars: 21294
approxPrefixTokens: 5324
systemCacheControl: { "type": "ephemeral" }
tools: null
```

## 13. Cache-write and cache-read values

| Measurement | A | B |
| --- | ---: | ---: |
| `cache_creation_input_tokens` | 5,445 | 0 |
| `cache_read_input_tokens` | 0 | 5,445 |
| `input_tokens` (after last breakpoint) | 17 | 15 |
| Gross prompt (`prompt_tokens`) | 5,462 | 5,460 |
| Completion output | 7 | 5 |

Accounting invariant preserved: gross = uncached + reads + writes
(5,462 = 17 + 0 + 5,445; 5,460 = 15 + 5,445 + 0). The read is not counted as
uncached, and the write is not counted twice.

## 14. Estimated testing cost

| Item | Estimate |
| --- | ---: |
| Request A (5,445 write + 17 input + 7 output) | $0.0137165 |
| Request B (5,445 read + 15 input + 5 output) | $0.0011690 |
| **Total** | **$0.0148855** |

Pricing used: Sonnet 5 at $2/M input, $10/M output, $2.50/M 5-minute cache
write, $0.20/M cache read. Budget: $0.0149 / $0.10, 2 / 2 requests. No
OpenRouter Claude request was made.

## 15. Regression-suite comparison

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Phase 2.0C-2 recorded baseline | 1,342 | 1,316 | 25 | 1 |
| Phase 2.0C-2A after changes | 1,367 | 1,341 | 25 | 1 |

The +25 tests and +25 passes are the new focused suite. The 25 failing test
identities are byte-for-byte unchanged from the recorded baseline, including
the known cloud-settings test and the eleven test files that cannot load under
the current harness. No new regression was introduced.

`npm test` remains broken on Node 22 (`MODULE_NOT_FOUND`); the suite was run as
`node --test tests/*.test.*`.

## 16. Production build result

```
$ npx vite build
✓ built in 12.42s
EXIT=0
```

The existing chunk-size warning is unchanged and non-blocking.

## 17. Known limitations

1. **Stable-boundary heuristic.** The first system block is assumed to be the
   base prompt. This is guaranteed by Continuum's `prependBaseSystemPrompt`,
   but a future caller that puts dynamic content first would get a poor
   boundary. The rule is documented and covered by workspace-shape tests.
2. **Character-based token estimate.** `ceil(chars / 4)` is approximate. It can
   skip an eligible breakpoint, but it cannot produce a false claim of caching.
3. **Only the system prefix is explicitly cached.** Growing message history is
   not cached in the explicit path. Anthropic's automatic caching would cover
   append-only history, but combining it was deliberately avoided to keep one
   deterministic strategy and prevent a changing-tail write. This may be worth
   revisiting for very long sessions.
4. **Tool changes invalidate the prefix.** Expected and documented; not hidden.
5. **System prompt changes invalidate the prefix.** A changed base prompt,
   memory mode, media-tool setting, or daily temporal anchor requires one new
   write.
6. **OpenRouter Claude was not live-tested in this phase.** Its top-level
   automatic behavior is unchanged and covered deterministically only.
7. **One live shape only.** The live test used a single system block and no
   tools. Multi-block workspace and tool-loop shapes are deterministic-only.

## 18. Remaining follow-up work

1. **Optional combined strategy for long sessions.** Evaluate adding a second
   breakpoint on the growing conversation tail, or re-enabling automatic
   caching alongside the stable marker, once metrics show message-history cost
   dominates. Any such change must keep the total at or below four breakpoints
   and avoid a write on a changing final block.
2. **Live workspace/tool-loop measurement.** Confirm the explicit base-system
   read across a multi-block workspace prompt and a tool continuation.
3. **Prompt-cache observability.** Surface per-request cache reads/writes in a
   diagnostic view so reuse can be confirmed without a custom harness. No UI
   work was done in this phase.
4. **OpenRouter Claude parity.** Optionally verify that OpenRouter passes an
   explicit block breakpoint through unchanged, then align it with direct
   Anthropic. No paid test was authorized here.
5. **Midnight anchor.** A session spanning midnight invalidates the base prefix
   once. A session-stable anchor would avoid that single re-read.

Stop here. Phase 2.0C-3 has not been started.

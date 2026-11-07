# Workspace chat overhead — 2026-11-06 (Asia/Dhaka)

Follow-up: [compact validation](compact-native-validation.md) resolves the schema compilation failure and adds an ASAR smoke and fixed-fixture benchmark. Production remains full pending real-model acceptance. The measurements and limitations below describe the earlier audit.

The reported 12,213-token greeting was **one model request, not a tool loop**. Its provider usage is 12,061 prompt + 152 completion = 12,213 total, zero cached input, finish reason `stop`. Stored execution steps contain a thought event and no tool calls. `scope: all` selected the UI's multi-turn treatment even when `promptRequests: 1`; this is now fixed.

## Original evidence and limits

Read-only SQLite inspection found the exact 12,213 match: session `21bc2b0e-0118-4676-bd20-561fe9f7fa95`, assistant message 5115, created 2026-11-06 15:30:27 UTC (21:30:27 Dhaka). The conversation contains just user `hello` and its assistant response. Model identity matches `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf`. One raw usage entry corroborates the request count; no evidence supports additional inference rounds in this turn. Background/auxiliary requests not recorded in turn usage cannot be ruled out.

The footer is usage across recorded requests: prompt tokens plus generated output, including any cache reads. It is not a measurement of GPU operations or occupied context. Prepared context instead measures a projection for one request using the backend template/tokenizer when available, with an explicit estimate fallback. The meter can select current dispatch telemetry via `selectContextOccupancy`; it never sums the prompt counts of every request. Its limit is usable input after output/safety reserves, not necessarily the model's advertised capacity. 12.1k is consistent with 12,061 rounded for display. The screenshot's precise prepared projection, method, timestamp, runtime capacity and 74.4k denominator were not persisted, so their exact values cannot be recovered from the assistant row.

The original serialized request, schema manifest, environment/profile and settings snapshot were not stored. Current session overrides are null for persona, sampling and memory; resolved defaults can have changed. The current workspace is Workspace Write, with no custom instructions, description, attached project context files, AGENTS.md or PROJECT.md. Current MCP mode is manual; all 17 configured server entries, including bundled `playwright-native`, have disabled=true and uiEnabled=false. These current observations corroborate the supplied settings but do not prove historical configuration identity. The remembered load configuration has contextLength 75,312, parallel 1, GPU offload enabled and MTP enabled; no running llama server or usable CUDA device is available here. It is not evidence for the original runtime's exact limit.

No live storage was initialized or migrated. SQLite was opened read-only and backed up into `/tmp/continuum-overhead-original`; builders ran only on that disposable database. No original chat, prompt, memory, configuration secrets, tool arguments or raw request bodies are included in repository evidence.

## Measurement method

Two reproductions were made, both using production `rebuildChatMessages`/`getToolContext` and `runMemoryChat` to capture the serialized local request. Fetch returned a synthetic final answer; **no fresh real-model inference or behavior acceptance is claimed**.

1. Fresh isolated workspace greeting, empty repository/project instructions and MCP configuration; memory enabled, default persona/settings, Workspace Write. Existing `scripts/audits/p1PromptEfficiency.cjs` captured full before/after requests. `CONTINUUM_NATIVE_TOOL_PROFILE=compact node scripts/audits/p2CompactNativeTools.cjs /tmp/workspace-compact.json` captured compact. Paths/date were normalized by those scripts.
2. Original-session reconstruction on the disposable backup: exclude assistant 5115, retain the original user turn and applicable task brief, use current resolved settings and workspace inputs, pass no external MCP schemas. Explicit full/compact profiles were separately pinned for the run. This is not a new session or exact historical replay. Before was reconstructed by substituting only the original Git protocol into the captured request.

The available matching GGUF was loaded **vocabulary-only**, skipping tensors. `ggufPromptTokens.cpp` calls llama.cpp's tokenizer and reads the embedded `tokenizer.chat_template`. Python Jinja2 3.1.2 rendered that template with tools, add_generation_prompt=true and enable_thinking=true; tokenization parses special tokens and adds no extra BOS. Template SHA-256: `c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041`. This uses the actual model vocabulary and embedded template, but Python Jinja2 is not the original server's minja renderer, and historical template kwargs/settings are unavailable. These are **measured retrospective rendered prompts**, not authoritative original wire counts. The reconstructed before count differs from original provider input by +98 tokens; the difference is left unattributed rather than forced into a component.

Reproduction helpers are `scripts/audits/ggufPromptTokens.cpp` and `scripts/audits/workspaceChatTokenize.py`. Compile the C++ helper with matching llama.cpp include, ggml/include, library and rpath flags, then run:

```sh
python3 scripts/audits/workspaceChatTokenize.py \
  --tokenizer /tmp/continuum-tokenize --model /absolute/path/to/model.gguf \
  /tmp/captured-request.json
```

The helper emits hashes/counts only. Raw captures contain private context and should stay outside the repository. `workspace-chat-overhead-evidence.json` contains sanitized measurement results. Existing audit scripts also emit conservative bytes/3 + per-message estimates; those are not substituted for the model-tokenizer measurements below.

## Before and after

| Request | Native tools | Serialized JSON bytes | Rendered model tokens |
| --- | ---: | ---: | ---: |
| Original observed provider request | manifest unavailable | unavailable | **12,061 input + 152 output** |
| Original-session reconstruction, full before | 46 | 48,844 | 12,159 |
| Original-session reconstruction, full after | 46 | 47,863 | 11,864 |
| Original-session reconstruction, compact after | 18 | 27,593 | 6,622 |
| Fresh isolated greeting, full before | 46 | 46,832 | 11,753 |
| Fresh isolated greeting, full after | 46 | 45,851 | 11,458 |
| Fresh isolated greeting, compact after | 19 | 26,041 | 6,320 |

The implemented full-profile reduction is **981 serialized bytes and 295 rendered tokens**, measured on both reproductions. These are different representations: JSON escaping and chat-template serialization have different byte sizes. Compact is a comparison, not an implemented default change. Different tool counts between compact fixtures reflect current manual MCP mode suppressing native MCP discovery in the original-session reconstruction.

The following **non-overlapping byte partition** describes the fresh captured full request. Its categories sum to the JSON total; they are not independently tokenized additive sections.

| Contributor | Before bytes | After bytes |
| --- | ---: | ---: |
| Base/core, excluding separately categorized safety | 1,553 | 1,553 |
| Workspace/persona/memory/instructions, excluding safety | 7,105 | 6,124 |
| Safety/permission spans | 757 | 757 |
| Native tool descriptions, including parameter descriptions | 19,286 | 19,286 |
| Remaining native schemas/envelopes | 16,984 | 16,984 |
| Task brief (includes the greeting and preservation guidance) | 534 | 534 |
| Conversation | 5 | 5 |
| Serialization/provider/merge residual | 608 | 608 |
| Plans, worklog, checkpoint | 0 | 0 |
| **Total** | **46,832** | **45,851** |

Original-session reconstruction source content after the change: base 1,701 bytes; task brief 533; session instructions 8,110; explicit no-plan state 90; execution environment 570; user history 5. These source strings total 11,009 bytes; provider coalescing/serialization accounts for a different merged/wire size. Within the 8,110-byte session block, current memory plus clarification guidance is 1,504 bytes, persona 1,250, project identity/context 106; the rest comprises workspace orchestration, Git, subagent, tool, safety and output guidance and wrappers. These nested figures must not be added again. The memory component is query-retrieved using current memory scope/settings; historical selected records were not persisted. No older conversation history, checkpoint, summary, worklog, active plan, skills or repository guideline content was present in this reconstruction. No attachments or media inputs were present.

A whole-request ablation removing tools from the reconstructed full-after request measures 2,411 tokens versus 11,864 with tools: a **9,453-token marginal difference including template tool framing**. This is not a standalone additive schema count. The instruction/history floor is substantial; attributing all 12k to schemas would be incorrect. No additive model-token breakdown is claimed.

## Tool exposure, behavior and changes

`mcpManager.getTools` filters enabled + connected servers, manual UI selection, disabled tools and automatic session selection before `getToolContext` adds external schemas. Bundled Playwright is an MCP server, not an always-injected native browser schema. All captured requests above have **zero external MCP and browser schemas**. Native web search/page-reading tools remain native research capabilities; disabling browser/MCP tools does not disable them. Current manual mode also omits the external-discovery prompt paragraph. A focused test with connected-but-disabled external and Playwright servers verifies absent schemas and failed resolution in both MCP modes. Historical absence cannot be proven byte-for-byte without the missing manifest.

Full is the configured fallback; `npm run dev` explicitly opts into compact, whereas `dev:electron`, start and production fallback do not. The original active profile is **not durably recorded**. Full's reconstructed count is close to the observation, but that is circumstantial evidence, not proof of the original environment. This report does not assert the original profile as fact.

Full advertises all currently authorized native tools directly, except legacy shadowed/availability-filtered tools. Compact retains common file/edit/command/plan/status tools, always-on web tools and `manage_native_tools`, exposing specialized groups on model request. Discovery lists authorized capabilities by intent; activation persists through subsequent requests of the owning run, is idempotent and grants no permissions. Fresh runs reset activation. External MCP exposure remains separately governed. Schemas and dispatcher permission checks are unchanged by this patch.

Existing scripted production-loop tests perform search/read/edit/write/command verification and specialized batch-edit discovery/activation with paired tool results and fresh schemas. Tests cover owner/run isolation, unauthorized groups, permission downgrade, memory-off, external schemas and manual mode. They demonstrate the mechanism, not whether Qwen spontaneously chooses the right discovery calls. Additional discovery requests/results have their own processing cost. Compact remains opt-in because real-model multi-step acceptance is absent and one existing schema-validation test currently fails. No claim is made that compact will preserve success rates or reduce cumulative processing for every task.

Implemented changes:

- Condense repetitive Git command prohibitions, tool mappings and duplicated workflows into one protocol. Preserve the shell metadata boundary, dedicated mutation tools, explicit staging, commit/push verification, approvals and recovery without permission escalation. No schemas or tool availability changed.
- Derive the footer's multiple-request status from recorded request count (raw usage fallback), not aggregation scope. One-request `scope: all` now shows single-request usage. Use the neutral “Multiple model requests” label because additional requests alone do not prove tool execution. Explain cumulative prompt/output usage including cache reads, separately from prepared context; remove the unsupported “total GPU compute” wording.
- Add focused request-accounting, Git-guidance and disabled-schema regression tests plus count-only measurement helpers.

Memory selection/retrieval, permissions, workspace boundaries, safety instructions, tool handlers, profile defaults and automatic context compaction were not changed. The working tree already contained unrelated edits, including memory retrieval and tool-validation changes; they were preserved and included as current reconstruction inputs.

## Validation and remaining gaps

Passed: new request-accounting regression; contextMeasure and contextTelemetry suites (3 test files together); focused Git protocol test; selected compact discovery/activation, permission, production-loop, memory, external-schema and new disabled-schema tests; production `npm run build` (Vite 8.09 s; existing large-chunk warning).

The complete existing compact suite is **7/8 passing before the added disabled-schema test**; its schema compilation case fails `TOOL_SCHEMA_UNSUPPORTED`. Replacing only this patch's Git text with the before version reproduces the same failure. Existing sessionPromptWording continuity test also fails its stale `/get the existing plan/` expectation with both before/after Git text; the new Git test passes after. These unrelated failures were not papered over. Additional attempted checks: messageStats fails an existing saved-message `siblings` equality assertion; mcpManager's stdio fixture reports connection closed (6/7 pass), so no live MCP runtime success is claimed.

`npm test` itself fails immediately under Node v22.23.4 because `node --test tests/` resolves the directory as a module (`MODULE_NOT_FOUND`); explicit test-file invocations were used for the checks above. This work does not claim a green full suite. No real-model greeting, spontaneous discovery, browser execution, permission approval UI interaction or multi-step Qwen acceptance was performed. Original payload/settings identity and original denominator remain unavailable. These are acceptance gaps, not inferred successes.

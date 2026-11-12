# Default workspace tool profile — 2026-11-11

Compact advertisement is now the shared default for ordinary development, source production and packaged launches. No profile switch is required. `CONTINUUM_NATIVE_TOOL_PROFILE=full` remains an explicit diagnostic override. Restart the running app to load changed source; installed distributions require a new build.

The initial workspace set includes common file, editing, command, plan, Git inspection and web tools plus discovery. Recent chat history is discovered through the memory group. Specialized groups activate within the same run; full descriptions and parameter contracts arrive on the next request. No tool description is truncated: only whitespace is normalized. Required fields, unions, enums, limits, hashes and permission checks are preserved. Explicit reader guidance requires exactly one source identifier on every call.

The refreshed production request fixture enables automatic MCP discovery, memory with zero stored records, rich blocks off, an empty persona, no injected project files/repository instructions and a fresh greeting. It estimates **9,837 input tokens**, 18 tools and 29,317 serialized bytes, compared with 17,182 estimated tokens for full advertisement with complete descriptions. These are conservative application estimates, not new tokenizer or provider measurements. The benchmark now fails at 10,000 estimated compact tokens as well as on excessive byte growth. The byte baseline changed intentionally to preserve complete descriptions and exercise automatic MCP discovery.

Validation for this revision: the compact native-tool suite, prompt-budget regression, prompt correctness, web availability and tool-validation reliability suites pass. The production frontend build and temporary ASAR/Electron production-mode budget and native-tool checks pass. No new live-model inference was run.

This is a starting-context budget, not a cap on arbitrary project instructions, memories, attachments, external tool selections or history. Activated specialized groups can exceed it. Historical real-model native-reader failures below have not been reclassified as passing; schema and handler verification cannot guarantee every model emits valid calls. The prior 6,117-token measurement used truncated descriptions and is not a measurement of this revision.

The following is the historical November 6 validation record; its held-default rollout instructions are superseded by this update and the user's explicit request to make compact the default.

---

# Compact native-tool validation — 2026-11-06

**Production remains on full.** The compact schema defect is fixed, automated acceptance passes, and the fixed greeting measures below 10k with the user's model tokenizer. A host inference server was subsequently found outside the sandbox: real greetings and specialized discovery ran, but native-file-reader acceptance failed in both profiles. The requested gate for switching the default has not been met. No default switch is claimed.

## Selection and fallback

`src/main/compactNativeTools.js::configuredProfile` is the shared selector: exactly `CONTINUUM_NATIVE_TOOL_PROFILE=compact` selects compact; unset, `full` and other values select full. `nativeToolActivation.begin` snapshots the selected profile for each run; changing the environment mid-run does not change that run. There is no packaging-specific override in either electron-builder configuration. Normal packages include `src/main/**/*.js` and use the same selector when launched. An existing installed AppImage was not rebuilt or modified by this work.

Previously `npm run dev` silently forced compact, while `dev:electron`, `start`, `start:local` and a packaged launch with no override selected full. This explains how development could look cheaper without production selecting compact; the earlier screenshot's historical process environment was not persisted. Removed that one implicit override. Ordinary development and production launches now both honor the shared selector and its retained full default. Named opt-in/fallback commands make the selection deliberate:

| Launch | Compact candidate | Explicit full |
| --- | --- | --- |
| Development | `npm run dev:compact` | `npm run dev:full` |
| Production from source | `npm run start:compact` | `npm run start:full` |
| Linux AppImage | `CONTINUUM_NATIVE_TOOL_PROFILE=compact ./Continuum-1.0.0.AppImage` | `CONTINUUM_NATIVE_TOOL_PROFILE=full ./Continuum-1.0.0.AppImage` |

Fully quit an existing app before relaunching with a different environment; forwarding to an already-running single instance does not replace its environment. The same environment variable also works with `dev:electron` and the installed executable. Selection changes advertisement, not permissions. Full remains available when compact discovery is unsuitable.

## Schema defect and fix

The original compact-suite failure was a genuine production-path schema compatibility defect, not an absent model or test-only dependency issue. Instrumenting Ajv's compile call revealed:

```text
strict mode: required property "relative_path" is not defined at "#/oneOf/0" (strictRequired)
```

`read_project_file` defined its string properties on the parent and `oneOf: [{required:[relative_path]}, {required:[attachment_id]}]`. This expresses valid JSON Schema exactly-one semantics, but Ajv's strictRequired lint rejects branch requirements without a local property declaration. Both full and compact expose this tool, and the actual IPC dispatcher validates the advertised schema with this strict compiler before execution. The test caught a defect that could block ordinary file reads in either profile.

Declared the corresponding typed property in each union branch. Parent constraints, `additionalProperties:false`, exactly-one semantics, line bounds and hash constraints remain intact. No validator option was relaxed; no keyword was stripped or schema truncated for this fix. The runtime's explicit source-selection check also remains. Regression coverage compares the old schema's validation semantics (strictRequired lint disabled only in the test reference) against the new fully strict schema across source-presence/type combinations, then checks unknown properties, invalid lines and invalid hashes. All currently authorized full-catalog schemas compile strictly. The pre-existing 9-test compact suite went from 8 pass / 1 fail to 9 pass / 0 fail; it now has 14 passing tests with the added coverage.

## Prompt-size measurements

The new fixture is deliberately independent of user context: one fresh `hello`, Workspace Write, no persona text, no stored memories, no earlier history, one sample.txt whose content is not injected, no AGENTS.md/PROJECT.md/project instructions, rich blocks off, MCP manual with an empty isolated config, no browser or external schemas. Memory retrieval remains enabled, with zero fixture records. Mid-run clarification guidance and ask_user retain normal workspace behavior. Date, timezone offset and temporary root are normalized in the captured request. This differs from the earlier audit's auto-MCP/default-settings fixture; do not compare their totals as an optimization result.

The benchmark executes the production builders and `runMemoryChat` request serializer, returning a synthetic final answer through fetch. It does **not** run inference. Before-schema-fix requests below substitute only the old oneOf branches into the otherwise identical new fixture capture; those old schemas are not used to execute tools.

The existing vocabulary-only C++ helper loaded `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` without tensors. Its embedded template was rendered with Python Jinja2 3.1.2, tools, thinking enabled, generation prompt enabled, special-token parsing enabled and no extra BOS. Same template SHA-256 as the prior audit: `c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041`. These are actual tokenizer counts of those rendered strings, **not provider-reported prompt usage or a replay of the original server's minja serialization**. No independent component counts are summed.

| Fixed greeting request | Native schemas | Normalized JSON bytes | Rendered model-tokenizer count |
| --- | ---: | ---: | ---: |
| Full, before schema fix | 45 | 44,909 | 11,214 |
| Full, after schema fix | 45 | 45,007 | 11,242 |
| Compact, before schema fix | 18 | 25,099 | 6,076 |
| Compact, after schema fix | 18 | 25,197 | **6,104** |

Compact is below 10k for this defined measurement. The schema repair costs 98 JSON bytes / 28 rendered tokens in both profiles, preserving validation instead of trading it for size. The after-fix full-to-compact difference is 19,810 bytes / 5,138 rendered tokens. This is profile comparison, not a claimed production-default saving. No claim is made for arbitrary memories, personas, repository instructions, MCP selections, model templates or actual inference usage.

`npm run bench:compact` checks serialized byte growth against the versioned `compact-prompt-budget-v1` fixture baseline: full 45,007 bytes; compact 25,197. Growth beyond 10% fails with profile-specific diagnostics. Reported production-estimator counts (15,067 / 8,463) are explicitly estimates and differ from the measured model-template counts above. The byte budget is not a token ceiling and applies only to the fixed fixture, never unrelated user-provided context. Inspect intentional changes before reviewing/updating the baseline; `--record-only` explicitly skips enforcement and marks the report unchecked. The regression test verifies repeatability across UTC/Dhaka and incoming profile environments and checks that a deliberately too-small baseline fails with a machine-readable growth report.

Repeatable commands:

```sh
npm run bench:compact
node scripts/audits/compactPromptBudget.cjs --output /tmp/compact-budget.json --capture-dir /tmp/compact-requests
python3 scripts/audits/workspaceChatTokenize.py --tokenizer /tmp/continuum-tokenize \
  --model /absolute/path/to/Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf \
  /tmp/compact-requests/full.json /tmp/compact-requests/compact.json
npm run bench:compact:asar -- /tmp/compact-asar-evidence.json
```

Compile `scripts/audits/ggufPromptTokens.cpp` against compatible llama.cpp headers/libraries as described in the earlier workspace-chat audit. The model tokenizer step is optional and requires that model and helper; the default byte check has no tokenizer/model/server dependency. Captures are public fixture-only content; the benchmark never reads the live profile or original private conversation.

## Automated and ASAR validation

All **14 compact-suite tests pass**, both from source (Node 22.23.4) and with current source inside a temporary ASAR under **Electron 44.7.0 / Node 24.21.0, NODE_ENV=production**. The ASAR check starts with no incoming profile override, tests the retained full default and explicit compact selection, then exercises both profiles. The archive contains current src/tests/scripts/package.json; dependencies, including native SQLite, resolve outside the archive. Test after-hooks write a completion manifest so a zero-exit process that never executes tests cannot qualify. Normalized full and compact requests have identical bytes and SHA-256 hashes in source and ASAR runs (see evidence).

This is a packaged-source/Electron loading smoke, **not a released or installed production AppImage, full GUI session, or electron-builder distribution qualification**. The test stubs Electron's app/settings location to disposable profiles and uses synthetic model responses. No primary profile was changed, no model was loaded for generation, and the automated smoke itself sends no inference requests. Separate live runs are described below.

Coverage includes:

- Real file reads, surgical JSX/CSS edits, atomic batch edit rollback/success, writes and a real command verification through the production tool loop. Those tool calls are scripted responses, not Qwen choices.
- A tool absent initially (`edit_project_files`): scripted intent-based discovery, activation, refreshed schema advertisement, validation and task completion with matched tool-call/result IDs.
- Git in a real disposable repository: discover/activate git_read and git_write, execute git_status/git_log and stage a change through native Git handlers. An Ask for Approval-mode guard is explicitly declined after activation; the index stays unchanged. A separately authorized Full Access stage succeeds. This does not imply Git always prompts in Workspace Write; the existing policy allows normal workspace Git there.
- Activated batch edits reject traversal and escaping symlinks and leave the outside file unchanged. After a live permission downgrade to read-only, edit schemas disappear and a forged edit is rejected with the file unchanged; activation state does not override policy or permit new mutation groups.
- Different sessions do not share activation; stale run owners cannot activate a replacement run; stale finalizers cannot clear it; termination clears groups; a new run starts compact with its intended initial set. A run's profile remains stable if the environment changes.
- Full fallback/default, all legacy direct/discoverable routes, memory-off, MCP manual selection, disabled external/Playwright schemas and existing checkpoint-rebuild retention. Automatic context compaction code was not changed.

Final source check: **8 test files passed** in one explicit invocation: p2CompactNativeTools, compactPromptBudget, toolValidationReliability, nativePermissions, toolPermissions, permissionIsolationReliability, permissionPolicy and permissionSelector. Production `npm run build` passed in 8.63 s with the existing Vite large-chunk warning. `git diff --check` passed.

The broader existing gitTools suite was also attempted: **8 pass / 29 fail**, with fixture `makeRepo` failing `spawnSync git EPERM` before native-tool execution. An isolated probe reproduces that error with default stdio and succeeds with `stdio: ['ignore','pipe','pipe']`; the new compact Git fixture uses the latter. No production permission/sandbox code was weakened to bypass it, and the older suite was not rewritten. This is an environment limitation in that fixture setup, not evidence of compact Git success or failure. `npm test`'s existing Node-22 directory-discovery issue remains as documented in the prior report; explicit test files were used. A green entire-repository suite is not claimed.

## Live-model validation and the remaining gate

The sandbox initially hid the host endpoint and CUDA device. A read-only health check outside it found an available server on 127.0.0.1:8080; `/props` and `/v1/models` verified the exact model basename. This supersedes the initial unavailable-runtime assessment. The already-loaded host model was used without changing server configuration or reloading it. Runtime reported one slot, n_ctx 75,520 and speculative.types `none`; the model filename includes MTP, but active MTP acceleration is not established. These conditions are not asserted identical to the original screenshot runtime.

Opt-in `compactRealModelCheck.cjs` uses the production builders, `runMemoryChat`, refreshed tool schemas, strict validation, permission guards and native handlers under Electron 44.7 / Node 24.21 / NODE_ENV=production. It supplies disposable application data and Workspace Write roots, manual MCP/empty external configuration, empty persona, memory enabled with zero records and rich blocks off. Tasks create only fixture files/repositories, contact no Git remote, and decline any approval callback. Sampling is temperature 0.2, seed 42, max_tokens 2,048 (512 for the final bounded native-reader diagnostic). No GUI or primary application profile is used. This is production-like orchestration, not a complete engine:chat IPC/approval-UI session.

At every dispatch the production `createPromptMeasurer` queries the live server's `/props`, `/apply-template` and `/tokenize`. **All recorded dispatch measurements used server-template-tokenizer**, not an estimate. Accepted provider usage supplies the separate input/output accounting. The first live greetings have exact agreement between prepared measurement and provider prompt count:

| Live case | Model requests | Cumulative provider input | Provider output | Observed result |
| --- | ---: | ---: | ---: | --- |
| Full greeting, source/Electron | 1 | 11,253 | 59 | Text only, pass |
| Compact greeting, source/Electron | 1 | **6,117** | 62 | Text only, below 10k, pass |
| Compact file/edit/command task | 12 | 90,738 | 1,498 | Edited correct file and command printed VERIFIED; native-reader acceptance failed |
| Compact atomic discovery task | 12 | 100,308 | 2,453 | Spontaneous discovery/activation, atomic edit and verification succeeded, with reader retries |
| Compact Git task, source/Electron | 7 | 63,538 | 2,123 | Native stage/commit/show/status succeeded; original harness over-required git_log |
| Compact greeting, live temporary ASAR | 1 | **6,119** | 66 | Text only, below 10k, pass |
| Compact Git task, live temporary ASAR | 6 | 46,493 | 1,504 | Native stage/commit/status and read-only command showing commit succeeded |

Source and ASAR live greetings differ by two tokens with independently generated temporary roots; neither is the normalized byte-budget fixture. The 6,104 count above remains a separate offline fixture/template measurement. Cumulative input across tool rounds is **not prepared context occupancy** and is not a claimed saving versus full. Failed reads made the successful atomic task process over 100k cumulative input despite its much smaller initial request.

The native reader repeatedly received `{}` and strict validation rejected it. The file task eventually read via a contained command, edited via str_replace_editor and verified with a successful contained command; it did not satisfy the deliberately stricter native-reader acceptance assertion. Atomic discovery independently succeeded: the model called manage_native_tools list with an intent query, activated editing, received edit_project_files from the next request, performed the atomic mutation and verified final contents. Git discovery activated git_write (source also activated git_read), then used native mutation tools successfully. New-run snapshots after these tasks have empty activated groups and the intended initial compact tool set.

The first Git harness assertion required git_log specifically, although the request allowed showing the latest commit with git_show or a read-only command. Those execution paths are valid. The source trace shows native git_show succeeded. The ASAR evidence independently records head message `Update fixture text`, an empty staged diff, successful native stage/commit/status, and a successful contained command whose output shows that commit. Its original automatic `passed:false` is retained in evidence as a **harness assertion defect**, with a separate corrected task assessment; it is not portrayed as a product Git failure or as an automatically green entire live suite. The repeatable harness now accepts either permitted history-display path.

A separate read-only native-reader diagnostic compared both profiles with identical task text, no permission to use commands, strict schemas and provider response argument-key tracing. See the evidence for the final bounded results. The final bounded diagnostic used two requests per profile: full reported 23,097 cumulative input / 273 output tokens; compact 12,395 / 243. Both stopped at the explicit acceptance request limit without a successful native read. The provider's streamed read_project_file arguments are empty in the full profile too; the omission is present before client tool execution, not manufactured by the argument validator. No schema constraint or permission was relaxed to let such calls execute. The full diagnostic also used commands despite the task forbidding them; compact called write_project_file despite the no-changes instruction. Those operations stayed within disposable Workspace Write fixtures, but they are further task-instruction adherence failures, not accepted reader behavior. The exact reason the model/runtime emits empty reader arguments is unresolved. This is a shared model/runtime acceptance problem, not evidence that compact alone removes file-reading capability. It still blocks a reliable default rollout.

A preliminary diagnostic was stopped after repeated identical failures: the workspace loop intentionally does not enforce casual maxAutoTurns/maxToolRounds, so those options did not bound it. The **acceptance harness only** now checks its own dispatch limit explicitly. The stopped preliminary runs recorded 29 full-profile dispatch attempts and two compact-profile attempts; these are not asserted to be 31 completed requests. Preliminary dispatch counts/partial status are retained in evidence; no missing completion usage is invented. Application turn policy and automatic context compaction were not changed.

To repeat live checks against an already-loaded matching local model:

```sh
NODE_ENV=production ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
  scripts/audits/compactRealModelCheck.cjs --output /tmp/compact-live.json
node scripts/audits/compactPackagedCheck.cjs /tmp/compact-asar-live.json \
  --live-case hello-compact,git-discovery
```

These commands are explicitly live and execute model-selected operations in disposable workspaces under the existing guards. The ASAR helper's normal invocation without --live-case remains synthetic. An installed release/AppImage GUI and actual approval UI interactions remain unvalidated; ASAR source loading and live ASAR inference/tool execution were exercised instead.

**Do not switch the default yet.** Fix or establish a reliable model/runtime-compatible native-reader contract without weakening source alternatives, pagination/hash constraints or validation, then repeat the native reader, edit/command, discovery and Git checks with bounded diagnostics. Retest live approval denial/downgrade UI behavior in an installed production app if qualifying that distribution. Once the relevant acceptance tests pass, change the single shared default to compact, update the held-default test, rerun the source/ASAR checks and production build, and retain the full override. The earlier report's schema compilation failure is resolved here; the newly measured real native-reader reliability gap is the current blocker.

See `compact-native-validation-evidence.json` for sanitized conditions, hashes, per-request prepared counts/provider usage, tool names, activation transitions and test completion names. No private original prompt or memory is published.

Follow-up on 2026-11-07: [native-reader-investigation.md](native-reader-investigation.md) adds structured wire/contract regressions and a bounded raw/template diagnostic. The matching server is currently unreachable, the generation-versus-server-parsing cause remains unresolved, and production remains full.

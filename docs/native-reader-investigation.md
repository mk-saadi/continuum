# Native reader follow-up — 2026-11-07

Production remains **full**. No reliable reader fix or compact rollout is claimed. The prior Ajv strictRequired repair remains intact. This follow-up adds diagnostics and regression coverage; it does not change the production schema, parser, permissions, or automatic context compaction. Existing unrelated working-tree edits were preserved.

The previous live evidence establishes a failure in the model/server tool-call representation before dispatch, in both profiles. It does **not** establish whether the model emitted an empty object in its original generation. The prior harness concatenates `delta.tool_calls[].function.arguments`, parses it, and retains argument keys. The server has already applied its tool-call parser at that point. An empty key list also loses the distinction between some JSON representations (for example, an empty array and object). Task-instruction violations in those runs are separate observations; they cannot all be attributed to reader schema interpretation.

## Traced contract

1. `tools/agentTools.js` defines reader properties, `required: []`, `additionalProperties: false`, and an exactly-one `oneOf` with locally declared typed source properties. A workspace path and attachment reference are alternatives. Strict schema compilation succeeds. Both profiles advertise the same reader schema.
2. `compactNativeTools.js` and `nativeToolActivation.js` select/filter the catalog. `promptBuilder.getToolContext` supplies the tools. `runMemoryChat` refreshes tools and serializes them in the request `tools` array without flattening the union. The fixed benchmark captures this actual serialization, rather than reconstructing a schema by hand.
3. The model server renders its chat template, generates text and parses tool calls into JSON or SSE. The current server/template implementation and raw generation were unavailable to inspect. A template which ignores union-level required fields is a hypothesis, **not an established cause**. Changing this schema based only on that hypothesis would be speculative.
4. `memoryChat.readCompletion` reads JSON tool calls directly. SSE handling groups calls by index, concatenates string argument fragments, and normalizes complete object JSON. Tool calls completed with `stop` require complete arguments; explicitly malformed `tool_calls` responses can reach the normal rejection/retry path. The separate XML fallback parses named `<parameter=...>` tags; it is a different representation and must not be equated with the server's structured tool output. No claim is made that arbitrary raw XML/JSON dialects are equivalent.
5. The loop parses arguments for execution steps and forwards the argument string. IPC parses again, checks the current advertised schema/manifest, performs strict validation, checks permissions and epochs, then dispatches. The native reader independently rejects both/neither sources. Workspace reads use contained paths and bounded/version-aware reads. Attachment reads resolve session-owned managed references, reject workspace/hash extras, and enforce read-only access. None of these checks supplies a missing filename.

New tests show no argument loss in the tested structured JSON/SSE paths: character-sized argument deltas and seven-byte transport chunks preserve paths, references, ranges and hashes, including `{}` and a malformed both-source call. This excludes those tested accumulation cases, not every possible server response. A bounded synthetic loop verifies rejection followed by a corrected explicit-path retry. Native tests use strict advertised-schema validation, real workspace and persisted attachment fixtures, pagination, a trusted revision hash, malformed calls, attachment hash rejection, ownership isolation and corrected retries. The existing selective reader suite supplies further containment, hash-conflict, pagination and permission coverage.

## Bounded live diagnostic

`scripts/audits/nativeReaderDiagnostic.mjs` sends no tool executions. It consumes only disposable benchmark captures. It retains the exact reader schemas, schema/catalog hashes, raw JSON/SSE responses and separately parsed Continuum calls. It compares both profile catalogs, an isolated actual reader, and a diagnostic-only top-level-required-path control across workspace pages, hash-checked calls and attachment pages. The control is never used by the application. Minimal fixture prompts are held equal; profile comparisons here compare tool advertisement, not full workspace prompt behavior.

Where supported, `/apply-template` captures the server-rendered minimal prompt and `/completion` captures generation without the chat endpoint's tool parser. Compare those outputs before assigning blame to generation, template rendering, server parsing or client accumulation. These are independent deterministic generations, not a guarantee of identical samples or an exact replay. Unsupported endpoints/statuses remain evidence, not passes. This diagnostic validates argument generation; its placeholder attachment reference/hash do not constitute real file-read acceptance. Actual reads still require the production acceptance harness and owned live fixtures.

Limits are **40 total HTTP requests, 180 seconds total, 15 seconds per request including body consumption, and 512 generated tokens per generation**. Health/props/template requests count toward the ceiling. The expected model basename is checked. The harness aborts without inference when `/health` is unavailable. An outer process timeout is also recommended:

```sh
ELECTRON_RUN_AS_NODE=1 NODE_ENV=production node_modules/electron/dist/electron \
  scripts/audits/compactPromptBudget.cjs --capture-dir /tmp/reader-captures
# Read-only; no selected tools are executed. Use only the fixture captures above.
timeout 195s node scripts/audits/nativeReaderDiagnostic.mjs \
  --capture-dir /tmp/reader-captures --output /tmp/reader-diagnostic.json
```

The final run attempted one `/health` request inside the sandbox and one outside it. Both failed to connect to `127.0.0.1:8080`. Earlier curl health probes also failed in both environments. **Zero inference requests completed**. No server was started, model reloaded, or host settings changed. The sanitized evidence retains the failed health probes and exact current schemas. No inference output, fresh provider input usage or live acceptance pass is invented.

## Verification and rollout gate

Eight selected source test files passed under Electron 44.7.0 / Node 24.21.0 / production mode: nativeReaderWire (six tests), nativeReaderContract (two tests), p2CompactNativeTools, selectiveFileReading, toolValidationReliability, memoryChat, nativePermissions and compactPromptBudget. These include default/full fallback, discovery, synthetic Git/denial/downgrade and strict schemas. An initial new test fixture needed a system prompt, unique retry call IDs and the attachment reader's existing newline semantics; after correcting those fixture expectations all passed. No whole-repository green claim is made.

The prompt budget passed unchanged: **full 45,007 bytes / 45 schemas; compact 25,197 bytes / 18 schemas**. Production estimates remain 15,067 / 8,463 tokens; these are not measured provider usage. No baseline update was necessary. Historical provider greeting counts (11,253 full / 6,117 compact) and offline tokenizer counts (11,242 / 6,104) belong to the prior report's conditions and were not remeasured today.

The temporary ASAR check passed its compact suite and normalized source-equivalent prompt budget with the retained full default and explicit compact override. This uses current source inside ASAR with external dependencies, Electron RUN_AS_NODE, disposable profiles and synthetic responses. **No installed AppImage, packaged GUI, approval UI, new distribution build or live ASAR inference was checked today.** The new reader regressions were run from source; they are not added to the ASAR helper's existing suite.

All real-model gates remain outstanding for this follow-up: native reads in both profiles (including real pagination/hash and owned attachments), compact read/edit/command, initially hidden group discovery, Git and denied/downgraded permissions, and fresh greeting provider usage. Required installed-package/GUI qualification also remains unverified. Consequently the shared selector stays on full, with `CONTINUUM_NATIVE_TOOL_PROFILE=compact` opt-in and `CONTINUUM_NATIVE_TOOL_PROFILE=full` fallback retained. Resume on an available matching runtime, inspect raw/template comparisons, implement only an evidence-supported fix, and then repeat acceptance before considering rollout.

Evidence: [native-reader-investigation-evidence.json](native-reader-investigation-evidence.json). The prior report and evidence are retained unchanged except for a link to this follow-up.

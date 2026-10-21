# Dynamic MCP discovery and hot activation report

Date: 2026-10-21. Focused reliability changes; no commits, installations, paid inference, LSP changes, or background-command changes.

## Findings and actual causes

The reported symptoms were poor browser-tool selection, advice to start a new turn/run after activation, and an approval prompt in Workspace Write.

1. **Discovery:** `buildSessionSystemPrompt` read the configuration but listed only server names. It excluded explicitly disabled entries even though Auto management can activate them for a chat. Browser guidance existed separately, but the catalog itself did not explain capabilities, readiness, or trust.
2. **Continuation wording:** both prompt and activation-tool description said “next turn.” This was ambiguous and could induce a model to stop. A missing hot-registration implementation was **not reproduced**: `runMemoryChat` already calls `getChatTools` before each inference; IPC reloads the manager and assembles session-filtered schemas there. The existing hot-reload loop test passed at baseline. The correct fix preserves that loop and makes its same-run behavior explicit.
3. **Approval:** `manage_mcp_servers` is classified as `EXTERNAL_MUTATION`. `guardTool` normally requests approval for native external mutations in Workspace Write. This activation gate is distinct from Playwright tool execution: MCP-hosted calls already receive the Workspace Write allow decision, followed by the manager's existing payload mutation backstop. No broad MCP execution exemption was added.

The original long-running user session was unavailable. These findings come from source tracing, existing deterministic tests and the new real-loop fixture, not reproduction of that specific model's decision.

## Discovery and prompt changes

Before (representative configured identifier):

```text
Available dynamic tools (MCP servers): "playwright-native".
... Its tools appear in your schema on the next turn.
```

After (captured from the real manager smoke attempt):

```text
"playwright-native" — Browser automation: navigation, page/DOM inspection and page screenshots. Status: inactive. Trusted bundled configuration.
```

The surrounding prompt explains `manage_mcp_servers(action="enable", server_names=[...])`, says schemas arrive before the next inference in the same run, and directs the model to continue without another message or restart. It distinguishes desktop screenshots, browser inspection, and public web search. Native tools remain preferred when directly sufficient. Unrelated speculative activation is discouraged.

`getDiscoveryCatalog` uses current registered metadata, explicit configuration descriptions, or the exact bundled Playwright preset. Unknown capabilities remain explicitly unknown. Descriptions and cached tool summaries are bounded; full input schemas, launch arguments, environment values, headers and credentials are not included. It can read persisted descriptive metadata before manager initialization without launching anything. Disabled integrations are described as inactive, not callable. Connecting, disconnected and failed states remain distinct. The prompt labels status as a startup snapshot; runtime schemas and activation results are authoritative.

The catalog is part of the system prompt and is rebuilt through the existing prompt builder on context recovery. No duplicate catalog is appended per inference.

## Manager, schemas and dispatch

Existing stable hashed tool names and session-filtered `getTools`/`resolveTool` remain authoritative. The manager awaits initialization and tool listing before returning success. Failure returns an actionable error and no callable schemas. Successful activation now explicitly says tools are available for the next inference request **in this same run**.

No active inference request is modified. The existing request-boundary callback rebuilds native plus authorized connected MCP schemas, including after context recovery. Dispatch resolves availability again; disabled or disconnected tools are rejected. Tool-list notifications, restart refresh and persisted disabled-tool filtering remain in the existing manager.

Management now rechecks Manual mode inside the serialized queue, observes cancellation before queued work and between activation steps, and revalidates trusted launch configuration from disk before launching under the exception. Cancellation during initialization does not kill a shared process; initialization remains bounded by the existing connection timeout. This is cooperative cancellation, not immediate per-caller transport cancellation.

## Authorization and trust

The narrow Workspace Write exception requires a workspace and the exact bundled `playwright-native` command, argument array, environment and launch fields. A server name, description, or `trusted` flag cannot grant trust. Modified commands, extra CLI arguments, injected environment variables and remote replacements fail comparison. The existing bundled executable configuration supplies the trust anchor; user-defined integrations require the existing approval path.

The exception covers managing that stored bundled configuration, not writing configuration, registering commands, shell execution or all tools on a server. The authorization marker is carried through the existing native executor into the manager, where disk configuration is checked again to close a configuration-change race. Other permission modes retain their existing policy. Read Only rejects activation, Ask for Permission still requires approval, Full Access retains its behavior, and untrusted Workspace Write activation still requires approval.

MCP payload mutation interception, browser security, native command containment and recovery boundaries are unchanged. This phase does not claim that payload pattern checks prove every possible browser action harmless. General MCP operation classification remains the existing policy; no new broad trust grant was introduced.

## Main agent, providers and state

The deterministic tests invoke the real `runMemoryChat` loop with the real manager and permission guard, an injected MCP transport and mocked model responses. The sequence is activation call → connected fixture → refreshed schema → browser snapshot call → paired result → final answer. Tests cover local/cloud loop flags and JSON/SSE responses, without inference charges.

There is one loop invocation, three model requests, one server launch and no restart. Existing task text survives; steering is delivered once; activation has zero approval prompts; another chat cannot see the activated fixture. Repeat activation does not reconnect. Deactivation rejects the stale hashed name.

The test does not boot Electron's IPC run owner, so it does not independently assert a persisted run ID, database plan/budget rows or recovery records. Those components were not rewritten. Existing transcript, steering and request-boundary code remains responsible for them.

Anthropic's adapter maps each request's current `payload.tools`; OpenAI-compatible/OpenRouter requests likewise consume current schemas. No provider cache or adapter changes were needed. The new tests cover the shared cloud loop, not live Anthropic/OpenRouter endpoints or every provider adapter end to end. Provider-specific compatibility is therefore not claimed universally.

## Ownership, concurrency, UI and activity

MCP mode is a global app setting. Auto activation remains a session override and does not persist global enable changes. Manual mode continues to use UI-enabled state and blocks agent management. The existing UI (`McpSettingsTab`) and IPC broadcasts remain intact. Session-filtered schemas prevent another Auto chat from inheriting an activation. Shared manager operations remain serialized.

Children use a fixed native read-only allowlist in `subagents/agentLoop.js`; MCP and MCP management are excluded. Parent activation does not add schemas to that allowlist. Child-managed activation has not been introduced.

Live steering still enters at inference boundaries. The fixture supplies steering directing browser inspection and verifies delivery alongside activation and tool use. Plans, budgets and recovery subsystems were not changed.

Existing manager `changed` events, connecting/connected/error/disabled statuses, native activity pending/results and context-token notifications are reused. Readiness is reported only after `listTools` finishes. No UI redesign or additional chat chatter was added.

## Deterministic evidence and measurements

`tests/mcpDynamicActivation.test.cjs`: **7/7 pass**. Covers exact trust identity, injected-command rejection, four local/cloud × JSON/SSE real-loop variants, initial schema absence, refresh and call, steering delivery, pairing, chat isolation, repeat activation, stale-call rejection, initialization failure, pre-aborted activation, Manual restriction, permission modes and config-race rejection.

Fixture measurements (characters, not tokenizer counts): compact two-server catalog **256**; minimal initial activation schema **93**; after one snapshot schema **279**. These are test schemas, not the full production native catalog. Across four runs activation took approximately **1.19–12.15 ms**, first fixture call **0.08–5.45 ms**, repeat activation **0.45–1.52 ms**. These in-memory fixture timings are not Playwright performance estimates. One launch, zero unnecessary reconnections, three requests total: activation, inspection, final response. No additional inference solely for schema refresh.

The baseline catalog was name-only; actual sizes vary by configured names and cached metadata. Full production catalog overhead and real-browser latency remain unmeasured. The evidence JSON records fixture timing samples and exact failing test-file identities.

## Real Playwright smoke attempt

The bundled package and its matching Chromium executable exist locally. A disposable config used the actual `nativePlaywrightConfig` and real stdio manager, initially inactive. Catalog discovery succeeded. Activation returned:

```text
Server 'playwright-native' could not be enabled: MCP error -32000: Connection closed
```

Zero schemas were exposed. The existing real stdio fixture also failed initialization in this environment with connection closure, while injected transports worked. The cause of the environment's stdio process closure was not established. No browser navigation, DOM inspection or screenshot passed, and no real-browser performance is reported. No additional server/browser was downloaded. The manager was closed and disposable configuration removed.

## Regression and build

The repository started with unrelated modified/untracked LSP, model settings, engine and subagent files. They were preserved.

`npm test` (`node --test tests/`) failed to resolve the directory in this Node 22 environment, so the same explicit file expansion was used before and after:

```sh
node --test tests/*.test.cjs tests/*.test.mjs
```

Baseline: **202 test-file entries, 166 pass, 36 fail**. Final: **203 entries, 167 pass, 36 fail**. These are file-level results from this runtime, not the historical 1,527 assertion total. Exact failing-file identities are unchanged: **zero added failures, zero resolved failures**. Existing MCP stdio/SSE/IPC, several LSP, recovery and other tests already fail here. Focused MCP files retain their pre-existing failures; the new deterministic file passes. Therefore this is not a claim that the full suite is green.

Production `npm run build`: baseline passed (22.17 s); final passed (21.38 s), with the existing large-chunk warning. `git diff --check` passes. Electron UI scripts needing a running display/app were not exercised interactively.

## Changed files

- `src/main/mcpManager.js`: compact catalog, trust eligibility, queued mode/config revalidation, cancellation checkpoints, truthful activation response.
- `src/main/nativePlaywright.js`: exact bundled launch identity comparison.
- `src/main/promptBuilder.js`: capability catalog and same-run/native-vs-browser guidance.
- `src/main/toolPermissions.js`: narrow trusted Workspace Write management exception.
- `src/main/tools/agentTools.js`: same-run description; carry trust/cancellation to manager.
- `tests/mcpDynamicActivation.test.cjs`: new deterministic loop/authorization tests.
- `tests/agentTools.test.cjs`, `tests/sessionPromptWording.test.cjs`, `tests/promptCorrectness.test.cjs`: update discovery expectations; disabled entries are now discoverable but inactive.
- This report and `docs/dynamic-mcp-hot-activation-evidence.json`.

## Limitations and manual verification

Real-browser smoke and a green full regression suite remain unavailable. There is no new Electron IPC integration assertion for persisted run IDs, task-plan rows, mid-run permission downgrade, cancellation during a real initialization timeout, or shutdown during initialization. Existing code paths are preserved, but these acceptance scenarios need verification in a working desktop environment. Custom and legacy Playwright launch variants are intentionally not silently trusted; use the exact bundled configuration or the existing approval path.

Manual desktop procedure:

1. Select Auto globally; leave bundled Playwright inactive; use a disposable workspace in Workspace Write.
2. Start a coding task with a local test app and an existing plan. Record the run ID and pending steering state.
3. Steer the running agent to inspect the local application using Playwright.
4. Confirm activation proceeds without an approval prompt, reaches connected only after initialization, and adds browser schemas on the next request.
5. Navigate locally, inspect the page, and capture a page screenshot. Confirm all results and the final answer belong to the original run and plan.
6. In a second Auto chat confirm detailed schemas are absent until authorized there. Disable the integration and verify subsequent/stale calls fail.
7. Switch to Manual and verify only UI-enabled tools appear; agent management is blocked. Test Ask for Permission and a modified/untrusted launch command to confirm approval remains required.
8. Exercise cancellation, reconnect, queued mode switch, permission downgrade and application shutdown while monitoring activity and plan continuity.

This report does not declare every requested desktop acceptance scenario complete; it distinguishes the passing deterministic fixes from the remaining integration verification gaps.

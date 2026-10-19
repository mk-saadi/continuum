# Reasoning Controls Compatibility Report

Date: 2026-10-19

## Scope

This change makes reasoning/thinking settings target-aware across every inference
path in Continuum:

- local `llama-server` chats and local sub-agents;
- cloud chats and cloud sub-agents, including independently selected child
  models;
- casual chat, workspace chat, main chat, agent runs, one-shot child execution,
  investigation loops, forced-answer continuations, and context-recovery
  measurement;
- streaming and non-streaming requests;
- model switches and context-window re-resolution mid-chat.

The renderer persists a normalized user intent. The main process resolves that
intent against the actual selected model/provider immediately before each
request. Provider-specific wire parameters are never inferred in the renderer
and never sent to a target that has not reported or documented support.

No commit, push, stash, or reset was performed.

## Normalized intent

Persisted settings keep two independent fields:

| Setting | Meaning |
| --- | --- |
| `thinkingBudget` | `-1` = Automatic, `0` = Off, positive integer = numeric token budget |
| `reasoningEffort` | A named effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) or `null` |

`normalizeIntent()` produces exactly one of:

- Automatic — send no reasoning field, preserving the provider/model default;
- Off — disable reasoning only where the target supports it;
- Effort — send one named effort where the target supports that exact effort;
- Numeric budget — send a token budget only where the target supports one.

The resolver never converts a numeric budget into an effort or an effort into a
numeric budget. An unsupported persisted value resolves to **Automatic** with a
warning; it is not silently coerced. Numeric budgets are clamped only to a
target-reported maximum, and the clamp is reported.

Persistence uses the existing sampling JSON (`thinking_budget`) plus the new
`reasoning_effort` key. `reasoning_effort: null` clears a session override.
Global, per-model, and per-session settings continue to use the existing
three-tier precedence.

## Capability resolution

`src/lib/reasoningControls.cjs` is the shared pure contract. It owns intent
normalization, provider-family detection, capability resolution, warning text,
public capability views, and wire mapping. `src/main/reasoningRuntime.js` is the
async bridge that reads effective settings and cached cloud metadata for a
specific session/model/target.

Cloud capability families:

| Family | Detection | Reported controls |
| --- | --- | --- |
| Anthropic | `apiType: "anthropic"` | Adaptive effort for 4.7+, legacy numeric budget for older models, disable |
| OpenRouter | host `openrouter.ai` | Metadata-reported effort, budget, disable, and mandatory reasoning |
| DeepSeek | `api.deepseek.com` | Effort `low`/`high`/`max`, enable/disable; no numeric budget |
| Gemini | Google Generative Language hosts | Per-model effort/disable/budget rules |
| OpenAI | `api.openai.com` | Effort only; no numeric Chat Completions budget |
| Compatible | Any other saved provider | Only parameters listed in that provider's model metadata |

Local capabilities come from scanned GGUF template metadata:

- `supportsReasoningEffort` — the template or scanner reports effort support;
- `supportsReasoningBudget` — the template exposes reasoning **end tags** that
  the installed runtime can enforce;
- `supportsDisableReasoning` — the template can disable thinking.

When metadata is missing, the public capability view says `null` ("unknown")
instead of guessing. When a model reports no reasoning controls, the UI says
"Unavailable". These are deliberately different labels.

## Provider wire contracts

### Local llama-server

The installed runtime contract is:

- top-level `reasoning_effort` (`"none"` sets `enable_thinking=false`);
- top-level `reasoning_budget_tokens` (alias `thinking_budget_tokens`);
- request-level `reasoning_format`;
- `chat_template_kwargs` merged into template context.

Legacy local fields (`thinking_budget`, `reasoning_budget`,
`max_thinking_tokens`) are not used: the installed runtime silently ignores
them. Local mapping is:

- Automatic: no fields;
- Off: `reasoning_effort: "none"` plus `reasoning_budget_tokens: 0` only when
  the template advertises budget support;
- Effort: `reasoning_effort: "<effort>"`;
- Budget: `reasoning_budget_tokens: <budget>`.

A numeric local budget is only advertised when the rendered template has
reasoning end tags. This is model/template-dependent and is not a universal
local capability. The budget ceiling is the loaded context minus a 2,048-token
reserve, rounded down to 256-token steps. If a model only supports a numeric
stop signal through end tags, the UI does not pretend an effort control exists.

### Anthropic

- 4.7 and newer: `thinking: { type: "adaptive" }` plus
  `output_config.effort`. Off sends `thinking: { type: "disabled" }`.
- 4.6 and older: `thinking: { type: "enabled", budget_tokens: N }`. Off omits
  the thinking block because extended thinking defaults off.
- Numeric budgets require at least 1,024 tokens and must stay below
  `max_tokens`; the request's `max_tokens` is raised to at least
  `budget_tokens + 1` when needed.
- The maximum budget uses provider-reported output limits when available,
  otherwise a conservative fallback.

### OpenRouter

- Effort: `reasoning: { effort: "<effort>" }`.
- Budget: `reasoning: { max_tokens: N }`.
- Off: `reasoning: { enabled: false }`.
- Disable is not offered when metadata marks reasoning as mandatory.
- Effort/list/budget capabilities and bounds come from model metadata; the
  resolver never guesses OpenRouter support for an unknown model.

### DeepSeek

- Effort: `thinking: { type: "enabled" }` plus
  `reasoning_effort: low|high|max`.
- Off: `thinking: { type: "disabled" }`.
- Numeric budgets are rejected as unsupported rather than mapped to effort.

### Gemini

- Effort: `reasoning_effort: "<effort>"`.
- Off: `reasoning_effort: "none"` only on models that allow disabling.
- Budget: `extra_body.google.thinking_config.thinking_budget` on models that
  report numeric-budget support.
- Gemini 2.5 Pro and Flash use their documented per-model ranges; Gemini 3
  models report effort support without a numeric budget in this contract.

### OpenAI

- Effort: `reasoning_effort: "<effort>"`.
- No numeric thinking budget is sent on Chat Completions.
- Known GPT-5/o-series rows do not advertise disable; a persisted Off resolves
  to Automatic with a warning instead of sending an undocumented value.

### Generic compatible endpoints

Only parameters explicitly listed in `supportedParameters` are sent. An
advertised effort list without a documented wire parameter is not treated as a
wire contract. This prevents generic endpoints from receiving `reasoning`,
`reasoning_effort`, or budget fields they never advertised.

## UI behavior

`AgentSettingsPopover` now contains one compact capability-driven
`ReasoningSelector` (the old `ThinkingBudgetSelector` export remains as an
alias for compatibility). The composer calls the new
`reasoning:capabilities` IPC and renders:

- **Automatic** when the model exposes any control;
- **Off** only when disabling is supported;
- exactly the efforts the model reports;
- **Custom budget** only when numeric budgets are supported, with the reported
  min/max and a 256-token step;
- **Unavailable** when the model reports no reasoning support;
- **Unknown** when metadata cannot establish support.

Saved values are re-resolved after a model or provider switch. If the newly
selected target cannot honor the saved intent, the selector shows Automatic and
the resolver's warning; the old value is not silently applied or coerced. The
renderer no longer sends `reasoningEffort`, `thinkingBudget`, or any provider
wire field with chat requests. It sends only the session/model/provider
identity needed by the main process.

## Consistency across execution paths

- Main chat resolves reasoning before every request and re-resolves after
  context recovery using the recovered window.
- Streaming and non-streaming use the same resolution and mapping.
- Child investigation loops resolve against the child's own effective engine
  and model settings.
- One-shot and forced-answer child continuations do the same.
- A child never inherits the parent session's reasoning override or wire
  parameters. Cloud children use `cloud:<provider>:<model>` as their settings
  key; local children use their GGUF path.
- A child on a different provider/model receives that model's capabilities and
  limits, not the parent's.
- Mid-chat model switches read settings and capabilities again; nothing is
  cached as if the previous model were still active.

## Usage accounting

`completionStats.mjs` now recognizes reasoning tokens from every supported
shape:

- `usage.completion_tokens_details.reasoning_tokens`;
- `usage.output_tokens_details.reasoning_tokens`;
- `usage.reasoning_tokens`;
- `usage.thoughts_token_count`;
- local `timings.reasoning_n`.

Reasoning tokens are treated as a **measured subset of completion/output
tokens**, not as another output total. Reports expose:

- input tokens;
- measured completion/output tokens;
- reasoning tokens when reported;
- visible output tokens, derived only as `completion - reasoning` when both
  are measured;
- total tokens;
- `reasoningCoverage` of `measured`, `partial`, `unreported`, or
  `unavailable`.

Unreported reasoning stays unknown instead of being inferred from the
configured budget. Sub-agent ledgers and continuation state preserve the same
subset semantics and avoid double counting. A configured budget is never
reported as consumed tokens.

Provider limitations are surfaced honestly: for example, if a provider does not
expose a separate reasoning counter, visible output remains unknown and
coverage says unreported. Local runtimes that do not report `reasoning_n` are
handled the same way.

## Test coverage

New deterministic tests:

- `tests/reasoningControls.test.cjs` (18 tests): intent normalization,
  Automatic no-op behavior, local mapping/gating/clamping, unsupported
  warnings, family detection, Anthropic adaptive/legacy mapping, OpenRouter,
  DeepSeek, Gemini, OpenAI, compatible endpoints, and the public capability
  shape.
- `tests/reasoningRuntime.test.cjs` (7 tests): child settings isolation from
  the parent, cloud child model keys, serializable cloud descriptors,
  metadata-gated compatible endpoints, context-size re-resolution, mid-chat
  model switches, unsupported intent, Automatic defaults, and target helpers.
- `tests/reasoningUsage.test.cjs` (6 tests): every provider reasoning shape,
  visible-output derivation, no double counting across phases, partial /
  unreported coverage, and sub-agent ledger subsets.

Updated deterministic tests include `memoryChat`, `cloudProviders`,
`desktopChat`, `mcpIpc`, `settingsResolver`, `ggufMetadata`, and
`subagentModelBudgets`.

Updated Electron UI tests:

- `tests/thinkingBudget.ui.cjs` (now exercises the capability-driven selector,
  Off/effort/custom-budget modes, bounds, persistence, and unavailable/unknown
  labels);
- `tests/reasoningSettings.ui.cjs` (composer integration, local and cloud
  targets, renderer payload exclusions, model switch restoration, and disabled
  engine state).

Both UI tests passed under `xvfb-run` with Electron 44.7.0.

## Verification results

- Full suite: `node --test "tests/**/*.test.cjs" "tests/**/*.test.mjs"`
  - 1,271 tests
  - 1,243 passed
  - 27 failed
  - 1 skipped
- Baseline before this work: 1,240 tests, 1,212 passed, 27 failed, 1 skipped.
- The 27 failures are the same pre-existing failures recorded in the baseline;
  there are no new failures.
- `npm run build` succeeded (Vite production build, 1,809 modules). The build
  retains the existing large-chunk warning only.
- No paid-provider live tests were run. No live local-model reasoning test was
  required for the deterministic contract; capability detection is covered by
  GGUF template fixtures.

## Known limitations and approval boundaries

- Local numeric budget enforcement depends on the model's chat template
  exposing reasoning end tags and on the installed `llama-server` build. There
  is no universal local budget switch; models without end tags report budget
  as unsupported.
- Local effort support depends on the template's `reasoning_effort` handling.
  The resolver does not invent efforts the template does not mention.
- Anthropic does not expose a separate reasoning-token counter through the
  normalized response path, so reasoning coverage remains unreported there
  unless the provider adds one.
- Provider metadata discovery is advisory. If metadata lookup fails, the UI
  reports unknown/unverified rather than guessing, and Automatic preserves the
  provider default.
- No native runtime changes were required for this work. If future
  `llama-server` versions expose a first-class budget flag, capability
  detection should be updated to consume it rather than relying on template end
  tags.

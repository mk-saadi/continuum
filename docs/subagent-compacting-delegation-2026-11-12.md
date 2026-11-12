# Delegated source analysis uses the compacting child loop

November 12, 2026

## Cause

`spawn_sub_agent` used the durable investigation loop only for `investigate:true`.
Explicit `target_file` and URL tasks instead used one-shot file/web executions.
Those executions never entered `createChildContextAdapter`, so removing budgets
could not enable mid-task compaction or staged source reading on those paths.

## Change

All `spawn_sub_agent` source forms now call `runInvestigation`. File targets
become project-relative source instructions, with numbered paginated reads through
`read_project_file`. URL targets instruct the child to fetch the specified page.
Both keep the same selected child model, scheduler, read-only permissions,
parent ownership, independent history, cancellation, persistence and compaction.
The one-shot runtime APIs remain available to their existing direct callers;
this change affects the parent-facing delegation tool.

Unlimited output uses a working generation reserve when deciding whether to
compact, then grants available context at request admission. Reserving the whole
window during compaction planning would incorrectly leave no room for input.
Confirmed-overflow recovery uses the same planning reserve.

## Verification

- File delegation through a local HTTP fixture reads source with a native tool,
  includes its result in the next request, and completes in a distinct child.
- Spawn schema/routing, child loop, completion, continuation, compaction and
  compaction-hardening regression suites pass.
- Existing long-horizon scripted benchmark passes: 220 tool calls, repeated
  compaction within a 32K context, more than 2M simulated cumulative input tokens,
  suspension at an explicit finite limit, renewal and completion.
- Unlimited-output regression confirms ordinary requests do not immediately
  exhaust context during compaction planning.

## Limits of this evidence

The model responses and benchmark usage are scripted, not live inference.
These checks establish orchestration, not local-model answer quality. Actual
compaction requires it to be enabled for the selected model. Configured budgets,
permissions, cancellations, provider failures and malformed responses remain
real stop conditions. A model that repeatedly emits no answer is not guaranteed
to converge. Native page extraction and result preview limits are unchanged.

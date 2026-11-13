# Background commands and automatic continuation

Main workspace runs separate command lifetime from interactive tool waiting.

- `execute_command` defaults to a one-hour wall-clock lifetime. Both command
  and background lifetimes accept 1 second through 24 hours.
- With `background` omitted, a command waits up to 10 seconds, then yields a
  managed command ID for the same process. Quick commands return their normal
  terminal result and do not remain in the background command card.
- `background: true` returns a managed ID promptly. `background: false` waits
  synchronously. Runs without a main-workspace owner retain synchronous
  behavior. `run_tests` remains synchronous, with the longer lifetime bounds;
  use `execute_command` for checks that should yield to independent work.
- While the agent performs other work, completion events enter its original
  conversation at the next model-request boundary, including nonzero exit and
  timeout outcomes. The agent retrieves bounded output with `get_command_status`.
- If the model finishes its response while ordinary owned commands remain,
  the runtime retains the conversation and waits on command events. No model
  request, open model response stream, shell sleep, or repeated status tool call
  is required during this wait. Completion wakes the same conversation.
- User steering wakes a waiting conversation. Stop, permission revocation,
  session deletion and application shutdown continue to cancel owned work.
- Explicitly persistent development servers (`survive_run_completion: true`)
  do not hold the task in the waiting state. Their existing finite lifetime,
  authorization checks and manual stop controls remain in effect.

The app must remain running. This is an in-memory suspended conversation, not
restart recovery: interrupted commands are recorded with an unknown outcome
and are never silently restarted. The run remains owned by its existing chat;
new input can steer it rather than starting a competing agent in that chat.

Workspace networking now permits the 24-hour command maximum and renews the
shared owner's safety deadline for each authorized launch. A command launched
late in an owner's lifetime receives its full requested command budget. CPU
allowance is derived from wall-clock lifetime and the existing two-core quota,
rather than an unrelated 60-CPU-second cutoff. Memory, process-count, network,
filesystem and authorization restrictions remain enforced.

Background recovery workflows have their own maintenance lease, independent
of the short startup tool call. Cleanup cannot remove an active checkpoint;
independent tools may proceed while cleanup waits for a background workflow.

## Verification

- `tests/backgroundCommandWaiting.test.cjs`: inference-free wait, success,
  failure, timeout, completion-before-sleep, cancellation, scoped steering wake,
  persistent-server exclusion, and actual automatic yield of one process.
- `tests/backgroundCommands.test.cjs`: existing background lifecycle suite.
- `tests/commandExecutionReliability.test.cjs`: real shell behavior and bounds.
- `tests/recoveryMaintenance.test.cjs`: normal cleanup fairness and background
  checkpoint protection without blocking independent tools.
- `tests/networkCommandLifetime.test.py`: validated lifetime bounds, CPU budget,
  and a late launch renewing the network owner without waiting hours.
- Real transport acceptance uses the existing pinned local helper through
  `tests/b2dNetworkExecution.test.cjs`; actual kernel resource limits are checked
  by the development-profile case in `tests/b2fPreviews.test.cjs`.

Tests use short real commands and controlled terminal events; they do not
claim a continuous 24-hour soak test.

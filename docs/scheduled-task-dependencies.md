# Task dependencies and restart recovery

The task editor's **Trigger** selector supports **After another task finishes**.
Choose one predecessor and optionally include its result and failure details.
Each successful or failed predecessor run queues one dependent run, including
manual runs. The dependent uses its own model, instructions, permissions and
workspace, in a fresh chat. Included results are reference data, capped at
24,000 characters; the original chat remains available through run history.

Queued, running, cancelled, blocked, skipped, missed, expired and interrupted
predecessor runs do not trigger dependents. Tasks can form chains and fan out,
but self references and cycles are rejected. Paused dependents do not collect
new triggers. Changing a dependency or pausing a task cancels its queued
automatic runs. Deleting a predecessor leaves the dependent visibly needing
attention and cancels its pending automatic runs. Execution remains serial.

Completion and dependent queue insertion share one database transaction.
A unique `(task_id, source_run_id)` index prevents duplicate delivery; pending
dependent runs survive process restarts. Creating a dependency does not replay
past completions. Queued dependents retain the source run and the selected
result snapshot even if other predecessor runs finish before they execute.

## Missed and interrupted runs

The default **Run the latest missed or interrupted task when the app opens**
policy (`until_next`) queues the latest eligible occurrence on startup or wake.
It never replays a backlog. An interrupted attempt is retried only before its
next scheduled occurrence; at that occurrence the latest slot takes priority.
One-time tasks have no next occurrence and remain eligible without an age limit.
Paused tasks do not automatically retry. Existing grace and catch-up policies
are migrated once to this policy; explicit skip preferences are preserved.
The legacy grace, skip and replay-every-missed-run options remain selectable.

Retries reuse the occurrence record and increment `retry_count`. Each retry
uses a new chat, preserving previous attempt chats. This restarts the prompt;
it does not resume an agent checkpoint, and actions before interruption may
repeat. Dependency runs have no time schedule and stay eligible after restart.
A dependent of a retried run waits for that run to succeed or fail.

The app must be open. Model availability, active chats and the serial queue can
delay execution. Existing model fallback, permissions and runtime budgets apply.

## Model handoff and preparation retries

Scheduled tasks wait for active engine turns to finish, including turns using
an already-loaded copy of the task model. Waiting does not consume the task's
execution budget. When a different local model is loaded, the scheduler waits
for it to become idle, unloads it, waits for its process to exit, and then loads
the task's configured model with its saved settings. The task model stays loaded
after completion. An explicitly configured fallback can still be used when the
primary cannot be prepared; a busy model alone does not trigger fallback.

A model startup failure or deferred unload leaves the occurrence **Deferred**
with a diagnostic reason and a retry deadline. Subsequent ticks retry the same
occurrence; reopening the app makes preparation retries immediately eligible.
For latest-only recovery, an occurrence expires when the next slot arrives.
Earlier startup failures recorded as **Skipped**, without a started turn or
chat, are also recovered on startup while that occurrence remains eligible.
No dependent task is triggered by a pending model preparation failure.

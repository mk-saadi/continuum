# Retired compaction audit material

These `.txt` files are inert snapshots of the retired implementation and its old tests. They are outside `src/main`, are excluded from the application bundle, and are not active acceptance suites. They are retained to make the architectural replacement reviewable, rather than silently erasing the previous checks. Reproduce historical behavior from the original audit's source revision (`db248f464fe5ac29a431d2458359afb538e6cbad`) and its recorded working-tree evidence, not by loading these snapshots into the current app.

The previous `autoCompactionAudit.cjs` asserts defects of that historical engine; it is not a current acceptance command. Its report/evidence remain historical source evidence.

## Where the meaningful lifecycle assertions moved

| Previous suite family | Active replacement coverage |
| --- | --- |
| Workspace safe/advanced/candidate, automatic replay, casual recovery | `mainChatCompaction.test.cjs`, `contextOverflowRecovery.test.cjs`: production loop/builders/transports, both main modes, pairing, same-run repeated compaction, source changes, atomic writes, no repeated effects, branch/variant safety, background result updates. |
| Structured/checkpoint/semantic summaries and correction diagnostics | `conversationCompaction.test.cjs`: one ordinary Markdown generation, no tools/schema/correction pipeline, coverage of stages and previous summaries, invalid responses, cancellation, fit/shrink and modest emergency savings. Citation/schema/evidence-union assertions are intentionally retired product behavior. |
| C6-C actual coding acceptance | Ported in place to the new service: real temporary files, native read/edit/retrieval and a failing then passing Node test across three compactions. Scripted inference and estimates remain labelled. |
| Lifecycle, legacy checkpoint/brief selection and idle projection | `compressionLifecycle.test.cjs`, main restart/branch tests, existing deletion/attachment/plan suites. No idle compaction owner remains. Legacy read-only compatibility fixtures explicitly seed old records. |
| Child compaction/checkpoint hardening | Updated `subagentCompaction.test.cjs`, `subagentCompactionHardening.test.cjs`, lifetime-budget, continuation, timeout and process-restart suites. Requests, committed versions and tool effects are counted separately. |
| Context panel/checkpoint/archived UI and activity | Updated `contextPanel.test.cjs`, `contextPanel.ui.cjs`, `compactionActivity.ui.cjs`, context budget/UI tests. One summary, current capacity/usage, safe text rendering, status, ordering and session isolation. |
| Work-log prompt placement | Storage/legacy association checks remain active with explicit legacy fixtures. Prompt tests now assert no historical brief or work-log injection. |

No production module imports these files. New acceptance must target the production shared core and its adapters.

`workLogPanel.ui.cjs.txt` exercised the retired three-panel context interface; active rendered coverage lives in `tests/contextPanel.ui.cjs`.

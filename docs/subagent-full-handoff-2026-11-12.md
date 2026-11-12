# Complete child-to-parent answers — November 12, 2026

The display fixes did not cover the inference handoff. Investigation finish clipped the generated final answer to 6,000 characters before storing/returning it. One-shot file/web completion imposed a separate 6,000-character limit. The parent then applied its generic 20,000-character tool-output guard to child results. Those cuts could remove the middle/end of a successful analysis even when the model request had ample capacity.

Generated child answers now return intact. The parent exempts delegation answers from the generic bulk-tool excerpt guard; formatting and secret redaction still apply. All ordinary provider output limits, lifetime/request accounting, permissions and context budgeting remain. A genuine provider length/interruption is still reported incomplete. Normal compaction may summarize older complete conversation under context pressure; arbitrary per-answer character clipping no longer substitutes for it.

The end-to-end regressions assert complete content equality in the parent's actual next inference payload beyond both former caps. They cover investigation finish, real one-shot file execution through parent dispatch, and all delegation tool names (`spawn_sub_agent`, `delegate_task`, `extract_web_page_data`). Independent child status updates and ordered model history remain covered. All 40 acceptance suites, the build and diff check pass. Inference is scripted; this is not live model certification. See the companion evidence JSON.

Old answers already clipped before storage cannot be reconstructed by these changes. A packaged installed application must be rebuilt/reinstalled to receive the fix.

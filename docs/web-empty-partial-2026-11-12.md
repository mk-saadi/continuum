# Empty page extraction and partial child reports — November 12, 2026

A direct read-only probe of the reported React toast demo returned HTTP 200 with 1,132 bytes of HTML, an empty app root and one script. Continuum's text-only extractor returned zero readable characters. The site requires JavaScript rendering; this result does not establish that the rendered site lacks content. The page tool now returns a specific `WEB_PAGE_NO_READABLE_CONTENT` explanation instead of blank successful output. It still does not execute JavaScript.

The third repeated fetch triggered `no_progress`, which previously propagated across its batch and skipped a different web-search call. Repetition is now blocked per call. An alternative valid call in the same batch can execute, and a wholly stalled repeated-only batch still terminates honestly. Existing request/tool limits remain.

The transcript previously marked skipped calls green because it defaulted every recorded tool result to complete. Skipped calls now show Deferred/not executed; plain tool errors show failure. Partial results retain their answer without also copying it into `session.error`. Historical duplicate partial errors are suppressed in the modal. Partial run badges use warning styling. A complete explanation of missing evidence remains a partial research outcome, not automatic task success.

All 40 acceptance suites pass, plus 14 web-tool cases and five transcript-display cases. The rendered modal confirms one copy of a partial report, long-text behavior and completion/reopening. Build and diff checks pass. The website probe was live; model inference in tests was scripted. The packaged application needs rebuilding/reinstalling to receive the changes. See the companion evidence JSON.

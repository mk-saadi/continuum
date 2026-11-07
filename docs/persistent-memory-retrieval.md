# Local persistent-memory retrieval

Full facts and scope/active/core flags remain in `permanent_memories`. Existing explicit FTS and paginated memory search tools remain available. Automatic prompts now select relevant facts instead of the newest five.

`memoryRetrieval.js` generates all meaningful words and adjacent phrases from each fact and category. It normalizes plurals, supports a small explicit alias vocabulary (including commit/Git), discounts aliases, weights uncommon words more heavily, boosts phrase matches, and ignores common words such as “name.” Ties resolve by memory ID. This is lexical retrieval, not semantic understanding.

The derived SQLite `memory_keyword_index` is created and reconciled before retrieval, including facts saved before this upgrade. Source rows are authoritative: missing, stale, malformed, or outdated entries are regenerated without parsing or trusting cached data. Updates and deletes invalidate entries with SQLite triggers; new/edited facts are indexed on the next retrieval. Inactive, superseded and deleted facts are removed from the index. This intentionally scans hundreds of small facts to reconcile and rank, rather than adding a worker, service or embedding dependency. Only selected full facts enter the prompt, never index terms.

Global, current-model and current-project scopes are eligible, matching existing recent-memory scope behavior; other model/project scopes are excluded. Existing profile/session memory switches still gate injection. No new agent scope is invented.

The explicit policy is at most 10 facts and 2,048 estimated tokens for formatted fact lines, shared between core and relevant facts. The estimate uses UTF-8 byte length, deliberately conservative; fixed section headings/instructions are additional. Core facts take priority, then relevance, then ID. Oversized facts are skipped whole, and overflow core facts remain stored and searchable. Core flags are preserved. The settings page explains this policy and new manually entered facts default to relevance retrieval; users can still mark essential facts.

Interactive `engine:chat` refreshes its one memory context block before every model request. The query combines the current user prompt with names/arguments of the last eight assistant tool calls (at most 2,000 argument characters each). It excludes injected facts and tool output to avoid self-reinforcing retrieval. Activity is visible on the request following a tool call, not before that tool executes; this is not a pre-execution policy/identity enforcement mechanism. Other prompt-builder consumers get initial retrieval; standalone/delegated runners do not gain activity refresh automatically. The hook replaces rather than appends context, bounding duplicate facts and total selected memory size within each request.

Automatic context compaction was not changed.

Validation: `node --test tests/memoryRetrieval.test.cjs tests/memoryChat.test.mjs tests/memoryNormalization.test.cjs tests/promptCorrectness.test.cjs tests/memorySearchApproval.test.mjs tests/settingsResolver.test.cjs` covers relevance/irrelevance, ranking, aliases/variants, scopes, core priority, count/size caps, legacy indexing, malformed/missing index repair, edits/deactivation/deletion, and request-boundary refresh without duplicate blocks. Existing prompt/settings/search/chat coverage also passes.

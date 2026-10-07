# Continuum streaming and tool execution performance audit

## Findings

| Path | Finding | Impact | Change |
| --- | --- | --- | --- |
| `ipcHandlers.js` → `createMessagePersistence.update` | Every text delta synchronously updated SQLite, serialized the full execution timeline, reloaded the row, and rebuilt its variants. | Main process stalls and repeated large allocations, especially after tool output. | Coalesce in-progress snapshots to one every 250 ms; commit completion and interruption synchronously. |
| `ipcHandlers.js` IPC notifier | Each text delta crossed IPC twice (`engine:stream-chunk` and `engine:chat-event`). | Serialization and dispatch work rose with token rate. | Aggregate deltas for 40 ms per request; drain before tool events and invoke completion. The legacy and current channels now both receive aggregated text. |
| `memoryChat.mjs` timeline publisher | Every visible text delta called `structuredClone(executionSteps)` even though no step changed. | Full timeline copy per token and increasing GC cost as the run grew. | Stop publishing steps for text deltas; throttle changing thoughts and argument previews to 50 ms; publish tool status transitions immediately. |
| `desktopChat.mjs` and `ChatInterface.jsx` | Text buffers used repeated concatenation, and every renderer text callback mapped chat state. | Repeated string allocations and React updates. | Use chunk arrays; `useStreamBuffer` publishes at most every 32 ms and flushes the complete reply before saving. |
| `ChatMessage.jsx` | Streaming text entered the Markdown, raw HTML, syntax, and media rendering pipeline on every update. | Parsing and DOM work proportional to the growing reply on every frame. | Render plain text while streaming; render Markdown when the reply completes. |
| Tool execution timeline | Full results and arguments reached IPC and React state; closed tool cards still formatted and highlighted results. | Large bridge payloads, retained heap, and avoidable render work. | Limit each displayed field to 10,000 characters before IPC and in loaded chat state. Full execution steps remain in session persistence. Closed cards omit code sections and directory parsing. |
| Chat listener lifecycle | `desktopChat.mjs` request listeners and `ChatInterface.jsx` subscriptions already returned cleanup functions. The main-process MCP subscriber set retained destroyed senders until another change event. | Stale sender references could remain indefinitely. | Keep request cleanup; remove MCP subscribers when their sender is destroyed. |
| Historical messages | `ChatMessage` had default memoization, but an inline answer callback changed on each parent render. | Completed messages lost the benefit of memoization. | Stabilize the callback and use an explicit prop comparator. |

## Verification and limits

- A synthetic test sends 1,000 small deltas and verifies one aggregated IPC text event, preserved ordering, and final drain. This verifies dispatch behavior, not an end-to-end latency number.
- The existing desktop chat and XML tool streaming tests pass, including tool status transitions and listener cleanup.
- The production Vite build passes. Its pre-existing large bundle warning remains; bundle splitting is separate from streaming responsiveness.
- The full test suite could not pass in the current environment because `better-sqlite3` was built for Node module ABI 123 while the installed Node runtime requires ABI 127. The `npm test` script also invokes `node --test tests/`, which this Node runtime treats as a missing module; direct test file invocation works.
- This is a source audit with focused synthetic checks. It does not claim measured UI frame times or heap profiles from a live generation session.

## Follow-up pass

The second pass isolates active text in a subscribed child component. Token frames append only the new text to one DOM text node, while the chat list keeps its existing message objects until the reply completes. Regenerated replies use the same path. Draft token counts update at most once per second during generation and once more at completion.

Completed directory tools now open on demand, and closed thought and delegation cards defer their content trees. Completed tool previews retain their object identity while later steps stream, so those cards avoid repeated formatting. The new `session:load-display` IPC route caps saved tool payloads before crossing into the renderer; the existing full session route and SQLite records remain available for execution and persistence.

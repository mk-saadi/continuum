# Migrating Chat-Interface Error Messages to react-toast-master Custom Toasts

Date: 2026-10-20 · Scope: main chat interface (`src/components/main-app/ChatInterface.jsx` and its direct error surfaces) · Package: `react-toast-master@3.0.1` (already in `package.json`)

## 1. Current state — how errors are shown today

All error display in the chat interface is **inline, state-driven, and non-dismissable** (it clears only when the triggering condition resolves or a new action succeeds). There is no global toast system for errors yet; the two floating "toasts" that exist (`ToolApprovalToast`, `ToolLimitToast`) are custom hand-rolled components.

| # | Surface | Where rendered | State / trigger | Behavior today |
|---|---------|----------------|-----------------|----------------|
| 1 | **History error** (session load, chat create/switch/delete failures) | `ChatInterface.jsx:1756` — `<p role="alert" class="p-2 text-[var(--error-soft)]">` at top of transcript column | `historyError` state; set by `refreshHistory().catch`, workspace-chat guard ("Select and start a model…"), session ops (lines 430, 465, 494, 538); cleared on success (472, 506, 588) | Persists until next successful action; full-width line above transcript |
| 2 | **Summarize notice** (compression-lock warning after a sent prompt's save) | `ChatInterface.jsx:2097` — muted 11px line above composer, casual chats only (`!isWorkspaceChat`) | `summarizeNotice`, derived via `summarizeNoticeFor({message, isWorkspaceChat})` at line 1338 | Persists until next turn; informational, not red |
| 3 | **Mid-run questions error** (settings read/save failure) | Passed to composer area at `ChatInterface.jsx:2220` (`midRunQuestionsError`) | set in the settings effect `.catch` and `changeMidRunQuestions` catch | Inline near the toggle; cleared on retry success |
| 4 | **Tool limit toast** (agent hit tool-call budget) | `ToolLimitToast.jsx` — absolute-positioned card, top-center of chat pane (`top-3 left-1/2 z-50`, amber border, slate-900 bg), `role="alertdialog"` | `toolLimit` state from `onToolLimitReached` IPC; errors from its buttons call `onError={setHistoryError}` (line 1628) — i.e., **falls through into surface #1** | Modal-like card with Allow/Deny buttons; stays until resolved |
| 5 | **Paused loop banner** ("Agent reached max autonomous turns") | Inline JSX at `ChatInterface.jsx:~1634` — same absolute top-center pattern as #4, amber/slate styling | `pausedLoop` state from `onLoopPaused` IPC | Persists until turn resumes; has resume/stop buttons |
| 6 | **Tool approval toast** | `ToolApprovalToast.jsx`, rendered at line 1622 with `key={approvalId}` | `toolApprovals[]` from `onToolApproval` IPC, filtered by session id | Stays until the user answers; only first approval shown (`toolApprovals[0]`) |
| 7 | **Skill proposal / pending-interaction errors** (per-row) | `PendingInteractions.jsx:97,150`, `ChatMessage.jsx:696-701,774-778` — `<p class="project-error">` (`projects.css:47`: `color: var(--error); font-size: 13px`) | Per-step `step.status === "error"` + action `.catch(err => setError(cause.message))` | Inline under the specific step; bound to that row's identity |
| 8 | **Bridge/server errors** (spawn/bind failure) — adjacent, not in-chat | `App.jsx:159-296` → `TerminalLog.jsx:29`, `ModelSelectorModal.jsx:371`, settings slots via prop drilling (`serverError`) | IPC status channel + dedicated error channel | Inline banner inside terminal log / modal; cleared on next successful status (line 250) |
| 9 | **Chat export toast** — already a hand-rolled toast | `ChatHistory.jsx:222-334,640-647` — local `toast` state `{text, error}`, auto-hide after 4500 ms via effect timer, `role={error ? "alert" : "status"}` | Export success/failure in the history panel menu | This is the closest existing analogue to what react-toast-master provides |

Observations:

- **No shared toast primitive.** Surfaces #1–#3 are plain `<p>` elements; #4/#5 duplicate each other's styling by hand (same `absolute top-3 left-1/2 z-50 rounded-xl border … bg-slate-900` recipe); #9 implements its own 4500 ms auto-hide timer. Three independent implementations of the same idea.
- **Error text is raw** (`error.message`) everywhere — no truncation, no line-clamp, no "show more". A long stack-ish message stretches an inline `<p>` and can push the transcript down (surface #1 sits above it).
- **Accessibility is already correct at each site** (`role="alert"` / `role="status"` / `alertdialog`) — a migration must preserve these roles on the toast root.
- **Errors are sticky by design.** None auto-dismiss today; they clear only when state resolves. This matters for the migration (see §3).

## 2. What react-toast-master gives us (and its constraints)

Verified against `node_modules/react-toast-master@3.0.1` (`index.d.ts`, README):

- `ToastProvider` + one CSS import at root. **Already done in this repo**: `src/main.jsx` wraps `<App />` in `ToastProvider`; the CSS import was added this session:
  ```js
  import { ToastProvider } from "react-toast-master";
  import "react-toast-master/dist/style.css";   // ← added (was missing)
  ```
- `useToast()` returns `{ toastMaster, hideToast }`. **`toastMaster` returns `void`** — the toast id is generated internally and never exposed. Consequence: you can only dismiss via `hideToast()` = *most recent* toast. If two toasts are live simultaneously, targeted dismissal of an older one is impossible from the API. Design around this (one error toast at a time per category).
- **Custom canvas contract** (`type: "custom"` / `"customStay"`): the library renders your node as-is and owns zero pixels of it. Four responsibilities fall on us:
  1. **Background** — add `bg-[var(--bg-secondary)]` (or similar) to our root element, or the toast is transparent over the chat background.
  2. **Close button** — none is injected; ours must call `hideToast()`.
  3. **Positioning context** — root needs `relative` for an absolutely-positioned close button.
  4. **Contrast** — keep text colors in sync with the background we pick (use CSS vars so both themes work).
- **Custom toasts are excluded from hover pause/resume** (only success/error/warning/info/basic families get it), and `timeout: 0` dismisses immediately (real `setTimeout`; there is no "never" value). Indefinite display requires the `*Stay` types, which additionally gain Escape-to-dismiss.
- v3.0.2 scopes all CSS resets under `.outer_container`, so importing the stylesheet won't leak into host-app styling — safe given this app's heavy custom theming (`[data-theme="…"]` in `src/index.css`).

## 3. Migration mapping — which surfaces should become toasts, and how

### Tier A — migrate now (transient, global, non-row-bound)

**A1. History error (#1) → `customStay` toast, top-center.**
The message is session-global ("failed to load/switch/create this chat"), not attached to any row, and it currently pushes transcript layout down as a full-width line. A floating card matches the existing #4/#5 pattern users already have at that position.

```jsx
// In ChatInterface (child of ToastProvider — OK), replace the <p role="alert"> block:
const { toastMaster, hideToast } = useToast();

useEffect(() => {
  if (!historyError) return;
  const t = setTimeout(() =>
    toastMaster({
      type: "customStay",            // no auto-hide: matches today's sticky behavior
      position: "topCenter",         // same slot as ToolLimitToast / paused-loop banner
      transition: "zoom",
      custom: (
        <div className="relative flex max-w-[min(28rem,calc(100vw-2rem))] items-start gap-3 rounded-xl border border-red-400/40 bg-[var(--bg-secondary)] p-4 shadow-lg">
          {/* 1. background via CSS var (theme-safe) */}
          <LuAlertTriangle className="mt-0.5 shrink-0 text-[var(--error)]" />
          <p role="alert" className="min-w-0 flex-1 break-words text-sm text-[var(--text-primary)]">
            {historyError}
          </p>
          {/* 2. our own close button — required for custom toasts */}
          <button type="button" aria-label="Dismiss error" onClick={() => hideToast()}
                  className="shrink-0 rounded-full bg-[var(--input)] p-1 text-[var(--text-primary)]">
            <LuX />
          </button>
        </div>
      ),
    }), 250);                        // defer so the card mounts after state commit
  return () => clearTimeout(t);
}, [historyError, toastMaster]);
```

Notes:
- `customStay` keeps today's semantics exactly (sticky until dismissed) and adds Escape-to-dismiss for free. If we later want auto-hide, switch to `type: "custom"` + `timeout: 8000` — but note custom types don't pause on hover, so the countdown can expire while the user is reading; that's an argument for keeping `customStay`.
- The effect-based trigger means a *change* in `historyError` fires one toast; clearing it (success path) should also call `hideToast()` from those same success handlers to avoid a stale card.
- Because `toastMaster` returns no id, the "clear on resolve" call is best-effort most-recent dismissal — acceptable since we only ever have one history-error toast live at a time.

**A2. Summarize notice (#2) → `custom` (auto-hide), top-center.**
It's informational ("N earlier messages summarized to free memory"), casual-chat-only, and currently sits as an 11px line above the composer where it competes with drag-drop affordances. A short-lived toast is a strict improvement; no sticky semantics needed.

```jsx
toastMaster({
  type: "custom",
  position: "topCenter",
  transition: "zoom",
  timeout: 6000,                    // custom types ignore hover pause — fine for one line
  custom: (
    <div className="relative flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 shadow-lg">
      <IoIosHourglass className="shrink-0 text-[var(--text-muted)]" />
      <p role="status" className="text-xs text-[var(--text-muted)]">{summarizeNotice}</p>
    </div>
  ),
});
```

**A3. Chat export toast (#9, `ChatHistory.jsx`) → drop the hand-rolled timer entirely.**
Replace the local `toast` state + 4500 ms effect with:

```jsx
const { toastMaster } = useToast();
// success:
toastMaster({ type: "success", message: "Chat exported successfully.", position: "topRight" });
// failure — custom, so we keep the raw error text and a close button:
toastMaster({
  type: "custom", position: "topRight", timeout: 6000,
  custom: (/* red-bordered card, same recipe as A1 but compact */),
});
```

This is the lowest-risk change in the whole migration: it deletes ~25 lines of bespoke state/timer code and uses a built-in type for the success path.

### Tier B — migrate with care (interactive / must stay until answered)

**B1. Tool limit (#4) and paused loop (#5).**
These are `alertdialog`s with **action buttons that block agent progress**. They should become custom toasts only if we accept: no hover pause (irrelevant — they're sticky), Escape-to-dismiss via `customStay` (Escape would *dismiss the question without answering* — must be suppressed or handled by routing Escape to "deny"), and stacking order with A1. Recommendation: convert them to `customStay` cards reusing one shared `<ErrorToastCard>` component, keep `role="alertdialog"` + `aria-modal`, and wire Escape through our own keydown handler that calls the deny path instead of letting the library dismiss silently. Do **not** use auto-hiding types here — a budget question that vanishes on its own is worse than one that lingers.

**B2. Tool approval (#6).**
Same reasoning as B1, plus it's queue-based (`toolApprovals[0]` with `key={approvalId}`). react-toast-master has no documented queue API for custom types; keeping the current component (or a shared card) is the rational choice. Migrate only if we also build a small wrapper that re-fires on each new approval id and calls `hideToast()` before showing the next one — feasible, but it's a rewrite with zero user-visible gain over today's behavior.

### Tier C — do NOT migrate (row-bound errors)

**C1. Skill proposal / pending-interaction / step errors (#7)** and **bridge/server errors (#8)**.
These are attached to specific rows, steps, or panels: the error text is only meaningful next to its trigger ("this proposal failed", "this skill import failed"), and `hideToast()`'s most-recent-only semantics break down when several rows fail in one turn. Inline `<p class="project-error">` with `role="alert"` remains correct. The one partial exception: **bridge/server errors (#8)** are global, not row-bound — a future pass could toast them once on transition (App-level effect watching the `serverError` channel) while keeping the TerminalLog banner as the persistent record. That's optional; it duplicates information today.

## 4. Shared implementation notes

1. **One component, many surfaces.** A1/A2/(B if pursued)/(#8 future pass) all want the same card: relative root, theme-var background, icon slot, `break-words` text (raw `error.message` can be long — add `line-clamp-3` + a "show more" toggle if messages exceed ~3 lines), close button calling `hideToast()`. Put it in `src/components/main-app/ErrorToastCard.jsx`; keep the four responsibilities documented on it, since they're easy to regress.
2. **Theme safety.** Use only CSS variables (`--bg-secondary`, `--border`, `--error`, `--text-primary`, `--input`) inside custom nodes — never hard-coded slate colors like the current #4/#5 banners do (they don't follow the 18 custom themes). The library's own stylesheet is scoped under `.outer_container` and won't fight our `[data-theme]` rules.
3. **Z-index.** Current floating cards use `z-50`; verify the toast container sits below modals (`RecoveryHistoryModal`, `SubagentTranscriptModal`) — if not, add a z-index override scoped to `.outer_container`.
4. **StrictMode double-invoke.** The effect in A1 fires twice on mount in dev; guard with a ref keyed on `historyError` value so we don't stack two identical cards (the library has no dedupe API).
5. **Accessibility.** Preserve `role="alert"`/`"status"`/`"alertdialog"` on the inner content node exactly as today — the toast wrapper is presentational, the role must stay where screen readers already find it.

## 5. Suggested order of work

1. A3 (export toast) — pure deletion of bespoke code, zero new surface.
2. A1 (history error) — highest user-visible win; removes transcript layout shift.
3. A2 (summarize notice).
4. B1 only if a shared card exists from step 2 and the Escape routing is handled.
5. C surfaces: leave inline; revisit #8 as an optional App-level toast.

## Evidence index

- `src/components/main-app/ChatInterface.jsx` — lines 257–300 (midRunQuestionsError), 416–588 (historyError set/clear sites), 1338 (summarizeNoticeFor), 1622–1640 (ToolApprovalToast / ToolLimitToast render + `onError={setHistoryError}`), ~1634 (paused-loop banner), 1756–1763 (history error `<p>`), 2097–2100 (summarize notice), 2220 (midRunQuestionsError prop)
- `src/components/main-app/ToolLimitToast.jsx:18–29` — hand-rolled alertdialog styling, Allow/Deny buttons
- `src/components/chat/PendingInteractions.jsx:97,150`, `src/components/ChatMessage.jsx:696–701,774–778` — per-row `project-error` rendering
- `src/projects.css:47` — `.project-error { color: var(--error); font-size: 13px; margin: 12px 0; }`
- `src/App.jsx:159,250,264,272,296` → `TerminalLog.jsx:29`, `ModelSelectorModal.jsx:371` — serverError prop-drilling chain
- `src/components/ChatHistory.jsx:222–334,640–647` — existing hand-rolled export toast with 4500 ms auto-hide
- `node_modules/react-toast-master/index.d.ts:89–90` — `toastMaster → void`, `hideToast(id?)`; README custom-canvas contract and duration table (v3.0.1 installed; CSS import added to `src/main.jsx` this session)

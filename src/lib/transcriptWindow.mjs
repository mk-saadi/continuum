// Progressive transcript rendering (Phase 2).
//
// The canonical conversation is NEVER truncated. `selectTranscriptWindow`
// only *derives* which contiguous tail of the existing message array the
// transcript should mount, leaving the full collection available to
// inference/context construction, persistence, export, search, editing and
// regeneration. It returns the same message objects (a slice of the input
// array) so the rendering window references the canonical records instead of
// creating a second source of truth.

export const INITIAL_VISIBLE_MESSAGES = 15;
export const OLDER_MESSAGES_PAGE_SIZE = 15;
// Context shown on each side of a search-navigation target. Small enough that
// jumping to an old hit never mounts the intervening history.
export const SEARCH_CONTEXT_MESSAGES = 8;

// A pagination unit is one top-level user/assistant conversation message, the
// same entries the transcript renderer turns into rows. Tool calls, tool
// results, attachments and other parts belong to their owning message and are
// never split into separate units. Any other role (for example an internal
// system record) is neither counted nor used to decide whether older messages
// remain: it simply travels with the span it is interleaved in, exactly as it
// did before pagination existed.
export function isConversationMessage(message) {
  return (
    !!message &&
    typeof message === "object" &&
    (message.role === "user" || message.role === "assistant")
  );
}

// Returns { start, messages, hasOlder }:
//   - messages: the contiguous slice of `all` that contains the newest
//     `visibleCount` conversation messages, preserving original order and any
//     non-conversation records interleaved within the span.
//   - start: index in `all` where the window begins (0 when the window covers
//     everything).
//   - hasOlder: whether at least one conversation message exists before the
//     window (i.e. more can be revealed by scrolling up).
// The input array is never mutated.
export function selectTranscriptWindow(all, visibleCount) {
  const list = Array.isArray(all) ? all : [];
  if (list.length === 0) return { start: 0, messages: list, hasOlder: false };
  const requested = Number.isFinite(visibleCount)
    ? Math.max(1, Math.floor(visibleCount))
    : INITIAL_VISIBLE_MESSAGES;

  let remaining = requested;
  let start = 0;
  let found = false;
  for (let index = list.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (!isConversationMessage(list[index])) continue;
    remaining -= 1;
    start = index;
    found = true;
  }
  // No conversation message at all: nothing to paginate.
  if (!found) return { start: 0, messages: list, hasOlder: false };

  let hasOlder = false;
  for (let index = 0; index < start; index += 1) {
    if (isConversationMessage(list[index])) {
      hasOlder = true;
      break;
    }
  }
  return {
    start,
    messages: start === 0 ? list : list.slice(start),
    hasOlder,
  };
}

// The effective window size for the active session. A count recorded while a
// different conversation was open must never leak into the newly selected
// chat, so a session mismatch falls back to the initial window synchronously
// (no render ever mounts the previous conversation's expanded window).
export function effectiveVisibleCount(state, sessionId) {
  if (
    state &&
    state.sessionId === sessionId &&
    Number.isFinite(state.count) &&
    state.count > 0
  ) {
    return Math.floor(state.count);
  }
  return INITIAL_VISIBLE_MESSAGES;
}

// True when at least one top-level conversation message exists in [from, to).
export function hasConversationInRange(all, from, to) {
  if (!Array.isArray(all)) return false;
  const start = Math.max(0, from);
  const end = Math.min(all.length, to);
  for (let index = start; index < end; index += 1) {
    if (isConversationMessage(all[index])) return true;
  }
  return false;
}

export function countConversationMessages(all, from = 0, to = Infinity) {
  if (!Array.isArray(all)) return 0;
  const start = Math.max(0, from);
  const end = Math.min(all.length, to);
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (isConversationMessage(all[index])) count += 1;
  }
  return count;
}

// Index of a message by its stable id, or -1. Search navigation locates a
// target by identity rather than by its position in a rendered slice.
export function indexOfMessage(all, messageId) {
  if (!Array.isArray(all) || messageId == null) return -1;
  for (let index = 0; index < all.length; index += 1) {
    if (all[index] && all[index].id === messageId) return index;
  }
  return -1;
}

// A bounded window around a single target message, with `radius` context
// messages on each side. Mirrors selectTranscriptWindow and additionally
// reports whether newer conversation messages remain below the window so the
// caller can offer a way back to the latest messages.
export function selectTranscriptWindowAround(all, messageId, radius = SEARCH_CONTEXT_MESSAGES) {
  const list = Array.isArray(all) ? all : [];
  const targetIndex = indexOfMessage(list, messageId);
  if (targetIndex === -1) {
    return {
      start: 0,
      messages: list,
      hasOlder: false,
      hasNewer: false,
      targetIndex: -1,
      found: false,
    };
  }
  const span = Math.max(0, Math.floor(radius));
  const start = Math.max(0, targetIndex - span);
  const end = Math.min(list.length, targetIndex + span + 1);
  return {
    start,
    messages: list.slice(start, end),
    hasOlder: hasConversationInRange(list, 0, start),
    hasNewer: hasConversationInRange(list, end, list.length),
    targetIndex,
    found: true,
  };
}

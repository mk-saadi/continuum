// Shared in-flight session-listing requests across mounted panes.
//
// Every mounted ChatInterface (plus tab hydration) requests the identical
// global listing on mount, so startup fires N duplicate session:get-all IPCs
// for N tabs. This module shares only the in-flight promise: concurrent
// callers await one request, and the slot clears on settle (success or
// failure) so later calls always fetch fresh data. Resolved results are never
// served from here — sequential refreshes after mutations each hit the
// database, so no invalidation protocol (and no staleness) is needed. A
// rejected share rejects every waiter and still clears the slot, so the next
// caller retries instead of inheriting a failure.
let inflight = null;

export function fetchSessionGroups(api) {
  if (!api || typeof api.getAllSessions !== 'function') {
    return Promise.reject(new Error('Session history is unavailable.'));
  }
  if (!inflight) {
    inflight = api.getAllSessions().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// Test-only counting wrapper around `pendingSkillProposals`.
//
// The Phase 5 UI suite redirects ChatInterface's `executionEvents.mjs` import
// to this module so the number of `pendingSkillProposals(messages, …)` calls can
// be observed. Every other export is re-exported unchanged, so the bundle under
// test behaves exactly like production apart from the counter.
import { pendingSkillProposals as realPendingSkillProposals } from '../../src/lib/executionEvents.mjs';

window.__skillCalls = 0;

export * from '../../src/lib/executionEvents.mjs';

export function pendingSkillProposals(messages, isResolved) {
  window.__skillCalls += 1;
  return realPendingSkillProposals(messages, isResolved);
}

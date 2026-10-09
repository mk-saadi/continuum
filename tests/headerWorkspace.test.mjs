import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHeaderFor } from '../src/lib/headerWorkspace.mjs';
import { parseTabState } from '../src/lib/tabState.mjs';

const projects = [{ id: 'p_llm', name: 'llm-electron' }];
const track = () => {
  const calls = [];
  return [calls, patch => calls.push(patch)];
};

test('a casual tab has no workspace header block', () => {
  assert.equal(workspaceHeaderFor({ id: 'a', projectId: null }, projects, () => {}), null);
});

test('a workspace tab reports its project name from the projects list', () => {
  const header = workspaceHeaderFor({ id: 'a', projectId: 'p_llm' }, projects, () => {});
  assert.equal(header.name, 'llm-electron');
});

test('home navigates to the all-workspaces view without touching the project id', () => {
  const [calls, update] = track();
  workspaceHeaderFor({ id: 'a', projectId: 'p_llm' }, projects, update).onOpenHome();
  assert.deepEqual(calls, [{ view: 'projects' }]);
});

test('workspace name navigates to the workspace overview and keeps its project id', () => {
  const [calls, update] = track();
  workspaceHeaderFor({ id: 'a', projectId: 'p_llm' }, projects, update).onOpenWorkspace();
  assert.deepEqual(calls, [{ projectId: 'p_llm', view: 'project' }]);
});

test('a workspace tab whose project is not loaded yet falls back to a generic name', () => {
  const header = workspaceHeaderFor({ id: 'a', projectId: 'missing' }, projects, () => {});
  assert.equal(header.name, 'Workspace');
});

test('on the workspace home page only Home shows — no single-workspace name', () => {
  const header = workspaceHeaderFor({ id: 'a', projectId: 'p_llm', view: 'projects' }, projects, () => {});
  assert.equal(header.name, null);
  assert.equal(typeof header.onOpenHome, 'function');
});

test('restored tabs keep their header context through a persistence round trip', () => {
  const restored = parseTabState(JSON.stringify({
    tabs: [
      { id: 'casual', sessionId: 's1', title: 'Chat', projectId: null },
      { id: 'ws', sessionId: 's2', title: 'llm chat', projectId: 'p_llm' },
      { id: 'home', sessionId: 's3', title: 'llm chat', projectId: 'p_llm', view: 'projects' },
    ],
    activeTabId: 'ws',
  }));
  assert.equal(workspaceHeaderFor(restored.tabs[0], projects, () => {}), null);
  assert.equal(workspaceHeaderFor(restored.tabs[1], projects, () => {}).name, 'llm-electron');
  assert.equal(workspaceHeaderFor(restored.tabs[2], projects, () => {}).name, null);
});

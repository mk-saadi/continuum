import test from 'node:test';
import assert from 'node:assert/strict';
import { getTabTitle } from '../src/lib/tabTitle.mjs';

test('navigation displays page titles and preserves the chat title on return', () => {
  const tab = { title: 'Previous conversation', projectId: 'p1', view: 'chat' };
  const projects = [{ id: 'p1', name: 'Desktop assistant' }];
  assert.equal(getTabTitle(tab, projects), 'Previous conversation');
  assert.equal(getTabTitle({ ...tab, view: 'tasks' }, projects), 'Tasks');
  assert.equal(getTabTitle({ ...tab, view: 'projects' }, projects), 'All Projects');
  assert.equal(getTabTitle({ ...tab, view: 'project' }, projects), 'Desktop assistant');
  assert.equal(getTabTitle(tab, projects), 'Previous conversation');
});

test('page titles handle loading, renamed projects, and background chat updates', () => {
  const tab = { view: 'project', projectId: 'p1', title: 'Old chat' };
  assert.equal(getTabTitle(tab), 'Project');
  assert.equal(getTabTitle(tab, [{ id: 'p1', name: 'Renamed project' }]), 'Renamed project');
  assert.equal(getTabTitle({ ...tab, view: 'tasks', title: 'Updated chat' }), 'Tasks');
  assert.equal(getTabTitle({ ...tab, view: 'chat', title: 'Updated chat' }), 'Updated chat');
  assert.equal(getTabTitle({}), 'New chat');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { getTabTypeIcon } from '../src/lib/tabIcons.mjs';
import { LuMessageCircle, LuFolder, LuCalendar } from 'react-icons/lu';

test('page icons follow navigation regardless of the previous chat project', () => {
  assert.equal(getTabTypeIcon({ view: 'tasks', projectId: 'p1' }).Icon, LuCalendar);
  assert.equal(getTabTypeIcon({ view: 'projects' }).Icon, LuFolder);
  assert.equal(getTabTypeIcon({ view: 'project' }).Icon, LuFolder);
});

test('casual tab (projectId: null) returns the casual chat icon', () => {
  const { Icon, label } = getTabTypeIcon({ projectId: null });
  assert.equal(Icon, LuMessageCircle);
  assert.equal(label, 'Casual chat');
});

test('project tab (projectId set) returns the project icon', () => {
  const { Icon, label } = getTabTypeIcon({ projectId: 'p1' });
  assert.equal(Icon, LuFolder);
  assert.equal(label, 'Project');
});

test('casual tab with undefined projectId returns the casual chat icon', () => {
  const { Icon, label } = getTabTypeIcon({});
  assert.equal(Icon, LuMessageCircle);
  assert.equal(label, 'Casual chat');
});

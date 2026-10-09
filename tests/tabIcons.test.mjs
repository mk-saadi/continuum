import test from 'node:test';
import assert from 'node:assert/strict';
import { getTabTypeIcon } from '../src/lib/tabIcons.mjs';
import { LuMessageCircle, LuFolder } from 'react-icons/lu';

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

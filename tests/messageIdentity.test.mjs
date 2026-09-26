import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantLabel, formatModelName } from '../src/lib/messageIdentity.mjs';

test('formats model paths without changing model spelling', () => {
  assert.equal(formatModelName('/models/Gemma4-26B-A4B-Uncensored.gguf'), 'Gemma4-26B-A4B-Uncensored');
  assert.equal(formatModelName('C:\\models\\Huihui-gemma-4-12B.GGUF'), 'Huihui-gemma-4-12B');
});

test('prioritizes turn identity and preserves it when models or personas change', () => {
  const agent = { name: 'New Persona' };
  assert.equal(assistantLabel({ modelName: 'Original', agentName: 'Senior Code Reviewer' }, 'New', agent), 'Senior Code Reviewer');
  assert.equal(assistantLabel({ modelName: 'Original', agentName: null }, 'New', agent), 'Original');
  assert.equal(assistantLabel({ modelId: '/models/Original.gguf' }, 'New'), 'Original');
  assert.equal(assistantLabel({ model_name: 'Stored' }, 'New'), 'Stored');
  assert.equal(assistantLabel({}, 'Active', agent), 'Active');
  assert.equal(assistantLabel({}, 'Active'), 'Active');
  assert.equal(assistantLabel({}), 'Assistant');
});

test('persisted SQLite fields override stale aliases and current selections', () => {
  assert.equal(assistantLabel({ model_name: 'Original', modelName: 'New' }, 'Current'), 'Original');
  assert.equal(assistantLabel({ model_name: 'Original', agent_name: 'Original Agent', agentName: 'New Agent' }, 'Current'), 'Original Agent');
  assert.equal(assistantLabel({ model_name: 'Original', agent_name: null, agentName: 'New Agent' }, 'Current'), 'Original');
  assert.equal(assistantLabel({ model_name: null, agent_name: null, modelName: 'Stale', agentName: 'Stale' }, 'Current'), 'Current');
});

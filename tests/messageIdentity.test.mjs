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
  assert.equal(assistantLabel({}, 'Active', agent), 'New Persona');
  assert.equal(assistantLabel({}, 'Active'), 'Active');
  assert.equal(assistantLabel({}), 'Assistant');
});

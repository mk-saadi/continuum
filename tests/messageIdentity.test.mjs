import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantLabel, formatModelName, resolveDisplayName } from '../src/lib/messageIdentity.mjs';

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


test('display names resolve per path, then global, then filename and stay literal', () => {
  const settings = { globalModelName: 'Global Assistant', perModelNames: { '/models/a.gguf': 'Custom / Name.gguf' } };
  assert.equal(resolveDisplayName(settings, '/models/a.gguf', 'Raw'), 'Custom / Name.gguf');
  assert.equal(resolveDisplayName(settings, '/models/b.gguf', 'Raw'), 'Global Assistant');
  assert.equal(resolveDisplayName({ globalModelName: '  ', perModelNames: { a: '  ' } }, 'a', 'Raw'), 'Raw');
  const message = { displayName: resolveDisplayName(settings, '/models/a.gguf', 'Raw'), modelName: 'Raw' };
  settings.perModelNames['/models/a.gguf'] = 'Changed';
  assert.equal(assistantLabel(message), 'Custom / Name.gguf');
  assert.equal(assistantLabel({ ...message, variants: [{ content: 'First', displayName: 'First name' }, { content: 'Second', displayName: 'Second name' }], active_variant_index: 1 }), 'Second name');
  assert.equal(assistantLabel({ display_name: 'Saved', displayName: 'Stale' }), 'Saved');
});


test('streaming and finalized legacy variants keep the captured message name', () => {
  const streaming = { content: '', displayName: 'qwey', model: 'raw-model.gguf' };
  assert.equal(assistantLabel(streaming), 'qwey');
  assert.equal(assistantLabel({ ...streaming, display_name: null, content: 'Done' }), 'qwey');
  assert.equal(assistantLabel({ ...streaming, variants: [{ content: 'Done', model_name: 'raw-model.gguf' }] }), 'qwey');
  assert.equal(assistantLabel({ model: 'raw-model.gguf' }), 'raw-model');
  assert.equal(assistantLabel({ ...streaming, variants: [{ content: 'Old reply', model_name: 'Older', displayName: null }] }), 'Older');
});

'use strict';

// Step 7: connect the subagent runtime to the application's existing model
// selection system, so the main agent and its children can be configured with
// different models — without introducing a second routing system.
//
// One app setting decides what a child runs on:
//
//   null                        follow the parent chat's own selection (default)
//   { type: 'local' }           the local model server (the model it has loaded)
//   { type: 'cloud', provider, model }
//                               a saved cloud provider + model — exactly the
//                               { type, provider, model } shape the chat
//                               already validates through validateChatProvider()
//
// The selection is read once per spawn and resolved into the same engine
// descriptor every execution already carries ({ provider, port, modelId,
// contextLength } for local, { provider, modelId, chatTarget } for cloud). That
// descriptor flows through ./index.js into the Step 3 inference scheduler,
// which stays the only authority on when a generation may run: lanes are still
// just provider + model, with capacity declared by the provider.
//
// Resolution happens exactly once per child, at the runtime boundary
// (./index.js run*/start*), and the resolved descriptor is what continuation
// stores (./continuationManager.js). Foreground, background, sendMessage,
// interrupt and resume therefore all keep the model the child started with:
// changing the setting affects the next spawn, never a live child.
//
// Model choice never touches permissions. Whatever engine resolves here, the
// child still runs ./agentLoop.js's read-only allowlist under permissionMode
// 'read_only' — a cloud model buys no extra capability.

const SELECTION_KEY = 'subagentModel';

// The local selection needs the running engine (its port and loaded model).
// The application wires its accessor in from the IPC composition root
// (../ipcHandlers.js registerIpcHandlers); without one (tests, headless use)
// a local selection simply reports that the local model server is not running.
let engineConfigProvider = () => null;

function setEngineConfigProvider(provider) {
  engineConfigProvider = typeof provider === 'function' ? provider : () => null;
}

function providerIdOf(engine) {
  if (typeof engine?.provider === 'string' && engine.provider.trim()) return engine.provider.trim();
  return engine?.chatTarget ? 'cloud' : 'local';
}

/**
 * The engine descriptor a chat hands to its tools — what a delegated child
 * inherits when no sub-agent model is configured. A local chat carries its
 * loaded-model config; a cloud chat carries its validated provider target, so
 * spawn_sub_agent stays usable there too.
 *
 * @param {{cloud?: boolean, target?: object|null, config?: object|null, modelId?: string}} chat
 * @returns {object|null}
 */
function buildChatEngine({ cloud, target, config, modelId }) {
  if (cloud) return { provider: 'cloud', modelId: target?.model ?? null, chatTarget: target ?? null };
  if (!config) return null;
  return { provider: 'local', port: config.port, modelId, contextLength: config.activeModelConfig?.contextLength };
}

/**
 * Validate a stored/offered selection. Reuses the chat's own cloud validation:
 * the provider must be a saved text provider and the model must be the one
 * stored on it — no provider or model name is ever hard-coded here.
 */
function normalizeSubagentModel(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sub-agent model must be null (follow the chat model), { type: "local" }, or '
      + '{ type: "cloud", provider, model }.');
  }
  if (value.type === 'local') return { type: 'local' };
  if (value.type === 'cloud') {
    return require('../cloudProviders').validateChatProvider(value);
  }
  throw new Error('Invalid sub-agent model selection. Choose the local model server or a saved cloud provider.');
}

/**
 * The configured selection, or null when children should follow the parent
 * chat's model. The read is deliberately defensive about the settings store:
 * no database (headless/tests) simply means "no selection", which is the
 * pre-Step-7 behavior. A stored-but-invalid value, by contrast, fails loudly
 * at spawn instead of silently routing a child to the wrong model.
 */
function getSubagentModel() {
  let raw;
  try {
    const row = require('../db').db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SELECTION_KEY);
    raw = row?.value_json ?? null;
  } catch {
    return null; // settings store unavailable: no selection, child follows the parent's model
  }
  if (raw == null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The saved sub-agent model selection is not readable. Choose the model again in Settings.');
  }
  return normalizeSubagentModel(parsed);
}

/** Persist the selection (null clears it back to "follow the chat model"). */
function saveSubagentModel(value) {
  const selection = normalizeSubagentModel(value);
  require('../db').db.prepare(
    'INSERT INTO app_settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(SELECTION_KEY, JSON.stringify(selection));
  return selection;
}

/**
 * Turn "this chat's engine + the sub-agent model setting" into the engine
 * descriptor the child executes with. Pure routing decision, no transport:
 *
 *   inherit      -> the parent descriptor, unchanged (local+local and
 *                   cloud+cloud "same model" need no extra machinery)
 *   local        -> the parent descriptor when it already is the local server,
 *                   otherwise the running engine's own port/loaded model
 *   cloud        -> a cloud descriptor validated against the saved providers
 *
 * Returns null/undefined untouched when there is nothing to inherit, so the
 * executions keep raising their own "start the local model server" error.
 */
function resolveChildEngine(parentEngine = null) {
  const selection = getSubagentModel();
  if (!selection) return parentEngine ?? null;
  if (selection.type === 'local') {
    if (parentEngine && providerIdOf(parentEngine) === 'local') return parentEngine;
    const config = engineConfigProvider();
    if (!config || !Number.isInteger(config.port) || !config.modelPath) {
      throw new Error('Start the local model server before delegating a task.');
    }
    return {
      provider: 'local',
      port: config.port,
      modelId: config.modelPath,
      contextLength: config.activeModelConfig?.contextLength,
    };
  }
  const target = require('../cloudProviders').validateChatProvider(selection);
  return { provider: 'cloud', modelId: target.model, chatTarget: target };
}

module.exports = { getSubagentModel, saveSubagentModel, normalizeSubagentModel,
  resolveChildEngine, setEngineConfigProvider, providerIdOf, buildChatEngine };

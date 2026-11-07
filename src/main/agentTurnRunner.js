'use strict';

// Renderer-agnostic entry point for a full agent turn.
//
// It deliberately reuses the existing `engine:chat` implementation instead of
// duplicating or rewriting the agent runtime: streaming, tool approvals,
// steering, persistence, compaction, cancellation and error handling all stay
// in one place. The only renderer-shaped pieces (`notify`, `sender`, activity)
// are supplied by a headless adapter, so scheduled tasks can drive the exact
// same pipeline.

const { EventEmitter } = require('node:events');

let registeredChatHandler = null;

/**
 * Register the chat handler built by registerIpcHandlers.
 * Returns an unregister function that only clears the handler it installed.
 */
function registerChatTurnHandler(handler) {
  if (typeof handler !== 'function') throw new TypeError('A chat turn handler is required.');
  registeredChatHandler = handler;
  return () => {
    if (registeredChatHandler === handler) registeredChatHandler = null;
  };
}

/**
 * The adapter the runner hands to the chat handler. A scheduled turn has no
 * renderer, so outbound UI events are forwarded to `onEvent` and nothing waits
 * for a browser response. Approval/question/pause flows keep their existing
 * abort and timeout behaviour (a scheduled task defaults to Read Only).
 */
function createHeadlessAdapter({ onEvent = () => {} } = {}) {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => onEvent({ channel, payload });
  const notify = event => onEvent({ channel: 'notify', payload: event });
  const emitActivity = payload => onEvent({ channel: 'activity', payload });
  return { sender, notify, emitActivity };
}

/**
 * Run one full agent turn through the registered chat handler.
 *
 * @param {Object} request - the same payload `engine:chat` accepts
 * @param {Object} [options]
 * @param {Function} [options.onEvent] - receives every outbound event
 * @param {AbortSignal} [options.signal] - cancels the turn
 * @returns {Promise<Object>} the handler result ({ text, stats, executionSteps, ... })
 */
async function runAgentTurn(request, { onEvent = () => {}, signal = null } = {}) {
  const handler = registeredChatHandler;
  if (typeof handler !== 'function')
    throw Object.assign(new Error('Agent turn runner is not registered.'), { code: 'AGENT_RUNNER_UNAVAILABLE' });
  if (!request || typeof request !== 'object')
    throw new TypeError('An agent turn request is required.');
  if (signal?.aborted)
    throw Object.assign(new Error('Agent turn cancelled before it started.'), { name: 'AbortError', code: 'ABORT_ERR' });

  const { sender, notify, emitActivity } = createHeadlessAdapter({ onEvent });
  const abort = () => sender.emit('destroyed');
  if (signal) signal.addEventListener('abort', abort, { once: true });

  try {
    // Match the IPC path so a migration cannot close SQLite mid-turn.
    return await require('./dataAccess').withDataAccess(() => handler(request, notify, sender, emitActivity));
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
    sender.removeAllListeners();
  }
}

module.exports = { registerChatTurnHandler, runAgentTurn, createHeadlessAdapter };

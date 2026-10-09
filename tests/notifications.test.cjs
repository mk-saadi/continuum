const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const originalLoad = Module._load;
const shown = [];
let focused = false;
let prefs = { notificationsEnabled: true, notifyOnlyWhenBackgrounded: true,
  notificationEvents: { completion: true, error: true, contextOverflow: true } };
class FakeNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; }
  show() { shown.push(this); }
}
Module._load = function(name, ...args) {
  if (name === 'electron') return { Notification: FakeNotification };
  if (name === '../configManager') return { getAppSettings: () => prefs };
  return originalLoad.call(this, name, ...args);
};

try {
  const { configureNotificationService, sendDesktopNotification } = require('../src/main/services/notificationService');
  const window = { isFocused: () => focused, isDestroyed: () => false, show() { this.shown = true; }, focus() { this.focused = true; } };
  configureNotificationService(() => window);
  focused = true;
  assert.equal(sendDesktopNotification({ type: 'completion' }), false);
  focused = false;
  assert.equal(sendDesktopNotification({ type: 'completion' }), true);
  assert.equal(shown[0].options.title, 'Task Completed');
  assert.equal(shown[0].options.body, 'AI agent finished task successfully.');
  assert.ok(fs.existsSync(shown[0].options.icon));
  shown[0].emit('click');
  assert.equal(window.shown, true);
  assert.equal(window.focused, true);

  const { notifyChatOutcome, isContextLimitError } = require('../src/main/engineManager');
  assert.equal(notifyChatOutcome({ text: 'Done. [TASK COMPLETE]', executionSteps: [{ type: 'tool_call', status: 'error' }] }), 'completion');
  assert.equal(shown.at(-1).options.title, 'Task Completed');
  assert.equal(notifyChatOutcome({ text: 'Here is my answer.', executionSteps: [{ type: 'tool_call', status: 'error' }] }), 'completion');
  assert.equal(shown.at(-1).options.title, 'Response Finished');
  assert.equal(shown.at(-1).options.body, 'AI agent finished responding.');
  assert.equal(notifyChatOutcome({ text: 'Done. [TASK COMPLETE]', interrupted: true }), 'error');
  assert.equal(shown.at(-1).options.title, 'Execution Interrupted');
  assert.equal(notifyChatOutcome({ error: new Error('Network disconnected') }), 'error');
  assert.equal(shown.at(-1).options.title, 'Execution Interrupted');
  assert.equal(notifyChatOutcome({ text: '   ' }), 'error');
  assert.equal(isContextLimitError({ status: 400, message: 'Invalid sampling parameter' }), false);
  assert.equal(notifyChatOutcome({ error: { status: 400, message: 'Invalid sampling parameter' } }), 'error');
  const overflow = { status: 400, responseBody: JSON.stringify({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 8619, n_ctx: 8192 } }) };
  assert.equal(isContextLimitError(overflow), true);
  assert.equal(notifyChatOutcome({ error: overflow }), 'contextOverflow');
  assert.equal(shown.at(-1).options.title, 'Context Limit Reached');
  assert.equal(notifyChatOutcome({ aborted: true, error: new Error('Cancelled') }), null);
  prefs = { ...prefs, notificationEvents: { ...prefs.notificationEvents, error: false } };
  assert.equal(sendDesktopNotification({ type: 'error' }), false);
  prefs = { ...prefs, notificationsEnabled: false };
  assert.equal(sendDesktopNotification({ type: 'completion' }), false);
  console.log('Native notification preferences, focus behavior, click action, and outcome classification passed.');
} finally {
  Module._load = originalLoad;
}

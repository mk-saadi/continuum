'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

test('mid-run preference defaults off and changes the system prompt', () => {
  const { getEffectiveSettings } = require('../src/main/settingsResolver');
  assert.equal(getEffectiveSettings({ overrides: {} }, 'model', { perModelConfigs: {} }).allowMidRunQuestions, false);
  assert.equal(getEffectiveSettings({ overrides: { allowMidRunQuestions: true } }, 'model', { perModelConfigs: {} }).allowMidRunQuestions, true);
  const { buildSystemPrompt } = require('../src/main/promptBuilder');
  const enabled = buildSystemPrompt({ modelId: 'model', memoryEnabled: false, allowMidRunQuestions: true }).content;
  const disabled = buildSystemPrompt({ modelId: 'model', memoryEnabled: false, allowMidRunQuestions: false }).content;
  assert.match(enabled, /MID-RUN CLARIFICATIONS \(ENABLED\)/);
  assert.match(enabled, /ask_user/);
  assert.match(disabled, /DISABLED - AUTONOMOUS EXECUTION/);
  assert.doesNotMatch(disabled, /MAY pause execution/);
});

test('ask_user pauses for an answer, alerts in background, and respects the toggle', async () => {
  const originalLoad = Module._load;
  const notifications = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { notifications.push(this); }
  }
  Module._load = function(name, ...args) {
    if (name === 'electron') return { Notification: FakeNotification };
    if (name === '../configManager') return { getAppSettings: () => ({ notificationsEnabled: true,
      notificationEvents: { action_required: true }, notifyOnlyWhenBackgrounded: true }) };
    return originalLoad.call(this, name, ...args);
  };
  try {
    const service = require('../src/main/services/notificationService');
    const window = { minimized: true, focused: false, isDestroyed: () => false,
      isMinimized() { return this.minimized; }, isFocused() { return this.focused; },
      restore() { this.minimized = false; }, show() { this.shown = true; }, focus() { this.focused = true; } };
    service.configureNotificationService(() => window);
    const { askUserDuringRun, askUserTool } = require('../src/main/engineManager');
    assert.equal(askUserTool.function.name, 'ask_user');
    const controller = new AbortController();
    const sent = [];
    const sender = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
    const waiting = askUserDuringRun({ controller, sender, requestId: 'run', sessionId: 'chat', stepId: 'step',
      question: 'Which environment?', options: ['Staging', 'Production'], enabled: true });
    assert.equal(sent[0].channel, 'engine:ask-user');
    assert.equal(sent[0].payload.stepId, 'step');
    assert.equal(notifications[0].options.title, 'Agent Needs Input');
    assert.equal(notifications[0].options.body, 'Which environment?');
    notifications[0].emit('click');
    assert.equal(window.shown, true);
    assert.equal(window.focused, true);
    assert.equal(window.minimized, false);
    controller.pendingQuestions.get(sent[0].payload.questionId)('Staging');
    assert.equal(await waiting, 'Staging');
    assert.equal(sent[1].payload.resolved, true);
    assert.equal(await askUserDuringRun({ controller, sender, question: 'Ignored?', enabled: false }),
      'Mid-run questions are currently disabled by user preference. Proceed with the task using your best judgment.');
    assert.equal(notifications.length, 1);
    const cancelled = new AbortController();
    const pending = askUserDuringRun({ controller: cancelled, sender, requestId: 'second', sessionId: 'chat', stepId: 'step2',
      question: 'Continue?', enabled: true });
    assert.equal(notifications.length, 1);
    cancelled.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/main/services/notificationService')];
  }
});

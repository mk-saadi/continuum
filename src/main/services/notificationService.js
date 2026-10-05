'use strict';

const { Notification } = require('electron');
const path = require('node:path');
const { getAppSettings } = require('../configManager');

const ICON = path.join(__dirname, '../../../assets/continuum-notification.png');
const CONTENT = Object.freeze({
  completion: { title: 'Task Completed', body: 'AI agent finished task successfully.' },
  error: { title: 'Execution Interrupted', body: 'AI agent execution stopped before finishing.' },
  contextOverflow: { title: 'Context Limit Reached', body: 'Request exceeded model context window limit.' },
  action_required: { title: 'Agent Needs Input', body: 'The agent is waiting for your response.' },
});

let getMainWindow = () => null;
const activeNotifications = new Set();

function configureNotificationService(windowGetter) {
  if (typeof windowGetter !== 'function') throw new TypeError('A main window getter is required.');
  getMainWindow = windowGetter;
}

function isMainWindowBackgrounded() {
  const window = getMainWindow();
  return !!window && !window.isDestroyed?.() && (window.isMinimized?.() || !window.isFocused?.());
}

function sendDesktopNotification({ title, body, type }) {
  if (!Object.hasOwn(CONTENT, type)) throw new TypeError('Invalid notification type.');
  try {
    const settings = getAppSettings();
    if (!settings.notificationsEnabled || !settings.notificationEvents[type] ||
        Notification.isSupported?.() === false) return false;
    const mainWindow = getMainWindow();
    if (settings.notifyOnlyWhenBackgrounded && mainWindow?.isFocused?.()) return false;
    const message = CONTENT[type];
    const notification = new Notification({
      title: title || message.title,
      body: body || message.body,
      icon: ICON,
    });
    activeNotifications.add(notification);
    notification.on('click', () => {
      const window = getMainWindow();
      if (!window || window.isDestroyed?.()) return;
      if (window.isMinimized?.()) window.restore();
      window.show();
      window.focus();
    });
    notification.on('close', () => activeNotifications.delete(notification));
    notification.show();
    return true;
  } catch (error) {
    console.warn('Desktop notification failed:', error);
    return false;
  }
}

module.exports = { sendDesktopNotification, configureNotificationService, isMainWindowBackgrounded };

'use strict';

// Installation/publication review remains independent of shell syntax.
function isPackageOperation(command) {
  const text = String(command).replace(/["']/g, '').toLowerCase();
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:[^;&|]*?\s)?(?:install|add|i|ci|publish|unpublish|deprecate)\b/.test(text)
    || /\b(?:apt(?:-get)?|dnf|yum|brew|apk|zypper)\s+(?:[^;&|]*?\s)?(?:install|add|upgrade)\b/.test(text)
    || /\b(?:pip\d*|pipx|uv|poetry|cargo|gem|bundle|composer|go)\s+(?:[^;&|]*?\s)?(?:install|add|sync|publish|push|get|require)\b/.test(text);
}
module.exports = { isPackageOperation };

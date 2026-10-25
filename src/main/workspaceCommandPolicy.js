'use strict';

const path = require('node:path');

// This is only a conservative literal-path review. bwrap, not shell parsing,
// contains execution. Expansion and embedded programs require explicit review.
async function inspectWorkspaceCommand(root, cwd, command, workspacePath) {
  const resolvedPaths = [cwd];
  if (/[$`\\*?\[\]{}()]|<<|\b(?:cd|pushd|popd|alias|unalias)\b/.test(command) || /\b(?:eval|exec|source)\b|\b(?:python\d*|node|ruby|perl|sh|bash|zsh)\s+(?:-[^\s]+\s+)*-(?:c|e)\b/.test(command.replace(/["']/g, ''))) return { reviewRequired: true, resolvedPaths };
  const tokens = [];
  let token = '', quote = null;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/[\s;&|<>]/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else token += character;
  }
  if (quote) return { reviewRequired: true, resolvedPaths };
  if (token) tokens.push(token);
  for (const token of tokens) {
    if (/^~|^[A-Za-z]:[\\/]/.test(token)) return { reviewRequired: true, resolvedPaths };
    // Options/env assignments can carry paths after '='. URLs are external
    // references and require review even though the workspace network is off.
    const candidate = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return { reviewRequired: true, resolvedPaths };
    if (!candidate) continue;
    if (candidate.startsWith('-')) {
      if (/[/.]/.test(candidate)) return { reviewRequired: true, resolvedPaths };
      continue;
    }
    const absolute = path.resolve(cwd, candidate);
    resolvedPaths.push(await workspacePath(root, absolute));
  }
  return { reviewRequired: /(?:^|[;&|]\s*)\.\s/.test(command), resolvedPaths };
}

function isPackageOperation(command) {
  const text = String(command).replace(/["']/g, '').toLowerCase();
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:[^;&|]*?\s)?(?:install|add|i|ci|publish|unpublish|deprecate)\b/.test(text)
    || /\b(?:pip\d*|pipx|uv|poetry|cargo|gem|bundle|composer|go)\s+(?:[^;&|]*?\s)?(?:install|add|sync|publish|push|get|require)\b/.test(text);
}
module.exports = { inspectWorkspaceCommand, isPackageOperation };

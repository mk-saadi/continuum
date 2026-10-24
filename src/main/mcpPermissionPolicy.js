'use strict';

// MCP discovery/activation is already constrained by the configured registry.
// Workspace Write authorizes its use; publishing Git history still asks.
function requiresGitApproval(name, args = {}, serverName = '') {
  const operation = String(name).toLowerCase().replace(/-/g, '_');
  if (/^(?:(?:github|git)_)?(?:commit|push)$|^(?:github_)?(?:create_commit|push_files|create_or_update_file)$/.test(operation)) return true;
  if (/^(?:git|git_sync|github)$/.test(operation) && /^(?:commit|push|create_commit|push_files|create_or_update_file)$/.test(args.action || args.operation || '')) return true;
  const github = /github/i.test(serverName);
  if (github && /^(?:delete_file|update_file|create_file)$/.test(operation)) return true;
  // Generic command tools can also publish history. Do not inspect arbitrary
  // file contents: only fields used to carry a command or API endpoint.
  const command = args.command ?? args.cmd ?? '';
  if (typeof command === 'string' && /\bgit\s+(?:-[^\s]+\s+)*(?:commit|push)\b/i.test(command)) return true;
  const endpoint = args.url ?? args.endpoint ?? args.path;
  return typeof endpoint === 'string' && /(?:api\.github\.com\/repos\/|^\/repos\/).*\/(?:contents|git\/(?:commits|refs))(?:\/|$)/i.test(endpoint) &&
    /^(?:POST|PUT|PATCH|DELETE)$/i.test(args.method || '');
}

// This is a conservative capability boundary, not side-effect inference.
// A read-looking wrapper with program/API arguments is still opaque. Unknown
// capabilities require the existing trusted approval channel in writable modes.
function classifyEffect(name, args = {}) {
  const words = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[-_.]/g, ' ');
  const operation = words(name);
  const action = words(args.action || args.operation || '');
  if (/\b(send|publish|post|transfer|purchase|pay|payment|trade)\b/.test(operation + ' ' + action)) return 'outbound';
  if (/\b(delete|remove|drop|truncate)\b/.test(operation + ' ' + action)) return 'destructive';
  if (/^(POST|PUT|PATCH|DELETE)$/i.test(args.method || '') || /^\s*(DELETE|DROP|TRUNCATE|UPDATE|INSERT|ALTER|CREATE)\b/i.test(args.query || args.sql || '')) return 'external-mutation';
  if (Object.keys(args).some(key => /^(?:code|script|program|command|cmd|expression|javascript|python|payload|body|request|requests|steps|actions)$/i.test(key)) ||
      /\b(execute|eval|evaluate|exec|run|request|invoke|dispatch)\b/.test(operation)) return 'opaque';
  if (action && !/^(?:get|read|fetch|list|search|inspect|describe|status|snapshot)(?: |$)/.test(action)) return 'unknown';
  // Preserve existing explicit file/browser capabilities. These are classified
  // operations, not a guarantee about a third-party executable's honesty.
  if (/(?:^| )(?:get|read|fetch|list|search|inspect|describe)(?: |$)/.test(operation) ||
      /^(?:browser (?:navigate|snapshot)|git (?:status|diff|log|show|branch|blame))$/.test(operation)) return 'read';
  if (operation === 'query' && /^\s*SELECT\b/i.test(args.query || args.sql || '') &&
      !/;\s*\S|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|CALL|EXEC|COPY|INTO|LOAD_EXTENSION)\b/i.test(args.query || args.sql || '')) return 'read';
  if (/^(?:write file|push files|git commit|git push|create or update file)$/.test(operation)) return 'known-mutation';
  return 'unknown';
}
function requiresOutboundApproval(name, args = {}) {
  return !['read', 'known-mutation'].includes(classifyEffect(name, args));
}
module.exports = { requiresGitApproval, requiresOutboundApproval, classifyEffect };

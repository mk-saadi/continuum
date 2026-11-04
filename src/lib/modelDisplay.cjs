'use strict';

// Display only: preserve the original identifier for routing and accounting.
function modelIdentity(value, providerId) {
  const id = typeof value === 'string' ? value.trim() : '';
  const cloud = /^cloud:([^:]+):(.+)$/.exec(id);
  return cloud ? { providerId: cloud[1], modelId: cloud[2] } : { providerId, modelId: id };
}

function modelDisplayName(value, { name, providerId, metadata } = {}) {
  const identity = modelIdentity(value, providerId);
  const id = identity.modelId;
  if (!id) return 'Unknown model';
  const preferred = name || metadata?.(identity.providerId, id)?.name;
  if (preferred && preferred !== value && preferred !== id) return preferred;
  // Both Windows and POSIX paths can occur in imported usage history.
  const local = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(id) || /\.gguf$/i.test(id);
  const leaf = id.split(/[\\/]/).pop() || id;
  if (local) return leaf.replace(/\.gguf$/i, '');
  return leaf.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

module.exports = { modelIdentity, modelDisplayName };

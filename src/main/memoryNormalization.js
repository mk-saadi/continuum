'use strict';

// Cleanup for facts already selected by the model or entered in settings.
// This helper never decides whether a chat message should be saved.
function normalizeMemoryContent(content) {
  if (typeof content !== 'string' || content.includes('\0')) {
    throw new TypeError('Memory content must be a string without null characters.');
  }
  let fact = content.trim().replace(/\s+/g, ' ');
  const preamble = /^(?:(?:please\s+)?remember(?:\s+that)?|from now on|please note(?:\s+that)?)\b[\s,:-]*/i;
  while (preamble.test(fact)) fact = fact.replace(preamble, '').trim();

  fact = fact.replace(/^(?:the\s+)?user['’]s\s+favou?rite\s+(.+?)\s+is\s+(.+)$/i,
    (_, property, value) => `Favorite ${property}: ${value}`);
  fact = fact.replace(/^my\s+favou?rite\s+(.+?)\s+is\s+(.+)$/i,
    (_, property, value) => `Favorite ${property}: ${value}`);
  fact = fact.replace(/^(?:I\s+prefer|(?:the\s+)?user\s+prefers)\s+/i, 'Prefers ');

  // Match the requested short preference form without stripping other scopes
  // such as project names, exceptions, or negations.
  if (/^Prefers\s/i.test(fact)) {
    fact = fact.replace(/\s+for all new files[.!]?$/i, '');
  }
  fact = fact.replace(/([\p{L}\p{N}])[.!]$/u, '$1').trim();
  if (!fact || !/[\p{L}\p{N}]/u.test(fact)) {
    throw new TypeError('Memory content must contain a fact after cleanup.');
  }
  return fact;
}

module.exports = { normalizeMemoryContent };

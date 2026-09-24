'use strict';

// OpenAI-compatible chat-completions tool definitions for local LLM servers.
// Tool execution must bind model/session scope in the main process.
const nativeTools = [
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search saved long-tail user preferences and personal facts relevant to the current request. Returns up to five active, non-superseded memories visible to the current model. Use concise search terms when the needed detail is absent from the current context.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: 'Literal keywords or a short phrase describing the preference or fact to find; do not include SQL or FTS operators.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_chat_history',
      description: 'Search archived messages from the current chat session using chat_fts to recover earlier details omitted from the current context or summary. Use when the user refers to an earlier discussion that is not available in active messages.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: 'Literal keywords or a short phrase from the earlier conversation; do not include SQL or FTS operators.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

module.exports = { nativeTools };

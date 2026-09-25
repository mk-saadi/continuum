'use strict';

// OpenAI-compatible chat-completions tool definitions for local LLM servers.
// Tool execution must bind model/session scope in the main process.
const nativeTools = [
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: "Searches the user's permanent facts/preferences AND their past organic chat history. Use this for ANY recall task.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: 'Literal keywords or a short phrase describing the fact, preference, or past discussion to find; do not include SQL or FTS operators.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

module.exports = { nativeTools };

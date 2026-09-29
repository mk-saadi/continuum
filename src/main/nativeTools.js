'use strict';

// OpenAI-compatible chat-completions tool definitions for local LLM servers.
// Tool execution must bind model/session scope in the main process.
const nativeTools = [
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: "Searches past chat history. Input 2-4 broad KEYWORDS, not full sentences. Returns relevant snippets, not full messages. Also searches the user's permanent facts/preferences.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: 'Use 2-4 broad keywords, not full sentences. Chat search matches all keyword prefixes in any order; do not include SQL or FTS operators.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

module.exports = { nativeTools };

'use strict';

const saveMemoryTool = {
  name: 'save_memory',
  description: `PERSISTENT MEMORY STORAGE.
CRITICAL RULES:
- NEVER save transient state, routine task progress, conversational replies, or easily re-discoverable code snippets.
- ONLY save enduring user preferences, absolute project constraints, or architectural rules.
- If the user did not explicitly ask you to remember it, or if it doesn't fundamentally change how you write code in the future, DO NOT CALL THIS TOOL.`,
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['preference', 'architecture', 'rule', 'workflow'] },
      content: { type: 'string', maxLength: 150, description: 'Concise factual statement (max 150 characters).' },
    },
    required: ['category', 'content'],
    additionalProperties: false,
  },
};

module.exports = { saveMemoryTool };

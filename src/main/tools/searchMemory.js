'use strict';

const searchMemoryTool = {
  name: 'search_memory',
  description: 'Search permanent Memory Palace facts and past chat messages. Results are bounded and newest-first by default. If a search is incomplete, repeat it with the returned cursor or narrow it with filters.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'Search keywords, such as "testing framework" or "git rules".' },
      target: { type: 'string', enum: ['permanent', 'session', 'all'], default: 'all', description: 'Memory store to search.' },
      cursor: { type: 'string', description: 'Opaque continuation cursor returned by an incomplete search. Keep the same query and filters.' },
      order: { type: 'string', enum: ['newest', 'oldest'], default: 'newest', description: 'Chat-message search direction.' },
      limit: { type: 'integer', minimum: 1, maximum: 5, default: 5, description: 'Maximum matches from each selected store.' },
      session_id: { type: 'string', description: 'Optional chat ID filter for message search.' },
      project_id: { type: 'string', description: 'Optional project ID filter for message search.' },
      role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Optional message role filter.' },
      since: { type: 'string', description: 'Optional earliest message timestamp, YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.' },
      until: { type: 'string', description: 'Optional latest message timestamp, YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

module.exports = { searchMemoryTool };

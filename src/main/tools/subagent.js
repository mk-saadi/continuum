'use strict';

// Every delegated task uses the durable, read-only investigation loop, including
// explicit file and URL targets. Each child owns its context and auto-compaction.
const spawnSubagentTool = {
  type: 'function',
  function: {
    name: 'spawn_sub_agent',
    description: 'Read-only worker for isolated web research or local analysis; returns concise findings. Supply task and exactly one of: one public URL (url or in task), one absolute target_file, or investigate:true for project/public-web research using its own web_search tool. Cannot edit, run commands, use memory or spawn workers.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Concrete bounded question, paths or sources, exclusions, and acceptance criterion. Avoid overlap with other children.' },
        constraint: { type: 'string', description: 'Optional length and omission rules, such as no raw HTML or boilerplate.' },
        expected_output: { type: 'string', description: 'Concise findings with file/line or URL evidence first, followed by uncertainties and unfinished work.' },
        url: { type: 'string', description: 'Public HTTP or HTTPS URL to analyze. The worker reads this source and continues in its own automatically compacting context. For broader source discovery use investigate: true.' },
        target_file: { type: 'string', description: 'Absolute path to the file to analyze. The worker reads numbered pages, follows pagination, and automatically compacts its own context as needed.' },
        investigate: { type: 'boolean', description: 'Set true to let the worker investigate autonomously: it searches, reads, and lists project files (and may fetch public web pages) across as many turns as its configured budgets allow, automatically compacting its own context before returning its answer. Cannot be combined with url or target_file.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
};

// Parent-context protection, reviewed in Step 7: whatever a child returns lands
// in the parent's conversation as one tool result, so the parent context pays
// for every character. The limit mirrors the child's OWN answer ceiling
// (MAX_FINAL_CHARACTERS / MAX_SUMMARY_CHARACTERS = 6,000 characters, see
// subagents/agentLoop.js and subagents/executionManager.js) instead of
// re-truncating a bounded answer: the parent receives the whole review a child
// was allowed to produce, and this notice is a backstop for any path that
// returns more. The full answer is NOT discarded either way — the child session
// keeps it (session.result plus the whole session.context), so the complete
// findings stay available internally for continuation (sendMessage / resume)
// and for inspection through the runtime. One helper, one limit, one notice —
// instead of the same slice repeated per path.
const PARENT_RESULT_LIMIT = 6000;
const TRUNCATED_NOTICE = '[Summary truncated]';
function boundResultForParent(answer) {
  if (typeof answer !== 'string' || answer.length <= PARENT_RESULT_LIMIT) return answer;
  return `${answer.slice(0, PARENT_RESULT_LIMIT - TRUNCATED_NOTICE.length - 1)}\n${TRUNCATED_NOTICE}`;
}

async function executeSpawnSubagent({ task, constraint = '', expected_output = '', url, target_file, investigate,
  engine, signal, parentSessionId = null, parentToolCallId = null, rootPath, onSpawn = null, budgetScope, executionContext = null }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 2000 || task.includes('\0')) {
    throw new Error('Task must be a non-empty instruction of at most 2,000 characters.');
  }
  for (const [name, value] of Object.entries({ constraint, expected_output })) {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) {
      throw new Error(`${name} must be a string of at most 1,000 characters.`);
    }
  }
  if (investigate !== undefined && typeof investigate !== 'boolean') {
    throw new Error('investigate must be a boolean.');
  }

  const runWorker = async instruction => {
    const runtime = require('../subagents');
    return boundResultForParent(await runtime.runInvestigation({ task: instruction, rootPath, engine, signal,
      parentSessionId, parentToolCallId, budgetScope, onSpawn: id => {
        const child = require('../subagents/sessionManager').getSession(id);
        require('../lspExecutionContext').authorizeChild(child, executionContext);
        onSpawn?.(id);
      } }));
  };
  const instructionFor = source => [task, source,
    expected_output && `Expected output: ${expected_output}`,
    constraint && `Constraint: ${constraint}`,
    'Work until the requested analysis is complete or a real blocker prevents progress. Use tools to read evidence; do not answer from the task alone. Read remaining source pages when pagination indicates more content. Your context is automatically compacted as needed; retrieve earlier evidence with read_child_history rather than restarting or asking the parent to continue.'
  ].filter(Boolean).join('\n');
  // All source types share the same scheduler, continuation and compaction path.
  if (investigate === true) {
    if (url !== undefined || target_file !== undefined) {
      throw new Error('Choose either investigate or url/target_file, not both.');
    }
    return runWorker(instructionFor(''));
  }

  // --- File analysis path ---
  if (target_file !== undefined) {
    if (typeof target_file !== 'string' || !target_file.trim()) {
      throw new Error('target_file must be a non-empty absolute path.');
    }
    if (!require('node:path').isAbsolute(target_file) || target_file.includes('\0')) {
      throw new Error('target_file must be a non-empty absolute path.');
    }
    if (url !== undefined) throw new Error('Choose either url or target_file, not both.');
    return runWorker(instructionFor(`Source file: ${target_file}. Start with read_project_file using relative_path=${JSON.stringify(require('node:path').relative(rootPath ?? process.cwd(), target_file))}. Use the returned line numbers for citations.`));
  }

  // --- Web URL path ---
  const mentionedUrls = [...new Set((task.match(/https?:\/\/[^\s\])}>"]+/gi) || [])
    .map(found => found.replace(/[.,;!?]+$/, '')))];
  if (url !== undefined && (typeof url !== 'string' || !url.trim())) throw new Error('url must be a web address.');
  const resolvedUrl = url ?? mentionedUrls[0];

  // Require exactly one URL for web research
  if (mentionedUrls.length > 1 || resolvedUrl && mentionedUrls.some(mentioned => mentioned !== resolvedUrl)) {
    throw new Error('Delegate one web URL per sub-agent call.');
  }
  const sourceUrl = resolvedUrl;
  // No URL, no target_file, no investigate: the remaining shape is a research
  // task that expects search/discovery. A URL-only call fetches one page; a
  // worker that should discover URLs itself must run in investigate mode (its
  // read-only allowlist includes the native web_search tool). Fail with
  // guidance the caller can act on instead of a bare parameter complaint.
  if (!sourceUrl) {
    throw Object.assign(new Error('Provide a url or target_file parameter (or set investigate: true). '
      + 'A url call fetches exactly one page; to let the worker discover public sources itself, '
      + 'set investigate: true, or call web_search in the main context and pass the chosen URL. For local analysis put the absolute path in target_file, not just task.'), { code: 'SUBAGENT_TARGET_REQUIRED' });
  }

  return runWorker(instructionFor(`Source URL: ${sourceUrl}. Start by fetching this page with get_single_web_page_content. Keep the analysis scoped to this source; clearly identify unavailable or truncated content.`));
}

module.exports = { spawnSubagentTool, executeSpawnSubagent, PARENT_RESULT_LIMIT, boundResultForParent };
